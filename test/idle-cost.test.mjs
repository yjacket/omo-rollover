// Idle cost engine (plan task 3): pure cost/cache/quality contracts + the preserved DP.
// Deterministic only: no clocks, no sleeps, no I/O, no model calls.
// Run: node --test test/idle-cost.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  IDLE_COST_ENGINE_VERSION,
  USAGE_FIELDS,
  convertUsage,
  combineMeteredCosts,
  cacheStateAtArrival,
  applyWarmOutcome,
  requestSequenceCostEq,
  futureWorkDifferential,
  planIdle,
  parkingGates,
  proactiveSpendGate,
  budgetFallback,
  evaluateIdleCost,
  UNCONFIGURED_LIMITS,
} from "../extension/rollover.ts"

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`)

// ---------------------------------------------------------------- fixtures
// AGENT_TASK section 8 regression input. NOT measured coefficients: a mathematical fixture.
// Engine unit here is input-equivalent TOKENS, so the K-token table is scaled x1000.
const I = 270_000 // review interval (ms)
const TTL = 300_000
// remainingTtlMs = 1ms encodes the fixture condition "current free remaining TTL is negligible"
// (the planner requires a positive residual TTL; 1ms expires before any return point).
const OPT = { ttlMs: TTL, intervalMs: I, remainingTtlMs: 1, sharedCachePersists: true, allowParking: true }

// a=A=8.25K ping/resume, G=24K park now, B=16.75K restore, K=cold resume.
const fixtureCosts = (coldEq, over = {}) => ({
  warmEq: 8_250,
  rawWarmEq: 8_250,
  parkNowEq: 24_000,
  restoreWarmEq: 16_750,
  skillRestoreEq: 0,
  sharedLossEq: 0,
  coldSharedEq: coldEq,
  coldFullEq: coldEq,
  parkQualityEq: 0,
  ...over,
})
const forecastOf = (probs, never) => ({
  returns: probs.map((probability, i) => ({ afterMs: (i + 1) * I, probability })),
  neverReturnsProbability: never,
})
const F20 = forecastOf([0.1, 0.05, 0.03, 0.02], 0.8) // q=20%, h=10%
const F24 = forecastOf([0.12, 0.06, 0.036, 0.024], 0.76) // q=24%, h=12% (new shared counterexample)

const COEFF = {
  modelId: "opus-5",
  provider: "anthropic",
  authLane: "oauth",
  ttlLane: "5m",
  effortOrConfigIdentity: "default",
  quotaMeterOrCostUnit: "input_equivalent_tokens",
  validFrom: "2026-09-19",
  measuredAt: null,
  sourceKind: "api_assumption",
  evidenceRef: "references/latest-review/reply-review.md#2",
  sampleCount: 0,
  version: "coeff/test-1",
  coefficients: { uncachedInput: 1, cacheWrite5m: 1.25, cacheWrite1h: null, cacheRead: 0.1, billedModelOutput: 5 },
}
const usageOf = (over = {}) => ({ uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, billedModelOutput: 0, ...over })

const EVIDENCE = {
  lastVerifiedCacheRequestStartedAtMs: 1_000_000,
  cacheExpiresAtMs: 1_300_000,
  verifiedPrefixTokens: 150_000,
  contextTokens: 150_000,
  sessionGeneration: "g1",
  modelLanePrefixIdentity: "opus-5|oauth|5m|prefixA",
  lastOutcome: "verified_write",
}
const ARRIVAL = {
  decisionAtMs: 1_200_000,
  requestArrivalDelayMs: 2_000,
  safetyMarginMs: 1_000,
  expectedGeneration: "g1",
  expectedIdentity: "opus-5|oauth|5m|prefixA",
}

// -------------------------------------------- independent forward enumeration
// Deliberately NOT the backward recurrence. Enumerates the FULL deterministic
// policy class of this model: at every review epoch before the terminal one the
// policy either WAITS (free, issues nothing) or PINGS, and at the terminal epoch
// it PARKS or LET_EXPIREs. Each outcome is then simulated forward with an explicit
// expiry clock, so free residual waiting, deferred pings and "let it die, rewrite
// later" are all represented. A policy that would need an unpriced rewrite
// (coldWarmEq absent) is not available, exactly as the engine treats it.
// Model scope: fixed costs/lane for one idle spell, decisions only at n*interval,
// PARK/LET_EXPIRE terminal, calls atomic.
function forwardBest(c, f, o) {
  const I = o.intervalMs
  const lateness = (o.requestArrivalDelayMs ?? 0) + (o.safetyMarginMs ?? 0)
  const pts = [...f.returns].sort((a, b) => a.afterMs - b.afterMs)
  const maxT = pts.length ? pts[pts.length - 1].afterMs : 0
  const horizon = Math.ceil(maxT / I) + 1
  const V = c.futureWorkDifferentialEq ?? 0
  const coldResume = o.sharedCachePersists ? c.coldSharedEq : c.coldFullEq
  const outcomes = [...pts.map((p) => ({ T: p.afterMs, p: p.probability })), { T: Infinity, p: f.neverReturnsProbability }]
  const resume = (T, expiry) => (T + lateness < expiry ? c.rawWarmEq : coldResume)
  let best = Infinity
  for (let terminalEpoch = 0; terminalEpoch <= horizon; terminalEpoch++) {
    for (let pingMask = 0; pingMask < 1 << terminalEpoch; pingMask++) {
      for (const terminal of ["PARK", "LET_EXPIRE"]) {
        if (terminal === "PARK" && !o.allowParking) continue
        let total = 0
        let available = true
        for (const { T, p } of outcomes) {
          if (p === 0) continue
          let expiry = o.remainingTtlMs
          let cost = 0
          for (let j = 0; j <= terminalEpoch; j++) {
            const t = j * I
            if (t >= T) {
              cost += resume(T, expiry) // the return cancels this review
              break
            }
            if (j === terminalEpoch) {
              if (terminal === "PARK") {
                cost += c.parkNowEq
                if (Number.isFinite(T))
                  cost += c.restoreWarmEq + c.skillRestoreEq + c.parkQualityEq + (!o.sharedCachePersists && T >= t + o.ttlMs ? c.sharedLossEq : 0) - V
              } else if (Number.isFinite(T)) cost += resume(T, expiry)
              break
            }
            if (pingMask & (1 << j)) {
              const late = t + lateness >= expiry
              if (late && c.coldWarmEq === undefined) {
                available = false
                break
              }
              cost += late ? c.coldWarmEq : c.warmEq
              expiry = t + o.ttlMs
            }
          }
          if (!available) break
          total += p * cost
        }
        if (available && total < best) best = total
      }
    }
  }
  return best
}

// ------------------------------------------------------------ cost coefficients
test("five usage fields are disjoint and weighted exactly once", () => {
  assert.deepEqual([...USAGE_FIELDS], ["uncachedInput", "cacheWrite5m", "cacheWrite1h", "cacheRead", "billedModelOutput"])
  const r = convertUsage(usageOf({ uncachedInput: 1000, cacheWrite5m: 2000, cacheRead: 4000, billedModelOutput: 500 }), COEFF)
  assert.equal(r.ok, true)
  near(r.valueEq, 1000 * 1 + 2000 * 1.25 + 4000 * 0.1 + 500 * 5)
  assert.equal(r.meter, "input_equivalent_tokens")
  assert.equal(r.coefficientVersion, "coeff/test-1")
})

test("coefficients are never defaulted and negative usage is rejected", () => {
  assert.throws(() => convertUsage(usageOf({ uncachedInput: 1 })), /coefficients are required/)
  assert.throws(() => convertUsage(usageOf({ uncachedInput: -1 }), COEFF), /must be finite and >= 0/)
})

test("an unknown coefficient blocks conversion of that field instead of costing zero", () => {
  const blocked = convertUsage(usageOf({ cacheWrite1h: 6_000 }), { ...COEFF, ttlLane: "1h" })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes("unknown_coefficient:cacheWrite1h"))
  assert.deepEqual(blocked.unknownCoefficients, ["cacheWrite1h"])
  // Unused unknown coefficient: still reported, never silently treated as measured zero.
  const unused = convertUsage(usageOf({ uncachedInput: 10 }), COEFF)
  assert.equal(unused.ok, true)
  assert.deepEqual(unused.unknownCoefficients, ["cacheWrite1h"])
})

test("a 5m write coefficient is never substituted for the 1h lane (and vice versa)", () => {
  const fiveOnly = { ...COEFF, coefficients: { ...COEFF.coefficients, cacheWrite1h: 2 }, ttlLane: "5m" }
  const r = convertUsage(usageOf({ cacheWrite1h: 6_000 }), fiveOnly)
  assert.equal(r.ok, false)
  assert.ok(r.blockers.includes("ttl_lane_substitution_refused:cacheWrite1h"))
  const oneHour = { ...fiveOnly, ttlLane: "1h" }
  assert.equal(convertUsage(usageOf({ cacheWrite5m: 6_000 }), oneHour).ok, false)
  // Both lanes priced and declared mixed: no substitution happens, the two rates stay distinct.
  const mixed = { ...fiveOnly, ttlLane: "mixed" }
  const both = convertUsage(usageOf({ cacheWrite5m: 1_000, cacheWrite1h: 1_000 }), mixed)
  assert.equal(both.ok, true)
  near(both.valueEq, 1_000 * 1.25 + 1_000 * 2)
})

test("a coefficient record with unknown provenance cannot be spent", () => {
  const r = convertUsage(usageOf({ uncachedInput: 10 }), { ...COEFF, sourceKind: "unknown" })
  assert.equal(r.ok, false)
  assert.ok(r.blockers.includes("coefficient_source_unknown"))
})

test("different quota meters are not summed without an explicit common meter", () => {
  const parts = [
    { label: "parent", modelId: "opus-5", meter: "opus_write_eq", valueEq: 100 },
    { label: "child", modelId: "fable-5.1", meter: "fable_write_eq", valueEq: 50 },
  ]
  const mixed = combineMeteredCosts(parts)
  assert.equal(mixed.ok, false)
  assert.ok(mixed.blockers.some((b) => b.startsWith("incomparable_meters:")))

  const converted = combineMeteredCosts(parts, { meter: "input_equivalent_tokens", rates: { "opus-5": 1, "fable-5.1": 0.2 } })
  assert.equal(converted.ok, true)
  near(converted.totalEq, 110)
  assert.equal(converted.meter, "input_equivalent_tokens")

  const missing = combineMeteredCosts(parts, { meter: "input_equivalent_tokens", rates: { "opus-5": 1 } })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes("missing_common_meter_rate:fable-5.1"))

  const same = combineMeteredCosts([
    { label: "a", modelId: "opus-5", meter: "m", valueEq: 1 },
    { label: "b", modelId: "opus-5", meter: "m", valueEq: 2 },
  ])
  assert.equal(same.ok, true)
  near(same.totalEq, 3)

  const dup = combineMeteredCosts([
    { label: "a", modelId: "opus-5", meter: "m", valueEq: 1 },
    { label: "a", modelId: "opus-5", meter: "m", valueEq: 1 },
  ])
  assert.equal(dup.ok, false)
  assert.ok(dup.blockers.includes("duplicate_cost_part:a"))
})

// -------------------------------------------------- cache state at request arrival
test("warm only when the request arrives before expiry with full verified prefix coverage", () => {
  const a = cacheStateAtArrival(EVIDENCE, ARRIVAL)
  assert.equal(a.state, "warm")
  assert.equal(a.arrivalAtMs, 1_203_000)
  assert.equal(a.remainingTtlAtArrivalMs, 97_000)
  assert.equal(a.retryAllowed, false)
})

test("expiry at the arrival instant counts as expired (equality is cold)", () => {
  const exact = cacheStateAtArrival({ ...EVIDENCE, cacheExpiresAtMs: 1_203_000 }, ARRIVAL)
  assert.equal(exact.state, "cold")
  assert.ok(exact.reasons.includes("expired_at_arrival"))
  assert.equal(exact.remainingTtlAtArrivalMs, 0)
  const justWarm = cacheStateAtArrival({ ...EVIDENCE, cacheExpiresAtMs: 1_203_001 }, ARRIVAL)
  assert.equal(justWarm.state, "warm")
})

test("a request delay larger than the residual TTL is cold, not warm", () => {
  const late = cacheStateAtArrival({ ...EVIDENCE, cacheExpiresAtMs: 1_210_000 }, { ...ARRIVAL, requestArrivalDelayMs: 20_000 })
  assert.equal(late.state, "cold")
  assert.ok(late.reasons.includes("expired_at_arrival"))
})

test("unknown arrival delay or safety margin is uncertain, never assumed zero", () => {
  const noDelay = cacheStateAtArrival(EVIDENCE, { ...ARRIVAL, requestArrivalDelayMs: null })
  assert.equal(noDelay.state, "uncertain")
  assert.ok(noDelay.reasons.includes("arrival_delay_unknown"))
  assert.equal(noDelay.arrivalAtMs, null)
  const noMargin = cacheStateAtArrival(EVIDENCE, { ...ARRIVAL, safetyMarginMs: null })
  assert.equal(noMargin.state, "uncertain")
})

test("no expiry evidence and no prefix coverage evidence are both uncertain, not hits", () => {
  const noExpiry = cacheStateAtArrival({ ...EVIDENCE, cacheExpiresAtMs: null }, ARRIVAL)
  assert.equal(noExpiry.state, "uncertain")
  assert.ok(noExpiry.reasons.includes("no_expiry_evidence"))
  const noCoverage = cacheStateAtArrival({ ...EVIDENCE, verifiedPrefixTokens: null }, ARRIVAL)
  assert.equal(noCoverage.state, "uncertain")
  assert.ok(noCoverage.reasons.includes("no_prefix_coverage_evidence"))
})

test("a partially covered prefix is its own state, not a full hit and not a full miss", () => {
  const partial = cacheStateAtArrival({ ...EVIDENCE, verifiedPrefixTokens: 25_000 }, ARRIVAL)
  assert.equal(partial.state, "partial")
  assert.ok(partial.reasons.includes("partial_prefix_only"))
  assert.equal(partial.verifiedPrefixTokens, 25_000)
})

test("failed, refused and fallback warm attempts are uncertain transitions with no retry", () => {
  for (const lastOutcome of ["failed", "refused", "model_fallback", "unknown"]) {
    const a = cacheStateAtArrival({ ...EVIDENCE, lastOutcome }, ARRIVAL)
    assert.equal(a.state, "uncertain", lastOutcome)
    assert.ok(a.reasons.some((r) => r.startsWith("warm_transition_unverified:") || r === "cache_outcome_unknown"), lastOutcome)
    assert.equal(a.retryAllowed, false)
  }
})

test("a new session generation or a model/lane/prefix change invalidates cache evidence", () => {
  const gen = cacheStateAtArrival(EVIDENCE, { ...ARRIVAL, expectedGeneration: "g2" })
  assert.equal(gen.state, "uncertain")
  assert.ok(gen.reasons.includes("evidence_invalidated:session_generation"))
  const lane = cacheStateAtArrival(EVIDENCE, { ...ARRIVAL, expectedIdentity: "fable-5.1|oauth|1h|prefixA" })
  assert.equal(lane.state, "uncertain")
  assert.ok(lane.reasons.includes("evidence_invalidated:model_lane_prefix"))
})

test("TTL renewal needs usage AND prefix coverage: stop_reason or usage alone never renews", () => {
  const stale = { ...EVIDENCE, cacheExpiresAtMs: 1_300_000, lastOutcome: "verified_write" }
  const ok = applyWarmOutcome(stale, {
    outcome: "verified_write",
    requestStartedAtMs: 1_250_000,
    ttlMs: TTL,
    verifiedPrefixTokens: 150_000,
    evidenceBasis: "usage_and_prefix_coverage",
  })
  assert.equal(ok.applied, true)
  assert.equal(ok.evidence.cacheExpiresAtMs, 1_550_000)
  assert.equal(ok.evidence.lastVerifiedCacheRequestStartedAtMs, 1_250_000)

  for (const evidenceBasis of ["usage_only", "stop_reason_only", "none"]) {
    const r = applyWarmOutcome(stale, { outcome: "verified_hit", requestStartedAtMs: 1_250_000, ttlMs: TTL, verifiedPrefixTokens: 150_000, evidenceBasis })
    assert.equal(r.applied, false, evidenceBasis)
    assert.equal(r.evidence.cacheExpiresAtMs, 1_300_000, evidenceBasis)
    assert.equal(r.evidence.lastOutcome, "unknown", evidenceBasis)
    assert.ok(r.reasons.includes(`renewal_not_evidenced:${evidenceBasis}`), evidenceBasis)
  }

  for (const outcome of ["failed", "refused", "model_fallback"]) {
    const r = applyWarmOutcome(stale, { outcome, requestStartedAtMs: 1_250_000, ttlMs: TTL, verifiedPrefixTokens: null, evidenceBasis: "usage_and_prefix_coverage" })
    assert.equal(r.applied, false, outcome)
    assert.equal(r.evidence.cacheExpiresAtMs, 1_300_000, outcome) // a failed warm does not extend the TTL
    assert.equal(r.evidence.lastOutcome, outcome)
    assert.equal(r.retryScheduled, false)
  }
})

// -------------------------------------------------------- per-request arrival costs
test("a cold parent first call plus warm repeats is not one constant", () => {
  const req = (requestId, state) => ({ requestId, state, warmEq: 1_500, coldEq: 40_000, partialEq: 12_000 })
  const firstCold = requestSequenceCostEq([req("r1", "cold"), req("r2", "warm"), req("r3", "warm")])
  assert.equal(firstCold.ok, true)
  near(firstCold.totalEq, 40_000 + 1_500 + 1_500)
  assert.deepEqual(
    firstCold.perRequestEq.map((r) => r.valueEq),
    [40_000, 1_500, 1_500],
  )
  const allCold = requestSequenceCostEq([req("r1", "cold"), req("r2", "cold"), req("r3", "cold")])
  near(allCold.totalEq, 120_000)
  const mixed = requestSequenceCostEq([req("r1", "cold"), req("r2", "partial"), req("r3", "warm")])
  near(mixed.totalEq, 40_000 + 12_000 + 1_500)
})

test("uncertain arrivals block a point estimate and expose a scenario range instead", () => {
  const r = requestSequenceCostEq([
    { requestId: "r1", state: "uncertain", warmEq: 1_500, coldEq: 40_000 },
    { requestId: "r2", state: "warm", warmEq: 1_500, coldEq: 40_000 },
  ])
  assert.equal(r.ok, false)
  assert.ok(r.blockers.includes("uncertain_arrival:r1"))
  near(r.scenario.minEq, 3_000)
  near(r.scenario.maxEq, 41_500)
})

test("a partial arrival without a measured partial cost is blocked, not rounded to warm", () => {
  const r = requestSequenceCostEq([{ requestId: "r1", state: "partial", warmEq: 1_500, coldEq: 40_000 }])
  assert.equal(r.ok, false)
  assert.ok(r.blockers.includes("partial_cost_unconfigured:r1"))
})

test("a repeated request id is a double-count and is rejected", () => {
  const r = requestSequenceCostEq([
    { requestId: "r1", state: "warm", warmEq: 1, coldEq: 2 },
    { requestId: "r1", state: "warm", warmEq: 1, coldEq: 2 },
  ])
  assert.equal(r.ok, false)
  assert.ok(r.blockers.includes("duplicate_request:r1"))
})

// ------------------------------------------------------------ the preserved DP
test("AGENT_TASK fixture: LET_EXPIRE 30000, PARK 27350, KEEP_WARM 24075 and the DP keeps warm", () => {
  const r = planIdle(fixtureCosts(150_000), F20, OPT)
  near(r.costs.LET_EXPIRE, 30_000)
  near(r.costs.PARK, 27_350)
  near(r.costs.KEEP_WARM, 24_075)
  assert.equal(r.action, "KEEP_WARM")
  near(r.expectedCostEq, 24_075)
  assert.equal(r.epochCount, 5)
  assert.equal(r.vAppliedEq, 0)
})

test("K_shared = 126375 variant costs 21712.5 (same probabilities, not the same counterexample)", () => {
  const r = planIdle(fixtureCosts(126_375), F20, OPT)
  assert.equal(r.action, "KEEP_WARM")
  near(r.expectedCostEq, 21_712.5)
})

test("new shared counterexample q=24%: PARK 28020 but the DP keeps warm at 24405", () => {
  const r = planIdle(fixtureCosts(126_375), F24, OPT)
  near(r.costs.PARK, 28_020)
  assert.equal(r.action, "KEEP_WARM")
  near(r.expectedCostEq, 24_405)
})

test("x1000 normalization changes the unit, never the decision", () => {
  const tokens = planIdle(fixtureCosts(150_000), F20, OPT)
  const scaled = Object.fromEntries(Object.entries(fixtureCosts(150_000)).map(([k, v]) => [k, v / 1000]))
  const kUnits = planIdle(scaled, F20, OPT)
  assert.equal(kUnits.action, tokens.action)
  near(kUnits.expectedCostEq * 1000, tokens.expectedCostEq)
  for (const k of ["LET_EXPIRE", "PARK", "KEEP_WARM"]) near(kUnits.costs[k] * 1000, tokens.costs[k])
})

test("tie order is preserved: no request, then raw context, then compression", () => {
  const f = { returns: [{ afterMs: I, probability: 1 }], neverReturnsProbability: 0 }
  const base = { warmEq: 50, rawWarmEq: 50, parkNowEq: 60, restoreWarmEq: 40, skillRestoreEq: 0, sharedLossEq: 0, coldSharedEq: 100, coldFullEq: 100, parkQualityEq: 0 }
  const tie = planIdle(base, f, OPT)
  near(tie.costs.LET_EXPIRE, 100)
  near(tie.costs.KEEP_WARM, 100)
  near(tie.costs.PARK, 100)
  assert.equal(tie.action, "LET_EXPIRE")
  // Within the 1e-7 tie window the cheaper-looking candidate still does not win.
  assert.equal(planIdle({ ...base, rawWarmEq: 49.999999999 }, f, OPT).action, "LET_EXPIRE")
  assert.equal(planIdle({ ...base, rawWarmEq: 49 }, f, OPT).action, "KEEP_WARM")
  // PARK only wins when it is strictly cheaper than both.
  assert.equal(planIdle({ ...base, coldSharedEq: 500, coldFullEq: 500 }, f, OPT).action, "KEEP_WARM")
  assert.equal(planIdle({ ...base, coldSharedEq: 500, coldFullEq: 500, parkNowEq: 40 }, f, OPT).action, "PARK")
})

test("a return exactly at the review deadline cancels that review; expiry equality is cold", () => {
  const costs = fixtureCosts(150_000)
  const atDeadline = planIdle(costs, { returns: [{ afterMs: I, probability: 1 }], neverReturnsProbability: 0 }, OPT)
  near(atDeadline.costs.KEEP_WARM, 8_250 + 8_250) // one ping, then the warm resume it protected
  // A return that outlives the next review window needs a second ping; the boundary return did not.
  const afterNextWindow = planIdle(costs, { returns: [{ afterMs: I + 30_000, probability: 1 }], neverReturnsProbability: 0 }, OPT)
  near(afterNextWindow.costs.KEEP_WARM, 8_250 + 8_250 + 8_250)
  // LET_EXPIRE at epoch 0: a return exactly at the residual-TTL boundary is already expired.
  const boundary = planIdle(costs, { returns: [{ afterMs: 30_000, probability: 1 }], neverReturnsProbability: 0 }, { ...OPT, remainingTtlMs: 30_000 })
  near(boundary.costs.LET_EXPIRE, 150_000)
  const inside = planIdle(costs, { returns: [{ afterMs: 29_999, probability: 1 }], neverReturnsProbability: 0 }, { ...OPT, remainingTtlMs: 30_000 })
  near(inside.costs.LET_EXPIRE, 8_250)
})

test("a late-arriving ping is priced as a rewrite, and its price must be supplied", () => {
  const costs = fixtureCosts(150_000)
  const lateOpts = { ...OPT, remainingTtlMs: 30_000, requestArrivalDelayMs: 25_000, safetyMarginMs: 6_000 }
  assert.throws(() => planIdle(costs, F20, lateOpts), /coldWarmEq/)
  const withRewrite = planIdle({ ...costs, coldWarmEq: 100_000 }, F20, lateOpts)
  near(withRewrite.costs.KEEP_WARM - planIdle({ ...costs, coldWarmEq: 8_250 }, F20, lateOpts).costs.KEEP_WARM, 100_000 - 8_250)
  assert.throws(() => planIdle({ ...costs, coldWarmEq: 8_249 }, F20, lateOpts), /coldWarmEq must be >= /)
})

test("no return at all: pay nothing rather than generate a handoff", () => {
  const r = planIdle(fixtureCosts(150_000), { returns: [], neverReturnsProbability: 1 }, OPT)
  assert.equal(r.action, "LET_EXPIRE")
  near(r.expectedCostEq, 0)
})

test("a small enough cold resume beats parking", () => {
  const r = planIdle(fixtureCosts(20_000), forecastOf([0, 0, 0, 0.2], 0.8), OPT)
  assert.equal(r.action, "LET_EXPIRE")
  near(r.expectedCostEq, 4_000)
})

test("the planner has no sunk-cost input and is deterministic", () => {
  const a = planIdle(fixtureCosts(150_000), F20, OPT)
  const b = planIdle(fixtureCosts(150_000), F20, OPT)
  assert.deepEqual(a, b)
  assert.ok(!("alreadySpentEq" in OPT))
  assert.ok(!Object.keys(fixtureCosts(150_000)).some((k) => /spent|sunk|incurred/i.test(k)))
})

test("malformed forecasts and options are rejected, not silently repaired", () => {
  const c = fixtureCosts(150_000)
  assert.throws(() => planIdle(c, forecastOf([0.1, 0, 0, 0], 0.8), OPT), /sum to 1/)
  assert.throws(() => planIdle(c, { returns: [{ afterMs: 0, probability: 1 }], neverReturnsProbability: 0 }, OPT), /afterMs/)
  assert.throws(() => planIdle(c, F20, { ...OPT, intervalMs: TTL }), /intervalMs must be < ttlMs/)
  assert.throws(() => planIdle(c, F20, { ...OPT, remainingTtlMs: TTL + 1 }), /remainingTtlMs exceeds ttlMs/)
  assert.throws(() => planIdle({ ...c, restoreWarmEq: -1 }, F20, OPT), /costs.restoreWarmEq/)
  assert.throws(() => planIdle(c, F20, { ...OPT, maxEpochs: 1 }), /maxEpochs/)
})

test("the DP matches an independent forward policy enumeration on the required fixtures", () => {
  near(planIdle(fixtureCosts(150_000), F20, OPT).expectedCostEq, forwardBest(fixtureCosts(150_000), F20, OPT))
  near(planIdle(fixtureCosts(126_375), F20, OPT).expectedCostEq, forwardBest(fixtureCosts(126_375), F20, OPT))
  near(planIdle(fixtureCosts(126_375), F24, OPT).expectedCostEq, forwardBest(fixtureCosts(126_375), F24, OPT))
})

test("the DP matches the forward enumeration on 200 deterministic pseudo-random scenarios", () => {
  let seed = 20260919
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 200; i++) {
    const warmEq = 500 + rng() * 20_000
    const costs = {
      warmEq,
      coldWarmEq: warmEq + rng() * 100_000,
      rawWarmEq: rng() * 20_000,
      parkNowEq: rng() * 60_000,
      restoreWarmEq: rng() * 40_000,
      skillRestoreEq: rng() < 0.5 ? 0 : rng() * 11_000,
      sharedLossEq: rng() * 30_000,
      coldSharedEq: rng() * 200_000,
      coldFullEq: rng() * 300_000,
      parkQualityEq: rng() < 0.7 ? 0 : rng() * 50_000,
      futureWorkDifferentialEq: i % 3 === 0 ? (rng() - 0.5) * 20_000 : 0,
    }
    const masses = Array.from({ length: 5 }, rng)
    const total = masses.reduce((a, b) => a + b, 0)
    const returns = masses.slice(0, 4).map((m, k) => ({ afterMs: 10_000 + k * I + rng() * 250_000, probability: m / total }))
    const f = { returns, neverReturnsProbability: masses[4] / total }
    const o = {
      ttlMs: TTL,
      intervalMs: I,
      remainingTtlMs: Math.max(1, Math.round(rng() * TTL)),
      sharedCachePersists: i % 2 === 0,
      allowParking: i % 5 !== 0,
      requestArrivalDelayMs: i % 4 === 0 ? Math.round(rng() * 40_000) : 0,
      safetyMarginMs: i % 4 === 0 ? Math.round(rng() * 10_000) : 0,
    }
    near(planIdle(costs, f, o).expectedCostEq, forwardBest(costs, f, o), 1e-6)
  }
})

// ------------------------------------------------------- future work differential V
test("V=0 preserves the original recurrence and result exactly", () => {
  const withoutV = planIdle(fixtureCosts(150_000), F20, OPT)
  const withZeroV = planIdle(fixtureCosts(150_000, { futureWorkDifferentialEq: 0 }), F20, OPT)
  assert.deepEqual(withZeroV, withoutV)
})

test("V is applied per actual return, not unconditionally, and can flip the choice", () => {
  const v = 5_000
  const r = planIdle(fixtureCosts(150_000, { futureWorkDifferentialEq: v }), F20, OPT)
  near(r.costs.PARK, 27_350 - 0.2 * v) // only the 20% that actually return realise V
  assert.equal(r.vAppliedEq, v)
  const flip = planIdle(fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }), F20, OPT)
  assert.equal(flip.action, "PARK")
  near(flip.costs.PARK, 27_350 - 0.2 * 30_000)
})

test("V is a signed path differential over nonnegative useful-work path costs", () => {
  const raw = {
    pathId: "raw",
    completionBoundary: "task#42:tests-green",
    rolloverCutoffEq: null,
    requests: [
      { requestId: "raw-1", phase: "resume_raw", costEq: 20_000 },
      { requestId: "raw-2", phase: "useful_work", costEq: 60_000 },
    ],
  }
  const parked = {
    pathId: "parked",
    completionBoundary: "task#42:tests-green",
    rolloverCutoffEq: null,
    requests: [{ requestId: "park-1", phase: "useful_work", costEq: 45_000 }],
  }
  const d = futureWorkDifferential(raw, parked)
  assert.equal(d.ok, true)
  near(d.rawTotalEq, 80_000)
  near(d.parkedTotalEq, 45_000)
  near(d.vSignedEq, 35_000)
  // Signed the other way when parking is the more expensive path; raw totals stay nonnegative.
  const worse = futureWorkDifferential(raw, { ...parked, requests: [{ requestId: "park-1", phase: "useful_work", costEq: 100_000 }] })
  near(worse.vSignedEq, -20_000)
  assert.ok(worse.rawTotalEq >= 0 && worse.parkedTotalEq >= 0)
})

test("both paths must end at the same completion boundary and share one rollover cutoff", () => {
  const raw = { pathId: "raw", completionBoundary: "task#42:tests-green", rolloverCutoffEq: 50_000, requests: [{ requestId: "raw-1", phase: "useful_work", costEq: 90_000 }] }
  const parked = { pathId: "parked", completionBoundary: "task#42:tests-green", rolloverCutoffEq: 50_000, requests: [{ requestId: "park-1", phase: "useful_work", costEq: 30_000 }] }
  const capped = futureWorkDifferential(raw, parked)
  assert.equal(capped.ok, true)
  near(capped.rawTotalEq, 50_000) // the big-context path stops accumulating at the budget rollover
  near(capped.vSignedEq, 20_000)
  assert.equal(capped.cappedAtEq, 50_000)

  const boundary = futureWorkDifferential(raw, { ...parked, completionBoundary: "task#42:first-reply" })
  assert.equal(boundary.ok, false)
  assert.ok(boundary.blockers.includes("completion_boundary_mismatch"))

  const cutoff = futureWorkDifferential(raw, { ...parked, rolloverCutoffEq: null })
  assert.equal(cutoff.ok, false)
  assert.ok(cutoff.blockers.includes("rollover_cutoff_mismatch"))
})

test("restore requests may not be counted in V as well as in B", () => {
  const raw = { pathId: "raw", completionBoundary: "b", rolloverCutoffEq: null, requests: [{ requestId: "raw-1", phase: "useful_work", costEq: 10 }] }
  const withRestorePhase = {
    pathId: "parked",
    completionBoundary: "b",
    rolloverCutoffEq: null,
    requests: [{ requestId: "park-1", phase: "restore_child", costEq: 5 }],
  }
  const phase = futureWorkDifferential(raw, withRestorePhase)
  assert.equal(phase.ok, false)
  assert.ok(phase.blockers.includes("restore_phase_in_future_work:park-1"))

  const byId = futureWorkDifferential(
    raw,
    { pathId: "parked", completionBoundary: "b", rolloverCutoffEq: null, requests: [{ requestId: "restore-7", phase: "useful_work", costEq: 5 }] },
    { restoreRequestIds: ["restore-7"] },
  )
  assert.equal(byId.ok, false)
  assert.ok(byId.blockers.includes("restore_double_count:restore-7"))

  const negative = futureWorkDifferential(raw, { pathId: "parked", completionBoundary: "b", rolloverCutoffEq: null, requests: [{ requestId: "p", phase: "useful_work", costEq: -1 }] })
  assert.equal(negative.ok, false)
  assert.ok(negative.blockers.includes("negative_path_cost:p"))

  const swapped = futureWorkDifferential(raw, { ...raw, pathId: "raw" })
  assert.equal(swapped.ok, false)
  assert.ok(swapped.blockers.includes("path_id_mismatch"))
})

// --------------------------------------------------------- quality / approval gates
const LIMITS = {
  unit: "input_equivalent_tokens",
  maxProactiveSpendPerIdle: 50_000,
  maxTotalExperimentalSpend: 500_000,
  maxResumeDelayMs: 600_000,
  allowedQualityDegradation: 0,
  minimumEvidenceForEnforcement: "measured_coefficients_and_ab_test",
}
const GATE_OK = { limits: LIMITS, expectedQualityLossEq: 0, expectedResumeDelayMs: 120_000, unfinishedStatePreserved: true, handoffApproved: true }

test("an unconfigured quality allowance is not a zero allowance", () => {
  assert.deepEqual(parkingGates(GATE_OK), { allowParking: true, reasons: [] })
  const unset = parkingGates({ ...GATE_OK, limits: { ...LIMITS, allowedQualityDegradation: "unconfigured" } })
  assert.equal(unset.allowParking, false)
  assert.ok(unset.reasons.includes("quality_allowance_unconfigured"))
  const unmeasured = parkingGates({ ...GATE_OK, expectedQualityLossEq: null })
  assert.equal(unmeasured.allowParking, false)
  assert.ok(unmeasured.reasons.includes("quality_loss_unmeasured"))
  const over = parkingGates({ ...GATE_OK, expectedQualityLossEq: 1 })
  assert.equal(over.allowParking, false)
  assert.ok(over.reasons.includes("quality_loss_exceeds_allowance"))
})

test("approval, unfinished state and resume delay all gate parking before any optimisation", () => {
  for (const [over, reason] of [
    [{ handoffApproved: false }, "handoff_not_approved"],
    [{ unfinishedStatePreserved: false }, "unfinished_state_not_preserved"],
    [{ expectedResumeDelayMs: null }, "resume_delay_unknown"],
    [{ expectedResumeDelayMs: 900_000 }, "resume_delay_exceeds_limit"],
    [{ limits: { ...LIMITS, maxResumeDelayMs: "unconfigured" } }, "resume_delay_limit_unconfigured"],
  ]) {
    const g = parkingGates({ ...GATE_OK, ...over })
    assert.equal(g.allowParking, false, reason)
    assert.ok(g.reasons.includes(reason), `${reason}: ${g.reasons.join(",")}`)
  }
  assert.equal(parkingGates({ ...GATE_OK, limits: UNCONFIGURED_LIMITS }).allowParking, false)
})

test("a gated PARK is unavailable even when it would be the cheapest candidate", () => {
  const cheapPark = fixtureCosts(150_000, { parkNowEq: 1_000, restoreWarmEq: 0 })
  const open = planIdle(cheapPark, F20, OPT)
  assert.equal(open.action, "PARK")
  const gated = planIdle(cheapPark, F20, { ...OPT, allowParking: false })
  assert.notEqual(gated.action, "PARK")
  assert.equal(gated.costs.PARK, Infinity)
})

test("proactive spend limits are refused when unconfigured and never invented", () => {
  assert.deepEqual(proactiveSpendGate(LIMITS, 8_250, 10_000), { allowed: true, reasons: [] })
  assert.deepEqual(proactiveSpendGate(UNCONFIGURED_LIMITS, 0, 10_000), { allowed: true, reasons: [] }) // spending nothing needs no budget
  const unset = proactiveSpendGate(UNCONFIGURED_LIMITS, 8_250, 0)
  assert.equal(unset.allowed, false)
  assert.ok(unset.reasons.includes("max_proactive_spend_per_idle_unconfigured"))
  assert.ok(unset.reasons.includes("spend_unit_unconfigured"))
  assert.ok(proactiveSpendGate(LIMITS, 60_000, 0).reasons.includes("exceeds_max_proactive_spend_per_idle"))
  assert.ok(proactiveSpendGate(LIMITS, 10_000, 495_000).reasons.includes("exceeds_max_total_experimental_spend"))
})

test("sunk spend only ever reaches the explicit budget guard", () => {
  assert.equal(budgetFallback(15_000, 30_000, 55_000).action, "KEEP_WARM")
  assert.equal(budgetFallback(15_000, 45_000, 55_000).action, "LET_EXPIRE")
  assert.equal(budgetFallback(15_000, 40_000, 55_000).action, "LET_EXPIRE")
  const unconfigured = budgetFallback(15_000, 0, "unconfigured")
  assert.equal(unconfigured.action, "LET_EXPIRE")
  assert.equal(unconfigured.reason, "budget_unconfigured")
})

// ------------------------------------------------------------------- evaluator
const WARM_CACHE = { state: "warm", reasons: [], arrivalAtMs: 1_203_000, remainingTtlAtArrivalMs: 97_000, verifiedPrefixTokens: 150_000, retryAllowed: false }
const snapshot = (over = {}) => ({
  idleEpisodeId: "ep-1",
  timestampMs: 1_200_000,
  sessionGeneration: "g1",
  modelId: "opus-5",
  lane: "oauth|5m",
  contextTokens: 150_000,
  coefficientVersion: "coeff/test-1",
  coefficientStatus: "measured",
  forecastVersion: "forecast/test-1",
  parameterSources: { costs: "measured:evidence/task2", forecast: "scenario:fixture" },
  cache: WARM_CACHE,
  costs: fixtureCosts(150_000),
  costBlockers: [],
  forecast: F20,
  planner: { ttlMs: TTL, intervalMs: I, remainingTtlMs: 1, sharedCachePersists: true },
  gates: { allowParking: true, reasons: [] },
  limits: LIMITS,
  incurredSpendEq: 99_000,
  vScenario: null,
  mode: "shadow",
  ...over,
})

test("the evaluator reports all three candidates, the DP choice and its provenance", () => {
  const d = evaluateIdleCost(snapshot())
  assert.equal(d.engineVersion, IDLE_COST_ENGINE_VERSION)
  assert.equal(d.recommendedAction, "KEEP_WARM")
  assert.equal(d.reasonCode, "minimum_prospective_expected_cost")
  near(d.candidateCosts.LET_EXPIRE, 30_000)
  near(d.candidateCosts.PARK, 27_350)
  near(d.candidateCosts.KEEP_WARM, 24_075)
  assert.equal(d.enforcement, "unavailable")
  assert.equal(d.evidenceStatus, "sufficient")
  assert.equal(d.incurredSpendEq, 99_000)
  assert.deepEqual(evaluateIdleCost(snapshot()), d) // pure
})

test("no calibrated forecast logs the reason and never substitutes a return probability", () => {
  const d = evaluateIdleCost(snapshot({ forecast: null, forecastVersion: null }))
  assert.equal(d.recommendedAction, "LET_EXPIRE")
  assert.equal(d.reasonCode, "no_calibrated_forecast")
  assert.deepEqual(d.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  assert.equal(d.plan, null)
  assert.equal(d.evidenceStatus, "uncertain")
  for (const r of Object.values(d.candidateUnavailableReasons)) assert.equal(r, "no_calibrated_forecast")
})

test("the approved bounded-wait objective uses the explicit budget, not a guessed q", () => {
  const within = evaluateIdleCost(snapshot({ forecast: null, noForecastObjective: "bounded_wait", incurredSpendEq: 1_000 }))
  assert.equal(within.recommendedAction, "KEEP_WARM")
  assert.equal(within.reasonCode, "no_calibrated_forecast:within_explicit_budget")
  const exhausted = evaluateIdleCost(snapshot({ forecast: null, noForecastObjective: "bounded_wait", incurredSpendEq: 49_000 }))
  assert.equal(exhausted.recommendedAction, "LET_EXPIRE")
  const unfunded = evaluateIdleCost(snapshot({ forecast: null, noForecastObjective: "bounded_wait", limits: UNCONFIGURED_LIMITS }))
  assert.equal(unfunded.recommendedAction, "LET_EXPIRE")
  assert.equal(unfunded.reasonCode, "no_calibrated_forecast:budget_unconfigured")
})

test("an uncertain cache or an unknown cost snapshot yields blockers, never zero costs", () => {
  const uncertain = evaluateIdleCost(snapshot({ cache: { state: "uncertain", reasons: ["arrival_delay_unknown"], arrivalAtMs: null, remainingTtlAtArrivalMs: null, retryAllowed: false } }))
  assert.equal(uncertain.recommendedAction, "NO_DECISION")
  assert.equal(uncertain.reasonCode, "insufficient_evidence")
  assert.deepEqual(uncertain.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  assert.ok(uncertain.blockers.includes("cache_uncertain:arrival_delay_unknown"))
  assert.equal(uncertain.evidenceStatus, "blocked")

  const unknownCosts = evaluateIdleCost(snapshot({ costs: null, costBlockers: ["unknown_coefficient:billedModelOutput"] }))
  assert.equal(unknownCosts.recommendedAction, "NO_DECISION")
  assert.ok(unknownCosts.blockers.includes("unknown_coefficient:billedModelOutput"))
  assert.ok(unknownCosts.blockers.includes("cost_snapshot_unavailable"))
})

test("a future-saving differential without provenance is a blocker", () => {
  const d = evaluateIdleCost(snapshot({ costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }) }))
  assert.equal(d.recommendedAction, "NO_DECISION")
  assert.ok(d.blockers.includes("future_savings_without_provenance"))
  const scenario = evaluateIdleCost(
    snapshot({
      costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }),
      vScenario: { label: "V=30K optimistic", vSignedEq: 30_000, status: "scenario" },
    }),
  )
  assert.equal(scenario.recommendedAction, "PARK")
  assert.equal(scenario.evidenceStatus, "uncertain") // a scenario V is never reported as measured savings
  assert.equal(scenario.vAppliedEq, 30_000)
})

test("gated parking is reported as unavailable with its guard reasons, not as a number", () => {
  const d = evaluateIdleCost(
    snapshot({
      costs: fixtureCosts(150_000, { parkNowEq: 1_000, restoreWarmEq: 0 }),
      gates: { allowParking: false, reasons: ["quality_allowance_unconfigured"] },
    }),
  )
  assert.notEqual(d.recommendedAction, "PARK")
  assert.equal(d.candidateCosts.PARK, null)
  assert.equal(d.candidateUnavailableReasons.PARK, "quality_allowance_unconfigured")
  assert.ok(d.guardReasons.includes("quality_allowance_unconfigured"))
})

test("spend limits are recorded as guards; they never rewrite the cost-minimal recommendation", () => {
  const d = evaluateIdleCost(snapshot({ limits: UNCONFIGURED_LIMITS }))
  assert.equal(d.recommendedAction, "KEEP_WARM")
  assert.ok(d.guardReasons.includes("max_proactive_spend_per_idle_unconfigured"))
  assert.equal(d.enforcement, "unavailable")
  assert.equal(d.spendGate.allowed, false)
})

test("incurred spend is logged but never enters the decision", () => {
  const cheap = evaluateIdleCost(snapshot({ incurredSpendEq: 0 }))
  const expensive = evaluateIdleCost(snapshot({ incurredSpendEq: 10_000_000 }))
  assert.equal(cheap.recommendedAction, expensive.recommendedAction)
  assert.deepEqual(cheap.candidateCosts, expensive.candidateCosts)
  assert.equal(expensive.incurredSpendEq, 10_000_000)
})

// =====================================================================
// verify3 regressions (independent QA findings P03/P06/P10/P11/P12/P14/P16/P17/P19)
// =====================================================================

test("free residual waiting is a nonterminal action: wait now, review later, resume warm (verify3 P03)", () => {
  const costs = fixtureCosts(150_000, { coldWarmEq: 100_000 })
  const late = { returns: [{ afterMs: 2 * I, probability: 1 }], neverReturnsProbability: 0 }
  const fullTtl = { ...OPT, remainingTtlMs: TTL }
  const r = planIdle(costs, late, fullTtl)
  assert.equal(r.action, "WAIT")
  near(r.expectedCostEq, 16_500) // one review ping at 270000 plus the warm resume it protects
  near(r.costs.WAIT, 16_500)
  near(r.costs.KEEP_WARM, 24_750) // pinging now throws away the free residual TTL
  assert.equal(r.rootSpendEq, 0)
  near(r.expectedCostEq, forwardBest(costs, late, fullTtl))
})

test("waiting never beats the preserved fixtures and keeps the v1 tie order (verify3 P01/P03)", () => {
  const r = planIdle(fixtureCosts(150_000), F20, OPT)
  near(r.costs.WAIT, 30_000) // a dead residual TTL makes waiting exactly as costly as expiring
  assert.equal(r.action, "KEEP_WARM")
  near(r.expectedCostEq, 24_075)
  // LET_EXPIRE still wins an exact tie against WAIT: no speculative option value is invented.
  const f1 = { returns: [{ afterMs: I, probability: 1 }], neverReturnsProbability: 0 }
  const base = { warmEq: 50, rawWarmEq: 50, parkNowEq: 60, restoreWarmEq: 40, skillRestoreEq: 0, sharedLossEq: 0, coldSharedEq: 100, coldFullEq: 100, parkQualityEq: 0 }
  const tie = planIdle(base, f1, OPT)
  near(tie.costs.WAIT, 100)
  assert.equal(tie.action, "LET_EXPIRE")
})

test("the DP matches the full forward policy class, waiting included, on 200 scenarios (verify3 P03)", () => {
  let seed = 7771
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 200; i++) {
    const warmEq = 500 + rng() * 20_000
    const costs = {
      warmEq,
      coldWarmEq: warmEq + rng() * 100_000,
      rawWarmEq: rng() * 20_000,
      parkNowEq: rng() * 60_000,
      restoreWarmEq: rng() * 40_000,
      skillRestoreEq: 0,
      sharedLossEq: rng() * 30_000,
      coldSharedEq: rng() * 200_000,
      coldFullEq: rng() * 300_000,
      parkQualityEq: 0,
    }
    const masses = Array.from({ length: 5 }, rng)
    const total = masses.reduce((a, b) => a + b, 0)
    const returns = masses.slice(0, 4).map((m, k) => ({ afterMs: 10_000 + k * I + rng() * 250_000, probability: m / total }))
    const f = { returns, neverReturnsProbability: masses[4] / total }
    // residual TTL above one interval is exactly where free waiting exists
    const o = {
      ttlMs: TTL,
      intervalMs: I,
      remainingTtlMs: Math.max(1, Math.round(rng() * TTL)),
      sharedCachePersists: i % 2 === 0,
      allowParking: i % 5 !== 0,
      requestArrivalDelayMs: i % 4 === 0 ? Math.round(rng() * 40_000) : 0,
      safetyMarginMs: 0,
    }
    near(planIdle(costs, f, o).expectedCostEq, forwardBest(costs, f, o), 1e-6)
  }
})

test("a partial prefix without validated partial pricing blocks the decision (verify3 P06)", () => {
  const partial = cacheStateAtArrival({ ...EVIDENCE, verifiedPrefixTokens: 10_000 }, ARRIVAL)
  assert.equal(partial.state, "partial")
  const blocked = evaluateIdleCost(snapshot({ cache: partial }))
  assert.equal(blocked.recommendedAction, "NO_DECISION")
  assert.ok(blocked.blockers.includes("cost_model_not_validated_for_cache_state:partial"))
  assert.equal(blocked.candidateCosts.KEEP_WARM, null)
  assert.equal(blocked.evidenceStatus, "blocked")
  const mismatched = evaluateIdleCost(snapshot({ cache: partial, costValidation: { cacheStates: ["partial"], verifiedPrefixTokens: 25_000 } }))
  assert.equal(mismatched.recommendedAction, "NO_DECISION")
  assert.ok(mismatched.blockers.includes("partial_prefix_evidence_mismatch"))
  const declared = evaluateIdleCost(snapshot({ cache: partial, costValidation: { cacheStates: ["partial"], verifiedPrefixTokens: 10_000 } }))
  assert.equal(declared.recommendedAction, "KEEP_WARM")
})

test("unknown coefficient provenance blocks numeric candidates at the evaluator (verify3 P16)", () => {
  const unknown = evaluateIdleCost(snapshot({ coefficientStatus: "unknown" }))
  assert.equal(unknown.recommendedAction, "NO_DECISION")
  assert.ok(unknown.blockers.includes("coefficient_status_unknown"))
  assert.equal(unknown.spendGate.allowed, false)
  assert.deepEqual(unknown.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  // declared-but-unmeasured provenance still decides, but is never reported as sufficient
  const assumed = evaluateIdleCost(snapshot({ coefficientStatus: "api_assumption" }))
  assert.equal(assumed.recommendedAction, "KEEP_WARM")
  assert.equal(assumed.evidenceStatus, "uncertain")
})

test("the spend gate prices the actual root request, including a late rewrite (verify3 P10)", () => {
  const costs = fixtureCosts(2_000_000, { coldWarmEq: 100_000, parkNowEq: 1_000_000 })
  const planner = { ttlMs: TTL, intervalMs: I, remainingTtlMs: 30_000, sharedCachePersists: true, requestArrivalDelayMs: 31_000 }
  const d = evaluateIdleCost(
    snapshot({ costs, planner, forecast: { returns: [{ afterMs: 100_000, probability: 1 }], neverReturnsProbability: 0 }, incurredSpendEq: 0 }),
  )
  assert.equal(d.recommendedAction, "KEEP_WARM")
  near(d.candidateCosts.KEEP_WARM, 108_250) // 100000 rewrite + 8250 warm resume
  assert.equal(d.plan.rootSpendEq, 100_000)
  assert.equal(d.spendGate.allowed, false)
  assert.ok(d.guardReasons.includes("exceeds_max_proactive_spend_per_idle"))
})

test("the per-idle cap counts spend already incurred; the experiment cap is tracked apart (verify3 P11)", () => {
  const over = proactiveSpendGate(LIMITS, 8_250, 45_000)
  assert.equal(over.allowed, false)
  assert.ok(over.reasons.includes("exceeds_max_proactive_spend_per_idle"))
  assert.equal(proactiveSpendGate(LIMITS, 8_250, 40_000).allowed, true)
  const ledger = proactiveSpendGate(LIMITS, 8_250, { episodeIncurredEq: 1_000, experimentTotalEq: 495_000 })
  assert.equal(ledger.allowed, false)
  assert.ok(ledger.reasons.includes("exceeds_max_total_experimental_spend"))
  assert.ok(!ledger.reasons.includes("exceeds_max_proactive_spend_per_idle"))
  // the evaluator feeds the episode ledger, so an exhausted episode cannot authorise the next ping
  const d = evaluateIdleCost(snapshot({ incurredSpendEq: 45_000 }))
  assert.equal(d.spendGate.allowed, false)
  assert.ok(d.guardReasons.includes("exceeds_max_proactive_spend_per_idle"))
})

test("the applied V must equal its validated scenario (verify3 P12)", () => {
  const measuredZero = evaluateIdleCost(
    snapshot({ costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }), vScenario: { label: "measured-zero", vSignedEq: 0, status: "measured" } }),
  )
  assert.equal(measuredZero.recommendedAction, "NO_DECISION")
  assert.ok(measuredZero.blockers.includes("future_savings_scenario_mismatch"))
  const claimedButUnapplied = evaluateIdleCost(snapshot({ vScenario: { label: "hoped-for", vSignedEq: 30_000, status: "scenario" } }))
  assert.equal(claimedButUnapplied.recommendedAction, "NO_DECISION")
  assert.ok(claimedButUnapplied.blockers.includes("future_savings_scenario_mismatch"))
  const matched = evaluateIdleCost(
    snapshot({ costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }), vScenario: { label: "matched", vSignedEq: 30_000, status: "scenario" } }),
  )
  assert.equal(matched.recommendedAction, "PARK")
  assert.equal(matched.vAppliedEq, 30_000)
})

test("the common rollover boundary is a shared event, not a per-path clamp (verify3 P14)", () => {
  const p = (pathId, costs, cutoff) => ({
    pathId,
    completionBoundary: "done",
    rolloverCutoffEq: cutoff,
    requests: costs.map((costEq, i) => ({ requestId: `${pathId}${i}`, phase: "useful_work", costEq })),
  })
  const before = futureWorkDifferential(p("raw", [60], 60), p("parked", [30], 60))
  near(before.vSignedEq, 30)
  const after = futureWorkDifferential(p("raw", [60, 50], 60), p("parked", [30, 50], 60))
  near(after.vSignedEq, 30) // identical post-rollover work cannot erase the earlier saving
  assert.deepEqual(after.excludedAfterCutoff, ["raw1", "parked1"])
  assert.equal(after.boundaryIndex, 0)
  // the request that straddles the cutoff is still clamped to the shared budget
  const straddle = futureWorkDifferential(p("raw", [90_000], 50_000), p("parked", [30_000], 50_000))
  near(straddle.rawTotalEq, 50_000)
  near(straddle.vSignedEq, 20_000)
  // no cutoff means no boundary: every request counts on both paths
  const uncapped = futureWorkDifferential(p("raw", [60, 50], null), p("parked", [30, 50], null))
  near(uncapped.vSignedEq, 30)
})

test("non-finite quality or latency inputs block parking instead of authorising it (verify3 P17)", () => {
  for (const [patch, reason] of [
    [{ expectedQualityLossEq: Number.NaN }, "quality_loss_invalid"],
    [{ expectedQualityLossEq: Number.POSITIVE_INFINITY }, "quality_loss_invalid"],
    [{ expectedQualityLossEq: -1 }, "quality_loss_invalid"],
    [{ expectedResumeDelayMs: Number.NaN }, "resume_delay_invalid"],
    [{ expectedResumeDelayMs: -1 }, "resume_delay_invalid"],
    [{ limits: { ...LIMITS, allowedQualityDegradation: Number.NaN } }, "quality_allowance_invalid"],
    [{ limits: { ...LIMITS, maxResumeDelayMs: Number.NaN } }, "resume_delay_limit_invalid"],
  ]) {
    const g = parkingGates({ ...GATE_OK, ...patch })
    assert.equal(g.allowParking, false, reason)
    assert.ok(g.reasons.includes(reason), `${reason}: ${g.reasons.join(",")}`)
  }
  assert.equal(parkingGates(GATE_OK).allowParking, true)
})

test("an empty meter unit is not a declared unit (verify3 P19)", () => {
  const missing = convertUsage(usageOf({ uncachedInput: 10 }), { ...COEFF, quotaMeterOrCostUnit: "" })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes("meter_unit_missing"))
  assert.equal(convertUsage(usageOf({ uncachedInput: 10 }), { ...COEFF, quotaMeterOrCostUnit: "   " }).ok, false)
  const combined = combineMeteredCosts([
    { label: "parent", modelId: "a", meter: "", valueEq: 100 },
    { label: "child", modelId: "b", meter: "", valueEq: 50 },
  ])
  assert.equal(combined.ok, false)
  assert.ok(combined.blockers.includes("meter_unit_missing:parent"))
  assert.ok(combined.blockers.includes("meter_unit_missing:child"))
  const blankCommon = combineMeteredCosts([{ label: "a", modelId: "a", meter: "m", valueEq: 1 }], { meter: " ", rates: { a: 1 } })
  assert.equal(blankCommon.ok, false)
  assert.ok(blankCommon.blockers.includes("common_meter_unit_missing"))
})

// ------------------------------------------------ verify3 recheck1/recheck2 regressions
for (const cutoff of [null, 1_000]) {
  test(`complete unequal paths retain all work when cutoff is ${cutoff} (dp-regressions R04/R05)`, () => {
    const p = (pathId, costs) => ({
      pathId,
      completionBoundary: "done",
      rolloverCutoffEq: cutoff,
      requests: costs.map((costEq, i) => ({ requestId: pathId + i, phase: "useful_work", costEq })),
    })
    const d = futureWorkDifferential(p("raw", [60]), p("parked", [30, 50]))
    assert.equal(d.ok, true)
    near(d.rawTotalEq, 60)
    near(d.parkedTotalEq, 80)
    near(d.vSignedEq, -20)
    assert.deepEqual(d.excludedAfterCutoff, [])
    assert.equal(d.cappedAtEq, cutoff)
  })
}

for (const [boundary, rawCosts, parkedCosts] of [
  ["middle", [60, 50], [10, 20, 50]],
  ["final", [60], [30, 50]],
]) {
  test(`reached cutoff rejects unequal sequences at the ${boundary} raw event (dp-regressions R10/B01)`, () => {
    const p = (pathId, costs) => ({
      pathId,
      completionBoundary: "done",
      rolloverCutoffEq: 60,
      requests: costs.map((costEq, i) => ({ requestId: pathId + i, phase: "useful_work", costEq })),
    })
    const d = futureWorkDifferential(p("raw", rawCosts), p("parked", parkedCosts))
    assert.equal(d.ok, false)
    assert.ok(d.blockers.includes("unequal_request_sequences_with_cutoff_alignment_assumption"))
    assert.equal(d.vSignedEq, undefined)
    assert.equal(d.rawTotalEq, undefined)
    assert.equal(d.parkedTotalEq, undefined)
  })
}

test("equal sequences remain supported at middle and final cutoff events (dp-regressions B02)", () => {
  const p = (pathId, costs) => ({
    pathId,
    completionBoundary: "done",
    rolloverCutoffEq: 60,
    requests: costs.map((costEq, i) => ({ requestId: pathId + i, phase: "useful_work", costEq })),
  })
  for (const [rawCosts, parkedCosts, excluded] of [
    [[60], [30], []],
    [[60, 50], [30, 50], ["raw1", "parked1"]],
    [[20, 40], [10, 20], []],
  ]) {
    const d = futureWorkDifferential(p("raw", rawCosts), p("parked", parkedCosts))
    assert.equal(d.ok, true)
    near(d.rawTotalEq, 60)
    near(d.parkedTotalEq, 30)
    near(d.vSignedEq, 30)
    assert.equal(d.boundaryIndex, rawCosts[0] === 60 ? 0 : 1)
    assert.deepEqual(d.excludedAfterCutoff, excluded)
  }
})

for (const [requestArrivalDelayMs, safetyMarginMs] of [[31_000, 0], [30_000, 0], [25_000, 6_000], [25_000, 5_000]]) {
  test(`bounded wait prices rewrite with arrival ${requestArrivalDelayMs} and margin ${safetyMarginMs} (dp-regressions R06/B03)`, () => {
    const planner = { ...snapshot().planner, remainingTtlMs: 30_000, requestArrivalDelayMs, safetyMarginMs }
    const cache = cacheStateAtArrival(
      { ...EVIDENCE, cacheExpiresAtMs: ARRIVAL.decisionAtMs + 30_000 },
      { ...ARRIVAL, requestArrivalDelayMs, safetyMarginMs },
    )
    assert.equal(cache.state, "cold")
    const s = snapshot({ costs: fixtureCosts(150_000, { coldWarmEq: 100_000 }), planner, cache, forecast: null, forecastVersion: null, noForecastObjective: "bounded_wait", incurredSpendEq: 0 })
    const over = evaluateIdleCost(s)
    assert.equal(over.recommendedAction, "LET_EXPIRE")
    assert.equal(over.reasonCode, "no_calibrated_forecast:explicit_budget_exhausted")
    assert.deepEqual(over.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
    assert.equal(over.plan, null)
    assert.equal(over.evidenceStatus, "uncertain")
    const enough = evaluateIdleCost({ ...s, limits: { ...LIMITS, maxProactiveSpendPerIdle: 150_000 } })
    assert.equal(enough.recommendedAction, "KEEP_WARM")
    assert.equal(enough.spendGate.allowed, true)
    assert.equal(enough.reasonCode, "no_calibrated_forecast:within_explicit_budget")
    // The strict episode budget includes the rewrite AND incurred spend.
    const exhausted = evaluateIdleCost({ ...s, limits: { ...LIMITS, maxProactiveSpendPerIdle: 150_000 }, incurredSpendEq: 50_000 })
    assert.equal(exhausted.recommendedAction, "LET_EXPIRE")
    assert.equal(exhausted.reasonCode, "no_calibrated_forecast:explicit_budget_exhausted")
    // Sufficient episode funding cannot hide an experiment cap using warm-read pricing.
    const experiment = evaluateIdleCost({ ...s, limits: { ...LIMITS, maxProactiveSpendPerIdle: 150_000 }, experimentTotalSpendEq: 450_000 })
    assert.equal(experiment.recommendedAction, "KEEP_WARM")
    assert.equal(experiment.spendGate.allowed, false)
    assert.ok(experiment.guardReasons.includes("exceeds_max_total_experimental_spend"))
  })
}

test("bounded wait before expiry still prices a warm read (dp-regressions B03 control)", () => {
  const planner = { ...snapshot().planner, remainingTtlMs: 30_000, requestArrivalDelayMs: 25_000, safetyMarginMs: 4_999 }
  const d = evaluateIdleCost(snapshot({ costs: fixtureCosts(150_000, { coldWarmEq: 100_000 }), planner, forecast: null, noForecastObjective: "bounded_wait", incurredSpendEq: 0 }))
  assert.equal(d.recommendedAction, "KEEP_WARM")
  assert.equal(d.spendGate.allowed, true)
})

test("bounded wait with an unpriced root rewrite records unavailable evidence and spends nothing (dp-regressions B04)", () => {
  const planner = { ...snapshot().planner, remainingTtlMs: 30_000, requestArrivalDelayMs: 31_000 }
  const d = evaluateIdleCost(snapshot({ planner, forecast: null, noForecastObjective: "bounded_wait", incurredSpendEq: 0 }))
  assert.equal(d.recommendedAction, "LET_EXPIRE")
  assert.ok(d.blockers.includes("no_forecast_late_rewrite_unpriced"))
  assert.equal(d.reasonCode, "no_calibrated_forecast")
  assert.deepEqual(d.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  assert.equal(d.plan, null)
  assert.equal(d.evidenceStatus, "uncertain")
  assert.equal(d.spendGate.allowed, true) // the selected action spends zero, not an authorized rewrite
})

for (const vSignedEq of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  for (const status of ["measured", "scenario"]) {
    test(`nonfinite ${status} V ${vSignedEq} blocks numeric candidates (dp-regressions R07/B05)`, () => {
      const d = evaluateIdleCost(snapshot({
        costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }),
        vScenario: { label: "invalid-measurement", vSignedEq, status },
      }))
      assert.equal(d.recommendedAction, "NO_DECISION")
      assert.equal(d.reasonCode, "insufficient_evidence")
      assert.equal(d.evidenceStatus, "blocked")
      assert.ok(d.blockers.includes("future_savings_scenario_nonfinite"))
      assert.deepEqual(d.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
      assert.equal(d.plan, null)
      assert.equal(d.spendGate.allowed, false)
    })
  }
}

test("finite V must match and retains measured versus scenario provenance (dp-regressions B05 control)", () => {
  for (const status of ["measured", "scenario"]) {
    const s = snapshot({ costs: fixtureCosts(150_000, { futureWorkDifferentialEq: 30_000 }), vScenario: { label: "finite", vSignedEq: 30_000, status } })
    const matched = evaluateIdleCost(s)
    assert.equal(matched.recommendedAction, "PARK")
    assert.equal(matched.evidenceStatus, status === "measured" ? "sufficient" : "uncertain")
    assert.equal(matched.vAppliedEq, 30_000)
    assert.deepEqual(matched.blockers, [])
    const mismatched = evaluateIdleCost({ ...s, vScenario: { ...s.vScenario, vSignedEq: 0 } })
    assert.equal(mismatched.recommendedAction, "NO_DECISION")
    assert.ok(mismatched.blockers.includes("future_savings_scenario_mismatch"))
  }
})

test("forecasted unpriced cold-root rewrite returns blocked evidence instead of throwing (dp-regressions B06)", () => {
  const planner = { ...snapshot().planner, remainingTtlMs: 30_000, requestArrivalDelayMs: 31_000 }
  const cache = cacheStateAtArrival(
    { ...EVIDENCE, cacheExpiresAtMs: ARRIVAL.decisionAtMs + 30_000 },
    { ...ARRIVAL, requestArrivalDelayMs: 31_000, safetyMarginMs: 0 },
  )
  assert.equal(cache.state, "cold")
  let d
  assert.doesNotThrow(() => { d = evaluateIdleCost(snapshot({ planner, cache, incurredSpendEq: 0 })) })
  assert.equal(d.recommendedAction, "NO_DECISION")
  assert.equal(d.reasonCode, "insufficient_evidence")
  assert.equal(d.evidenceStatus, "blocked")
  assert.ok(d.blockers.includes("forecast_late_rewrite_unpriced"))
  assert.deepEqual(d.candidateCosts, { WAIT: null, KEEP_WARM: null, PARK: null, LET_EXPIRE: null })
  assert.equal(d.plan, null)
  assert.equal(d.spendGate.allowed, true) // zero spend for NO_DECISION, never a proactive authorization
  assert.throws(() => planIdle(fixtureCosts(150_000), F20, { ...planner, allowParking: true }), /coldWarmEq/)
})
