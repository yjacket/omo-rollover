import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { loadApproval } from "../scripts/idle-live/approval.mjs"

const approval = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-2026-09-23.json", import.meta.url), "utf8"))
const proposalJson = readFileSync(new URL("../docs/idle-experiments-approval-proposal.json", import.meta.url), "utf8")
const plannerSource = readFileSync(new URL("../scripts/idle-experiments.mjs", import.meta.url), "utf8")
const NOW = Date.parse("2026-09-24T00:00:00Z")
const rerun = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-2026-09-27.json", import.meta.url), "utf8"))
const basisBytes = readFileSync(new URL("../docs/idle-experiments-approval-2026-09-23.json", import.meta.url))
const rerunLoad = (json, options = {}) => loadApproval(json, { now: Date.parse("2026-09-28T00:00:00Z"), plannerSource, proposalJson, capBasisBytes: basisBytes, ...options })

const copy = () => JSON.parse(JSON.stringify(approval))
const load = (json, options = {}) => loadApproval(json, { now: NOW, plannerSource, proposalJson, ...options })
const assertIssue = (result, issue) => {
  assert.equal(result.ok, false)
  assert.ok(result.issues.includes(issue), `expected ${issue}, got ${JSON.stringify(result.issues)}`)
}

test("a signed approval with matching planner and proposal is accepted", () => {
  const result = load(copy())
  assert.equal(result.ok, true)
  assert.deepEqual(result.approval, approval)
})

test("proposed status is refused as not_approved", () => {
  const json = copy()
  json.status = "proposed"
  assertIssue(load(json), "not_approved")
})

test("future approval time is refused as approval_in_future", () => {
  const json = copy()
  json.approvedAt = "2026-09-25T00:00:00Z"
  assertIssue(load(json), "approval_in_future")
})

test("expired approval is refused as approval_expired", () => {
  assertIssue(load(copy(), { now: Date.parse("2026-11-01T00:00:00Z") }), "approval_expired")
})

test("planner byte drift is refused as planner_sha_drift", () => {
  assertIssue(load(copy(), { plannerSource: `${plannerSource} ` }), "planner_sha_drift")
})

test("tampered plan limits are refused as limits_mismatch", () => {
  const json = copy()
  json.plans["output-quota"].limits.maxTotalExperimentalSpend.value = 0.09
  assertIssue(load(json), "limits_mismatch")
})

test("a missing plan id in the order is refused as order_mismatch", () => {
  const json = copy()
  json.order.pop()
  assertIssue(load(json), "order_mismatch")
})

test("5x approval binds the prior artifact and accepts only spend-limit scaling", () => {
  assert.equal(rerunLoad(rerun).ok, true)
  const bad = structuredClone(rerun)
  bad.plans["output-quota"].limits.maxTotalExperimentalSpend.value = 0.32
  assertIssue(rerunLoad(bad), "cap_multiplier_mismatch")
  const meter = structuredClone(rerun)
  meter.perMeterCumulativeCaps["unified-5h"] = 2.12
  assertIssue(rerunLoad(meter), "cap_multiplier_mismatch")
  const nonSpend = structuredClone(rerun)
  nonSpend.plans["output-quota"].limits.minimumEvidenceForEnforcement.value *= 5
  assertIssue(rerunLoad(nonSpend), "limits_mismatch")
  assertIssue(rerunLoad(rerun, { capBasisBytes: Buffer.from("wrong") }), "cap_basis_sha_drift")
  for (const key of ["campaignStop", "perIdleScope", "unpricedCallMaxTokens", "skippedArms", "capSemantics", "order", "target"]) {
    const badScope = structuredClone(rerun)
    badScope[key] = null
    assertIssue(rerunLoad(badScope), "approval_scope_mismatch")
  }
  assert.equal(rerun.capBasis.sha256, createHash("sha256").update(basisBytes).digest("hex"))
})

test("malformed multipliers and incomplete or invalid prior spend refuse with explicit issues", () => {
  for (const value of [0, -1, "5", NaN]) {
    const bad = structuredClone(rerun)
    bad.capMultiplier = value
    assertIssue(rerunLoad(bad), "cap_multiplier_invalid")
  }
  for (const field of ["perMeterUpperEq", "perPlanUpperEq"]) {
    const key = Object.keys(rerun.priorSpend[field])[0]
    for (const value of [undefined, -1, "0.01", NaN]) {
      const bad = structuredClone(rerun)
      if (value === undefined) delete bad.priorSpend[field][key]
      else bad.priorSpend[field][key] = value
      assertIssue(rerunLoad(bad), "prior_spend_invalid")
    }
  }
})

test("malformed input returns issues without throwing", () => {
  for (const json of [null, [], "not an object", { status: "approved" }]) {
    assert.doesNotThrow(() => load(json))
    const result = load(json)
    assert.equal(result.ok, false)
    assert.ok(result.issues.length > 0)
  }
})
