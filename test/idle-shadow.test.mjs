import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRollover } from "../extension/rollover.ts"

function harness(t, { mode = "shadow", supplier, record, idleMinutes = 1, goalStatus = async () => null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "idle-shadow-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ idleCostMode: mode, idleMinutes, idleGraceMinutes: 1 }))
  const hooks = {}, bus = {}, timers = new Set(), counts = { sends: 0, sessions: 0, shutdowns: 0, pauses: 0 }
  let clock = 0
  const rt = { idle: true, pending: false }
  const ctx = { cwd: dir, model: { id: "fixture-model", provider: "fixture-lane" },
    isIdle: () => rt.idle, hasPendingMessages: () => rt.pending,
    getContextUsage: () => ({ tokens: 120000 }), ui: { notify() {} },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [], getHeader: () => ({}) },
    newSession: async () => { counts.sessions++ }, shutdown: () => { counts.shutdowns++ } }
  const ext = createRollover({ on: (e, fn) => { hooks[e] = fn }, events: { on: (e, fn) => { bus[e] = fn } },
    registerCommand() {}, sendUserMessage: () => { counts.sends++ } }, {
    env: { OMO_ROLLOVER_DIR: dir }, now: () => new Date(clock), idleCostSnapshot: supplier, idleCostRecord: record, goalStatus,
    pauseGoal: async () => { counts.pauses++; return { ok: true, method: "main" } },
    resumeGoal: async () => ({ ok: true, method: "main" }),
    timer: { setInterval: fn => { const handle = { fn }; timers.add(handle); return handle }, clearInterval: h => timers.delete(h) } })
  const fire = (e, data = {}) => hooks[e]?.(data, ctx)
  const rows = () => existsSync(join(dir, "sessions/s1.jsonl")) ? readFileSync(join(dir, "sessions/s1.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []
  t.after(async () => { await fire("session_shutdown", { reason: "reload" }); rmSync(dir, { recursive: true, force: true }) })
  return { ext, fire, rows, ctx, rt, counts, timers, advance: ms => { clock += ms },
    start: async () => { await fire("session_start"); bus.wake_source_state({ source: "senpi-task", activeCount: 0 }) },
    decisions: () => rows().filter(r => r.ev === "idle_cost_shadow") }
}

test("records unknown candidates and missing forecast when genuinely idle", async t => {
  // Given
  const h = harness(t); await h.start()
  assert.equal(h.decisions().length, 0)
  // When
  await h.fire("agent_settled")
  // Then
  const r = h.decisions().at(-1)
  assert.ok(r, "shadow idle boundary must emit a decision")
  for (const key of ["idleEpisodeId", "timestamp", "sessionGeneration", "modelId", "lane", "contextTokens", "remainingTtlMs", "cacheStateEvidence", "costCoefficientVersion", "forecastVersion", "parameterSources", "candidateCosts", "recommendedAction", "currentPolicyAction", "reasonCode", "guardReasons", "incurredSpendSoFar", "VScenario", "evidenceStatus"]) assert.ok(Object.hasOwn(r, key), key)
  assert.deepEqual(r.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  assert.ok(r.blockers.includes("no_calibrated_forecast"))
  assert.equal(r.remainingTtlMs, null)
  assert.equal(r.incurredSpendSoFar, null)
  assert.equal(r.episodeStatus, "observing")
})

test("default off and unavailable enforce leave the observer inert", async t => {
  // Given / When
  for (const mode of [null, "enforce", "bogus", "off"]) {
    const h = harness(t, { mode }); await h.start(); await h.fire("agent_settled")
    // Then
    assert.equal(h.ext.config.idleCostMode, "off")
    assert.equal(h.decisions().length, 0)
  }
})

function mathScenario(i) {
  return { snapshot: { ...i, coefficientVersion: "math/1", coefficientStatus: "reported_unverified",
    forecastVersion: "simulation/1", parameterSources: { costs: "AGENT_TASK/8:math_fixture", forecast: "simulation:not_runtime_calibrated", meter: "write_equivalent_tokens" },
    costs: { warmEq: 8250, rawWarmEq: 8250, parkNowEq: 24000, restoreWarmEq: 16750, skillRestoreEq: 0,
      sharedLossEq: 0, coldSharedEq: 150000, coldFullEq: 150000, parkQualityEq: 0 },
    forecast: { returns: [0.1, 0.05, 0.03, 0.02].map((probability, j) => ({ afterMs: (j + 1) * 270000, probability })), neverReturnsProbability: 0.8 },
    planner: { ttlMs: 300000, intervalMs: 270000, remainingTtlMs: 1, sharedCachePersists: true },
    gates: { allowParking: true, reasons: [] }, limits: { maxProactiveSpendPerIdle: "unconfigured", maxTotalExperimentalSpend: "unconfigured", maxResumeDelay: "unconfigured", allowedQualityDegradation: "unconfigured", minimumEvidenceForEnforcement: "unconfigured" },
    incurredSpendEq: 0, vScenario: { label: "math/V0", vSignedEq: 0, status: "scenario" }, mode: "shadow" },
    cacheEvidence: { lastVerifiedCacheRequestStartedAtMs: i.timestampMs - 299999, cacheExpiresAtMs: i.timestampMs + 1,
      verifiedPrefixTokens: i.contextTokens, contextTokens: i.contextTokens, sessionGeneration: i.sessionGeneration,
      modelLanePrefixIdentity: i.modelLanePrefixIdentity, lastOutcome: "verified_hit" }, requestArrivalDelayMs: 0, safetyMarginMs: 0 }
}

for (const residual of [0, -1]) test(
  `F2-02 runtime known expired root ${residual} prices cold candidates`, async t => {
    const h = harness(t, { idleMinutes: 0, supplier: i => {
      const s = mathScenario(i)
      s.cacheEvidence.cacheExpiresAtMs = i.timestampMs + residual
      s.cacheEvidence.lastVerifiedCacheRequestStartedAtMs = i.timestampMs + residual - 300000
      s.cacheEvidence.lastOutcome = "verified_write"
      s.snapshot.costs.coldWarmEq = 100000
      s.snapshot.planner.remainingTtlMs = 300000 // deliberately stale; evidence must win
      return s
    } })
    await h.start()
    await h.fire("agent_settled")
    const r = h.decisions().at(-1)
    assert.equal(r.cacheStateEvidence.assessment.state, "cold")
    assert.equal(r.remainingTtlMs, residual)
    assert.ok(Number.isFinite(r.candidateCosts.KEEP_WARM), "verified expired root must have a priced KEEP_WARM candidate")
    for (const [action, expected] of Object.entries({ WAIT: 30000, KEEP_WARM: 115825, PARK: 27350, LET_EXPIRE: 30000 }))
      assert.ok(Math.abs(r.candidateCosts[action] - expected) < 1e-6, action)
    assert.equal(r.recommendedAction, "PARK")
    assert.deepEqual(r.blockers, [])
    assert.deepEqual(h.counts, { sends: 0, sessions: 0, shutdowns: 0, pauses: 0 })
    assert.equal(h.timers.size, 0)
  })

for (const missing of ["coldWarmEq", "request_start", "expiry", "prefix", "arrival_delay"]) test(
  `F2-02 runtime expired root handles missing ${missing}`, async t => {
    const h = harness(t, { idleMinutes: 0, supplier: i => {
      const s = mathScenario(i)
      s.cacheEvidence.cacheExpiresAtMs = i.timestampMs
      s.cacheEvidence.lastOutcome = "verified_write"
      s.snapshot.costs.coldWarmEq = 100000
      if (missing === "coldWarmEq") delete s.snapshot.costs.coldWarmEq
      if (missing === "request_start") s.cacheEvidence.lastVerifiedCacheRequestStartedAtMs = null
      if (missing === "expiry") s.cacheEvidence.cacheExpiresAtMs = null
      if (missing === "prefix") s.cacheEvidence.verifiedPrefixTokens = null
      if (missing === "arrival_delay") s.requestArrivalDelayMs = null
      return s
    } })
    await h.start(); await h.fire("agent_settled")
    const r = h.decisions().at(-1)
    if (missing === "prefix") {
      // Known expiry prices a full cold rewrite; prior warm coverage is irrelevant.
      assert.equal(r.cacheStateEvidence.assessment.state, "cold")
      assert.equal(r.recommendedAction, "PARK")
      assert.ok(Math.abs(r.candidateCosts.KEEP_WARM - 115825) < 1e-6)
      assert.deepEqual(r.blockers, [])
    } else {
      assert.equal(r.recommendedAction, "NO_DECISION")
      assert.deepEqual(r.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
      if (missing === "coldWarmEq") assert.ok(r.blockers.includes("forecast_late_rewrite_unpriced"))
      else assert.ok(r.blockers.some(b => b.startsWith("cache_uncertain:")))
    }
    assert.deepEqual(h.counts, { sends: 0, sessions: 0, shutdowns: 0, pauses: 0 })
    assert.equal(h.timers.size, 0)
  })

test("labelled injected math uses the real DP without changing operating actions", async t => {
  // Given
  const off = harness(t, { mode: "off" }), on = harness(t, { supplier: mathScenario })
  // When
  for (const h of [off, on]) { await h.start(); await h.fire("agent_settled"); h.advance(120000); await h.ext.tick() }
  // Then
  const r = on.decisions().find(r => r.episodeStatus === "observing")
  assert.ok(r, "injected math must produce a decision")
  assert.ok(Math.abs(r.candidateCosts.PARK - 27350) < 1e-6)
  assert.ok(Math.abs(r.candidateCosts.KEEP_WARM - 24075) < 1e-6)
  assert.equal(r.recommendedAction, "KEEP_WARM")
  assert.deepEqual(on.counts, off.counts)
  assert.equal(on.timers.size, 1); assert.equal(off.timers.size, 1)
})

test("warm input and its work do not count as return but real input does", async t => {
  // Given
  const h = harness(t); await h.start(); await h.fire("agent_settled")
  const id = h.decisions().at(-1)?.idleEpisodeId
  // When
  await h.fire("input", { source: "extension", text: "PRIVATE_BODY" })
  await h.fire("before_agent_start", { systemPrompt: "PRIVATE_BODY" })
  await h.fire("tool_call", { toolName: "read", input: { text: "PRIVATE_BODY" } })
  await h.fire("message_end", { message: { role: "assistant", content: "PRIVATE_BODY", usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 } } })
  await h.fire("agent_settled")
  await h.fire("input", { source: "interactive", text: "PRIVATE_BODY" })
  // Then
  assert.ok(id)
  assert.equal(h.decisions().filter(r => r.episodeStatus === "returned").length, 1)
  assert.equal(h.decisions().at(-1).idleEpisodeId, id)
  assert.deepEqual(h.decisions().at(-1).rawUsage, { uncachedInput: 3, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 5, billedModelOutput: 4 })
  assert.equal(JSON.stringify(h.decisions()).includes("PRIVATE_BODY"), false)
  assert.equal(h.decisions().at(-1).cacheStateEvidence.request.lastVerifiedCacheRequestStartedAtMs, null)
})

for (const reason of ["quit", "reload", "task_end"]) test(`shutdown ${reason} right-censors rather than inventing permanent no-return`, async t => {
  // Given
  const h = harness(t); await h.start(); await h.fire("agent_settled")
  // When
  await h.fire("session_shutdown", { reason })
  // Then
  assert.equal(h.decisions().at(-1)?.episodeStatus, "right_censored")
  assert.equal(h.timers.size, 0)
})

test("explicit task_end signal ends observation without inventing a forecast", async t => {
  // Given
  const h = harness(t); await h.start(); await h.fire("agent_settled")
  // When
  h.ext.observeTaskEnd?.("completed")
  // Then
  assert.equal(h.decisions().at(-1)?.episodeStatus, "ended")
  assert.equal(h.decisions().at(-1).forecastVersion, null)
})

test("pending input at the timer boundary wins without starting an episode", async t => {
  // Given
  const h = harness(t); await h.start(); h.advance(120000); h.rt.pending = true
  // When
  await h.ext.tick()
  // Then
  assert.equal(h.decisions().length, 0)
  assert.deepEqual(h.counts, { sends: 0, sessions: 0, shutdowns: 0, pauses: 0 })
})

test("user return during timer autonomy await prevents stale handoff", { timeout: 3000 }, async t => {
  // Given: subscribe before triggering; bounded by node:test, no sleeps
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = harness(t, { goalStatus: () => { entered.resolve(); return release.promise } })
  await h.start(); await h.fire("agent_settled"); h.advance(120000)
  // When
  const tick = h.ext.tick()
  await entered.promise
  await h.fire("input", { source: "interactive" })
  release.resolve(null); await tick
  // Then
  assert.equal(h.counts.sends, 0)
  assert.equal(h.ext.st.state, "watching")
  assert.equal(h.decisions().at(-1)?.episodeStatus, "returned")
})

test("model lane and generation changes cannot reuse stamped cache evidence", async t => {
  // Given
  let saved
  const h = harness(t, { supplier: i => { saved ??= mathScenario(i); return saved } }); await h.start(); await h.fire("agent_settled")
  const first = h.decisions().at(-1)
  // When
  h.ctx.model = { id: "different", provider: "other-lane" }; await h.fire("agent_settled")
  await h.fire("session_start"); await h.fire("agent_settled")
  // Then
  const r = h.decisions().at(-1)
  assert.ok(first)
  assert.notEqual(r.sessionGeneration, first.sessionGeneration)
  assert.equal(r.recommendedAction, "NO_DECISION")
  assert.ok(r.blockers.includes("snapshot_identity_mismatch"))
  assert.ok(h.decisions().some(r => r.episodeStatus === "right_censored"))
})

test("throwing observer supplier cannot alter operating policy", async t => {
  // Given
  const h = harness(t, { supplier: () => { throw new TypeError("PRIVATE_ERROR") } }); await h.start()
  // When
  await h.fire("agent_settled"); h.advance(120000); await h.ext.tick()
  // Then
  assert.equal(h.counts.sends, 1)
  assert.equal(h.counts.pauses, 1)
  assert.ok(h.rows().some(r => r.ev === "idle_shadow_error"))
  assert.equal(JSON.stringify(h.rows()).includes("PRIVATE_ERROR"), false)
})

test("request evidence rather than a stale planner TTL determines candidate costs", async t => {
  // Given
  const h = harness(t, { supplier: i => {
    const s = mathScenario(i); s.snapshot.planner.remainingTtlMs = 300000
    return s
  } }); await h.start()
  // When
  await h.fire("agent_settled")
  // Then
  assert.ok(Math.abs(h.decisions().at(-1).candidateCosts.KEEP_WARM - 24075) < 1e-6)
  assert.equal(h.decisions().at(-1).recommendedAction, "KEEP_WARM")
})

test("usage stays nullable and observation ids prevent repeated snapshots being billed twice", async t => {
  // Given
  const h = harness(t); await h.start()
  // When
  await h.fire("message_end", { message: { role: "assistant", usage: { input: NaN, output: -1, cacheRead: Infinity, cacheWrite5m: 7, cacheWrite1h: 8 } } })
  await h.fire("agent_settled"); await h.fire("agent_settled")
  // Then
  const [a, b] = h.decisions()
  assert.deepEqual(a.rawUsage, { uncachedInput: null, cacheWrite5m: 7, cacheWrite1h: 8, cacheRead: null, billedModelOutput: null })
  assert.ok(a.rawUsageObservationId)
  assert.equal(a.rawUsageObservationId, b.rawUsageObservationId)
})

test("observer sink exceptions are reported without blocking the idle policy", async t => {
  // Given
  const h = harness(t, { record: () => { throw new Error("PRIVATE_SINK") } }); await h.start()
  // When
  await h.fire("agent_settled"); h.advance(120000); await h.ext.tick()
  // Then
  assert.equal(h.counts.sends, 1)
  assert.ok(h.ext.shadowDiagnostics().count >= 1)
  assert.ok(h.rows().some(r => r.ev === "idle_shadow_error"))
  assert.equal(JSON.stringify(h.rows()).includes("PRIVATE_SINK"), false)
})

test("shadow never adds a timer when operating idle timers are disabled", async t => {
  // Given
  const h = harness(t, { idleMinutes: 0 }); await h.start()
  // When
  await h.fire("agent_settled")
  // Then
  assert.equal(h.timers.size, 0)
  assert.equal(h.decisions().length, 1)
})

test("real tool work closes an idle episode without requiring typed input", async t => {
  // Given
  const h = harness(t); await h.start(); await h.fire("agent_settled")
  // When
  await h.fire("tool_call", { toolName: "read", input: { body: "PRIVATE_BODY" } })
  // Then
  assert.equal(h.decisions().at(-1).episodeStatus, "returned")
  assert.equal(h.decisions().at(-1).episodeEndReason, "tool_work_started")
})

test("changed model closes old usage before recording the new response", async t => {
  // Given: faithful injected request lifecycle, distinct usage on each lane
  const h = harness(t); await h.start()
  await h.fire("message_end", { message: { role: "assistant", model: "fixture-model", provider: "fixture-lane", usage: { input: 1, output: 2, cacheRead: 3 } } })
  await h.fire("agent_settled")
  const old = h.decisions().at(-1)
  // When
  h.ctx.model = { id: "second", provider: "lane-b" }
  await h.fire("input", { source: "extension" }); await h.fire("before_agent_start")
  await h.fire("message_end", { message: { role: "assistant", model: "second", provider: "lane-b", usage: { input: 101, output: 102, cacheRead: 103 } } })
  await h.fire("agent_settled")
  // Then
  const close = h.decisions().find(r => r.episodeEndReason === "model_lane_changed"), fresh = h.decisions().at(-1)
  assert.equal(close.rawUsage.uncachedInput, 1)
  assert.equal(close.rawUsageObservationId, old.rawUsageObservationId)
  assert.equal(close.rawUsageModelId, "fixture-model"); assert.equal(close.rawUsageLane, "fixture-lane")
  assert.equal(fresh.rawUsage.uncachedInput, 101)
  assert.equal(fresh.rawUsageModelId, "second"); assert.equal(fresh.rawUsageLane, "lane-b")
  assert.notEqual(fresh.rawUsageObservationId, old.rawUsageObservationId)
})

test("fallback response provenance blocks incompatible primary cache evidence", async t => {
  // Given: fresh primary-stamped math evidence must not authorize fallback usage
  const h = harness(t, { supplier: mathScenario }); await h.start(); await h.fire("agent_settled")
  const oldGeneration = h.decisions().at(-1).sessionGeneration
  // When
  await h.fire("input", { source: "extension" }); await h.fire("before_agent_start")
  await h.fire("message_end", { message: { role: "assistant", model: "fallback", provider: "fallback-lane", usage: { input: 201, output: 202, cacheRead: 203 } } })
  await h.fire("agent_settled")
  // Then
  const r = h.decisions().at(-1)
  assert.equal(r.rawUsageModelId, "fallback"); assert.equal(r.rawUsageLane, "fallback-lane")
  assert.equal(r.rawUsage.uncachedInput, 201)
  assert.notEqual(r.sessionGeneration, oldGeneration)
  assert.equal(r.cacheStateEvidence.assessment.state, "uncertain")
  assert.equal(r.recommendedAction, "NO_DECISION")
  assert.ok(r.blockers.includes("cache_uncertain:response_model_lane_mismatch"))
  assert.deepEqual(h.counts, { sends: 0, sessions: 0, shutdowns: 0, pauses: 0 })
})

for (const metadata of [{}, { model: "response-only" }, { provider: "response-lane-only" }]) test(`absent response metadata stays unknown: ${Object.keys(metadata).join(",") || "both"}`, async t => {
  // Given
  const h = harness(t); await h.start()
  // When
  await h.fire("message_end", { message: { role: "assistant", ...metadata, usage: { input: 9 } } })
  await h.fire("agent_settled")
  // Then
  const r = h.decisions().at(-1)
  assert.equal(r.rawUsageModelId, metadata.model ?? null)
  assert.equal(r.rawUsageLane, metadata.provider ?? null)
  assert.equal(r.rawUsage.uncachedInput, 9)
})

test("throwing censor sink cannot interrupt session generation and usage reset", async t => {
  // Given
  const captured = []
  const h = harness(t, { record: r => { if (r.episodeStatus === "right_censored") throw new Error("PRIVATE_CENSOR"); captured.push(r) } })
  await h.start()
  await h.fire("message_end", { message: { role: "assistant", model: "fixture-model", provider: "fixture-lane", usage: { input: 5 } } })
  await h.fire("agent_settled"); const old = captured.at(-1)
  // When
  await h.fire("session_start"); await h.fire("agent_settled")
  // Then
  const fresh = captured.at(-1)
  assert.notEqual(fresh.sessionGeneration, old.sessionGeneration)
  assert.equal(fresh.rawUsageObservationId, null); assert.equal(fresh.rawUsage.uncachedInput, null)
  assert.equal(fresh.rawUsageModelId, null); assert.equal(fresh.rawUsageLane, null)
  assert.equal(h.ext.shadowDiagnostics().count, 1)
  assert.equal(h.timers.size, 1)
})

test("throwing identity censor cannot discard the new response observation", async t => {
  // Given
  const captured = []
  const h = harness(t, { record: r => { if (r.episodeStatus === "right_censored") throw new Error("PRIVATE_CENSOR"); captured.push(r) } })
  await h.start(); await h.fire("agent_settled")
  // When
  h.ctx.model = { id: "second", provider: "lane-b" }
  await h.fire("message_end", { message: { role: "assistant", model: "second", provider: "lane-b", usage: { input: 101 } } })
  await h.fire("agent_settled")
  // Then
  const r = captured.at(-1)
  assert.equal(r.modelId, "second"); assert.equal(r.rawUsage.uncachedInput, 101)
  assert.equal(r.rawUsageModelId, "second"); assert.equal(r.rawUsageLane, "lane-b")
  assert.equal(h.ext.shadowDiagnostics().count, 1)
})
