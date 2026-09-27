#!/usr/bin/env node
// Analyzer for one idle-live evidence directory (Appendix B "Analyzer" of
// .omo/plans/idle-experiments-live-run.md; the formulas are Appendix A sections 1-5 and
// their numbers are binding).
//
//   node scripts/idle-live-analyze.mjs <runDir> [--merge <laterRunDir> ...] [--md <path>] [--out <path>]
//
// Input:  <runDir>/requests.jsonl (primary), <runDir>/events.jsonl, <runDir>/cli/<stepId>.json,
//         <runDir>/summary.json (optional).
// Output: <runDir>/analysis.json (or --out) and, with --md, a Korean results document.
// --merge adds later runs of the same campaign, oldest first (todo 25 D4): every attempt of every
// run is reported and only clean, terminal attempts are pooled. A merged analysis is only written
// to --out, never into an evidence directory.
//
// This file performs no network access, spawns nothing, starts no timer and reads no clock:
// every timestamp it prints is copied from the input, so a second run over the same evidence
// reproduces the same bytes. Writes go through the promise API on purpose - the source scan of
// test/idle-experiments.test.mjs forbids the *Sync write names, and nothing here needs them.
//
// Rules this file enforces (Appendix A/B, gate review blockers B1-B8):
//   * FAIL CLOSED. A torn/garbage row, a missing `usage` or billable field, a request set that
//     does not match step_intent/step_result 1:1, a reset epoch that differs from the
//     experiment_started baseline, an in-doubt step or a record without the producer metadata
//     (`role`, `unit`) makes that experiment `void` with the reason, its coefficients
//     `sourceKind: "unknown"`, and removes it from the policy feed. Skip counts are not validity.
//   * Only a CLEAN window measures (one experiment, one reset window, one request per step,
//     model echoed, status allowed, no anomaly, no in-doubt step); everything else is published
//     with sourceKind "unknown" and the reason.
//   * No point coefficient is invented: the published point is explicitly the UPPER bound of the
//     quantization interval (`pointRule=upper_quantization_bound` in the string evidenceRef),
//     unmeasured fields stay null, structured provenance lives in a sibling object.
//   * Phase phi is evidence, never a default: a pre-walk tick, the phase the machine carries in
//     `experiment_started.carryPhase`, or the bounded residual the previous block left after its
//     second tick (todo 25 D2). Without one a block only bounds the output coefficient from above
//     (`phase_unobserved`); blocks whose intervals do not overlap publish no measured coefficient.
//   * Every OUT request is judged against the target its own step_intent records; a missing or
//     conflicting target is reported, never defaulted (todo 25 D3).
//   * The cache-read subtraction propagates the prior RANGE (caps.mjs PRIOR_RANGE_ONLY), never a
//     point, and names the prior in provenance.
//   * The engine decides: `convertUsage` prices the phase sums, `evaluateIdleCost` runs at the LOW
//     and the HIGH end of every range with forecast null and V = 0, and the action is reported
//     only if both ends agree (else NO_DECISION with the reason). The q values AGENT_TASK names
//     are `planIdle` scenarios labelled `hypothetical`; they are never promoted to the answer.
//   * cli/<stepId>.json assistant text is UNTRUSTED DATA. It is only compared, by exact string
//     rules, against makeTask(seed) ground truth; nothing in it is ever executed or interpreted
//     as an instruction to this analyzer.
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pathToFileURL } from "node:url"

import { RULES, EXPERIMENT_IDS, schedule, makeTask, scoreWork, scoreGuard, reexplainNeeded, handoffLossy, BIG_CONTEXT_MODE } from "./idle-live/protocols.mjs"
import { METERS, metersOf, sameWindow } from "./idle-live/gauge.mjs"
import { RESOLUTION, PRIOR_RANGE_ONLY, OUTPUT_RATIO_PRIOR } from "./idle-live/caps.mjs"
import { normalizeUsage } from "./quota-analysis.mjs"
import { convertUsage, evaluateIdleCost, planIdle, USAGE_FIELDS } from "../extension/rollover.ts"

export const SCHEMA_VERSION = "idle-live-analysis/1"
export const RHO = RULES.rho // 1/37, the DIAL read cost in ticks
const RHO_LOW = RULES.rhoLow // 1/38
const PING_TERM = 0.0045 // Appendix A section 1: the 7 hold pings cost 0.0045 tick in total
const H6_BELOW = 0.645
const H8_ABOVE = 0.755
const PRIOR_FIVE_WRITE_TOKENS = 713500 // 5 x 142.7K from quota-test/2026-09-19
const PRIOR_TICKS = { H6: 6, H8: 8 }
// The reported read prior is a RANGE (caps.mjs), never the 5.4M point: it is propagated into
// every interval it takes part in and named in provenance.
const READ_TOKENS_PER_TICK_RANGE = PRIOR_RANGE_ONLY.cacheRead
const METER_5H = "unified-5h"
// Appendix A section 4: write-equivalent tokens per tick of the slower meters, as multiples of T.
const METER_MULTIPLIER = Object.freeze({
  "unified-5h": { point: 1, range: [1, 1], sourceKind: "measured" },
  "unified-7d": { point: 5.7, range: [2.7, 8], sourceKind: "reported_unverified" },
  "unified-7d_oi": { point: 2.7, range: [1.75, 4.5], sourceKind: "reported_unverified" },
})
const CONFIG_IDENTITY = "effort:low|thinking:0|tools:none|max_turns:1|tier:standard"

// Reasons that make an experiment void outright, in report priority order.
const HARD_REASONS = [
  "malformed_evidence_row",
  "schema_incomplete",
  "usage_incomplete",
  "reset_in_window",
  "baseline_reset_mismatch",
  "request_row_missing",
  "request_step_mismatch",
  "in_doubt_step",
  "unexpected_request_count",
  "meter_reading_missing",
]

// ------------------------------------------------------------------ utilities

const sha256 = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex")
const num = (v) => (Number.isFinite(v) ? v : null)
const sortedKeys = (o) => Object.keys(o).sort()

/** Deterministic JSON: keys sorted at every level so a rerun is byte-identical. */
export function stableStringify(value, indent = 2) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out = {}
      for (const k of sortedKeys(v)) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value), null, indent)
}

/** JSONL -> objects; blank, torn and non-object lines are skipped WITH their line number. */
export function parseRecords(text) {
  const records = []
  const skipped = []
  const lines = String(text ?? "").split(/\r?\n/)
  lines.forEach((line, i) => {
    if (!line.trim()) return
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped.push({ line: i + 1, reason: "malformed_json" })
      return
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped.push({ line: i + 1, reason: "not_an_object" })
      return
    }
    records.push(parsed)
  })
  return { records, skipped, lines: lines.filter((l) => l.trim()).length }
}

/**
 * The five immutable billable fields of one request. An absent counter is NOT read as zero: it
 * is listed in `unknownFields`, and the window that contains it can never be measured.
 */
function fields(record) {
  const hasUsage = !!record?.usage && typeof record.usage === "object"
  const n = normalizeUsage(record?.usage)
  const out = { uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, billedModelOutput: 0 }
  const unknown = []
  for (const f of USAGE_FIELDS) {
    const v = n[f]
    if (v === null || v === undefined) unknown.push(f)
    else out[f] = v
  }
  if ((n.cacheWriteUnknownTtl ?? 0) > 0) unknown.push("cacheWriteTtlSplit")
  out.unknownFields = unknown
  out.hasUsage = hasUsage
  return out
}

const emptySums = () => ({ requests: 0, uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, billedModelOutput: 0 })

function addTo(sums, record) {
  const f = fields(record)
  sums.requests += 1
  for (const k of USAGE_FIELDS) sums[k] += f[k]
  return sums
}

export function sumRecords(recs) {
  const s = emptySums()
  for (const r of recs) addTo(s, r)
  return s
}

const meterReading = (record, meter) => {
  const m = metersOf(record?.headers)[meter]
  return m && m !== "absent" ? m : null
}

// Appendix B "Paid-request counting": a row is paid when accounting.requestCount >= 1. A row with
// requestCount 0 records a call the proxy never logged: not a paid request, not meter spend, never
// measured. Any other value is malformed evidence and is not counted either; a row without the
// field (older evidence) counts as before.
const requestCountOf = (record) => record?.accounting?.requestCount
const isPaid = (record) => {
  const n = requestCountOf(record)
  return n === undefined || (Number.isInteger(n) && n >= 1)
}
const hasMalformedCount = (record) => {
  const n = requestCountOf(record)
  return n !== undefined && !(Number.isInteger(n) && n >= 0)
}

const msOf = (v) => (typeof v === "number" ? num(v) : typeof v === "string" ? num(Date.parse(v)) : null)
const byIndex = (a, b) => (a.index ?? 0) - (b.index ?? 0)

/**
 * Per-request tick deltas of one meter inside one experiment. The first request is compared to
 * the experiment baseline from `experiment_started`; without that event its own reading is the
 * baseline, so it shows 0 ticks (stated, never silently assumed to have ticked).
 */
function tickView(recs, { baseline = null, meter = METER_5H } = {}) {
  const ordered = [...recs].sort(byIndex)
  const view = []
  let prev = baseline && Number.isFinite(baseline.util) ? baseline : null
  for (const rec of ordered) {
    const reading = meterReading(rec, meter)
    let ticks = 0
    let window = true
    if (reading && prev) {
      if (!sameWindow(prev, reading)) window = false
      else ticks = Math.round((reading.util - prev.util) / RESOLUTION)
    }
    view.push({ rec, reading, ticks, sameWindow: window, usage: fields(rec) })
    if (reading) prev = reading
  }
  return view
}

// Producer metadata contract (Appendix B): only these documented fields are consumed, and none
// of them has a default. `run` is DERIVED from unit.index; a top-level `run` copy is never read.
const roleOf = (v) => (typeof v.rec.role === "string" && v.rec.role ? v.rec.role : null)
// unit.index is an integer >= 1. windowStatus applies this same rule, so a record that unit
// grouping would drop always voids its window (schema_incomplete) instead of vanishing from it.
const unitIndexOf = (unit) => (unit && typeof unit === "object" && Number.isInteger(unit.index) && unit.index >= 1 ? unit.index : null)
const unitOf = (v) => unitIndexOf(v.rec.unit)
const unitKindOf = (v) => (v.rec.unit && typeof v.rec.unit.kind === "string" ? v.rec.unit.kind : null)
const ordinalOf = (v) => (Number.isInteger(v.rec.n) ? v.rec.n : null)
const workStepOf = (v) => (Number.isInteger(v.rec.k) ? v.rec.k : null)
const prefixOf = (v) => (typeof v.rec.prefix === "string" && v.rec.prefix ? v.rec.prefix : null)

function groupByUnit(view) {
  const map = new Map()
  for (const v of view) {
    const u = unitOf(v)
    if (u === null) continue // schema_incomplete: the window is void, nothing is grouped by guess
    if (!map.has(u)) map.set(u, [])
    map.get(u).push(v)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
}

// ------------------------------------------------- 1. fable-write-tick

const intersect = (a, b) => {
  if (!a) return b
  if (!b) return a
  const lo = Math.max(a.lo, b.lo)
  const hi = Math.min(a.hi, b.hi)
  return { lo, hi, empty: lo > hi }
}

/**
 * Appendix A section 1: the hold is seven PINGs at fixed offsets after the write, the last one
 * 30 minutes later. A hold that is short, incomplete or off its offset is not a 30-minute hold,
 * so it cannot carry the delayed-tick argument.
 */
function holdTiming(write, holds) {
  const offsets = RULES.fable.holdOffsetsMs
  const tolerance = RULES.fable.holdToleranceMs
  const writeAt = write ? (msOf(write.rec.ts) ?? msOf(write.rec.ts_req)) : null
  const samples = offsets.map((offsetMs, i) => {
    const hold = holds.find((h) => ordinalOf(h) === i + 1)
    const at = hold ? msOf(hold.rec.ts_req) : null
    const deltaMs = at !== null && writeAt !== null ? at - writeAt - offsetMs : null
    return {
      n: i + 1,
      offsetMs,
      present: !!hold,
      deltaMs,
      withinTolerance: deltaMs !== null && Math.abs(deltaMs) <= tolerance,
    }
  })
  const complete = writeAt !== null && holds.length === offsets.length && samples.every((s) => s.present && s.withinTolerance)
  return { complete, toleranceMs: tolerance, spanMs: writeAt !== null ? offsets[offsets.length - 1] : null, samples }
}

function fableBlocksFrom(view) {
  const blocks = []
  let chainedPhase = null
  for (const [index, entries] of groupByUnit(view)) {
    const pre = entries.filter((v) => roleOf(v) === "pre_walk").sort((a, b) => (ordinalOf(a) ?? 0) - (ordinalOf(b) ?? 0))
    const write = entries.find((v) => roleOf(v) === "write")
    const hold = entries.filter((v) => roleOf(v) === "hold")
    const post = entries.filter((v) => roleOf(v) === "post_walk").sort((a, b) => (ordinalOf(a) ?? 0) - (ordinalOf(b) ?? 0))
    const preTicked = pre.length > 0 && pre[pre.length - 1].ticks > 0
    let phi = null
    let phiSource = null
    if (preTicked) {
      phi = { lo: 0, hi: RHO }
      phiSource = "pre_walk_tick"
    } else if (pre.length > 0) {
      phi = { lo: Math.min(1, pre.length * RHO), hi: 1 }
      phiSource = "pre_walk_exhausted"
    } else if (chainedPhase) {
      phi = chainedPhase
      phiSource = "chained_from_previous_block"
    } else {
      phi = { lo: 0, hi: 1 }
      phiSource = "phase_unobserved"
    }
    const delayedTicks = hold.reduce((a, v) => a + v.ticks, 0)
    const ticked = post.find((v) => v.ticks > 0)
    const timing = holdTiming(write, hold)
    blocks.push({
      block: index,
      chained: phiSource === "chained_from_previous_block",
      phi,
      phiSource,
      preWalkReads: pre.length,
      writeTokens: write ? write.usage.cacheWrite1h : null,
      writeTicks: write ? write.ticks : null,
      holdPings: hold.length,
      holdsComplete: timing.complete,
      holdTiming: timing,
      delayedTicks,
      postWalkReads: post.length,
      m: ticked ? ordinalOf(ticked) : null,
      n: write ? write.ticks + delayedTicks : null,
    })
    if (ticked) chainedPhase = { lo: 0, hi: RHO }
  }
  return blocks
}

function fableInterval(block) {
  const { phi, m, n, writeTokens } = block
  if (m === null || n === null || !writeTokens) return null
  // phi + W/T + pings + m*rho = n + 1  (Appendix A section 1)
  const lo = n + 1 - phi.hi - m * RHO - PING_TERM
  const hi = n + 1 - phi.lo - (m - 1) * RHO_LOW - PING_TERM
  return { lo, hi, loExclusive: true, hiInclusive: true }
}

/** The blocks of one attempt with their intervals, and whether its holds can carry the H8 argument. */
function fableUnits(recs, opts = {}) {
  const overridden = Array.isArray(opts.overrideBlocks)
  const blocks = (opts.overrideBlocks ?? fableBlocksFrom(tickView(recs, opts))).map((b) => {
    const block = { chained: false, delayedTicks: 0, preWalkReads: 0, holdPings: 0, postWalkReads: 0, holdsComplete: false, holdTiming: null, ...b }
    const writeOverT = fableInterval(block)
    if (!writeOverT) return { ...block, writeOverT: null, T: null, kWrite60: null, status: "incomplete" }
    const T = { lo: block.writeTokens / writeOverT.hi, hi: block.writeTokens / writeOverT.lo }
    return {
      ...block,
      writeOverT,
      T,
      kWrite60: { lo: RESOLUTION / T.hi, hi: RESOLUTION / T.lo },
      status: "valid",
    }
  })
  // Appendix A section 1: the H8 rejection needs TWO complete 30-minute holds with zero delayed
  // ticks. Fewer blocks, a missing sample or a sample off its offset leaves the question open.
  const holdsUsable = !overridden && blocks.length === RULES.fable.blocks && blocks.every((b) => b.holdsComplete)
  return { blocks, holdsUsable, overridden }
}

/** Blocks of several attempts pooled; each attempt's holds were judged within that attempt. */
const mergeFableUnits = (list) => ({ blocks: list.flatMap((u) => u.blocks), holdsUsable: list.length > 0 && list.every((u) => u.holdsUsable), overridden: false })

function fableAggregate({ blocks, holdsUsable, overridden }) {
  const valid = blocks.filter((b) => b.status === "valid")
  let intersectedT = null
  let intersectedWriteOverT = null
  let disjoint = false
  for (const b of valid) {
    intersectedT = intersect(intersectedT, { lo: b.T.lo, hi: b.T.hi })
    intersectedWriteOverT = intersect(intersectedWriteOverT, { lo: b.writeOverT.lo, hi: b.writeOverT.hi })
  }
  if (intersectedT?.empty) {
    disjoint = true
    intersectedT = null
    intersectedWriteOverT = valid.length ? { lo: valid[0].writeOverT.lo, hi: valid[0].writeOverT.hi } : null
  }
  const delayedTicksTotal = blocks.reduce((a, b) => a + (b.delayedTicks ?? 0), 0)
  const holdsPerBlock = blocks.map((b) => b.holdPings ?? 0)
  let verdict = { hypothesis: "uncertain", straddles: null, basis: "no_interval", thresholds: { h6Below: H6_BELOW, h8Above: H8_ABOVE } }
  if (intersectedWriteOverT) {
    const straddles = !(intersectedWriteOverT.hi < H6_BELOW) && !(intersectedWriteOverT.lo > H8_ABOVE)
    if (intersectedWriteOverT.hi < H6_BELOW) verdict = { hypothesis: "H6", straddles: false, basis: "interval_below_h6_threshold", thresholds: verdict.thresholds }
    else if (intersectedWriteOverT.lo > H8_ABOVE) verdict = { hypothesis: "H8", straddles: false, basis: "interval_above_h8_threshold", thresholds: verdict.thresholds }
    else if (delayedTicksTotal === 0 && holdsUsable)
      verdict = { hypothesis: "H6", straddles: true, basis: "delayed_tick_evidence", thresholds: verdict.thresholds }
    else if (straddles && !holdsUsable && !overridden)
      verdict = { hypothesis: "uncertain", straddles, basis: "incomplete_holds", thresholds: verdict.thresholds }
    else verdict = { hypothesis: "uncertain", straddles, basis: "straddles_without_delay_evidence", thresholds: verdict.thresholds }
  }
  const ticksAssumed = verdict.hypothesis === "H6" ? PRIOR_TICKS.H6 : verdict.hypothesis === "H8" ? PRIOR_TICKS.H8 : null
  const writeSum = valid.reduce((a, b) => a + b.writeTokens, 0)
  const nSum = valid.reduce((a, b) => a + b.n, 0)
  const pooledT =
    ticksAssumed === null
      ? null
      : {
          lo: (PRIOR_FIVE_WRITE_TOKENS + writeSum) / (ticksAssumed + nSum + 1),
          hi: (PRIOR_FIVE_WRITE_TOKENS + writeSum) / (ticksAssumed + nSum - 1),
          ticksAssumed,
          phasePlusMinusTicks: 1,
          priorSourceKind: "reported_unverified",
        }
  const flags = []
  if (disjoint) flags.push("blocks_disjoint")
  if (!holdsUsable && !overridden) flags.push("holds_incomplete")
  if (pooledT && intersectedT && (pooledT.hi < intersectedT.lo || pooledT.lo > intersectedT.hi)) flags.push("pooled_prior_disjoint_from_measured")
  return {
    experiment: "fable-write-tick",
    status: valid.length ? "valid" : "void",
    blocks,
    holdsPerBlock,
    holdOffsetsMs: [...RULES.fable.holdOffsetsMs],
    holdToleranceMs: RULES.fable.holdToleranceMs,
    holdsUsable,
    intersectedT,
    intersectedWriteOverT,
    blocksDisjoint: disjoint,
    delayedTicksTotal,
    verdict,
    pooledT,
    kWrite60: intersectedT ? { lo: RESOLUTION / intersectedT.hi, hi: RESOLUTION / intersectedT.lo } : null,
    skippedArms: { "fable-write-5m": "adapter_capability" },
    hypotheses: [
      { id: "H6", ticksForFiveWrites: PRIOR_TICKS.H6, tokensPerTick: PRIOR_FIVE_WRITE_TOKENS / PRIOR_TICKS.H6, supported: verdict.hypothesis === "H6", basis: verdict.basis },
      { id: "H8", ticksForFiveWrites: PRIOR_TICKS.H8, tokensPerTick: PRIOR_FIVE_WRITE_TOKENS / PRIOR_TICKS.H8, supported: verdict.hypothesis === "H8", basis: verdict.basis },
    ],
    flags,
  }
}

export function analyzeFableWriteTick(recs, opts = {}) {
  return fableAggregate(fableUnits(recs, opts))
}

// ----------------------------------------------------- 2. output-quota

/** 1h write cost in ticks per token: this run's T when fable-write-tick measured it, else the prior range. */
const writeTicksPerToken = (T) =>
  T
    ? { lo: 1 / T.hi, hi: 1 / T.lo, source: "T_measured_this_run" }
    : { lo: 1 / PRIOR_RANGE_ONLY.cacheWrite1h[1], hi: 1 / PRIOR_RANGE_ONLY.cacheWrite1h[0], source: "prior_range_only" }

/**
 * The non-output charge of one request in ticks, as an interval (todo 25 D2): reads at the reported
 * prior RANGE (never the 5.4M point), 1h writes at the write coefficient, and the 5m writes and the
 * uncached input bounded by it (Appendix A section 4). A charged field left out would push the k_out
 * lower bound up, which is unsound.
 */
function chargeOf(usage, kW) {
  return {
    lo: usage.cacheRead / READ_TOKENS_PER_TICK_RANGE[1] + usage.cacheWrite1h * kW.lo,
    hi: usage.cacheRead / READ_TOKENS_PER_TICK_RANGE[0] + (usage.cacheWrite1h + usage.cacheWrite5m + usage.uncachedInput) * kW.hi,
  }
}

/** fixed(n) of Appendix A section 2: every non-output charge since the phase reference, as an interval. */
function fixedOf(usages, kW) {
  let lo = 0
  let hi = 0
  for (const u of usages) {
    const c = chargeOf(u, kW)
    lo += c.lo
    hi += c.hi
  }
  return { lo, hi, priorRange: [...READ_TOKENS_PER_TICK_RANGE], priorEvidenceRef: PRIOR_RANGE_ONLY.evidenceRef, sourceKind: PRIOR_RANGE_ONLY.sourceKind, writeCoefficient: kW.source }
}

/**
 * The OUT target of one request (todo 25 D3). The producer records it on the request's own
 * step_intent (`expect.outputTokensTarget`); request rows carry no `expect` (Appendix B record
 * schema). `intents` holds the step_intents of this attempt only - step ids repeat across runs - so
 * nothing is ever joined across runs. A missing target, or two records of it that disagree, is
 * reported as such and never replaced by a default.
 */
function targetOf(rec, intents) {
  const list = [].concat(intents.get(rec.stepId) ?? [])
  const isTarget = (x) => typeof x === "number" && Number.isFinite(x) && x > 0
  const known = list.map((e) => e?.expect?.outputTokensTarget).filter(isTarget)
  const own = rec.expect?.outputTokensTarget
  const all = new Set(own === undefined ? known : [...known, own])
  if (all.size > 1 || (list.length > 1 && known.length !== list.length)) return { target: null, problem: "output_target_conflict" }
  if (!known.length) return { target: null, problem: "output_target_missing" }
  return { target: known[0], problem: null }
}

const phaseInterval = (p) => (Array.isArray(p) && p.length === 2 && p.every((x) => Number.isFinite(x)) && p[0] >= 0 && p[0] <= p[1] && p[1] <= 1 ? { lo: p[0], hi: p[1] } : null)

/**
 * Appendix A section 2 per block of one attempt (derivation: task-25/d2/derivation.md). Phase
 * evidence, first match wins:
 *   - the block's own pre-walk: a tick gives [0, rho], an exhausted walk [k rho, 1);
 *   - block 1: `experiment_started.carryPhase` (opts.phase, D1). The quiet settle PING(s) between the
 *     call that set it and the gate (opts.preRows) are charged as the block's pre-block segment;
 *   - block b > 1: the residual block b-1 left after its second tick (D2). It is at least 0 and below
 *     the cost of the OUT call that ticked, bounded with block b-1's own k_out interval, and by
 *     r = phi + S(N) - 2 itself. Block b-1's quiet hold PINGs are block b's pre-block segment. The
 *     DIAL's rho is never assumed after an OUT tick;
 *   - otherwise phi is unobserved, [0, 1), and the block only bounds k_out from above.
 * Sum_out and fixed count everything charged since the phase reference, the segment included.
 */
function outputUnits(recs, opts = {}) {
  const view = tickView(recs, opts)
  const kW = writeTicksPerToken(opts.T ?? null)
  const intents = opts.intents instanceof Map ? opts.intents : new Map()
  const carried = phaseInterval(opts.phase)
  const carriedSegment = carried && Array.isArray(opts.preRows) ? opts.preRows.map((r) => fields(r)) : []
  const byN = (a, b) => (ordinalOf(a) ?? 0) - (ordinalOf(b) ?? 0)
  const targetTicks = RULES.output.targetTicks
  const blocks = []
  let handed = null
  for (const [index, entries] of groupByUnit(view)) {
    const pre = entries.filter((v) => roleOf(v) === "pre_walk").sort(byN)
    const loop = entries.filter((v) => roleOf(v) === "gate" || roleOf(v) === "loop").sort(byN)
    const hold = entries.filter((v) => roleOf(v) === "hold").sort(byN)
    const preTicked = pre.length > 0 && pre[pre.length - 1].ticks > 0
    const chain = handed && handed.block === index - 1 ? handed : null
    let phi = { lo: 0, hi: 1 }
    let phiSource = "phase_unobserved"
    let segment = []
    if (preTicked) {
      phi = { lo: 0, hi: RHO }
      phiSource = "pre_walk_tick"
    } else if (pre.length > 0) {
      phi = { lo: Math.min(1, pre.length * RHO), hi: 1 }
      phiSource = "pre_walk_exhausted"
    } else if (index === 1 && carried) {
      phi = carried
      phiSource = "carried_phase_from_events"
      segment = carriedSegment
    } else if (chain) {
      phi = chain.phi
      phiSource = `chained_residual_of_block_${chain.block}`
      segment = chain.segment
    }
    const phaseObserved = phiSource !== "phase_unobserved"
    let cumulative = 0
    let N = loop.length
    const outs = []
    const usages = []
    const targets = new Set()
    let problem = null
    let valid = 0
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i]
      outs.push(v.usage.billedModelOutput)
      usages.push(v.usage)
      const t = targetOf(v.rec, intents)
      if (t.problem) problem = problem === "output_target_conflict" ? problem : t.problem
      else {
        targets.add(t.target)
        const minOutput = Math.round((RULES.output.gateMinOutput * t.target) / RULES.output.outputTarget)
        if (v.usage.billedModelOutput >= minOutput && v.rec.stop_reason === "end_turn") valid += 1
      }
      cumulative += v.ticks
      if (cumulative >= targetTicks) {
        N = i + 1
        break
      }
    }
    if (!problem && targets.size > 1) problem = "output_target_conflict"
    const segOut = segment.reduce((a, u) => a + u.billedModelOutput, 0)
    const sum = (arr, k) => arr.slice(0, Math.max(0, k)).reduce((a, x) => a + x, 0)
    const sumOut = segOut + sum(outs, N)
    const sumOutPrev = segOut + sum(outs, N - 1)
    const fixed = fixedOf([...segment, ...usages.slice(0, N)], kW)
    const fixedPrev = fixedOf([...segment, ...usages.slice(0, Math.max(0, N - 1))], kW)
    const ticksIdentified = cumulative >= targetTicks && sumOutPrev > 0
    const identified = ticksIdentified && phaseObserved
    // Upper bound: no second tick at N-1 when the block reached it (phi_lo + fixed(N-1) + k Sum_out(N-1) < 2),
    // else Appendix A's non-identified case over every request, (2 - phi_lo) / Sum_out(N).
    const upper = ticksIdentified ? (targetTicks - phi.lo - fixedPrev.lo) / sumOutPrev : sumOut > 0 ? (targetTicks - phi.lo) / sumOut : null
    const kOut = identified ? { lo: (targetTicks - phi.hi - fixed.hi) / sumOut, hi: upper, loInclusive: true, hiExclusive: true } : null
    const delayedTicks = hold.reduce((a, v) => a + v.ticks, 0)
    // D2: what this block hands on. Everything after its ticking call and before the next block (its
    // hold PINGs) must be read in the same window without a tick, else the next phase is unobserved.
    const tail = [...loop.slice(N), ...hold]
    let residual = null
    if (kOut && kOut.lo < kOut.hi && tail.every((v) => v.reading && v.sameWindow && v.ticks === 0)) {
      const last = loop[N - 1]
      const cost = chargeOf(last.usage, kW)
      const r = {
        lo: Math.max(0, phi.lo + fixed.lo + kOut.lo * sumOut - targetTicks),
        hi: Math.min(cost.hi + kOut.hi * last.usage.billedModelOutput, phi.hi + fixed.hi + kOut.hi * sumOut - targetTicks),
      }
      if (r.lo < r.hi) residual = r
    }
    handed = residual ? { block: index, phi: residual, segment: tail.map((v) => v.usage) } : null
    blocks.push({
      block: index,
      phi,
      phiSource,
      phaseObserved,
      preBlock: { requests: segment.length, sumOut: segOut },
      N,
      ticks: cumulative,
      sumOut,
      sumOutPrev,
      fixed,
      fixedPrev,
      delayedTicks,
      outputTokensTarget: problem ? null : (targets.values().next().value ?? null),
      validShare: problem ? null : loop.length ? valid / loop.length : null,
      validShareReason: problem,
      kOut,
      kOutUpperBound: upper,
      residualAfter: residual,
      status: identified ? "identified" : "upper_bound",
      reason: identified ? null : phaseObserved ? "no_second_tick_within_64" : "phase_unobserved",
    })
  }
  return blocks
}

/**
 * The experiment over the blocks of one or more attempts. k_out is the intersection of the
 * identified blocks (Appendix A: "Block 2 must overlap block 1"). Blocks that do not overlap publish
 * no measured k_out: the Appendix model does not fit them, and the reported bound is the largest
 * block upper bound. Validity needs every OUT target known and >= 90% valid requests.
 */
function outputAggregate(blocks, opts = {}) {
  const identified = blocks.filter((b) => b.kOut)
  let meet = null
  for (const b of identified) meet = intersect(meet, { lo: b.kOut.lo, hi: b.kOut.hi })
  // half-open intervals [lo, hi) meet only when lo < hi
  const disjoint = identified.length > 0 && !(meet.lo < meet.hi)
  const kOut = meet && !disjoint ? { lo: meet.lo, hi: meet.hi, unit: "ticks_per_output_token" } : null
  const T = opts.T ?? null
  const totalRequests = blocks.reduce((a, b) => a + b.N, 0)
  const targetProblem = blocks.some((b) => b.validShareReason === "output_target_conflict") ? "output_target_conflict" : (blocks.find((b) => b.validShareReason)?.validShareReason ?? null)
  const validShare = targetProblem || !totalRequests ? null : blocks.reduce((a, b) => a + (b.validShare ?? 0) * b.N, 0) / totalRequests
  const unobserved = blocks.filter((b) => !b.phaseObserved).map((b) => b.block)
  let status = "upper_bound"
  let reason = unobserved.length ? "phase_unobserved" : null
  if (!blocks.length) {
    status = "void"
    reason = null
  } else if (targetProblem) {
    status = "void"
    reason = targetProblem
  } else if (validShare !== null && validShare < RULES.output.validOutputShare) {
    status = "void"
    reason = "invalid_output_share"
  } else if (disjoint) reason = "blocks_disjoint"
  else if (identified.length === blocks.length) {
    status = "valid"
    reason = null
  }
  const bounds = blocks.map((b) => b.kOutUpperBound).filter((x) => typeof x === "number" && Number.isFinite(x))
  return {
    experiment: "output-quota",
    status,
    reason,
    blocks,
    phaseObserved: unobserved.length === 0,
    blocksWithoutPhase: unobserved,
    kOut,
    kOutUpperBound: bounds.length ? (disjoint ? Math.max(...bounds) : Math.min(...bounds)) : null,
    kOutUpperBoundRule: bounds.length ? (disjoint ? "max_over_disjoint_blocks" : "min_over_blocks") : null,
    overlap: !disjoint,
    ratio: kOut && T ? { lo: kOut.lo * T.lo, hi: kOut.hi * T.hi, definition: "k_out * T = output cost relative to one 1h write token" } : null,
    validShare,
    validShareThreshold: RULES.output.validOutputShare,
    blocksOverlap: !disjoint,
    readPrior: { range: [...READ_TOKENS_PER_TICK_RANGE], evidenceRef: PRIOR_RANGE_ONLY.evidenceRef, sourceKind: PRIOR_RANGE_ONLY.sourceKind, unit: PRIOR_RANGE_ONLY.unit },
  }
}

export function analyzeOutputQuota(recs, opts = {}) {
  return outputAggregate(outputUnits(recs, opts), opts)
}

// ------------------------------------------------ 3. ttl-1h-unique-prefix

const classifyPing = (u) => (u.cacheRead >= RULES.ttl.pingMinCacheRead && u.cacheWrite1h < RULES.ttl.pingMaxWrite1h ? "HIT" : "MISS")
const classifyCheck = (u) => {
  if (u.cacheRead >= RULES.ttl.checkHitMinCacheRead && u.cacheWrite1h <= RULES.ttl.checkHitMaxWrite1h) return "HIT"
  if (u.cacheWrite1h >= RULES.ttl.checkMissMinWrite1h) return "MISS"
  return "PARTIAL"
}

// Appendix A section 3 timing table, from the protocol module (never re-typed here).
const TTL_SCHEDULE = schedule("ttl-1h-unique-prefix")
const ttlOffsetOf = (prefix, role) => TTL_SCHEDULE.steps.find((s) => s.prefix === prefix && s.role === role) ?? null

/** The runs of one attempt, each judged on its own schedule and classification. */
function ttlUnits(recs, opts = {}) {
  const view = tickView(recs, opts)
  const t0 = msOf(opts.t0 ?? null)
  const runsMap = new Map()
  for (const v of view) {
    const run = unitOf(v)
    if (run === null) continue
    if (!runsMap.has(run))
      runsMap.set(run, {
        run,
        treatment: { write: null, ping: null, check: null, prefix: null },
        control: { write: null, check: null, prefix: null },
        timing: { ok: t0 === null ? null : true, toleranceMs: RULES.ttl.toleranceMs, t0, steps: [] },
        status: "pending",
        reason: null,
      })
    const entry = runsMap.get(run)
    const arm = v.rec.arm === "control" ? "control" : "treatment"
    const role = roleOf(v)
    const prefix = prefixOf(v)
    const u = v.usage
    // Timing: every step must land within +-90 s of experiment_started.t0 + its fixed offset.
    const scheduled = prefix && role ? ttlOffsetOf(prefix, role) : null
    const at = msOf(v.rec.ts_req)
    const deltaMs = t0 !== null && scheduled && at !== null ? at - (t0 + scheduled.atOffsetMs) : null
    const within = deltaMs !== null && Math.abs(deltaMs) <= RULES.ttl.toleranceMs
    entry.timing.steps.push({ stepId: v.rec.stepId ?? null, prefix, role, atOffsetMs: scheduled?.atOffsetMs ?? null, deltaMs, withinTolerance: deltaMs === null ? null : within })
    if (t0 === null || !scheduled || at === null) entry.timing.ok = null
    else if (!within && entry.timing.ok !== null) entry.timing.ok = false
    if (role === "write") {
      entry[arm].prefix = prefix
      entry[arm].write = { cacheWrite1h: u.cacheWrite1h, cacheWrite5m: u.cacheWrite5m, valid: u.cacheWrite1h >= RULES.ttl.writeMinWrite1h && u.cacheWrite5m === 0 }
    } else if (role === "ping") entry[arm].ping = classifyPing(u)
    else if (role === "check") entry[arm].check = classifyCheck(u)
  }
  const runs = [...runsMap.values()].sort((a, b) => a.run - b.run)
  for (const r of runs) {
    if (r.timing.ok === false) {
      r.status = "void"
      r.reason = "late_check"
      continue
    }
    if (r.timing.ok === null) {
      r.status = "void"
      r.reason = "schedule_unverified"
      continue
    }
    const reasons = []
    if (!r.treatment.write?.valid || !r.control.write?.valid) reasons.push("write_invalid")
    if (r.treatment.ping !== "HIT") reasons.push("ping_miss")
    if (!r.treatment.check || !r.control.check) reasons.push("missing_check")
    r.status = reasons.length ? "invalid" : "valid"
    r.reason = reasons[0] ?? null
  }
  return runs
}

function ttlAggregate(runs) {
  const valid = runs.filter((r) => r.status === "valid")
  let verdict = "uncertain"
  if (valid.length === 0) verdict = "no_valid_run"
  else if (valid.some((r) => r.treatment.check === "PARTIAL" || r.control.check === "PARTIAL")) verdict = "uncertain"
  else if (valid.some((r) => r.control.check === "HIT")) verdict = "no_contrast"
  else if (valid.every((r) => r.treatment.check === "HIT" && r.control.check === "MISS")) verdict = "renews_at_55min"
  else if (valid.every((r) => r.treatment.check === "MISS" && r.control.check === "MISS")) verdict = "no_renewal"
  return {
    experiment: "ttl-1h-unique-prefix",
    status: valid.length ? "valid" : "void",
    reason: valid.length ? null : (runs.find((r) => r.reason)?.reason ?? "no_valid_run"),
    runs,
    verdict,
    n: valid.length,
    renewsAt55min: verdict === "renews_at_55min" ? "measured" : null,
    ttlAtLeast110Min: verdict === "no_contrast" ? true : null,
    schedule: { offsetsMs: TTL_SCHEDULE.steps.map((s) => ({ prefix: s.prefix, role: s.role, atOffsetMs: s.atOffsetMs })), toleranceMs: RULES.ttl.toleranceMs },
    thresholds: { hitCacheRead: RULES.ttl.checkHitMinCacheRead, hitMaxWrite1h: RULES.ttl.checkHitMaxWrite1h, missMinWrite1h: RULES.ttl.checkMissMinWrite1h },
  }
}

export function analyzeTtl(recs, opts = {}) {
  return ttlAggregate(ttlUnits(recs, opts))
}

// -------------------------------------------- coefficients and conversion

const kWriteFromT = (T) => (T ? { lo: RESOLUTION / T.hi, hi: RESOLUTION / T.lo } : { lo: RESOLUTION / PRIOR_RANGE_ONLY.cacheWrite1h[1], hi: RESOLUTION / PRIOR_RANGE_ONLY.cacheWrite1h[0] })

/**
 * The two ends of the conversion Q = kW*w1h + kR*rd + kOut*out + kIn*in (Appendix A section 4).
 * kIn is unknown and only bounded by kW: it is 0 at the low end and kW at the high end.
 * Without a measured kOut the output end is the prior ratio range, 0.5x-2.5x the write
 * coefficient. When this evidence bounds kOut from above (`kOutUpperBound`, ticks per output token)
 * and the bound is above the prior's high end, the high end is raised to it (todo 25 D2): the
 * prior cannot exclude what the evidence allows. A bound below the prior's high end narrows
 * nothing, and the low end is always the prior's - an upper bound says nothing about the low end.
 */
export function conversionEnds({ T = null, kOut = null, kOutUpperBound = null, meter = METER_5H } = {}) {
  const mult = METER_MULTIPLIER[meter] ?? METER_MULTIPLIER[METER_5H]
  const baseW = kWriteFromT(T)
  const w = { lo: baseW.lo / mult.range[1], hi: baseW.hi / mult.range[0] }
  const read = { lo: RESOLUTION / (READ_TOKENS_PER_TICK_RANGE[1] * mult.range[1]), hi: RESOLUTION / (READ_TOKENS_PER_TICK_RANGE[0] * mult.range[0]) }
  let out = kOut
    ? { lo: (kOut.lo * RESOLUTION) / mult.range[1], hi: (kOut.hi * RESOLUTION) / mult.range[0] }
    : { lo: w.lo * OUTPUT_RATIO_PRIOR[0], hi: w.hi * OUTPUT_RATIO_PRIOR[1] }
  const evidenceHi = !kOut && Number.isFinite(kOutUpperBound) ? (kOutUpperBound * RESOLUTION) / mult.range[0] : null
  const raised = evidenceHi !== null && evidenceHi > out.hi
  if (raised) out = { lo: out.lo, hi: evidenceHi }
  return {
    meter,
    provenance: {
      cacheWrite1h: T ? "measured_this_run" : "prior_range_only",
      cacheRead: `reported_unverified_prior_range_${READ_TOKENS_PER_TICK_RANGE[0]}_${READ_TOKENS_PER_TICK_RANGE[1]}_tokens_per_tick`,
      cacheReadPriorEvidenceRef: PRIOR_RANGE_ONLY.evidenceRef,
      billedModelOutput: kOut ? "measured_this_run" : raised ? "prior_ratio_0.5_to_2.5_x_write_high_end_raised_to_evidence_upper_bound" : "prior_ratio_0.5_to_2.5_x_write",
      ...(raised ? { billedModelOutputEvidenceUpperBound: kOutUpperBound } : {}),
      uncachedInput: "unknown_bounded_by_cacheWrite1h",
      cacheWrite5m: "not_measured_on_this_lane",
      meterMultiplier: mult.range,
    },
    low: { uncachedInput: 0, cacheWrite5m: null, cacheWrite1h: w.lo, cacheRead: read.lo, billedModelOutput: out.lo },
    high: { uncachedInput: w.hi, cacheWrite5m: null, cacheWrite1h: w.hi, cacheRead: read.hi, billedModelOutput: out.hi },
  }
}

function conversionRecord(coefficients, meter, end) {
  return {
    modelId: RULES.model,
    provider: "firstParty",
    authLane: "claude-sdk-oauth",
    ttlLane: "1h",
    effortOrConfigIdentity: CONFIG_IDENTITY,
    quotaMeterOrCostUnit: `${meter}-utilization-fraction`,
    validFrom: "2026-09-23",
    measuredAt: null,
    // The conversion set mixes a measured write coefficient with reported priors, so it is
    // labelled reported_unverified even when the write end is measured.
    sourceKind: "reported_unverified",
    evidenceRef: `idle-live-analysis#conversionSet=${end}`,
    sampleCount: 0,
    version: SCHEMA_VERSION,
    coefficients,
  }
}

/** Convert one phase's usage sums into meter-equivalent spend at both ends of the ranges. */
export function convertSums(sums, ends) {
  const usage = { uncachedInput: sums.uncachedInput, cacheWrite5m: sums.cacheWrite5m, cacheWrite1h: sums.cacheWrite1h, cacheRead: sums.cacheRead, billedModelOutput: sums.billedModelOutput }
  const lo = convertUsage(usage, conversionRecord(ends.low, ends.meter, "low"))
  const hi = convertUsage(usage, conversionRecord(ends.high, ends.meter, "high"))
  return {
    lo: lo.ok ? lo.valueEq : null,
    hi: hi.ok ? hi.valueEq : null,
    blockers: [...(lo.ok ? [] : lo.blockers), ...(hi.ok ? [] : hi.blockers)],
    meter: ends.meter,
  }
}

// ------------------------------------------------------- quality scoring

/**
 * cli/<stepId>.json is the ledger envelope { stepId, experiment, role, exitCode, stdoutJson,
 * stderrHead, result } (Appendix B "CLI artifact contract"): the assistant text is `result`,
 * else `stdoutJson.result`; no string in either place is cli_artifact_unreadable.
 * The text is UNTRUSTED input: it is only ever compared against makeTask(seed) ground truth by
 * the pure scorers of protocols.mjs. No instruction inside it is read, followed or evaluated.
 */
const cliText = (cli, stepId) => {
  const artifact = cli && typeof cli === "object" ? cli[stepId] : undefined
  if (artifact === undefined || artifact === null) return { text: null, reason: "cli_artifact_missing" }
  if (typeof artifact === "string") return { text: artifact, reason: null }
  const text = artifact.result ?? artifact.stdoutJson?.result
  if (typeof text === "string") return { text, reason: null }
  return { text: null, reason: "cli_artifact_unreadable" }
}

const unknownField = (reason) => ({ value: null, reason })

/**
 * Appendix A sections 4-5 quality: guard correctness, useful-work correctness, reexplain_needed
 * and handoff_lossy. Every field is `{ value, reason }`; a missing artifact is null WITH the
 * reason, never a zero that could read as a measured failure.
 */
function scoreArm(entries, { task, cli, workTotal }) {
  const out = {
    guardCorrect: unknownField("ground_truth_unavailable"),
    workCorrect: { value: null, total: workTotal, reason: "ground_truth_unavailable", scored: 0 },
    reexplainNeeded: unknownField("ground_truth_unavailable"),
    handoffLossy: unknownField("not_applicable"),
    source: "cli/<stepId>.json",
    artifactsMissing: [],
  }
  if (!task) return out
  const pick = (role) => entries.find((v) => roleOf(v) === role) ?? null
  const guardStep = pick("guard") ?? pick("resume_raw")
  if (!guardStep) out.guardCorrect = unknownField("step_missing")
  else {
    const { text, reason } = cliText(cli, guardStep.rec.stepId)
    if (text === null) {
      out.guardCorrect = { value: null, reason, stepId: guardStep.rec.stepId }
      out.artifactsMissing.push(guardStep.rec.stepId)
    } else out.guardCorrect = { value: scoreGuard(text, task.guardAnswer).correct, reason: null, stepId: guardStep.rec.stepId }
  }
  const park = pick("park_parent")
  if (park) {
    const { text, reason } = cliText(cli, park.rec.stepId)
    if (text === null) {
      out.handoffLossy = { value: null, reason, stepId: park.rec.stepId }
      out.artifactsMissing.push(park.rec.stepId)
    } else out.handoffLossy = { value: handoffLossy(text, task.guardAnswer), reason: null, stepId: park.rec.stepId }
  }
  const r2 = pick("r2")
  if (!r2) out.reexplainNeeded = unknownField("not_applicable")
  else {
    const { text, reason } = cliText(cli, r2.rec.stepId)
    if (text === null) {
      out.reexplainNeeded = { value: null, reason, stepId: r2.rec.stepId }
      out.artifactsMissing.push(r2.rec.stepId)
    } else out.reexplainNeeded = { value: reexplainNeeded(text) ? 1 : 0, reason: null, stepId: r2.rec.stepId }
  }
  const work = entries.filter((v) => roleOf(v) === "work")
  if (!work.length) out.workCorrect = { value: null, total: workTotal, reason: "step_missing", scored: 0 }
  else {
    let correct = 0
    let scored = 0
    let missing = null
    for (const v of work) {
      const k = workStepOf(v)
      const truth = k !== null ? task.workSteps[k - 1]?.truth ?? null : null
      if (truth === null) {
        missing = missing ?? "work_step_unknown"
        continue
      }
      const { text, reason } = cliText(cli, v.rec.stepId)
      if (text === null) {
        missing = missing ?? reason
        out.artifactsMissing.push(v.rec.stepId)
        continue
      }
      scored += 1
      if (scoreWork(text, truth).correct) correct += 1
    }
    // A partially scored set is not a score: an absent answer is unknown, never a wrong answer.
    out.workCorrect = missing ? { value: null, total: workTotal, reason: missing, scored } : { value: correct, total: workTotal, reason: null, scored }
  }
  return out
}

// ------------------------------------------- 4. restore-decomposition

const RESTORE_PHASES = ["ctx_create", "resume_raw", "park_parent", "restore_child", "useful_work", "warm", "observe"]

function phaseSums(entries) {
  const phases = {}
  const byArmPhase = {}
  for (const v of entries) {
    const phase = v.rec.phase ?? "unknown"
    const arm = v.rec.arm ?? "unknown"
    phases[phase] ??= emptySums()
    addTo(phases[phase], v.rec)
    byArmPhase[arm] ??= {}
    byArmPhase[arm][phase] ??= emptySums()
    addTo(byArmPhase[arm][phase], v.rec)
  }
  return { phases, byArmPhase }
}

const delayBetween = (first, last) => {
  const a = msOf(first?.rec?.ts_req)
  const b = msOf(last?.rec?.ts)
  return a === null || b === null ? null : b - a
}

/** The runs of one attempt: phase sums, conversions and quality per run. */
function restoreUnits(recs, opts = {}) {
  const view = tickView(recs, opts)
  const ends = conversionEnds(opts)
  const cli = opts.cli ?? null
  const runs = []
  for (const [index, entries] of groupByUnit(view)) {
    const { phases, byArmPhase } = phaseSums(entries)
    const restoreChild = entries.filter((v) => v.rec.phase === "restore_child").sort(byViewIndex)
    const rawResume = entries.filter((v) => v.rec.phase === "resume_raw" && roleOf(v) !== "gate").sort(byViewIndex)
    const gate = entries.find((v) => roleOf(v) === "gate")
    // Amendment 2026-09-27: a run whose big-context rows carry a system prompt file hash was sent in
    // the resume-sysfile form (there is no fallback form); older runs keep the gate-derived mode.
    const sysfile = entries.some((v) => typeof v.rec.systemPromptSha256 === "string")
    const childMisses = entries
      .filter((v) => v.rec.arm === "park_path" && v.usage.cacheWrite1h >= RULES.restore.bigContextRewriteWrite1h)
      .map((v) => v.rec.stepId)
    const armSum = (arm) => {
      const s = emptySums()
      for (const v of entries.filter((x) => x.rec.arm === arm)) addTo(s, v.rec)
      return s
    }
    const park = armSum("park_path")
    const raw = armSum("raw_path")
    const task = opts.taskOf ? opts.taskOf(index) : null
    runs.push({
      run: index,
      mode: sysfile ? BIG_CONTEXT_MODE : gate ? (gate.usage.cacheRead >= RULES.restore.gateMinCacheRead && gate.usage.cacheWrite1h < RULES.restore.gateMaxWrite1h ? "resume" : "rf-emulation") : "unknown",
      gate: gate ? { stepId: gate.rec.stepId, cacheRead: gate.usage.cacheRead, cacheWrite1h: gate.usage.cacheWrite1h } : null,
      phases,
      byArmPhase,
      totals: { park, raw, shared: armSum("shared") },
      resumeDelayMs: {
        park: restoreChild.length ? delayBetween(restoreChild[0], restoreChild[restoreChild.length - 1]) : null,
        raw: rawResume.length ? delayBetween(rawResume[0], rawResume[rawResume.length - 1]) : null,
        flagAboveMs: RULES.restore.resumeDelayFlagMs,
      },
      quality: {
        park_path: scoreArm(entries.filter((v) => v.rec.arm === "park_path"), { task, cli, workTotal: RULES.restore.workSteps }),
        raw_path: scoreArm(entries.filter((v) => v.rec.arm === "raw_path"), { task, cli, workTotal: RULES.restore.workSteps }),
        groundTruth: task ? { seed: task.seed, ticket: task.ticket, source: "makeTask(seed) from experiment_started" } : { seed: null, source: "unavailable" },
      },
      childResumeMisses: childMisses,
      converted: { park: convertSums(park, ends), raw: convertSums(raw, ends) },
      byMeter: Object.fromEntries(
        METERS.map((m) => {
          const e = conversionEnds({ ...opts, meter: m })
          return [m, { park: convertSums(park, e), raw: convertSums(raw, e) }]
        }),
      ),
    })
  }
  return runs
}

const restoreAggregate = (runs, opts = {}) => ({
  experiment: "restore-decomposition",
  status: runs.length ? "valid" : "void",
  runs,
  phasesTracked: RESTORE_PHASES,
  conversionProvenance: conversionEnds(opts).provenance,
})

export function analyzeRestore(recs, opts = {}) {
  return restoreAggregate(restoreUnits(recs, opts), opts)
}

const byViewIndex = (a, b) => (a.rec.index ?? 0) - (b.rec.index ?? 0)

// -------------------------------------------------- 5. policy-effect

const ARMS = ["shadow_candidate_policy", "current_policy"]

/** The pairs of one attempt, each arm priced at both range ends and scored. */
function policyUnits(recs, opts = {}) {
  const view = tickView(recs, opts)
  const endsByMeter = Object.fromEntries(METERS.map((m) => [m, conversionEnds({ ...opts, meter: m })]))
  const cli = opts.cli ?? null
  const pairs = []
  for (const [index, entries] of groupByUnit(view)) {
    const task = opts.taskOf ? opts.taskOf(index) : null
    const arms = {}
    for (const arm of ARMS) {
      const mine = entries.filter((v) => v.rec.arm === arm).sort(byViewIndex)
      if (!mine.length) continue
      const totals = emptySums()
      for (const v of mine) addTo(totals, v.rec)
      const warm = mine.filter((v) => v.rec.phase === "warm")
      const warmMisses = warm.filter((v) => v.usage.cacheRead < RULES.policy.warmMinCacheRead).length
      const restore = mine.filter((v) => v.rec.phase === "restore_child").sort(byViewIndex)
      const rawResume = mine.filter((v) => v.rec.phase === "resume_raw").sort(byViewIndex)
      arms[arm] = {
        arm,
        totals,
        metersEq: Object.fromEntries(METERS.map((m) => [m, convertSums(totals, endsByMeter[m])])),
        resumeDelayMs: restore.length ? delayBetween(restore[0], restore[restore.length - 1]) : rawResume.length ? delayBetween(rawResume[0], rawResume[rawResume.length - 1]) : null,
        warm: warm.length ? { pings: warm.length, misses: warmMisses } : null,
        quality: scoreArm(mine, { task, cli, workTotal: RULES.policy.workSteps }),
        state: warmMisses >= RULES.policy.warmMissStop ? "warm_miss" : "complete",
      }
    }
    const shared = entries.filter((v) => v.rec.arm === "shared")
    const sharedSum = emptySums()
    for (const v of shared) addTo(sharedSum, v.rec)
    pairs.push({ pair: index, arms, shared: sharedSum, groundTruth: task ? { seed: task.seed, ticket: task.ticket } : { seed: null } })
  }
  return pairs
}

function policyAggregate(pairs) {
  const complete = pairs.filter((p) => ARMS.every((a) => p.arms[a]))
  const diffInterval = (cand, cur) => ({ lo: (cand.lo ?? 0) - (cur.hi ?? 0), hi: (cand.hi ?? 0) - (cur.lo ?? 0) })
  const perMeter = {}
  for (const m of METERS) {
    const diffs = complete.map((p) => diffInterval(p.arms.shadow_candidate_policy.metersEq[m], p.arms.current_policy.metersEq[m]))
    perMeter[m] = diffs.length
      ? {
          mean: { lo: diffs.reduce((a, d) => a + d.lo, 0) / diffs.length, hi: diffs.reduce((a, d) => a + d.hi, 0) / diffs.length },
          min: { lo: Math.min(...diffs.map((d) => d.lo)) },
          max: { hi: Math.max(...diffs.map((d) => d.hi)) },
          perPair: diffs,
        }
      : { mean: null, min: null, max: null, perPair: [] }
  }
  const delays = complete
    .map((p) => ({ cand: p.arms.shadow_candidate_policy.resumeDelayMs, cur: p.arms.current_policy.resumeDelayMs }))
    .filter((d) => d.cand !== null && d.cur !== null)
    .map((d) => d.cand - d.cur)
  const states = [...new Set(pairs.flatMap((p) => ARMS.filter((a) => p.arms[a]).map((a) => p.arms[a].state)))].sort()
  const qualityDiff = (pick) => {
    const values = complete.map((p) => ({ cand: pick(p.arms.shadow_candidate_policy.quality), cur: pick(p.arms.current_policy.quality) }))
    if (!values.length || values.some((v) => v.cand === null || v.cur === null)) return { value: null, reason: "unknown_for_at_least_one_arm", n: values.length }
    return { value: values.reduce((a, v) => a + (v.cand - v.cur), 0) / values.length, reason: null, n: values.length }
  }
  return {
    experiment: "policy-effect",
    status: pairs.length ? "valid" : "void",
    pairs,
    states,
    pairedDifferences: {
      definition: "candidate (park) minus current (keep warm), per pair, same context and same 8 work steps",
      n: complete.length,
      intervalClaim: false,
      note: "n = 3 paired runs: a mean and a range, never a confidence interval",
      perMeter,
      resumeDelayMs: delays.length ? { mean: delays.reduce((a, d) => a + d, 0) / delays.length, min: Math.min(...delays), max: Math.max(...delays), n: delays.length } : null,
      quality: {
        source: "cli/<stepId>.json scored against makeTask(seed) ground truth",
        workCorrectMeanDiff: qualityDiff((q) => q.workCorrect.value),
        guardCorrectMeanDiff: qualityDiff((q) => (q.guardCorrect.value === null ? null : q.guardCorrect.value ? 1 : 0)),
      },
    },
  }
}

export function analyzePolicy(recs, opts = {}) {
  return policyAggregate(policyUnits(recs, opts))
}

// --------------------------------------------------- clean-window rule

/**
 * A window is a measurement only when it is complete and clean. `opts.baselineResets` is the set
 * of reset epochs the experiment_started events recorded: a request outside it crossed a reset
 * boundary even when all requests agree with each other (the stale-baseline case).
 */
export function windowStatus(records, events, experiment, opts = {}) {
  const rows = records.filter((r) => r.experiment === experiment)
  const recs = rows.filter(isPaid)
  const unpaid = rows.filter((r) => requestCountOf(r) === 0).map((r) => r.stepId)
  const malformedCount = rows.filter(hasMalformedCount).map((r) => r.stepId)
  if (!rows.length) return { experiment, clean: false, sourceKind: "unknown", reasons: ["not_run"], requests: 0, resetEpochs: [] }
  const reasons = new Set()
  if (opts.malformedRows) reasons.add("malformed_evidence_row")
  const baselineResets = Array.isArray(opts.baselineResets) ? opts.baselineResets.filter((x) => Number.isFinite(x)) : []
  const resets = new Set()
  const counts = new Map()
  const unknownUsage = new Set()
  for (const r of recs) {
    const reading = meterReading(r, METER_5H)
    if (reading && Number.isFinite(reading.reset)) {
      resets.add(reading.reset)
      if (baselineResets.length && !baselineResets.includes(reading.reset)) reasons.add("baseline_reset_mismatch")
    } else reasons.add("meter_reading_missing")
    counts.set(r.stepId, (counts.get(r.stepId) ?? 0) + 1)
    if (typeof r.role !== "string" || !r.role) reasons.add("schema_incomplete")
    if (unitIndexOf(r.unit) === null || typeof r.unit.kind !== "string") reasons.add("schema_incomplete")
    const f = fields(r)
    if (!f.hasUsage) {
      reasons.add("usage_incomplete")
      unknownUsage.add("usage_object_missing")
    } else if (f.unknownFields.length) {
      reasons.add("usage_incomplete")
      for (const u of f.unknownFields) unknownUsage.add(u)
    }
    if (r.model !== RULES.model) reasons.add("model_not_echoed")
    const status = r.headers?.["anthropic-ratelimit-unified-status"]
    if (status !== undefined && status !== "allowed") reasons.add("status_not_allowed")
    if (r.stop_reason === "refusal") reasons.add("refusal")
    if (Array.isArray(r.anomalies) && r.anomalies.length) reasons.add("anomalies_present")
    if (r.error) reasons.add("request_error")
  }
  if (unpaid.length) reasons.add("unpaid_request_row")
  if (malformedCount.length) reasons.add("malformed_request_count")
  if (resets.size > 1) reasons.add("reset_in_window")
  for (const [, n] of counts) if (n !== 1) reasons.add("unexpected_request_count")
  const intents = new Set()
  const results = new Set()
  for (const e of events ?? []) {
    if (e?.experiment !== experiment) continue
    if (e.ev === "step_intent" && typeof e.stepId === "string") intents.add(e.stepId)
    if (e.ev === "step_result" && typeof e.stepId === "string") results.add(e.stepId)
  }
  for (const id of intents) if (!results.has(id)) reasons.add("in_doubt_step")
  // A resume that found a recorded result without its requests.jsonl row says so (row_missing):
  // that call's usage and reading are gone, so the experiment cannot be measured.
  if ((events ?? []).some((e) => e?.ev === "row_missing" && e.experiment === experiment)) reasons.add("request_row_missing")
  // Request rows and the checkpoint must describe the same set of calls, 1:1 (an unpaid row
  // still records its step).
  const requestIds = new Set(rows.map((r) => r.stepId))
  const missingRequest = [...results].filter((id) => !requestIds.has(id))
  const unannounced = [...requestIds].filter((id) => intents.size > 0 && !intents.has(id))
  if (missingRequest.length || unannounced.length) reasons.add("request_step_mismatch")
  const list = [...reasons].sort()
  return {
    experiment,
    clean: list.length === 0,
    sourceKind: list.length === 0 ? "measured" : "unknown",
    reasons: list,
    requests: recs.length,
    resetEpochs: [...resets].sort(),
    baselineResets,
    unknownUsageFields: [...unknownUsage].sort(),
    ...(unpaid.length ? { unpaidRequestRows: unpaid.sort() } : {}),
    ...(malformedCount.length ? { malformedRequestCountRows: malformedCount.sort() } : {}),
    stepParity: { requests: requestIds.size, intents: intents.size, results: results.size, missingRequest: missingRequest.sort(), unannounced: unannounced.sort() },
  }
}

const hardReasonOf = (reasons) => HARD_REASONS.find((r) => reasons.includes(r)) ?? null

// ------------------------------------------------- coefficient records

/**
 * One record per meter in the engine's CostCoefficients shape: `evidenceRef` is a STRING, every
 * unmeasured field stays null, and the structured provenance is returned beside the records
 * (never inside them). The published point is the UPPER bound of the quantization interval.
 */
export function buildCoefficientRecords({ T, kOut, outputStatus = "unidentified", outputReason = null, sourceKind, window, runId, requestsSha256, sampleCount, measuredAt, validFrom }) {
  const records = []
  const provenance = []
  for (const meter of METERS) {
    const mult = METER_MULTIPLIER[meter]
    const measured = sourceKind === "measured" && T !== null
    const kind = !measured ? "unknown" : mult.sourceKind
    const tokensPerTick = T ? { lo: T.lo * mult.range[0], hi: T.hi * mult.range[1] } : null
    const write = measured && tokensPerTick ? [RESOLUTION / tokensPerTick.hi, RESOLUTION / tokensPerTick.lo] : null
    // The output coefficient is identified on the 5h gauge only, and only when the phase was
    // observed; the slower meters have no output observation of their own.
    const outMeasured = measured && kOut && outputStatus === "measured" && meter === METER_5H
    const out = outMeasured ? [kOut.lo * RESOLUTION, kOut.hi * RESOLUTION] : null
    const unit = `${meter}-utilization-fraction`
    const ref = runId ? `idle-live-run/${runId}/fable-write-tick#${write ? "pointRule=upper_quantization_bound" : "status=unknown"}` : null
    records.push({
      modelId: RULES.model,
      provider: "firstParty",
      authLane: "claude-sdk-oauth",
      ttlLane: "1h",
      effortOrConfigIdentity: CONFIG_IDENTITY,
      quotaMeterOrCostUnit: unit,
      validFrom: validFrom ?? null,
      measuredAt: measuredAt ?? null,
      sourceKind: kind,
      evidenceRef: ref,
      sampleCount: sampleCount ?? 0,
      version: SCHEMA_VERSION,
      coefficients: {
        uncachedInput: null,
        cacheWrite5m: null,
        cacheWrite1h: write ? write[1] : null,
        cacheRead: null,
        billedModelOutput: out ? out[1] : null,
      },
      observedRangeOrUncertainty: {
        ...(write ? { cacheWrite1h: write } : {}),
        ...(out ? { billedModelOutput: out } : {}),
      },
    })
    provenance.push({
      quotaMeterOrCostUnit: unit,
      evidenceRef: ref,
      runId: runId ?? null,
      requestsSha256: requestsSha256 ?? null,
      window: window ?? null,
      pointRule: "upper_quantization_bound",
      rangeKind: "quantization_bounds",
      statisticalConfidenceInterval: false,
      meterMultiplierFromReportedLog: meter === METER_5H ? null : mult.range,
      status: write ? "range_only" : "unidentified",
      fields: {
        cacheWrite1h: write
          ? { status: "range_only", sourceKind: kind, range: write, reason: null }
          : { status: "unidentified", sourceKind: "unknown", range: null, reason: "no_clean_fable_window" },
        billedModelOutput: outMeasured
          ? { status: "measured", sourceKind: kind, range: out, reason: null }
          : { status: meter === METER_5H ? outputStatus : "unidentified", sourceKind: "unknown", range: null, reason: meter === METER_5H ? outputReason : "no_output_observation_on_this_meter" },
        cacheWrite5m: { status: "skipped", sourceKind: "unknown", range: null, reason: "adapter_capability" },
        cacheRead: { status: "prior_only", sourceKind: "reported_unverified", range: null, reason: "not_measured_by_this_run" },
        uncachedInput: { status: "unidentified", sourceKind: "unknown", range: null, reason: "bounded_above_by_cacheWrite1h" },
      },
      priors: {
        cacheRead: { evidenceRef: PRIOR_RANGE_ONLY.evidenceRef, range: [...PRIOR_RANGE_ONLY.cacheRead], unit: PRIOR_RANGE_ONLY.unit, sourceKind: PRIOR_RANGE_ONLY.sourceKind },
        cacheWrite1h: { evidenceRef: PRIOR_RANGE_ONLY.evidenceRef, range: [...PRIOR_RANGE_ONLY.cacheWrite1h], unit: PRIOR_RANGE_ONLY.unit, sourceKind: PRIOR_RANGE_ONLY.sourceKind },
        outputRatio: { range: [...OUTPUT_RATIO_PRIOR], unit: "x_write_coefficient", sourceKind: "reported_unverified" },
      },
    })
  }
  return { records, provenance }
}

// ----------------------------------------------------- engine feed

const DEFAULT_PLANNER = Object.freeze({ ttlMs: 3600000, intervalMs: 3000000, remainingTtlMs: 3600000, sharedCachePersists: true, requestArrivalDelayMs: 0, safetyMarginMs: 0 })
const UNCONFIGURED_LIMITS = Object.freeze({
  unit: "unconfigured",
  maxProactiveSpendPerIdle: "unconfigured",
  maxTotalExperimentalSpend: "unconfigured",
  maxResumeDelayMs: "unconfigured",
  allowedQualityDegradation: "unconfigured",
  minimumEvidenceForEnforcement: "unconfigured",
})
// AGENT_TASK section B4 names q = 1 and q = 0.5 as values that must NOT be asserted as facts.
// They appear here only as hypothetical planIdle scenarios beside the V = 0 baseline.
const HYPOTHETICAL_SCENARIOS = Object.freeze([
  { id: "q1_return_after_2h", returns: [{ afterMs: 7200000, probability: 1 }], neverReturnsProbability: 0 },
  { id: "q0.5_return_after_2h", returns: [{ afterMs: 7200000, probability: 0.5 }], neverReturnsProbability: 0.5 },
])
const V_SCENARIO = Object.freeze({ label: "idle-live/V0", vSignedEq: 0, status: "scenario" })

const planView = (p) => ({ action: p.action, expectedCostEq: p.expectedCostEq, costs: p.costs, rootSpendEq: p.rootSpendEq, notes: p.notes })
const decisionView = (d, costs) => ({
  engineVersion: d.engineVersion,
  recommendedAction: d.recommendedAction,
  reasonCode: d.reasonCode,
  evidenceStatus: d.evidenceStatus,
  blockers: [...d.blockers],
  guardReasons: [...d.guardReasons],
  candidateCosts: d.candidateCosts,
  spendGate: d.spendGate,
  vAppliedEq: d.vAppliedEq,
  forecast: null,
  costs,
})

/** Build the engine's IdleCostModel from restore/policy phase sums converted at one range end. */
export function buildIdleCostModel(phaseEq) {
  const nonneg = (x) => (Number.isFinite(x) && x >= 0 ? x : 0)
  const cold = Math.max(nonneg(phaseEq.ctxCreate), nonneg(phaseEq.warm))
  return {
    warmEq: nonneg(phaseEq.warm),
    coldWarmEq: Math.max(cold, nonneg(phaseEq.warm)),
    rawWarmEq: nonneg(phaseEq.resumeRaw),
    parkNowEq: nonneg(phaseEq.parkParent),
    restoreWarmEq: nonneg(phaseEq.restoreChild),
    // Not measured by this run: reported as 0 baselines and listed in `unknowns`, never as facts.
    skillRestoreEq: 0,
    sharedLossEq: 0,
    coldSharedEq: cold,
    coldFullEq: cold,
    parkQualityEq: 0,
    futureWorkDifferentialEq: 0,
  }
}

function idleCostSnapshot(costs, { end, runId, planner, limits, noForecastObjective, contextTokens, timestampMs }) {
  return {
    idleEpisodeId: `${runId ?? "idle-live-analysis"}#${end}`,
    timestampMs: timestampMs ?? 0,
    sessionGeneration: runId ?? "idle-live-analysis",
    modelId: RULES.model,
    lane: "1h",
    contextTokens: contextTokens ?? 0,
    coefficientVersion: SCHEMA_VERSION,
    // The conversion set mixes a measured write coefficient with reported priors.
    coefficientStatus: "reported_unverified",
    forecastVersion: null,
    parameterSources: {
      costs: "idle-live-run phase sums converted at one end of every coefficient range",
      forecast: "not_measured",
      meter: `${METER_5H}-utilization-fraction`,
    },
    cache: { state: "warm", reasons: [], arrivalAtMs: null, remainingTtlAtArrivalMs: null, verifiedPrefixTokens: contextTokens ?? 0, retryAllowed: false },
    costs,
    forecast: null,
    planner: { ...DEFAULT_PLANNER, ...(planner ?? {}) },
    gates: { allowParking: true, reasons: [] },
    limits: { ...UNCONFIGURED_LIMITS, ...(limits ?? {}) },
    incurredSpendEq: 0,
    vScenario: V_SCENARIO,
    mode: "shadow",
    ...(noForecastObjective ? { noForecastObjective } : {}),
  }
}

/**
 * The policy answer. `evaluateIdleCost` runs at the LOW and the HIGH end of every coefficient
 * range with forecast null and V = 0; the action is the engine's only when both ends agree.
 * planIdle is run for the AGENT_TASK q values as labelled hypothetical scenarios only.
 */
export function engineFeed({ modelLow, modelHigh, scenarios = null, planner = null, limits = null, noForecastObjective = null, notes = [], runId = null, contextTokens = 0, timestampMs = 0, evidenceOk = true, evidenceReason = null } = {}) {
  const plannerOpts = { ...DEFAULT_PLANNER, ...(planner ?? {}) }
  const out = {
    engine: "evaluateIdleCost",
    actionSource: "evaluateIdleCost",
    forecast: null,
    forecastReason: "no_calibrated_forecast: q is never invented; the entries below are labelled hypothetical scenarios",
    baseline: { futureWorkDifferentialEq: 0, vScenario: V_SCENARIO, quality: "not_monetised" },
    options: plannerOpts,
    limits: { ...UNCONFIGURED_LIMITS, ...(limits ?? {}) },
    noForecastObjective: noForecastObjective ?? "no_speculative_spend",
    evaluatedAt: null,
    scenarios: [],
    action: "NO_DECISION",
    reason: "no_cost_model",
    notes: [...notes],
  }
  if (!evidenceOk) {
    out.action = "NO_DECISION"
    out.reason = "evidence_incomplete"
    out.notes.push(evidenceReason ? `evidence_incomplete: ${evidenceReason}` : "evidence_incomplete")
    return out
  }
  if (!modelLow || !modelHigh) return out
  const context = { runId, planner: plannerOpts, limits, noForecastObjective, contextTokens, timestampMs }
  const low = evaluateIdleCost(idleCostSnapshot(modelLow, { ...context, end: "low" }))
  const high = evaluateIdleCost(idleCostSnapshot(modelHigh, { ...context, end: "high" }))
  out.evaluatedAt = { low: decisionView(low, modelLow), high: decisionView(high, modelHigh) }
  if (low.recommendedAction === high.recommendedAction) {
    out.action = low.recommendedAction
    out.reason = "both_range_ends_agree"
    if (low.recommendedAction === "NO_DECISION") out.notes.push(`engine reasonCode: ${low.reasonCode}`)
  } else {
    out.action = "NO_DECISION"
    out.reason = "coefficient_range_straddles_boundary"
  }
  for (const s of scenarios ?? HYPOTHETICAL_SCENARIOS) {
    const forecast = { returns: s.returns, neverReturnsProbability: s.neverReturnsProbability }
    let lowPlan = null
    let highPlan = null
    let error = null
    try {
      lowPlan = planIdle(modelLow, forecast, { ...plannerOpts, allowParking: true })
      highPlan = planIdle(modelHigh, forecast, { ...plannerOpts, allowParking: true })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const agree = lowPlan && highPlan && lowPlan.action === highPlan.action
    out.scenarios.push({
      id: s.id,
      labelledAs: "hypothetical",
      promoted: false,
      forecast,
      low: lowPlan ? planView(lowPlan) : null,
      high: highPlan ? planView(highPlan) : null,
      action: agree ? lowPlan.action : "NO_DECISION",
      reason: error ? `engine_error:${error}` : agree ? "both_range_ends_agree" : "coefficient_range_straddles_boundary",
    })
  }
  return out
}

// --------------------------------------------------------- spend

function spendByMeter(records, events) {
  const baselines = {}
  for (const e of events ?? []) {
    if (e?.ev !== "experiment_started" || !e.baselines) continue
    for (const m of METERS) {
      const b = e.baselines[m]
      if (b && Number.isFinite(b.util) && baselines[m] === undefined) baselines[m] = { util: b.util, reset: b.reset }
    }
  }
  const out = {}
  for (const m of METERS) {
    const readings = records.map((r) => meterReading(r, m)).filter(Boolean)
    if (!readings.length) {
      out[m] = { present: false, windows: 0, observedEq: null, upperEq: null, startUtil: null, endUtil: null }
      continue
    }
    const windows = []
    const first = baselines[m]?.reset === readings[0].reset ? baselines[m] : readings[0]
    let current = { reset: first.reset, start: first.util, end: first.util }
    for (const r of readings) {
      if (r.reset !== current.reset) {
        windows.push(current)
        const start = baselines[m]?.reset === r.reset ? Math.min(baselines[m].util, r.util) : r.util
        current = { reset: r.reset, start, end: r.util }
        continue
      }
      current.end = r.util
    }
    windows.push(current)
    let observed = 0
    for (const w of windows) observed += Math.round((w.end - w.start) / RESOLUTION) * RESOLUTION
    out[m] = {
      present: true,
      windows: windows.length,
      observedEq: Math.round(observed * 1e6) / 1e6,
      upperEq: Math.round((observed + windows.length * RESOLUTION) * 1e6) / 1e6,
      startUtil: windows[0].start,
      endUtil: windows[windows.length - 1].end,
      perWindow: windows.map((w) => ({ resetEpoch: w.reset, startUtil: w.start, endUtil: w.end, observedEq: Math.round(Math.round((w.end - w.start) / RESOLUTION) * RESOLUTION * 1e6) / 1e6 })),
      upperRule: "observed + 0.01 per reset window (the gauge only shows floor(cumulative/0.01))",
    }
  }
  return out
}

// ------------------------------------------------------ analyzeRun

const startedEvents = (events, experiment) => (events ?? []).filter((e) => e?.ev === "experiment_started" && e.experiment === experiment)

// Reason codes the MACHINE records on experiment_ended and campaign_stop (Appendix B "Resume
// verdict contract, revision 2", clarification A, and the machine's gate, delivery and stop-rule
// verdicts - a gate refusal records the first caps.mjs reason code, else gate_refused), plus the
// event-derived voids below, with the words the Korean results doc uses for them. The analyzer reports each one
// explicitly; it never re-derives a verdict for an experiment the machine closed.
const REASON_TEXT = Object.freeze({
  interrupted_by_crash: "크래시 시점에 진행 중이던 실험: 재개가 남은 단계를 발행하지 않고 무효로 닫았다",
  cancelled: "호출이 진행 중일 때 운영자가 취소하여 실험을 무효로 닫았다",
  cancelled_before_start: "첫 발행 전에 운영자가 취소했다(시작 전 취소): 요청이 없고 측정한 것이 없다",
  cap_exceeded: "다음 호출이 지출 한도를 넘을 것으로 예측되어 게이트가 거부했다: 이 실험만 중단했다",
  aborted_before_invoke: "호출 직전에 운영자 취소가 도착해 호출하지 않았다",
  aborted_in_quiet_wait: "조용함 확인 대기 중 운영자 취소로 중단했다",
  unknown_issue_state: "호출이 실제로 나갔는지 알 수 없다(proxy 기록 없음): 재발행하지 않고 무효로 닫았다",
  skipped_arm_requested: "어댑터가 지원하지 않는 arm의 단계가 요청되어 중단했다",
  foreign_traffic: "조용함 확인에서 다른 트래픽이 감지되어 중단했다",
  checkpoint_anomalies_malformed: "체크포인트의 이상 기록을 읽을 수 없어 무효로 닫았다",
  late_step: "허용 오차를 넘겨 늦게 발행될 단계라 무효로 닫았다",
  refusal: "모델이 응답을 거부했다(캠페인 중단 규칙)",
  model_mismatch: "응답 모델이 승인된 모델과 달랐다(캠페인 중단 규칙)",
  status_not_allowed: "한도 상태가 allowed가 아니었다(캠페인 중단 규칙)",
  http_error: "HTTP 오류 응답을 받았다(캠페인 중단 규칙)",
  unexpected_request_count: "한 단계의 요청 수가 1이 아니었다(캠페인 중단 규칙)",
  adapter_error: "CLI 어댑터가 실패해 결과를 신뢰할 수 없다",
  cli_is_error: "CLI가 오류 결과를 보고했다",
  cli_stdout_not_json: "CLI 출력이 JSON이 아니었다",
  usage_missing: "응답에 사용량(usage)이 없었다",
  response_error: "응답이 오류였다",
  in_doubt_step: "결과가 확정되지 않은 단계가 있어 게이트가 거부했다",
  unpredictable_call: "호출 비용을 예측할 수 없어 게이트가 거부했다",
  meter_missing: "한도 계기 값이 없어 게이트가 거부했다",
  reset_changed: "기준선 이후 한도 창이 바뀌어 게이트가 거부했다",
  gate_refused: "게이트가 사유 코드 없이 호출을 거부했다",
  campaign_stop: "캠페인 중단 한도에 닿아 게이트가 거부하고 캠페인을 멈췄다",
  invalid_step: "단계 기술이 올바르지 않아 게이트가 거부했다",
  invalid_state: "게이트 상태를 읽을 수 없어 게이트가 거부했다",
  invalid_approval: "승인 파일의 한도 정의를 읽을 수 없어 게이트가 거부했다",
  unknown_experiment: "승인 파일에 없는 실험이라 게이트가 거부했다",
  invalid_cap: "승인된 한도 값이 숫자가 아니어서 게이트가 거부했다",
  invalid_scope: "이 단계의 유휴 한도 범위를 정할 수 없어 게이트가 거부했다",
  invalid_window: "닫힌 한도 창 기록이 올바르지 않아 게이트가 거부했다",
  invalid_windows: "닫힌 한도 창 목록을 읽을 수 없어 게이트가 거부했다",
  invalid_reading: "계기 판독값(사용률 또는 reset 시각)이 올바르지 않아 게이트가 거부했다",
  meter_absent: "응답 헤더에 이 한도 계기가 없었다(게이트는 경고로만 기록한다)",
  request_row_missing: "기록된 응답의 requests.jsonl 행이 없어(row_missing) 사용량을 읽을 수 없다",
  // The miss is read from the response's own usage (cacheWrite1h >= the big-context
  // threshold, protocols.mjs bigContextRewriteWrite1h), not from a gauge reading or header lag -
  // once one big-context call shows the cache miss, the machine stops issuing further big-context
  // jobs of that kind rather than pay the same ~143K rewrite again.
  fallback_mode_misses: "앞서 기록된 호출이 이 대용량 컨텍스트 전송 방식으로는 캐시를 읽지 못한다는 것을 보였다(첫 재개 확인에서 캐시를 놓쳤거나 대용량 컨텍스트를 처음부터 다시 썼다). 이 작업도 같은 비용을 낼 것으로 보고 호출 없이(0건) 바로 중단했다",
  // Mode-neutral: a big-context rewrite can happen under --resume or under the rf-emulation
  // fallback (both are recorded session modes for this job) - the text must not assert which one
  // ran without reading the event's own `result.mode`.
  big_context_rewrite: "이 호출의 사용량이 캐시를 놓치고 대용량 컨텍스트를 처음부터 다시 썼다(--resume이든 대체 모드 rf-emulation이든, 기록된 세션 모드에서 캐시 적중을 얻지 못했다는 뜻이다): 이후 같은 종류의 작업은 같은 비용을 낼 것으로 보고 중단했다",
  // Amendment 2026-09-27 (todo 21b): the resume-hit gate of the system-prompt-file form missed.
  // There is no fallback form any more, so the run stops there and later big-context jobs close
  // without calls (fallback_mode_misses).
  resume_gate_miss: "컨텍스트를 만든 뒤 같은 세션을 이어 받은 첫 확인 호출이 캐시를 읽지 못했다. 이 전송 방식이 캐시에 적중하지 않는다는 뜻이라 다른 방식에 비용을 쓰지 않고 이 실행을 중단했고, 이후의 대용량 컨텍스트 작업도 호출 없이 닫았다",
  // The CLI adapter checks the big-context file before it starts the CLI; these refusals send nothing.
  system_prompt_mismatch: "대용량 컨텍스트 파일의 내용이 기록된 해시와 달라 호출하지 않고 이 실험을 중단했다",
  system_prompt_missing: "대용량 컨텍스트 파일이 없어 호출하지 않고 이 실험을 중단했다",
  bad_system_prompt: "대용량 컨텍스트 파일을 가리키는 기록이 올바르지 않아 호출하지 않고 이 실험을 중단했다",
  skipped_arm: "이 어댑터가 지원하지 않는 arm의 단계라서 발행하지 않고 건너뛰었다",
  run_already_ended: "이전 프로세스가 이미 캠페인을 종료 상태로 기록해 재개가 더 이상 호출하지 않았다",
  smoke_dial_miss: "smoke 모드의 dial 읽기가 예상한 캐시 적중을 보이지 않았다",
  // Protocol verdicts (scripts/idle-live/protocols.mjs), recorded into experiment_ended by
  // machine.mjs. The output-quota gate floor is proportional to the block's own output target
  // (gateMinOutput * level.target / outputTarget, protocols.mjs:325), not a fixed 6,000 - block
  // 1's floor happens to be 6,000 (the base gateMinOutput) but block 3's is 3,000 (a 4K target).
  // The post-walk stops at 40 reads, so its text says the walk read all 40, not that it exceeded them.
  short_output: "8K 블록의 최소 출력 토큰 기준은 6,000이고, 그보다 작은 블록은 그 블록의 목표 출력에 비례해 정해진다. 이 기준을 채우지 못했거나, 채웠어도 모델이 끝까지 답하지 않은(stop_reason이 end_turn이 아닌) 첫 호출이라 이 실험을 중단했다",
  dial_miss: "dial 읽기가 예상한 캐시 적중(prefix hit)을 보이지 않아 이 실험 전체를 중단했다",
  early_tick: "예비 걷기(pre-walk) 중 너무 이르게 tick이 관측돼 위상을 신뢰할 수 없어 이 실험 전체를 무효로 닫았다",
  no_dial_prefix: "이 블록이 쓸 dial prefix가 없어(직전 쓰기가 없거나 체인이 끊겨서) 중단했다",
  post_walk_overrun: "post-walk 걷기가 허용된 읽기 40회를 다 읽도록 tick을 보지 못했거나, tick을 보긴 했지만 이상 기준(읽기 38회 이후)보다 늦게 왔다: 두 경우 모두 이 실험을 중단했다",
  missing_record: "이 단계의 응답 기록을 읽을 수 없어(proxy 기록 없음) 무효로 닫았다",
  missing_usage: "응답에 이 판정에 필요한 사용량(usage) 필드가 없어 무효로 닫았다",
  missing_ticks: "이 판정에 필요한 게이지 tick 값을 읽을 수 없어 무효로 닫았다",
  reset_in_block: "이 블록 도중 한도 창(reset epoch)이 바뀌어 관측을 신뢰할 수 없어 무효로 닫았다",
  all_runs_invalid: "이 실험의 모든 run이 valid로 끝나지 못해 실험 전체를 무효로 닫았다",
  missing_result_text: "복원 결과 텍스트(handoff)를 읽을 수 없어 무효로 닫았다",
  // run_ended-level reasons (never an experiment's own reason, but the source scan below is
  // deliberately broad - these get real text too rather than special-cased out of it).
  preflight_refused: "preflight 점검이 거부돼 캠페인을 시작하지 않았다: 요청이 없고 측정한 것이 없다",
  window_wait_unbounded: "5시간 창의 재설정까지 대기 시간이 5시간을 넘거나 재설정 시각을 확인할 수 없어 시작하지 않았다",
  fresh_window_unknown: "첫 사전 점검 응답에서 5시간 창 재설정 시각을 읽지 못해 실험을 시작하지 않았다",
  window_not_fresh: "재설정 후 다시 확인한 5시간 창이 충분히 새 창이 아니어서 실험 전에 중단했다",
  dry_run: "--dry-run으로 실행해 일정만 출력했다: 유료 호출이 없었다",
})
// A code the machine recorded that has no entry above is still printed, and marked as recorded.
const UNDESCRIBED_REASON_TEXT = "기계가 기록한 사유 코드(추가 설명 없음)"
// Appendix B revision 2 (4), mirrored for a log no process ever resumed (todo 7 I17).
const OPEN_AT_END_OF_LOG = "open_at_end_of_log"
const OPEN_AT_END_TEXT = "로그가 이 실험 도중에 끝났다(experiment_ended도 재개 기록도 없다): 크래시로 중단된 실험으로 보고 무효로 닫았다"
// Voids the analyzer derives from an event rather than from a machine-recorded verdict.
const EVENT_DERIVED_REASONS = new Set(["cancelled_before_start", "request_row_missing"])
const CLOSED_STATUS_RANK = { void: 1, aborted: 2 }

/**
 * The attempts of one experiment in one evidence log (todo 25 D4). An attempt is one
 * experiment_started .. experiment_ended span, keyed by its `run` (null for a job that is not
 * per-run). A step belongs to the attempt that was open when its step_intent was written, and a
 * request row to the attempt of its step: step ids repeat across runs, so nothing is ever joined
 * across logs. A row or step event no attempt claims is an orphan; it joins the window of EVERY
 * attempt of the experiment, where it can only make them unclean (fail closed).
 * An experiment_ended closes the open attempt of its run; one that names no run closes the attempt
 * opened last (a producer may omit `run`). A later statement about an attempt that is already
 * closed (a resume re-states verdicts) joins that attempt's own verdicts, where the worst one wins:
 * a later verdict can close an attempt harder, never reopen it. A verdict that names no attempt of
 * this log - e.g. one written before any attempt of its run started - is stray and changes nothing.
 * A log without any experiment_started for the experiment (older evidence) is one implicit attempt.
 */
function splitAttempts(rows, events, experiment) {
  const attempts = []
  const open = new Map()
  const byStep = new Map()
  const orphanEvents = []
  const strays = []
  for (const e of events ?? []) {
    if (e?.experiment !== experiment) continue
    if (e.ev === "experiment_started") {
      const a = { ordinal: attempts.length + 1, run: e.run ?? null, started: e, ended: [], events: [e], rows: [], implicit: false }
      attempts.push(a)
      open.set(a.run, a)
    } else if (e.ev === "experiment_ended") {
      const key = e.run ?? (open.size ? [...open.keys()].pop() : null)
      const a = open.get(key) ?? (e.run == null ? attempts.at(-1) : attempts.findLast((x) => x.run === e.run)) ?? null
      if (!a) {
        strays.push(e)
        continue
      }
      a.ended.push(e)
      a.events.push(e)
      if (open.get(a.run) === a) open.delete(a.run)
    } else if (typeof e.stepId === "string") {
      let a = byStep.get(e.stepId) ?? null
      if (!a && e.ev === "step_intent" && open.size) {
        const list = [...open.values()]
        a = list.find((x) => x.run !== null && x.run === unitIndexOf(e.unit)) ?? list.at(-1)
        byStep.set(e.stepId, a)
      }
      if (a) a.events.push(e)
      else orphanEvents.push(e)
    } else if (open.size) [...open.values()].at(-1).events.push(e)
    else orphanEvents.push(e)
  }
  const orphanRows = []
  for (const r of rows ?? []) {
    if (r?.experiment !== experiment) continue
    const a = byStep.get(r.stepId)
    if (a) a.rows.push(r)
    else orphanRows.push(r)
  }
  if (!attempts.length && (orphanRows.length || orphanEvents.length || strays.length)) {
    const ended = strays.splice(0)
    attempts.push({ ordinal: 1, run: null, started: null, ended, events: [...orphanEvents.splice(0), ...ended], rows: orphanRows.splice(0), implicit: true })
  }
  return { attempts, orphans: { rows: orphanRows, events: orphanEvents }, strays }
}

/**
 * The verdict an attempt is closed with, or null (the analyzer then judges its window). Of its
 * recorded experiment_ended statements the worst wins (void < aborted, the machine's own ranking).
 * An attempt with none is still open at the end of the log - a crashed run nobody resumed - and is
 * closed here as void:interrupted_by_crash (source "open_at_end_of_log"), exactly as a resume would
 * close it (Appendix B revision 2 (4)). A closed attempt is reported with that status and reason,
 * whatever its partial rows would have measured: its rows are not a complete protocol.
 */
function closingOf(a) {
  if (!a.ended.length) return a.implicit ? null : { status: "void", reason: "interrupted_by_crash", run: a.run, source: OPEN_AT_END_OF_LOG, seq: a.started?.seq ?? null }
  let worst = null
  for (const e of a.ended) {
    const rank = CLOSED_STATUS_RANK[e.status]
    if (!rank || (worst && rank <= CLOSED_STATUS_RANK[worst.status])) continue
    worst = e
  }
  if (!worst) return null
  return { status: worst.status, reason: typeof worst.reason === "string" && worst.reason ? worst.reason : "unspecified", run: worst.run ?? a.run, source: worst.source ?? "live", seq: worst.seq ?? null }
}

/**
 * The machine's own last recorded verdict for an experiment, unfiltered (unlike
 * closingOf, which only tracks void/aborted ranks and is used to short-circuit the
 * analyzer's own judgement). This is display-only: it never changes what the analyzer measures
 * or reports as status/reason, even when the analyzer re-judges a machine-valid window as
 * contaminated (D2 ruling: the analyzer is the authority on window cleanliness).
 */
function machineVerdictOf(events, experiment) {
  const ends = (events ?? []).filter((e) => e?.ev === "experiment_ended" && e.experiment === experiment)
  if (!ends.length) return null
  const last = ends.at(-1)
  // seq is a global log position, not a content identity - a resume's own preflight can shift it
  // for an unrelated experiment, so it is left out of this display-only field.
  return { status: last.status ?? null, reason: typeof last.reason === "string" && last.reason ? last.reason : null }
}

/**
 * The campaign as the log records it: processes (a resume appends run_resumed), campaign stops,
 * and the one case with nothing to measure - a cancel recorded before any issuance (clarification
 * A (ii): campaign_stop{cancelled} is written first; there may be no run_started and no request).
 * Null for an uninterrupted, unstopped run, so its analysis.json is unchanged.
 */
function campaignOf(events, records) {
  const evs = events ?? []
  const stops = evs
    .filter((e) => e?.ev === "campaign_stop")
    .map((e) => ({ reason: e.reason ?? null, experiment: e.experiment ?? null, stepId: e.stepId ?? null, meter: e.meter ?? null, seq: e.seq ?? null }))
  const resumes = evs.filter((e) => e?.ev === "run_resumed").length
  const issued = evs.some((e) => e?.ev === "step_intent")
  const cancelledBeforeStart = (records ?? []).length === 0 && !issued && stops.length > 0 && stops[0].reason === "cancelled"
  if (!stops.length && !resumes) return null
  const ended = [...evs].reverse().find((e) => e?.ev === "run_ended") ?? null
  return {
    status: cancelledBeforeStart ? "cancelled_before_start" : stops.length ? "stopped" : "ran",
    reason: cancelledBeforeStart ? "cancelled_before_start" : (stops[0]?.reason ?? null),
    processes: resumes + 1,
    stops,
    requests: (records ?? []).length,
    runEnded: ended ? { exitCode: ended.exitCode ?? null, reason: ended.reason ?? null } : null,
  }
}

const baselineResetsOf = (events, experiment, meter = METER_5H) =>
  startedEvents(events, experiment)
    .map((e) => e.baselines?.[meter]?.reset)
    .filter((x) => Number.isFinite(x))

/** The baseline one attempt recorded at its start; null without an experiment_started. */
const baselineOf = (a, meter = METER_5H) => a.started?.baselines?.[meter] ?? null

/** The step_intents of one attempt by step id. A step with two intents keeps both: they may disagree. */
function intentsOf(a) {
  const map = new Map()
  for (const e of a.events) {
    if (e.ev !== "step_intent" || typeof e.stepId !== "string") continue
    if (!map.has(e.stepId)) map.set(e.stepId, [])
    map.get(e.stepId).push(e)
  }
  return map
}

const PREFLIGHT = "preflight"

/**
 * Block 1's carried phase (todo 25 D1): `experiment_started.carryPhase`, the field the machine
 * writes; no producer ever wrote `phase`. The paid preflight PINGs between the call that set it and
 * this attempt's first request (the quiet settle) are block 1's pre-block segment, charged in its
 * sums. They must read the gauge where the phase reference left it: a PING that moved it, or one
 * without a reading, leaves the phase unobserved.
 */
function carryOf(ctx, a) {
  const phase = a.started?.carryPhase ?? null
  const first = a.rows.length ? ctx.rows.indexOf(a.rows[0]) : -1
  if (!phaseInterval(phase) || first < 0) return { phase: null, preRows: [] }
  let i = first - 1
  while (i >= 0 && ctx.rows[i]?.experiment === PREFLIGHT) i--
  const segment = ctx.rows.slice(i + 1, first).filter(isPaid)
  const ref = i >= 0 ? meterReading(ctx.rows[i], METER_5H) : null
  const quiet = segment.every((r) => {
    const m = meterReading(r, METER_5H)
    return !!(m && ref && sameWindow(ref, m) && Math.round((m.util - ref.util) / RESOLUTION) === 0)
  })
  return quiet ? { phase, preRows: segment } : { phase: null, preRows: [] }
}

// makeTask is deterministic but not free: one task per (seed, steps) per process.
const taskCache = new Map()
const taskFor = (seed, steps) => {
  if (!Number.isFinite(seed)) return null
  const key = `${seed}#${steps}`
  if (!taskCache.has(key)) taskCache.set(key, makeTask(seed, { steps }))
  return taskCache.get(key)
}

/**
 * Seed of one unit of one attempt: its `experiment_started.seeds`, indexed by the unit, or the
 * first seed when the start is per-run and names that run. A start whose `run` is null or absent is
 * not per-run (Appendix B), so its seeds are indexed.
 */
function seedOfAttempt(a, unitIndex) {
  const e = a.started
  if (!e || !Array.isArray(e.seeds)) return null
  if (e.run != null) return e.run === unitIndex && Number.isFinite(e.seeds[0]) ? e.seeds[0] : null
  return e.seeds.length >= unitIndex && Number.isFinite(e.seeds[unitIndex - 1]) ? e.seeds[unitIndex - 1] : null
}

function scaleSums(sums, factor) {
  const out = emptySums()
  out.requests = sums.requests * factor
  for (const k of USAGE_FIELDS) out[k] = sums[k] * factor
  return out
}

/** Warm-phase sums straight from the records (one ping on the parent context). */
function warmSumsFrom(records) {
  const warm = records.filter((r) => r.phase === "warm")
  if (!warm.length) return null
  const s = sumRecords(warm)
  return scaleSums(s, 1 / warm.length)
}

// The `unknowns` list is published in analysis.json as English lines; the Korean doc renders
// each line through unknownTextKo below. Both come from these definitions, so they cannot drift.
const UNKNOWN_FIXED = [
  [
    "cacheWrite5m coefficient: the CLI writes only the 1h lane, so the 5m arm is skipped (adapter_capability) and k_write5 stays unknown - never defaulted from the 1h lane",
    "cacheWrite5m 계수: CLI는 1h 캐시에만 쓰므로 5m 갈래는 건너뛰었고(adapter_capability) k_write5는 모른다. 1h 값으로 대신 채우지 않는다",
  ],
  [
    "uncachedInput coefficient (k_input): unknown, only bounded above by the 1h write coefficient",
    "uncachedInput 계수(k_input): 모른다. 1h 쓰기 계수보다 크지 않다는 상한만 있다",
  ],
  [
    `cacheRead coefficient: the ${READ_TOKENS_PER_TICK_RANGE[0]}-${READ_TOKENS_PER_TICK_RANGE[1]} tokens per tick figure is a reported_unverified prior range from ${PRIOR_RANGE_ONLY.evidenceRef}, not measured by this run`,
    `cacheRead 계수: tick당 ${READ_TOKENS_PER_TICK_RANGE[0]}-${READ_TOKENS_PER_TICK_RANGE[1]} 토큰이라는 값은 ${PRIOR_RANGE_ONLY.evidenceRef}에 보고된 검증 전 사전 범위(reported_unverified)이며, 이 실행에서 측정하지 않았다`,
  ],
  [
    "return forecast q: not measured; the planner entries are labelled hypothetical scenarios, never facts",
    "복귀 예측 q: 측정하지 않았다. 계획기의 항목은 가정 시나리오라는 라벨을 붙였을 뿐 사실로 쓰지 않는다",
  ],
  [
    "skillRestoreEq / sharedLossEq / parkQualityEq: not measured; entered as 0 baselines in the engine model",
    "skillRestoreEq / sharedLossEq / parkQualityEq: 측정하지 않았다. 엔진 모델에는 0 기준값으로 넣었다",
  ],
]
const UNKNOWN_T = [
  "T (tokens per 5h write tick): not identified by this evidence; the prior range 102K-143K is reported_unverified",
  "T(5h 쓰기 tick당 토큰 수): 이 증거로는 정하지 못했다. 사전 범위 102K-143K는 검증 전 값(reported_unverified)이다",
]
const UNKNOWN_KOUT_PREFIX = "k_out (ticks per output token): not identified by this evidence ("
const QUALITY_GAP = /^restore run (\S+) (\S+) (\S+): (.*)$/
const EXCLUDED_SUFFIX = "excluded from the pooled analysis"
const EXCLUDED_ATTEMPT = new RegExp(`^([a-z0-9-]+) attempt (\\S+)( \\(run (\\d+)\\))?: ([a-z_]+)( \\(([^()]*)\\))? - ${EXCLUDED_SUFFIX}$`)
const UNKNOWN_KO = new Map([...UNKNOWN_FIXED, UNKNOWN_T])

/**
 * The Korean line for one `unknowns` entry, or null when the line has no Korean form (a line
 * shape added without one; the doc then prints the English line). Experiment lines are codes only
 * (`<id>: <status> (<reason>)`) and stay as they are.
 */
export function unknownTextKo(line) {
  if (UNKNOWN_KO.has(line)) return UNKNOWN_KO.get(line)
  if (line.startsWith(UNKNOWN_KOUT_PREFIX) && line.endsWith(")")) return `k_out(출력 토큰당 tick): 이 증거로는 정하지 못했다(${line.slice(UNKNOWN_KOUT_PREFIX.length, -1)})`
  const excluded = line.match(EXCLUDED_ATTEMPT)
  if (excluded) return `${excluded[1]} 시도 ${excluded[2]}${excluded[4] ? ` (run ${excluded[4]})` : ""}: ${excluded[5]}${excluded[7] ? ` (${excluded[7]})` : ""} - 합산 분석에서 제외했다`
  const id = line.slice(0, line.indexOf(":"))
  if (EXPERIMENT_IDS.includes(id) && /^[a-z0-9-]+: [a-z_]+( \([^()]*\))?$/.test(line)) return line
  const gap = line.match(QUALITY_GAP)
  if (gap) return `복원 ${gap[1]}회차 ${gap[2]} ${gap[3]}: ${gap[4]}`
  return null
}

/** Policy pairs the doc reports: completed (with paired differences) and planned (RULES.policy.pairs). */
export function pairCounts(analysis) {
  return { completed: analysis.experiments["policy-effect"]?.findings?.pairedDifferences?.n ?? 0, planned: RULES.policy.pairs }
}

/** The label every report gives an attempt: `<runId>#<ordinal within its log>`. */
const attemptLabel = (a) => `${a.runId ?? "run"}#${a.attempt}`

/** Every unit of an attempt judged by the clean-window rule on its own rows and steps. */
function unitVerdicts(rows, events, experiment, opts) {
  const byUnit = new Map()
  for (const r of rows) {
    const u = unitIndexOf(r.unit)
    if (!byUnit.has(u)) byUnit.set(u, [])
    byUnit.get(u).push(r)
  }
  return [...byUnit.entries()]
    .sort((a, b) => (a[0] === null) - (b[0] === null) || (a[0] ?? 0) - (b[0] ?? 0))
    .map(([unit, list]) => {
      const ids = new Set(list.map((r) => r.stepId))
      const own = events.filter((e) => (unit !== null && unitIndexOf(e.unit) === unit) || (typeof e.stepId === "string" && ids.has(e.stepId)))
      const w = windowStatus(list, own, experiment, opts)
      return { unit, clean: w.clean, reasons: w.reasons, requests: w.requests }
    })
}

// N4 (todo 14): the machine-consumed label must not say "measured" once the window itself is not
// valid (e.g. contaminated) - it follows the analyzer's non-clean-window convention (sourceKind
// "unknown"), the value windowStatus uses for a dirty window.
const shownFindings = (f, status) => (f && status !== "valid" && f.renewsAt55min === "measured" ? { ...f, renewsAt55min: "unknown" } : f)

const tagUnits = (list, attempt) => list.map((u) => ({ ...u, attempt }))
const flatUnits = (list) => list.flat()
const restoreTask = (a) => (u) => taskFor(seedOfAttempt(a, u), RULES.restore.workSteps)
const policyTask = (a) => (u) => taskFor(seedOfAttempt(a, u), RULES.policy.workSteps)

// Per experiment: its units from one attempt's paid rows, how the units of several attempts pool,
// the findings over units, and one attempt's options - only its own baseline, schedule origin,
// seeds, carried phase and step_intents; T and k_out come from the pooled earlier experiments.
const SPECS = {
  "fable-write-tick": {
    units: fableUnits,
    tag: (u, attempt) => ({ ...u, blocks: tagUnits(u.blocks, attempt) }),
    merge: mergeFableUnits,
    aggregate: (u) => fableAggregate(u),
    opts: (_ctx, a) => ({ baseline: baselineOf(a) }),
  },
  "output-quota": {
    units: outputUnits,
    tag: tagUnits,
    merge: flatUnits,
    aggregate: outputAggregate,
    opts: (ctx, a, shared) => ({ baseline: baselineOf(a), T: shared.T, ...carryOf(ctx, a), intents: intentsOf(a) }),
  },
  "ttl-1h-unique-prefix": {
    units: ttlUnits,
    tag: tagUnits,
    merge: flatUnits,
    aggregate: (runs) => ttlAggregate(runs),
    opts: (_ctx, a) => ({ baseline: baselineOf(a), t0: a.started?.t0 ?? null }),
  },
  "restore-decomposition": {
    units: restoreUnits,
    tag: tagUnits,
    merge: flatUnits,
    aggregate: restoreAggregate,
    opts: (ctx, a, shared) => ({ baseline: baselineOf(a), T: shared.T, kOut: shared.kOut, kOutUpperBound: shared.kOutUpperBound, cli: ctx.cli, taskOf: restoreTask(a) }),
  },
  "policy-effect": {
    units: policyUnits,
    tag: tagUnits,
    merge: flatUnits,
    aggregate: (pairs) => policyAggregate(pairs),
    opts: (ctx, a, shared) => ({ baseline: baselineOf(a), T: shared.T, kOut: shared.kOut, kOutUpperBound: shared.kOutUpperBound, cli: ctx.cli, taskOf: policyTask(a) }),
  },
}

const notRunReason = (ctx) =>
  ctx.campaign?.status === "cancelled_before_start" ? "cancelled_before_start" : ctx.campaign?.stops.length ? `campaign_stopped:${ctx.campaign.stops[0].reason}` : "no_request_in_evidence"

/**
 * One attempt judged within its own log: a recorded closing verdict first, then the clean-window
 * rule over its own rows and steps (plus any orphan of the experiment). Only a clean attempt that
 * is terminal - closed by its own experiment_ended, or an implicit legacy attempt - and valid or
 * upper_bound is pooled; `units` and `rows` are returned only for a pooled attempt.
 */
function judgeAttempt(ctx, id, a, orphans, shared) {
  const spec = SPECS[id]
  const rows = [...a.rows, ...orphans.rows]
  const events = [...a.events, ...orphans.events]
  const reset = a.started?.baselines?.[METER_5H]?.reset
  const wopts = { malformedRows: ctx.malformedRows, baselineResets: Number.isFinite(reset) ? [reset] : [] }
  const report = {
    runId: ctx.runId,
    attempt: a.ordinal,
    run: a.run,
    window: windowStatus(rows, events, id, wopts),
    units: unitVerdicts(rows, events, id, wopts),
    machineVerdict: machineVerdictOf(a.ended, id),
    pooled: false,
    findings: null,
  }
  const closed = (status, reason, extra = {}) => ({ report: { ...report, status, reason, ...extra }, units: null, rows: [] })
  if (ctx.campaign?.status === "cancelled_before_start") return closed("not_run", "cancelled_before_start")
  const recorded = closingOf(a)
  if (recorded) return closed(recorded.status, recorded.reason, { recordedVerdict: recorded })
  const paid = a.rows.filter(isPaid)
  if (!paid.length) return closed("not_run", notRunReason(ctx))
  const hard = hardReasonOf(report.window.reasons)
  if (hard) return closed("void", hard)
  const opts = spec.opts(ctx, a, shared)
  const units = spec.tag(spec.units(paid, opts), { runId: ctx.runId, attempt: a.ordinal })
  const findings = spec.aggregate(units, opts)
  const clean = report.window.clean
  const status = clean ? findings.status : "contaminated"
  const pooled = clean && (status === "valid" || status === "upper_bound")
  return {
    // a pooled attempt's units are in the experiment's findings, each tagged with this attempt
    report: { ...report, status, reason: clean ? (findings.reason ?? null) : report.window.reasons.join(","), pooled, findings: pooled ? null : shownFindings(findings, status) },
    units: pooled ? units : null,
    rows: pooled ? paid : [],
  }
}

// With no attempt pooled, the experiment reports its most telling attempt: a machine-recorded
// abort, then a recorded void, a hard void, a contaminated window, any other verdict, not_run.
// Ties go to the earliest attempt.
const representativeRank = (r) => (r.recordedVerdict ? (r.status === "aborted" ? 5 : 4) : r.status === "void" ? 3 : r.status === "contaminated" ? 2 : r.status === "not_run" ? 0 : 1)
const representativeOf = (reports) => reports.reduce((best, r) => (representativeRank(r) > representativeRank(best) ? r : best))

/** The windows of one experiment across merged runs: every reason of every run, counts summed. */
function combineWindows(list) {
  const ran = list.filter((w) => w.requests > 0 || !w.reasons.includes("not_run"))
  const use = ran.length ? ran : list.slice(0, 1)
  if (use.length === 1) return use[0]
  const union = (pick) => [...new Set(use.flatMap((w) => pick(w) ?? []))].sort()
  const sum = (pick) => use.reduce((acc, w) => acc + (pick(w) ?? 0), 0)
  const reasons = union((w) => w.reasons)
  return {
    experiment: use[0].experiment,
    clean: reasons.length === 0,
    sourceKind: reasons.length === 0 ? "measured" : "unknown",
    reasons,
    requests: sum((w) => w.requests),
    resetEpochs: union((w) => w.resetEpochs),
    baselineResets: union((w) => w.baselineResets),
    unknownUsageFields: union((w) => w.unknownUsageFields),
    ...(use.some((w) => w.unpaidRequestRows) ? { unpaidRequestRows: union((w) => w.unpaidRequestRows) } : {}),
    ...(use.some((w) => w.malformedRequestCountRows) ? { malformedRequestCountRows: union((w) => w.malformedRequestCountRows) } : {}),
    stepParity: {
      requests: sum((w) => w.stepParity?.requests),
      intents: sum((w) => w.stepParity?.intents),
      results: sum((w) => w.stepParity?.results),
      missingRequest: union((w) => w.stepParity?.missingRequest),
      unannounced: union((w) => w.stepParity?.unannounced),
    },
    windows: use.length,
  }
}

/**
 * One experiment over every input: each attempt judged in its own log and reported; the findings
 * pool the units of the pooled attempts only. With none pooled, the representative attempt's
 * verdict (and its own findings, if any) is the experiment's.
 */
function analyzeExperiment(ctxs, id, shared) {
  const spec = SPECS[id]
  const judged = []
  const strays = []
  for (const ctx of ctxs) {
    const split = splitAttempts(ctx.rows, ctx.events, id)
    for (const e of split.strays) strays.push({ runId: ctx.runId, run: e.run ?? null, status: e.status ?? null, reason: e.reason ?? null, seq: e.seq ?? null })
    for (const a of split.attempts) judged.push({ ctx, ...judgeAttempt(ctx, id, a, split.orphans, shared) })
  }
  const attempts = judged.map((j) => j.report)
  const pooled = judged.filter((j) => j.report.pooled)
  let status = "not_run"
  let reason = notRunReason(ctxs[ctxs.length - 1])
  let findings = null
  let recordedVerdict = null
  if (pooled.length) {
    findings = spec.aggregate(spec.merge(pooled.map((j) => j.units)), shared)
    status = findings.status
    reason = findings.reason ?? null
  } else if (attempts.length) {
    const rep = representativeOf(attempts)
    status = rep.status
    reason = rep.reason
    findings = rep.findings
    recordedVerdict = rep.recordedVerdict ?? null
  }
  const machine = ctxs.map((c) => machineVerdictOf(c.events, id)).filter(Boolean)
  const experiment = {
    status,
    reason,
    window: combineWindows(ctxs.map((c) => c.windows[id])),
    hypotheses: id === "fable-write-tick" ? (findings?.hypotheses ?? []) : [],
    findings: shownFindings(findings, status),
    attempts,
    pool: { included: attempts.filter((a) => a.pooled).map(attemptLabel), excluded: attempts.filter((a) => !a.pooled).map(attemptLabel) },
    ...(recordedVerdict ? { recordedVerdict } : {}),
    recordedMachineVerdict: machine.length ? machine[machine.length - 1] : null,
    ...(strays.length ? { strayVerdicts: strays } : {}),
  }
  return { experiment, pooledRows: pooled.flatMap((j) => j.rows), pooledWindows: pooled.map((j) => j.report.window), pooledInputs: [...new Set(pooled.map((j) => j.ctx))] }
}

/** One evidence log, normalised: its rows, verdict-bearing events, integrity and whole-experiment windows. */
function inputContext(input) {
  const rows = input.rows ?? []
  const events = input.events ?? []
  const records = rows.filter(isPaid)
  const skippedRequests = input.skippedRequests ?? (input.requestsText ? parseRecords(input.requestsText).skipped.length : 0)
  const skippedEvents = input.skippedEvents ?? (input.eventsText ? parseRecords(input.eventsText).skipped.length : 0)
  // A row that does not parse cannot be attributed to an experiment or an attempt, so it
  // contaminates its whole evidence file: nothing of that run may stay measured.
  const malformedRows = skippedRequests > 0
  return {
    rows,
    events,
    records,
    requestsText: input.requestsText ?? null,
    eventsText: input.eventsText ?? null,
    cli: input.cli ?? null,
    summary: input.summary ?? null,
    integrityWarnings: input.integrityWarnings ?? [],
    runId: input.runId ?? records.find((r) => r.runId)?.runId ?? null,
    skippedRequests,
    skippedEvents,
    malformedRows,
    campaign: campaignOf(events, records),
    windows: Object.fromEntries(EXPERIMENT_IDS.map((id) => [id, windowStatus(rows, events, id, { malformedRows, baselineResets: baselineResetsOf(events, id) })])),
  }
}

const generatedFromOf = (c) => ({
  requests: { sha256: c.requestsText ? sha256(c.requestsText) : null, records: c.records.length, skipped: c.skippedRequests, ...(c.rows.length > c.records.length ? { unpaid: c.rows.length - c.records.length } : {}) },
  events: { sha256: c.eventsText ? sha256(c.eventsText) : null, records: c.events.length, skipped: c.skippedEvents },
  cli: { artifacts: c.cli ? Object.keys(c.cli).length : 0, source: "cli/<stepId>.json (assistant text is untrusted data, compared only against ground truth)" },
  summary: c.summary ? { exitCode: c.summary.exitCode ?? null, v: c.summary.v ?? null } : null,
})

const integrityOf = (c, rule) => ({
  ok: !c.malformedRows,
  malformedRequestRows: c.skippedRequests,
  malformedEventRows: c.skippedEvents,
  rule,
  // present only when an optional input existed but could not be read (loadRunDir)
  ...(c.integrityWarnings.length ? { warnings: c.integrityWarnings } : {}),
})

/** Meter spend of merged runs: each run's windows kept, the observed and upper spend summed. */
function combineSpend(parts) {
  const out = {}
  const r6 = (x) => Math.round(x * 1e6) / 1e6
  for (const m of METERS) {
    const present = parts.filter((p) => p.spend[m].present)
    if (!present.length) {
      out[m] = { present: false, windows: 0, observedEq: null, upperEq: null, startUtil: null, endUtil: null }
      continue
    }
    out[m] = {
      present: true,
      windows: present.reduce((a, p) => a + p.spend[m].windows, 0),
      observedEq: r6(present.reduce((a, p) => a + p.spend[m].observedEq, 0)),
      upperEq: r6(present.reduce((a, p) => a + p.spend[m].upperEq, 0)),
      startUtil: present[0].spend[m].startUtil,
      endUtil: present[present.length - 1].spend[m].endUtil,
      perWindow: present.flatMap((p) => p.spend[m].perWindow.map((w) => ({ runId: p.runId, ...w }))),
      upperRule: present[0].spend[m].upperRule,
    }
  }
  return out
}

/**
 * Inputs of a merged analysis must be distinct runs, oldest first, that do not overlap in time;
 * the order is read from the evidence's own timestamps. Returns an error code, or null.
 */
export function mergeInputsError(inputs) {
  const ids = inputs.map((i) => i.runId ?? (i.rows ?? []).filter(isPaid).find((r) => r.runId)?.runId ?? null)
  if (ids.some((x) => x === null)) return "merge_run_id_unknown"
  if (new Set(ids).size !== ids.length) return "merge_duplicate_run"
  const spans = inputs.map((i) => {
    const ts = [...(i.events ?? []).map((e) => msOf(e?.ts)), ...(i.rows ?? []).flatMap((r) => [msOf(r?.ts_req), msOf(r?.ts)])].filter((x) => x !== null)
    return ts.length ? { from: Math.min(...ts), to: Math.max(...ts) } : null
  })
  if (spans.some((s) => s === null)) return "merge_order_unverifiable"
  for (let k = 1; k < spans.length; k++) {
    if (spans[k].from < spans[k - 1].from) return "merge_out_of_order"
    if (spans[k].from <= spans[k - 1].to) return "merge_overlapping_runs"
  }
  return null
}

/** One line per attempt for the CLI summary: `<label>[ run <n>] <status>[(<reason>)][ pooled]`. */
const attemptLine = (a) => `${attemptLabel(a)}${a.run !== null ? ` run ${a.run}` : ""} ${a.status}${a.reason ? `(${a.reason})` : ""}${a.pooled ? " pooled" : ""}`
const excludedAttemptLine = (id, a) => `${id} attempt ${attemptLabel(a)}${a.run !== null ? ` (run ${a.run})` : ""}: ${a.status}${a.reason ? ` (${a.reason})` : ""} - ${EXCLUDED_SUFFIX}`

/**
 * The analysis of one evidence log, or of several merged ones (`--merge`, todo 25 D4). Each
 * experiment's attempts are judged within their own log and every attempt is reported; only
 * clean, terminal attempts (valid or upper_bound) are pooled into the experiment's findings, the
 * coefficient records and the engine inputs. T comes from the pooled fable-write-tick, k_out (or
 * its upper bound) from the pooled output-quota, and restore/policy are priced with them. One
 * input keeps the single-run shape.
 */
export function analyzeRuns(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("analyzeRuns: no input")
  if (inputs.length > 1) {
    const error = mergeInputsError(inputs)
    if (error) throw Object.assign(new Error(error), { code: error })
  }
  const ctxs = inputs.map(inputContext)
  const single = ctxs.length === 1 ? ctxs[0] : null
  const runIds = ctxs.map((c) => c.runId)
  const runId = single ? single.runId : runIds.join("+")
  const shared = { T: null, kOut: null, kOutUpperBound: null }

  const fable = analyzeExperiment(ctxs, "fable-write-tick", shared)
  shared.T = fable.experiment.status === "valid" ? (fable.experiment.findings?.intersectedT ?? null) : null
  const T = shared.T
  const output = analyzeExperiment(ctxs, "output-quota", shared)
  const oq = output.experiment
  // An identified block measures k_out even when a sibling block only bounds it; a void or
  // contaminated window measures nothing at all.
  const outputWindowUsable = oq.status === "valid" || oq.status === "upper_bound"
  const kOut = outputWindowUsable ? (oq.findings?.kOut ?? null) : null
  // Only a usable window's upper bound reaches the engine, where it can raise the prior's high end
  // and never narrow it (conversionEnds).
  shared.kOut = kOut
  shared.kOutUpperBound = outputWindowUsable && !kOut ? (oq.findings?.kOutUpperBound ?? null) : null
  // "upper_bound" means a bound was actually computed (outputAggregate's own kOutUpperBound, e.g.
  // an unobserved phase or disjoint blocks); a machine-recorded non-valid verdict computes no
  // findings at all, and must not claim a bound that does not exist.
  const outputStatus = kOut ? "measured" : oq.findings?.kOutUpperBound != null ? "upper_bound" : "unidentified"
  // A window with no findings is either the machine's own recorded verdict (the window stayed
  // clean; the experiment is not valid for its own reason, e.g. aborted:short_output) or a hard
  // void from an unclean window (schema/usage/reset defects) - only the latter is unclean.
  const outputReason = kOut
    ? null
    : (oq.findings?.reason ?? (outputWindowUsable ? "no_second_tick_within_64" : oq.window?.clean ? `experiment_not_valid:${oq.reason}` : "output_window_not_clean"))
  const ttl = analyzeExperiment(ctxs, "ttl-1h-unique-prefix", shared)
  const restore = analyzeExperiment(ctxs, "restore-decomposition", shared)
  const policy = analyzeExperiment(ctxs, "policy-effect", shared)

  const experiments = {
    "fable-write-tick": fable.experiment,
    "output-quota": output.experiment,
    "ttl-1h-unique-prefix": ttl.experiment,
    "restore-decomposition": restore.experiment,
    "policy-effect": policy.experiment,
  }

  // The coefficient records come from the pooled fable attempts only (their window, rows and runs).
  const fableCtxs = fable.pooledInputs.length ? fable.pooledInputs : ctxs
  const fw = fable.pooledWindows.length ? combineWindows(fable.pooledWindows) : fable.experiment.window
  const fableRows = fable.pooledRows.length ? fable.pooledRows : ctxs.flatMap((c) => c.records.filter((r) => r.experiment === "fable-write-tick"))
  const span = fableCtxs.flatMap((c) => c.records)
  const { records: coefficientRecords, provenance: coefficientProvenance } = buildCoefficientRecords({
    T,
    kOut,
    outputStatus,
    outputReason,
    sourceKind: fable.experiment.status === "valid" && fw.clean ? "measured" : "unknown",
    window: { experiment: "fable-write-tick", requests: fw.requests, resetEpochs: fw.resetEpochs ?? [], reasons: fw.reasons },
    runId: single ? runId : fableCtxs.map((c) => c.runId).join("+"),
    requestsSha256: single ? (single.requestsText ? sha256(single.requestsText) : null) : fableCtxs.map((c) => (c.requestsText ? sha256(c.requestsText) : "unknown")).join(","),
    sampleCount: fableRows.length,
    measuredAt: span.length ? (span[span.length - 1].ts ?? null) : null,
    validFrom: span.length ? (span[0].ts_req ?? null) : null,
  })

  // Engine feed: the phase sums converted at both ends of every range. A restore or policy
  // experiment that is not valid takes the whole feed out: the answer is NO_DECISION, never an
  // action, and no phase cost is priced from its rows (todo 9 reads phaseCostsEq). Only POOLED
  // attempts are priced: an excluded attempt's rows never reach a phase cost (todo 25 D4).
  const endsLowHigh = conversionEnds({ T, kOut, kOutUpperBound: shared.kOutUpperBound, meter: METER_5H })
  const feed = { "restore-decomposition": restore, "policy-effect": policy }
  const invalidFeed = Object.keys(feed).filter((id) => experiments[id].status !== "valid")
  const warmPer = warmSumsFrom(Object.keys(feed).filter((id) => !invalidFeed.includes(id)).flatMap((id) => feed[id].pooledRows))
  const restoreRun = invalidFeed.includes("restore-decomposition") ? null : (restore.experiment.findings?.runs?.[0] ?? null)
  const pick = (sums) => (sums ? convertSums(sums, endsLowHigh) : { lo: null, hi: null })
  const parts = {
    warm: pick(warmPer),
    ctxCreate: pick(restoreRun?.phases?.ctx_create ?? null),
    parkParent: pick(restoreRun?.phases?.park_parent ?? null),
    restoreChild: pick(restoreRun?.phases?.restore_child ?? null),
    resumeRaw: pick(restoreRun?.phases?.resume_raw ?? null),
    usefulWorkPark: pick(restoreRun?.byArmPhase?.park_path?.useful_work ?? null),
    usefulWorkRaw: pick(restoreRun?.byArmPhase?.raw_path?.useful_work ?? null),
  }
  const hasModel = parts.warm.lo !== null && parts.parkParent.lo !== null && parts.restoreChild.lo !== null && parts.resumeRaw.lo !== null && parts.ctxCreate.lo !== null
  const modelLow = hasModel ? buildIdleCostModel({ warm: parts.warm.lo, ctxCreate: parts.ctxCreate.lo, parkParent: parts.parkParent.lo, restoreChild: parts.restoreChild.lo, resumeRaw: parts.resumeRaw.lo }) : null
  const modelHigh = hasModel ? buildIdleCostModel({ warm: parts.warm.hi, ctxCreate: parts.ctxCreate.hi, parkParent: parts.parkParent.hi, restoreChild: parts.restoreChild.hi, resumeRaw: parts.resumeRaw.hi }) : null
  const raisedBound = endsLowHigh.provenance.billedModelOutputEvidenceUpperBound
  const poolNotes = Object.keys(feed)
    .filter((id) => !invalidFeed.includes(id) && experiments[id].pool.excluded.length)
    .map((id) => `${id}: priced from pooled attempt(s) ${experiments[id].pool.included.join(", ")} only; excluded ${experiments[id].pool.excluded.join(", ")}`)
  const policyAnswer = engineFeed({
    modelLow,
    modelHigh,
    runId,
    contextTokens: restoreRun?.phases?.ctx_create?.cacheWrite1h ?? 0,
    timestampMs: 0,
    evidenceOk: invalidFeed.length === 0,
    evidenceReason: invalidFeed.map((id) => `${id}:${experiments[id].status}`).join(","),
    notes: [
      "V = 0 baseline: no future-work differential is claimed",
      "quality is reported as states and scores, never monetised into parkQualityEq",
      hasModel
        ? `cost model built from restore ${restoreRun.attempt?.runId ?? runId} run ${restoreRun.run} phase sums`
        : `no cost model: phase costs missing for ${["warm", "ctxCreate", "parkParent", "restoreChild", "resumeRaw"].filter((k) => parts[k].lo === null).join(", ")}`,
      ...poolNotes,
      T ? "write coefficient measured by this run" : "coefficients are the reported prior RANGE only: this evidence did not measure T",
      // N1 (todo 14): the note follows outputStatus - a genuine upper bound (a bound WAS
      // computed, e.g. an unobserved phase) reads differently from unidentified (no bound at all,
      // e.g. a machine-recorded non-valid verdict with no findings).
      kOut
        ? "output coefficient measured by this run"
        : outputStatus === "upper_bound"
          ? `output coefficient is an upper bound only (${outputReason ?? "unidentified"})`
          : `output coefficient not identified: no bound was computed (${outputReason ?? "unidentified"})`,
      ...(raisedBound !== undefined
        ? [`output coefficient range: the prior ratio's high end is raised to this evidence's upper bound k_out < ${raisedBound} ticks per output token; the low end stays the prior's`]
        : []),
    ],
  })
  policyAnswer.phaseCostsEq = parts
  policyAnswer.coefficientEnds = { low: endsLowHigh.low, high: endsLowHigh.high, provenance: endsLowHigh.provenance }

  const unknowns = UNKNOWN_FIXED.map(([en]) => en)
  if (!T) unknowns.push(UNKNOWN_T[0])
  if (!kOut) unknowns.push(`${UNKNOWN_KOUT_PREFIX}${outputReason ?? "unidentified"})`)
  for (const id of EXPERIMENT_IDS) {
    const e = experiments[id]
    if (e.status !== "valid") unknowns.push(`${id}: ${e.status}${e.reason ? ` (${e.reason})` : ""}`)
  }
  // Beside a pool, every attempt kept out of it is named with its verdict.
  for (const id of EXPERIMENT_IDS) {
    const e = experiments[id]
    if (!e.pool.included.length) continue
    for (const a of e.attempts.filter((x) => !x.pooled)) unknowns.push(excludedAttemptLine(id, a))
  }
  const qualityGaps = []
  for (const r of restore.experiment.findings?.runs ?? []) {
    const run = single ? r.run : `${r.run}@${r.attempt?.runId ?? "run"}`
    for (const arm of ["park_path", "raw_path"]) {
      const q = r.quality?.[arm]
      if (!q) continue
      for (const [name, field] of Object.entries(q)) {
        if (name === "source" || name === "artifactsMissing" || !field || typeof field !== "object") continue
        if (field.value === null && field.reason) qualityGaps.push(`restore run ${run} ${arm} ${name}: ${field.reason}`)
      }
    }
  }
  unknowns.push(...qualityGaps.sort())

  const common = { experiments, coefficientRecords, coefficientProvenance, policyAnswer }
  if (single) {
    return {
      v: SCHEMA_VERSION,
      runId,
      generatedFrom: generatedFromOf(single),
      integrity: integrityOf(single, "a request row that does not parse voids every experiment: it cannot be attributed"),
      ...(single.campaign ? { campaign: single.campaign } : {}),
      ...common,
      spend: spendByMeter(single.records, single.events),
      unknowns,
    }
  }
  const spends = ctxs.map((c) => spendByMeter(c.records, c.events))
  const inputRule = "a request row that does not parse voids every attempt of its own run: it cannot be attributed"
  return {
    v: SCHEMA_VERSION,
    runId,
    runIds,
    merge: {
      inputs: ctxs.length,
      order: "oldest_first_by_evidence_timestamps_non_overlapping",
      rule: "every attempt of every run is reported; only clean terminal attempts (valid or upper_bound) are pooled into the findings, the coefficient records and the policy answer",
    },
    inputs: ctxs.map((c, i) => ({ runId: c.runId, generatedFrom: generatedFromOf(c), integrity: integrityOf(c, inputRule), campaign: c.campaign, spend: spends[i] })),
    integrity: {
      ok: ctxs.every((c) => !c.malformedRows),
      malformedRequestRows: ctxs.reduce((a, c) => a + c.skippedRequests, 0),
      malformedEventRows: ctxs.reduce((a, c) => a + c.skippedEvents, 0),
      rule: inputRule,
    },
    ...common,
    spend: combineSpend(ctxs.map((c, i) => ({ runId: c.runId, spend: spends[i] }))),
    unknowns,
  }
}

export function analyzeRun(rows, events, opts = {}) {
  return analyzeRuns([{ ...opts, rows, events }])
}

// ------------------------------------------------------- markdown

const fmt = (x, digits = 6) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(digits)) : "미측정")
const interval = (iv, digits = 6) => (iv && typeof iv.lo === "number" ? `[${fmt(iv.lo, digits)}, ${fmt(iv.hi, digits)}]` : "미측정")
const qval = (field) => (field && field.value !== null && field.value !== undefined ? String(field.value) : `미상(${field?.reason ?? "unknown"})`)

// Verdicts the analyzer derives from the evidence itself (todo 25), with the words the Korean doc uses.
const ANALYZER_REASON_TEXT = Object.freeze({
  output_target_missing: "OUT 요청의 목표 출력 토큰 수가 그 요청의 step_intent에 없다: 기본값으로 채우지 않았고, 유효 요청 비율도 계산하지 않았다",
  output_target_conflict: "한 OUT 요청 또는 한 블록의 목표 출력 토큰 수 기록이 서로 다르다: 어느 쪽도 고르지 않았고, 유효 요청 비율도 계산하지 않았다",
  invalid_output_share: "목표 출력의 최소 기준(8K 목표는 6,000, 4K 목표는 3,000 토큰)을 채우고 end_turn으로 끝난 요청이 90% 미만이라 유효로 보지 않는다",
  blocks_disjoint: "블록들 전체에 공통으로 겹치는 k_out 구간이 없다(Appendix A: 블록 2는 블록 1과 겹쳐야 한다). 이 증거에는 모형이 맞지 않으므로 측정값은 발표하지 않고, 블록 상한 중 가장 큰 값만 상한으로 보고한다",
})

const reasonText = (x) => {
  if (x.recordedVerdict?.source === OPEN_AT_END_OF_LOG) return OPEN_AT_END_TEXT
  if (x.recordedVerdict) return REASON_TEXT[x.reason] ?? UNDESCRIBED_REASON_TEXT
  if (EVENT_DERIVED_REASONS.has(x.reason)) return REASON_TEXT[x.reason]
  return ANALYZER_REASON_TEXT[x.reason] ?? null
}
const verdict = (x) => `- 판정: ${x.status}${x.reason ? ` (${x.reason}${reasonText(x) ? `: ${reasonText(x)}` : ""})` : ""}`
const fmtExp = (x) => (typeof x === "number" && Number.isFinite(x) ? x.toExponential(4) : "미측정")

/** One line per attempt: which were pooled into the findings below and which were excluded, and why. */
const attemptLines = (x) =>
  (x.attempts ?? []).map((a) => `- 시도 ${attemptLabel(a)}${a.run !== null ? ` (run ${a.run})` : ""}: ${a.status}${a.reason ? ` (${a.reason})` : ""} -> ${a.pooled ? "합산에 포함" : "합산에서 제외"}`)

export function renderMarkdown(analysis) {
  const L = []
  const e = analysis.experiments
  const merged = Array.isArray(analysis.inputs)
  const inputs = merged ? analysis.inputs : [analysis]
  // a unit's attempt is printed when units of more than one attempt can appear side by side
  const tagged = (x) => merged || (x.pool?.included.length ?? 0) > 1
  const tagOf = (u, show) => (show && u?.attempt ? ` [${attemptLabel(u.attempt)}]` : "")
  L.push(`# 유휴 비용 실측 결과 (${analysis.runId ?? "run"})`)
  L.push("")
  if (merged)
    L.push(
      `합친 실행 ${inputs.length}개(오래된 순, 시간이 겹치지 않음): ${inputs.map((i) => i.runId).join(", ")}. 실험마다 모든 시도(attempt)를 판정과 함께 적고, 끝까지 기록되고 창이 깨끗한 시도(valid 또는 upper_bound)만 합산했다. 제외한 시도의 행은 합산 결과, 계수, 정책 답 어디에도 들어가지 않는다.`,
    )
  for (const i of inputs) L.push(`${merged ? `${i.runId} ` : ""}증거: requests.jsonl sha256 \`${i.generatedFrom.requests.sha256 ?? "없음"}\`, events.jsonl sha256 \`${i.generatedFrom.events.sha256 ?? "없음"}\`.`)
  L.push("게이지 해상도는 0.01이므로 모든 계수는 양자화 구간으로만 보고한다. 이 구간은 신뢰구간이 아니며 점추정값은 발표하지 않는다(발표하는 점은 구간의 상단이라고 명시한다).")
  for (const i of inputs) {
    const who = merged ? `${i.runId} ` : ""
    L.push(`${who}증거 무결성: 해석 불가 요청 행 ${i.integrity.malformedRequestRows}개 -> ${i.integrity.ok ? "없음" : merged ? "이 실행의 모든 시도 void" : "모든 실험 void"}.`)
    for (const w of i.integrity.warnings ?? []) L.push(`${who}증거 무결성 경고: ${w.file}을(를) 읽을 수 없다(${w.issue}: ${w.detail}). 이 파일이 없는 것으로 보고 분석했다.`)
    const c = i.campaign
    if (c) {
      const stops = c.stops.map((s) => `${s.reason}${s.experiment ? ` (${s.experiment})` : ""}`).join(", ")
      L.push(`${who}캠페인: ${c.status}${REASON_TEXT[c.reason] ? ` - ${REASON_TEXT[c.reason]}` : ""}. 프로세스 ${c.processes}개(재개 ${c.processes - 1}회), 요청 ${c.requests}건, 중단 기록: ${stops || "없음"}.`)
    }
  }
  L.push("")
  L.push("## 1. fable-write-tick (쓰기 tick)")
  const f = e["fable-write-tick"]
  L.push(verdict(f))
  L.push(...attemptLines(f))
  if (f.findings) {
    const show = tagged(f)
    for (const b of f.findings.blocks) {
      L.push(`- 블록 ${b.block}${tagOf(b, show)}: W=${b.writeTokens ?? "?"} tokens, n=${b.n ?? "?"}, m=${b.m ?? "?"}, phi=${interval(b.phi, 4)} -> W/T ${interval(b.writeOverT, 6)}, T ${interval(b.T, 1)} tokens/tick`)
      L.push(`  - hold: ${b.holdPings}/${f.findings.holdOffsetsMs.length}개, 규정 오프셋 충족 ${b.holdsComplete ? "예" : "아니오"} (허용오차 ${f.findings.holdToleranceMs} ms)`)
    }
    L.push(`- 블록 교집합 T: ${interval(f.findings.intersectedT, 1)} tokens/tick${f.findings.blocksDisjoint ? " (블록 구간이 서로 어긋남: 두 값을 모두 보고)" : ""}`)
    L.push(`- 가설: ${f.findings.verdict.hypothesis} (근거 ${f.findings.verdict.basis}, 경계 ${f.findings.verdict.thresholds.h6Below}/${f.findings.verdict.thresholds.h8Above}, 지연 tick ${f.findings.delayedTicksTotal}개)`)
    L.push(`- 사전값과의 pooled T: ${interval(f.findings.pooledT, 1)} (prior 6/8 tick은 reported_unverified)`)
    L.push(`- 건너뛴 arm: fable-write-5m (adapter_capability) -> k_write5 미측정`)
  }
  L.push("")
  L.push("## 2. output-quota (출력 계수)")
  const o = e["output-quota"]
  L.push(verdict(o))
  L.push(...attemptLines(o))
  if (o.findings) {
    const show = tagged(o)
    const unknownShare = (b) => `미상(${b.validShareReason ?? "unknown"})`
    for (const b of o.findings.blocks)
      L.push(
        `- 블록 ${b.block}${tagOf(b, show)}: 목표 ${b.outputTokensTarget ?? unknownShare(b)} tokens, N=${b.N}, tick=${b.ticks}, Sum_out=${b.sumOut}, phi ${interval(b.phi, 6)}, phi 출처 ${b.phiSource}, k_out ${b.kOut ? interval(b.kOut, 12) : `상한만 < ${fmt(b.kOutUpperBound, 12)}`} ticks/token, 유효 비율 ${b.validShare === null ? unknownShare(b) : fmt(b.validShare, 3)}`,
      )
    if (o.findings.blocks.some((b) => b.phiSource !== "phase_unobserved"))
      L.push(
        "- 위상 근거: 블록 1의 위상은 experiment_started.carryPhase(기계가 기록한 직전 tick 이후 위상)이고, 그 사이의 조용한 settle PING은 블록 1의 합에 넣었다. 다음 블록의 위상은 직전 블록의 두 번째 tick이 남긴 잔여 구간이다: 0 이상이고, 그 tick을 낸 OUT 호출의 비용보다 작으며, 직전 블록의 k_out 구간으로 제한한다. 직전 블록의 hold PING은 그 사이의 비용으로 합에 넣었다. DIAL 읽기의 rho는 가정하지 않는다. hold PING에서 tick이 나오면 연쇄가 끊기고, 그 다음 블록의 위상은 미관측(상한만)이다.",
      )
    L.push(
      `- k_out: ${o.findings.kOut ? interval(o.findings.kOut, 12) : `상한만 < ${fmt(o.findings.kOutUpperBound, 12)}`} ticks/token, 블록 겹침 ${o.findings.overlap ? "예" : "아니오"}${o.findings.kOutUpperBoundRule === "max_over_disjoint_blocks" ? " (블록 구간이 서로 겹치지 않아 측정값은 없다. 상한은 블록 상한 중 가장 큰 값이다)" : ""}`,
    )
    L.push(`- 읽기 비용 차감에 쓴 사전 범위: ${o.findings.readPrior.range.join("-")} tokens/tick (${o.findings.readPrior.evidenceRef}, ${o.findings.readPrior.sourceKind})`)
    L.push(`- 쓰기 대비 비율 r = k_out * T: ${interval(o.findings.ratio, 4)}`)
    const shareGap = o.findings.blocks.find((b) => b.validShareReason)
    L.push(`- 유효 요청 비율: ${o.findings.validShare === null || o.findings.validShare === undefined ? unknownShare(shareGap ?? {}) : fmt(o.findings.validShare, 3)} (기준 ${o.findings.validShareThreshold})`)
  }
  L.push("")
  L.push("## 3. ttl-1h-unique-prefix (1h TTL 갱신)")
  const t = e["ttl-1h-unique-prefix"]
  L.push(verdict(t))
  L.push(...attemptLines(t))
  if (t.findings) {
    const show = tagged(t)
    for (const r of t.findings.runs)
      L.push(`- run ${r.run}${tagOf(r, show)}: 처치 ping ${r.treatment.ping ?? "?"}, 처치 check ${r.treatment.check ?? "?"}, 대조 check ${r.control.check ?? "?"} (${r.status}${r.reason ? `: ${r.reason}` : ""}, 일정 준수 ${r.timing.ok === null ? "확인 불가" : r.timing.ok ? "예" : "아니오"})`)
    const renewalNote = t.findings.renewsAt55min
      ? t.status === "valid"
        ? ` (55분 읽기가 TTL을 갱신함, n=${t.findings.n}, measured)`
        : ` (55분 읽기가 TTL을 갱신함, n=${t.findings.n}, 사용량 기준 HIT/MISS - 창 오염으로 measured 아님)`
      : ""
    L.push(`- 결론: ${t.findings.verdict}${renewalNote}`)
  }
  L.push("")
  L.push("## 4. restore-decomposition (복원 분해)")
  const rs = e["restore-decomposition"]
  L.push(verdict(rs))
  L.push(...attemptLines(rs))
  const showRestore = tagged(rs)
  for (const r of rs.findings?.runs ?? []) {
    L.push(`- run ${r.run}${tagOf(r, showRestore)} (${r.mode}): 파킹 경로 ${interval(r.converted.park, 5)} / 원문 경로 ${interval(r.converted.raw, 5)} (unified-5h 환산, 구간)`)
    L.push(`  - 복원 지연: 파킹 ${r.resumeDelayMs.park ?? "미측정"} ms, 원문 ${r.resumeDelayMs.raw ?? "미측정"} ms`)
    const ph = Object.keys(r.phases).sort()
    L.push(`  - phase별 요청 수: ${ph.map((p) => `${p}=${r.phases[p].requests}`).join(", ")}`)
    for (const arm of ["park_path", "raw_path"]) {
      const q = r.quality?.[arm]
      if (!q) continue
      L.push(`  - 품질(${arm}): guard ${qval(q.guardCorrect)}, 정답 ${qval(q.workCorrect)}/${q.workCorrect.total}, 재설명 요청 ${qval(q.reexplainNeeded)}, handoff 유실 ${qval(q.handoffLossy)}`)
    }
    if (r.childResumeMisses.length) L.push(`  - 자식 resume miss: ${r.childResumeMisses.join(", ")}`)
  }
  L.push("")
  L.push("## 5. policy-effect (정책 효과)")
  const p = e["policy-effect"]
  L.push(verdict(p))
  L.push(...attemptLines(p))
  if (p.findings) {
    L.push(`- 쌍 수 n=${p.findings.pairedDifferences.n} (평균과 범위만, 구간 추정 주장 없음)`)
    for (const m of Object.keys(p.findings.pairedDifferences.perMeter).sort()) {
      const d = p.findings.pairedDifferences.perMeter[m]
      L.push(`  - ${m}: 평균 차이 ${interval(d.mean, 5)}, 최소 ${fmt(d.min?.lo, 5)}, 최대 ${fmt(d.max?.hi, 5)} (후보 - 현행)`)
    }
    const qd = p.findings.pairedDifferences.quality
    L.push(`  - 품질 차이(정답 수 평균): ${qd.workCorrectMeanDiff.value === null ? `미상(${qd.workCorrectMeanDiff.reason})` : fmt(qd.workCorrectMeanDiff.value, 3)}`)
    L.push(`  - 상태: ${p.findings.states.join(", ")}`)
  }
  L.push("")
  L.push("## 6. 지출 (meter별)")
  L.push("")
  L.push("| meter | 관측 | 상한 | 창 수 |")
  L.push("| --- | --- | --- | --- |")
  for (const m of Object.keys(analysis.spend).sort()) {
    const s = analysis.spend[m]
    L.push(`| \`${m}\` | ${s.observedEq ?? "미측정"} | ${s.upperEq ?? "미측정"} | ${s.windows} |`)
  }
  if (merged)
    for (const i of inputs)
      for (const m of Object.keys(i.spend).sort()) L.push(`| \`${m}\` (${i.runId}) | ${i.spend[m].observedEq ?? "미측정"} | ${i.spend[m].upperEq ?? "미측정"} | ${i.spend[m].windows} |`)
  L.push("")
  L.push("## 7. 계수 레코드")
  L.push("")
  L.push("| meter | sourceKind | cacheWrite1h 구간 | 발표값(상단) | 출력 계수 |")
  L.push("| --- | --- | --- | --- | --- |")
  for (const c of analysis.coefficientRecords) {
    const rng = c.observedRangeOrUncertainty.cacheWrite1h
    const prov = analysis.coefficientProvenance.find((x) => x.quotaMeterOrCostUnit === c.quotaMeterOrCostUnit)
    const outField = prov?.fields?.billedModelOutput
    L.push(
      `| \`${c.quotaMeterOrCostUnit}\` | ${c.sourceKind} | ${rng ? `[${rng[0].toExponential(4)}, ${rng[1].toExponential(4)}]` : "미측정"} | ${c.coefficients.cacheWrite1h === null ? "없음" : c.coefficients.cacheWrite1h.toExponential(4)} | ${c.coefficients.billedModelOutput === null ? `없음 (${outField?.status ?? "unidentified"}${outField?.reason ? `: ${outField.reason}` : ""})` : c.coefficients.billedModelOutput.toExponential(4)} |`,
    )
  }
  L.push("")
  L.push("측정하지 않은 필드는 null로 두었다(0으로 채우지 않았다). evidenceRef는 문자열이며 구조화된 출처는 `coefficientProvenance`에 따로 둔다.")
  L.push("")
  L.push("## 8. 정책 답 (범위 양 끝)")
  L.push(`- 결론: **${analysis.policyAnswer.action}** (${analysis.policyAnswer.reason})`)
  const scenarios = analysis.policyAnswer.scenarios ?? []
  const forecastCode = String(analysis.policyAnswer.forecastReason ?? "").split(":")[0]
  L.push(`- 엔진: ${analysis.policyAnswer.engine}, 예측 분포는 측정하지 않았다(${forecastCode}: q를 지어내지 않는다${scenarios.length ? ". 아래 가정 시나리오는 라벨을 붙인 가정일 뿐이다" : ""}). V=0 기준.`)
  const ends = analysis.policyAnswer.coefficientEnds
  if (ends)
    L.push(`- 엔진에 넣은 출력 계수(unified-5h, 출력 토큰당 사용률): 하단 ${fmtExp(ends.low.billedModelOutput)}, 상단 ${fmtExp(ends.high.billedModelOutput)} (${ends.provenance.billedModelOutput})`)
  if (analysis.policyAnswer.evaluatedAt) {
    for (const end of ["low", "high"]) {
      const d = analysis.policyAnswer.evaluatedAt[end]
      L.push(`- 범위 ${end === "low" ? "하단" : "상단"}: ${d.recommendedAction} (${d.reasonCode}, 증거 ${d.evidenceStatus})`)
    }
  } else {
    L.push("- 범위 하단/상단 평가 없음: 증거가 불완전하여 엔진을 돌리지 않았다.")
  }
  for (const s of scenarios) {
    L.push(`- 가정 시나리오 \`${s.id}\` (라벨: ${s.labelledAs}, 채택 ${s.promoted ? "예" : "아니오"}): 범위 하단 ${s.low?.action ?? "없음"} / 범위 상단 ${s.high?.action ?? "없음"} -> ${s.action} (${s.reason})`)
  }
  L.push("")
  L.push("## 9. 모르는 것")
  L.push("")
  for (const u of analysis.unknowns) L.push(`- ${unknownTextKo(u) ?? u}`)
  L.push("")
  const pairs = pairCounts(analysis)
  L.push(`이 문서는 측정된 범위를 넘는 절감 주장을 하지 않는다. 쌍 실행은 계획한 ${pairs.planned}쌍 중 ${pairs.completed}쌍을 마쳤고, 마친 쌍의 차이는 평균과 범위로만 보고한다.`)
  L.push("")
  return L.join("\n")
}

// ------------------------------------------------------------- CLI

function usage(message) {
  return { ok: false, error: message, usage: "node scripts/idle-live-analyze.mjs <runDir> [--merge <laterRunDir> ...] [--md <path>] [--out <path>]" }
}

export function parseArgs(argv) {
  const out = { runDir: null, md: null, out: null, merge: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--md" || a === "--out" || a === "--merge") {
      const v = argv[++i]
      if (!v || v.startsWith("-")) return { error: `missing_value_for:${a}` }
      if (a === "--merge") out.merge.push(v)
      else out[a === "--md" ? "md" : "out"] = v
      continue
    }
    if (a.startsWith("-")) return { error: `unknown_argument:${a}` }
    if (out.runDir !== null) return { error: "too_many_arguments" }
    out.runDir = a
  }
  if (!out.runDir) return { error: "missing_run_directory" }
  return out
}

// Same sanitization the ledger writes cli/<stepId>.json with (scripts/idle-live/ledger.mjs).
const sanitizeStepId = (stepId) => String(stepId).replace(/[^A-Za-z0-9._-]/g, "_")
const QUALITY_ROLES = new Set(["park_parent", "r1", "r2", "guard", "work", "resume_raw"])

export function loadRunDir(dir) {
  const requestsPath = path.join(dir, "requests.jsonl")
  const eventsPath = path.join(dir, "events.jsonl")
  const summaryPath = path.join(dir, "summary.json")
  // An absent requests.jsonl is only acceptable for a campaign cancelled before any issuance;
  // main() decides that from the events and fails closed otherwise.
  let requestsText = null
  try {
    requestsText = readFileSync(requestsPath, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  // Every run the machine starts writes events.jsonl (even a campaign cancelled before start), and
  // the verdicts are read from it: a missing or unreadable event log is never an empty one.
  let eventsText
  try {
    eventsText = readFileSync(eventsPath, "utf8")
  } catch (error) {
    // neither log present: no run directory at all (reported as such by main)
    if (requestsText === null && error?.code === "ENOENT") throw error
    throw Object.assign(new Error(`events.jsonl: ${error?.message ?? error}`), { code: error?.code ?? "unknown", issue: "unreadable_event_log" })
  }
  // Inputs that only refine the report. An absent one is a known shape (a crashed run has no
  // summary.json; a step may have no CLI artifact); one that exists but cannot be read or parsed
  // is named in `warnings`, which the analysis carries as integrity.warnings.
  const warnings = []
  const readOptionalJson = (file, issue, name) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") warnings.push({ issue, file: name, detail: String(error?.code ?? error?.name ?? "unknown") })
      return null
    }
  }
  const summary = readOptionalJson(summaryPath, "summary_unreadable", "summary.json")
  const requests = parseRecords(requestsText)
  const events = parseRecords(eventsText)
  // cli/<stepId>.json for the steps whose answer text the quality rules need. A file that is
  // absent or unreadable stays absent: the analyzer reports cli_artifact_missing, never a score.
  const cli = {}
  for (const r of requests.records) {
    if (!QUALITY_ROLES.has(r.role) || typeof r.stepId !== "string") continue
    const name = `cli/${sanitizeStepId(r.stepId)}.json`
    const artifact = readOptionalJson(path.join(dir, name), "cli_artifact_unreadable", name)
    if (artifact !== null) cli[r.stepId] = artifact
  }
  return { requestsText, eventsText, summary, requests, events, cli, warnings }
}

/** Reasons of every experiment that is not valid, so the one-line summary never reads as success. */
const reasonsOf = (analysis) => {
  const reasons = Object.fromEntries(Object.entries(analysis.experiments).filter(([, v]) => v.status !== "valid" && v.reason).map(([k, v]) => [k, v.reason]))
  return Object.keys(reasons).length ? { reasons } : {}
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.error) return { code: 3, payload: usage(args.error) }
  // A merged analysis is never written into an evidence directory: it needs an explicit --out.
  if (args.merge.length && !args.out) return { code: 3, payload: usage("missing_out_for_merge") }
  const dirs = [args.runDir, ...args.merge]
  const dirKey = (d) => (process.platform === "win32" ? path.resolve(d).toLowerCase() : path.resolve(d))
  if (new Set(dirs.map(dirKey)).size !== dirs.length) return { code: 2, payload: usage("merge_duplicate_input") }
  const loaded = []
  for (const dir of dirs) {
    let one
    try {
      one = loadRunDir(dir)
    } catch (error) {
      return { code: 2, payload: usage(`${error?.issue ?? "unreadable_run_directory"}:${error?.code ?? "unknown"}`) }
    }
    if (!one.requests.records.length && campaignOf(one.events.records, [])?.status !== "cancelled_before_start") {
      return { code: 2, payload: usage(one.requestsText === null ? "unreadable_run_directory:ENOENT" : "no_request_record") }
    }
    loaded.push(one)
  }
  const inputs = loaded.map((l) => ({
    rows: l.requests.records,
    events: l.events.records,
    requestsText: l.requestsText,
    eventsText: l.eventsText,
    runId: l.summary?.runId,
    summary: l.summary,
    cli: l.cli,
    skippedRequests: l.requests.skipped.length,
    skippedEvents: l.events.skipped.length,
    integrityWarnings: l.warnings,
  }))
  if (inputs.length > 1) {
    const error = mergeInputsError(inputs)
    if (error) return { code: 2, payload: usage(error) }
  }
  const analysis = analyzeRuns(inputs)
  const outPath = args.out ?? path.join(args.runDir, "analysis.json")
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await writeFile(outPath, `${stableStringify(analysis)}\n`, "utf8")
  if (args.md) {
    await mkdir(path.dirname(path.resolve(args.md)), { recursive: true })
    await writeFile(args.md, renderMarkdown(analysis), "utf8")
  }
  return {
    code: 0,
    payload: {
      ok: true,
      runId: analysis.runId,
      ...(analysis.runIds ? { runIds: analysis.runIds } : {}),
      out: outPath,
      md: args.md,
      skippedLines: { requests: loaded.reduce((a, l) => a + l.requests.skipped.length, 0), events: loaded.reduce((a, l) => a + l.events.skipped.length, 0) },
      experiments: Object.fromEntries(Object.entries(analysis.experiments).map(([k, v]) => [k, v.status])),
      attempts: Object.fromEntries(Object.entries(analysis.experiments).map(([k, v]) => [k, v.attempts.map(attemptLine)])),
      ...reasonsOf(analysis),
      ...(analysis.campaign ? { campaign: analysis.campaign.status } : {}),
      policyAnswer: analysis.policyAnswer.action,
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2))
  console.log(JSON.stringify(result.payload))
  process.exitCode = result.code
}
