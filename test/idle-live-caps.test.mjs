// Tests for scripts/idle-live/caps.mjs and scripts/idle-live/gauge.mjs.
// Both modules are pure: no I/O, no timers, no clock. Everything here is arithmetic.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  RESOLUTION,
  PRIOR_RANGE_ONLY,
  ticks,
  spentObservedEq,
  spentUpperEq,
  cumulative,
  predictedTicks,
  scopeKey,
  gate,
} from "../scripts/idle-live/caps.mjs"
import {
  METERS,
  RHO,
  PING_TICKS,
  DIAL_TICKS,
  metersOf,
  sameWindow,
  settled,
  phaseLedger,
} from "../scripts/idle-live/gauge.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`)

// ------------------------------------------------------------------ fixtures

const R5 = 1789765800
const reading = (util, reset = R5, status = "allowed") => ({ util, reset, status })

const APPROVAL = {
  plans: {
    "fable-write-tick": {
      limits: {
        maxProactiveSpendPerIdle: { value: 0.02, unit: "quota_fraction" },
        maxTotalExperimentalSpend: { value: 0.04, unit: "quota_fraction" },
      },
    },
    "output-quota": {
      limits: {
        maxProactiveSpendPerIdle: { value: 0.03, unit: "quota_fraction" },
        maxTotalExperimentalSpend: { value: 0.08, unit: "quota_fraction" },
      },
    },
  },
  perMeterCumulativeCaps: { "unified-5h": 0.53, "unified-7d": 0.12, "unified-7d_oi": 0.12 },
  perIdleScope: { "fable-write-tick": "block", "output-quota": "block" },
  campaignStop: { "unified-7d_oi": 0.11, "unified-7d": 0.11, "unified-5h": 0.5 },
  unpricedCallMaxTokens: 20000,
}

const step = (over = {}) => ({
  id: "fable-write-tick/block-1/3",
  experiment: "fable-write-tick",
  arm: "block-1",
  index: 3,
  kind: "write",
  phase: "observe",
  prompt: { text: "", sha256: "x", chars: 242000, tokensEst: 71300 },
  dominantField: "cacheWrite1h",
  expect: { ttlLane: "1h" },
  ...over,
})

// A state where every meter and every scope starts at a baseline and has moved to `latest`.
function stateFor({ baseline = 0.12, latest = 0.13, meterLatest = {}, meterBaseline = {}, extra = {} } = {}) {
  const meters = {}
  for (const m of METERS) {
    meters[m] = {
      baseline: reading(meterBaseline[m] ?? 0.1),
      latest: reading(meterLatest[m] ?? 0.1),
      closedWindows: [],
    }
  }
  return {
    status: "allowed",
    inDoubt: false,
    meters,
    scopes: {
      "fable-write-tick/block-1": { meter: "unified-5h", baseline: reading(baseline), latest: reading(latest), closedWindows: [] },
      "plan:fable-write-tick": { meter: "unified-5h", baseline: reading(baseline), latest: reading(latest), closedWindows: [] },
    },
    runObservations: [],
    ...extra,
  }
}

// ------------------------------------------------------------------- ticks

test("ticks: quantized difference inside one reset window", () => {
  assert.equal(ticks(reading(0.12), reading(0.13)), 1)
  assert.equal(ticks(reading(0.12), reading(0.12)), 0)
  assert.equal(ticks(reading(0.12), reading(0.15)), 3)
  // floating noise must not produce 0.9999 ticks
  assert.equal(ticks(reading(0.07), reading(0.1)), 3)
  assert.equal(ticks(reading(0.12), reading(0.13), 0.01), 1)
})

test("ticks: null across reset epochs (stale_state)", () => {
  assert.equal(ticks(reading(0.12, R5), reading(0.01, R5 + 18000)), null)
})

test("ticks: null for malformed readings, never throws (malformed_input)", () => {
  assert.equal(ticks(reading(NaN), reading(0.13)), null)
  assert.equal(ticks(reading(0.12), reading(undefined)), null)
  assert.equal(ticks(undefined, reading(0.13)), null)
  assert.equal(ticks(reading(0.12), null), null)
  assert.equal(ticks({ util: 0.12, reset: undefined }, { util: 0.13, reset: R5 }), null)
})

test("spentObservedEq / spentUpperEq: upper = observed + resolution", () => {
  near(spentObservedEq(reading(0.12), reading(0.13)), 0.01)
  near(spentUpperEq(reading(0.12), reading(0.13)), 0.02)
  near(spentObservedEq(reading(0.12), reading(0.12)), 0)
  near(spentUpperEq(reading(0.12), reading(0.12)), 0.01)
  assert.equal(spentObservedEq(reading(0.12, R5), reading(0.01, R5 + 1)), null)
  assert.equal(spentUpperEq(reading(0.12, R5), reading(0.01, R5 + 1)), null)
  assert.equal(RESOLUTION, 0.01)
})

test("cumulative: sums spentUpperEq over reset windows; a broken window is an issue, not a throw", () => {
  const ok = cumulative([
    { baseline: reading(0.12, R5), latest: reading(0.15, R5) },
    { baseline: reading(0.0, R5 + 18000), latest: reading(0.02, R5 + 18000) },
  ])
  near(ok.observedEq, 0.05)
  near(ok.upperEq, 0.07)
  assert.deepEqual(ok.issues, [])
  const bad = cumulative([{ baseline: reading(0.12, R5), latest: reading(0.15, R5 + 1) }])
  assert.equal(bad.upperEq, null)
  assert.equal(bad.issues[0].code, "reset_changed")
  const empty = cumulative([])
  assert.equal(empty.upperEq, 0)
  const nan = cumulative([{ baseline: reading(NaN), latest: reading(0.1) }])
  assert.equal(nan.upperEq, null)
  assert.equal(nan.issues[0].code, "invalid_reading")
})

// ------------------------------------------------------------ predictions

test("PRIOR_RANGE_ONLY is the 09-19 reported range, labelled reported_unverified", () => {
  assert.deepEqual(PRIOR_RANGE_ONLY.cacheWrite1h, [102000, 143000])
  assert.deepEqual(PRIOR_RANGE_ONLY.cacheRead, [5390000, 5550000])
  assert.equal(PRIOR_RANGE_ONLY.sourceKind, "reported_unverified")
  assert.match(PRIOR_RANGE_ONLY.evidenceRef, /quota-test\/2026-09-19\/REPORT\.md/)
  assert.ok(Object.isFrozen(PRIOR_RANGE_ONLY))
})

test("predictedTicks tier 2: prior range (low tokens per tick) when no run observation", () => {
  const p = predictedTicks(step(), [], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.ticks, 1) // ceil(71300 / 102000)
  assert.equal(p.tier, 2)
  const big = predictedTicks(step({ prompt: { tokensEst: 142700 } }), [], PRIOR_RANGE_ONLY, 20000)
  assert.equal(big.ticks, 2) // ceil(142700 / 102000)
  assert.equal(big.tier, 2)
  const dial = predictedTicks(step({ kind: "dial", dominantField: "cacheRead", prompt: { tokensEst: 145655 } }), [], PRIOR_RANGE_ONLY, 20000)
  assert.equal(dial.ticks, 1) // ceil(145655 / 5390000)
  assert.equal(dial.tier, 2)
})

test("predictedTicks tier 1: run observation of the same kind wins over the prior", () => {
  // A 71.3K write observed to move the gauge 2 ticks once -> T > 71300/3 -> a 71.3K write predicts 3.
  // Tier 1 only uses settled observations of the step's own kind AND dominant field (I2).
  const obs = [
    { kind: "write", dominantField: "cacheWrite1h", tokens: 71300, ticks: 2, settled: true },
    { kind: "dial", dominantField: "cacheRead", tokens: 145655, ticks: 0, settled: true },
  ]
  const p = predictedTicks(step(), obs, PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.tier, 1)
  assert.equal(p.ticks, 3)
  // a different kind's observation is not used
  const q = predictedTicks(step({ kind: "probe" }), obs, PRIOR_RANGE_ONLY, 20000)
  assert.equal(q.tier, 2)
})

test("predictedTicks tier 3: 1 tick for unpriced small calls, unpredictable otherwise", () => {
  const ping = step({ kind: "ping", dominantField: "cacheWrite5m", prompt: { tokensEst: 3437 } })
  const p = predictedTicks(ping, [], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.ticks, 1)
  assert.equal(p.tier, 3)
  const huge = step({ kind: "probe", dominantField: "cacheWrite5m", prompt: { tokensEst: 20001 } })
  assert.equal(predictedTicks(huge, [], PRIOR_RANGE_ONLY, 20000).ticks, "unpredictable")
  // no priors at all and above the unpriced bound -> unpredictable
  assert.equal(predictedTicks(step(), [], {}, 20000).ticks, "unpredictable")
  // malformed tokensEst -> unpredictable, no throw
  assert.equal(predictedTicks(step({ prompt: { tokensEst: NaN } }), [], PRIOR_RANGE_ONLY, 20000).ticks, "unpredictable")
  assert.equal(predictedTicks(step({ prompt: undefined }), [], PRIOR_RANGE_ONLY, 20000).ticks, "unpredictable")
})

test("predictedTicks: output-dominated calls use the output target and the output ratio prior", () => {
  const out = step({ kind: "probe", dominantField: "billedModelOutput", prompt: { tokensEst: 40 }, expect: { outputTokensTarget: 8000 } })
  const p = predictedTicks(out, [], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.tier, 2)
  assert.equal(p.ticks, 1) // 8000 * 2.5 / 102000 < 1
})

// Tier 1 (plan todo 7, I2/I8). A call of W tokens that moved the gauge n ticks bounds the price
// T > W/(n+1). Every valid bound holds at once, so the tightest (max) is the one to use - but only
// from settled observations of the step's own kind and dominant field, and never below the price
// the step gets without any observation.
const settledObs = (over = {}) => ({ kind: "write", dominantField: "cacheWrite1h", tokens: 71300, ticks: 2, settled: true, ...over })

test("I2a tier 1: a cache-miss observation (cache_read=3) next to a normal settled one does not explode a large read", () => {
  // The miss read 3 tokens and still ticked once: T > 1.5 is true and useless. The normal read of
  // the same 145K prefix moved nothing: T > 145655. A 145K read must stay at the prior's 1 tick,
  // not ceil(145655 / 1.5) = 97104.
  const dial = step({ kind: "dial", dominantField: "cacheRead", prompt: { tokensEst: 145655 } })
  const miss = settledObs({ kind: "dial", dominantField: "cacheRead", tokens: 3, ticks: 1 })
  const normal = settledObs({ kind: "dial", dominantField: "cacheRead", tokens: 145655, ticks: 0 })
  for (const obs of [[miss, normal], [normal, miss]]) {
    const p = predictedTicks(dial, obs, PRIOR_RANGE_ONLY, 20000)
    assert.equal(p.ticks, 1, `observations in order ${obs.map((o) => o.tokens).join(", ")}`)
  }
})

test("I2b tier 1: an observation with a different dominantField is ignored", () => {
  const write = step() // write / cacheWrite1h / 71.3K -> the prior prices it at 1 tick
  const other = settledObs({ dominantField: "cacheRead" }) // same kind, read-priced
  const p = predictedTicks(write, [other], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.tier, 2)
  assert.equal(p.ticks, 1)
  // a missing field is not a match either
  const q = predictedTicks(write, [{ kind: "write", tokens: 71300, ticks: 2, settled: true }], PRIOR_RANGE_ONLY, 20000)
  assert.equal(q.tier, 2)
  assert.equal(q.ticks, 1)
  // control: the same observation carrying the step's own field is used
  const c = predictedTicks(write, [settledObs()], PRIOR_RANGE_ONLY, 20000)
  assert.equal(c.tier, 1)
  assert.equal(c.ticks, 3)
})

test("I2c tier 1: an observation not marked settled:true is ignored (stale_state)", () => {
  // Delayed accounting: an immediate zero delta after a 141K write is silence, not a sub-tick
  // price. Used, it would price the next 141K write at 1 tick where the prior says 2.
  const big = step({ prompt: { tokensEst: 141000 } })
  const silent = { kind: "write", dominantField: "cacheWrite1h", tokens: 141000, ticks: 0 }
  const p = predictedTicks(big, [silent], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.ticks, 2)
  assert.equal(p.tier, 2)
  // ignored, not merely floored: an unsettled observation that would RAISE the price is dropped too
  for (const settled of [undefined, false, null, "true", 1]) {
    const o = settledObs({ settled })
    if (settled === undefined) delete o.settled
    const q = predictedTicks(step(), [o], PRIOR_RANGE_ONLY, 20000)
    assert.equal(q.tier, 2, `settled: ${String(settled)}`)
    assert.equal(q.ticks, 1, `settled: ${String(settled)}`)
  }
  // control: marked settled:true, the same observation is used
  const s = predictedTicks(step(), [settledObs()], PRIOR_RANGE_ONLY, 20000)
  assert.equal(s.tier, 1)
  assert.equal(s.ticks, 3)
})

test("I2d tier 1 never predicts fewer ticks than tier 2 (misleading_success_output)", () => {
  // A settled, matching observation that bounds T ABOVE the prior's low end must not lower the price.
  const big = step({ prompt: { tokensEst: 141000 } })
  const cheap = settledObs({ tokens: 141000, ticks: 0 })
  const p = predictedTicks(big, [cheap], PRIOR_RANGE_ONLY, 20000)
  assert.equal(p.ticks, 2) // ceil(141000 / 102000), never ceil(141000 / 141000)
  assert.equal(p.tier, 2)

  // ...so the gate cannot be talked into admitting it: 0.01 observed + 2 ticks > the 0.02 per-idle cap
  const r = gate(big, stateFor({ baseline: 0.12, latest: 0.13, extra: { runObservations: [cheap] } }), APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.equal(r.accounting.predictedTicks, 2)
  assert.ok(r.reasons.some((x) => x.code === "cap_exceeded" && x.scope === "idle:fable-write-tick/block-1"), JSON.stringify(r.reasons))

  // Property over a fixed grid: whatever settled, matching observations say, the prediction is
  // never below the one without observations, and a call nothing can price stays unpredictable.
  const cases = [
    { kind: "write", dominantField: "cacheWrite1h", sizes: [1, 20000, 71300, 101999, 102000, 102001, 141000, 142700, 500000] },
    { kind: "dial", dominantField: "cacheRead", sizes: [3437, 145655, 5389999, 5390000, 5390001, 20000000] },
    { kind: "work", dominantField: "uncachedInput", sizes: [40, 71300, 204001] },
    { kind: "probe", dominantField: "billedModelOutput", sizes: [8000, 40800, 40801, 100000], output: true },
    { kind: "probe", dominantField: "cacheWrite5m", sizes: [3437, 20000, 20001, 500000] },
  ]
  const tokens = [1, 3, 1000, 71300, 141000, 5390000, 1e9]
  const ticksSeen = [0, 1, 2, 7]
  const beats = (got, floor) => (floor === "unpredictable" ? got === "unpredictable" : typeof got === "number" && got >= floor)
  let checked = 0
  for (const c of cases) {
    const obsSet = tokens.flatMap((t) => ticksSeen.map((n) => settledObs({ kind: c.kind, dominantField: c.dominantField, tokens: t, ticks: n })))
    for (const size of c.sizes) {
      const s = c.output
        ? step({ kind: c.kind, dominantField: c.dominantField, prompt: { tokensEst: 40 }, expect: { outputTokensTarget: size } })
        : step({ kind: c.kind, dominantField: c.dominantField, prompt: { tokensEst: size } })
      const floor = predictedTicks(s, [], PRIOR_RANGE_ONLY, 20000).ticks
      for (const obs of [...obsSet.map((o) => [o]), obsSet]) {
        const got = predictedTicks(s, obs, PRIOR_RANGE_ONLY, 20000).ticks
        assert.ok(beats(got, floor), `${c.dominantField} ${size} tokens: ${got} < ${floor} with ${JSON.stringify(obs.length === 1 ? obs[0] : "all")}`)
        checked += 1
      }
    }
  }
  assert.equal(checked, 26 * 29)
})

test("I2 tier 1: malformed observations are ignored, never a throw (malformed_input)", () => {
  const write = step() // the prior prices it at 1 tick; the good observation below raises it to 3
  const good = settledObs()
  const bad = [
    null, undefined, 0, "obs", [],
    settledObs({ tokens: NaN }), settledObs({ tokens: -71300 }), settledObs({ tokens: 0 }), settledObs({ tokens: Infinity }), settledObs({ tokens: "71300" }), settledObs({ tokens: undefined }),
    settledObs({ ticks: NaN }), settledObs({ ticks: -1 }), settledObs({ ticks: 0.5 }), settledObs({ ticks: Infinity }), settledObs({ ticks: "2" }), settledObs({ ticks: undefined }),
    settledObs({ kind: undefined }), settledObs({ dominantField: undefined }), settledObs({ settled: undefined }),
  ]
  bad.forEach((o, i) => {
    const p = predictedTicks(write, [o], PRIOR_RANGE_ONLY, 20000)
    assert.equal(p.tier, 2, `bad[${i}]`)
    assert.equal(p.ticks, 1, `bad[${i}]`)
  })
  for (const obs of [undefined, null, {}, "obs", 42]) assert.equal(predictedTicks(write, obs, PRIOR_RANGE_ONLY, 20000).tier, 2)
  // a malformed entry does not hide a good one next to it
  const mixed = predictedTicks(write, [...bad, good], PRIOR_RANGE_ONLY, 20000)
  assert.equal(mixed.tier, 1)
  assert.equal(mixed.ticks, 3)
})

// ------------------------------------------------------------------ scopes

test("scopeKey yields experiment/arm-head", () => {
  assert.equal(scopeKey(step()), "fable-write-tick/block-1")
  assert.equal(scopeKey({ experiment: "policy-effect", arm: "pair-2/candidate" }), "policy-effect/pair-2")
  assert.equal(scopeKey({ experiment: "restore-decomposition", arm: "run-1" }), "restore-decomposition/run-1")
  assert.equal(scopeKey({ experiment: "x", arm: undefined }), null)
})

// -------------------------------------------------------------------- gate

test("gate ok: observed 0.01 + predicted 1 tick fits a 0.02 per-idle cap (manual QA happy path)", () => {
  const r = gate(step(), stateFor({ baseline: 0.12, latest: 0.13 }), APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, true, JSON.stringify(r.reasons))
  assert.deepEqual(r.reasons, [])
  assert.equal(r.accounting.predictedTicks, 1)
  near(r.accounting.predictedEq, 0.01)
  const idle = r.accounting.caps.find((c) => c.scope === "idle:fable-write-tick/block-1")
  near(idle.spentObservedEq, 0.01)
  near(idle.spentUpperEq, 0.02)
  near(idle.capEq, 0.02)
  near(idle.remainingUpperEq, 0)
  assert.ok(r.accounting.caps.some((c) => c.scope === "plan-total:fable-write-tick"))
  assert.ok(r.accounting.caps.some((c) => c.scope === "meter:unified-5h"))
  assert.ok(r.accounting.caps.some((c) => c.scope === "campaign-stop:unified-7d_oi"))
})

test("gate refuses the per-idle scope when observed + predicted exceeds it (manual QA failure path)", () => {
  const r = gate(step(), stateFor({ baseline: 0.12, latest: 0.14 }), APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  const tripped = r.reasons.filter((x) => x.code === "cap_exceeded").map((x) => x.scope)
  assert.ok(tripped.includes("idle:fable-write-tick/block-1"), JSON.stringify(r.reasons))
})

test("gate refuses the plan-total scope independently of the per-idle scope", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12 })
  s.scopes["plan:fable-write-tick"] = { meter: "unified-5h", baseline: reading(0.1), latest: reading(0.14), closedWindows: [] }
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  const tripped = r.reasons.filter((x) => x.code === "cap_exceeded").map((x) => x.scope)
  assert.deepEqual(tripped, ["plan-total:fable-write-tick"])
})

test("gate sums closed reset windows with spentUpperEq for a scope", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12 })
  // plan total: closed window spent 0.02 observed -> 0.03 upper; current window 0 -> 0.03 + 0.01 <= 0.04 ok
  s.scopes["plan:fable-write-tick"].closedWindows = [{ baseline: reading(0.3, R5 - 18000), latest: reading(0.32, R5 - 18000) }]
  assert.equal(gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY).ok, true)
  // one more observed tick in the current window -> 0.03 + 0.01 + 0.01 > 0.04
  s.scopes["plan:fable-write-tick"].latest = reading(0.13)
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "cap_exceeded" && x.scope === "plan-total:fable-write-tick"))
})

test("gate refuses on the campaign stop for unified-7d_oi", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12, meterBaseline: { "unified-7d_oi": 0.65 }, meterLatest: { "unified-7d_oi": 0.76 } })
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "cap_exceeded" && x.scope === "campaign-stop:unified-7d_oi"), JSON.stringify(r.reasons))
  // 0.10 observed + 0.01 predicted = 0.11, not above the stop -> still allowed to start
  const s2 = stateFor({ baseline: 0.12, latest: 0.12, meterBaseline: { "unified-7d_oi": 0.65 }, meterLatest: { "unified-7d_oi": 0.75 } })
  assert.equal(gate(step(), s2, APPROVAL, PRIOR_RANGE_ONLY).ok, true)
})

test("gate refuses on the per-meter cumulative cap", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12, meterBaseline: { "unified-5h": 0.1 }, meterLatest: { "unified-5h": 0.63 } })
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "cap_exceeded" && x.scope === "meter:unified-5h"))
})

test("gate refuses an unpredictable call even at zero spend (misleading_success_output)", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12 })
  const huge = step({ kind: "probe", dominantField: "cacheWrite5m", prompt: { tokensEst: 500000 } })
  const r = gate(huge, s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "unpredictable_call"))
  assert.equal(r.accounting.predictedTicks, "unpredictable")
})

test("gate refuses when the reset epoch changed since the scope baseline (stale_state)", () => {
  const s = stateFor({ baseline: 0.12, latest: 0.12 })
  s.scopes["fable-write-tick/block-1"].latest = reading(0.0, R5 + 18000)
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "reset_changed" && x.scope === "idle:fable-write-tick/block-1"))
})

test("gate refuses when status is not allowed or a step is in doubt", () => {
  const s = stateFor()
  s.status = "allowed_warning"
  assert.ok(gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY).reasons.some((x) => x.code === "status_not_allowed"))
  const d = stateFor()
  d.inDoubt = true
  assert.ok(gate(step(), d, APPROVAL, PRIOR_RANGE_ONLY).reasons.some((x) => x.code === "in_doubt_step"))
})

test("gate: NaN/undefined utilization and a missing meter are explicit issues, never a throw (malformed_input)", () => {
  const s = stateFor()
  s.scopes["fable-write-tick/block-1"].latest = reading(NaN)
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.code === "invalid_reading" && x.scope === "idle:fable-write-tick/block-1"))

  const m = stateFor()
  delete m.meters["unified-7d_oi"]
  const r2 = gate(step(), m, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r2.ok, false)
  assert.ok(r2.reasons.some((x) => x.code === "meter_missing" && x.meter === "unified-7d_oi"))

  const u = stateFor()
  u.meters["unified-7d"].latest = reading(undefined)
  const r3 = gate(step(), u, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r3.ok, false)
  assert.ok(r3.reasons.some((x) => x.code === "invalid_reading" && x.scope === "meter:unified-7d"))

  // a meter explicitly recorded as absent from the account's headers is a warning, not a refusal
  const a = stateFor()
  a.meters["unified-7d_oi"] = { absent: true }
  const r4 = gate(step(), a, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r4.ok, true)
  assert.ok(r4.accounting.warnings.some((w) => w.code === "meter_absent" && w.meter === "unified-7d_oi"))

  // unknown experiment -> explicit issue
  const r5 = gate(step({ experiment: "nope", arm: "block-1" }), stateFor(), APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r5.ok, false)
  assert.ok(r5.reasons.some((x) => x.code === "unknown_experiment"))

  // garbage state
  assert.equal(gate(step(), undefined, APPROVAL, PRIOR_RANGE_ONLY).ok, false)
  assert.equal(gate(undefined, stateFor(), APPROVAL, PRIOR_RANGE_ONLY).ok, false)
})

test("gate treats a scope not yet in state as fresh (zero spend) and says so", () => {
  const s = stateFor()
  delete s.scopes["fable-write-tick/block-1"]
  const r = gate(step(), s, APPROVAL, PRIOR_RANGE_ONLY)
  assert.equal(r.ok, true)
  const idle = r.accounting.caps.find((c) => c.scope === "idle:fable-write-tick/block-1")
  assert.equal(idle.fresh, true)
  near(idle.spentObservedEq, 0)
})

// ------------------------------------------------------------------- gauge

test("metersOf parses the unified ratelimit headers; missing meters are marked absent", () => {
  const headers = {
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.12",
    "anthropic-ratelimit-unified-5h-reset": "1789765800",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.39",
    "anthropic-ratelimit-unified-7d-reset": "1790078400",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  }
  const m = metersOf(headers)
  assert.deepEqual(m["unified-5h"], { util: 0.12, reset: 1789765800, status: "allowed" })
  assert.deepEqual(m["unified-7d"], { util: 0.39, reset: 1790078400, status: "allowed" })
  assert.equal(m["unified-7d_oi"], "absent")
  assert.equal(m.unifiedStatus, "allowed")
  assert.deepEqual(METERS, ["unified-5h", "unified-7d", "unified-7d_oi"])
  // also accepts a record with .headers, mixed-case keys, and 7d_oi
  const rec = { headers: { "Anthropic-RateLimit-Unified-7d_oi-Utilization": "0.65", "anthropic-ratelimit-unified-7d_oi-reset": "1790078400" } }
  const m2 = metersOf(rec)
  assert.deepEqual(m2["unified-7d_oi"], { util: 0.65, reset: 1790078400, status: null })
  assert.equal(m2["unified-5h"], "absent")
  assert.equal(m2.unifiedStatus, null)
})

test("metersOf: malformed values become null, never NaN, never a throw", () => {
  const m = metersOf({ "anthropic-ratelimit-unified-5h-utilization": "abc", "anthropic-ratelimit-unified-5h-reset": "" })
  assert.deepEqual(m["unified-5h"], { util: null, reset: null, status: null })
  assert.equal(metersOf(undefined)["unified-5h"], "absent")
  assert.equal(metersOf({ headers: null })["unified-7d"], "absent")
})

test("sameWindow compares reset epochs and rejects invalid ones", () => {
  assert.equal(sameWindow(reading(0.1, R5), reading(0.5, R5)), true)
  assert.equal(sameWindow(reading(0.1, R5), reading(0.5, R5 + 1)), false)
  assert.equal(sameWindow(reading(0.1, null), reading(0.5, null)), false)
  assert.equal(sameWindow({ util: 0.1 }, { util: 0.5 }), false)
  assert.equal(sameWindow(undefined, reading(0.5)), false)
  assert.equal(sameWindow("absent", "absent"), false)
})

test("settled: readings unchanged in the same window across the whole settle period", () => {
  const rs = [
    { ts: 1000, util: 0.12, reset: R5 },
    { ts: 61000, util: 0.12, reset: R5 },
    { ts: 121000, util: 0.12, reset: R5 },
  ]
  assert.equal(settled(rs, 0, 120000), true)
  assert.equal(settled(rs, 0, 180000), false) // span too short
  assert.equal(settled(rs, 2000, 60000), true) // only readings since 2000: 61000..121000
  assert.equal(settled([...rs, { ts: 130000, util: 0.13, reset: R5 }], 0, 120000), false) // moved
  assert.equal(settled([...rs, { ts: 130000, util: 0.12, reset: R5 + 1 }], 0, 120000), false) // reset changed
  assert.equal(settled([], 0, 1000), false)
  assert.equal(settled([{ ts: 0, util: NaN, reset: R5 }, { ts: 5000, util: NaN, reset: R5 }], 0, 1000), false)
})

test("phase ledger: 35 dial reads without a tick -> lo >= 0.945; tick on a dial -> [0, 0.027]", () => {
  const led = phaseLedger()
  assert.deepEqual(led.bounds(), [0, 1])
  for (let i = 0; i < 35; i++) led.addCost(DIAL_TICKS)
  const [lo, hi] = led.bounds()
  assert.ok(lo >= 0.945, `lo=${lo}`)
  assert.equal(hi, 1)
  near(led.phiHat(), 35 / 37)
  const after = led.onTick(DIAL_TICKS)
  assert.equal(after[0], 0)
  near(after[1], 1 / 37, 1e-12)
  assert.ok(after[1] <= 0.02704 && after[1] >= 0.027)
  assert.deepEqual(led.bounds(), after)
  assert.equal(led.phiHat(), 0)
  near(RHO, 1 / 37, 1e-15)
  near(DIAL_TICKS, RHO, 1e-15)
  near(PING_TICKS, 6.4e-4, 1e-15)
})

test("phase ledger: a tick with phi_hat < 0.9 after an anchor is flagged early; the first anchoring tick is not", () => {
  const led = phaseLedger()
  led.addCost(0.5)
  led.onTick(DIAL_TICKS) // first tick anchors the phase; before it the phase was unknown
  assert.equal(led.early(), false)
  led.addCost(0.5)
  led.onTick(PING_TICKS)
  assert.equal(led.early(), true)
  assert.equal(led.early(0.4), false)
  assert.equal(led.lastTick().early, true)
  near(led.lastTick().phiHat, 0.5 + PING_TICKS)
  // a legitimate tick after ~1 tick of known cost is not early
  for (let i = 0; i < 37; i++) led.addCost(DIAL_TICKS)
  led.onTick(DIAL_TICKS)
  assert.equal(led.early(), false)
  // phi lower bound never reaches 1: after 40 dials without a tick lo stays below 1
  const l2 = phaseLedger()
  for (let i = 0; i < 40; i++) l2.addCost(DIAL_TICKS)
  assert.ok(l2.bounds()[0] < 1)
  assert.equal(l2.ticksSeen(), 0)
  // malformed cost is ignored with an issue, not thrown
  l2.addCost(NaN)
  assert.equal(l2.issues().length, 1)
})

// ----------------------------------------------------------- purity scan

test("caps.mjs and gauge.mjs never reference I/O, network, timers, process or the clock", () => {
  const forbidden = ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:child_process", "node:worker_threads", "fetch(", "XMLHttpRequest", "setTimeout(", "setInterval(", "setImmediate(", "Atomics.wait", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "execSync", "spawnSync"]
  const extra = ["node:fs", "Date.now(", "process.", "import(", "require("]
  for (const file of ["caps.mjs", "gauge.mjs"]) {
    const src = readFileSync(path.join(here, "..", "scripts", "idle-live", file), "utf8")
    for (const s of [...forbidden, ...extra]) assert.ok(!src.includes(s), `${file} must not reference ${s}`)
  }
})
