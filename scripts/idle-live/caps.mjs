// Cap accounting for the idle-live runner (Appendix B "Cap enforcement from
// 0.01-resolution gauges"). Pure: no I/O, no timers, no clock.
//
// Readings are { util, reset, status } as produced by gauge.mjs metersOf(). A "window"
// is { baseline, latest } inside one reset epoch; a scope (per-idle block/run/pair, plan
// total, meter, campaign stop) is { meter, baseline, latest, closedWindows:[window] }.
//
// Semantics (Appendix B "Gate tolerance" states the same rule and why a scope may end its
// current window up to one gauge tick above its cap):
//   - inside the CURRENT reset window the gate projects the observed gauge reading:
//       spentObservedEq + predictedTicks * resolution <= cap
//     (predictedTicks is already a ceil, i.e. an upper bound on the ticks a call can add;
//     a 0.02 cap must allow a ~2-tick block as Appendix A designs it);
//   - every CLOSED window contributes spentUpperEq (observed + resolution): its phase
//     is lost, so its true spend is bounded from above by one extra tick;
//   - spentUpperEq of the current window is reported in accounting for every scope.

import { METERS } from "./gauge.mjs"

export const RESOLUTION = 0.01

// Tokens per 5h tick from quota-test/2026-09-19/REPORT.md, reported and not verified by
// this runner. Only used as the fallback (tier 2) of predictedTicks; the analyzer never
// treats these as measured.
export const PRIOR_RANGE_ONLY = Object.freeze({
  cacheWrite1h: Object.freeze([102000, 143000]),
  cacheRead: Object.freeze([5390000, 5550000]),
  unit: "tokens_per_5h_tick",
  sourceKind: "reported_unverified",
  evidenceRef: "quota-test/2026-09-19/REPORT.md",
})

// Appendix A section 0: output is priced at 0.5x .. 2.5x the write coefficient (prior range).
export const OUTPUT_RATIO_PRIOR = Object.freeze([0.5, 2.5])

const isReading = (r) => !!r && typeof r === "object"
const validReading = (r) => isReading(r) && Number.isFinite(r.util) && Number.isFinite(r.reset)
const roundEq = (x) => Math.round(x * 1e6) / 1e6

/** ticks(a, b): round((b.util - a.util) / resolution); null across reset epochs or for invalid readings. */
export function ticks(a, b, resolution = RESOLUTION) {
  if (!validReading(a) || !validReading(b)) return null
  if (a.reset !== b.reset) return null
  if (!(resolution > 0)) return null
  return Math.round((b.util - a.util) / resolution)
}

export function spentObservedEq(baseline, latest, resolution = RESOLUTION) {
  const t = ticks(baseline, latest, resolution)
  return t === null ? null : roundEq(t * resolution)
}

export function spentUpperEq(baseline, latest, resolution = RESOLUTION) {
  const o = spentObservedEq(baseline, latest, resolution)
  return o === null ? null : roundEq(o + resolution)
}

function windowIssue(w, index) {
  if (!w || typeof w !== "object") return { code: "invalid_window", index }
  if (!validReading(w.baseline) || !validReading(w.latest)) return { code: "invalid_reading", index }
  if (w.baseline.reset !== w.latest.reset) return { code: "reset_changed", index }
  return null
}

/** cumulative(windows) -> { observedEq, upperEq, windows, issues }; sums spentUpperEq over reset windows. */
export function cumulative(meterWindows, resolution = RESOLUTION) {
  const issues = []
  if (!Array.isArray(meterWindows)) return { observedEq: null, upperEq: null, windows: 0, issues: [{ code: "invalid_windows" }] }
  let observed = 0
  let upper = 0
  meterWindows.forEach((w, i) => {
    const issue = windowIssue(w, i)
    if (issue) {
      issues.push(issue)
      return
    }
    observed += spentObservedEq(w.baseline, w.latest, resolution)
    upper += spentUpperEq(w.baseline, w.latest, resolution)
  })
  if (issues.length) return { observedEq: null, upperEq: null, windows: meterWindows.length, issues }
  return { observedEq: roundEq(observed), upperEq: roundEq(upper), windows: meterWindows.length, issues }
}

// ------------------------------------------------------------- predictions

function lowTokensPerTickFromPrior(field, priors) {
  if (!priors || typeof priors !== "object") return null
  const w = Array.isArray(priors.cacheWrite1h) ? priors.cacheWrite1h[0] : null
  const r = Array.isArray(priors.cacheRead) ? priors.cacheRead[0] : null
  switch (field) {
    case "cacheWrite1h":
    case "uncachedInput": // k_in is unknown but bounded by k_write (Appendix A section 4)
      return Number.isFinite(w) ? w : null
    case "cacheRead":
      return Number.isFinite(r) ? r : null
    case "billedModelOutput":
      return Number.isFinite(w) ? w / OUTPUT_RATIO_PRIOR[1] : null
    default:
      return null // cacheWrite5m: never defaulted from the 1h lane
  }
}

function tokensOf(step) {
  if (!step || typeof step !== "object") return null
  const field = step.dominantField
  const t = field === "billedModelOutput" ? step.expect?.outputTokensTarget : step.prompt?.tokensEst
  return Number.isFinite(t) && t >= 0 ? t : null
}

// The price of a call: tier 2 (the prior range), else tier 3 (the unpriced bound), else unpredictable.
function priceOf(tokens, field, priors, unpricedCallMaxTokens) {
  const prior = lowTokensPerTickFromPrior(field, priors)
  if (prior !== null && prior > 0) return { ticks: Math.max(1, Math.ceil(tokens / prior)), tier: 2, lowTokensPerTick: prior }

  const bound = Number.isFinite(unpricedCallMaxTokens) ? unpricedCallMaxTokens : 20000
  if (tokens <= bound) return { ticks: 1, tier: 3, lowTokensPerTick: null }
  return { ticks: "unpredictable", tier: null, lowTokensPerTick: null, reason: "no_price_basis_above_unpriced_bound" }
}

/**
 * predictedTicks(step, priors, unpricedCallMaxTokens)
 *   -> { ticks: number | "unpredictable", tier: 2|3|null, tokens, field, kind, lowTokensPerTick, reason? }
 * Tier 2: the prior range (low end) for the dominant field.
 * Tier 3: 1 tick if tokens <= unpricedCallMaxTokens, else "unpredictable".
 * There is no in-run learning tier. It existed to tighten a price from observations of THIS run,
 * but the machine never fed it: certifying that a reading has settled needs a quiet window the
 * campaign does not have (gate round 2, R2-B4), so `gateState` passed no observations and every
 * prediction came from the prior. An unreachable path that can only move a cap decision is worse
 * than no path, so it is gone: a price comes from the prior range or the call is refused.
 */
export function predictedTicks(step, priors, unpricedCallMaxTokens = 20000) {
  const tokens = tokensOf(step)
  const field = step?.dominantField ?? null
  const base = { tokens, field, kind: step?.kind ?? null }
  if (tokens === null) return { ...base, ticks: "unpredictable", tier: null, lowTokensPerTick: null, reason: "tokens_unknown" }

  return { ...base, ...priceOf(tokens, field, priors, unpricedCallMaxTokens) }
}

// ------------------------------------------------------------------ scopes

/** Per-idle scope id: `${experiment}/${head of arm}` (e.g. `fable-write-tick/block-1`); null if unknown. */
export function scopeKey(step) {
  if (!step || typeof step !== "object") return null
  if (typeof step.scopeId === "string" && step.scopeId) return step.scopeId
  if (typeof step.experiment !== "string" || !step.experiment) return null
  if (typeof step.arm !== "string" || !step.arm) return null
  return `${step.experiment}/${step.arm.split("/")[0]}`
}

// -------------------------------------------------------------------- gate

// Spend of a scope: closed windows at their upper bound, the current window as observed.
function scopeSpend(scope, resolution) {
  const closed = cumulative(scope.closedWindows ?? [], resolution)
  if (closed.issues.length) return { issue: { code: closed.issues[0].code, where: "closedWindows" } }
  if (!isReading(scope.baseline) || !isReading(scope.latest)) return { issue: { code: "invalid_reading" } }
  if (!Number.isFinite(scope.baseline.util) || !Number.isFinite(scope.latest.util)) return { issue: { code: "invalid_reading" } }
  if (!Number.isFinite(scope.baseline.reset) || !Number.isFinite(scope.latest.reset)) return { issue: { code: "invalid_reading" } }
  if (scope.baseline.reset !== scope.latest.reset) return { issue: { code: "reset_changed" } }
  const observed = spentObservedEq(scope.baseline, scope.latest, resolution)
  const upper = spentUpperEq(scope.baseline, scope.latest, resolution)
  return {
    spentObservedEq: roundEq(closed.upperEq + observed),
    spentUpperEq: roundEq(closed.upperEq + upper),
    currentWindow: { observedEq: observed, upperEq: upper },
    closedWindowsUpperEq: closed.upperEq,
  }
}

const FRESH = Object.freeze({ spentObservedEq: 0, spentUpperEq: RESOLUTION, currentWindow: { observedEq: 0, upperEq: RESOLUTION }, closedWindowsUpperEq: 0 })

/**
 * gate(step, state, approval, priors) -> { ok, reasons, accounting }
 * state: { status, inDoubt, meters: { [meter]: scope | { absent:true } }, scopes: { [scopeKey|plan:<id>]: scope } }
 * Refuses (each with a machine-readable reason { code, scope?, meter? }) when: an applicable cap would
 * be exceeded, the call is unpredictable, status !== "allowed", a reset epoch changed since a baseline,
 * a step is in doubt, or a reading/meter/experiment is missing or malformed.
 */
export function gate(step, state, approval, priors = PRIOR_RANGE_ONLY) {
  const reasons = []
  const warnings = []
  const caps = []
  const resolution = RESOLUTION
  const accounting = { caps, warnings, predictedTicks: null, predictedEq: null, predictionTier: null, scope: null }
  const refuse = () => ({ ok: false, reasons, accounting })

  if (!step || typeof step !== "object") {
    reasons.push({ code: "invalid_step" })
    return refuse()
  }
  if (!state || typeof state !== "object") {
    reasons.push({ code: "invalid_state" })
    return refuse()
  }
  if (!approval || typeof approval !== "object" || !approval.plans || typeof approval.plans !== "object") {
    reasons.push({ code: "invalid_approval" })
    return refuse()
  }

  const plan = approval.plans[step.experiment]
  if (!plan) reasons.push({ code: "unknown_experiment", experiment: step.experiment ?? null })
  if (state.status !== "allowed") reasons.push({ code: "status_not_allowed", status: state.status ?? null })
  if (state.inDoubt) reasons.push({ code: "in_doubt_step" })

  const prediction = predictedTicks(step, priors, approval.unpricedCallMaxTokens)
  accounting.predictedTicks = prediction.ticks
  accounting.predictionTier = prediction.tier
  if (prediction.ticks === "unpredictable") {
    reasons.push({ code: "unpredictable_call", reason: prediction.reason ?? null, tokens: prediction.tokens })
  } else {
    accounting.predictedEq = roundEq(prediction.ticks * resolution)
  }
  const predictedEq = accounting.predictedEq

  const idleKey = scopeKey(step)
  accounting.scope = idleKey
  const scopes = state.scopes && typeof state.scopes === "object" ? state.scopes : {}
  const meters = state.meters && typeof state.meters === "object" ? state.meters : {}

  const check = (scopeName, scope, capEq, extra = {}) => {
    const entry = { scope: scopeName, capEq, ...extra }
    if (!Number.isFinite(capEq)) {
      reasons.push({ code: "invalid_cap", scope: scopeName })
      caps.push(entry)
      return
    }
    let spend
    if (scope === undefined || scope === null) {
      spend = FRESH
      entry.fresh = true
    } else {
      spend = scopeSpend(scope, resolution)
    }
    if (spend.issue) {
      reasons.push({ code: spend.issue.code, scope: scopeName, ...(extra.meter ? { meter: extra.meter } : {}) })
      caps.push({ ...entry, issue: spend.issue.code })
      return
    }
    entry.spentObservedEq = spend.spentObservedEq
    entry.spentUpperEq = spend.spentUpperEq
    entry.closedWindowsUpperEq = spend.closedWindowsUpperEq
    entry.remainingUpperEq = roundEq(capEq - spend.spentUpperEq)
    if (predictedEq !== null) {
      entry.projectedEq = roundEq(spend.spentObservedEq + predictedEq)
      if (entry.projectedEq > capEq + 1e-9) {
        entry.tripped = true
        reasons.push({ code: "cap_exceeded", scope: scopeName, capEq, spentObservedEq: spend.spentObservedEq, spentUpperEq: spend.spentUpperEq, predictedEq, projectedEq: entry.projectedEq, ...(extra.meter ? { meter: extra.meter } : {}) })
      }
    }
    caps.push(entry)
  }

  if (plan) {
    const limits = plan.limits ?? {}
    if (idleKey === null) reasons.push({ code: "invalid_scope", experiment: step.experiment })
    else check(`idle:${idleKey}`, scopes[idleKey], limits.maxProactiveSpendPerIdle?.value, { name: "maxProactiveSpendPerIdle", scopeType: approval.perIdleScope?.[step.experiment] ?? null })
    check(`plan-total:${step.experiment}`, scopes[`plan:${step.experiment}`], limits.maxTotalExperimentalSpend?.value, { name: "maxTotalExperimentalSpend" })
  }

  const meterCaps = approval.perMeterCumulativeCaps && typeof approval.perMeterCumulativeCaps === "object" ? approval.perMeterCumulativeCaps : {}
  const stops = approval.campaignStop && typeof approval.campaignStop === "object" ? approval.campaignStop : {}
  const meterIds = [...new Set([...METERS, ...Object.keys(meterCaps), ...Object.keys(stops)])]
  for (const meter of meterIds) {
    const hasCap = Object.hasOwn(meterCaps, meter)
    const hasStop = Object.hasOwn(stops, meter)
    if (!hasCap && !hasStop) continue
    const scope = meters[meter]
    if (scope === undefined || scope === null) {
      reasons.push({ code: "meter_missing", meter })
      continue
    }
    if (scope.absent === true) {
      warnings.push({ code: "meter_absent", meter })
      continue
    }
    if (hasCap) check(`meter:${meter}`, scope, meterCaps[meter], { name: "perMeterCumulativeCap", meter })
    if (hasStop) check(`campaign-stop:${meter}`, scope, stops[meter], { name: "campaignStop", meter })
  }

  return { ok: reasons.length === 0, reasons, accounting }
}
