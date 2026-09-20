import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createRollover, USAGE_FIELDS } from "../extension/rollover.ts"
import { replay } from "../scripts/idle-replay.mjs"

const sample = JSON.parse(readFileSync(new URL("../docs/idle-shadow-sample.json", import.meta.url), "utf8"))

test("actual shadow emission replays finite signed candidate objectives through CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-shadow-replay-"))
  const hooks = {}, bus = {}
  const snapshot = structuredClone(sample.scenarios[0].snapshot)
  snapshot.costs.futureWorkDifferentialEq = 200000
  snapshot.vScenario = { label: "explicit_same_task", status: "scenario", vSignedEq: 200000 }
  const ctx = { cwd: dir, model: { id: snapshot.modelId, provider: snapshot.lane },
    isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: snapshot.contextTokens }), ui: { notify() {} },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [], getHeader: () => ({}) } }
  const unexpected = () => assert.fail("recording must not perform operating actions")
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ idleCostMode: "shadow", idleMinutes: 0 }))
    const ext = createRollover({ on: (event, fn) => { hooks[event] = fn },
      events: { on: (event, fn) => { bus[event] = fn } }, registerCommand() {}, sendUserMessage: unexpected }, {
      env: { OMO_ROLLOVER_DIR: dir }, now: () => new Date(snapshot.timestampMs),
      goalStatus: async () => null, pauseGoal: unexpected, resumeGoal: unexpected,
      timer: { setInterval: unexpected, clearInterval: unexpected },
      idleCostSnapshot: identity => ({ snapshot: { ...snapshot, ...identity },
        cacheEvidence: { ...sample.records[0].cacheStateEvidence.request,
          sessionGeneration: identity.sessionGeneration, modelLanePrefixIdentity: identity.modelLanePrefixIdentity },
        requestArrivalDelayMs: 0, safetyMarginMs: 0 }) })
    await hooks.session_start({}, ctx)
    bus.wake_source_state({ source: "senpi-task", activeCount: 0 })
    await hooks.message_end({ message: { role: "assistant", usage: { input: 1000, output: 50, cacheRead: 119000 } } }, ctx)
    await hooks.agent_settled({}, ctx)
    assert.equal(ext.shadowDiagnostics().count, 0)
    const file = join(dir, "sessions", "s1.jsonl")
    const emitted = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).filter(r => r.ev === "idle_cost_shadow")
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].candidateCosts.PARK, -12650)
    const child = spawnSync(process.execPath, ["scripts/idle-replay.mjs", file], { encoding: "utf8", timeout: 10000 })
    assert.equal(child.status, 0, child.stderr + child.stdout)
    const result = JSON.parse(child.stdout)
    assert.equal(result.integrity.ok, true)
    assert.equal(result.episodes.length, 1)
    assert.deepEqual(result.episodes[0].decisions[0].candidateCosts, emitted[0].candidateCosts)
    assert.equal(result.episodes[0].decisions[0].candidateCosts.PARK, -12650)
    assert.equal(result.usageTotals[0].totals.uncachedInput, 1000)
  } finally {
    try { if (hooks.session_shutdown) await hooks.session_shutdown({ reason: "reload" }, ctx) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

for (const action of ["WAIT", "KEEP_WARM", "PARK", "LET_EXPIRE"]) {
  test("signed finite " + action + " objective is preserved; null remains unavailable", () => {
    for (const value of [-Number.MAX_VALUE, -12650, 0, Number.MAX_VALUE, null]) {
      const row = structuredClone(sample.records[0]); row.candidateCosts[action] = value
      const result = replay(JSON.stringify(row))
      assert.equal(result.integrity.ok, true)
      assert.equal(result.episodes[0].decisions[0].candidateCosts[action], value)
    }
  })
}

const numericFields = [
  ...["WAIT", "KEEP_WARM", "PARK", "LET_EXPIRE"].map(action => ["candidateCosts", action]),
  ...USAGE_FIELDS.map(field => ["rawUsage", field]),
  ...["incurredSpendEq", "contextTokens", "timestampMs", "episodeStartedAtMs", "observedUntilMs", "rawUsageObservedAtMs", "returnedAtMs"].map(field => [field]),
]
for (const fields of numericFields) test("invalid numeric " + fields.join(".") + " remains rejected", () => {
  const invalid = ["1e309", "-1e309", "NaN", "Infinity", '"NaN"', '"Infinity"', '"-12650"', "true"]
  if (fields[0] !== "candidateCosts") invalid.push("-1")
  for (const literal of invalid) {
    const row = structuredClone(sample.records[0])
    if (fields[0] === "returnedAtMs") row.episodeStatus = "returned"
    const target = fields.length === 2 ? row[fields[0]] : row
    target[fields.at(-1)] = "INVALID_NUMBER_SENTINEL"
    // Replace after JSON serialization: JSON.stringify(NaN/Infinity) produces null,
    // which is legitimately unavailable for nullable fields, not a nonfinite test.
    const text = JSON.stringify(row).replace('"INVALID_NUMBER_SENTINEL"', literal)
    const result = replay(text)
    assert.equal(result.integrity.ok, false, fields.join(".") + ":" + literal)
    assert.equal(result.episodes.length, 0)
    assert.ok(result.integrity.issues.some(i => ["invalid_row", "malformed_json"].includes(i.code)))
  }
})
