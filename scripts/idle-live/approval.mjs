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
export function loadApproval(json, { now = Date.now(), plannerSource, proposalJson } = {}) {
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
  if (!isObject(proposal) || !isObject(proposal.plans)) add("limits_mismatch")
  else {
    for (const plan of PLANS) {
      if (!equal(json.plans?.[plan.id]?.limits, proposal.plans[plan.id]?.limits)) add("limits_mismatch")
      for (const issue of validatePlan(configuredPlan(plan, json), { now })) add(issue)
    }
  }

  return issues.length === 0 ? { ok: true, approval: json } : { ok: false, issues }
}
