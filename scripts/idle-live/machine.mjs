// Orchestration state machine for the idle-cost live run (Appendix B of
// .omo/plans/idle-experiments-live-run.md: "Preflight", "Experiment loop", "Checkpoint /
// resume", "Cap enforcement"). Pure orchestration: no network, no spawn, no timer, no clock,
// no file system - every effect goes through `deps`:
//
//   deps.clock      { now(): ms, sleep(ms, signal): Promise }
//   deps.adapter    { capabilities, invoke(step, { stepHeader, baseUrl }, signal) }
//   deps.proxy      { port, drainSince(cursor), readLog?(), close() }
//   deps.ledger     { append, fold, tail, writeRequestRecord, writeCli, readCli, writeSummary }
//   deps.processes  { conflicting(): Promise<row[]> }
//   deps.random     { uuid(), seed() }
//   deps.log(line)  human trace (optional)
//   deps.onEvent(e) every appended event, for tests and live monitoring (optional)
//
// The event log (events.jsonl) is the only checkpoint truth; `fold()` rebuilds the run state
// from it and ignores a torn final line. A step with `step_intent` and no `step_result` is IN
// DOUBT and is NEVER re-invoked: it is reconciled against the proxy log or voided.
import { protocols, schedule, parity, RULES, EXPERIMENT_IDS, makeTask, promptOf, fillerPrompt, NULLP } from "./protocols.mjs"
import { FILLER_TOKENS_PER_LINE } from "./filler.mjs"
import { gate, predictedTicks, cumulative, scopeKey, ticks as ticksBetween, RESOLUTION, PRIOR_RANGE_ONLY } from "./caps.mjs"
import { METERS, metersOf, phaseLedger, DIAL_TICKS, PING_TICKS } from "./gauge.mjs"

export const EXIT = Object.freeze({ OK: 0, PREFLIGHT: 2, ABORTED: 3, IN_DOUBT: 4 })
export const SUMMARY_VERSION = "idle-live-summary/1"
export const REQUEST_VERSION = "idle-live-request/1"
export const RUNSTATE_VERSION = "idle-live-runstate/1"

const METER_5H = "unified-5h"
const PREFLIGHT_ID = "preflight"
// The baseline block is the instrument's zero: the cap gate needs a meter reading before it can
// project anything, so these PINGs are issued outside the gate. Appendix A section 0 budgets
// ~0.002 for them; the machine bounds the block by count (3) and shape (PING) instead.
const BASELINE_PINGS = 3
const BASELINE_SPACING_MS = 60_000
// Appendix A section 0 preflight: a tick inside the three-PING quiet check is foreign traffic ->
// retry after 10 minutes, at most three attempts.
const QUIET_RETRY_MS = 10 * 60_000
const QUIET_ATTEMPTS = 3
const RESET_SETTLE_MS = 120_000 // Appendix A section 1: sleep to reset + 120 s
const SMOKE = Object.freeze({ lines: 2000, writeTokens: 59_400, hitFactor: 0.9, pings: 3, pingSpacingMs: 60_000 })

// Random draws are pre-drawn per experiment and recorded in `experiment_started`, so the analyzer
// can rebuild the exact prompt bytes and session ids a run used from its evidence alone.
const POOL = Object.freeze({
  "fable-write-tick": { seeds: 2, uuids: 0 },
  "output-quota": { seeds: 0, uuids: 0 },
  "ttl-1h-unique-prefix": { seeds: 4, uuids: 0 },
  "restore-decomposition": { seeds: 1, uuids: 2 },
  "policy-effect": { seeds: 3, uuids: 6 },
})

// Appendix A section 6 order with edit E1: exp 4 run 1 first (its context becomes the dial
// prefix), then exp 1, exp 2, exp 5 + exp 4 run 2, and the TTL frame last.
const RUN_ORDER = Object.freeze([
  { experiment: "restore-decomposition", run: 1 },
  { experiment: "fable-write-tick", run: null },
  { experiment: "output-quota", run: null },
  { experiment: "policy-effect", run: null },
  { experiment: "restore-decomposition", run: 2 },
  { experiment: "ttl-1h-unique-prefix", run: null },
])

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const num = (v) => (Number.isFinite(v) ? v : null)
const eq = (x) => Math.round(x * 1e6) / 1e6
const iso = (ms) => new Date(ms).toISOString()
const dateMs = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)
// Reset epochs arrive as unix seconds on some lanes and ms on others; normalise to ms.
const epochMs = (v) => (Number.isFinite(v) ? (v > 1e12 ? v : v * 1000) : null)
const jobKey = (job) => `${job.experiment}${job.run ? `#${job.run}` : ""}`

/** sequence(approval, only?) -> [{ experiment, run, order, key }] in Appendix A section 6 order. */
export function sequence(approval, only = null) {
  const approved = Array.isArray(approval?.order) ? approval.order.filter((id) => EXPERIMENT_IDS.includes(id)) : []
  const allowed = new Set(approved.length ? approved : [])
  const pick = Array.isArray(only) && only.length ? new Set(only) : null
  return RUN_ORDER
    .filter((j) => allowed.has(j.experiment) && (!pick || pick.has(j.experiment)))
    .map((j, i) => ({ ...j, order: i + 1, key: jobKey(j) }))
}

// --------------------------------------------------------------- approval gate

/**
 * approvalIssues(approval, { now, plannerSha256, proposalSha256 }) -> string[]
 * The runner also runs the full `loadApproval()` (which needs the planner and proposal bytes);
 * its issues are merged in through opts.approvalIssues. These checks are the machine's own so
 * the refusal matrix is testable without the file system.
 */
export function approvalIssues(approval, { now, plannerSha256 = null, proposalSha256 = null } = {}) {
  const issues = []
  const add = (i) => { if (!issues.includes(i)) issues.push(i) }
  if (!isObject(approval)) return ["not_an_approval_object"]
  if (approval.status !== "approved") add("not_approved")
  const approvedAt = dateMs(approval.approvedAt)
  if (approvedAt === null) add("missing_approved_at")
  else if (Number.isFinite(now) && approvedAt > now) add("approval_in_future")
  const expiresAt = dateMs(approval.approvalExpiresAt)
  if (expiresAt === null) add("missing_expiry")
  else if (Number.isFinite(now) && expiresAt <= now) add("approval_expired")
  if (approval.target?.modelId !== RULES.model) add("model_mismatch")
  const order = Array.isArray(approval.order) ? approval.order : []
  if (order.length !== EXPERIMENT_IDS.length || new Set(order).size !== order.length || order.some((id) => !EXPERIMENT_IDS.includes(id))) add("order_mismatch")
  if (approval.capSemantics !== "predictive_gate") add("unknown_cap_semantics")
  if (plannerSha256 !== null && approval.plannerSha256 !== plannerSha256) add("planner_sha_drift")
  if (proposalSha256 !== null && approval.proposalSha256 !== proposalSha256) add("proposal_sha_drift")
  for (const id of EXPERIMENT_IDS) {
    const limits = approval.plans?.[id]?.limits
    if (!isObject(limits)) { add("limits_mismatch"); continue }
    if (!Number.isFinite(limits.maxProactiveSpendPerIdle?.value) || !Number.isFinite(limits.maxTotalExperimentalSpend?.value)) add("limits_mismatch")
  }
  if (!isObject(approval.perMeterCumulativeCaps)) add("missing_meter_caps")
  return issues
}

/** skippedArms(approval, capabilities) -> { [experiment]: { [arm]: reason } } */
export function skippedArms(approval, capabilities) {
  const out = {}
  const lanes = new Set(Array.isArray(capabilities?.ttlLanes) ? capabilities.ttlLanes : [])
  // The only lane-bound arm of the plan: fable-write-5m needs a 5m cache write (Appendix B F2).
  if (!lanes.has("5m")) out["fable-write-tick"] = { "fable-write-5m": "adapter_capability" }
  const declared = approval?.skippedArmReasons
  if (isObject(declared)) {
    for (const [experiment, arms] of Object.entries(declared)) {
      if (!isObject(arms)) continue
      out[experiment] = { ...(out[experiment] ?? {}), ...arms }
    }
  }
  return out
}

// The biggest single call of each experiment, used by preflight to prove the predictive gate
// can admit it under the per-idle cap before anything is paid for.
function largestCall(experimentId) {
  const lines = (n) => ({ prompt: { tokensEst: Math.round(n * FILLER_TOKENS_PER_LINE) } })
  switch (experimentId) {
    case "fable-write-tick":
      return { experiment: experimentId, arm: "fable-write-1h", kind: "write", dominantField: "cacheWrite1h", label: `WRITE-${RULES.fable.writeLines}`, ...lines(RULES.fable.writeLines) }
    case "output-quota":
      return { experiment: experimentId, arm: "out-8k", kind: "work", dominantField: "billedModelOutput", label: "OUT-8K", prompt: { tokensEst: 40 }, expect: { outputTokensTarget: RULES.output.outputTarget } }
    case "ttl-1h-unique-prefix":
      return { experiment: experimentId, arm: "treatment", kind: "write", dominantField: "cacheWrite1h", label: `WRITE-${RULES.ttl.lines}`, ...lines(RULES.ttl.lines) }
    default:
      return { experiment: experimentId, arm: "shared", kind: "write", dominantField: "cacheWrite1h", label: `WRITE-${RULES.restore.lines}`, ...lines(RULES.restore.lines) }
  }
}

/**
 * Appendix A section 3 interleaves the TTL frame's two runs on ONE gauge - run 1 issues
 * treatment/0, control/1, treatment/4, treatment/6, control/7 and run 2 the calls between them - so
 * a tick the gauge posts while either run is in flight is charged to whichever run happened to be
 * issuing. A per-RUN cap is therefore not a property of the run: measured on the shipped fakes, two
 * extra ticks landing on run 1 refuse `treatment/6` on `idle:ttl-1h-unique-prefix/run-1` while the
 * FRAME still has 0.02 to spend. The approval's "0.03 per run over 2 runs" is enforced where it IS
 * a property of the work - the frame, one scope, 2 x 0.03 = 0.06. The approval file is unchanged
 * and no total cap moves; this is how the machine reads it (Appendix B proposal in lane-m-b).
 */
const INTERLEAVED_FRAMES = Object.freeze({ "ttl-1h-unique-prefix": 2 })

/** The per-idle cap as ENFORCED: the frame for an interleaved experiment, the approval's own otherwise. */
function perIdleCapOf(approval, experiment) {
  const capEq = num(approval?.plans?.[experiment]?.limits?.maxProactiveSpendPerIdle?.value) ?? 0
  const runs = INTERLEAVED_FRAMES[experiment] ?? 0
  if (!runs) return { capEq, scopeType: approval?.perIdleScope?.[experiment] ?? null }
  return { capEq: eq(capEq * runs), scopeType: "frame" }
}

/** The scope a step's per-idle cap is accounted and gated on. */
const idleScopeOf = (step) => (INTERLEAVED_FRAMES[step?.experiment] ? `${step.experiment}/frame` : scopeKey(step))

/** scheduleTable(approval, jobs, skipped, priors) -> one row per job for --dry-run. */
export function scheduleTable(approval, jobs, skipped = {}, priors = PRIOR_RANGE_ONLY) {
  return jobs.map((job) => {
    const sch = schedule(job.experiment) ?? {}
    const limits = approval?.plans?.[job.experiment]?.limits ?? {}
    const big = largestCall(job.experiment)
    const pred = predictedTicks(big, priors, approval?.unpricedCallMaxTokens)
    const perUnit = sch.paidCallsPerRun ?? sch.paidCallsPerPair ?? null
    const units = job.run ? 1 : (sch.maxUnits ?? 1)
    const perRun = job.run ? perUnit : null
    return {
      order: job.order,
      experiment: job.experiment,
      run: job.run,
      unit: sch.unit ?? "run",
      units,
      timed: sch.timed === true,
      paidCallsExpected: perRun ?? sch.paidCallsExpected ?? (perUnit === null ? (sch.paidCallsMax ?? 0) : perUnit * units),
      paidCallsMax: job.run ? (perRun ?? sch.paidCallsMax ?? 0) : (sch.paidCallsMax ?? 0),
      expectedWallClockMs: job.run ? Math.round((sch.expectedDurationMs ?? 0) / ((sch.maxUnits ?? 1) || 1)) : (sch.expectedDurationMs ?? 0),
      // the cap the machine will ENFORCE, so the dry run cannot advertise one it does not apply
      perIdleCapEq: perIdleCapOf(approval, job.experiment).capEq,
      perIdleScope: perIdleCapOf(approval, job.experiment).scopeType ?? (sch.unit ?? null),
      perPlanCapEq: num(limits.maxTotalExperimentalSpend?.value) ?? 0,
      largestCall: { label: big.label, tokensEst: pred.tokens, predictedTicks: pred.ticks, predictedEq: pred.ticks === "unpredictable" ? Infinity : eq(pred.ticks * RESOLUTION), tier: pred.tier },
      skippedArms: skipped[job.experiment] ?? {},
    }
  })
}

/**
 * The `run.json` manifest of an evidence directory (Appendix B "Evidence directory"). Pure: the
 * caller supplies every value, so the runner and the fixture test produce identical bytes.
 */
export function manifest({ runId, evidenceDir = null, startedAt = null, approvalPath = null, approvalSha256 = null, plannerSha256 = null, proposalSha256 = null, adapter = null, cliVersion = null, model = RULES.model, order = EXPERIMENT_IDS, proxyPort = null, resumedFrom = null } = {}) {
  return {
    v: "idle-live-run/1",
    runId,
    evidenceDir,
    startedAt,
    model,
    order: [...order],
    approval: { path: approvalPath, sha256: approvalSha256, plannerSha256, proposalSha256 },
    adapter: adapter ? { ...adapter } : null,
    cliVersion,
    proxyPort,
    resumedFrom,
  }
}

// ------------------------------------------------------------------- run state

function newState(deps, approval, opts) {
  const st = {
    deps,
    approval,
    opts,
    runId: opts.runId ?? "run",
    evidenceDir: opts.evidenceDir ?? null,
    priors: opts.priors ?? PRIOR_RANGE_ONLY,
    signal: opts.signal ?? null,
    status: "allowed",
    meters: {},            // meter -> { baseline, latest, closedWindows, absent }
    scopes: {},            // scopeId | plan:<id> -> { baseline, latest, closedWindows } on the 5h meter
    experiments: {},       // experiment id -> aggregate for the summary
    jobs: {},              // job key -> { status, reason, paidRequests }
    resetWaits: 0,         // reset waits taken so far: re-baseline PING ids are per wait
    resumeIndex: 0,        // how many times this run has been resumed: preflight PING ids per run
    mode: { resumeHit: null },
    dialPrefix: null,
    carry: { phase: null },
    ledgerPhase: phaseLedger(),
    lastCall: null,
    inDoubt: [],
    paidRequests: 0,
    proxyCursor: 0,
    campaignStop: null,
    abort: null,
    skipped: {},
  }
  return st
}

function emit(st, event) {
  const rec = st.deps.ledger.append({ ts: iso(st.deps.clock.now()), runId: st.runId, ...event })
  st.deps.log?.(`${rec.ts} ${rec.ev}${rec.stepId ? ` ${rec.stepId}` : ""}${rec.experiment && !rec.stepId ? ` ${rec.experiment}` : ""}`)
  st.deps.onEvent?.(rec)
  return rec
}

// ------------------------------------------------------------------- preflight

/**
 * preflight(deps, approval, opts) -> { ok, issues, skippedArms, schedule, jobs, conflicts, adapter }
 * No paid call. Appendix B: approval ok, adapter capabilities cover each arm (else skipped),
 * predicted upper cost of every arm's largest call <= its caps, no other claude.exe, evidence
 * writable. `--dry-run` stops here and prints the schedule.
 */
export async function preflight(deps, approval, opts = {}) {
  const now = deps.clock.now()
  const issues = []
  const add = (i) => { if (!issues.includes(i)) issues.push(i) }
  for (const i of approvalIssues(approval, { now, plannerSha256: opts.plannerSha256 ?? null, proposalSha256: opts.proposalSha256 ?? null })) add(i)
  for (const i of Array.isArray(opts.approvalIssues) ? opts.approvalIssues : []) add(i)

  const capabilities = deps.adapter?.capabilities ?? null
  if (!capabilities) add("adapter_missing")
  else if (isObject(approval) && capabilities.model !== approval.target?.modelId) add("adapter_model_mismatch")
  const skipped = skippedArms(approval, capabilities)

  const only = Array.isArray(opts.only) && opts.only.length ? opts.only : null
  if (only?.some((id) => !EXPERIMENT_IDS.includes(id))) add("unknown_experiment")
  const jobs = sequence(approval, only)
  if (jobs.length === 0) add("nothing_to_run")

  const table = scheduleTable(approval, jobs, skipped, opts.priors ?? PRIOR_RANGE_ONLY)
  for (const row of table) {
    if (!(row.largestCall.predictedEq <= row.perIdleCapEq)) add(`predicted_cost_exceeds_cap:${row.experiment}`)
  }

  let conflicts = []
  try {
    conflicts = (await deps.processes.conflicting()) ?? []
  } catch {
    add("process_scan_failed")
  }
  if (conflicts.length) add("conflicting_process")
  // (ii) THE SCAN SEAM. The process scan is the only await a resumed run reaches before it decides
  // whether to issue anything, so an operator cancel that lands here must be recorded - and it is
  // read BEFORE this function's own `preflight` event, so the marker is the first record the
  // process writes after the cancel. `onCancel` is how the caller records it: preflight holds no
  // run state of its own.
  if (opts.signal?.aborted) opts.onCancel?.()

  const ok = issues.length === 0
  const out = { ok, issues, skippedArms: skipped, schedule: table, jobs, conflicts, adapter: capabilities ? { ...capabilities } : null }
  try {
    emit({ deps, runId: opts.runId ?? "run" }, { ev: "preflight", ok, issues, skippedArms: skipped, adapter: out.adapter, conflicts, schedule: table })
  } catch {
    out.ok = false
    if (!out.issues.includes("evidence_not_writable")) out.issues.push("evidence_not_writable")
  }
  return out
}

// --------------------------------------------------------------------- summary

function meterSummary(st) {
  const out = {}
  const caps = st.approval?.perMeterCumulativeCaps ?? {}
  for (const meter of METERS) {
    const m = st.meters[meter]
    if (!m || m.absent) {
      out[meter] = { windows: 0, cumulativeUpperEq: null, capEq: num(caps[meter]) ?? null, absent: true }
      continue
    }
    const windows = [...m.closedWindows, { baseline: m.baseline, latest: m.latest }]
    const c = cumulative(windows)
    out[meter] = { windows: windows.length, cumulativeUpperEq: c.upperEq, capEq: num(caps[meter]) ?? null }
  }
  return out
}

const TERMINAL = new Set(["valid", "void", "skipped", "upper_bound"])

function summaryOf(st, exitCode, extra = {}) {
  const experiments = {}
  for (const id of EXPERIMENT_IDS) {
    const e = st.experiments[id]
    experiments[id] = e
      ? { status: e.status, reason: e.reason, paidRequests: e.paidRequests, spentObservedEq: e.spentObservedEq, spentUpperEq: e.spentUpperEq, skippedArms: st.skipped[id] ?? {} }
      : { status: "not_run", reason: extra.notRunReason ?? null, paidRequests: 0, spentObservedEq: 0, spentUpperEq: 0, skippedArms: st.skipped[id] ?? {} }
  }
  return {
    v: SUMMARY_VERSION,
    runId: st.runId,
    exitCode,
    experiments,
    meters: meterSummary(st),
    // Appendix B "Resume verdict contract": ONLY exit 4 is resumable. Advertising a resume for
    // an exit-3 stop invites an operator to re-issue calls the stop rule forbade.
    resumable: exitCode === EXIT.IN_DOUBT,
    evidenceDir: st.evidenceDir,
    paidRequestsIssued: st.paidRequests,
    inDoubt: st.inDoubt.slice(),
    ...extra,
  }
}

// ------------------------------------------------------------------------ fold

function parseJsonl(text) {
  const out = []
  const lines = String(text ?? "").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") continue
    try {
      out.push(JSON.parse(line))
    } catch {
      if (i === lines.length - 1) break // torn final line: the remains of a crashed append
      throw new Error(`corrupt event line ${i + 1}`)
    }
  }
  return out
}

/**
 * fold(events) -> RunState. Accepts the parsed events array or raw events.jsonl text; a torn
 * final line is ignored, so fold(text) === fold(text + partialLine). Pure and deterministic:
 * the same log always folds to the same object in the same key order.
 */
export function fold(events) {
  const rows = typeof events === "string" ? parseJsonl(events) : Array.isArray(events) ? events : []
  const st = {
    v: RUNSTATE_VERSION,
    runId: null,
    startedAt: null,
    preflightOk: null,
    experiments: {},
    steps: {},
    stepOwner: {},
    results: [],
    inDoubt: [],
    paidRequests: 0,
    resetWaits: 0,
    campaignStop: null,
    mode: { resumeHit: null },
    dialPrefix: null,
    ended: null,
    lastSeq: -1,
  }
  const keyOf = (id, run) => (run ? `${id}#${run}` : id)
  const expOf = (id, run) => {
    const key = keyOf(id, run)
    st.experiments[key] ??= { experiment: id, run: run ?? null, status: "started", reason: null, t0: null, baselines: null, pool: { seeds: [], uuids: [] }, steps: [], paidRequests: 0 }
    return st.experiments[key]
  }
  // Step events carry the PROTOCOL unit's run (TTL interleaves runs 1 and 2 inside one job), so a
  // step is attributed to the job that started last, never to `e.run`.
  let current = null
  const ownerOf = (e) => (current && current.experiment === e.experiment ? st.experiments[current.key] : expOf(e.experiment, null))
  for (const e of rows) {
    if (!isObject(e)) continue
    if (Number.isFinite(e.seq)) st.lastSeq = e.seq
    if (e.runId && !st.runId) st.runId = e.runId
    switch (e.ev) {
      case "run_started":
        st.startedAt = e.ts ?? null
        break
      case "preflight":
        st.preflightOk = e.ok === true
        break
      case "experiment_started": {
        const x = expOf(e.experiment, e.run)
        current = { experiment: e.experiment, key: keyOf(e.experiment, e.run) }
        x.t0 = e.t0 ?? null
        x.baselines = e.baselines ?? null
        x.pool = { seeds: [...(e.pool?.seeds ?? [])], uuids: [...(e.pool?.uuids ?? [])] }
        x.status = "started"
        break
      }
      case "random_drawn": {
        const x = expOf(e.experiment, e.run)
        if (e.kind === "seed") x.pool.seeds.push(e.value)
        else x.pool.uuids.push(e.value)
        break
      }
      case "mode_set":
        st.mode.resumeHit = e.resumeHit ?? null
        break
      case "dial_prefix":
        st.dialPrefix = { seed: e.seed ?? null, sessionId: e.sessionId ?? null }
        break
      case "step_intent": {
        const x = ownerOf(e)
        st.steps[e.stepId] = { state: "intent", experiment: e.experiment, run: e.run ?? null, role: e.role ?? null, unit: e.unit ?? null, n: e.n ?? null, k: e.k ?? null, prefix: e.prefix ?? null, index: e.index ?? null, intent: e }
        x.steps.push(e.stepId)
        // The owning JOB (experiment[#run]) - a step's own `run` is its protocol unit, which is
        // not the same thing (the TTL frame interleaves runs 1 and 2 inside one job).
        st.stepOwner[e.stepId] = keyOf(x.experiment, x.run)
        break
      }
      case "step_result": {
        const x = ownerOf(e)
        const s = st.steps[e.stepId] ?? { state: "intent", experiment: e.experiment, run: e.run ?? null, intent: null }
        st.steps[e.stepId] = { ...s, state: "result", source: e.source ?? "adapter", event: e }
        st.results.push(e)
        // a response may have produced more than one request row (an extra request, or a
        // multi-row reconciliation); the event carries the true multiplicity
        const n = Number.isInteger(e.accounting?.requestCount) && e.accounting.requestCount > 0 ? e.accounting.requestCount : 1
        x.paidRequests += n
        st.paidRequests += n
        break
      }
      case "step_void":
        st.steps[e.stepId] = { ...(st.steps[e.stepId] ?? {}), state: "void", reason: e.reason ?? null, event: e }
        break
      case "gate_refused":
        st.steps[e.stepId] = { ...(st.steps[e.stepId] ?? {}), state: "gate_refused", reason: e.reasons?.[0]?.code ?? null }
        break
      case "reset_wait": {
        st.resetWaits += 1
        break
      }
      case "campaign_stop":
        st.campaignStop = { meter: e.meter ?? null, reason: e.reason ?? null }
        break
      case "experiment_ended": {
        const x = expOf(e.experiment, e.run)
        x.status = e.status ?? null
        x.reason = e.reason ?? null
        // The experiment's OWN count of the calls it paid for. `paidRequests` above counts every
        // step_result, including the one that ended it; the two differ by exactly that step, and
        // a resumed summary must report the same number the uninterrupted run reported.
        if (Number.isFinite(e.paidRequests)) x.endedPaid = e.paidRequests
        break
      }
      case "run_ended":
        st.ended = { exitCode: e.exitCode ?? null, reason: e.reason ?? null }
        break
      default:
        break
    }
  }
  // Unresolved issuance. A step is uncertain while the log shows it was ISSUED and never
  // answered: either it stopped at `step_intent` (the process died mid-call) or the machine wrote
  // its own `step_void{inDoubt:true}` for it. That checkpoint must not retire the doubt - the
  // response may still appear in proxy.jsonl later - so it stays in doubt across THIS resume and
  // every later one, until a proxy record reconciles it.
  for (const [stepId, s] of Object.entries(st.steps)) {
    if (s.state === "intent" || (s.state === "void" && s.event?.inDoubt === true)) st.inDoubt.push(stepId)
  }
  return st
}

// --------------------------------------------------------- meters and scopes

const windowOf = (reading) => ({ baseline: reading, latest: reading, closedWindows: [] })

// Per-idle and per-plan spend is ATTRIBUTED, not windowed: the machine adds up the gauge ticks
// observed across each of that scope's OWN calls. A window (baseline -> latest) would charge a
// scope for everything else the campaign did meanwhile, and Appendix A interleaves units on
// purpose - the TTL frame runs its two runs together, exp 4's two runs sit either side of exps
// 1, 2 and 5. A delta that cannot be read (the reset epoch moved under the call) counts as one
// tick. Meter caps and campaign stops keep the real cumulative windows: those ARE global.
function attributedScope(st, key) {
  st.scopes[key] ??= { ticks: 0, calls: 0, reset: null }
  return st.scopes[key]
}
function attribute(st, keys, ticks, reset) {
  for (const key of keys) {
    if (!key) continue
    const sc = attributedScope(st, key)
    sc.ticks += Number.isFinite(ticks) ? Math.max(0, ticks) : 1
    sc.calls += 1
    sc.reset = reset ?? sc.reset
  }
}
// caps.mjs reads { baseline, latest, closedWindows }; the attributed sum is handed over as a
// one-window view so spentObservedEq = ticks x 0.01 and spentUpperEq adds the one phase tick.
const scopeView = (sc) => ({ baseline: { util: 0, reset: sc.reset ?? 0 }, latest: { util: eq(sc.ticks * RESOLUTION), reset: sc.reset ?? 0 }, closedWindows: [] })
function scopeViews(st) {
  const out = {}
  for (const [key, sc] of Object.entries(st.scopes)) out[key] = scopeView(sc)
  return out
}

// One reading -> one window update. A reset epoch change CLOSES the window (Appendix B: never
// stitched); inside a window the tick delta is round((u2-u1)/0.01).
function updateWindow(w, reading) {
  if (w.baseline.reset !== reading.reset) {
    w.closedWindows.push({ baseline: w.baseline, latest: w.latest })
    w.baseline = reading
    w.latest = reading
    return { closed: true, ticks: null, decreased: false }
  }
  const t = ticksBetween(w.latest, reading)
  const decreased = reading.util < w.latest.util - 1e-12
  w.latest = reading
  return { closed: false, ticks: t, decreased }
}

const readingOf = (m) => (m && m !== "absent" && Number.isFinite(m.util) && Number.isFinite(m.reset) ? { util: m.util, reset: m.reset, status: m.status ?? null } : null)

/**
 * Applies one response's ratelimit headers to every meter window. A meter the response does not
 * carry is `{ absent: true }` for that step and never counted as 0 (Appendix B); a decrease
 * inside one epoch and an epoch change are both anomalies.
 */
function applyReading(st, headers) {
  const readings = metersOf(headers ?? {})
  const out = { meters: {}, ticks: {}, anomalies: [], status: readings.unifiedStatus ?? null }
  for (const meter of METERS) {
    const reading = readingOf(readings[meter])
    if (!reading) {
      out.meters[meter] = { absent: true }
      out.ticks[meter] = 0
      st.meters[meter] ??= { absent: true }
      continue
    }
    const known = st.meters[meter]
    if (!known || known.absent) {
      st.meters[meter] = windowOf(reading)
      out.meters[meter] = { util: reading.util, reset: reading.reset, ticks: 0, sameWindow: true, baseline: true }
      out.ticks[meter] = 0
      continue
    }
    const u = updateWindow(known, reading)
    out.ticks[meter] = u.ticks ?? 0
    out.meters[meter] = { util: reading.util, reset: reading.reset, ticks: u.ticks ?? 0, sameWindow: !u.closed }
    if (u.closed && !out.anomalies.includes("reset_changed")) out.anomalies.push("reset_changed")
    else if (u.decreased && !out.anomalies.includes("gauge_decreased_same_epoch")) out.anomalies.push("gauge_decreased_same_epoch")
  }
  if (typeof readings.unifiedStatus === "string") st.status = readings.unifiedStatus
  return out
}

/**
 * The clock a resumed run walks on. While there is still a recorded outcome to serve, time is the
 * time the LOG recorded: the machine must not sleep out a wait it already waited, and must not
 * judge a recorded step late because the operator restarted an hour later. The moment the log runs
 * out, both fall back to the real injected clock and the run is live again.
 */
// Appendix B revision 2: a resumed run does not replay the campaign, so there is exactly ONE
// clock - the real one. No decision is ever taken against a recorded timestamp.
const nowOf = (st) => st.deps.clock.now()
const sleepOf = (st, ms) => st.deps.clock.sleep(ms, st.signal)

const spendOf = (sc) => (sc ? { observedEq: eq(sc.ticks * RESOLUTION), upperEq: eq(sc.ticks * RESOLUTION + RESOLUTION) } : { observedEq: 0, upperEq: 0 })

/**
 * The cap gate is fed the PRIOR only - caps.mjs `predictedTicks` tier 2 - and never an in-run
 * observation (its tier 1).
 *
 * A response that reports no tick of its own does NOT prove it cost less than a tick: Appendix A
 * delayed accounting lets the gauge post a call's charge several calls later, so an immediate
 * zero delta is silence, not a measurement. Proving settlement would need the gauge to stay
 * unchanged across the whole posting delay (gauge.mjs `settled(readings, sinceMs, windowMs)`),
 * which the machine cannot establish from its own call pattern - it only reads the gauge when it
 * spends - and a bound learned too early admitted a 141K-token write at one tick where the prior
 * prices it at two. The cheaper prediction is not worth an unsafe admission, so the optimization
 * is declined outright: every call is priced from the approved prior.
 */
function gateState(st) {
  return { status: st.status, inDoubt: st.inDoubt.length > 0, meters: st.meters, scopes: scopeViews(st) }
}

const knownCost = (step) => (step?.kind === "dial" ? DIAL_TICKS : step?.kind === "ping" ? PING_TICKS : null)

const META_OF = (step) => ({
  stepId: step.id,
  experiment: step.experiment,
  run: Number.isInteger(step.run) ? step.run : (step.unit?.kind === "run" || step.unit?.kind === "pair" ? step.unit.index : null),
  arm: step.arm,
  phase: step.phase,
  index: step.index,
  kind: step.kind,
  role: step.role ?? null,
  unit: step.unit ?? null,
  n: step.n ?? null,
  k: step.k ?? null,
  prefix: step.prefix ?? null,
  scopeId: step.scopeId ?? null,
  dominantField: step.dominantField ?? null,
})

// Appendix B's record schema: caps:[{ scope, name, capEq, remainingUpperEq }]. A tripped cap is
// reported through `gate_refused`, so the per-record rows stay at the four schema fields.
const compactCaps = (accounting) => (Array.isArray(accounting?.caps) ? accounting.caps.map((c) => ({ scope: c.scope, name: c.name ?? null, capEq: num(c.capEq), remainingUpperEq: num(c.remainingUpperEq) })) : [])

const emptyResult = (anomalies, late) => ({ record: null, anomalies, ticks: {}, late, meters: {} })

// ------------------------------------------------------------------- one step

/**
 * One paid call: sleep to its offset, refuse it late, gate it, record the intent, invoke, drain
 * the proxy, check the response, record the result. Returns the StepResult the protocol expects,
 * or `{ fatal }` when the machine (not the protocol) ends the experiment here.
 */
async function runStep(st, exp, step, { ungated = false } = {}) {
  const clock = st.deps.clock
  // A reset wait can end the experiment before this step exists as an intent: its re-baseline
  // PING is a paid call, and a global stop rule on it means nothing more may be issued.
  if (Number.isFinite(step.resetMarginMs)) {
    const stopped = await maybeResetWait(st, exp, step)
    if (stopped) return { fatal: { status: stopped.status, reason: stopped.reason }, stop: stopped.stop === true }
  }

  // Every paid call of the run - a preflight PING, a re-baseline PING, an experiment step - is
  // issued through here, so the cancel seams, the gate and the late check cannot be forgotten by
  // one caller. A resumed run issues only what never started (revision 2), on the real clock.
  const target = exp.t0 + step.atOffsetMs
  const waitMs = target - nowOf(st)
  if (waitMs > 0) {
    try {
      await sleepOf(st, waitMs)
    } catch (e) {
      // An operator cancel is a campaign-level stop, and it is recorded BEFORE anything else so a
      // log truncated during the wind-down still says the campaign was stopped on purpose.
      stopCampaign(st, { reason: "cancelled", experiment: step.experiment, stepId: step.id })
      emit(st, { ev: "step_void", ...META_OF(step), reason: "aborted_before_invoke", error: { code: e?.code ?? "aborted", message: String(e?.message ?? e) } })
      return { fatal: { status: "void", reason: "aborted_before_invoke" }, stop: true }
    }
  }
  // A preflight or re-baseline PING is the instrument, not a step of a timed protocol: its
  // offsets are spacing, not a schedule. Voiding it as late would hand the quiet check an empty
  // result, which the block would read as "the gauge did not move" - the one thing the check
  // exists to rule out. It is issued now, on whatever clock this process has.
  const lateBy = step.experiment === PREFLIGHT_ID ? 0 : nowOf(st) - (target + step.toleranceMs)
  if (lateBy > 0) {
    emit(st, { ev: "step_void", ...META_OF(step), reason: "late_step", lateByMs: lateBy, atOffsetMs: step.atOffsetMs, toleranceMs: step.toleranceMs })
    return { result: emptyResult(["late_step"], true) }
  }
  if (st.skipped[step.experiment]?.[step.arm]) {
    emit(st, { ev: "step_void", ...META_OF(step), reason: "skipped_arm" })
    return { fatal: { status: "aborted", reason: "skipped_arm_requested" } }
  }

  // The gate needs both scopes to exist so their (attributed) spend is reported even at zero.
  const idleKey = idleScopeOf(step)
  const planKey = `plan:${step.experiment}`
  if (idleKey) attributedScope(st, idleKey)
  attributedScope(st, planKey)
  let accounting = { caps: [], predictedTicks: null, predictedEq: null, predictionTier: null, warnings: [] }
  if (!ungated) {
    const g = gate({ ...step, scopeId: idleKey }, gateState(st), gateApprovalOf(st), st.priors)
    accounting = g.accounting
    if (!g.ok) {
      emit(st, { ev: "gate_refused", ...META_OF(step), reasons: g.reasons, predictedTicks: accounting.predictedTicks, caps: compactCaps(accounting) })
      // The refusal is in the log now; the predicate decides whether it ended the campaign. A
      // per-idle or per-plan cap trip is not campaign-level - it aborts only this experiment.
      const campaignLevel = syncCampaignStop(st, { experiment: step.experiment, stepId: step.id })
      const first = campaignLevel ? campaignLevel.reason : (g.reasons[0]?.code ?? "gate_refused")
      return { fatal: { status: "aborted", reason: first }, stop: !!campaignLevel }
    }
  } else {
    const pred = predictedTicks(step, st.priors, st.approval?.unpricedCallMaxTokens)
    accounting = { caps: [], predictedTicks: pred.ticks, predictedEq: pred.ticks === "unpredictable" ? null : eq(pred.ticks * RESOLUTION), predictionTier: pred.tier, warnings: [{ code: "ungated_baseline_block" }] }
  }

  // (ii) The issuance seam, outbound. An operator cancel is campaign-level and is recorded BEFORE
  // any other write: no intent, no further experiment. The call it forbids was never spawned - the
  // landed adapter refuses a pre-aborted signal (adapters/claude-cli.mjs) - so nothing is in doubt.
  if (st.signal?.aborted) {
    stopCampaign(st, { reason: "cancelled", experiment: step.experiment, stepId: step.id })
    emit(st, { ev: "step_void", ...META_OF(step), reason: "aborted_before_invoke" })
    return { fatal: { status: "void", reason: "aborted_before_invoke" }, stop: true }
  }

  emit(st, {
    ev: "step_intent", ...META_OF(step), atOffsetMs: step.atOffsetMs, toleranceMs: step.toleranceMs,
    sessionId: step.session?.id ?? null, sessionMode: step.session?.mode ?? null,
    promptSha256: step.prompt.sha256, promptChars: step.prompt.chars, promptTokensEst: step.prompt.tokensEst,
    dominantField: step.dominantField, expect: step.expect ?? null, needsText: step.needsText === true,
    predictedTicks: accounting.predictedTicks, gated: !ungated,
  })

  const cursor = st.proxyCursor
  let res = null
  let invokeError = null
  try {
    res = await st.deps.adapter.invoke(step, { stepHeader: step.id, baseUrl: st.opts.baseUrl ?? null }, st.signal)
  } catch (e) {
    invokeError = { code: e?.code ?? "invoke_threw", message: String(e?.message ?? e) }
  }
  const drained = await st.deps.proxy.drainSince(cursor)
  st.proxyCursor = drained.cursor ?? cursor
  const records = Array.isArray(drained.records) ? drained.records : []
  st.paidRequests += records.length
  const own = records.filter((r) => r?.stepId === step.id || r?.label === step.id)

  // (ii) The same seam, inbound: the cancel may have landed while this call was in flight. The
  // marker goes in before the call's own step_result or step_void, so a log truncated during the
  // wind-down still says the campaign was stopped on purpose. Whether the call reached the API
  // (its row is here) or left no trace (in doubt), no further one is issued.
  const cancelled = st.signal?.aborted === true
  if (cancelled) stopCampaign(st, { reason: "cancelled", experiment: step.experiment, stepId: step.id })

  // In doubt: the call may or may not have reached the API and no proxy record proves it.
  // Appendix B: never re-invoke; the experiment is void and the run is resumable. The adapter
  // reports failure BOTH ways - a thrown spawn error and the structured
  // `{error:{code:"aborted"},stdoutJson:null,exitCode:null}` it resolves after killing the child
  // (adapters/claude-cli.mjs) - and both leave the same uncertainty.
  const adapterFailure = invokeError ?? (isObject(res?.error) ? res.error : null)
  if (adapterFailure && own.length === 0) {
    // The cancel, if any, is already recorded above; this call stays in doubt (exit 4) until
    // proxy.jsonl settles it.
    emit(st, { ev: "step_void", ...META_OF(step), reason: "unknown_issue_state", inDoubt: true, error: adapterFailure })
    st.inDoubt.push(step.id)
    return { fatal: { status: "void", reason: "unknown_issue_state" }, stop: true, inDoubt: true }
  }

  const p = own[0] ?? null
  const usageRaw = p?.usage ?? res?.stdoutJson?.usage ?? null
  const applied = applyReading(st, p?.headers ?? null)
  const m5 = applied.meters[METER_5H]
  attribute(st, [idleKey, planKey], m5?.absent || m5?.sameWindow === false ? 1 : (applied.ticks[METER_5H] ?? 0), m5?.reset ?? null)
  const anomalies = []
  const flag = (a) => { if (!anomalies.includes(a)) anomalies.push(a) }
  if (own.length !== 1 || records.length !== 1) flag("unexpected_request_count")
  if (typeof p?.model === "string" && p.model !== RULES.model) flag("model_mismatch")
  if (p?.stop_reason === "refusal") flag("refusal")
  if (applied.status !== null && applied.status !== "allowed") flag("status_not_allowed")
  if (Number.isFinite(p?.status) && (p.status < 200 || p.status >= 300)) flag("http_error")
  if (invokeError || res?.error) flag("adapter_error")
  if (res?.stdoutJson?.is_error === true) flag("cli_is_error")
  // The CLI's `--output-format json` result must be an object; null, a bare string or any other
  // shape means the run did not report itself and nothing about it can be trusted.
  if (res && !isObject(res.stdoutJson)) flag("cli_stdout_not_json")
  if (!usageRaw) flag("usage_missing")
  if (p?.error) flag("response_error")
  // A re-baseline PING after a planned reset wait is EXPECTED to see the new epoch: that is a
  // window roll, not an anomaly. Every other step straddling a reset is one.
  const rolled = applied.anomalies.includes("reset_changed")
  for (const a of applied.anomalies) if (!(a === "reset_changed" && step.expectWindowRoll === true)) flag(a)
  // Gauge movement beyond what this call could possibly cost: foreign traffic or delayed
  // accounting. Recorded and counted as spend (the gauge already carries it).
  const predicted = typeof accounting.predictedTicks === "number" ? accounting.predictedTicks : null
  let unexplained = 0
  for (const meter of METERS) {
    const observed = applied.ticks[meter] ?? 0
    if (predicted !== null && observed > predicted) unexplained = Math.max(unexplained, observed - predicted)
  }
  if (unexplained > 0) flag("gauge_moved_without_own_call")

  // phase ledger (Appendix A section 0): only dial reads and pings have a known own cost.
  if (applied.meters[METER_5H]?.sameWindow === false) exp.phase = phaseLedger()
  const known = knownCost(step)
  const ticks5h = applied.ticks[METER_5H] ?? 0
  if (ticks5h > 0) exp.phase.onTick(known)
  else if (known !== null) exp.phase.addCost(known)
  const [phiLo, phiHi] = exp.phase.bounds()
  const phaseLedgerRow = { phiLo: eq(phiLo), phiHi: eq(phiHi), early: exp.phase.early(), phiHat: eq(exp.phase.phiHat()), knownCost: known === null ? null : eq(known) }
  st.lastCall = { ticked: ticks5h > 0, knownCost: known, bounds: [eq(phiLo), eq(phiHi)] }

  const idleSpend = spendOf(idleKey ? st.scopes[idleKey] : null)
  const expBase = exp.baselines?.[METER_5H] ?? null
  const now5h = applied.meters[METER_5H]?.absent ? null : { util: applied.meters[METER_5H].util, reset: applied.meters[METER_5H].reset }
  const accountingRow = {
    meter: METER_5H,
    baselineUtil: num(st.meters[METER_5H]?.baseline?.util) ?? null,
    baselineReset: num(st.meters[METER_5H]?.baseline?.reset) ?? null,
    utilNow: now5h ? now5h.util : null,
    resetNow: now5h ? now5h.reset : null,
    sameWindow: applied.meters[METER_5H]?.absent ? null : applied.meters[METER_5H].sameWindow,
    ticksSinceExperimentStart: expBase && now5h ? ticksBetween(expBase, now5h) : null,
    spentObservedEq: idleSpend.observedEq,
    spentUpperEq: idleSpend.upperEq,
    scope: idleKey,
    caps: compactCaps(accounting),
    predictedTicksForThisCall: accounting.predictedTicks,
    predictionTier: accounting.predictionTier ?? null,
    gateOk: !ungated,
    gated: !ungated,
    requestCount: records.length,
    unexplainedTicks: unexplained,
    ticks: applied.ticks,
    windowRolled: rolled,
    // The machine never tightens a price bound in-run (see gateState): recorded so the analyzer
    // can tell a prior-priced call from a learned one without reading this source.
    learnedBound: false,
  }

  const record = {
    v: REQUEST_VERSION,
    runId: st.runId,
    ...META_OF(step),
    label: p?.label ?? step.id,
    ts_req: p?.ts_req ?? iso(res?.startedMs ?? clock.now()),
    ts: p?.ts ?? iso(res?.endedMs ?? clock.now()),
    sessionId: step.session?.id ?? null,
    sessionMode: step.session?.mode ?? null,
    promptSha256: step.prompt.sha256,
    promptChars: step.prompt.chars,
    promptTokensEst: step.prompt.tokensEst,
    method: p?.method ?? "POST",
    path: p?.path ?? "/v1/messages",
    status: Number.isFinite(p?.status) ? p.status : null,
    requestId: p?.headers?.["request-id"] ?? null,
    msgId: p?.msg_id ?? null,
    model: p?.model ?? null,
    stop_reason: p?.stop_reason ?? null,
    error: p?.error ?? null,
    usage: usageRaw,
    headers: p?.headers ?? {},
    meters: applied.meters,
    accounting: accountingRow,
    phase_ledger: phaseLedgerRow,
    adapterError: invokeError ?? res?.error ?? null,
    exitCode: Number.isFinite(res?.exitCode) ? res.exitCode : null,
    anomalies,
  }
  st.deps.ledger.writeRequestRecord(record)
  // Every drained response is a call that was paid for. A step that produced more than one - the
  // `unexpected_request_count` case - keeps each of them as its own requests.jsonl row, the way a
  // multi-row reconciliation does, so the rows on disk are the calls that happened and the
  // run-level count can be read off them.
  const extras = records.filter((r) => r !== p)
  for (const x of extras) {
    st.deps.ledger.writeRequestRecord({
      ...record,
      label: x?.label ?? "",
      ts_req: x?.ts_req ?? record.ts_req, ts: x?.ts ?? record.ts,
      status: Number.isFinite(x?.status) ? x.status : null,
      requestId: x?.headers?.["request-id"] ?? null, msgId: x?.msg_id ?? null,
      model: x?.model ?? null, stop_reason: x?.stop_reason ?? null, error: x?.error ?? null,
      usage: x?.usage ?? null, headers: x?.headers ?? {},
      accounting: { ...record.accounting, source: "extra_request" },
    })
  }
  const rows = 1 + extras.length
  const text = typeof res?.stdoutJson?.result === "string" ? res.stdoutJson.result : (typeof res?.stdoutJson?.text === "string" ? res.stdoutJson.text : null)
  // Assistant text is needed to score restore/policy quality; it is synthetic and never a prompt.
  if (step.needsText) {
    st.deps.ledger.writeCli(step.id, {
      stepId: step.id, experiment: step.experiment, role: step.role ?? null,
      exitCode: Number.isFinite(res?.exitCode) ? res.exitCode : null,
      // The analyzer reads the answer from the artifact's `result` field (idle-live-analyze.mjs
      // cliText): without it every quality field comes back `cli_artifact_unreadable` and the run
      // scores nothing. The envelope around it keeps the exit code and the stderr head.
      result: text,
      stdoutJson: res?.stdoutJson ?? null, stderrHead: typeof res?.stderrHead === "string" ? res.stderrHead : "",
    })
  }
  // usage, headers and the meter readings live once, in requests.jsonl (the analyzer's input);
  // the event carries what the state machine needs and joins by stepId on resume.
  emit(st, {
    ev: "step_result", ...META_OF(step), source: "adapter", clean: anomalies.length === 0,
    ts_req: record.ts_req, ts: record.ts, model: record.model, stop_reason: record.stop_reason, status: record.status,
    ticks: applied.ticks,
    accounting: { spentObservedEq: accountingRow.spentObservedEq, spentUpperEq: accountingRow.spentUpperEq, scope: idleKey, predictedTicksForThisCall: accountingRow.predictedTicksForThisCall, requestCount: records.length, unexplainedTicks: unexplained },
    phase_ledger: phaseLedgerRow, anomalies, exitCode: record.exitCode, late: false,
  })

  const protocolRecord = p || usageRaw ? { ...record, text } : null
  const result = { record: protocolRecord, anomalies, ticks: applied.ticks, late: false, meters: applied.meters }
  const v = verdictOf(anomalies)
  // A cancel recorded at the seam above ends the CAMPAIGN whatever this one call's verdict was, and
  // it is also what ended the EXPERIMENT: `void:cancelled`, not the adapter failure the kill caused.
  // The call keeps its own evidence in its step_result anomalies, and a stop rule it carried is
  // still read from there by `campaignStopOf`; what changes is only the reason the experiment
  // reports, so the analyzer does not blame the adapter for a run the operator stopped (I16).
  if (cancelled) return { result, rows, fatal: { status: "void", reason: "cancelled" }, stop: true }
  return v ? { result, rows, fatal: { status: v.status, reason: v.reason }, stop: v.stop } : { result, rows }
}

/**
 * The machine's own verdict on a completed step, independent of the protocol. A global stop rule
 * (Appendix A section 0) aborts the experiment AND the campaign; a delivery failure - the adapter,
 * the CLI or the response itself did not report a trustworthy result - voids the experiment with
 * that reason. `null` means the protocol decides.
 *
 * It is applied wherever a step completes: a live call, and a response recovered from proxy.jsonl
 * during a resume. The landed protocol does not classify `adapter_error` as fatal, so without this
 * verdict a crash between the step_result and the experiment_ended left a failed call inside a
 * `valid` experiment at exit 0.
 */
/**
 * Stops the campaign once. The same stop can be reached twice - baselineBlock() sees the PING's
 * verdict, and the experiment that was waiting for it ends `aborted` with the same reason - and a
 * campaign stops exactly once, so the second call is a no-op.
 */
/**
 * Appendix B "clarification A" (i): the ONE stop predicate, a pure function of the event log.
 * Live and resume cannot diverge because neither decides a campaign-level stop any other way -
 * the live path appends the deciding event and then evaluates THIS function on the updated log
 * (see syncCampaignStop), and a resume evaluates it after reconciliation.
 *
 * `campaign_stop` remains an explicit marker, written as early as possible, but a stop holds
 * without it: the deciding records are the ones the live path acted on.
 */
export function campaignStopOf(events) {
  const rows = Array.isArray(events) ? events : []
  // An unresolved issuance makes every later prediction unsound, so it stops the campaign - but
  // only while it IS unresolved. A resume that recovers the response from proxy.jsonl settles the
  // doubt, and the stop lifts with it; that is why the gate's own `in_doubt_step` refusal is not
  // the record read here.
  const settled = new Set(rows.filter((e) => isObject(e) && e.ev === "step_result").map((e) => e.stepId))
  const unresolved = rows.find((e) => isObject(e) && e.ev === "step_void" && e.inDoubt === true && !settled.has(e.stepId))
  for (const e of rows) {
    if (!isObject(e)) continue
    switch (e.ev) {
      case "campaign_stop":
        return { reason: e.reason ?? "campaign_stop", meter: e.meter ?? null, source: "campaign_stop" }
      case "run_ended":
        if (Number.isFinite(e.exitCode) && e.exitCode !== EXIT.IN_DOUBT) return { reason: "run_already_ended", meter: null, source: "run_ended", ended: e }
        break
      case "gate_refused": {
        // A meter cap is cumulative and a campaign-stop scope is the approval's own kill switch:
        // both refuse everything after them, so the refusal itself is the stop.
        const stop = (e.reasons ?? []).find((r) => r?.code === "cap_exceeded" && String(r.scope).startsWith("campaign-stop:"))
        const meter = (e.reasons ?? []).find((r) => r?.code === "cap_exceeded" && String(r.scope).startsWith("meter:"))
        const other = (e.reasons ?? []).find((r) => r?.code === "status_not_allowed")
        if (stop) return { reason: "campaign_stop", meter: stop.meter ?? null, source: "gate_refused" }
        if (meter) return { reason: "cap_exceeded", meter: meter.meter ?? null, source: "gate_refused" }
        if (other) return { reason: other.code, meter: null, source: "gate_refused" }
        break
      }
      case "quiet_check_failed":
        return { reason: e.reason ?? "foreign_traffic", meter: null, source: "quiet_check_failed" }
      case "experiment_ended":
        if (e.status === "aborted" && (CAMPAIGN_FATAL.has(e.reason) || e.reason === "foreign_traffic")) {
          return { reason: e.reason, meter: null, source: "experiment_ended" }
        }
        break
      case "step_result": {
        const anomalies = Array.isArray(e.anomalies) ? e.anomalies : []
        const rule = anomalies.find((a) => CAMPAIGN_FATAL.has(a))
          ?? (e.experiment === PREFLIGHT_ID ? anomalies.find((a) => DELIVERY_FAILURE.has(a)) : null)
        if (rule) return { reason: rule, meter: null, source: "step_result", preflight: e.experiment === PREFLIGHT_ID }
        break
      }
      default:
        break
    }
  }
  if (unresolved) return { reason: "in_doubt_step", meter: null, source: "step_void", stepId: unresolved.stepId }
  return null
}

/**
 * The live path's only campaign-stop decision: the deciding event is already in the log, so ask
 * the predicate. Writes the explicit marker once, the first time it says stop.
 */
function syncCampaignStop(st, { experiment = null, run = null, stepId = null } = {}) {
  if (st.campaignStop) return st.campaignStop
  const hit = campaignStopOf(st.deps.ledger.fold().events)
  if (!hit || hit.source === "run_ended") return null
  stopCampaign(st, { meter: hit.meter, reason: hit.reason, experiment, run, stepId })
  return st.campaignStop
}

function stopCampaign(st, { meter = null, reason, experiment = null, run = null, stepId = null, record = true }) {
  if (st.campaignStop) return
  st.campaignStop = { meter, reason }
  if (!record) return
  // Every campaign-level stop gets its explicit marker EXCEPT the unresolved issuance, which is
  // the one stop that can lift: the deciding record is the in-doubt `step_void`, and a resume that
  // recovers the response from proxy.jsonl settles it. A marker would outlive its own reason.
  if (reason === "in_doubt_step") return
  emit(st, { ev: "campaign_stop", meter, reason, experiment, run, ...(stepId ? { stepId } : {}) })
}

function verdictOf(anomalies) {
  // Malformed either way: not an array, or an array carrying something that is not an anomaly
  // name. `["adapter_error"]` is a verdict; `[{code:"adapter_error"}]` is an unreadable record of
  // one, and reading it as "no anomalies" would replay a failed call as clean.
  if (!Array.isArray(anomalies) || anomalies.some((a) => typeof a !== "string")) {
    return { status: "void", reason: "checkpoint_anomalies_malformed", stop: false }
  }
  const stopRule = anomalies.find((a) => CAMPAIGN_FATAL.has(a)) ?? null
  if (stopRule) return { status: "aborted", reason: stopRule, stop: true }
  const delivery = anomalies.find((a) => DELIVERY_FAILURE.has(a)) ?? null
  if (delivery) return { status: "void", reason: delivery, stop: false }
  return null
}

// ------------------------------------------------------- reset-window waiting

// A gauge block must fit inside one reset window: if it cannot, free-wait past the reset
// (Appendix A section 1: reset + 120 s), shift the experiment's t0 by the wait so the
// protocol's own offsets stay intact, and re-baseline with the same three-PING quiet check.
async function maybeResetWait(st, exp, step) {
  const m = st.meters[METER_5H]
  if (!m || m.absent) return null
  const resetAt = epochMs(m.latest?.reset)
  const now = nowOf(st)
  if (resetAt === null || resetAt - now >= step.resetMarginMs) return null
  const until = resetAt + RESET_SETTLE_MS
  const waitMs = Math.max(0, until - now)
  emit(st, { ev: "reset_wait", ...META_OF(step), resetAtMs: resetAt, untilMs: until, waitMs, marginMs: step.resetMarginMs, t0ShiftMs: waitMs })
  try {
    await sleepOf(st, waitMs)
  } catch {
    stopCampaign(st, { reason: "cancelled", experiment: exp.id, stepId: step.id })
    return { status: "void", reason: "aborted_before_invoke", stop: true }
  }
  // The re-baseline PINGs are paid calls under the same global stop rules as any other, and the
  // block is the same bounded quiet check as preflight. Its fatal verdict is RETURNED, not
  // dropped: the caller must stop before it gates, records an intent for or invokes the step that
  // was waiting for this window.
  // Each reset window's quiet check gets its OWN PING ids. Reusing `preflight/rebaseline/<n>`
  // meant a resumed process served a NEW window's quiet check from the PREVIOUS window's recorded
  // PINGs: the new window got no quiet check at all and the waiting step went out straddling the
  // epoch. The first window keeps the bare `rebaseline` arm, so its ids are unchanged.
  // The Nth reset wait of the RUN gets the Nth set of PING ids, and a resumed process keys them by
  // its resume index as well, so a wait it takes can never reuse ids an earlier run already issued.
  st.resetWaits += 1
  const window = st.resetWaits
  const role = st.resumeIndex ? `rebaseline-r${st.resumeIndex}-w${window}` : (window === 1 ? "rebaseline" : `rebaseline-w${window}`)
  const r = await baselineBlock(st, { role })
  // t0 moves by the WHOLE interruption - the free wait, the three PINGs and any quiet retry -
  // so the protocol's own offsets stay intact instead of the next step coming out late.
  exp.t0 += nowOf(st) - now
  return r.fatal ? { ...r.fatal, stop: r.stop === true } : null
}

// --------------------------------------------------------------- ping blocks

function pingStep({ role, arm, index, atOffsetMs, n, expectWindowRoll = false }) {
  return {
    expectWindowRoll,
    id: `${PREFLIGHT_ID}/${arm}/${index}`,
    experiment: PREFLIGHT_ID,
    arm,
    index,
    kind: "ping",
    phase: "observe",
    role,
    unit: { kind: "run", index: 1 },
    n,
    scopeId: `${PREFLIGHT_ID}/${arm}`,
    atOffsetMs,
    toleranceMs: RULES.untimedToleranceMs,
    prompt: promptOf(NULLP),
    session: { id: null, mode: "ephemeral" },
    expect: { ttlLane: "any" },
    dominantField: "cacheRead",
  }
}

/**
 * The instrument's zero (Appendix A section 0: "PING x3 at 60 s spacing; any tick -> foreign
 * traffic, retry after 10 min (max 3)"). Ungated on purpose: the gate cannot project anything
 * before a meter reading exists, so the block is bounded by count and by shape instead.
 *
 * These are paid calls, so the global stop rules apply to them: a refusal, a model that is not
 * echoed, a status that is not "allowed" or an HTTP error stops the CAMPAIGN here, and a delivery
 * failure means the instrument was never established. A tick inside the quiet check is foreign
 * traffic: wait 10 minutes on the injected clock and try again, at most three attempts, then
 * refuse the run (exit 3 - a stop condition, nothing was measured).
 */
async function baselineBlock(st, { role = "baseline", count = BASELINE_PINGS, spacingMs = BASELINE_SPACING_MS } = {}) {
  const firstBlock = role.startsWith("baseline")
  // The re-baseline is the SAME three-PING quiet check as the preflight one (Appendix B "Resume
  // verdict contract"): a single PING cannot tell a foreign tick from this run's own delayed
  // accounting, so it would stop a healthy campaign on its own charge.
  for (let attempt = 1; attempt <= QUIET_ATTEMPTS; attempt++) {
    const arm = attempt === 1 ? role : `${role}-${attempt}`
    const exp = { id: PREFLIGHT_ID, run: null, t0: nowOf(st), phase: phaseLedger(), baselines: {}, steps: [] }
    let ticks = 0
    let moved = false
    for (let n = 1; n <= count; n++) {
      // Exactly ONE PING of a block may cross a reset: the FIRST PING of the FIRST attempt, and
      // only when this block follows something that moves the window - a planned wait (the
      // re-baseline) or a downtime (a resumed preflight). A retry attempt starts ten minutes later
      // INSIDE the window attempt 1 established, so its first PING is expected to stay there; and
      // a window that moves under PING 2 or 3 is an unreadable delta wherever it happens (v).
      const expectWindowRoll = attempt === 1 && n === 1 && (!firstBlock || st.resumeIndex > 0)
      const step = pingStep({ role: `${firstBlock ? "baseline" : "rebaseline"}_ping`, arm, index: n - 1, atOffsetMs: (n - 1) * spacingMs, n, expectWindowRoll })
      const r = await runStep(st, exp, step, { ungated: true })
      if (r.fatal) {
        syncCampaignStop(st, { experiment: PREFLIGHT_ID, stepId: step.id })
        return { fatal: r.fatal, stop: true }
      }
      // Quiet means the gauge did not move on its own. Only an UPWARD move is COUNTED as ticks -
      // a decrease can never cancel an earlier foreign tick - but a same-epoch DECREASE is not
      // quiet either: the gauge did something this run cannot explain, so the attempt fails. A
      // delta across a reset epoch is unreadable (the first re-baseline PING rolls the window by
      // design) and is neither.
      // A PING with no reading at all is not evidence of quiet either: without a meter this call
      // says nothing about the gauge, so the attempt cannot be called quiet on its strength.
      // (v) an attempt is quiet only if EVERY delta of it is readable in one window with zero
      // ticks. Missing, anomalous, or a window that moved under the attempt - unless this PING is
      // the one expected to roll it - all mean the attempt proved nothing and is retried.
      const m5 = r.result?.meters?.[METER_5H] ?? null
      const unreadable = !m5 || m5.absent === true || (m5.sameWindow === false && step.expectWindowRoll !== true)
      if (unreadable || (r.result?.anomalies ?? []).some((a) => a !== "reset_changed" || step.expectWindowRoll !== true)) moved = true
      if (!unreadable && m5.sameWindow !== false) {
        const d = r.result?.ticks?.[METER_5H] ?? 0
        ticks += Math.max(0, d)
        if (d !== 0 || r.result?.anomalies?.includes("gauge_decreased_same_epoch")) moved = true
      }
    }
    if (!moved && ticks === 0) {
      st.carry.phase = null // a paid call outside an experiment breaks the phase chain
      return { fatal: null, attempts: attempt }
    }
    if (attempt < QUIET_ATTEMPTS) {
      emit(st, { ev: "quiet_retry", experiment: PREFLIGHT_ID, arm, attempt, attempts: QUIET_ATTEMPTS, reason: ticks > 0 ? "foreign_tick" : "gauge_moved", ticks, waitMs: QUIET_RETRY_MS })
      try {
        await sleepOf(st, QUIET_RETRY_MS)
      } catch {
        stopCampaign(st, { reason: "cancelled", experiment: PREFLIGHT_ID })
        return { fatal: { status: "aborted", reason: "aborted_in_quiet_wait" }, stop: true }
      }
    }
  }
  emit(st, { ev: "quiet_check_failed", experiment: PREFLIGHT_ID, attempts: QUIET_ATTEMPTS, role, reason: "foreign_traffic" })
  syncCampaignStop(st, { experiment: PREFLIGHT_ID })
  return { fatal: { status: "aborted", reason: "foreign_traffic" }, stop: true }
}


// ------------------------------------------------------------- one experiment

function drawPool(st, job) {
  const want = POOL[job.experiment] ?? { seeds: 0, uuids: 0 }
  const pool = { seeds: [], uuids: [] }
  for (let i = 0; i < want.seeds; i++) pool.seeds.push(st.deps.random.seed())
  for (let i = 0; i < want.uuids; i++) pool.uuids.push(st.deps.random.uuid())
  return pool
}

// Draws come from the pool recorded in `experiment_started`, so the prompt bytes and session ids a
// run used are reproducible from its log; an over-draw is appended and recorded as its own event.
function pooledRandom(st, job, pool) {
  let si = 0
  let ui = 0
  return {
    seed() {
      if (si < pool.seeds.length) return pool.seeds[si++]
      const v = st.deps.random.seed()
      pool.seeds.push(v)
      si++
      emit(st, { ev: "random_drawn", experiment: job.experiment, run: job.run ?? null, kind: "seed", value: v })
      return v
    },
    uuid() {
      if (ui < pool.uuids.length) return pool.uuids[ui++]
      const v = st.deps.random.uuid()
      pool.uuids.push(v)
      ui++
      emit(st, { ev: "random_drawn", experiment: job.experiment, run: job.run ?? null, kind: "uuid", value: v })
      return v
    },
  }
}

const RANK = { valid: 0, upper_bound: 1, skipped: 1, not_run: 2, void: 3, aborted: 4 }
const CAMPAIGN_FATAL = new Set(["refusal", "model_mismatch", "status_not_allowed", "http_error", "unexpected_request_count"])
// The call did happen but nothing trustworthy came back: the adapter failed, the CLI did not
// report itself, the response carried no usage, or the checkpoint of it is malformed. The window
// is not a measurement, so the experiment is void with that reason - never valid.
const DELIVERY_FAILURE = new Set(["adapter_error", "cli_is_error", "cli_stdout_not_json", "usage_missing", "response_error", "checkpoint_anomalies_malformed"])
// The ExperimentResult as it goes into the log: per-step rows live in their own events, and the
// dial prefix is a PROMPT - only its hash may be recorded (Appendix B: never write prompt text).
const stripSteps = (result) => {
  if (!isObject(result)) return null
  const { steps, anomalies, dialPrefix, ...rest } = result
  const out = { ...rest, anomalies: Array.isArray(anomalies) ? anomalies : [] }
  if (dialPrefix) out.dialPrefix = { sessionId: dialPrefix.sessionId ?? null, promptSha256: dialPrefix.prompt?.sha256 ?? null, promptChars: dialPrefix.prompt?.chars ?? null }
  return out
}

function snapshotBaselines(st) {
  const out = {}
  for (const meter of METERS) {
    const m = st.meters[meter]
    out[meter] = m && !m.absent ? { util: m.latest.util, reset: m.latest.reset } : { absent: true }
  }
  return out
}

async function runExperiment(st, job) {
  const id = job.experiment
  const pool = drawPool(st, job)
  const carry = st.carry.phase
  // Revision 2: only an experiment that never started runs here, so its t0 is the REAL clock.
  // Anchoring it in a recorded past would make its first step late before it was ever issued.
  const t0 = st.deps.clock.now()
  const exp = { id, run: job.run ?? null, t0, phase: phaseLedger(), baselines: snapshotBaselines(st), steps: [], paid: 0 }
  const modeBefore = st.mode.resumeHit
  emit(st, {
    ev: "experiment_started", experiment: id,
    // Appendix B: {t0, baselines, seeds, sessionIds} at the TOP LEVEL - that is where the
    // analyzer reads the ground truth from (seedOf/makeTask). `pool` stays for resume, which
    // replays the draws from it. The `run` key is OMITTED for a job that is not per-run: the
    // analyzer indexes a multi-unit experiment by position and skips any event that has one.
    ...(job.run == null ? {} : { run: job.run }),
    t0: exp.t0, baselines: exp.baselines, seeds: [...pool.seeds], sessionIds: [...pool.uuids], pool,
    mode: { ...st.mode }, carryPhase: carry, dialPrefix: st.dialPrefix ? { seed: st.dialPrefix.seed, sessionId: st.dialPrefix.sessionId } : null,
  })
  const ctx = {
    experiment: id,
    approval: st.approval,
    random: pooledRandom(st, job, pool),
    mode: st.mode,
    dialPrefix: st.dialPrefix ? { prompt: st.dialPrefix.prompt, sessionId: st.dialPrefix.sessionId } : null,
    now: () => nowOf(st) - exp.t0,
    priors: st.priors,
    run: job.run ?? 1,
    phase: carry,
  }
  const gen = protocols[id](ctx)
  let feed
  let result = null
  let stop = false
  let inDoubt = false
  for (;;) {
    const next = await gen.next(feed)
    if (next.done) {
      result = next.value
      break
    }
    const step = next.value
    exp.steps.push({ id: step.id, arm: step.arm, role: step.role, unit: step.unit, index: step.index })
    const r = await runStep(st, exp, step)
    // What the experiment paid is what it recorded: the request rows this step wrote, counted
    // before the verdict, because a call that ended the experiment was still a paid call.
    exp.paid += r.rows ?? 0
    if (r.fatal) {
      result = { experiment: id, status: r.fatal.status, reason: r.fatal.reason }
      stop = r.stop === true
      inDoubt = r.inDoubt === true
      break
    }
    feed = r.result
  }
  const par = parity(id, exp.steps)
  const status = result?.status ?? "void"
  const reason = result?.reason ?? null
  // Appendix A global stop rules: a refusal, a model fallback, a status that is not "allowed",
  // an HTTP error or an unexpected extra request stops the CAMPAIGN - no retry, cache state
  // unknown afterwards. A protocol-local abort (dial miss, short output, ...) does not. The stop
  // is appended BEFORE the verdict it follows from: a kill between the two events must not leave
  // a log whose worst reading is "this experiment ended, carry on".
  if (status === "aborted" && CAMPAIGN_FATAL.has(reason)) {
    syncCampaignStop(st, { experiment: id, run: job.run ?? null })
    stop = true
  }
  // I13: the mode this run measured about `--resume` is written BEFORE the verdict. A crash in the
  // gap used to lose it, and the next restore/policy run re-measured it with its own paid gate call.
  if (st.mode.resumeHit !== modeBefore) emit(st, { ev: "mode_set", experiment: id, resumeHit: st.mode.resumeHit })
  emit(st, {
    ev: "experiment_ended", experiment: id, run: job.run ?? null, status, reason,
    paidRequests: exp.paid, parity: { ok: par.ok, complete: par.complete, issues: par.issues },
    result: stripSteps(result),
  })
  st.experiments[id] ??= { status: null, reason: null, paidRequests: 0, spentObservedEq: 0, spentUpperEq: 0, runs: [] }
  const agg = st.experiments[id]
  agg.paidRequests += exp.paid
  agg.runs.push({ run: job.run ?? null, status, reason })
  if (agg.status === null || (RANK[status] ?? 0) > (RANK[agg.status] ?? 0)) {
    agg.status = status
    agg.reason = reason
  }
  const planSpend = spendOf(st.scopes[`plan:${id}`])
  agg.spentObservedEq = planSpend.observedEq
  agg.spentUpperEq = planSpend.upperEq
  if (isObject(result?.dialPrefix) && result.dialPrefix.prompt) {
    st.dialPrefix = { prompt: result.dialPrefix.prompt, sessionId: result.dialPrefix.sessionId, seed: pool.seeds[0] ?? null }
    emit(st, { ev: "dial_prefix", experiment: id, run: job.run ?? null, seed: st.dialPrefix.seed, sessionId: st.dialPrefix.sessionId })
  }
  const ledgerCarry = st.lastCall?.ticked && st.lastCall.knownCost !== null ? st.lastCall.bounds : null
  st.carry.phase = Array.isArray(result?.phaseAtEnd) ? result.phaseAtEnd : ledgerCarry
  return { status, stop, inDoubt }
}

// ------------------------------------------------------------------- resume

async function proxyLogOf(st) {
  if (typeof st.deps.proxyLog?.records === "function") return (await st.deps.proxyLog.records()) ?? []
  if (typeof st.deps.proxy?.readLog === "function") return (await st.deps.proxy.readLog()) ?? []
  return []
}

/**
 * One in-doubt step, reconciled against proxy.jsonl. The request HAPPENED - the proxy logged the
 * response - so the step is recorded from that evidence and NEVER re-invoked.
 *
 * `matches` is the COMPLETE set of rows the proxy logged for this step id, not the first one: the
 * one-response rule of the live loop applies here too, so two rows mean
 * `unexpected_request_count`, and BOTH rows' spend is applied to the meters and attributed to the
 * caps before anything else is gated.
 */
function reconcileStep(st, stepId, intent, matches) {
  const anomalies = ["proxy_reconciled"]
  const flag = (a) => { if (!anomalies.includes(a)) anomalies.push(a) }
  if (matches.length !== 1) flag("unexpected_request_count")
  const rows = []
  const ticks = {}
  for (const p of matches) {
    const applied = applyReading(st, p.headers ?? null)
    for (const meter of METERS) ticks[meter] = (ticks[meter] ?? 0) + (applied.ticks[meter] ?? 0)
    if (typeof p.model === "string" && p.model !== RULES.model) flag("model_mismatch")
    if (p.stop_reason === "refusal") flag("refusal")
    if (applied.status !== null && applied.status !== "allowed") flag("status_not_allowed")
    if (Number.isFinite(p.status) && (p.status < 200 || p.status >= 300)) flag("http_error")
    if (!p.usage) flag("usage_missing")
    if (p.error) flag("response_error")
    for (const a of applied.anomalies) flag(a)
    rows.push({ p, applied })
  }
  const applied = rows[rows.length - 1].applied
  const meta = {
    stepId,
    experiment: intent?.experiment ?? null,
    run: intent?.run ?? null,
    arm: intent?.arm ?? null,
    phase: intent?.phase ?? null,
    index: intent?.index ?? null,
    kind: intent?.kind ?? null,
    role: intent?.role ?? null,
    unit: intent?.unit ?? null,
    n: intent?.n ?? null,
    k: intent?.k ?? null,
    prefix: intent?.prefix ?? null,
    scopeId: intent?.scopeId ?? null,
    dominantField: intent?.dominantField ?? null,
  }
  // The recovered response was PAID for: its ticks must reach the per-idle and per-plan scopes
  // before the next gate, exactly like a live result (the gate reproduced a run that spent its
  // whole 0.03 cap in the uncertain call and then issued nine more).
  const m5 = applied.meters[METER_5H]
  const planKey = meta.experiment ? `plan:${meta.experiment}` : null
  const ownTicks = ticks[METER_5H] ?? 0
  const idleKey = idleScopeOf(meta)
  attribute(st, [idleKey, planKey], m5?.absent || m5?.sameWindow === false ? Math.max(1, ownTicks) : ownTicks, m5?.reset ?? null)
  const spend = spendOf(idleKey ? st.scopes[idleKey] : null)
  const recordOf = ({ p, applied: a }) => ({
    v: REQUEST_VERSION, runId: st.runId, ...meta, label: p.label ?? stepId,
    ts_req: p.ts_req ?? null, ts: p.ts ?? null,
    sessionId: intent?.sessionId ?? null, sessionMode: intent?.sessionMode ?? null,
    promptSha256: intent?.promptSha256 ?? null, promptChars: intent?.promptChars ?? null, promptTokensEst: intent?.promptTokensEst ?? null,
    method: p.method ?? "POST", path: p.path ?? "/v1/messages", status: Number.isFinite(p.status) ? p.status : null,
    requestId: p.headers?.["request-id"] ?? null, msgId: p.msg_id ?? null,
    model: p.model ?? null, stop_reason: p.stop_reason ?? null, error: p.error ?? null,
    usage: p.usage ?? null, headers: p.headers ?? {}, meters: a.meters,
    accounting: { meter: METER_5H, source: "proxy_reconciled", gateOk: null, gated: false, caps: [], requestCount: matches.length, unexplainedTicks: 0, ticks: a.ticks, sameWindow: a.meters[METER_5H]?.sameWindow ?? null, scope: idleKey, spentObservedEq: spend.observedEq, spentUpperEq: spend.upperEq, learnedBound: false },
    phase_ledger: { phiLo: null, phiHi: null, early: null, phiHat: null, knownCost: null },
    adapterError: null, exitCode: null, anomalies,
  })
  // Every row of the matching set is kept as evidence, so a requests.jsonl join by stepId shows
  // the true multiplicity instead of hiding it behind one synthesized record.
  const written = rows.map(recordOf)
  for (const r of written) {
    st.deps.ledger.writeRequestRecord(r)
    st.paidRequests += 1
  }
  const record = written[0]
  emit(st, {
    ev: "step_result", ...meta, source: "proxy_reconciled", clean: false,
    ts_req: record.ts_req, ts: record.ts, model: record.model, stop_reason: record.stop_reason, status: record.status,
    ticks, accounting: { source: "proxy_reconciled", requestCount: matches.length, scope: idleKey, spentObservedEq: spend.observedEq, spentUpperEq: spend.upperEq }, phase_ledger: record.phase_ledger, anomalies, exitCode: null, late: false,
  })
}

/**
 * Appendix B "Resume verdict contract, revision 2". A resumed run does NOT replay the campaign.
 * Rounds 3-6 each found a new way for a continued experiment to diverge from the live one across
 * downtime, so continuation is gone. All the log is used for is:
 *   * cap accounting - every recorded response's reading is applied and attributed, so the caps a
 *     fresh experiment is gated against include all the spend the run has already made;
 *   * in-doubt reconciliation - an issuance the log never resolved is settled against proxy.jsonl
 *     and NEVER re-invoked;
 *   * verdicts - an experiment the log ended keeps its verdict, and the one in progress at the
 *     crash is closed `void:interrupted_by_crash`: its unissued steps are never issued.
 * Everything else - the preflight quiet check, the experiments that never started - runs fresh on
 * the real clock.
 */
async function resumeFromLog(st) {
  const folded = fold(st.deps.ledger.fold().events)
  st.runId = folded.runId ?? st.runId
  const rows = new Map((st.deps.ledger.readRequests?.() ?? []).map((r) => [r.stepId, r]))
  emit(st, { ev: "run_resumed", lastSeq: folded.lastSeq, inDoubt: folded.inDoubt, paidRequests: folded.paidRequests, mode: { ...st.mode } })

  // (5) cap accounting includes ALL recorded spend, in the order it was recorded.
  for (const ev of folded.results) {
    const rec = rows.get(ev.stepId) ?? null
    const applied = applyReading(st, rec?.headers ?? null)
    const m5 = applied.meters[METER_5H]
    const charged = m5?.absent || m5?.sameWindow === false ? 1 : (applied.ticks[METER_5H] ?? 0)
    attribute(st, [idleScopeOf(ev), `plan:${ev.experiment}`], charged, m5?.reset ?? null)
    // A recorded result whose requests.jsonl row is gone has NO reading to re-account. The charge
    // stays conservative (one tick), but silence would let a truncated evidence dir look clean:
    // the resume says which call it could not read and what it charged for it instead.
    if (!rec) emit(st, { ev: "row_missing", stepId: ev.stepId, experiment: ev.experiment ?? null, run: ev.run ?? null, anomalies: ["request_row_missing"], charged, source: "resume" })
    st.paidRequests += Number.isInteger(ev.accounting?.requestCount) && ev.accounting.requestCount > 0 ? ev.accounting.requestCount : 1
  }

  // (3) an issuance the log never resolved: reconcile from proxy.jsonl (its spend is attributed
  // by reconcileStep) or keep the run in doubt. Never re-invoked either way.
  const proxyLog = await proxyLogOf(st)
  for (const stepId of folded.inDoubt) {
    const intent = folded.steps[stepId]?.intent ?? null
    const matches = proxyLog.filter((r) => r?.stepId === stepId || r?.label === stepId)
    if (matches.length > 0) {
      reconcileStep(st, stepId, intent, matches)
      continue
    }
    emit(st, { ev: "step_void", stepId, experiment: intent?.experiment ?? null, run: intent?.run ?? null, arm: intent?.arm ?? null, phase: intent?.phase ?? null, index: intent?.index ?? null, kind: intent?.kind ?? null, role: intent?.role ?? null, unit: intent?.unit ?? null, n: intent?.n ?? null, k: intent?.k ?? null, prefix: intent?.prefix ?? null, reason: "unknown_issue_state", inDoubt: true, source: "resume" })
    st.inDoubt.push(stepId)
  }

  // Verdicts: ended keeps its own, started-but-not-ended is closed by the crash. Read from the
  // log AS IT NOW STANDS: the rows this process reconciled above belong to the experiment that
  // paid for them, so its reported count is the rows on disk and not the count at crash time.
  const settled = fold(st.deps.ledger.fold().events)
  const done = new Map()
  const interrupted = new Set()
  for (const [key, x] of Object.entries(settled.experiments)) {
    if (x.status && x.status !== "started") done.set(key, { status: x.status, reason: x.reason, paidRequests: x.endedPaid ?? x.paidRequests })
    else if (x.status === "started") interrupted.add(key)
  }
  // (iii) every id THIS process issues is absent from the log. The fresh preflight and any reset
  // wait this process takes are keyed by the resume index, and the wait counter continues from the
  // folded count, so a re-baseline can never reuse the ids of an earlier process's wait.
  st.resumeIndex = st.deps.ledger.fold().events.filter((e) => e?.ev === "run_resumed").length
  st.resetWaits = folded.resetWaits ?? 0
  // (iv) fresh experiments inherit the run-level state the protocols need. Without the recorded
  // dial prefix, fable and output-quota abort `no_dial_prefix` on the runner's resume path.
  st.dialPrefix = rebuildDialPrefix(folded.dialPrefix ?? dialPrefixSeedOf(folded)) ?? st.dialPrefix
  st.mode.resumeHit = folded.mode?.resumeHit ?? st.mode.resumeHit
  // what each job has paid, read from the settled log (reconciled rows included)
  const paidByJob = Object.fromEntries(Object.entries(settled.experiments).map(([key, x]) => [key, x.paidRequests]))
  st.resume = { folded, done, interrupted, paidByJob }
  return st.resume
}

/**
 * The resumed run's stop decision: the same pure predicate, evaluated AFTER reconciliation, so a
 * response recovered from proxy.jsonl in THIS process is part of the evidence it reads.
 */
function campaignStopFromLog(st) {
  const events = st.deps.ledger.fold().events
  const hit = campaignStopOf(events)
  if (!hit) return null
  if (hit.source === "run_ended") {
    return { reason: "run_already_ended", stopped: hit.ended?.reason ?? "run_already_ended" }
  }
  // One writer, so the marker rule cannot differ between the live path and a resume - and the marker
  // is written only when the log holds NONE. The predicate returns the first deciding record in log
  // order, which is the deciding EVENT and precedes the marker the live path wrote for it, so
  // keying on `hit.source` alone made every later resume re-state a stop the log already says (I14a).
  const marked = events.some((e) => isObject(e) && e.ev === "campaign_stop")
  stopCampaign(st, { meter: hit.meter ?? null, reason: hit.reason, record: !marked })
  return { reason: hit.reason, stopped: hit.preflight && !CAMPAIGN_FATAL.has(hit.reason) ? "baseline_failed" : "campaign_stop" }
}



// ---------------------------------------------------------------------- smoke

// The smoke block is not one of the approved plans, so the machine bounds it itself: Appendix B
// budgets ~0.55 tick (3 PINGs + WRITE-2000 + one DIAL read), this allows 2 ticks. The meter caps
// and the campaign stop rules still come from the approval.
const SMOKE_PLAN = Object.freeze({ limits: { maxProactiveSpendPerIdle: { value: 0.02, unit: "quota_fraction" }, maxTotalExperimentalSpend: { value: 0.02, unit: "quota_fraction" } } })
/**
 * The approval as the gate reads it: the smoke run's extra plans, and the per-idle cap of an
 * interleaved frame stated at the scope it is enforced on (see INTERLEAVED_FRAMES). The approval
 * file itself is never modified.
 */
function gateApprovalOf(st) {
  const base = st.extraPlans ? { ...st.approval, plans: { ...st.approval.plans, ...st.extraPlans } } : st.approval
  const plans = { ...base.plans }
  let framed = false
  for (const id of Object.keys(INTERLEAVED_FRAMES)) {
    const plan = plans[id]
    if (!plan?.limits?.maxProactiveSpendPerIdle) continue
    plans[id] = { ...plan, limits: { ...plan.limits, maxProactiveSpendPerIdle: { ...plan.limits.maxProactiveSpendPerIdle, value: perIdleCapOf(base, id).capEq } } }
    framed = true
  }
  if (!framed) return base
  return { ...base, plans, perIdleScope: { ...base.perIdleScope, ...Object.fromEntries(Object.keys(INTERLEAVED_FRAMES).map((id) => [id, "frame"])) } }
}

function smokeStep({ index, arm, kind, role, atOffsetMs, prompt, dominantField, hit, seed }) {
  return {
    id: `smoke/${arm}/${index}`, experiment: "smoke", arm, index, kind, phase: "observe", role,
    unit: { kind: "run", index: 1 }, n: index + 1, scopeId: "smoke/run-1",
    atOffsetMs, toleranceMs: RULES.untimedToleranceMs, prompt,
    session: { id: null, mode: "ephemeral" }, expect: { ttlLane: "1h", hit }, dominantField, seed,
  }
}

async function smokeRun(st) {
  st.extraPlans = { smoke: SMOKE_PLAN }
  const base = await baselineBlock(st, {})
  const threshold = SMOKE.hitFactor * SMOKE.writeTokens
  const out = { write: null, dial: null, thresholdCacheRead: threshold, pings: BASELINE_PINGS }
  if (base.fatal) return { exitCode: EXIT.ABORTED, smoke: { ...out, reason: base.fatal.reason } }
  const seed = st.deps.random.seed()
  const prompt = fillerPrompt(seed, SMOKE.lines)
  const exp = { id: "smoke", run: null, t0: st.deps.clock.now(), phase: phaseLedger(), baselines: snapshotBaselines(st), steps: [], paid: 0 }
  emit(st, { ev: "experiment_started", experiment: "smoke", run: null, t0: exp.t0, baselines: exp.baselines, pool: { seeds: [seed], uuids: [] }, mode: { ...st.mode }, carryPhase: null, dialPrefix: null })
  const write = smokeStep({ index: 0, arm: "write", kind: "write", role: "smoke_write", atOffsetMs: 0, prompt, dominantField: "cacheWrite1h", hit: false, seed })
  const w = await runStep(st, exp, write)
  if (w.fatal) {
    emit(st, { ev: "experiment_ended", experiment: "smoke", run: null, status: w.fatal.status, reason: w.fatal.reason, paidRequests: exp.paid, parity: null, result: null })
    return { exitCode: EXIT.ABORTED, smoke: { ...out, reason: w.fatal.reason } }
  }
  out.write = { cacheWrite1h: w.result.record?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? null, ticks: w.result.ticks?.[METER_5H] ?? null }
  const dial = smokeStep({ index: 1, arm: "dial", kind: "dial", role: "smoke_dial", atOffsetMs: RULES.restore.settleMs, prompt, dominantField: "cacheRead", hit: true, seed })
  const d = await runStep(st, exp, dial)
  if (d.fatal) {
    emit(st, { ev: "experiment_ended", experiment: "smoke", run: null, status: d.fatal.status, reason: d.fatal.reason, paidRequests: exp.paid, parity: null, result: null })
    return { exitCode: EXIT.ABORTED, smoke: { ...out, reason: d.fatal.reason } }
  }
  const cacheRead = d.result.record?.usage?.cache_read_input_tokens ?? null
  const hit = Number.isFinite(cacheRead) && cacheRead >= threshold
  out.dial = { cacheRead, hit, ticks: d.result.ticks?.[METER_5H] ?? null }
  const status = hit ? "valid" : "aborted"
  emit(st, { ev: "experiment_ended", experiment: "smoke", run: null, status, reason: hit ? null : "smoke_dial_miss", paidRequests: 2, parity: null, result: { experiment: "smoke", status, ...out } })
  return { exitCode: hit ? EXIT.OK : EXIT.ABORTED, smoke: hit ? out : { ...out, reason: "smoke_dial_miss" } }
}



// ------------------------------------------------------------------ runMachine

function exitCodeOf(st, jobs) {
  if (st.inDoubt.length) return EXIT.IN_DOUBT
  // A campaign-level stop is exit 3 whatever the individual experiments say - live, and on a
  // resume that read the same stop out of the log.
  if (st.campaignStop) return EXIT.ABORTED
  for (const job of jobs) {
    const agg = st.experiments[job.experiment]
    const run = agg?.runs?.find((r) => (r.run ?? null) === (job.run ?? null))
    if (!run) return EXIT.ABORTED // scheduled but never reached (campaign stop)
    if (!TERMINAL.has(run.status)) return EXIT.ABORTED
  }
  return EXIT.OK
}

/**
 * The dial prefix is recorded only once its producing run finishes, so a crash can fall between
 * the call that primes the parent session and the `dial_prefix` event. The prefix is a pure
 * function of that run's recorded seed, and the session it primed is the run's first recorded
 * uuid - so rebuild it from those, but only once the context-creating call is itself recorded:
 * an unprimed prefix would turn every later dial into a cache miss.
 */
function dialPrefixSeedOf(folded) {
  for (const x of Object.values(folded.experiments)) {
    const seed = x.pool?.seeds?.[0]
    if (!Number.isInteger(seed)) continue
    const primed = x.steps.some((id) => folded.steps[id]?.state === "result" && folded.steps[id]?.role === CTX_CREATE_ROLE)
    if (primed) return { seed, sessionId: x.pool?.uuids?.[0] ?? null }
  }
  return null
}

// protocols.mjs gives the context-creating call of the dial-prefix producer this role
const CTX_CREATE_ROLE = "ctx_create"

const rebuildDialPrefix = (dp) => (isObject(dp) && Number.isInteger(dp.seed) ? { prompt: makeTask(dp.seed).ctxPrompt, sessionId: dp.sessionId ?? null, seed: dp.seed } : null)

/** runMachine(deps, approval, opts) -> Summary. See Appendix B "Experiment loop". */
export async function runMachine(deps, approval, opts = {}) {
  const st = newState(deps, approval, opts)
  // (ii) A cancel already in force when the machine starts is recorded before the run's own
  // bookkeeping, so nothing at all precedes it in the log.
  if (st.signal?.aborted) stopCampaign(st, { reason: "cancelled" })
  if (!opts.resume) emit(st, { ev: "run_started", evidenceDir: st.evidenceDir, dryRun: opts.dryRun === true, smoke: opts.smoke === true, only: opts.only ?? null, adapter: deps.adapter?.capabilities ?? null, proxyPort: deps.proxy?.port ?? null })
  else await resumeFromLog(st)

  const pre = await preflight(deps, approval, { ...opts, onCancel: () => stopCampaign(st, { reason: "cancelled" }) })
  // The same read again for a preflight that was given no hook: a cancel taken during the scan must
  // never be lost, and this is the last point before the branch that can skip the quiet check
  // entirely (a recorded stop, an unresolved in-doubt step, or no fresh job left).
  if (st.signal?.aborted) stopCampaign(st, { reason: "cancelled" })
  if (!pre.ok) {
    const summary = summaryOf(st, EXIT.PREFLIGHT, { issues: pre.issues, notRunReason: "preflight_refused" })
    emit(st, { ev: "run_ended", exitCode: EXIT.PREFLIGHT, reason: "preflight_refused", issues: pre.issues })
    return summary
  }
  st.skipped = pre.skippedArms
  if (opts.dryRun) {
    const summary = summaryOf(st, EXIT.OK, { dryRun: true, schedule: pre.schedule, notRunReason: "dry_run", issues: [] })
    emit(st, { ev: "run_ended", exitCode: EXIT.OK, reason: "dry_run" })
    return summary
  }
  // TEST SEAM. In production the dial prefix comes from the restore run that primes it (or, on a
  // resume, from the recorded seed); `opts.dialPrefix` lets a test run an experiment that consumes
  // the prefix without running restore-decomposition first. The runner never passes it.
  st.dialPrefix = rebuildDialPrefix(opts.dialPrefix) ?? st.dialPrefix

  if (opts.smoke) {
    const sm = await smokeRun(st)
    const summary = summaryOf(st, sm.exitCode, { issues: [], smoke: sm.smoke, notRunReason: "smoke" })
    st.deps.ledger.writeSummary?.(summary)
    emit(st, { ev: "run_ended", exitCode: sm.exitCode, reason: sm.smoke.reason ?? "smoke_ok", paidRequests: st.paidRequests })
    return summary
  }

  // Appendix B revision 2. A resumed run reports what the log holds and then runs only what
  // never started:
  //   * a campaign-level stop in the log refuses ALL issuance - not even the preflight runs;
  //   * an experiment the log ended keeps its verdict;
  //   * the experiment in progress at the crash is closed `void:interrupted_by_crash` - its
  //     unissued steps are never issued;
  //   * everything else runs fresh, after a fresh preflight quiet check on the real clock.
  const recordedStop = st.resume ? campaignStopFromLog(st) : null
  const reported = new Set()
  if (st.resume) {
    for (const job of pre.jobs) {
      const prior = st.resume.done.get(job.key)
      const wasInterrupted = st.resume.interrupted.has(job.key)
      if (!prior && !wasInterrupted) continue
      const status = prior ? prior.status : "void"
      const reason = prior ? prior.reason : "interrupted_by_crash"
      reported.add(job.key)
      st.experiments[job.experiment] ??= { status: null, reason: null, paidRequests: 0, spentObservedEq: 0, spentUpperEq: 0, runs: [] }
      const agg = st.experiments[job.experiment]
      agg.paidRequests += prior?.paidRequests ?? st.resume.paidByJob[job.key] ?? 0
      agg.runs.push({ run: job.run ?? null, status, reason })
      if (agg.status === null || (RANK[status] ?? 0) > (RANK[agg.status] ?? 0)) {
        agg.status = status
        agg.reason = reason
      }
      // the spend of a job reported from the log is the spend the resume re-attributed for it,
      // exactly as the live path reports it - not zero
      const reportedSpend = spendOf(st.scopes[`plan:${job.experiment}`])
      agg.spentObservedEq = reportedSpend.observedEq
      agg.spentUpperEq = reportedSpend.upperEq
      emit(st, { ev: "experiment_ended", experiment: job.experiment, ...(job.run == null ? {} : { run: job.run }), status, reason, paidRequests: agg.paidRequests, source: "resume" })
    }
  }
  const fresh = pre.jobs.filter((job) => !reported.has(job.key))
  // The instrument is established for the experiments that are about to run, never for the log.
  const base = recordedStop || st.inDoubt.length || fresh.length === 0
    ? { fatal: recordedStop ? { status: "aborted", reason: recordedStop.reason } : null, stopped: recordedStop?.stopped ?? null }
    : await baselineBlock(st, { role: st.resumeIndex ? `baseline-r${st.resumeIndex}` : "baseline" })
  let stopped = base.fatal ? (base.stopped ?? (st.campaignStop ? "campaign_stopped" : "baseline_failed")) : (st.inDoubt.length ? "in_doubt" : null)
  if (!stopped) {
    for (const job of fresh) {
      if (stopped) break
      const r = await runExperiment(st, job)
      if (r.stop) stopped = r.inDoubt ? "in_doubt" : (st.campaignStop ? "campaign_stop" : "stop_condition")
    }
  }
  for (const job of pre.jobs) {
    const agg = st.experiments[job.experiment]
    if (!agg) st.experiments[job.experiment] = { status: "not_run", reason: stopped ?? "not_reached", paidRequests: 0, spentObservedEq: 0, spentUpperEq: 0, runs: [] }
  }
  const exitCode = exitCodeOf(st, pre.jobs)
  const summary = summaryOf(st, exitCode, { issues: [], stopped })
  st.deps.ledger.writeSummary?.(summary)
  emit(st, { ev: "run_ended", exitCode, reason: stopped ?? "complete", paidRequests: st.paidRequests })
  return summary
}
