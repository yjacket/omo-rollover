// Safety contract for the offline experiment planner.
// The planner must never issue a paid request, open a socket, or schedule anything:
// these tests assert the refusal paths, the plan schema, and the absence of side effects.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { PLANS, REQUIRED_LIMITS, validatePlan, parseArgs, runCli, planSummary, limitState, spendAllowance } from "../scripts/idle-experiments.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, "..", "scripts", "idle-experiments.mjs")
const byId = (id) => PLANS.find((p) => p.id === id)
const REQUIRED_PLANS = ["output-quota", "fable-write-tick", "ttl-1h-unique-prefix", "restore-decomposition", "policy-effect"]
const LIMIT_DIMENSIONS = { maxProactiveSpendPerIdle: "spend", maxTotalExperimentalSpend: "spend", maxResumeDelay: "time", allowedQualityDegradation: "quality", minimumEvidenceForEnforcement: "evidence" }
const paidOf = (plan) => plan.requests.filter((r) => r.paid)
const offsets = (plan, arm) => paidOf(plan).filter((r) => r.arm === arm).map((r) => r.offsetMin).sort((a, b) => a - b)
// Validation time is injected, never read from the wall clock, so approval expiry is deterministic.
const REF_NOW = Date.parse("2026-09-20T00:00:00Z")
const v = (plan, now = REF_NOW) => validatePlan(plan, { now })
const clone = (id) => JSON.parse(JSON.stringify(byId(id)))
const withPlan = (id, mutate, now = REF_NOW) => { const p = clone(id); mutate(p); return v(p, now) }
// An approved budget fixture: explicit numeric limits, each with its own unit and dimension.
const configuredBudget = ({ spend = 0, spendUnit = "quota_fraction", approvedAt = "2026-09-19T12:00:00Z", approvalExpiresAt = "2026-12-31T00:00:00Z" } = {}) => ({
  limits: {
    maxProactiveSpendPerIdle: { value: spend, unit: spendUnit, dimension: "spend" },
    maxTotalExperimentalSpend: { value: spend, unit: spendUnit, dimension: "spend" },
    maxResumeDelay: { value: 0, unit: "ms", dimension: "time" },
    allowedQualityDegradation: { value: 0, unit: "lost_context_events", dimension: "quality" },
    minimumEvidenceForEnforcement: { value: 3, unit: "paired_runs", dimension: "evidence" },
  },
  approvedAt,
  approvalExpiresAt,
  note: "explicit numeric limits; 0 means zero allowed spend, not 'unconfigured' and not 'unlimited'",
})
// A configured budget also retires the budget_unconfigured block reason, so both stay consistent.
const fund = (plan, opts) => { plan.budget = configuredBudget(opts); plan.blockedBy = ["no_execution_approval", "coefficients_unknown"] }
// Temp cwd is always removed, even when an assertion throws.
const inTempCwd = (fn) => {
  const cwd = mkdtempSync(join(tmpdir(), "idle-exp-"))
  try { return fn(cwd) } finally { rmSync(cwd, { recursive: true, force: true }) }
}
// Run the CLI as a real child process, bounded: a scheduler or a wait would be killed and reported.
const cli = (args, cwd) => {
  try {
    return { code: 0, signal: null, out: execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, killSignal: "SIGKILL" }) }
  } catch (e) {
    return { code: e.status ?? -1, signal: e.signal ?? null, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

test("every shipped plan is non-executable, blocked, and valid", () => {
  assert.equal(PLANS.length, REQUIRED_PLANS.length)
  for (const plan of PLANS) {
    assert.equal(plan.executable, false, `${plan.id} must never be executable`)
    assert.ok(plan.blockedBy.includes("no_execution_approval"), `${plan.id} must state the approval block`)
  }
  assert.deepEqual(PLANS.map((p) => p.id), REQUIRED_PLANS)
  for (const plan of PLANS) assert.deepEqual(v(plan), [], `${plan.id} must validate`)
})

test("paid model requests and meter observations are counted apart, and observation cost stays unknown", () => {
  for (const plan of PLANS) {
    const paid = paidOf(plan).reduce((a, r) => a + r.count, 0)
    const obs = plan.requests.filter((r) => !r.paid).reduce((a, r) => a + r.count, 0)
    assert.equal(plan.expectedRequests, paid, `${plan.id} paid request total`)
    assert.equal(plan.expectedObservations, obs, `${plan.id} observation total`)
    assert.equal(plan.observationCost, "unknown", `${plan.id} must not price meter observations`)
    for (const r of plan.requests) {
      assert.equal(r.paid, r.kind !== "observation", `${plan.id}/${r.label} paid flag follows kind`)
      assert.equal(r.cost, r.paid ? "coefficient_dependent" : "unknown", `${plan.id}/${r.label} cost status`)
    }
  }
  // An unsupported zero price for a meter observation must be rejected, not printed.
  assert.ok(withPlan("output-quota", (p) => { p.observationCost = 0 }).includes("unsupported_observation_cost"))
  assert.ok(withPlan("output-quota", (p) => { p.observationCost = "free" }).includes("unsupported_observation_cost"))
  assert.ok(withPlan("output-quota", (p) => { p.requests.find((r) => !r.paid).cost = 0 }).includes("unsupported_request_cost"))
})

// The cost of a meter reading is unknown, and that is asserted on the machine fields only.
// Whether the shipped prose contradicts them is a review question, not an automated phrase check.
test("no shipped plan path prices a meter observation, on the data or through the real CLI", () => {
  for (const plan of PLANS) {
    assert.equal(plan.observationCost, "unknown", `${plan.id} observation cost`)
    for (const r of plan.requests.filter((r) => !r.paid)) assert.equal(r.cost, "unknown", `${plan.id}/${r.label}`)
  }
  inTempCwd((cwd) => {
    const json = cli(["--json"], cwd)
    assert.equal(json.code, 0)
    const doc = JSON.parse(json.out)
    assert.equal(doc.observationCostBasis, "unmetered_in_this_repository")
    for (const s of doc.summaries) assert.equal(s.observationCost, "unknown", `${s.id} summary`)
  })
})

test("no plan claims a measured quota estimate", () => {
  for (const plan of PLANS) {
    assert.equal(plan.spend.measuredQuotaEstimate, null, `${plan.id} must not carry a measured number`)
    assert.ok(["coefficient_dependent", "unknown"].includes(plan.spend.status), `${plan.id} spend status`)
    assert.ok(plan.spend.requiredCoefficients.length > 0)
  }
})

test("all five approval limits exist, stay unconfigured, and carry their own dimension and unit", () => {
  assert.deepEqual([...REQUIRED_LIMITS].sort(), Object.keys(LIMIT_DIMENSIONS).sort())
  for (const plan of PLANS) {
    assert.deepEqual(Object.keys(plan.budget.limits).sort(), Object.keys(LIMIT_DIMENSIONS).sort(), `${plan.id} limits`)
    for (const [name, limit] of Object.entries(plan.budget.limits)) {
      assert.equal(limit.value, "unconfigured", `${plan.id}.${name} value`)
      assert.equal(limit.unit, "unconfigured", `${plan.id}.${name} unit`)
      assert.equal(limit.dimension, LIMIT_DIMENSIONS[name], `${plan.id}.${name} dimension`)
      assert.equal(limitState(limit), "unconfigured", `${plan.id}.${name} state`)
    }
    assert.equal(plan.budget.approvedAt, null)
    assert.equal(plan.budget.approvalExpiresAt, null)
    assert.equal(spendAllowance(plan.budget), "unconfigured", `${plan.id} spend allowance`)
    assert.ok(plan.blockedBy.includes("budget_unconfigured"), `${plan.id} block reason matches its budget state`)
  }
})

test("an explicit zero cap is a valid zero-spend configuration, not 'unconfigured' and not 'unlimited'", () => {
  const p = clone("ttl-1h-unique-prefix")
  fund(p, { spend: 0 })
  assert.deepEqual(v(p), [], "zero allowed spend is a legitimate explicit configuration")
  assert.equal(limitState(p.budget.limits.maxTotalExperimentalSpend), "numeric")
  assert.equal(spendAllowance(p.budget), "zero")
  assert.notEqual(spendAllowance(p.budget), spendAllowance(byId("ttl-1h-unique-prefix").budget))
  const unlimited = clone("ttl-1h-unique-prefix")
  fund(unlimited, { spend: "unlimited" })
  assert.equal(limitState(unlimited.budget.limits.maxTotalExperimentalSpend), "unlimited")
  assert.equal(spendAllowance(unlimited.budget), "unlimited")
  const positive = clone("ttl-1h-unique-prefix")
  fund(positive, { spend: 0.25 })
  assert.equal(spendAllowance(positive.budget), "positive")
  // A funded budget never makes this offline planner executable.
  assert.equal(p.executable, false)
  assert.notEqual(runCli(["--execute"]).code, 0)
})

test("a zero spend cap binds the whole allowance, whatever the other spend cap says", () => {
  // A total of zero cannot permit positive spend just because the per-idle cap is positive.
  const totalZero = clone("ttl-1h-unique-prefix")
  fund(totalZero, { spend: 1 })
  totalZero.budget.limits.maxTotalExperimentalSpend.value = 0
  assert.deepEqual(v(totalZero), [], "a zero total beside a positive per-idle cap is a legitimate configuration")
  assert.equal(spendAllowance(totalZero.budget), "zero", "a zero total experimental spend cap binds")
  assert.equal(planSummary(totalZero, { now: REF_NOW }).spendAllowance, "zero", "the machine surface reports the binding cap")
  // The mirror case: a zero per-idle cap binds even when the total is positive.
  const perIdleZero = clone("ttl-1h-unique-prefix")
  fund(perIdleZero, { spend: 2 })
  perIdleZero.budget.limits.maxProactiveSpendPerIdle.value = 0
  assert.equal(spendAllowance(perIdleZero.budget), "zero", "a zero per-idle cap binds")
  // A zero cap still binds when the other spend limit is unlimited.
  const zeroBesideUnlimited = clone("ttl-1h-unique-prefix")
  fund(zeroBesideUnlimited, { spend: 0 })
  zeroBesideUnlimited.budget.limits.maxProactiveSpendPerIdle.value = "unlimited"
  assert.equal(spendAllowance(zeroBesideUnlimited.budget), "zero", "unlimited beside zero is still zero")
  // None of these funded budgets make the planner executable.
  assert.equal(totalZero.executable, false)
  assert.notEqual(runCli(["--execute"]).code, 0)
})

test("an approval dated after the reference time is not yet current", () => {
  const future = withPlan("output-quota", (p) => { fund(p, { approvedAt: "2026-09-21T00:00:00Z" }) })
  assert.ok(future.includes("future_budget_approval"), `approval in the future must be rejected, got ${JSON.stringify(future)}`)
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvedAt: "2030-01-01T00:00:00Z", approvalExpiresAt: "2030-06-01T00:00:00Z" }) }).includes("future_budget_approval"))
  // The boundary: an approval stamped exactly at the reference time is current, not future.
  assert.deepEqual(withPlan("output-quota", (p) => { fund(p, { approvedAt: "2026-09-20T00:00:00Z" }) }), [])
  // Same plan, earlier reference time: the very same approval has not happened yet.
  assert.ok(withPlan("output-quota", (p) => { fund(p) }, Date.parse("2026-09-01T00:00:00Z")).includes("future_budget_approval"))
})

test("a block reason that contradicts the budget state is rejected", () => {
  assert.ok(withPlan("output-quota", (p) => { p.budget = configuredBudget() }).includes("stale_block_reason"))
  assert.ok(withPlan("output-quota", (p) => { p.blockedBy = ["no_execution_approval"] }).includes("missing_block_reason"))
})

test("malformed, nonfinite or negative caps are rejected", () => {
  for (const bad of [NaN, Infinity, -Infinity, "5", null, {}, true, []]) {
    const issues = withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxTotalExperimentalSpend.value = bad })
    assert.ok(issues.includes("malformed_cap_value"), `cap value ${String(bad)} must be rejected`)
  }
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxTotalExperimentalSpend.value = -1 }).includes("negative_cap"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxResumeDelay.value = -1 }).includes("negative_cap"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxTotalExperimentalSpend = { value: 1, unit: "quota_fraction" } }).includes("malformed_limit"))
})

test("missing required limits, missing units, wrong dimensions and partial spend limits are rejected", () => {
  for (const name of REQUIRED_LIMITS) {
    assert.ok(withPlan("output-quota", (p) => { delete p.budget.limits[name] }).includes("missing_required_limit"), `${name} is required`)
  }
  assert.ok(withPlan("output-quota", (p) => { p.budget.limits.extraLimit = { value: "unconfigured", unit: "unconfigured", dimension: "spend" } }).includes("unknown_limit"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxTotalExperimentalSpend.unit = "unconfigured" }).includes("numeric_cap_without_unit"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxTotalExperimentalSpend.unit = "" }).includes("malformed_limit_unit"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxResumeDelay.unit = "quota_fraction" }).includes("wrong_limit_unit_dimension"))
  assert.ok(withPlan("output-quota", (p) => { p.budget.limits.maxResumeDelay.dimension = "spend" }).includes("wrong_limit_dimension"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxProactiveSpendPerIdle.value = "unconfigured"; p.budget.limits.maxProactiveSpendPerIdle.unit = "unconfigured" }).includes("partial_spend_limits"))
  assert.ok(withPlan("output-quota", (p) => { fund(p); p.budget.limits.maxProactiveSpendPerIdle.unit = "usd" }).includes("budget_unit_conflict"))
})

test("approval metadata must be well formed and current against the injected reference time", () => {
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvedAt: "not-a-date" }) }).includes("malformed_approval_timestamp"))
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvalExpiresAt: "whenever" }) }).includes("malformed_approval_timestamp"))
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvedAt: null }) }).includes("cap_without_approval"))
  assert.ok(withPlan("output-quota", (p) => { p.budget.approvedAt = "2026-09-19T00:00:00Z" }).includes("approval_without_cap"))
  // An old preparation date cannot make an expired approval current.
  assert.ok(withPlan("output-quota", (p) => { p.preparedAt = "2020-01-01T00:00:00Z"; fund(p, { approvedAt: "2020-01-01T00:00:00Z", approvalExpiresAt: "2020-01-02T00:00:00Z" }) }).includes("stale_budget_approval"))
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvalExpiresAt: "2026-09-19T23:59:59Z" }) }).includes("stale_budget_approval"))
  assert.ok(withPlan("output-quota", (p) => { fund(p, { approvedAt: "2026-09-19T12:00:00Z", approvalExpiresAt: "2026-09-19T11:00:00Z" }) }).includes("stale_budget_approval"))
  assert.deepEqual(withPlan("output-quota", (p) => { fund(p, { approvalExpiresAt: "2026-09-20T00:00:01Z" }) }), [])
  // Same plan, later reference time: the approval is stale. The clock is an input, not ambient state.
  assert.ok(withPlan("output-quota", (p) => { fund(p) }, Date.parse("2027-01-01T00:00:00Z")).includes("stale_budget_approval"))
})

test("stop conditions, contamination conditions and the approval row are all present", () => {
  for (const plan of PLANS) {
    assert.ok(plan.stopConditions.length >= 2, `${plan.id} stop conditions`)
    assert.ok(plan.contamination.length >= 2, `${plan.id} contamination conditions`)
    for (const field of ["measures", "callPlan", "budgetUnitAndCap", "stopCondition", "ifNotExecuted"]) {
      assert.ok(typeof plan.approval[field] === "string" && plan.approval[field].length > 0, `${plan.id} approval.${field}`)
    }
  }
})

test("output quota plan separates input/read/write and varies output over several levels", () => {
  const plan = byId("output-quota")
  const arms = Object.keys(plan.arms)
  assert.ok(arms.length >= 3, "at least three output levels")
  assert.ok(plan.design.separates.includes("uncachedInput") && plan.design.separates.includes("cacheRead") && plan.design.separates.includes("cacheWrite"))
  const levels = arms.map((a) => plan.arms[a].outputTargetTokens)
  assert.deepEqual(levels, [...new Set(levels)].sort((a, b) => a - b), "output levels are distinct and increasing")
  for (const arm of arms) assert.ok(offsets(plan, arm).length >= 2, `${arm} establishes its own prefix before measuring output`)
})

test("fable write tick plan keeps 5m and 1h lanes separate and captures delayed ticks", () => {
  const plan = byId("fable-write-tick")
  assert.deepEqual(Object.keys(plan.arms), ["fable-write-1h", "fable-write-5m"])
  for (const arm of Object.keys(plan.arms)) {
    assert.equal(offsets(plan, arm).length, 1, `${arm} issues exactly one write request`)
    const obs = plan.requests.filter((r) => !r.paid && r.arm === arm).map((r) => r.offsetMin)
    assert.ok(obs.some((o) => o < 0 || o === 0), `${arm} records the gauge before the write`)
    assert.ok(Math.max(...obs) >= 30, `${arm} keeps watching for a delayed tick`)
  }
  assert.ok(plan.design.hypotheses.length === 2, "6-tick and 8-tick attributions stay as two hypotheses")
})

test("1h TTL plan uses unique prefixes, t0/t55/t110 treatment, t0/t110 control and no extra probes", () => {
  const plan = byId("ttl-1h-unique-prefix")
  assert.deepEqual(Object.keys(plan.arms), ["treatment", "control"])
  assert.deepEqual(offsets(plan, "treatment"), [0, 55, 110])
  assert.deepEqual(offsets(plan, "control"), [0, 110])
  assert.equal(plan.expectedRequests, 5)
  const prefixes = paidOf(plan).map((r) => r.prefix)
  assert.equal(new Set(prefixes).size, 2, "one unique prefix per arm, never shared")
  assert.equal(prefixes.filter((p) => p === paidOf(plan)[0].prefix).length, 3)
  assert.equal(paidOf(plan).filter((r) => r.kind === "probe").reduce((a, r) => a + r.count, 0), 1, "the t55 ping is the only probe")
  assert.equal(plan.design.noExtraProbes, true)
  assert.equal(plan.design.sharedSystemPrefixHitIsNotUniqueSegmentHit, true)
})

test("the TTL design fixes exactly five intended calls; extra multiplicity at an approved offset is rejected", () => {
  const plan = byId("ttl-1h-unique-prefix")
  assert.equal(plan.intendedPaidCalls, 5)
  assert.equal(plan.expectedRequests, 5)
  assert.deepEqual(plan.arms.treatment.paidCalls, [{ offsetMin: 0, count: 1 }, { offsetMin: 55, count: 1 }, { offsetMin: 110, count: 1 }])
  assert.deepEqual(plan.arms.control.paidCalls, [{ offsetMin: 0, count: 1 }, { offsetMin: 110, count: 1 }])
  for (const p of PLANS) {
    assert.equal(p.intendedPaidCalls, p.expectedRequests, `${p.id} intended calls match the request total`)
    const declared = Object.values(p.arms).flatMap((a) => a.paidCalls).reduce((a, c) => a + c.count, 0)
    assert.equal(declared, p.intendedPaidCalls, `${p.id} arm call plans sum to the intended total`)
  }
  // A second call at an already-approved offset is still an extra request, even if the totals are adjusted to match.
  const bumped = withPlan("ttl-1h-unique-prefix", (p) => { p.requests[2].count = 2; p.expectedRequests = 6 })
  assert.ok(bumped.includes("arm_call_plan_mismatch"), "per-call multiplicity is validated, not just the offset list")
  assert.ok(bumped.includes("intended_call_count_mismatch"))
  // Adjusting the design number as well does not help: it no longer matches the fixed five-call contract.
  const rewritten = withPlan("ttl-1h-unique-prefix", (p) => { p.requests[2].count = 2; p.expectedRequests = 6; p.intendedPaidCalls = 6 })
  assert.ok(rewritten.includes("arm_call_plan_mismatch"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests.push({ ...p.requests[2], label: "extra t110 check", count: 1 }); p.expectedRequests = 6 }).includes("arm_call_plan_mismatch"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[1].count = 2; p.expectedRequests = 6 }).includes("probe_count_mismatch"))
})

test("restore decomposition plan carries the five phase boundaries and an overlap check", () => {
  const plan = byId("restore-decomposition")
  assert.deepEqual(plan.design.phases, ["warm", "park_parent", "restore_child", "resume_raw", "useful_work"])
  assert.deepEqual(plan.design.overlapChecks.map((c) => c.id), ["system_skill_prompt_not_double_counted", "restore_ids_disjoint_from_useful_work", "parent_reads_logged_per_call"])
  for (const check of plan.design.overlapChecks) {
    assert.ok(check.phases.length > 0, `${check.id} names the phases it guards`)
    for (const phase of check.phases) assert.ok(plan.design.phases.includes(phase), `${check.id} phase ${phase} is a declared phase`)
  }
  assert.deepEqual(Object.keys(plan.arms), ["park_path", "raw_path"])
  assert.deepEqual(plan.design.perRequestUsageFields, ["uncachedInput", "cacheWrite5m", "cacheWrite1h", "cacheRead", "billedModelOutput"])
})

test("policy effect plan holds task and restore scope constant across both policies", () => {
  const plan = byId("policy-effect")
  assert.deepEqual(Object.keys(plan.arms), ["current_policy", "shadow_candidate_policy"])
  assert.equal(plan.design.sameTask, true)
  assert.equal(plan.design.sameRestoreScope, true)
  assert.equal(plan.arms.current_policy.usefulWorkRequests, plan.arms.shadow_candidate_policy.usefulWorkRequests)
  assert.ok(plan.design.outcomes.includes("resume_delay"))
})

test("validatePlan rejects malformed input instead of throwing", () => {
  for (const bad of [null, undefined, 42, "plan", []]) assert.deepEqual(v(bad), ["not_a_plan_object"])
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.id = "Bad Id!" }).includes("bad_plan_id"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests = [] }).includes("no_requests"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests = "t0 write" }).includes("no_requests"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[0].count = -1 }).includes("bad_request_count"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[0].count = 1.5 }).includes("bad_request_count"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[0].offsetMin = "soon" }).includes("bad_request_offset"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.expectedRequests = 99 }).includes("expected_request_total_mismatch"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.expectedObservations = 99 }).includes("expected_observation_total_mismatch"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.stopConditions = [] }).includes("no_stop_conditions"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.approval.ifNotExecuted = "" }).includes("incomplete_approval_row"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.preparedAt = "not-a-date" }).includes("malformed_prepared_at"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { delete p.budget }).includes("no_budget_block"))
})

test("validatePlan refuses an executable plan, an invented measurement and an unplanned request", () => {
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.executable = true }).includes("executable_must_be_false"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.blockedBy = [] }).includes("no_block_reason"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.spend.status = "measured" }).includes("unsupported_spend_status"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.spend.measuredQuotaEstimate = 27.35 }).includes("invented_measured_quota"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.spend.requiredCoefficients = [] }).includes("no_required_coefficients"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests.push({ label: "extra ttl probe", arm: "control", kind: "probe", paid: true, cost: "coefficient_dependent", count: 1, offsetMin: 60, prefix: "unique-prefix-B" }) }).includes("arm_call_plan_mismatch"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[0].arm = "ghost" }).includes("unknown_arm"))
  assert.ok(withPlan("ttl-1h-unique-prefix", (p) => { p.requests[0].paid = false }).includes("paid_flag_mismatch"))
})

test("argument parsing rejects unknown flags and unknown plan ids", () => {
  assert.deepEqual(parseArgs([]), { execute: false, json: false, help: false, plan: null })
  assert.equal(parseArgs(["--execute"]).execute, true)
  assert.equal(parseArgs(["--json"]).json, true)
  assert.equal(parseArgs(["--plan=output-quota"]).plan, "output-quota")
  assert.equal(parseArgs(["--plan", "output-quota"]).plan, "output-quota")
  assert.equal(parseArgs(["--nuke"]).error, "unknown_argument: --nuke")
  assert.equal(parseArgs(["output-quota"]).error, "unknown_argument: output-quota")
  assert.equal(parseArgs(["--plan"]).error, "missing_value: --plan")
  assert.equal(parseArgs(["--plan=ghost"]).error, "unknown_plan: ghost")
  assert.equal(parseArgs(["--execute", "--json"]).execute, true)
})

test("planSummary is the machine surface for every plan", () => {
  for (const plan of PLANS) {
    assert.deepEqual(planSummary(plan, { now: REF_NOW }), {
      id: plan.id,
      executable: false,
      paidRequests: plan.expectedRequests,
      intendedPaidCalls: plan.intendedPaidCalls,
      observations: plan.expectedObservations,
      observationCost: "unknown",
      spendAllowance: "unconfigured",
      measuredQuotaEstimate: null,
      blockedBy: plan.blockedBy,
      validation: [],
    })
  }
})

test("dry-run is the default and emits a machine line per plan", () => {
  const r = runCli([])
  assert.equal(r.code, 0)
  assert.equal(r.mode, "dry-run")
  assert.equal(r.requestsIssued, 0)
  const text = r.out.join("\n")
  for (const p of PLANS) {
    assert.ok(text.includes(`plan=${p.id} executable=false paidRequests=${p.expectedRequests} intendedPaidCalls=${p.intendedPaidCalls} observations=${p.expectedObservations} observationCost=unknown spendAllowance=unconfigured`), `${p.id} machine line`)
  }
  assert.ok(text.includes("totals: plans=5 paidRequestsPlanned=62 paidRequestsIssued=0 executable=0"))
})

test("every --execute path exits nonzero, including with --help, --json or a bad flag", () => {
  for (const args of [["--execute"], ["--execute", "--help"], ["--help", "--execute"], ["--execute", "--json"], ["--execute", "--plan=output-quota"], ["--execute", "--plan=ghost"], ["--execute", "--nuke"]]) {
    const r = runCli(args)
    assert.notEqual(r.code, 0, `${args.join(" ")} must exit nonzero`)
    assert.equal(r.executed, false, `${args.join(" ")} must not execute`)
    assert.equal(r.requestsIssued, 0, `${args.join(" ")} must issue nothing`)
    assert.equal(r.out.length, 0, `${args.join(" ")} must not print a success surface`)
    assert.ok(r.err.join("\n").includes("no_execution_approval"), `${args.join(" ")} states the refusal reason`)
  }
  assert.equal(runCli(["--execute"]).mode, "refused")
  assert.equal(runCli(["--help", "--execute"]).mode, "refused", "help must not outrank the execution refusal")
})

test("--json exposes the machine contract and never a free observation price", () => {
  const r = runCli(["--json"])
  assert.equal(r.code, 0)
  const data = JSON.parse(r.out.join("\n"))
  assert.equal(data.mode, "dry-run")
  assert.equal(data.executed, false)
  assert.equal(data.requestsIssued, 0)
  assert.equal(data.networkAdapter, null)
  assert.equal(data.scheduler, null)
  assert.equal(data.observationCostBasis, "unmetered_in_this_repository")
  assert.deepEqual(data.plans.map((p) => p.id), REQUIRED_PLANS)
  assert.ok(data.plans.every((p) => p.executable === false && p.observationCost === "unknown"))
  assert.deepEqual(data.summaries.map((s) => s.paidRequests), PLANS.map((p) => p.expectedRequests))
  assert.equal(data.totals.paidRequestsPlanned, 62)
  assert.equal(data.totals.paidRequestsIssued, 0)
  assert.equal(data.totals.observations, 30)
})

test("the planner source contains no network, timer, scheduler or write API", () => {
  const src = readFileSync(script, "utf8")
  for (const forbidden of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:child_process", "node:worker_threads", "fetch(", "XMLHttpRequest", "setTimeout(", "setInterval(", "setImmediate(", "Atomics.wait", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "execSync", "spawnSync"]) {
    assert.ok(!src.includes(forbidden), `planner must not reference ${forbidden}`)
  }
})

test("the real CLI terminates on its own and leaves no files behind in any mode", () => {
  inTempCwd((cwd) => {
    const dry = cli([], cwd)
    assert.equal(dry.code, 0)
    assert.equal(dry.signal, null, "the child exits on its own, it is not killed by the bound")
    assert.ok(dry.out.includes("paidRequestsIssued=0"))
    assert.deepEqual(readdirSync(cwd), [])

    const exec = cli(["--execute"], cwd)
    assert.equal(exec.code, 2)
    assert.equal(exec.signal, null)
    assert.ok(exec.out.includes("no_execution_approval"))
    assert.deepEqual(readdirSync(cwd), [], "--execute must not create resources")

    const execHelp = cli(["--execute", "--help"], cwd)
    assert.equal(execHelp.code, 2, "--help must not turn an --execute invocation into a success")
    assert.deepEqual(readdirSync(cwd), [])

    const bad = cli(["--nuke"], cwd)
    assert.equal(bad.code, 2)
    assert.ok(bad.out.includes("unknown_argument"))
    assert.deepEqual(readdirSync(cwd), [])
  })
})
