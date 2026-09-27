import { createHash } from "node:crypto"
import { PLAN_IDS, PLANS, validatePlan } from "../idle-experiments.mjs"

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
const sha256 = (value) => {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return null
  return createHash("sha256").update(value).digest("hex")
}

const equal = (left, right) => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]))
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
}

const samePlanIds = (order) => Array.isArray(order) && order.length === PLAN_IDS.length && new Set(order).size === PLAN_IDS.length && order.every((id) => PLAN_IDS.includes(id))

const configuredPlan = (plan, approval) => ({
  ...plan,
  budget: {
    ...plan.budget,
    limits: approval.plans?.[plan.id]?.limits,
    approvedAt: approval.approvedAt,
    approvalExpiresAt: approval.approvalExpiresAt,
  },
  blockedBy: plan.blockedBy.filter((block) => block !== "budget_unconfigured"),
})

// Validates an approval artifact supplied by the caller. Inputs are injected so this module
// remains pure and the approval can bind the exact planner and proposal bytes it authorizes.
export function loadApproval(json, { now = Date.now(), plannerSource, proposalJson, capBasisBytes } = {}) {
  const issues = []
  const add = (issue) => { if (!issues.includes(issue)) issues.push(issue) }
  if (!isObject(json)) return { ok: false, issues: ["not_an_approval_object"] }

  if (json.status !== "approved") add("not_approved")

  const approvedAt = isDate(json.approvedAt) ? Date.parse(json.approvedAt) : null
  if (approvedAt === null) add("missing_approved_at")
  else if (approvedAt > now) add("approval_in_future")

  const expiresAt = isDate(json.approvalExpiresAt) ? Date.parse(json.approvalExpiresAt) : null
  if (expiresAt === null) add("missing_expiry")
  else if (expiresAt <= now) add("approval_expired")

  if (json.target?.modelId !== "claude-fable-5-1") add("model_mismatch")
  if (!samePlanIds(json.order)) add("order_mismatch")

  if (json.proposalSha256 !== sha256(proposalJson)) add("proposal_sha_drift")
  if (json.plannerSha256 !== sha256(plannerSource)) add("planner_sha_drift")
  if (json.capSemantics !== "predictive_gate") add("unknown_cap_semantics")

  let proposal = null
  try { proposal = JSON.parse(proposalJson) } catch { add("malformed_proposal") }
  const scaled = Object.hasOwn(json, "capMultiplier")
  const multiplier = json.capMultiplier
  if (scaled && (!Number.isInteger(multiplier) || multiplier <= 0)) add("cap_multiplier_invalid")
  if (scaled) {
    if (!isObject(json.capBasis) || json.capBasis.file !== "docs/idle-experiments-approval-2026-09-23.json" || !/^[a-f0-9]{64}$/.test(json.capBasis.sha256 ?? "") || (capBasisBytes !== undefined && json.capBasis.sha256 !== sha256(capBasisBytes))) add("cap_basis_sha_drift")
    if (capBasisBytes !== undefined && json.capBasis?.sha256 === sha256(capBasisBytes)) {
      try {
        const basis = JSON.parse(capBasisBytes)
        for (const key of ["target", "order", "campaignStop", "perIdleScope", "unpricedCallMaxTokens", "skippedArms", "capSemantics"]) {
          if (!equal(json[key], basis[key])) add("approval_scope_mismatch")
        }
      } catch { add("cap_basis_sha_drift") }
    }
    const prior = json.priorSpend
    const validAmounts = (values, keys) => isObject(values) && equal(Object.keys(values).sort(), [...keys].sort()) && keys.every((key) => typeof values[key] === "number" && Number.isFinite(values[key]) && values[key] >= 0)
    if (!isObject(prior) || typeof prior.runId !== "string" || !prior.runId || !/^[a-f0-9]{64}$/.test(prior.summarySha256 ?? "") || !validAmounts(prior.perMeterUpperEq, Object.keys(proposal?.perMeterCumulativeCaps ?? {})) || !validAmounts(prior.perPlanUpperEq, PLAN_IDS)) add("prior_spend_invalid")
  }
  if (!isObject(proposal) || !isObject(proposal.plans)) add("limits_mismatch")
  else {
    const spendKeys = ["maxProactiveSpendPerIdle", "maxTotalExperimentalSpend"]
    const scale = (value) => Math.round(value * multiplier * 100) / 100
    if (scaled && Number.isInteger(multiplier) && multiplier > 0) {
      if (!equal(json.perMeterCumulativeCaps, Object.fromEntries(Object.entries(proposal.perMeterCumulativeCaps).map(([key, value]) => [key, scale(value)])))) add("cap_multiplier_mismatch")
    }
    for (const plan of PLANS) {
      const expected = proposal.plans[plan.id]?.limits
      const actual = json.plans?.[plan.id]?.limits
      if (scaled && Number.isInteger(multiplier) && multiplier > 0 && isObject(expected) && isObject(actual)) {
        const scaledLimits = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, spendKeys.includes(key) ? { ...value, value: scale(value.value) } : value]))
        if (spendKeys.some((key) => !equal(actual[key], scaledLimits[key]))) add("cap_multiplier_mismatch")
        if (!equal(Object.fromEntries(Object.entries(actual).filter(([key]) => !spendKeys.includes(key))), Object.fromEntries(Object.entries(expected).filter(([key]) => !spendKeys.includes(key))))) add("limits_mismatch")
        if (!equal(Object.keys(actual).sort(), Object.keys(expected).sort())) add("limits_mismatch")
      } else if (!scaled && !equal(actual, expected)) add("limits_mismatch")
      else if (scaled && (!isObject(expected) || !isObject(actual))) add("cap_multiplier_mismatch")
      for (const issue of validatePlan(configuredPlan(plan, json), { now })) add(issue)
    }
  }

  return issues.length === 0 ? { ok: true, approval: json } : { ok: false, issues }
}
