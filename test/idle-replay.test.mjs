import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { replay } from "../scripts/idle-replay.mjs"

const sample = JSON.parse(readFileSync(new URL("../docs/idle-shadow-sample.json", import.meta.url), "utf8"))
const row = (changes = {}) => ({ ...structuredClone(sample.records[0]), ...changes })
const jsonl = rows => rows.map(r => JSON.stringify(r)).join("\n")

test("deduplicates the last usage snapshot across ticks and episodes", () => {
  // Given
  const r = row(), next = row({ idleEpisodeId: "another", timestampMs: r.timestampMs + 1, observedUntilMs: r.timestampMs + 1 })
  // When
  const result = replay(jsonl([r, r, next]))
  // Then
  assert.equal(result.usageObservations.length, 1)
  assert.equal(result.usageTotals[0].totals.uncachedInput, 1000)
  assert.equal(result.usageTotals[0].totals.cacheWrite5m, null)
})

test("closing rows retain a prior decision rather than adding a decision at a tied timestamp", () => {
  // Given
  const rows = [row(), row({ episodeStatus: "returned", returnedAtMs: 1000000, episodeEndReason: "user_input" })]
  // When
  const result = replay(jsonl(rows))
  // Then
  assert.equal(result.episodes.length, 1)
  assert.equal(result.episodes[0].decisions.length, 1)
  assert.equal(result.episodes[0].status, "returned")
  assert.equal(result.episodes[0].returnedAtMs, 1000000)
  assert.equal(result.episodes[0].decisions[0].sourceLine, 1)
})

test("blocks explicitly future-dated forecast inputs before calling the evaluator", () => {
  // Given
  const scenario = structuredClone(sample.scenarios[0]); scenario.asOfMs++
  // When
  const result = replay(jsonl([row()]), { scenarios: [scenario] })
  // Then
  assert.equal(result.scenarios[0].status, "blocked")
  assert.equal(result.scenarios[0].reasonCode, "future_input")
  assert.equal(result.scenarios[0].decision, null)
  assert.equal(result.integrity.ok, false)
})

test("replays pinned actual emissions with all finite observation states", () => {
  // Given / When
  const result = replay(jsonl(sample.records))
  // Then
  assert.equal(result.integrity.ok, true)
  assert.deepEqual([...new Set(result.episodes.map(e => e.status))].sort(), ["ended", "observing", "returned", "right_censored"])
  assert.ok(result.episodes.every(e => e.permanentNonReturn === null))
  assert.deepEqual(result.actions, { requestsIssued: 0, sessionTransitions: 0, timersCreated: 0 })
})

test("groups reused episode names by generation and keeps equal timestamps in emission order", () => {
  // Given
  const rows = [row({ sessionGeneration: "g2" }), row(), row({ rawUsageObservationId: "new-observation" })]
  // When
  const result = replay(jsonl(rows))
  // Then
  assert.equal(result.episodes.length, 2)
  assert.deepEqual(result.episodes[1].decisions.map(d => d.sourceLine), [2, 3])
  assert.equal(result.usageObservations.length, 3)
})

test("uses response fallback billing identity, independently unknown when metadata is missing", () => {
  // Given
  const rows = [row({ rawUsageModelId: "fallback", rawUsageLane: "fallback-lane" }), row({ rawUsageObservationId: "u2", rawUsageModelId: undefined, rawUsageLane: undefined })]
  // When
  const result = replay(jsonl(rows))
  // Then
  assert.deepEqual(result.usageTotals.map(t => [t.modelId, t.lane]), [["fallback", "fallback-lane"], [null, null]])
  assert.ok(result.usageTotals.every(t => t.totals.uncachedInput === 1000))
})

test("missing usage is unknown, not a zero bill or a synthetic observation", () => {
  // Given
  const r = row({ rawUsage: undefined, rawUsageObservationId: null, rawUsageObservedAtMs: null })
  // When
  const result = replay(jsonl([r]))
  // Then
  assert.equal(result.usageObservations.length, 0)
  assert.equal(result.episodes[0].usageStatus, "unknown")
})

test("conflicting repeated observation IDs cannot silently change the bill", () => {
  // Given
  const r = row(), changed = row(); changed.rawUsage.uncachedInput++
  // When
  const result = replay(jsonl([r, changed]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.ok(result.integrity.issues.some(i => i.code === "usage_observation_conflict"))
  assert.equal(result.usageObservations.length, 1)
})

test("future outcomes never enter recomputation and oracle inputs are distinctly labelled", () => {
  // Given
  const scenarios = [sample.scenarios[0], { ...sample.scenarios[0], kind: "oracle" }]
  const closing = row({ episodeStatus: "right_censored", observedUntilMs: 9999999, episodeEndReason: "shutdown" })
  // When
  const result = replay(jsonl([row(), closing]), { scenarios })
  // Then
  assert.equal(result.scenarios.length, 2)
  assert.deepEqual(result.scenarios.map(s => s.kind), ["mathematical", "oracle"])
  for (const s of result.scenarios) {
    assert.equal(s.status, "evaluated")
    assert.equal(s.decision.recommendedAction, "KEEP_WARM")
    assert.ok(Math.abs(s.decision.candidateCosts.PARK - 27350) < 1e-6)
    assert.ok(Math.abs(s.decision.candidateCosts.KEEP_WARM - 24075) < 1e-6)
  }
})

test("no supplied snapshot means recorded-only replay, not a forecast reconstructed from returns", () => {
  // Given / When
  const result = replay(jsonl(sample.records))
  // Then
  assert.equal(result.scenarios.length, 0)
  assert.equal(result.forecastReconstruction, "unavailable")
})

test("missing as-of, nested future provenance, stale identity and malformed scenarios are blocked", () => {
  // Given
  const missing = structuredClone(sample.scenarios[0]); delete missing.asOfMs
  const future = structuredClone(sample.scenarios[0]); future.snapshot.forecast.measuredAt = "2099-01-01T00:00:00Z"
  const stale = structuredClone(sample.scenarios[0]); stale.snapshot.modelId = "stale"
  // When
  const result = replay(jsonl([row()]), { scenarios: [missing, future, stale, null] })
  // Then
  assert.deepEqual(result.scenarios.map(s => s.status), ["blocked", "blocked", "blocked", "blocked"])
  assert.equal(result.integrity.ok, false)
})

for (const [name, changes, code] of [
  ["schema", { schemaVersion: "idle-shadow/2" }, "unsupported_schema"],
  ["status", { episodeStatus: "never_returned" }, "invalid_row"],
  ["enforcement", { enforcement: "available" }, "invalid_row"],
  ["time", { observedUntilMs: -1 }, "invalid_row"],
  ["costs", { candidateCosts: { WAIT: "cheap" } }, "invalid_row"],
  ["usage", { rawUsage: { uncachedInput: -1 } }, "invalid_row"],
]) test(`reports invalid ${name} as machine integrity, never success`, () => {
  // Given / When
  const result = replay(jsonl([row(changes)]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.ok(result.integrity.issues.some(i => i.code === code))
})

test("malformed JSON and primitive rows have safe diagnostics without copying bodies", () => {
  // Given / When
  const result = replay('{"body":"PRIVATE_SENTINEL"\nnull\n3\n' + jsonl([row({ body: "PRIVATE_SENTINEL", content: "PRIVATE_SENTINEL" })]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.equal(result.integrity.issues.length, 3)
  assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false)
})

test("orphan closure and observing after closure are not accepted as new lifecycles", () => {
  // Given
  const close = row({ episodeStatus: "ended", episodeEndReason: "completed" })
  // When
  const result = replay(jsonl([close, row()]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.ok(result.integrity.issues.some(i => i.code === "orphan_closure"))
  assert.ok(result.integrity.issues.some(i => i.code === "row_after_closure"))
})

test("CLI sample executes the real evaluator and reports zero actions", () => {
  // Given / When
  const child = spawnSync(process.execPath, ["scripts/idle-replay.mjs", "--sample"], { encoding: "utf8", timeout: 10000 })
  // Then
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.equal(result.integrity.ok, true)
  assert.ok(result.scenarios.some(s => s.decision?.candidateCosts.PARK === 27350))
  assert.ok(result.defaultUnknown.blockers.includes("no_calibrated_forecast"))
  assert.deepEqual(result.actions, { requestsIssued: 0, sessionTransitions: 0, timersCreated: 0 })
})

test("CLI rejects unknown flags and malformed input with JSON integrity and no private echo", t => {
  // Given
  const dir = mkdtempSync(join(tmpdir(), "idle-replay-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "bad.jsonl"); writeFileSync(file, '{"PRIVATE_SENTINEL":')
  // When
  const children = [["--execute"], [file]].map(args => spawnSync(process.execPath, ["scripts/idle-replay.mjs", ...args], { encoding: "utf8", timeout: 10000 }))
  // Then
  for (const child of children) {
    assert.equal(child.status, 2, child.stderr)
    assert.equal(JSON.parse(child.stdout).integrity.ok, false)
    assert.equal((child.stdout + child.stderr).includes("PRIVATE_SENTINEL"), false)
  }
})

test("malformed scenario limits and flags are blocked before evaluation", () => {
  // Given
  const scenarios = ["limits", "retry", "shared"].map(() => structuredClone(sample.scenarios[0]))
  scenarios[0].snapshot.limits = {}
  scenarios[1].snapshot.cache.retryAllowed = true
  scenarios[2].snapshot.planner.sharedCachePersists = "false"
  // When
  const result = replay(jsonl([row()]), { scenarios })
  // Then
  assert.deepEqual(result.scenarios.map(s => s.status), ["blocked", "blocked", "blocked"])
  assert.equal(result.integrity.ok, false)
})

test("an observing row cannot include a response observed only after that decision", () => {
  // Given
  const r = row({ rawUsageObservedAtMs: 1000001, observedUntilMs: 1000001 })
  // When
  const result = replay(jsonl([r]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.equal(result.usageObservations.length, 0)
})

for (const status of ["returned", "right_censored", "ended"]) test(`elapsed ${status} closure preserves the original decision time`, () => {
  // Given: task5 shadowClose stamps emission time, not the retained decision time.
  const first = row(), closedAt = first.timestampMs + 1000
  const close = row({ timestampMs: closedAt, observedUntilMs: closedAt, episodeStatus: status,
    returnedAtMs: status === "returned" ? closedAt : null, episodeEndReason: "completed" })
  // When
  const result = replay(jsonl([first, close]), { scenarios: sample.scenarios })
  // Then
  assert.equal(result.integrity.ok, true)
  const episode = result.episodes[0]
  assert.equal(episode.status, status)
  assert.equal(episode.decisions.length, 1)
  assert.equal(episode.decisions[0].timestampMs, first.timestampMs)
  assert.equal(episode.observedUntilMs, closedAt)
  assert.equal(episode.returnedAtMs, close.returnedAtMs)
  assert.deepEqual(episode.decisions[0].candidateCosts, first.candidateCosts)
  assert.equal(result.usageObservations.length, 1)
  assert.equal(result.scenarios[0].status, "evaluated")
  assert.equal(result.scenarios[0].asOfMs, first.timestampMs)
})

for (const [field, value] of [["modelId", "wrong-model"], ["lane", "wrong-lane"], ["contextTokens", 999]])
  test(`closure rejects conflicting retained ${field}`, () => {
    // Given: tied times isolate identity validation from the elapsed-time defect.
    const close = row({ episodeStatus: "ended", episodeEndReason: "completed", [field]: value })
    // When
    const result = replay(jsonl([row(), close]))
    // Then
    assert.equal(result.integrity.ok, false)
    assert.ok(result.integrity.issues.some(i => i.code === "closing_decision_conflict"))
  })

test("elapsed closure still rejects changed decision costs", () => {
  // Given
  const close = row({ timestampMs: 1001000, observedUntilMs: 1001000, episodeStatus: "ended", episodeEndReason: "completed" })
  close.candidateCosts.PARK++
  // When
  const result = replay(jsonl([row(), close]))
  // Then
  assert.equal(result.integrity.ok, false)
  assert.ok(result.integrity.issues.some(i => i.code === "closing_decision_conflict"))
})

for (const field of ["uncachedInput", "cacheWrite5m", "cacheWrite1h", "cacheRead", "billedModelOutput"])
  test(`finite ${field} observations cannot overflow to legitimate unknown totals`, () => {
    // Given
    const first = row(), second = row({ rawUsageObservationId: "huge2" })
    first.rawUsage[field] = 1e308; second.rawUsage[field] = 1e308
    // When: assert the serialized CLI-shaped result, not only in-memory Infinity.
    const result = JSON.parse(JSON.stringify(replay(jsonl([first, second]))))
    // Then
    assert.equal(result.integrity.ok, false)
    assert.ok(result.integrity.issues.some(i => i.code === `usage_total_overflow:${field}`))
    assert.equal(result.usageTotals[0].totals[field], null)
    assert.equal(result.usageTotals[0].unavailableReasons[field], "usage_total_overflow")
    assert.deepEqual(result.usageObservations.map(o => o.usage[field]), [1e308, 1e308])
  })

test("large finite usage totals remain numeric rather than being arbitrarily capped", () => {
  // Given
  const first = row(), second = row({ rawUsageObservationId: "large2" })
  first.rawUsage.uncachedInput = Number.MAX_VALUE / 2; second.rawUsage.uncachedInput = Number.MAX_VALUE / 2
  // When
  const result = JSON.parse(JSON.stringify(replay(jsonl([first, second]))))
  // Then
  assert.equal(result.integrity.ok, true)
  assert.equal(result.usageTotals[0].totals.uncachedInput, Number.MAX_VALUE)
})
