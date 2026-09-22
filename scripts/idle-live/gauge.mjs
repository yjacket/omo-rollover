// Gauge helpers for the idle-live runner (Appendix B "gauge.mjs").
// Pure: no I/O, no timers, no clock. Time, when needed, is passed in as numbers.
//
// The unified ratelimit gauge shows floor(cumulative / 0.01) per meter. Everything
// here is bookkeeping on that quantized reading: parsing the headers, deciding whether
// two readings belong to the same reset window, whether the gauge has settled, and the
// phase ledger of Appendix A section 0 (phi = the unknown fractional tick position).

export const METERS = Object.freeze(["unified-5h", "unified-7d", "unified-7d_oi"])

// Appendix A section 0: a DIAL read of a hot 145K prefix costs rho = 1/37 tick
// (prior: 37 reads between ticks rf.13 -> rf.50); a PING costs ~6.4e-4 tick.
export const RHO = 1 / 37
export const DIAL_TICKS = RHO
export const PING_TICKS = 6.4e-4

const HEADER = /^anthropic-ratelimit-unified-([0-9][a-z0-9_]*)-(utilization|reset|status)$/
const ACCOUNT_STATUS = "anthropic-ratelimit-unified-status"

const finiteOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * metersOf(headers | { headers }) -> { "unified-5h": {util, reset, status} | "absent", ..., unifiedStatus }
 * Header keys are matched case-insensitively. Values that do not parse become null.
 */
export function metersOf(input) {
  const headers = input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "headers")
    ? input.headers
    : input
  const out = {}
  for (const m of METERS) out[m] = "absent"
  out.unifiedStatus = null
  if (!headers || typeof headers !== "object") return out
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey).toLowerCase()
    if (key === ACCOUNT_STATUS) {
      out.unifiedStatus = rawValue === null || rawValue === undefined ? null : String(rawValue)
      continue
    }
    const m = HEADER.exec(key)
    if (!m) continue
    const id = `unified-${m[1]}`
    if (out[id] === undefined || out[id] === "absent") out[id] = { util: null, reset: null, status: null }
    if (m[2] === "utilization") out[id].util = finiteOrNull(rawValue)
    else if (m[2] === "reset") out[id].reset = finiteOrNull(rawValue)
    else out[id].status = rawValue === null || rawValue === undefined ? null : String(rawValue)
  }
  return out
}

const validReading = (r) => !!r && typeof r === "object" && Number.isFinite(r.reset)

/** True iff both readings carry the same finite reset epoch. */
export function sameWindow(a, b) {
  return validReading(a) && validReading(b) && a.reset === b.reset
}

/**
 * settled(readings, sinceMs, windowMs): the gauge is settled when every reading with
 * ts >= sinceMs has the same finite utilization and reset epoch, and those readings span
 * at least windowMs. readings: [{ ts, util, reset }].
 */
export function settled(readings, sinceMs, windowMs) {
  if (!Array.isArray(readings) || !Number.isFinite(sinceMs) || !Number.isFinite(windowMs)) return false
  const rs = readings.filter((r) => r && typeof r === "object" && Number.isFinite(r.ts) && r.ts >= sinceMs)
  if (rs.length === 0) return false
  const first = rs[0]
  if (!Number.isFinite(first.util) || !Number.isFinite(first.reset)) return false
  for (const r of rs) {
    if (!Number.isFinite(r.util) || !Number.isFinite(r.reset)) return false
    if (r.util !== first.util || r.reset !== first.reset) return false
  }
  const span = Math.max(...rs.map((r) => r.ts)) - Math.min(...rs.map((r) => r.ts))
  return span >= windowMs
}

const PHI_LO_MAX = 1 - 1e-9 // phi is in [lo, 1): a lower bound never reaches 1

/**
 * Phase ledger (Appendix A section 0). phi = fractional tick position, unknown at start: [0, 1).
 *   addCost(ticksKnown)  a paid call that did not tick: phi lower bound moves up by its cost.
 *   onTick(cost)         a paid call that ticked: phi is now in [0, cost]. Returns the new bounds.
 *   early(threshold=0.9) true iff the last tick came with phi_hat < threshold after the phase
 *                        was already anchored by an earlier tick (foreign traffic / delayed accounting).
 *   phiHat()             sum of known costs since the last tick.
 */
export function phaseLedger() {
  let lo = 0
  let hi = 1
  let phiHat = 0
  let anchored = false
  let ticksSeen = 0
  let lastTick = null
  const issues = []
  return {
    addCost(ticksKnown) {
      if (!Number.isFinite(ticksKnown) || ticksKnown < 0) {
        issues.push({ code: "invalid_cost", value: ticksKnown })
        return this.bounds()
      }
      phiHat += ticksKnown
      lo = Math.min(lo + ticksKnown, PHI_LO_MAX)
      return this.bounds()
    },
    onTick(costOfTickingCall) {
      const cost = Number.isFinite(costOfTickingCall) && costOfTickingCall >= 0 ? costOfTickingCall : null
      if (cost === null) issues.push({ code: "invalid_cost", value: costOfTickingCall })
      const phiHatAtTick = phiHat + (cost ?? 0)
      lastTick = { phiHat: phiHatAtTick, anchored, early: anchored && phiHatAtTick < 0.9, cost }
      ticksSeen += 1
      lo = 0
      hi = cost ?? 1
      phiHat = 0
      anchored = true
      return this.bounds()
    },
    early(threshold = 0.9) {
      return !!lastTick && lastTick.anchored && lastTick.phiHat < threshold
    },
    bounds: () => [lo, hi],
    phiHat: () => phiHat,
    ticksSeen: () => ticksSeen,
    lastTick: () => lastTick,
    issues: () => issues.slice(),
  }
}
