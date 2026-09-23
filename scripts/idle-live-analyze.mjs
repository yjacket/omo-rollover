#!/usr/bin/env node
// Analyzer for one idle-live evidence directory (Appendix B "Analyzer" of
// .omo/plans/idle-experiments-live-run.md; the formulas are Appendix A sections 1-5 and
// their numbers are binding).
//
//   node scripts/idle-live-analyze.mjs <runDir> [--md <path>] [--out <path>]
//
// Input:  <runDir>/requests.jsonl (primary), <runDir>/events.jsonl, <runDir>/cli/<stepId>.json,
//         <runDir>/summary.json (optional).
// Output: <runDir>/analysis.json (or --out) and, with --md, a Korean results document.
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
//   * Phase phi is evidence, never a default: without a pre-walk tick or a carried phase recorded
//     in events, the output coefficient is an upper bound with reason `phase_unobserved`.
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

import { RULES, EXPERIMENT_IDS, schedule, makeTask, scoreWork, scoreGuard, reexplainNeeded, handoffLossy } from "./idle-live/protocols.mjs"
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
const unitOf = (v) => {
  const u = v.rec.unit
  return u && typeof u === "object" && Number.isInteger(u.index) && u.index > 0 ? u.index : null
}
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

export function analyzeFableWriteTick(recs, opts = {}) {
  const view = tickView(recs, opts)
  const overridden = Array.isArray(opts.overrideBlocks)
  const blocks = (opts.overrideBlocks ?? fableBlocksFrom(view)).map((b) => {
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
  // Appendix A section 1: the H8 rejection needs TWO complete 30-minute holds with zero delayed
  // ticks. Fewer blocks, a missing sample or a sample off its offset leaves the question open.
  const holdsUsable = !overridden && blocks.length === RULES.fable.blocks && blocks.every((b) => b.holdsComplete)
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

// ----------------------------------------------------- 2. output-quota

/** Read-cost of n reads as an INTERVAL from the reported prior range (never the 5.4M point). */
const readCostInterval = (tokens) => ({
  lo: tokens / READ_TOKENS_PER_TICK_RANGE[1],
  hi: tokens / READ_TOKENS_PER_TICK_RANGE[0],
  priorRange: [...READ_TOKENS_PER_TICK_RANGE],
  priorEvidenceRef: PRIOR_RANGE_ONLY.evidenceRef,
  sourceKind: PRIOR_RANGE_ONLY.sourceKind,
})

export function analyzeOutputQuota(recs, opts = {}) {
  const view = tickView(recs, opts)
  const blocks = []
  // A phase is evidence or it is unobserved: a carried phase must have been recorded by the
  // protocol in `experiment_started` (phase/phaseSource), otherwise phi stays [0, 1).
  const carried = Array.isArray(opts.phase) && opts.phase.length === 2 && opts.phase.every((x) => Number.isFinite(x)) ? { lo: opts.phase[0], hi: opts.phase[1] } : null
  // A block that ends on an OUT tick bounds phi by THAT request's cost - which is exactly the
  // unknown being measured - so a later block is NOT chained here. Only a dial pre-walk or a
  // phase the protocol recorded in events counts as evidence.
  let chainedPhase = carried
  const chainedSource = carried ? (opts.phaseSource ?? "carried_phase_from_events") : null
  for (const [index, entries] of groupByUnit(view)) {
    const pre = entries.filter((v) => roleOf(v) === "pre_walk")
    const loop = entries.filter((v) => roleOf(v) === "gate" || roleOf(v) === "loop").sort((a, b) => (ordinalOf(a) ?? 0) - (ordinalOf(b) ?? 0))
    const hold = entries.filter((v) => roleOf(v) === "hold")
    const preTicked = pre.length > 0 && pre[pre.length - 1].ticks > 0
    const phi = preTicked
      ? { lo: 0, hi: RHO }
      : pre.length > 0
        ? { lo: Math.min(1, pre.length * RHO), hi: 1 }
        : (chainedPhase ?? { lo: 0, hi: 1 })
    const phiSource = preTicked ? "pre_walk_tick" : pre.length > 0 ? "pre_walk_exhausted" : chainedPhase ? chainedSource : "phase_unobserved"
    const phaseObserved = phiSource !== "phase_unobserved"
    let cumulative = 0
    let N = loop.length
    const outs = []
    const reads = []
    let valid = 0
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i]
      outs.push(v.usage.billedModelOutput)
      reads.push(v.usage.cacheRead)
      const target = v.rec.expect?.outputTokensTarget ?? RULES.output.outputTarget
      const minOutput = Math.round((RULES.output.gateMinOutput * target) / RULES.output.outputTarget)
      if (v.usage.billedModelOutput >= minOutput && v.rec.stop_reason === "end_turn") valid += 1
      cumulative += v.ticks
      if (cumulative >= RULES.output.targetTicks) {
        N = i + 1
        break
      }
    }
    const sum = (arr, k) => arr.slice(0, k).reduce((a, x) => a + x, 0)
    const sumOut = sum(outs, N)
    const sumOutPrev = sum(outs, N - 1)
    const fixed = readCostInterval(sum(reads, N))
    const fixedPrev = readCostInterval(sum(reads, N - 1))
    const ticksIdentified = cumulative >= RULES.output.targetTicks && sumOutPrev > 0
    const identified = ticksIdentified && phaseObserved
    const delayedTicks = hold.reduce((a, v) => a + v.ticks, 0)
    blocks.push({
      block: index,
      phi,
      phiSource,
      phaseObserved,
      N,
      ticks: cumulative,
      sumOut,
      sumOutPrev,
      fixed,
      fixedPrev,
      delayedTicks,
      validShare: loop.length ? valid / loop.length : null,
      kOut: identified
        ? { lo: (RULES.output.targetTicks - phi.hi - fixed.hi) / sumOut, hi: (RULES.output.targetTicks - phi.lo - fixedPrev.lo) / sumOutPrev, loInclusive: true, hiExclusive: true }
        : null,
      kOutUpperBound: sumOut > 0 ? (RULES.output.targetTicks - phi.lo) / sumOut : null,
      status: identified ? "identified" : "upper_bound",
      reason: identified ? null : phaseObserved ? "no_second_tick_within_64" : "phase_unobserved",
    })
    // The carried phase belongs to the first block only: an OUT tick does not bound phi by a
    // known cost, so later blocks stay unobserved unless they walked a dial of their own.
    chainedPhase = null
  }
  const identifiedBlocks = blocks.filter((b) => b.kOut)
  let kOut = null
  let overlap = true
  for (const b of identifiedBlocks) {
    kOut = intersect(kOut, { lo: b.kOut.lo, hi: b.kOut.hi })
  }
  if (kOut?.empty) {
    overlap = false
    kOut = { lo: identifiedBlocks[0].kOut.lo, hi: identifiedBlocks[0].kOut.hi }
  }
  const status = blocks.length === 0 ? "void" : identifiedBlocks.length === blocks.length ? "valid" : "upper_bound"
  const bounds = blocks.map((b) => b.kOutUpperBound).filter((x) => typeof x === "number")
  const T = opts.T ?? null
  const totalRequests = blocks.reduce((a, b) => a + b.N, 0)
  const weightedValid = blocks.reduce((a, b) => a + (b.validShare ?? 0) * b.N, 0)
  const unobserved = blocks.filter((b) => !b.phaseObserved).map((b) => b.block)
  return {
    experiment: "output-quota",
    status,
    reason: status === "upper_bound" && unobserved.length ? "phase_unobserved" : null,
    blocks,
    phaseObserved: unobserved.length === 0,
    blocksWithoutPhase: unobserved,
    kOut: kOut ? { lo: kOut.lo, hi: kOut.hi, unit: "ticks_per_output_token" } : null,
    kOutUpperBound: bounds.length ? Math.min(...bounds) : null,
    overlap,
    ratio: kOut && T ? { lo: kOut.lo * T.lo, hi: kOut.hi * T.hi, definition: "k_out * T = output cost relative to one 1h write token" } : null,
    validShare: totalRequests ? weightedValid / totalRequests : null,
    validShareThreshold: RULES.output.validOutputShare,
    blocksOverlap: overlap,
    readPrior: { range: [...READ_TOKENS_PER_TICK_RANGE], evidenceRef: PRIOR_RANGE_ONLY.evidenceRef, sourceKind: PRIOR_RANGE_ONLY.sourceKind, unit: PRIOR_RANGE_ONLY.unit },
  }
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

export function analyzeTtl(recs, opts = {}) {
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

// -------------------------------------------- coefficients and conversion

const kWriteFromT = (T) => (T ? { lo: RESOLUTION / T.hi, hi: RESOLUTION / T.lo } : { lo: RESOLUTION / PRIOR_RANGE_ONLY.cacheWrite1h[1], hi: RESOLUTION / PRIOR_RANGE_ONLY.cacheWrite1h[0] })

/**
 * The two ends of the conversion Q = kW*w1h + kR*rd + kOut*out + kIn*in (Appendix A section 4).
 * kIn is unknown and only bounded by kW: it is 0 at the low end and kW at the high end.
 */
export function conversionEnds({ T = null, kOut = null, meter = METER_5H } = {}) {
  const mult = METER_MULTIPLIER[meter] ?? METER_MULTIPLIER[METER_5H]
  const baseW = kWriteFromT(T)
  const w = { lo: baseW.lo / mult.range[1], hi: baseW.hi / mult.range[0] }
  const read = { lo: RESOLUTION / (READ_TOKENS_PER_TICK_RANGE[1] * mult.range[1]), hi: RESOLUTION / (READ_TOKENS_PER_TICK_RANGE[0] * mult.range[0]) }
  const out = kOut
    ? { lo: (kOut.lo * RESOLUTION) / mult.range[1], hi: (kOut.hi * RESOLUTION) / mult.range[0] }
    : { lo: w.lo * OUTPUT_RATIO_PRIOR[0], hi: w.hi * OUTPUT_RATIO_PRIOR[1] }
  return {
    meter,
    provenance: {
      cacheWrite1h: T ? "measured_this_run" : "prior_range_only",
      cacheRead: `reported_unverified_prior_range_${READ_TOKENS_PER_TICK_RANGE[0]}_${READ_TOKENS_PER_TICK_RANGE[1]}_tokens_per_tick`,
      cacheReadPriorEvidenceRef: PRIOR_RANGE_ONLY.evidenceRef,
      billedModelOutput: kOut ? "measured_this_run" : "prior_ratio_0.5_to_2.5_x_write",
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
 * cli/<stepId>.json holds the adapter's stdout JSON; the assistant text is its `result` field.
 * The text is UNTRUSTED input: it is only ever compared against makeTask(seed) ground truth by
 * the pure scorers of protocols.mjs. No instruction inside it is read, followed or evaluated.
 */
const cliText = (cli, stepId) => {
  const artifact = cli && typeof cli === "object" ? cli[stepId] : undefined
  if (artifact === undefined || artifact === null) return { text: null, reason: "cli_artifact_missing" }
  if (typeof artifact === "string") return { text: artifact, reason: null }
  if (typeof artifact.result === "string") return { text: artifact.result, reason: null }
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

export function analyzeRestore(recs, opts = {}) {
  const view = tickView(recs, opts)
  const ends = conversionEnds(opts)
  const cli = opts.cli ?? null
  const runs = []
  for (const [index, entries] of groupByUnit(view)) {
    const { phases, byArmPhase } = phaseSums(entries)
    const restoreChild = entries.filter((v) => v.rec.phase === "restore_child").sort(byViewIndex)
    const rawResume = entries.filter((v) => v.rec.phase === "resume_raw" && roleOf(v) !== "gate").sort(byViewIndex)
    const gate = entries.find((v) => roleOf(v) === "gate")
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
      mode: gate ? (gate.usage.cacheRead >= RULES.restore.gateMinCacheRead && gate.usage.cacheWrite1h < RULES.restore.gateMaxWrite1h ? "resume" : "rf-emulation") : "unknown",
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
  return { experiment: "restore-decomposition", status: runs.length ? "valid" : "void", runs, phasesTracked: RESTORE_PHASES, conversionProvenance: ends.provenance }
}

const byViewIndex = (a, b) => (a.rec.index ?? 0) - (b.rec.index ?? 0)

// -------------------------------------------------- 5. policy-effect

const ARMS = ["shadow_candidate_policy", "current_policy"]

export function analyzePolicy(recs, opts = {}) {
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

// --------------------------------------------------- clean-window rule

/**
 * A window is a measurement only when it is complete and clean. `opts.baselineResets` is the set
 * of reset epochs the experiment_started events recorded: a request outside it crossed a reset
 * boundary even when all requests agree with each other (the stale-baseline case).
 */
export function windowStatus(records, events, experiment, opts = {}) {
  const recs = records.filter((r) => r.experiment === experiment)
  if (!recs.length) return { experiment, clean: false, sourceKind: "unknown", reasons: ["not_run"], requests: 0, resetEpochs: [] }
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
    if (!r.unit || typeof r.unit !== "object" || !Number.isInteger(r.unit.index) || typeof r.unit.kind !== "string") reasons.add("schema_incomplete")
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
  // Request rows and the checkpoint must describe the same set of paid calls, 1:1.
  const requestIds = new Set(recs.map((r) => r.stepId))
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
    const first = baselines[m] ?? readings[0]
    let current = { reset: first.reset, start: first.util, end: first.util }
    for (const r of readings) {
      if (r.reset !== current.reset) {
        windows.push(current)
        current = { reset: r.reset, start: r.util, end: r.util }
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

const experimentBaseline = (events, experiment, meter = METER_5H) => {
  for (const e of startedEvents(events, experiment)) if (e.baselines?.[meter]) return e.baselines[meter]
  return null
}

const baselineResetsOf = (events, experiment, meter = METER_5H) =>
  startedEvents(events, experiment)
    .map((e) => e.baselines?.[meter]?.reset)
    .filter((x) => Number.isFinite(x))

const experimentT0 = (events, experiment) => {
  const e = startedEvents(events, experiment)[0]
  return e ? msOf(e.t0) : null
}

/** Carried gauge phase, only when the protocol recorded one in `experiment_started`. */
const carriedPhase = (events, experiment) => {
  const e = startedEvents(events, experiment).find((x) => Array.isArray(x.phase))
  return e ? { phase: e.phase, phaseSource: typeof e.phaseSource === "string" ? e.phaseSource : "carried_phase_from_events" } : { phase: null, phaseSource: null }
}

// makeTask is deterministic but not free: one task per (seed, steps) per process.
const taskCache = new Map()
const taskFor = (seed, steps) => {
  if (!Number.isFinite(seed)) return null
  const key = `${seed}#${steps}`
  if (!taskCache.has(key)) taskCache.set(key, makeTask(seed, { steps }))
  return taskCache.get(key)
}

/** Seed of one unit: `experiment_started.seeds`, indexed by the unit (or labelled with `run`). */
function seedOf(events, experiment, unitIndex) {
  const starts = startedEvents(events, experiment)
  for (const e of starts) if (e.run === unitIndex && Array.isArray(e.seeds) && Number.isFinite(e.seeds[0])) return e.seeds[0]
  for (const e of starts) {
    if (e.run !== undefined) continue
    if (Array.isArray(e.seeds) && e.seeds.length >= unitIndex && Number.isFinite(e.seeds[unitIndex - 1])) return e.seeds[unitIndex - 1]
  }
  return null
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

export function analyzeRun(records, events, opts = {}) {
  const requestsText = opts.requestsText ?? null
  const eventsText = opts.eventsText ?? null
  const cli = opts.cli ?? null
  const runId = opts.runId ?? records.find((r) => r.runId)?.runId ?? null
  const skippedRequests = opts.skippedRequests ?? (requestsText ? parseRecords(requestsText).skipped.length : 0)
  const skippedEvents = opts.skippedEvents ?? (eventsText ? parseRecords(eventsText).skipped.length : 0)
  const byExperiment = Object.fromEntries(EXPERIMENT_IDS.map((id) => [id, records.filter((r) => r.experiment === id)]))
  // A row that does not parse cannot be attributed to an experiment, so it contaminates the whole
  // evidence file: nothing here may stay measured while part of the input is unreadable.
  const malformedRows = skippedRequests > 0
  const windows = Object.fromEntries(
    EXPERIMENT_IDS.map((id) => [id, windowStatus(records, events, id, { malformedRows, baselineResets: baselineResetsOf(events, id) })]),
  )

  const analyzeOne = (id, fn) => {
    const recs = byExperiment[id]
    const w = windows[id]
    if (!recs.length) return { status: "not_run", reason: "no_request_in_evidence", window: w, findings: null }
    const hard = hardReasonOf(w.reasons)
    if (hard) return { status: "void", reason: hard, window: w, findings: null }
    const findings = fn(recs, { baseline: experimentBaseline(events, id) })
    const status = w.clean ? findings.status : "contaminated"
    return { status, reason: w.clean ? (findings.reason ?? null) : w.reasons.join(","), window: w, findings }
  }

  const fable = analyzeOne("fable-write-tick", (recs, o) => analyzeFableWriteTick(recs, o))
  const T = fable.status === "valid" ? (fable.findings?.intersectedT ?? null) : null
  const outputPhase = carriedPhase(events, "output-quota")
  const output = analyzeOne("output-quota", (recs, o) => analyzeOutputQuota(recs, { ...o, T, phase: outputPhase.phase, phaseSource: outputPhase.phaseSource }))
  // An identified block measures k_out even when a sibling block only bounds it; a void or
  // contaminated window measures nothing at all.
  const outputWindowUsable = output.status === "valid" || output.status === "upper_bound"
  const kOut = outputWindowUsable ? (output.findings?.kOut ?? null) : null
  const outputStatus = kOut ? "measured" : "upper_bound"
  const outputReason = kOut ? null : (output.findings?.reason ?? (outputWindowUsable ? "no_second_tick_within_64" : "output_window_not_clean"))
  const ttl = analyzeOne("ttl-1h-unique-prefix", (recs, o) => analyzeTtl(recs, { ...o, t0: experimentT0(events, "ttl-1h-unique-prefix") }))
  const restoreTask = (unitIndex) => taskFor(seedOf(events, "restore-decomposition", unitIndex), RULES.restore.workSteps)
  const policyTask = (unitIndex) => taskFor(seedOf(events, "policy-effect", unitIndex), RULES.policy.workSteps)
  const restore = analyzeOne("restore-decomposition", (recs, o) => analyzeRestore(recs, { ...o, T, kOut, cli, taskOf: restoreTask }))
  const policy = analyzeOne("policy-effect", (recs, o) => analyzePolicy(recs, { ...o, T, kOut, cli, taskOf: policyTask }))

  const experiments = {
    "fable-write-tick": { status: fable.status, reason: fable.reason, window: fable.window, hypotheses: fable.findings?.hypotheses ?? [], findings: fable.findings },
    "output-quota": { status: output.status, reason: output.reason, window: output.window, hypotheses: [], findings: output.findings },
    "ttl-1h-unique-prefix": { status: ttl.status, reason: ttl.reason, window: ttl.window, hypotheses: [], findings: ttl.findings },
    "restore-decomposition": { status: restore.status, reason: restore.reason, window: restore.window, hypotheses: [], findings: restore.findings },
    "policy-effect": { status: policy.status, reason: policy.reason, window: policy.window, hypotheses: [], findings: policy.findings },
  }

  const { records: coefficientRecords, provenance: coefficientProvenance } = buildCoefficientRecords({
    T,
    kOut,
    outputStatus,
    outputReason,
    sourceKind: fable.status === "valid" && windows["fable-write-tick"].clean ? "measured" : "unknown",
    window: { experiment: "fable-write-tick", requests: windows["fable-write-tick"].requests, resetEpochs: windows["fable-write-tick"].resetEpochs ?? [], reasons: windows["fable-write-tick"].reasons },
    runId,
    requestsSha256: requestsText ? sha256(requestsText) : null,
    sampleCount: byExperiment["fable-write-tick"].length,
    measuredAt: records.length ? (records[records.length - 1].ts ?? null) : null,
    validFrom: records.length ? (records[0].ts_req ?? null) : null,
  })

  // Engine feed: the phase sums converted at both ends of every range. A restore or policy
  // window that is not valid takes the whole feed out: the answer is NO_DECISION, never an action.
  const endsLowHigh = conversionEnds({ T, kOut, meter: METER_5H })
  const warmPer = warmSumsFrom(records)
  const restoreRun = restore.findings?.runs?.[0] ?? null
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
  const feedExperiments = ["restore-decomposition", "policy-effect"]
  const invalidFeed = feedExperiments.filter((id) => experiments[id].status !== "valid")
  const hasModel = parts.warm.lo !== null && parts.parkParent.lo !== null && parts.restoreChild.lo !== null && parts.resumeRaw.lo !== null && parts.ctxCreate.lo !== null
  const modelLow = hasModel ? buildIdleCostModel({ warm: parts.warm.lo, ctxCreate: parts.ctxCreate.lo, parkParent: parts.parkParent.lo, restoreChild: parts.restoreChild.lo, resumeRaw: parts.resumeRaw.lo }) : null
  const modelHigh = hasModel ? buildIdleCostModel({ warm: parts.warm.hi, ctxCreate: parts.ctxCreate.hi, parkParent: parts.parkParent.hi, restoreChild: parts.restoreChild.hi, resumeRaw: parts.resumeRaw.hi }) : null
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
      hasModel ? "cost model built from restore run 1 phase sums" : "no cost model: the restore phases are missing",
      T ? "write coefficient measured by this run" : "coefficients are the reported prior RANGE only: this evidence did not measure T",
      kOut ? "output coefficient measured by this run" : `output coefficient is an upper bound only (${outputReason ?? "unidentified"})`,
    ],
  })
  policyAnswer.phaseCostsEq = parts
  policyAnswer.coefficientEnds = { low: endsLowHigh.low, high: endsLowHigh.high, provenance: endsLowHigh.provenance }

  const unknowns = [
    "cacheWrite5m coefficient: the CLI writes only the 1h lane, so the 5m arm is skipped (adapter_capability) and k_write5 stays unknown - never defaulted from the 1h lane",
    "uncachedInput coefficient (k_input): unknown, only bounded above by the 1h write coefficient",
    `cacheRead coefficient: the ${READ_TOKENS_PER_TICK_RANGE[0]}-${READ_TOKENS_PER_TICK_RANGE[1]} tokens per tick figure is a reported_unverified prior range from ${PRIOR_RANGE_ONLY.evidenceRef}, not measured by this run`,
    "return forecast q: not measured; the planner entries are labelled hypothetical scenarios, never facts",
    "skillRestoreEq / sharedLossEq / parkQualityEq: not measured; entered as 0 baselines in the engine model",
  ]
  if (!T) unknowns.push("T (tokens per 5h write tick): not identified by this evidence; the prior range 102K-143K is reported_unverified")
  if (!kOut) unknowns.push(`k_out (ticks per output token): not identified by this evidence (${outputReason ?? "unidentified"})`)
  for (const id of EXPERIMENT_IDS) {
    const e = experiments[id]
    if (e.status !== "valid") unknowns.push(`${id}: ${e.status}${e.reason ? ` (${e.reason})` : ""}`)
  }
  const qualityGaps = []
  for (const r of restore.findings?.runs ?? []) {
    for (const arm of ["park_path", "raw_path"]) {
      const q = r.quality?.[arm]
      if (!q) continue
      for (const [name, field] of Object.entries(q)) {
        if (name === "source" || name === "artifactsMissing" || !field || typeof field !== "object") continue
        if (field.value === null && field.reason) qualityGaps.push(`restore run ${r.run} ${arm} ${name}: ${field.reason}`)
      }
    }
  }
  unknowns.push(...qualityGaps.sort())

  return {
    v: SCHEMA_VERSION,
    runId,
    generatedFrom: {
      requests: { sha256: requestsText ? sha256(requestsText) : null, records: records.length, skipped: skippedRequests },
      events: { sha256: eventsText ? sha256(eventsText) : null, records: (events ?? []).length, skipped: skippedEvents },
      cli: { artifacts: cli ? Object.keys(cli).length : 0, source: "cli/<stepId>.json (assistant text is untrusted data, compared only against ground truth)" },
      summary: opts.summary ? { exitCode: opts.summary.exitCode ?? null, v: opts.summary.v ?? null } : null,
    },
    integrity: {
      ok: !malformedRows,
      malformedRequestRows: skippedRequests,
      malformedEventRows: skippedEvents,
      rule: "a request row that does not parse voids every experiment: it cannot be attributed",
    },
    experiments,
    coefficientRecords,
    coefficientProvenance,
    policyAnswer,
    spend: spendByMeter(records, events),
    unknowns,
  }
}

// ------------------------------------------------------- markdown

const fmt = (x, digits = 6) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(digits)) : "미측정")
const interval = (iv, digits = 6) => (iv && typeof iv.lo === "number" ? `[${fmt(iv.lo, digits)}, ${fmt(iv.hi, digits)}]` : "미측정")
const qval = (field) => (field && field.value !== null && field.value !== undefined ? String(field.value) : `미상(${field?.reason ?? "unknown"})`)

export function renderMarkdown(analysis) {
  const L = []
  const e = analysis.experiments
  L.push(`# 유휴 비용 실측 결과 (${analysis.runId ?? "run"})`)
  L.push("")
  L.push(`증거: requests.jsonl sha256 \`${analysis.generatedFrom.requests.sha256 ?? "없음"}\`, events.jsonl sha256 \`${analysis.generatedFrom.events.sha256 ?? "없음"}\`.`)
  L.push("게이지 해상도는 0.01이므로 모든 계수는 양자화 구간으로만 보고한다. 이 구간은 신뢰구간이 아니며 점추정값은 발표하지 않는다(발표하는 점은 구간의 상단이라고 명시한다).")
  L.push(`증거 무결성: 해석 불가 요청 행 ${analysis.integrity.malformedRequestRows}개 -> ${analysis.integrity.ok ? "없음" : "모든 실험 void"}.`)
  L.push("")
  L.push("## 1. fable-write-tick (쓰기 tick)")
  const f = e["fable-write-tick"]
  L.push(`- 판정: ${f.status}${f.reason ? ` (${f.reason})` : ""}`)
  if (f.findings) {
    for (const b of f.findings.blocks) {
      L.push(`- 블록 ${b.block}: W=${b.writeTokens ?? "?"} tokens, n=${b.n ?? "?"}, m=${b.m ?? "?"}, phi=${interval(b.phi, 4)} -> W/T ${interval(b.writeOverT, 6)}, T ${interval(b.T, 1)} tokens/tick`)
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
  L.push(`- 판정: ${o.status}${o.reason ? ` (${o.reason})` : ""}`)
  if (o.findings) {
    for (const b of o.findings.blocks) L.push(`- 블록 ${b.block}: N=${b.N}, tick=${b.ticks}, Sum_out=${b.sumOut}, phi 출처 ${b.phiSource}, k_out ${b.kOut ? interval(b.kOut, 12) : `상한만 < ${fmt(b.kOutUpperBound, 12)}`} ticks/token`)
    L.push(`- k_out: ${o.findings.kOut ? interval(o.findings.kOut, 12) : `상한만 < ${fmt(o.findings.kOutUpperBound, 12)}`} ticks/token, 블록 겹침 ${o.findings.overlap ? "예" : "아니오"}`)
    L.push(`- 읽기 비용 차감에 쓴 사전 범위: ${o.findings.readPrior.range.join("-")} tokens/tick (${o.findings.readPrior.evidenceRef}, ${o.findings.readPrior.sourceKind})`)
    L.push(`- 쓰기 대비 비율 r = k_out * T: ${interval(o.findings.ratio, 4)}`)
    L.push(`- 유효 요청 비율: ${fmt(o.findings.validShare, 3)} (기준 ${o.findings.validShareThreshold})`)
  }
  L.push("")
  L.push("## 3. ttl-1h-unique-prefix (1h TTL 갱신)")
  const t = e["ttl-1h-unique-prefix"]
  L.push(`- 판정: ${t.status}${t.reason ? ` (${t.reason})` : ""}`)
  if (t.findings) {
    for (const r of t.findings.runs)
      L.push(`- run ${r.run}: 처치 ping ${r.treatment.ping ?? "?"}, 처치 check ${r.treatment.check ?? "?"}, 대조 check ${r.control.check ?? "?"} (${r.status}${r.reason ? `: ${r.reason}` : ""}, 일정 준수 ${r.timing.ok === null ? "확인 불가" : r.timing.ok ? "예" : "아니오"})`)
    L.push(`- 결론: ${t.findings.verdict}${t.findings.renewsAt55min ? ` (55분 읽기가 TTL을 갱신함, n=${t.findings.n}, measured)` : ""}`)
  }
  L.push("")
  L.push("## 4. restore-decomposition (복원 분해)")
  const rs = e["restore-decomposition"]
  L.push(`- 판정: ${rs.status}${rs.reason ? ` (${rs.reason})` : ""}`)
  for (const r of rs.findings?.runs ?? []) {
    L.push(`- run ${r.run} (${r.mode}): 파킹 경로 ${interval(r.converted.park, 5)} / 원문 경로 ${interval(r.converted.raw, 5)} (unified-5h 환산, 구간)`)
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
  L.push(`- 판정: ${p.status}${p.reason ? ` (${p.reason})` : ""}`)
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
  L.push(`- 엔진: ${analysis.policyAnswer.engine}, 예측 분포는 측정하지 않았다(${analysis.policyAnswer.forecastReason}). V=0 기준.`)
  if (analysis.policyAnswer.evaluatedAt) {
    for (const end of ["low", "high"]) {
      const d = analysis.policyAnswer.evaluatedAt[end]
      L.push(`- 범위 ${end === "low" ? "하단" : "상단"}: ${d.recommendedAction} (${d.reasonCode}, 증거 ${d.evidenceStatus})`)
    }
  } else {
    L.push("- 범위 하단/상단 평가 없음: 증거가 불완전하여 엔진을 돌리지 않았다.")
  }
  for (const s of analysis.policyAnswer.scenarios ?? []) {
    L.push(`- 가정 시나리오 \`${s.id}\` (라벨: ${s.labelledAs}, 채택 ${s.promoted ? "예" : "아니오"}): 범위 하단 ${s.low?.action ?? "없음"} / 범위 상단 ${s.high?.action ?? "없음"} -> ${s.action} (${s.reason})`)
  }
  L.push("")
  L.push("## 9. 모르는 것")
  L.push("")
  for (const u of analysis.unknowns) L.push(`- ${u}`)
  L.push("")
  L.push("이 문서는 측정된 범위를 넘는 절감 주장을 하지 않는다. 쌍 실행 n=3의 차이는 평균과 범위로만 보고한다.")
  L.push("")
  return L.join("\n")
}

// ------------------------------------------------------------- CLI

function usage(message) {
  return { ok: false, error: message, usage: "node scripts/idle-live-analyze.mjs <runDir> [--md <path>] [--out <path>]" }
}

export function parseArgs(argv) {
  const out = { runDir: null, md: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--md" || a === "--out") {
      const v = argv[++i]
      if (!v || v.startsWith("-")) return { error: `missing_value_for:${a}` }
      out[a === "--md" ? "md" : "out"] = v
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
  const requestsText = readFileSync(requestsPath, "utf8")
  let eventsText = ""
  try {
    eventsText = readFileSync(eventsPath, "utf8")
  } catch {
    eventsText = ""
  }
  let summary = null
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"))
  } catch {
    summary = null
  }
  const requests = parseRecords(requestsText)
  const events = parseRecords(eventsText)
  // cli/<stepId>.json for the steps whose answer text the quality rules need. A file that is
  // absent or unreadable stays absent: the analyzer reports cli_artifact_missing, never a score.
  const cli = {}
  for (const r of requests.records) {
    if (!QUALITY_ROLES.has(r.role) || typeof r.stepId !== "string") continue
    try {
      cli[r.stepId] = JSON.parse(readFileSync(path.join(dir, "cli", `${sanitizeStepId(r.stepId)}.json`), "utf8"))
    } catch {
      // absent artifact
    }
  }
  return { requestsText, eventsText, summary, requests, events, cli }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.error) return { code: 3, payload: usage(args.error) }
  let loaded
  try {
    loaded = loadRunDir(args.runDir)
  } catch (error) {
    return { code: 2, payload: usage(`unreadable_run_directory:${error?.code ?? "unknown"}`) }
  }
  if (!loaded.requests.records.length) return { code: 2, payload: usage("no_request_record") }
  const analysis = analyzeRun(loaded.requests.records, loaded.events.records, {
    requestsText: loaded.requestsText,
    eventsText: loaded.eventsText,
    runId: loaded.summary?.runId,
    summary: loaded.summary,
    cli: loaded.cli,
    skippedRequests: loaded.requests.skipped.length,
    skippedEvents: loaded.events.skipped.length,
  })
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
      out: outPath,
      md: args.md,
      skippedLines: { requests: loaded.requests.skipped.length, events: loaded.events.skipped.length },
      experiments: Object.fromEntries(Object.entries(analysis.experiments).map(([k, v]) => [k, v.status])),
      policyAnswer: analysis.policyAnswer.action,
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2))
  console.log(JSON.stringify(result.payload))
  process.exitCode = result.code
}
