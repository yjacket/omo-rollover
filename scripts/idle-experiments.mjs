// Offline planner for the approval-gated idle-cost experiments (AGENT_TASK section 7).
//   node scripts/idle-experiments.mjs                 all plans, dry-run (default)
//   node scripts/idle-experiments.mjs --plan=<id>     one plan
//   node scripts/idle-experiments.mjs --json          machine-readable dry-run
//   node scripts/idle-experiments.mjs --execute       refused, exits nonzero
// This file plans; it never runs an experiment. It has no request adapter, no network
// import, no timer and no scheduler, so no flag can make it spend quota. Cost lines stay
// coefficient-dependent: no measured quota figure exists in this worktree yet.
import { pathToFileURL } from "node:url"

const PREPARED_AT = "2026-09-19T00:00:00Z"
const USAGE_FIELDS = ["uncachedInput", "cacheWrite5m", "cacheWrite1h", "cacheRead", "billedModelOutput"]
const COEFFICIENTS = ["k_input", "k_write5", "k_write60", "k_read", "k_output"]
const PAID_KINDS = ["write", "read", "probe", "check", "work"]
const BLOCKED_BY = ["no_execution_approval", "budget_unconfigured", "coefficients_unknown"]

const spend = (identification) => ({
  status: "coefficient_dependent",
  unit: "unconfigured",
  formula: "Q = k_input*uncachedInput + k_write5*cacheWrite5m + k_write60*cacheWrite1h + k_read*cacheRead + k_output*billedModelOutput",
  requiredCoefficients: COEFFICIENTS,
  coefficientSource: "none carried by this planner; a provenance-bearing coefficient record (modelId/authLane/ttlLane/quotaMeter) must exist before any number is quoted",
  identification,
  measuredQuotaEstimate: null,
})

// The five approval settings of AGENT_TASK B4. Each one carries its own value, unit and
// dimension: a spend cap and a resume-delay cap are different quantities and never share a unit.
export const REQUIRED_LIMITS = ["maxProactiveSpendPerIdle", "maxTotalExperimentalSpend", "maxResumeDelay", "allowedQualityDegradation", "minimumEvidenceForEnforcement"]
const LIMIT_DIMENSIONS = { maxProactiveSpendPerIdle: "spend", maxTotalExperimentalSpend: "spend", maxResumeDelay: "time", allowedQualityDegradation: "quality", minimumEvidenceForEnforcement: "evidence" }
const DIMENSION_UNITS = {
  spend: ["quota_fraction", "quota_ticks", "tokens", "usd"],
  time: ["ms", "s", "min"],
  quality: ["lost_context_events", "reexplanation_events"],
  evidence: ["paired_runs", "observations"],
}

const budget = () => ({
  limits: Object.fromEntries(REQUIRED_LIMITS.map((name) => [name, { value: "unconfigured", unit: "unconfigured", dimension: LIMIT_DIMENSIONS[name] }])),
  approvedAt: null,
  approvalExpiresAt: null,
  note: "'unconfigured' is neither 0 nor 'unlimited'. An explicit numeric 0 is a valid setting and means zero allowed spend; any numeric value needs its own unit and a current approval",
})

// How one approval setting is configured. A numeric 0 is a real setting, not a missing one.
export const limitState = (limit) => {
  if (!limit || typeof limit !== "object") return "malformed"
  if (limit.value === "unconfigured") return "unconfigured"
  if (limit.value === "unlimited") return "unlimited"
  return typeof limit.value === "number" && Number.isFinite(limit.value) ? "numeric" : "malformed"
}

// What the spend-dimension settings actually permit: unconfigured, zero, positive or unlimited.
export const spendAllowance = (b) => {
  const limits = b && typeof b === "object" && b.limits && typeof b.limits === "object" ? b.limits : null
  if (!limits) return "malformed"
  const spendLimits = REQUIRED_LIMITS.filter((name) => LIMIT_DIMENSIONS[name] === "spend").map((name) => limits[name])
  const states = spendLimits.map(limitState)
  if (states.includes("malformed")) return "malformed"
  if (states.includes("unconfigured")) return "unconfigured"
  if (states.every((s) => s === "unlimited")) return "unlimited"
  // The most binding spend cap decides. A single zero cap — the total or the per-idle one — allows
  // no spend at all, so it outranks a positive or unlimited cap beside it. Zero means zero.
  const numeric = spendLimits.filter((l) => limitState(l) === "numeric")
  return numeric.some((l) => l.value === 0) ? "zero" : "positive"
}

// Paid request rows cost whatever the (still unknown) coefficients say. Meter readings are not
// model requests, but nothing here establishes that reading a meter is free, so their cost is unknown.
const req = (arm, label, kind, offsetMin, count, prefix, note = "") => ({ arm, label, kind, paid: kind !== "observation", cost: kind === "observation" ? "unknown" : "coefficient_dependent", offsetMin, count, prefix, note })
const gauge = (arm, offsetMin, note) => req(arm, `quota meter reading at t${offsetMin >= 0 ? "+" : ""}${offsetMin}min`, "observation", offsetMin, 1, "n/a", note)

const outputQuota = {
  id: "output-quota",
  title: "Output quota contribution at several output levels",
  preparedAt: PREPARED_AT,
  measures: [
    "billed model output contribution separated from uncached input, cache read and cache write",
    "whether k_output is identifiable at all from the account-level quota gauge",
  ],
  design: {
    separates: ["uncachedInput", "cacheRead", "cacheWrite"],
    holdsConstant: "identical prompt prefix, identical tool surface, identical model and lane across levels; only the requested output length changes",
    perLevelPrefix: "each level establishes its own unique prefix so a later level cannot read an earlier level's cache",
    identification: "k_output is identifiable only if input/read/write stay constant across levels and no quota window resets mid-run; otherwise report not_identifiable",
    usageFields: USAGE_FIELDS,
  },
  arms: {
    L1: { outputTargetTokens: 250, paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 0, count: 3 }] },
    L2: { outputTargetTokens: 2000, paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 0, count: 3 }] },
    L3: { outputTargetTokens: 8000, paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 0, count: 3 }] },
  },
  intendedPaidCalls: 12,
  observationCost: "unknown",
  requests: [
    req("L1", "establish unique prefix (cache write)", "write", 0, 1, "unique-prefix-O1"),
    req("L1", "bounded-output request on the same prefix", "work", 0, 3, "unique-prefix-O1", "target ~250 output tokens, hard stop at the level cap"),
    gauge("L1", -1, "pre-level gauge; no model request"),
    gauge("L1", 1, "post-level gauge; delayed ticks recorded, not attributed yet"),
    req("L2", "establish unique prefix (cache write)", "write", 0, 1, "unique-prefix-O2"),
    req("L2", "bounded-output request on the same prefix", "work", 0, 3, "unique-prefix-O2", "target ~2000 output tokens"),
    gauge("L2", -1, "pre-level gauge"),
    gauge("L2", 1, "post-level gauge"),
    req("L3", "establish unique prefix (cache write)", "write", 0, 1, "unique-prefix-O3"),
    req("L3", "bounded-output request on the same prefix", "work", 0, 3, "unique-prefix-O3", "target ~8000 output tokens"),
    gauge("L3", -1, "pre-level gauge"),
    gauge("L3", 1, "post-level gauge"),
  ],
  expectedRequests: 12,
  expectedObservations: 6,
  spend: spend("output coefficient identifiable only under constant input/read/write and a single uninterrupted quota window"),
  budget: budget(),
  stopConditions: [
    "any quota meter resets or rolls over mid-run: abort, mark the run invalid, do not stitch windows",
    "a level exceeds its output cap or returns a truncated/refused response: stop that level, record as failed, do not retry automatically",
    "a second session or background worker touches the same account: abort before the next level",
    "cumulative spend cannot be checked against a cap because the budget unit is unconfigured: never start",
  ],
  contamination: [
    "concurrent requests on the same account make gauge deltas unattributable",
    "a shared system prefix hit inflates cache read and shrinks the apparent uncached input",
    "gauge rounding and delayed ticks can push a level's cost into the next level's window",
  ],
  approval: {
    measures: "output quota contribution (k_output) with input/read/write held constant",
    callPlan: "3 levels x (1 prefix-establishing write + 3 bounded-output requests) = 12 paid requests, plus 6 quota-meter readings whose own cost is unknown",
    budgetUnitAndCap: "all five settings unconfigured: maxProactiveSpendPerIdle and maxTotalExperimentalSpend (spend unit), maxResumeDelay (time unit), allowedQualityDegradation (quality unit), minimumEvidenceForEnforcement (evidence unit); each numeric value needs its own unit and a current approval before the run",
    stopCondition: "quota reset, truncated/refused output, concurrent account use, or an unconfigured cap",
    ifNotExecuted: "k_output stays unknown; DP output terms keep a scenario range instead of a coefficient, and no report may claim an output-side quota saving",
  },
  executable: false,
  blockedBy: BLOCKED_BY,
}

const fableWriteTick = {
  id: "fable-write-tick",
  title: "Fable delayed cache-write ticks, 1h and 5m lanes kept apart",
  preparedAt: PREPARED_AT,
  measures: [
    "how many gauge ticks one Fable cache write costs, including ticks that land after the response",
    "whether the delayed +0.02 belongs to the same write or to a neighbouring request/reset boundary",
  ],
  design: {
    hypotheses: [
      "6-tick: the delayed +0.02 belongs to a neighbouring request or a reset boundary",
      "8-tick: the delayed +0.02 is part of the same write and lands after the response",
    ],
    gaugeDelay: "the gauge is sampled before the write and repeatedly afterwards so a late tick is captured rather than assumed",
    isolation: "one write per observation window, no other request on the account, window never crosses a reset boundary",
    laneSeparation: "the 5m write coefficient is never reused as the 1h lane default; each lane is its own record",
    usageFields: USAGE_FIELDS,
  },
  arms: {
    "fable-write-1h": { ttlLane: "1h", paidCalls: [{ offsetMin: 0, count: 1 }] },
    "fable-write-5m": { ttlLane: "5m", paidCalls: [{ offsetMin: 0, count: 1 }] },
  },
  intendedPaidCalls: 2,
  observationCost: "unknown",
  requests: [
    gauge("fable-write-1h", -1, "baseline gauge, at least one reset-free minute before the write"),
    req("fable-write-1h", "single 1h-lane cache write on a unique prefix", "write", 0, 1, "unique-prefix-F1"),
    gauge("fable-write-1h", 1, "immediate post-write gauge"),
    gauge("fable-write-1h", 3, "early delayed-tick window"),
    gauge("fable-write-1h", 10, "late delayed-tick window"),
    gauge("fable-write-1h", 30, "settle check"),
    gauge("fable-write-1h", 60, "final settle check; any tick after this is unattributable"),
    gauge("fable-write-5m", -1, "baseline gauge"),
    req("fable-write-5m", "single 5m-lane cache write on a unique prefix", "write", 0, 1, "unique-prefix-F2"),
    gauge("fable-write-5m", 1, "immediate post-write gauge"),
    gauge("fable-write-5m", 3, "early delayed-tick window"),
    gauge("fable-write-5m", 10, "late delayed-tick window"),
    gauge("fable-write-5m", 30, "settle check"),
    gauge("fable-write-5m", 60, "final settle check"),
  ],
  expectedRequests: 2,
  expectedObservations: 12,
  spend: spend("tick attribution is identifiable only inside a single-request, reset-free window; otherwise both hypotheses are reported"),
  budget: budget(),
  stopConditions: [
    "any other request touches the account inside an observation window: discard that window",
    "a reset boundary falls inside the window: discard, do not reassign the tick",
    "the gauge does not settle by t+60min: report unresolved, keep both hypotheses",
  ],
  contamination: [
    "a neighbouring request's own delayed tick can be misread as this write's tick",
    "gauge rounding can hide or merge single ticks",
    "reusing the 5m coefficient for the 1h lane would fabricate a measurement",
  ],
  approval: {
    measures: "per-write gauge ticks for Fable, 1h and 5m lanes separately",
    callPlan: "2 paid cache writes (one per lane) plus 12 gauge readings; no other request may run in the windows",
    budgetUnitAndCap: "all five settings unconfigured; the spend cap must be expressed in the same meter as the quota gauge, and maxResumeDelay keeps its own time unit",
    stopCondition: "any other request, any reset boundary inside a window, or an unsettled gauge at t+60min",
    ifNotExecuted: "the 6/8-tick question stays open, both attribution hypotheses remain in the evidence record, and no write coefficient may be quoted as measured",
  },
  executable: false,
  blockedBy: BLOCKED_BY,
}

const ttlUniquePrefix = {
  id: "ttl-1h-unique-prefix",
  title: "1h TTL renewal on a unique prefix: t0/t55/t110 treatment vs t0/t110 control",
  preparedAt: PREPARED_AT,
  measures: [
    "whether a t+55min ping renews the 1h TTL of the target prefix",
    "hit/write difference on the target prefix at t+110min between treatment and control",
    "which TTL lane the request actually used",
  ],
  design: {
    noExtraProbes: true,
    probeBudget: 1,
    uniquePrefixes: "two same-length but different unique prefixes, one per arm, so neither arm can read the other's cache",
    sharedSystemPrefixHitIsNotUniqueSegmentHit: true,
    sharedSystemPrefixWarning: "a hit on the shared system/skill prefix is not a hit on the unique experiment segment; attribute hits only to the unique segment",
    ttlEvidence: "record request arrival time, response model id, lane and per-request usage; never infer renewal from stop_reason or message end time alone",
    invalidation: "a late or errored step breaks the timing contract; mark the run invalid rather than adjusting the schedule",
    singleObservation: "one observation does not establish TTL behaviour for every session",
    usageFields: USAGE_FIELDS,
  },
  arms: {
    treatment: { prefix: "unique-prefix-A", paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 55, count: 1 }, { offsetMin: 110, count: 1 }] },
    control: { prefix: "unique-prefix-B", paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 110, count: 1 }] },
  },
  intendedPaidCalls: 5,
  observationCost: "unknown",
  requests: [
    req("treatment", "t0 write of unique prefix A", "write", 0, 1, "unique-prefix-A", "1h lane requested explicitly"),
    req("treatment", "t+55min ping on prefix A", "probe", 55, 1, "unique-prefix-A", "smallest viable request; the only intermediate probe in the design"),
    req("treatment", "t+110min check on prefix A", "check", 110, 1, "unique-prefix-A", "reads hit/write on the unique segment"),
    req("control", "t0 write of unique prefix B", "write", 0, 1, "unique-prefix-B", "1h lane requested explicitly"),
    req("control", "t+110min check on prefix B", "check", 110, 1, "unique-prefix-B", "no intermediate request may touch prefix B"),
    gauge("treatment", -1, "pre-run gauge"),
    gauge("treatment", 111, "post-run gauge"),
    gauge("control", -1, "pre-run gauge"),
    gauge("control", 111, "post-run gauge"),
  ],
  expectedRequests: 5,
  expectedObservations: 4,
  spend: spend("renewal is identifiable only if no request other than the planned five touches either prefix"),
  budget: budget(),
  stopConditions: [
    "any request outside the five planned ones touches either prefix: the run is void, no extra probe is added to 'check'",
    "a step lands outside its time window: mark invalid, do not reschedule inside the same run",
    "the response model or lane changes between steps: void, prefix identity is no longer the same",
    "a step fails or is refused: stop, do not auto-retry, the cache state is unknown afterwards",
  ],
  contamination: [
    "an intermediate probe can itself renew the TTL, which is exactly why only the planned t+55min ping exists",
    "a shared system prefix hit can be mistaken for a unique-segment hit",
    "a concurrent session on the same account can renew or evict either prefix",
    "clock skew between the request arrival and the gauge timestamp can misplace a step inside the TTL window",
  ],
  approval: {
    measures: "1h TTL renewal by a mid-window ping on a unique prefix",
    callPlan: "treatment 3 paid requests (t0 write, t+55min ping, t+110min check) and control 2 paid requests (t0 write, t+110min check) = 5 total, plus 4 gauge readings; no other probe is permitted",
    budgetUnitAndCap: "all five settings unconfigured; the spend cap must cover exactly 5 paid requests including two large prefix writes, with maxResumeDelay in a time unit",
    stopCondition: "any unplanned request on either prefix, a missed time window, a lane/model change, or a failed step",
    ifNotExecuted: "TTL renewal stays uncertain; the engine keeps warm/cold/uncertain as three states and no enforcement may rely on ping-based renewal",
  },
  executable: false,
  blockedBy: BLOCKED_BY,
}

const restoreDecomposition = {
  id: "restore-decomposition",
  title: "Restore cost decomposition by phase, park path vs raw path",
  preparedAt: PREPARED_AT,
  measures: [
    "per-request usage inside each phase boundary, not an estimated Rw/Rr pair",
    "where the restore phase actually ends, i.e. the first substantive work event",
    "whether system and skill prompts are counted twice across phases",
  ],
  design: {
    phases: ["warm", "park_parent", "restore_child", "resume_raw", "useful_work"],
    firstUsefulWork: "the first task-defined edit/command/verification, not merely the first response or first tool call; the same definition applies to both paths",
    perRequestUsageFields: USAGE_FIELDS,
    overlapChecks: [
      { id: "system_skill_prompt_not_double_counted", phases: ["park_parent", "restore_child"], rule: "system prompt and skill prompt tokens must not be counted in both phases" },
      { id: "restore_ids_disjoint_from_useful_work", phases: ["restore_child", "useful_work"], rule: "restore request ids must not overlap useful_work request ids" },
      { id: "parent_reads_logged_per_call", phases: ["park_parent"], rule: "parent large-context reads are recorded per call with hit/write separated, never as one lump" },
    ],
    comparability: "both paths must reach the same task-completion endpoint before any total is compared",
  },
  arms: {
    park_path: { paidCalls: [{ offsetMin: 0, count: 3 }, { offsetMin: 0, count: 3 }, { offsetMin: 0, count: 6 }] },
    raw_path: { paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 0, count: 6 }] },
  },
  intendedPaidCalls: 19,
  observationCost: "unknown",
  requests: [
    req("park_path", "park_parent: handoff generation, verification and save", "work", 0, 3, "parent-session", "each call logged separately with hit/write split"),
    req("park_path", "restore_child: successor start up to the first substantive work", "work", 0, 3, "child-session", "phase ends at the first substantive work event"),
    req("park_path", "useful_work: same task to the same completion endpoint", "work", 0, 6, "child-session", "cap; exceeding it voids the comparison"),
    gauge("park_path", -1, "pre-run gauge"),
    gauge("park_path", 1, "post-run gauge"),
    req("raw_path", "resume_raw: same task resumed in the original session", "work", 0, 1, "parent-session", "preparation before the first substantive work"),
    req("raw_path", "useful_work: same task to the same completion endpoint", "work", 0, 6, "parent-session", "same cap as the park path"),
    gauge("raw_path", -1, "pre-run gauge"),
    gauge("raw_path", 1, "post-run gauge"),
  ],
  expectedRequests: 19,
  expectedObservations: 4,
  spend: spend("phase totals are additive only if every request belongs to exactly one phase and both paths end at the same completion endpoint"),
  budget: budget(),
  stopConditions: [
    "either path exceeds its useful_work request cap: void the comparison instead of extending it",
    "a phase boundary event is missing: leave those requests unassigned, never spread them across phases",
    "the two paths diverge in task scope or completion endpoint: stop, the totals are not comparable",
    "parent and successor use different models or meters without a common unit: report incomparable",
  ],
  contamination: [
    "system/skill prompt tokens counted in two phases inflate the restore cost",
    "streaming increments plus the final total double count one request",
    "tool result text billed as model output inflates the output side",
  ],
  approval: {
    measures: "actual read/write/output per restore phase and the true restore endpoint",
    callPlan: "park path 12 paid requests (3 park_parent + 3 restore_child + 6 useful_work) and raw path 7 paid requests (1 resume_raw + 6 useful_work) = 19 total, plus 4 gauge readings",
    budgetUnitAndCap: "all five settings unconfigured; spend caps must be stated per meter if the account has several limit windows, and the quality and evidence settings keep their own units",
    stopCondition: "cap exceeded, missing phase boundary, diverging task scope, or incomparable meters",
    ifNotExecuted: "Rw=6K and Rr=125K stay unverified estimates, restore cost keeps an explicit uncertainty range, and no park/raw total may be reported as measured",
  },
  executable: false,
  blockedBy: BLOCKED_BY,
}

const policyEffect = {
  id: "policy-effect",
  title: "Policy effect on the same task with the same restore scope",
  preparedAt: PREPARED_AT,
  measures: [
    "total quota per meter from idle start to the same task completion",
    "actual resume delay after the user returns",
    "failures, re-explanation and rework caused by the policy",
  ],
  design: {
    sameTask: true,
    sameRestoreScope: true,
    outcomes: ["total_quota_per_meter", "resume_delay", "failure_or_reexplanation", "rework"],
    assignment: "one policy per run, never both in one session; runs are paired on the same task definition and the same idle length",
    policySeparation: "the current policy keeps its existing ping behaviour unchanged; the candidate policy is the shadow recommendation executed manually under approval",
    sunkCost: "spend already incurred before the idle point belongs to the budget guard, not to the comparison objective",
    quality: "a run whose quality guard trips (lost context, unacceptable resume delay) counts as a failure, not as a cheaper result",
  },
  arms: {
    current_policy: { usefulWorkRequests: 8, paidCalls: [{ offsetMin: 0, count: 4 }, { offsetMin: 0, count: 8 }] },
    shadow_candidate_policy: { usefulWorkRequests: 8, paidCalls: [{ offsetMin: 0, count: 1 }, { offsetMin: 0, count: 3 }, { offsetMin: 0, count: 8 }] },
  },
  intendedPaidCalls: 24,
  observationCost: "unknown",
  requests: [
    req("current_policy", "existing idle keep-warm pings during the idle window", "probe", 0, 4, "session-prefix", "existing operational behaviour, unchanged"),
    req("current_policy", "useful_work to the shared completion endpoint", "work", 0, 8, "session-prefix", "same task definition as the other arm"),
    gauge("current_policy", -1, "pre-run gauge"),
    gauge("current_policy", 1, "post-run gauge"),
    req("shadow_candidate_policy", "park: handoff generation for the same task", "write", 0, 1, "parent-session"),
    req("shadow_candidate_policy", "restore: successor start to the first substantive work", "work", 0, 3, "child-session"),
    req("shadow_candidate_policy", "useful_work to the shared completion endpoint", "work", 0, 8, "child-session", "same task definition as the other arm"),
    gauge("shadow_candidate_policy", -1, "pre-run gauge"),
    gauge("shadow_candidate_policy", 1, "post-run gauge"),
  ],
  expectedRequests: 24,
  expectedObservations: 4,
  spend: spend("a policy difference is interpretable only when both arms complete the same task and every meter is compared separately"),
  budget: budget(),
  stopConditions: [
    "the two arms no longer share the same task definition or completion endpoint: stop, the totals are not comparable",
    "a quality guard trips (lost context, re-explanation, resume delay beyond the approved limit): record as failure, do not compare totals",
    "the candidate policy would change live operating behaviour rather than being executed manually: stop, shadow stays recording-only",
    "a single pair of runs is treated as a general saving claim: stop reporting, sample size is insufficient",
  ],
  contamination: [
    "running both arms concurrently on one account mixes quota windows",
    "different models or lanes between arms make the totals incomparable without a common meter",
    "a budget rollover inside one arm shifts its remaining call cost and breaks the comparison",
  ],
  approval: {
    measures: "total quota, resume delay and quality outcomes for the current policy versus the shadow candidate on one task",
    callPlan: "current policy 12 paid requests (4 idle pings + 8 useful_work) and candidate policy 12 paid requests (1 park write + 3 restore + 8 useful_work) = 24 total, plus 4 gauge readings",
    budgetUnitAndCap: "all five settings unconfigured; this comparison needs maxTotalExperimentalSpend and maxProactiveSpendPerIdle in a spend unit, maxResumeDelay in a time unit, allowedQualityDegradation in a quality unit and minimumEvidenceForEnforcement in an evidence unit before a run",
    stopCondition: "task scope divergence, quality guard trip, any live policy change, or a generalisation claim from one pair",
    ifNotExecuted: "the policy comparison stays unmeasured; shadow records remain recording-only evidence and may not be reported as a quota saving",
  },
  executable: false,
  blockedBy: BLOCKED_BY,
}

export const PLANS = [outputQuota, fableWriteTick, ttlUniquePrefix, restoreDecomposition, policyEffect]
export const PLAN_IDS = PLANS.map((p) => p.id)

const isStr = (v) => typeof v === "string" && v.length > 0
const isPosInt = (v) => Number.isInteger(v) && v > 0

const isDate = (v) => isStr(v) && Number.isFinite(Date.parse(v))

// Budget rules, kept apart because this is where "unconfigured", "unlimited" and an explicit
// numeric 0 must stay three different things, and where approval currency is decided against an
// injected reference time rather than an ambient clock.
function validateBudget(plan, now, add) {
  const b = plan.budget
  if (!b || typeof b !== "object" || Array.isArray(b)) { add("no_budget_block"); return }
  const limits = b.limits && typeof b.limits === "object" && !Array.isArray(b.limits) ? b.limits : null
  if (!limits) { add("no_budget_limits"); return }

  for (const name of REQUIRED_LIMITS) if (!Object.hasOwn(limits, name)) add("missing_required_limit")
  for (const name of Object.keys(limits)) if (!REQUIRED_LIMITS.includes(name)) add("unknown_limit")
  for (const name of REQUIRED_LIMITS) {
    const limit = limits[name]
    if (!Object.hasOwn(limits, name)) continue
    if (!limit || typeof limit !== "object" || !Object.hasOwn(limit, "value") || !Object.hasOwn(limit, "unit") || !Object.hasOwn(limit, "dimension")) { add("malformed_limit"); continue }
    const state = limitState(limit)
    if (state === "malformed") add("malformed_cap_value")
    if (state === "numeric" && limit.value < 0) add("negative_cap")
    if (limit.dimension !== LIMIT_DIMENSIONS[name]) add("wrong_limit_dimension")
    if (!isStr(limit.unit)) add("malformed_limit_unit")
    else if (state === "numeric") {
      if (limit.unit === "unconfigured") add("numeric_cap_without_unit")
      else if (!(DIMENSION_UNITS[LIMIT_DIMENSIONS[name]] ?? []).includes(limit.unit)) add("wrong_limit_unit_dimension")
    }
  }

  const stateOf = (name) => limitState(limits[name])
  const spendNames = REQUIRED_LIMITS.filter((name) => LIMIT_DIMENSIONS[name] === "spend")
  const spendStates = spendNames.map(stateOf)
  if (spendStates.some((s) => s === "numeric" || s === "unlimited") && spendStates.includes("unconfigured")) add("partial_spend_limits")
  const spendUnits = new Set(spendNames.filter((name) => stateOf(name) === "numeric").map((name) => limits[name].unit))
  if (spendUnits.size > 1) add("budget_unit_conflict")

  const configured = REQUIRED_LIMITS.some((name) => ["numeric", "unlimited"].includes(stateOf(name)))
  const anyUnconfigured = REQUIRED_LIMITS.some((name) => stateOf(name) !== "numeric" && stateOf(name) !== "unlimited")
  if (Array.isArray(plan.blockedBy)) {
    if (!anyUnconfigured && plan.blockedBy.includes("budget_unconfigured")) add("stale_block_reason")
    if (anyUnconfigured && !plan.blockedBy.includes("budget_unconfigured")) add("missing_block_reason")
  }

  if (b.approvedAt !== null && !isDate(b.approvedAt)) add("malformed_approval_timestamp")
  if (b.approvalExpiresAt !== null && !isDate(b.approvalExpiresAt)) add("malformed_approval_timestamp")
  const approvedAt = isDate(b.approvedAt) ? Date.parse(b.approvedAt) : null
  const expiresAt = isDate(b.approvalExpiresAt) ? Date.parse(b.approvalExpiresAt) : null
  const preparedAt = isDate(plan.preparedAt) ? Date.parse(plan.preparedAt) : null
  if (configured && approvedAt === null) add("cap_without_approval")
  if (configured && expiresAt === null) add("approval_without_expiry")
  if (!configured && (approvedAt !== null || expiresAt !== null)) add("approval_without_cap")
  // An approval that has not been granted yet at the reference time is not a current approval.
  if (approvedAt !== null && approvedAt > now) add("future_budget_approval")
  // An old preparation date cannot make an expired approval current: expiry is judged against now.
  if (expiresAt !== null && (!(expiresAt > now) || (approvedAt !== null && !(expiresAt > approvedAt)) || (preparedAt !== null && !(expiresAt > preparedAt)))) add("stale_budget_approval")
}

// Returns a list of issue codes; [] means the plan may be printed as a dry-run plan.
// It never throws on malformed input and it never makes a plan executable.
// `now` is injected so approval expiry is deterministic and testable.
export function validatePlan(plan, { now = Date.now() } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["not_a_plan_object"]
  const issues = []
  const add = (code) => { if (!issues.includes(code)) issues.push(code) }

  if (!isStr(plan.id) || !/^[a-z0-9-]+$/.test(plan.id)) add("bad_plan_id")
  if (!isDate(plan.preparedAt)) add("malformed_prepared_at")
  if (plan.observationCost !== "unknown") add("unsupported_observation_cost")
  if (!isStr(plan.title)) add("bad_plan_title")
  if (!Array.isArray(plan.measures) || plan.measures.length === 0) add("no_measures")
  if (plan.executable !== false) add("executable_must_be_false")
  if (!Array.isArray(plan.blockedBy) || plan.blockedBy.length === 0) add("no_block_reason")
  if (!Array.isArray(plan.stopConditions) || plan.stopConditions.length === 0) add("no_stop_conditions")
  if (!Array.isArray(plan.contamination) || plan.contamination.length === 0) add("no_contamination_conditions")

  const approval = plan.approval
  if (!approval || typeof approval !== "object") add("incomplete_approval_row")
  else for (const field of ["measures", "callPlan", "budgetUnitAndCap", "stopCondition", "ifNotExecuted"]) {
    if (!isStr(approval[field])) add("incomplete_approval_row")
  }

  const sp = plan.spend
  if (!sp || typeof sp !== "object") add("no_spend_block")
  else {
    if (!["coefficient_dependent", "unknown"].includes(sp.status)) add("unsupported_spend_status")
    if (sp.measuredQuotaEstimate !== null) add("invented_measured_quota")
    if (!Array.isArray(sp.requiredCoefficients) || sp.requiredCoefficients.length === 0) add("no_required_coefficients")
  }

  validateBudget(plan, now, add)

  if (!Array.isArray(plan.requests) || plan.requests.length === 0) {
    add("no_requests")
    return issues
  }
  const arms = plan.arms && typeof plan.arms === "object" ? plan.arms : {}
  if (Object.keys(arms).length === 0) add("no_arms")
  for (const r of plan.requests) {
    if (!r || typeof r !== "object") { add("bad_request"); continue }
    if (!isStr(r.label)) add("bad_request_label")
    if (!PAID_KINDS.includes(r.kind) && r.kind !== "observation") add("bad_request_kind")
    if (r.paid !== (r.kind !== "observation")) add("paid_flag_mismatch")
    if (r.cost !== (r.kind === "observation" ? "unknown" : "coefficient_dependent")) add("unsupported_request_cost")
    if (!isPosInt(r.count)) add("bad_request_count")
    if (!Number.isInteger(r.offsetMin) || (r.paid && r.offsetMin < 0)) add("bad_request_offset")
    if (!isStr(r.arm) || !Object.hasOwn(arms, r.arm)) add("unknown_arm")
  }
  const paid = plan.requests.filter((r) => r && r.paid === true)
  const observed = plan.requests.filter((r) => r && r.paid === false)
  const total = (list) => list.reduce((a, r) => a + (isPosInt(r.count) ? r.count : 0), 0)
  if (plan.expectedRequests !== total(paid)) add("expected_request_total_mismatch")
  if (plan.expectedObservations !== total(observed)) add("expected_observation_total_mismatch")
  // The per-arm call plan is the contract that forbids extra requests. It pins multiplicity as
  // well as timing, so a second call at an already-approved offset fails here even when the
  // caller adjusts the totals to match.
  const callKey = (list) => list.map((c) => `t${c?.offsetMin}x${c?.count}`).sort().join("|")
  for (const [name, arm] of Object.entries(arms)) {
    const declared = Array.isArray(arm?.paidCalls) ? arm.paidCalls : null
    if (!declared) { add("no_declared_arm_calls"); continue }
    if (callKey(declared) !== callKey(paid.filter((r) => r.arm === name))) add("arm_call_plan_mismatch")
  }
  const declaredCalls = Object.values(arms).reduce((a, arm) => a + (Array.isArray(arm?.paidCalls) ? arm.paidCalls.reduce((x, c) => x + (isPosInt(c?.count) ? c.count : 0), 0) : 0), 0)
  if (!isPosInt(plan.intendedPaidCalls)) add("bad_intended_call_count")
  else if (plan.intendedPaidCalls !== declaredCalls || plan.intendedPaidCalls !== total(paid)) add("intended_call_count_mismatch")
  if (isPosInt(plan.design?.probeBudget)) {
    const probes = total(paid.filter((r) => r.kind === "probe"))
    if (probes !== plan.design.probeBudget) add("probe_count_mismatch")
  }
  return issues
}

// The machine surface of a plan: consumers read these fields, not the printed layout.
export function planSummary(plan, { now = Date.now() } = {}) {
  return {
    id: plan.id,
    executable: plan.executable === true,
    paidRequests: plan.expectedRequests,
    intendedPaidCalls: plan.intendedPaidCalls,
    observations: plan.expectedObservations,
    observationCost: plan.observationCost,
    spendAllowance: spendAllowance(plan.budget),
    measuredQuotaEstimate: plan.spend.measuredQuotaEstimate,
    blockedBy: plan.blockedBy,
    validation: validatePlan(plan, { now }),
  }
}

const pad = (label) => `  ${label.padEnd(23)}: `
const row = (label, value) => `${pad(label)}${value}`
const bullets = (label, items) => [`${pad(label).trimEnd()}`, ...items.map((i) => `    - ${i}`)]
const fmtLimit = (limit) => `${limit.value} ${limit.value === "unconfigured" ? "(unit unconfigured)" : `(${limit.unit})`} [${limit.dimension}]`

export function renderPlan(plan, { now = Date.now() } = {}) {
  const summary = planSummary(plan, { now })
  const issues = summary.validation
  const at = (r) => `t${r.offsetMin >= 0 ? "+" : ""}${r.offsetMin}min`
  const lines = [
    `=== ${plan.id} - ${plan.title} ===`,
    row("executable", "false"),
    row("blocked by", plan.blockedBy.join(", ")),
    row("plan validation", issues.length === 0 ? "ok" : `FAILED: ${issues.join(", ")}`),
    ...bullets("measures", plan.measures),
    row("machine", `plan=${summary.id} executable=${summary.executable} paidRequests=${summary.paidRequests} intendedPaidCalls=${summary.intendedPaidCalls} observations=${summary.observations} observationCost=${summary.observationCost} spendAllowance=${summary.spendAllowance}`),
    row("expected paid requests", `${plan.expectedRequests} (fixed design: ${plan.intendedPaidCalls} intended calls)`),
    row("meter observations", `${plan.expectedObservations} (meter readings, not model requests; per-observation cost ${plan.observationCost}, not free)`),
    `${pad("request plan").trimEnd()}`,
  ]
  for (const r of plan.requests) {
    const tag = r.paid ? `${r.kind}`.padEnd(6) : "gauge "
    lines.push(`    [${r.arm}] ${at(r).padEnd(9)} ${tag} x${r.count}  ${r.label}${r.note ? ` (${r.note})` : ""}`)
  }
  lines.push(
    row("cost estimate", `${plan.spend.status} - no measured quota figure exists for these lanes`),
    row("cost formula", plan.spend.formula),
    row("needs coefficients", plan.spend.requiredCoefficients.join(", ")),
    row("identifiability", plan.spend.identification),
    row("spend allowance", summary.spendAllowance),
    ...bullets("approval limits", REQUIRED_LIMITS.map((name) => `${name} = ${fmtLimit(plan.budget.limits[name])}`)),
    row("approval window", `approvedAt=${plan.budget.approvedAt} approvalExpiresAt=${plan.budget.approvalExpiresAt}`),
    row("budget note", plan.budget.note),
    ...bullets("stop conditions", plan.stopConditions),
    ...bullets("contamination", plan.contamination),
    `${pad("approval row").trimEnd()}`,
    `    measures         : ${plan.approval.measures}`,
    `    call plan        : ${plan.approval.callPlan}`,
    `    budget unit/cap  : ${plan.approval.budgetUnitAndCap}`,
    `    stop condition   : ${plan.approval.stopCondition}`,
    `    if not executed  : ${plan.approval.ifNotExecuted}`,
    "",
  )
  return lines
}

export function parseArgs(argv) {
  const opts = { execute: false, json: false, help: false, plan: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--execute") opts.execute = true
    else if (a === "--json") opts.json = true
    else if (a === "--help" || a === "-h") opts.help = true
    else if (a === "--plan" || a.startsWith("--plan=")) {
      const value = a === "--plan" ? argv[++i] : a.slice("--plan=".length)
      if (!value) return { ...opts, error: "missing_value: --plan" }
      if (!PLAN_IDS.includes(value)) return { ...opts, error: `unknown_plan: ${value}` }
      opts.plan = value
    } else return { ...opts, error: `unknown_argument: ${a}` }
  }
  return opts
}

const HELP = [
  "idle-experiments - offline planner for approval-gated idle-cost experiments",
  "",
  "  node scripts/idle-experiments.mjs                 print every plan (dry-run, the default)",
  "  node scripts/idle-experiments.mjs --plan=<id>     print one plan",
  "  node scripts/idle-experiments.mjs --json          machine-readable dry-run",
  "  node scripts/idle-experiments.mjs --execute       refused; this planner cannot run experiments",
  "",
  `  plans: ${PLAN_IDS.join(", ")}`,
  "  This planner has no request adapter, no network client, no timer and no scheduler.",
]

// Pure: returns the streams and the exit code instead of writing or exiting.
export function runCli(argv = [], { now = Date.now() } = {}) {
  const result = { code: 0, out: [], err: [], requestsIssued: 0, executed: false, mode: "dry-run" }
  // Execution is refused before anything else is parsed, so no other flag - not even --help -
  // can turn an --execute invocation into a zero exit.
  if (argv.includes("--execute")) {
    result.code = 2
    result.mode = "refused"
    result.executed = false
    result.err.push(
      "idle-experiments: refused - --execute is not an available mode, whatever else is on the command line.",
      "  reason: no_execution_approval (no approved scope for paid requests accompanies this planner)",
      "  reason: budget_unconfigured (every approval limit is unconfigured; that is neither 0 nor unlimited)",
      "  reason: no_request_adapter (this file has no network client, no timer and no scheduler, so it cannot run an experiment)",
      "  paidRequestsIssued=0 executed=false",
      "  every plan stays executable=false; approval belongs in docs/idle-experiments.md and the run belongs to a separately reviewed runner.",
    )
    return result
  }
  const opts = parseArgs(argv)
  if (opts.error) {
    result.code = 2
    result.mode = "usage-error"
    result.err.push(`idle-experiments: ${opts.error}`, ...HELP)
    return result
  }
  if (opts.help) {
    result.mode = "help"
    result.out.push(...HELP)
    return result
  }
  const plans = opts.plan ? PLANS.filter((p) => p.id === opts.plan) : PLANS
  const summaries = plans.map((p) => planSummary(p, { now }))
  const totals = {
    plans: plans.length,
    paidRequestsPlanned: plans.reduce((a, p) => a + p.expectedRequests, 0),
    paidRequestsIssued: 0,
    observations: plans.reduce((a, p) => a + p.expectedObservations, 0),
    executable: summaries.filter((s) => s.executable).length,
  }
  if (opts.json) {
    result.out.push(JSON.stringify({
      mode: "dry-run",
      executed: false,
      requestsIssued: 0,
      networkAdapter: null,
      scheduler: null,
      observationCostBasis: "unmetered_in_this_repository",
      generatedBy: "scripts/idle-experiments.mjs",
      validatedAt: new Date(now).toISOString(),
      totals,
      summaries,
      plans: plans.map((p) => ({ ...p, validation: validatePlan(p, { now }) })),
    }, null, 2))
  } else {
    result.out.push("idle-experiments: dry-run (default). No experiment runs from this file.", "")
    for (const p of plans) result.out.push(...renderPlan(p, { now }))
    result.out.push(
      `totals: plans=${totals.plans} paidRequestsPlanned=${totals.paidRequestsPlanned} paidRequestsIssued=${totals.paidRequestsIssued} executable=${totals.executable}`,
      "All cost lines are coefficient-dependent; no measured quota estimate exists. Every approval limit is unconfigured, which is neither 0 nor unlimited.",
      "Meter readings are not model requests, but their cost is unknown here, not free.",
      "Use --execute to see the refusal path; it exits nonzero and still runs nothing.",
    )
  }
  const invalid = summaries.filter((s) => s.validation.length > 0)
  if (invalid.length > 0) {
    result.code = 3
    result.err.push(...invalid.map((s) => `idle-experiments: plan ${s.id} failed validation: ${s.validation.join(", ")}`))
  }
  return result
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = runCli(process.argv.slice(2))
  for (const line of r.out) console.log(line)
  for (const line of r.err) console.error(line)
  process.exitCode = r.code
}
