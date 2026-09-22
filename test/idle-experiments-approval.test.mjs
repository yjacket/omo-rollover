import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { PLAN_IDS, PLANS, planSummary, spendAllowance, validatePlan } from "../scripts/idle-experiments.mjs"

const proposal = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-proposal.json", import.meta.url), "utf8"))
const NOW = Date.parse("2026-09-24T00:00:00Z")

const configuredPlan = (plan, approved = true) => ({
  ...plan,
  budget: {
    ...plan.budget,
    limits: proposal.plans[plan.id].limits,
    approvedAt: approved ? "2026-09-23T00:00:00Z" : null,
    approvalExpiresAt: approved ? "2026-10-23T00:00:00Z" : null,
  },
  blockedBy: plan.blockedBy.filter((block) => block !== "budget_unconfigured"),
})

test("proposal is unsigned", () => {
  assert.equal(proposal.status, "proposed")
  assert.equal(proposal.approvedAt, null)
  assert.equal(proposal.approvalExpiresAt, null)
})

test("proposal order covers every shipped plan once", () => {
  assert.equal(proposal.order.length, PLAN_IDS.length)
  assert.deepEqual([...proposal.order].sort(), [...PLAN_IDS].sort())
})

test("each proposed plan validates with synthetic approval and remains non-executable", () => {
  for (const plan of PLANS) {
    const configured = configuredPlan(plan)
    assert.deepEqual(validatePlan(configured, { now: NOW }), [], plan.id)
    assert.equal(planSummary(configured, { now: NOW }).executable, false, plan.id)
  }
})

test("proposal limits without approval never authorize a plan", () => {
  for (const plan of PLANS) {
    assert.ok(validatePlan(configuredPlan(plan, false), { now: NOW }).includes("cap_without_approval"), plan.id)
  }
})

test("every proposal has positive quota-fraction spend allowance", () => {
  for (const plan of PLANS) {
    const { limits } = proposal.plans[plan.id]
    assert.equal(spendAllowance({ limits }), "positive", plan.id)
    assert.equal(limits.maxProactiveSpendPerIdle.unit, "quota_fraction", plan.id)
    assert.equal(limits.maxTotalExperimentalSpend.unit, "quota_fraction", plan.id)
  }
})

test("cumulative caps exactly cover the target meters", () => {
  assert.deepEqual(Object.keys(proposal.perMeterCumulativeCaps).sort(), [...proposal.target.quotaMeters].sort())
  for (const value of Object.values(proposal.perMeterCumulativeCaps)) {
    assert.ok(Number.isFinite(value) && value > 0 && value <= 1)
  }
})
