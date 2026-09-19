// Offline only: node scripts/idle-replay.mjs --sample
// node scripts/idle-replay.mjs events.jsonl [--scenario explicit-inputs.json]
// Scenario file: [{kind:"mathematical"|"as_of"|"oracle", asOfMs, snapshot}].
// snapshot is task3 IdleCostSnapshot stamped for an observing row. All input
// provenance must be available as of asOfMs. Outcomes are never evaluator inputs.
import { readFileSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { evaluateIdleCost, USAGE_FIELDS } from "../extension/rollover.ts"

const ACTIONS = ["WAIT", "KEEP_WARM", "PARK", "LET_EXPIRE"]
const STATUSES = ["observing", "returned", "right_censored", "ended"]
const object = x => x !== null && typeof x === "object" && !Array.isArray(x)
const number = x => Number.isFinite(x) && x >= 0
const token = x => typeof x === "string" && /^[\w.:/|,@+-]{1,240}$/.test(x)
const codes = x => Array.isArray(x) && x.every(token)
const nullableNumber = x => x === null || number(x)
const nullableToken = x => x == null || token(x)
const safeCodes = x => Array.isArray(x) ? x.filter(token) : []
const emptyResult = () => ({ schemaVersion: "idle-replay/1", mode: "offline",
  integrity: { ok: true, issues: [] }, episodes: [], usageObservations: [], usageTotals: [], scenarios: [],
  forecastReconstruction: "unavailable", actions: { requestsIssued: 0, sessionTransitions: 0, timersCreated: 0 } })

// Project machine fields only; never copy event, prompt, exception or tool bodies.
function decisionView(r) {
  return { engineVersion: r.engineVersion, recommendedAction: r.recommendedAction,
    reasonCode: r.reasonCode, candidateCosts: Object.fromEntries(ACTIONS.map(a => [a, r.candidateCosts[a]])),
    candidateUnavailableReasons: Object.fromEntries(ACTIONS.filter(a => token(r.candidateUnavailableReasons?.[a])).map(a => [a, r.candidateUnavailableReasons[a]])),
    guardReasons: safeCodes(r.guardReasons), blockers: safeCodes(r.blockers), evidenceStatus: r.evidenceStatus,
    forecastVersion: nullableToken(r.forecastVersion) ? r.forecastVersion ?? null : null,
    costCoefficientVersion: nullableToken(r.costCoefficientVersion) ? r.costCoefficientVersion ?? null : null,
    incurredSpendEq: r.incurredSpendEq ?? null, enforcement: "unavailable" }
}

function validRow(r) {
  return token(r.sessionGeneration) && token(r.idleEpisodeId) && token(r.modelId) && token(r.lane)
    && token(r.engineVersion) && token(r.reasonCode) && number(r.contextTokens)
    && ["sufficient", "uncertain", "blocked"].includes(r.evidenceStatus)
    && r.enforcement === "unavailable" && STATUSES.includes(r.episodeStatus)
    && [...ACTIONS, "NO_DECISION"].includes(r.recommendedAction)
    && codes(r.blockers) && codes(r.guardReasons) && nullableNumber(r.incurredSpendEq)
    && object(r.candidateCosts) && ACTIONS.every(a => nullableNumber(r.candidateCosts[a]))
    && number(r.timestampMs) && number(r.episodeStartedAtMs) && number(r.observedUntilMs)
    && r.episodeStartedAtMs <= r.timestampMs && r.timestampMs <= r.observedUntilMs
    && (r.episodeStatus !== "observing" || r.timestampMs === r.observedUntilMs)
    && (r.episodeStatus === "returned" ? number(r.returnedAtMs) && r.returnedAtMs >= r.episodeStartedAtMs && r.returnedAtMs <= r.observedUntilMs : r.returnedAtMs === null)
    && nullableToken(r.episodeEndReason) && nullableToken(r.rawUsageObservationId)
    && nullableToken(r.rawUsageModelId) && nullableToken(r.rawUsageLane)
    && (r.rawUsage == null || object(r.rawUsage) && USAGE_FIELDS.every(f => r.rawUsage[f] == null || number(r.rawUsage[f])))
    && (r.rawUsageObservationId == null || number(r.rawUsageObservedAtMs) && r.rawUsageObservedAtMs <= r.observedUntilMs)
}

export function replay(text, { scenarios = [] } = {}) {
  const result = emptyResult(), rows = [], episodes = new Map(), observations = new Map()
  const issue = (sourceLine, code) => { result.integrity.ok = false; result.integrity.issues.push({ sourceLine, code }) }
  if (typeof text !== "string" || Buffer.byteLength(text) > 5 * 1024 * 1024) { issue(null, "input_limit"); return result }
  const lines = text.split(/\r?\n/)
  if (lines.length > 10001) { issue(null, "row_limit"); return result }
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      issue(i + 1, "malformed_json"); continue
    }
    if (!object(r) || typeof r.ev !== "string") { issue(i + 1, "invalid_event"); continue }
    if (r.ev !== "idle_cost_shadow") continue
    if (r.schemaVersion !== "idle-shadow/1") { issue(i + 1, "unsupported_schema"); continue }
    if (!validRow(r)) { issue(i + 1, "invalid_row"); continue }
    rows.push({ r, sourceLine: i + 1 })
  }
  // Closure timestamps describe emission, not a new decision. Keep each prior
  // decision's timestamp separately from the episode's final observation time.
  rows.sort((a, b) => a.r.observedUntilMs - b.r.observedUntilMs || a.sourceLine - b.sourceLine)
  for (const { r, sourceLine } of rows) {
    const key = JSON.stringify([r.sessionGeneration, r.idleEpisodeId])
    let episode = episodes.get(key)
    if (!episode) {
      episode = { sessionGeneration: r.sessionGeneration, idleEpisodeId: r.idleEpisodeId,
        episodeStartedAtMs: r.episodeStartedAtMs, observedUntilMs: r.observedUntilMs,
        status: "observing", returnedAtMs: null, endReason: null, permanentNonReturn: null,
        usageStatus: "unknown", usageObservationRefs: [], decisions: [] }
      episodes.set(key, episode)
    }
    if (episode.status !== "observing") { issue(sourceLine, "row_after_closure"); continue }
    if (episode.episodeStartedAtMs !== r.episodeStartedAtMs) { issue(sourceLine, "episode_start_conflict"); continue }
    episode.observedUntilMs = r.observedUntilMs
    if (r.episodeStatus === "observing") {
      episode.decisions.push({ sourceLine, timestampMs: r.timestampMs, modelId: r.modelId, lane: r.lane,
        contextTokens: r.contextTokens, ...decisionView(r) })
    } else {
      if (!episode.decisions.length) issue(sourceLine, "orphan_closure")
      else {
        const prior = episode.decisions.at(-1)
        if (["modelId", "lane", "contextTokens"].some(field => prior[field] !== r[field])
          || JSON.stringify(decisionView(prior)) !== JSON.stringify(decisionView(r))) issue(sourceLine, "closing_decision_conflict")
      }
      episode.status = r.episodeStatus; episode.returnedAtMs = r.returnedAtMs; episode.endReason = r.episodeEndReason ?? null
    }
    if (r.rawUsageObservationId != null) {
      const id = JSON.stringify([r.sessionGeneration, r.rawUsageObservationId])
      const observation = { sessionGeneration: r.sessionGeneration, observationId: r.rawUsageObservationId,
        observedAtMs: r.rawUsageObservedAtMs, modelId: r.rawUsageModelId ?? null, lane: r.rawUsageLane ?? null,
        usage: Object.fromEntries(USAGE_FIELDS.map(f => [f, r.rawUsage?.[f] ?? null])) }
      const prior = observations.get(id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) issue(sourceLine, "usage_observation_conflict")
      else observations.set(id, observation)
      if (!episode.usageObservationRefs.includes(id)) episode.usageObservationRefs.push(id)
      episode.usageStatus = "observed_snapshot_not_episode_bill"
    }
  }
  result.episodes = [...episodes.values()]
  result.usageObservations = [...observations.values()]
  const totals = new Map()
  for (const o of result.usageObservations) {
    const key = JSON.stringify([o.modelId, o.lane])
    if (!totals.has(key)) totals.set(key, { modelId: o.modelId, lane: o.lane, observationCount: 0,
      scope: "unique_observed_messages_not_episode_spend", totals: Object.fromEntries(USAGE_FIELDS.map(f => [f, 0])) })
    const group = totals.get(key); group.observationCount++
    for (const f of USAGE_FIELDS) {
      const sum = group.totals[f] === null || o.usage[f] === null ? null : group.totals[f] + o.usage[f]
      if (sum !== null && !Number.isFinite(sum)) {
        issue(null, `usage_total_overflow:${f}`)
        group.unavailableReasons ??= {}
        group.unavailableReasons[f] = "usage_total_overflow"
        group.totals[f] = null
      } else group.totals[f] = sum
    }
  }
  result.usageTotals = [...totals.values()]
  if (!rows.length) issue(null, "no_shadow_records")
  if (!Array.isArray(scenarios) || scenarios.length > 100) issue(null, "invalid_scenarios")
  else for (const scenario of scenarios) {
    const evaluated = evaluateScenario(scenario, result.episodes)
    result.scenarios.push(evaluated)
    if (evaluated.status === "blocked") issue(null, evaluated.reasonCode)
  }
  return result
}

// Absolute evidence dates are not the forecast's relative afterMs or predicted
// cache expiry/arrival. Outcome features are refused even on labelled oracles;
// an oracle supplies its counterfactual forecast explicitly, never via log rows.
function inputTimeIssue(value, asOfMs) {
  if (!object(value) && !Array.isArray(value)) return null
  for (const [key, item] of Object.entries(value)) {
    if (["returnedAtMs", "observedUntilMs", "episodeStatus"].includes(key)) return "outcome_input_refused"
    if (/^(asOf|measuredAt|observedAt|availableAt|trainedThrough|validFrom|timestamp)(Ms)?$/i.test(key) && item !== null) {
      const time = typeof item === "string" ? Date.parse(item) : item
      if (!number(time)) return "invalid_input_time"
      if (time > asOfMs) return "future_input"
    }
    const nested = inputTimeIssue(item, asOfMs)
    if (nested) return nested
  }
  return null
}

function evaluateScenario(scenario, episodes) {
  const kind = ["mathematical", "as_of", "oracle"].includes(scenario?.kind) ? scenario.kind : null
  const base = { kind, asOfMs: number(scenario?.asOfMs) ? scenario.asOfMs : null,
    status: "blocked", reasonCode: "invalid_scenario", decision: null }
  const s = scenario?.snapshot
  if (!kind || base.asOfMs === null || !object(s) || !number(s.timestampMs)) return base
  if (base.asOfMs > s.timestampMs) return { ...base, reasonCode: "future_input" }
  const { timestampMs, ...inputs } = s
  const timeIssue = inputTimeIssue(inputs, base.asOfMs)
  if (timeIssue) return { ...base, reasonCode: timeIssue }
  const episode = episodes.find(e => e.sessionGeneration === s.sessionGeneration && e.idleEpisodeId === s.idleEpisodeId)
  const target = episode?.decisions.find(d => d.timestampMs === s.timestampMs && d.modelId === s.modelId && d.lane === s.lane && d.contextTokens === s.contextTokens)
  if (!target) return { ...base, reasonCode: "snapshot_identity_mismatch" }
  if (!object(s.cache) || !["warm", "cold", "partial", "uncertain"].includes(s.cache.state)
    || !codes(s.cache.reasons) || !object(s.gates) || typeof s.gates.allowParking !== "boolean" || !codes(s.gates.reasons)
    || !object(s.limits) || !object(s.planner) || !object(s.parameterSources)
    || s.cache.retryAllowed !== false || typeof s.planner.sharedCachePersists !== "boolean"
    || !token(s.limits.unit) || !token(s.limits.minimumEvidenceForEnforcement)
    || ["maxProactiveSpendPerIdle", "maxTotalExperimentalSpend", "maxResumeDelayMs", "allowedQualityDegradation"].some(k => s.limits[k] !== "unconfigured" && !number(s.limits[k]))
    || !["unknown", "measured", "reported_unverified", "api_assumption"].includes(s.coefficientStatus)
    || !["off", "shadow"].includes(s.mode) || !number(s.incurredSpendEq)
    || !(s.costs === null || object(s.costs)) || !(s.forecast === null || object(s.forecast))) return base
  if (s.forecast !== null) {
    if (!Array.isArray(s.forecast.returns) || s.forecast.returns.length > 256 || !number(s.planner.intervalMs) || s.planner.intervalMs === 0
      || s.forecast.returns.some(p => !object(p) || !number(p.afterMs) || !number(p.probability))) return base
    // CLI boundary bound, not a new recurrence or an invented tail probability.
    if (s.forecast.returns.some(p => p.afterMs / s.planner.intervalMs > 256)) return { ...base, reasonCode: "scenario_epoch_limit" }
    if (!token(s.forecastVersion)) return { ...base, reasonCode: "forecast_provenance_missing" }
  }
  try {
    const evaluated = evaluateIdleCost(s)
    if (evaluated.blockers.includes("plan_idle_error")) return { ...base, reasonCode: "invalid_engine_input" }
    return { ...base, status: "evaluated", reasonCode: "explicit_input_only",
      decision: decisionView({ ...evaluated, forecastVersion: s.forecastVersion, costCoefficientVersion: s.coefficientVersion }) }
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error
    return { ...base, reasonCode: "invalid_engine_input" }
  }
}

function readLocal(path) {
  // Never resolve a URL/UNC share or wait on a pipe/device as a replay input.
  if (typeof path === "string" && (/^(\\|\/\/)/.test(path) || /^[a-z]+:\/\//i.test(path))) throw new RangeError("local_file_required")
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new RangeError("input_limit")
  return readFileSync(path, "utf8")
}

function main(args) {
  if (args.length === 1 && args[0] === "--sample") {
    const sample = JSON.parse(readLocal(new URL("../docs/idle-shadow-sample.json", import.meta.url)))
    const result = replay(sample.records.map(r => JSON.stringify(r)).join("\n"), { scenarios: sample.scenarios })
    result.sampleKind = "mathematical_not_measured"
    result.defaultUnknown = decisionView(evaluateIdleCost(sample.unknownSnapshot))
    return result
  }
  if ((args.length !== 1 && args.length !== 3) || args[0].startsWith("-")
    || (args.length === 3 && (args[1] !== "--scenario" || args[2].startsWith("-")))) {
    const result = emptyResult()
    result.integrity = { ok: false, issues: [{ sourceLine: null, code: "invalid_arguments" }] }
    return result
  }
  return replay(readLocal(args[0]), { scenarios: args.length === 3 ? JSON.parse(readLocal(args[2])) : [] })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result
  try { result = main(process.argv.slice(2)) } catch (error) {
    // CLI boundary: neither a path nor exception text (possibly input bodies)
    // belongs in the machine report. Unexpected failures remain non-success.
    const code = error instanceof SyntaxError ? "malformed_json"
      : error instanceof RangeError ? "input_limit"
        : error instanceof Error && "code" in error ? "input_read_error" : "replay_failed"
    result = emptyResult(); result.integrity = { ok: false, issues: [{ sourceLine: null, code }] }
  }
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.integrity.ok ? 0 : 2
}
