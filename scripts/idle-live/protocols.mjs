// Adaptive measurement protocols for the idle-cost live run: Appendix A of
// .omo/plans/idle-experiments-live-run.md (.protocols.md; its numbers are binding and live in
// RULES). Pure: no I/O, no timer, no wall clock, no ambient randomness. Each protocol is an
// async generator: it yields one StepRequest per paid call, is resumed with that step's
// StepResult, and returns an ExperimentResult. Walks stop on a tick, so the request list is
// not static; `schedule()` exposes the static skeleton for --dry-run and `parity()` checks the
// paid-call multiplicity against the per-arm counts of Appendix A.
//
// Contract with the machine (scripts/idle-live/machine.mjs):
//   ctx = { experiment, approval, random: { uuid(), seed() }, mode: { resumeHit: null|true|false },
//           dialPrefix: { prompt, sessionId } | null, now(): ms elapsed since the experiment t0,
//           priors, run?: 1|2 (restore-decomposition invocation), phase?: [lo, hi] (gauge phase
//           carried from the previous gauge experiment; pass only if nothing was paid in between) }
//   StepRequest = { id: `${experiment}/${arm}/${index}`, experiment, arm, index, kind, phase, role,
//           unit: { kind: block|run|pair, index }, scopeId (per-idle cap scope), atOffsetMs, toleranceMs,
//           prompt: { text, sha256, chars, tokensEst, fillerLines }, session: { id, mode: new|resume|ephemeral },
//           expect: { ttlLane, hit?, outputTokensTarget? }, dominantField, needsText?, resetMarginMs?,
//           n? (walk/loop ordinal), k? (work step), prefix? (TTL), seed? (context writes) }
//   StepResult = { record | null, anomalies: string[], ticks: { "unified-5h": n, ... }, late, meters }
//     record.usage: raw API usage; record.text: assistant text (needed when needsText);
//     record.ts_req / record.ts: ISO or ms timestamps (resume delays); record.model; record.stop_reason;
//     record.headers["anthropic-ratelimit-unified-status"]. Anomaly "reset_changed" voids a gauge block;
//     late === true voids the experiment - a late step is never rescheduled.
//   ExperimentResult = { experiment, status: valid|void|aborted|upper_bound, reason, steps, anomalies,
//           paidRequests, ...protocol data for the analyzer }
import { NULLP, OUTP, outp, filler, SITES, promptOf, fillerPrompt, FILLER_TOKENS_PER_LINE } from "./filler.mjs"
import { makeTask, scoreWork, scoreGuard, reexplainNeeded, handoffLossy } from "./task.mjs"

export { filler, SITES, NULLP, OUTP, outp, promptOf, fillerPrompt, makeTask, scoreWork, scoreGuard, reexplainNeeded, handoffLossy }

export const EXPERIMENT_IDS = ["fable-write-tick", "output-quota", "ttl-1h-unique-prefix", "restore-decomposition", "policy-effect"]
const METER = "unified-5h"
const MIN = 60000

// Appendix A numbers. Usage thresholds are the 0.9 x expected-token rules written out.
export const RULES = Object.freeze({
  model: "claude-fable-5-1",
  meter: METER,
  rho: 1 / 37, // DIAL read cost in ticks (09-19: 37 reads between ticks)
  rhoLow: 1 / 38,
  spacingMs: 3000,
  dialSpacingMs: 6000,
  untimedToleranceMs: 10 * MIN,
  dial: { minCacheRead: 140000, maxWrite1h: 5000 },
  fable: {
    blocks: 2, writeLines: 2400, preWalkMax: 35, postWalkMax: 40, postWalkAnomalyAbove: 38,
    holdOffsetsMs: [5000, 15000, 30000, 1 * MIN, 3 * MIN, 10 * MIN, 30 * MIN], holdToleranceMs: 30000,
    resetMarginMs: 45 * MIN, earlyThreshold: 0.9,
  },
  output: {
    blocks: 2, optionalBlock: 3, preWalkMax: 30, loopMax: 64, targetTicks: 2, gateMinOutput: 6000, validOutputShare: 0.9,
    holdPings: 4, holdSpacingMs: 60000, holdToleranceMs: 30000, resetMarginMs: 140 * MIN, block3MinRemaining: 0.025,
    // Amendment 2026-09-27: outp(2000) returned 5,106 output tokens (~2 per line up to 999, ~3 per
    // 4-digit line), so outp(3000) ~ 8,000 and outp(1700) ~ 4,100. Targets and gates are unchanged.
    n: 3000, outputTarget: 8000, block3: { n: 1700, outputTarget: 4000 },
  },
  ttl: {
    lines: 2000, writeMinWrite1h: 53460, pingMinCacheRead: 56160, pingMaxWrite1h: 2000,
    checkHitMinCacheRead: 56160, checkHitMaxWrite1h: 2000, checkMissMinWrite1h: 53460, toleranceMs: 90000,
  },
  restore: {
    lines: 4800, settleMs: 20000, workSteps: 6, gateMinCacheRead: 131040, gateMaxWrite1h: 5000,
    parkOutputRange: [800, 3000], bigContextRewriteWrite1h: 100000, resumeDelayFlagMs: 120000,
  },
  policy: { pairs: 3, workSteps: 8, warmPings: 4, warmSpacingMs: 60000, warmToleranceMs: 30000, warmMinCacheRead: 140000, warmMissStop: 2 },
})

// TTL timing table (mm:ss -> ms). Run 2 (C, D) is interleaved +5 min.
const TTL_TABLE = Object.freeze([
  { at: 0, prefix: "A", role: "write" }, { at: 30000, prefix: "B", role: "write" },
  { at: 300000, prefix: "C", role: "write" }, { at: 330000, prefix: "D", role: "write" },
  { at: 3300000, prefix: "A", role: "ping" }, { at: 3600000, prefix: "C", role: "ping" },
  { at: 6600000, prefix: "A", role: "check" }, { at: 6630000, prefix: "B", role: "check" },
  { at: 6900000, prefix: "C", role: "check" }, { at: 6930000, prefix: "D", role: "check" },
])
const TTL_PREFIX = { A: { arm: "treatment", run: 1 }, B: { arm: "control", run: 1 }, C: { arm: "treatment", run: 2 }, D: { arm: "control", run: 2 } }
const TTL_KIND = { write: "write", ping: "probe", check: "check" }

// Anomalies the machine may attach that end an experiment on the spot.
const FATAL_ANOMALIES = ["refusal", "model_mismatch", "status_not_allowed", "http_error", "unexpected_request_count"]

// ------------------------------------------------------------------- helpers

const verdict = (status, reason) => ({ status, reason })
const VALID = verdict("valid", null)
const ephemeral = () => ({ id: null, mode: "ephemeral" })
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)
const toMs = (v) => (typeof v === "number" ? num(v) : typeof v === "string" ? num(Date.parse(v)) : null)
const textOf = (record) => (typeof record?.text === "string" ? record.text : null)
const isDialHit = (u) => u.cacheRead >= RULES.dial.minCacheRead && u.cacheWrite1h < RULES.dial.maxWrite1h
const normalizePhase = (p) => (Array.isArray(p) && p.length === 2 && num(p[0]) !== null && num(p[1]) !== null && p[0] >= 0 && p[0] <= p[1] && p[1] <= 1 ? [p[0], p[1]] : null)
const afterTick = (phase) => phase !== null && phase[1] <= RULES.rho + 1e-12

// Raw usage -> the five billable fields; an absent counter is null, never 0.
function usageOf(record) {
  const u = record?.usage
  if (!u || typeof u !== "object") return null
  const split = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null
  const zeroWrite = num(u.cache_creation_input_tokens) === 0
  return {
    uncachedInput: num(u.input_tokens),
    cacheWrite5m: split ? num(split.ephemeral_5m_input_tokens) : zeroWrite ? 0 : null,
    cacheWrite1h: split ? num(split.ephemeral_1h_input_tokens) : zeroWrite ? 0 : null,
    cacheRead: num(u.cache_read_input_tokens),
    billedModelOutput: num(u.output_tokens),
  }
}

function ticksOf(res) {
  const t = res?.ticks?.[METER]
  return Number.isInteger(t) && t >= 0 ? t : null
}

const USAGE_FIELDS = ["uncachedInput", "cacheWrite5m", "cacheWrite1h", "cacheRead", "billedModelOutput"]
function sumUsage(steps) {
  const t = { requests: 0, uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, billedModelOutput: 0, unknownFields: [] }
  for (const s of steps) {
    t.requests += 1
    for (const f of USAGE_FIELDS) {
      const v = s.usage?.[f] ?? null
      if (v === null) { if (!t.unknownFields.includes(f)) t.unknownFields.push(f); continue }
      t[f] += v
    }
  }
  return t
}
function sumsByArmPhase(steps) {
  const out = {}
  for (const s of steps) {
    out[s.arm] ??= {}
    out[s.arm][s.phase] ??= []
    out[s.arm][s.phase].push(s)
  }
  for (const arm of Object.keys(out)) for (const phase of Object.keys(out[arm])) out[arm][phase] = sumUsage(out[arm][phase])
  return out
}
const resumeDelay = (first, last) => {
  const a = toMs(first?.ts_req)
  const b = toMs(last?.ts)
  return a === null || b === null ? null : b - a
}

// Per-invocation bookkeeping: ids, the offset clock, the step log and result acceptance.
function newSession(ctx, experiment) {
  const model = ctx?.approval?.target?.modelId ?? RULES.model
  const steps = []
  const anomalies = []
  let index = 0
  let base = 0
  let blockStart = null
  const s = {
    steps,
    anomalies,
    now() { const t = num(ctx.now()); return t !== null && t > 0 ? t : 0 },
    setIndexBase(n) { base = n; index = 0 },
    markBlockStart(ms) { blockStart = ms },
    request({ arm, kind, phase, role, unit, at, tolerance = RULES.untimedToleranceMs, prompt, session, expect, dominantField, ...extra }) {
      const idx = base + index++
      const req = {
        id: `${experiment}/${arm}/${idx}`, experiment, arm, index: idx, kind, phase, role, unit,
        scopeId: `${experiment}/${unit.kind}-${unit.index}`, atOffsetMs: Math.max(0, Math.round(at)), toleranceMs: tolerance,
        prompt, session, expect, dominantField, ...extra,
      }
      if (blockStart !== null) { req.resetMarginMs = blockStart; blockStart = null }
      return req
    },
    dial({ unit, arm, role, n }) {
      return s.request({ arm, kind: "dial", phase: "observe", role, n, unit, at: s.now() + (steps.length === 0 ? 0 : RULES.dialSpacingMs), prompt: ctx.dialPrefix.prompt, ...(ctx.dialPrefix.systemPrompt ? { systemPrompt: ctx.dialPrefix.systemPrompt } : {}), session: ephemeral(), expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead" })
    },
    ping({ unit, arm, role, n, at, tolerance }) {
      return s.request({ arm, kind: "ping", phase: "observe", role, n, unit, at, tolerance, prompt: promptOf(NULLP), session: ephemeral(), expect: { ttlLane: "any" }, dominantField: "cacheRead" })
    },
    // Records the step, then applies the global validity rules. Returns { fatal } or { u, record, ticks }.
    accept(step, res, { need = [], ticks: needTicks = false, gauge = false } = {}) {
      const record = res && typeof res === "object" && res.record && typeof res.record === "object" ? res.record : null
      const list = Array.isArray(res?.anomalies) ? res.anomalies.filter((a) => typeof a === "string") : []
      const u = usageOf(record)
      const t = ticksOf(res)
      const entry = { id: step.id, arm: step.arm, phase: step.phase, kind: step.kind, role: step.role, unit: step.unit, index: step.index, usage: u, ticks: t, tsReq: toMs(record?.ts_req), ts: toMs(record?.ts), late: res?.late === true, anomalies: list }
      if (step.n !== undefined) entry.n = step.n
      if (step.k !== undefined) entry.k = step.k
      if (step.prefix !== undefined) entry.prefix = step.prefix
      steps.push(entry)
      anomalies.push(...list)
      if (res?.late === true) return { fatal: verdict("void", "late_step") }
      if (!record) return { fatal: verdict("void", "missing_record") }
      if (record.stop_reason === "refusal") return { fatal: verdict("aborted", "refusal") }
      if (typeof record.model === "string" && record.model !== model) return { fatal: verdict("aborted", "model_mismatch") }
      const status = record.headers?.["anthropic-ratelimit-unified-status"]
      if (typeof status === "string" && status !== "allowed") return { fatal: verdict("aborted", "status_not_allowed") }
      const fatalAnomaly = list.find((a) => FATAL_ANOMALIES.includes(a))
      if (fatalAnomaly) return { fatal: verdict("aborted", fatalAnomaly) }
      if (gauge && list.includes("reset_changed")) return { fatal: verdict("void", "reset_in_block") }
      if (!u || need.some((f) => u[f] === null)) return { fatal: verdict("void", "missing_usage") }
      if (needTicks && t === null) return { fatal: verdict("void", "missing_ticks") }
      return { u, record, ticks: t ?? 0 }
    },
    finish(out, v, unit) {
      if (unit && unit.status === "pending") { unit.status = v.status; unit.reason = v.reason }
      return { experiment, status: v.status, reason: v.reason, ...out, steps, anomalies, paidRequests: steps.length }
    },
  }
  return s
}

// DIAL walk at 6 s spacing until a tick or `max` reads. `phiHat` is the known cost since the
// last tick when the phase is chained (null when unknown); a tick at phiHat < 0.9 is early.
async function* dialWalk(s, { unit, arm, role, max, phiHat }) {
  let reads = 0
  for (let n = 1; n <= max; n++) {
    const step = s.dial({ unit, arm, role, n })
    const c = s.accept(step, yield step, { need: ["cacheRead", "cacheWrite1h"], ticks: true, gauge: true })
    if (c.fatal) return { reads, ticked: false, early: null, fatal: c.fatal }
    reads = n
    if (!isDialHit(c.u)) return { reads, ticked: false, early: null, fatal: verdict("aborted", "dial_miss") }
    if (phiHat !== null) phiHat += RULES.rho
    if (c.ticks > 0) {
      const early = phiHat === null ? null : phiHat < RULES.fable.earlyThreshold
      return { reads, ticked: true, early, fatal: early ? verdict("void", "early_tick") : null }
    }
  }
  return { reads, ticked: false, early: null, fatal: null }
}

// Pre-walk of a gauge block: establishes phi from a known phase or by walking to a tick.
async function* preWalk(s, { unit, arm, max, phase, block }) {
  if (afterTick(phase)) return { phase, fatal: null }
  const walk = yield* dialWalk(s, { unit, arm, role: "pre_walk", max, phiHat: phase ? phase[1] : null })
  block.preWalk = { reads: walk.reads, ticked: walk.ticked, early: walk.early }
  if (walk.fatal) return { phase, fatal: walk.fatal }
  if (walk.ticked) { block.phiSource = "pre_walk_tick"; return { phase: [0, RULES.rho], fatal: null } }
  block.phiSource = "pre_walk_exhausted"
  return { phase: [Math.min(1, (phase ? phase[0] : 0) + walk.reads * RULES.rho), 1], fatal: null }
}

// ----------------------------------------------------- 1. fable-write-tick

async function* fableWriteTick(ctx) {
  const experiment = "fable-write-tick"
  const arm = "fable-write-1h"
  const s = newSession(ctx, experiment)
  const out = { blocks: [], skippedArms: { "fable-write-5m": "adapter_capability" }, phaseAtEnd: null }
  if (!ctx.dialPrefix?.prompt) return s.finish(out, verdict("aborted", "no_dial_prefix"))
  let phase = normalizePhase(ctx.phase)
  let chained = phase !== null
  for (let b = 1; b <= RULES.fable.blocks; b++) {
    const unit = { kind: "block", index: b }
    const block = { block: b, chained, phi: null, phiSource: chained ? (b === 1 ? "chained_from_ctx" : `chained_from_block_${b - 1}`) : null, preWalk: { reads: 0, ticked: false, early: null }, write: null, hold: { pings: 0, delayedTicks: 0, tickedOn: [] }, postWalk: { reads: 0, ticked: false }, n: null, m: null, flags: [], status: "pending", reason: null }
    out.blocks.push(block)
    s.markBlockStart(RULES.fable.resetMarginMs)
    const pre = yield* preWalk(s, { unit, arm, max: RULES.fable.preWalkMax, phase, block })
    if (pre.fatal) return s.finish(out, pre.fatal, block)
    phase = pre.phase
    block.phi = phase
    // Write: WRITE-2400, fresh ephemeral session, new seed.
    const seed = ctx.random.seed()
    const write = s.request({ arm, kind: "write", phase: "observe", role: "write", unit, at: s.now() + RULES.spacingMs, prompt: fillerPrompt(seed, RULES.fable.writeLines), session: ephemeral(), expect: { ttlLane: "1h", hit: false }, dominantField: "cacheWrite1h", seed })
    const w = s.accept(write, yield write, { need: ["cacheWrite1h"], ticks: true, gauge: true })
    if (w.fatal) return s.finish(out, w.fatal, block)
    block.write = { id: write.id, seed, cacheWrite1h: w.u.cacheWrite1h, ticks: w.ticks }
    if (w.u.cacheWrite1h < 0.9 * RULES.fable.writeLines * FILLER_TOKENS_PER_LINE) block.flags.push("write_short")
    // Hold: 7 PINGs at fixed offsets after the write completes; any tick is a delayed tick.
    const base = s.now()
    for (let n = 1; n <= RULES.fable.holdOffsetsMs.length; n++) {
      const ping = s.ping({ unit, arm, role: "hold", n, at: base + RULES.fable.holdOffsetsMs[n - 1], tolerance: RULES.fable.holdToleranceMs })
      const c = s.accept(ping, yield ping, { ticks: true, gauge: true })
      if (c.fatal) return s.finish(out, c.fatal, block)
      block.hold.pings = n
      if (c.ticks > 0) { block.hold.delayedTicks += c.ticks; block.hold.tickedOn.push(n) }
    }
    block.n = block.write.ticks + block.hold.delayedTicks
    // Post-walk: DIAL reads until the next tick; m = index of the read that ticked.
    const post = yield* dialWalk(s, { unit, arm, role: "post_walk", max: RULES.fable.postWalkMax, phiHat: null })
    block.postWalk = { reads: post.reads, ticked: post.ticked }
    if (post.fatal) return s.finish(out, post.fatal, block)
    if (!post.ticked || post.reads > RULES.fable.postWalkAnomalyAbove) {
      if (post.ticked) block.m = post.reads
      return s.finish(out, verdict("aborted", "post_walk_overrun"), block)
    }
    block.m = post.reads
    block.status = "valid"
    phase = [0, RULES.rho]
    chained = true
    out.phaseAtEnd = phase
  }
  return s.finish(out, VALID)
}

// --------------------------------------------------------- 2. output-quota

// Per block: arm, prompt size n (outp(n)), output target and gate. The 6000-token gate floor is
// stated for the 8K shape and scales with the block's output target. Block 3 is optional.
export const OUTPUT_BLOCKS = Object.freeze([1, 2, 3].map((block) => {
  const optional = block === RULES.output.optionalBlock
  const { n, outputTarget: target } = optional ? RULES.output.block3 : RULES.output
  const gateMinOutput = Math.round(RULES.output.gateMinOutput * target / RULES.output.outputTarget)
  return Object.freeze({ block, arm: optional ? "out-4k" : "out-8k", n, target, gateMinOutput, optional })
}))

async function* outputQuota(ctx) {
  const experiment = "output-quota"
  const s = newSession(ctx, experiment)
  const out = { blocks: [], block3: null, phaseAtEnd: null }
  const cap = num(ctx.approval?.plans?.[experiment]?.limits?.maxTotalExperimentalSpend?.value)
  const priorSpend = num(ctx.approval?.priorSpend?.perPlanUpperEq?.[experiment]) ?? 0
  let phase = normalizePhase(ctx.phase)
  let chainSource = phase ? "chained_from_ctx" : null
  let ticksSpent = 0
  for (let b = 1; b <= RULES.output.optionalBlock; b++) {
    if (b === RULES.output.optionalBlock) {
      // Block 3 (1..1700) only if the remaining plan budget covers it; prior and current spend include 0.01 quantization slack.
      const remaining = cap === null ? null : cap - priorSpend - (ticksSpent + 1) * 0.01
      if (remaining === null || remaining < RULES.output.block3MinRemaining - 1e-12) { out.block3 = "skipped:budget"; break }
      out.block3 = "run"
    }
    const level = { ...OUTPUT_BLOCKS[b - 1], prompt: promptOf(outp(OUTPUT_BLOCKS[b - 1].n)) }
    const unit = { kind: "block", index: b }
    // Block 1 walks unless a phase right after a tick was handed in; later blocks chain from
    // the previous block's last tick, whose bound is that request's (analyzer-derived) cost.
    const block = { block: b, arm: level.arm, outputTokensTarget: level.target, chained: chainSource !== null, phi: null, phiSource: chainSource, preWalk: { reads: 0, ticked: false, early: null }, N: 0, ticks: 0, tickedOn: [], outputs: [], cumulativeOut: [0], validShare: null, hold: { pings: 0, delayedTicks: 0, tickedOn: [] }, flags: [], status: "pending", reason: null }
    out.blocks.push(block)
    s.markBlockStart(RULES.output.resetMarginMs)
    if (b === 1) {
      if (!afterTick(phase)) {
        if (!ctx.dialPrefix?.prompt) return s.finish(out, verdict("aborted", "no_dial_prefix"), block)
        const pre = yield* preWalk(s, { unit, arm: level.arm, max: RULES.output.preWalkMax, phase, block })
        if (pre.fatal) return s.finish(out, pre.fatal, block)
        phase = pre.phase
        if (block.preWalk.ticked) ticksSpent += 1
      }
      block.phi = phase
    }
    // Gate (N = 1) then the OUT loop at 3 s spacing until 2 ticks or N = 64.
    const minOutput = level.gateMinOutput
    let valid = 0
    while (block.N < RULES.output.loopMax && block.ticks < RULES.output.targetTicks) {
      const n = block.N + 1
      const step = s.request({ arm: level.arm, kind: "work", phase: "observe", role: n === 1 ? "gate" : "loop", n, unit, at: s.now() + RULES.spacingMs, prompt: level.prompt, session: ephemeral(), expect: { ttlLane: "any", outputTokensTarget: level.target }, dominantField: "billedModelOutput" })
      const c = s.accept(step, yield step, { need: ["billedModelOutput"], ticks: true, gauge: true })
      if (c.fatal) return s.finish(out, c.fatal, block)
      const ok = c.u.billedModelOutput >= minOutput && c.record.stop_reason === "end_turn"
      if (n === 1 && !ok) return s.finish(out, verdict("aborted", "short_output"), block)
      block.N = n
      block.outputs.push(c.u.billedModelOutput)
      block.cumulativeOut.push(block.cumulativeOut[n - 1] + c.u.billedModelOutput)
      if (ok) valid += 1
      if (c.ticks > 0) { block.ticks += c.ticks; block.tickedOn.push(n) }
    }
    ticksSpent += block.ticks
    block.validShare = valid / block.N
    if (block.validShare < RULES.output.validOutputShare) block.flags.push("invalid_output_share")
    // Hold: 4 PINGs over 3 min for delayed ticks.
    const base = s.now() + RULES.spacingMs
    for (let n = 1; n <= RULES.output.holdPings; n++) {
      const ping = s.ping({ unit, arm: level.arm, role: "hold", n, at: base + (n - 1) * RULES.output.holdSpacingMs, tolerance: RULES.output.holdToleranceMs })
      const c = s.accept(ping, yield ping, { ticks: true, gauge: true })
      if (c.fatal) return s.finish(out, c.fatal, block)
      block.hold.pings = n
      if (c.ticks > 0) { block.hold.delayedTicks += c.ticks; block.hold.tickedOn.push(n) }
    }
    ticksSpent += block.hold.delayedTicks
    if (block.hold.delayedTicks > 0) block.flags.push("delayed_tick_in_hold")
    if (block.ticks < RULES.output.targetTicks) {
      block.status = "upper_bound"
      block.reason = "no_second_tick_within_64"
      return s.finish(out, verdict("upper_bound", "no_second_tick_within_64"))
    }
    block.status = "identified"
    chainSource = block.hold.delayedTicks > 0 ? `chained_from_block_${b}_hold` : `chained_from_block_${b}`
  }
  return s.finish(out, VALID)
}

// ---------------------------------------------- 3. ttl-1h-unique-prefix

const classifyPing = (u) => (u.cacheRead >= RULES.ttl.pingMinCacheRead && u.cacheWrite1h < RULES.ttl.pingMaxWrite1h ? "HIT" : "MISS")
const classifyCheck = (u) => {
  if (u.cacheRead >= RULES.ttl.checkHitMinCacheRead && u.cacheWrite1h <= RULES.ttl.checkHitMaxWrite1h) return "HIT"
  if (u.cacheWrite1h >= RULES.ttl.checkMissMinWrite1h) return "MISS"
  return "PARTIAL"
}
const ttlOutcome = ({ treatment, control }) => {
  if (treatment === "PARTIAL" || control === "PARTIAL" || !treatment || !control) return "uncertain"
  if (control === "HIT") return "no_contrast"
  return treatment === "HIT" ? "renews" : "no_renewal"
}

async function* ttlUniquePrefix(ctx) {
  const experiment = "ttl-1h-unique-prefix"
  const s = newSession(ctx, experiment)
  const prompts = {}
  for (const p of ["A", "B", "C", "D"]) prompts[p] = fillerPrompt(ctx.random.seed(), RULES.ttl.lines)
  const runs = [1, 2].map((run) => ({ run, status: "pending", reason: null, prefixes: run === 1 ? { treatment: "A", control: "B" } : { treatment: "C", control: "D" }, writes: {}, ping: null, checks: { treatment: null, control: null }, outcome: null }))
  const invalidate = (r, reason) => { r.status = "invalid"; r.reason = reason }
  for (const row of TTL_TABLE) {
    const { arm, run } = TTL_PREFIX[row.prefix]
    const r = runs[run - 1]
    if (r.status === "invalid") continue
    const step = s.request({ arm, kind: TTL_KIND[row.role], phase: "observe", role: row.role, unit: { kind: "run", index: run }, at: row.at, tolerance: RULES.ttl.toleranceMs, prompt: prompts[row.prefix], session: ephemeral(), expect: { ttlLane: "1h", hit: row.role !== "write" }, dominantField: row.role === "write" ? "cacheWrite1h" : "cacheRead", prefix: row.prefix, run })
    const c = s.accept(step, yield step, { need: ["cacheRead", "cacheWrite1h", "cacheWrite5m"] })
    if (c.fatal) return s.finish({ runs }, c.fatal)
    if (row.role === "write") {
      r.writes[arm] = { id: step.id, cacheWrite1h: c.u.cacheWrite1h, cacheWrite5m: c.u.cacheWrite5m }
      if (!(c.u.cacheWrite1h >= RULES.ttl.writeMinWrite1h && c.u.cacheWrite5m === 0)) invalidate(r, "write_invalid")
    } else if (row.role === "ping") {
      r.ping = classifyPing(c.u)
      if (r.ping !== "HIT") invalidate(r, "ping_miss")
    } else {
      r.checks[arm] = classifyCheck(c.u)
    }
  }
  for (const r of runs) if (r.status === "pending") { r.status = "valid"; r.outcome = ttlOutcome(r.checks) }
  return s.finish({ runs }, runs.some((r) => r.status === "valid") ? VALID : verdict("void", "all_runs_invalid"))
}

// ------------------------------------------ 4/5 shared: gate, park, raw

// Amendment 2026-09-27 (todo 21b; task-20 capture, form f2r): the big context P (brief + log,
// without the NULLP suffix) is sent as a system prompt FILE. ctx_create creates the parent session
// with it and stdin NULLP; every later big-context request resumes that session with the same file,
// so tools + system (which ends with P and carries the 1h breakpoint) stay byte-identical. The
// earlier forms - P in the user message under --resume, and rf-emulation - are known misses.
export const BIG_CONTEXT_MODE = "resume-sysfile"
const CTX_SUFFIX = "\n\n" + NULLP

/** contextFileOf(task) -> { file, sha256, bytes, text }: P's bytes and file name, a pure function of the seed. */
export function contextFileOf(task) {
  const text = task.ctxPrompt.text.slice(0, -CTX_SUFFIX.length)
  return { file: `P-${task.seed}.txt`, sha256: promptOf(text).sha256, bytes: new TextEncoder().encode(text).length, text }
}
// What a request on P carries: the file and its sha (the adapter re-checks both before spawn).
// Only the context write carries the text, which the adapter writes once.
const sysRef = ({ file, sha256, bytes }) => ({ file, sha256, bytes })
// ctx_create's stdin is NULLP, but the call still writes the whole context: it is priced (and
// planned) as the context prompt it replaces.
const ctxCreatePrompt = (task) => ({ ...promptOf(NULLP), tokensEst: task.ctxPrompt.tokensEst, fillerLines: task.ctxPrompt.fillerLines })
/** dialPrefixOf(task, sessionId): the DIAL replays ctx_create's own shape (same file, stdin NULLP) in a fresh session. */
export const dialPrefixOf = (task, sessionId) => ({ prompt: ctxCreatePrompt(task), systemPrompt: sysRef(contextFileOf(task)), sessionId })

// Resume-hit gate on the parent context: sets ctx.mode for experiments 4 and 5.
async function* resumeHitGate(s, ctx, { unit, sessionId, at, systemPrompt }) {
  const step = s.request({ arm: "shared", kind: "probe", phase: "resume_raw", role: "gate", unit, at, prompt: promptOf(NULLP), session: { id: sessionId, mode: "resume" }, systemPrompt, expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead" })
  const c = s.accept(step, yield step, { need: ["cacheRead", "cacheWrite1h"] })
  if (c.fatal) return { fatal: c.fatal }
  const pass = c.u.cacheRead >= RULES.restore.gateMinCacheRead && c.u.cacheWrite1h < RULES.restore.gateMaxWrite1h
  ctx.mode.resumeHit = pass
  return { fatal: null, gate: { id: step.id, pass, cacheRead: c.u.cacheRead, cacheWrite1h: c.u.cacheWrite1h, mode: BIG_CONTEXT_MODE } }
}

// Big-context request builder: --resume on the parent session with P's system prompt file.
const bigContext = (sessionId, systemPrompt) => (p) => {
  const prompt = typeof p === "string" ? promptOf(p) : p
  return { prompt, session: { id: sessionId, mode: "resume" }, systemPrompt, expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead" }
}
// Big-context metadata for --dry-run; argv text comes from the adapter's cliArgs builder.
export const BIG_CONTEXT_FORM = Object.freeze({
  mode: BIG_CONTEXT_MODE,
  file: "<evidence>/<runId>/ctx/P-<seed>.txt",
  gateMiss: "resume_gate_miss",
  laterRoles: Object.freeze({
    "restore-decomposition": Object.freeze(["gate", "park_parent", "resume_raw", "work(raw_path)"]),
    "policy-effect": Object.freeze(["gate", "park_parent", "warm", "resume_raw", "work(current_policy)"]),
  }),
})
// A gate miss is recorded (mode_set resumeHit:false); no fallback form is paid for.
const GATE_MISS = verdict("aborted", "resume_gate_miss")
const KNOWN_MISS = verdict("aborted", "fallback_mode_misses")

const newPath = (arm, task) => ({ arm, state: "pending", completed: false, resumeDelayMs: null, quality: { guardCorrect: false, workCorrect: 0, workTotal: task.workSteps.length, reexplainNeeded: 0, handoffLossy: null } })

// Park path: park_parent on the big context, restore_child R1-R3 on the child, useful_work on the child.
async function* parkPath(s, { unit, arm, big, task, childId, at, flags }) {
  const path = newPath(arm, task)
  const park = s.request({ arm, kind: "work", phase: "park_parent", role: "park_parent", unit, at, ...big(task.parkPrompt), needsText: true })
  let c = s.accept(park, yield park, { need: ["cacheWrite1h", "cacheRead", "billedModelOutput"] })
  if (c.fatal) return { fatal: c.fatal, path }
  if (c.u.cacheWrite1h >= RULES.restore.bigContextRewriteWrite1h) return { fatal: verdict("aborted", "big_context_rewrite"), path }
  const handoff = textOf(c.record)
  if (handoff === null) return { fatal: verdict("void", "missing_result_text"), path }
  const [lo, hi] = RULES.restore.parkOutputRange
  if (c.u.billedModelOutput < lo || c.u.billedModelOutput > hi) flags.push("park_output_out_of_range")
  path.quality.handoffLossy = handoffLossy(handoff, task.guardAnswer)
  if (path.quality.handoffLossy) flags.push("handoff_lossy")
  const r1 = s.request({ arm, kind: "work", phase: "restore_child", role: "r1", unit, at: s.now() + RULES.spacingMs, prompt: task.restorePrompts.R1(handoff), session: { id: childId, mode: "new" }, expect: { ttlLane: "1h", hit: false }, needsText: true, dominantField: "uncachedInput" })
  c = s.accept(r1, yield r1, {})
  if (c.fatal) return { fatal: c.fatal, path }
  const first = c.record
  const r2 = s.request({ arm, kind: "work", phase: "restore_child", role: "r2", unit, at: s.now() + RULES.spacingMs, prompt: task.restorePrompts.R2, session: { id: childId, mode: "resume" }, expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead", needsText: true })
  c = s.accept(r2, yield r2, {})
  if (c.fatal) return { fatal: c.fatal, path }
  if (reexplainNeeded(textOf(c.record))) path.quality.reexplainNeeded += 1
  const guard = s.request({ arm, kind: "work", phase: "restore_child", role: "guard", unit, at: s.now() + RULES.spacingMs, prompt: task.restorePrompts.R3, session: { id: childId, mode: "resume" }, expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead", needsText: true })
  c = s.accept(guard, yield guard, {})
  if (c.fatal) return { fatal: c.fatal, path }
  path.quality.guardCorrect = scoreGuard(textOf(c.record), task.guardAnswer).correct
  path.resumeDelayMs = resumeDelay(first, c.record)
  if (path.resumeDelayMs !== null && path.resumeDelayMs > RULES.restore.resumeDelayFlagMs) flags.push("resume_delay_exceeded")
  for (const w of task.workSteps) {
    const step = s.request({ arm, kind: "work", phase: "useful_work", role: "work", k: w.k, unit, at: s.now() + RULES.spacingMs, prompt: w.prompt, session: { id: childId, mode: "resume" }, expect: { ttlLane: "1h", hit: true }, dominantField: "cacheRead", needsText: true })
    c = s.accept(step, yield step, {})
    if (c.fatal) return { fatal: c.fatal, path }
    if (scoreWork(textOf(c.record), w.truth).correct) path.quality.workCorrect += 1
  }
  path.completed = true
  path.state = "complete"
  return { fatal: null, path }
}

// Raw path: optional warm pings (policy), resume_raw GUARD on the big context, useful_work on it.
async function* rawPath(s, { unit, arm, big, task, at, flags, warm }) {
  const path = newPath(arm, task)
  path.warm = null
  if (warm) {
    path.warm = { hits: 0, misses: 0 }
    for (let n = 1; n <= warm.pings; n++) {
      const step = s.request({ arm, kind: "probe", phase: "warm", role: "warm", n, unit, at: at + (n - 1) * warm.spacingMs, tolerance: warm.toleranceMs, ...big(NULLP) })
      const c = s.accept(step, yield step, { need: ["cacheRead", "cacheWrite1h"] })
      if (c.fatal) return { fatal: c.fatal, path }
      if (c.u.cacheRead >= RULES.policy.warmMinCacheRead) path.warm.hits += 1
      else {
        path.warm.misses += 1
        if (path.warm.misses >= RULES.policy.warmMissStop) { path.state = "warm_miss"; return { fatal: null, path } }
      }
    }
    at = s.now() + RULES.spacingMs
  }
  const raw = s.request({ arm, kind: "work", phase: "resume_raw", role: "resume_raw", unit, at, ...big(task.guardPromptRaw), needsText: true })
  let c = s.accept(raw, yield raw, { need: ["cacheWrite1h", "cacheRead"] })
  if (c.fatal) return { fatal: c.fatal, path }
  if (c.u.cacheWrite1h >= RULES.restore.bigContextRewriteWrite1h) return { fatal: verdict("aborted", "big_context_rewrite"), path }
  path.quality.guardCorrect = scoreGuard(textOf(c.record), task.guardAnswer).correct
  path.resumeDelayMs = resumeDelay(c.record, c.record)
  if (path.resumeDelayMs !== null && path.resumeDelayMs > RULES.restore.resumeDelayFlagMs) flags.push("resume_delay_exceeded")
  for (const w of task.workSteps) {
    const step = s.request({ arm, kind: "work", phase: "useful_work", role: "work", k: w.k, unit, at: s.now() + RULES.spacingMs, ...big(w.prompt), needsText: true })
    c = s.accept(step, yield step, { need: ["cacheWrite1h"] })
    if (c.fatal) return { fatal: c.fatal, path }
    if (c.u.cacheWrite1h >= RULES.restore.bigContextRewriteWrite1h) return { fatal: verdict("aborted", "big_context_rewrite"), path }
    if (scoreWork(textOf(c.record), w.truth).correct) path.quality.workCorrect += 1
  }
  path.completed = true
  path.state = "complete"
  return { fatal: null, path }
}

function contextCreate(s, { unit, task, seed, sessionId, context }) {
  return s.request({ arm: "shared", kind: "write", phase: "ctx_create", role: "ctx_create", unit, at: s.now() + (s.steps.length === 0 ? 0 : RULES.spacingMs), prompt: ctxCreatePrompt(task), session: { id: sessionId, mode: "new" }, systemPrompt: context, expect: { ttlLane: "1h", hit: false }, dominantField: "cacheWrite1h", seed })
}
function endPing(s, { unit }) {
  return s.ping({ unit, arm: "shared", role: "end_ping", at: s.now() + RULES.spacingMs })
}

// ------------------------------------------------ 4. restore-decomposition

async function* restoreDecomposition(ctx) {
  const experiment = "restore-decomposition"
  const s = newSession(ctx, experiment)
  const run = Number.isInteger(ctx.run) && ctx.run > 0 ? ctx.run : 1
  s.setIndexBase((run - 1) * 100)
  const unit = { kind: "run", index: run }
  const seed = ctx.random.seed()
  const task = makeTask(seed, { steps: RULES.restore.workSteps })
  const parentId = ctx.random.uuid()
  const childId = ctx.random.uuid()
  const out = { run, mode: BIG_CONTEXT_MODE, gate: null, task: { seed, ticket: task.ticket, guardAnswer: task.guardAnswer }, sessions: { parent: parentId, child: childId }, sums: {}, paths: { park: null, raw: null }, flags: [], dialPrefix: null }
  if (ctx.mode.resumeHit === false) return s.finish(out, KNOWN_MISS)
  const context = contextFileOf(task)
  const create = contextCreate(s, { unit, task, seed, sessionId: parentId, context })
  let c = s.accept(create, yield create, { need: ["cacheWrite1h"] })
  if (c.fatal) return s.finish(out, c.fatal)
  const sys = sysRef(context)
  if (run === 1) out.dialPrefix = dialPrefixOf(task, parentId)
  let next = s.now() + RULES.restore.settleMs
  if (ctx.mode.resumeHit === null) {
    const g = yield* resumeHitGate(s, ctx, { unit, sessionId: parentId, at: next, systemPrompt: sys })
    if (g.fatal) return s.finish(out, g.fatal)
    out.gate = g.gate
    if (!g.gate.pass) return s.finish(out, GATE_MISS)
    next = s.now() + RULES.spacingMs
  }
  const big = bigContext(parentId, sys)
  const park = yield* parkPath(s, { unit, arm: "park_path", big, task, childId, at: next, flags: out.flags })
  out.paths.park = park.path
  if (park.fatal) return s.finish(out, park.fatal)
  const raw = yield* rawPath(s, { unit, arm: "raw_path", big, task, at: s.now() + RULES.spacingMs, flags: out.flags, warm: null })
  out.paths.raw = raw.path
  if (raw.fatal) return s.finish(out, raw.fatal)
  out.flags.push("raw_context_includes_park_turn")
  const ping = endPing(s, { unit })
  c = s.accept(ping, yield ping, {})
  if (c.fatal) return s.finish(out, c.fatal)
  out.sums = sumsByArmPhase(s.steps)
  return s.finish(out, VALID)
}

// ------------------------------------------------------ 5. policy-effect

async function* policyEffect(ctx) {
  const experiment = "policy-effect"
  const s = newSession(ctx, experiment)
  const out = { mode: BIG_CONTEXT_MODE, gate: null, pairs: [] }
  if (ctx.mode.resumeHit === false) return s.finish(out, KNOWN_MISS)
  for (let i = 1; i <= RULES.policy.pairs; i++) {
    const unit = { kind: "pair", index: i }
    const seed = ctx.random.seed()
    const task = makeTask(seed, { steps: RULES.policy.workSteps })
    const parentId = ctx.random.uuid()
    const childId = ctx.random.uuid()
    const pair = { pair: i, seed, ticket: task.ticket, guardAnswer: task.guardAnswer, sessions: { parent: parentId, child: childId }, shared: null, arms: { shadow_candidate_policy: null, current_policy: null }, flags: [] }
    out.pairs.push(pair)
    const armSummary = (path) => ({ ...path, totals: sumUsage(s.steps.filter((x) => x.unit.index === i && x.arm === path.arm)) })
    const context = contextFileOf(task)
    const sys = sysRef(context)
    const create = contextCreate(s, { unit, task, seed, sessionId: parentId, context })
    let c = s.accept(create, yield create, { need: ["cacheWrite1h"] })
    if (c.fatal) return s.finish(out, c.fatal)
    let next = s.now() + RULES.restore.settleMs
    if (ctx.mode.resumeHit === null) {
      const g = yield* resumeHitGate(s, ctx, { unit, sessionId: parentId, at: next, systemPrompt: sys })
      if (g.fatal) return s.finish(out, g.fatal)
      out.gate = g.gate
      if (!g.gate.pass) return s.finish(out, GATE_MISS)
      next = s.now() + RULES.spacingMs
    }
    const big = bigContext(parentId, sys)
    // Candidate arm first, then the current policy on the same context.
    const cand = yield* parkPath(s, { unit, arm: "shadow_candidate_policy", big, task, childId, at: next, flags: pair.flags })
    pair.arms.shadow_candidate_policy = armSummary(cand.path)
    if (cand.fatal) return s.finish(out, cand.fatal)
    const cur = yield* rawPath(s, { unit, arm: "current_policy", big, task, at: s.now() + RULES.spacingMs, flags: pair.flags, warm: { pings: RULES.policy.warmPings, spacingMs: RULES.policy.warmSpacingMs, toleranceMs: RULES.policy.warmToleranceMs } })
    pair.arms.current_policy = armSummary(cur.path)
    if (cur.fatal) return s.finish(out, cur.fatal)
    const ping = endPing(s, { unit })
    c = s.accept(ping, yield ping, {})
    if (c.fatal) return s.finish(out, c.fatal)
    pair.shared = sumsByArmPhase(s.steps.filter((x) => x.unit.index === i && x.arm === "shared")).shared
  }
  return s.finish(out, VALID)
}

export const protocols = Object.freeze({
  "fable-write-tick": fableWriteTick,
  "output-quota": outputQuota,
  "ttl-1h-unique-prefix": ttlUniquePrefix,
  "restore-decomposition": restoreDecomposition,
  "policy-effect": policyEffect,
})

// ------------------------------------------------------------- parity

// Per-arm role counts of Appendix A. `max` bounds every issued call; `expected` is the count a
// complete unit must show. Arms without a required flag are optional per unit (block 3's out-4k).
const one = { max: 1, expected: 1 }
const PARITY = {
  "fable-write-tick": { unit: "block", minUnits: 2, maxUnits: 2, requiredArms: ["fable-write-1h"], arms: { "fable-write-1h": { pre_walk: { max: 35 }, write: one, hold: { max: 7, expected: 7 }, post_walk: { max: 40 } } } },
  "output-quota": { unit: "block", minUnits: 2, maxUnits: 3, requiredArms: null, arms: { "out-8k": { pre_walk: { max: 30 }, gate: one, loop: { max: 63 }, hold: { max: 4, expected: 4 } }, "out-4k": { pre_walk: { max: 30 }, gate: one, loop: { max: 63 }, hold: { max: 4, expected: 4 } } } },
  "ttl-1h-unique-prefix": { unit: "run", minUnits: 2, maxUnits: 2, requiredArms: ["treatment", "control"], arms: { treatment: { write: one, ping: one, check: one }, control: { write: one, check: one } } },
  "restore-decomposition": { unit: "run", minUnits: 1, maxUnits: 2, requiredArms: ["shared", "park_path", "raw_path"], arms: { shared: { ctx_create: one, gate: { max: 1 }, end_ping: one }, park_path: { park_parent: one, r1: one, r2: one, guard: one, work: { max: 6, expected: 6 } }, raw_path: { resume_raw: one, work: { max: 6, expected: 6 } } } },
  "policy-effect": { unit: "pair", minUnits: 3, maxUnits: 3, requiredArms: ["shared", "shadow_candidate_policy", "current_policy"], arms: { shared: { ctx_create: one, gate: { max: 1 }, end_ping: one }, shadow_candidate_policy: { park_parent: one, r1: one, r2: one, guard: one, work: { max: 8, expected: 8 } }, current_policy: { warm: { max: 4, expected: 4 }, resume_raw: one, work: { max: 8, expected: 8 } } } },
}

export function parity(experimentId, paidCallsIssued) {
  const table = PARITY[experimentId]
  if (!table) return { ok: false, complete: false, issues: [{ code: "unknown_experiment", experiment: experimentId }], counts: {} }
  const issues = []
  const counts = {}
  for (const call of Array.isArray(paidCallsIssued) ? paidCallsIssued : []) {
    const unitIndex = call?.unit?.index
    const armTable = table.arms[call?.arm]
    if (!Number.isInteger(unitIndex) || !armTable || !armTable[call.role]) { issues.push({ code: "unexpected_step", id: call?.id ?? null, arm: call?.arm ?? null, role: call?.role ?? null }); continue }
    counts[unitIndex] ??= {}
    counts[unitIndex][call.arm] ??= {}
    counts[unitIndex][call.arm][call.role] = (counts[unitIndex][call.arm][call.role] ?? 0) + 1
  }
  const units = Object.keys(counts).map(Number).sort((a, b) => a - b)
  if (units.length > table.maxUnits || units.some((u) => u > table.maxUnits)) issues.push({ code: "too_many_units", units, max: table.maxUnits })
  let complete = units.length >= table.minUnits
  for (const u of units) {
    for (const [arm, roles] of Object.entries(counts[u])) {
      for (const [role, n] of Object.entries(roles)) {
        if (n > table.arms[arm][role].max) issues.push({ code: "overrun", unit: u, arm, role, count: n, max: table.arms[arm][role].max })
      }
    }
    const armsToCheck = table.requiredArms ?? Object.keys(counts[u])
    for (const arm of armsToCheck) {
      for (const [role, rule] of Object.entries(table.arms[arm])) {
        if (rule.expected !== undefined && (counts[u][arm]?.[role] ?? 0) !== rule.expected) complete = false
      }
    }
  }
  return { ok: issues.length === 0, complete, issues, counts }
}

// ----------------------------------------------------------- schedule

// Static skeleton per experiment for --dry-run; adaptive walks are described by their caps.
export function schedule(experimentId) {
  switch (experimentId) {
    case "fable-write-tick": {
      const f = RULES.fable
      return { experiment: experimentId, unit: "block", maxUnits: f.blocks, timed: false, resetMarginMs: f.resetMarginMs, dialSpacingMs: RULES.dialSpacingMs, preWalkMax: f.preWalkMax, postWalkMax: f.postWalkMax, holdOffsetsMs: [...f.holdOffsetsMs], writeLines: f.writeLines, arms: ["fable-write-1h"], skippedArms: { "fable-write-5m": "adapter_capability" }, paidCallsExpected: 12 + 1 + 7 + 14 + 1 + 7 + 14, paidCallsMax: (f.preWalkMax + 1 + 7 + f.postWalkMax) + (1 + 7 + f.postWalkMax), expectedDurationMs: 75 * MIN }
    }
    case "output-quota": {
      const o = RULES.output
      return { experiment: experimentId, unit: "block", maxUnits: o.optionalBlock, timed: false, resetMarginMs: o.resetMarginMs, preWalkMax: o.preWalkMax, loopMax: o.loopMax, targetTicks: o.targetTicks, spacingMs: RULES.spacingMs, holdPings: o.holdPings, holdSpacingMs: o.holdSpacingMs, gateMinOutput: o.gateMinOutput, blocks: [
        ...OUTPUT_BLOCKS.map(({ block, arm, n, target, optional }) => ({ block, arm, prompt: `outp(${n})`, outputTokensTarget: target, optional, ...(optional ? { minRemainingBudget: o.block3MinRemaining } : {}) })),
      ], paidCallsMax: o.optionalBlock * (o.preWalkMax + o.loopMax + o.holdPings), expectedDurationMs: 95 * MIN }
    }
    case "ttl-1h-unique-prefix":
      return { experiment: experimentId, unit: "run", maxUnits: 2, timed: true, offsets: TTL_TABLE.map((r) => r.at), steps: TTL_TABLE.map((r, index) => ({ index, arm: TTL_PREFIX[r.prefix].arm, run: TTL_PREFIX[r.prefix].run, prefix: r.prefix, role: r.role, kind: TTL_KIND[r.role], atOffsetMs: r.at, toleranceMs: RULES.ttl.toleranceMs })), lines: RULES.ttl.lines, paidCallsPerRun: 5, paidCallsMax: TTL_TABLE.length, expectedDurationMs: TTL_TABLE[TTL_TABLE.length - 1].at + RULES.ttl.toleranceMs }
    case "restore-decomposition": {
      const roles = ["ctx_create", "gate?", "park_parent", "r1", "r2", "guard", ...Array(RULES.restore.workSteps).fill("work"), "resume_raw", ...Array(RULES.restore.workSteps).fill("work"), "end_ping"]
      return { experiment: experimentId, unit: "run", maxUnits: 2, timed: false, settleMs: RULES.restore.settleMs, workSteps: RULES.restore.workSteps, roles, paidCallsPerRun: roles.length, paidCallsMax: 2 * roles.length, expectedDurationMs: 6 * MIN }
    }
    case "policy-effect": {
      const p = RULES.policy
      const perPair = 1 + 1 + 3 + p.workSteps + p.warmPings + 1 + p.workSteps + 1
      return { experiment: experimentId, unit: "pair", maxUnits: p.pairs, timed: false, warmPings: p.warmPings, warmSpacingMs: p.warmSpacingMs, workSteps: p.workSteps, paidCallsPerPair: perPair, paidCallsMax: p.pairs * perPair + 1, expectedDurationMs: 8 * MIN * p.pairs }
    }
    default:
      return null
  }
}
