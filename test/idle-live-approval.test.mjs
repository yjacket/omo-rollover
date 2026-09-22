import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { loadApproval } from "../scripts/idle-live/approval.mjs"

const approval = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-2026-09-23.json", import.meta.url), "utf8"))
const proposalJson = readFileSync(new URL("../docs/idle-experiments-approval-proposal.json", import.meta.url), "utf8")
const plannerSource = readFileSync(new URL("../scripts/idle-experiments.mjs", import.meta.url), "utf8")
const NOW = Date.parse("2026-09-24T00:00:00Z")

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

test("malformed input returns issues without throwing", () => {
  for (const json of [null, [], "not an object", { status: "approved" }]) {
    assert.doesNotThrow(() => load(json))
    const result = load(json)
    assert.equal(result.ok, false)
    assert.ok(result.issues.length > 0)
  }
})
