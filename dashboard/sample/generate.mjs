// Deterministic synthetic event log: 3 chained sessions (two rollovers) plus an
// unrelated short session. Run: node dashboard/sample/generate.mjs
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const out = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(out, "sessions"), { recursive: true })
let seed = 7
const rnd = (a, b) => { seed = (seed * 48271) % 2147483647; return a + (seed % (b - a + 1)) }
const summary = []
let clock = Date.parse("2026-09-10T09:00:00Z")
const T = () => new Date(clock).toISOString()
const cwd = "C:/dev/example"

function session(id, { parent, rollTo, budget = 150_000, spawnEvery = 2, hot = false, idle = false }) {
  const L = []
  const push = (ev, x = {}) => L.push({ t: T(), session: id, cwd, ev, ...x })
  const started = T()
  push("session_start", parent ? { parent } : {})
  let ctx = 12_000, active = 0, state = "watching", blocked = 0, msgs = 0, cr = 0, outp = 0, peak = 0, armReason = null
  const wake = (n) => { active = n; push("wake_source_state", { source: "senpi-task", activeCount: n, total: n }) }
  const children = []
  for (let turn = 0; turn < 60; turn++) {
    clock += rnd(40, 120) * 1000
    const output = rnd(300, 1500), input = rnd(500, 3000), cacheRead = hot ? output * rnd(160, 220) : ctx - 1000
    ctx = hot ? Math.min(ctx + rnd(2000, 5000), 120_000) : ctx + input + rnd(1500, 4000) + output
    msgs++; cr += cacheRead; outp += output; peak = Math.max(peak, ctx)
    push("message_end", { input, output, cacheRead, cacheWrite: rnd(0, 800), context: ctx })
    if (state === "watching" && (ctx >= budget || (hot && turn >= 6))) { state = "armed"; armReason = ctx >= budget ? "budget" : "reread"; push("armed", { reason: armReason, context: ctx }) }
    if (idle && state === "watching" && turn === 20 && ctx >= 100_000) {
      clock += 51 * 60_000 // the idle gap the telemetry describes
      push("idle_park", { sinceUserMin: 51, sinceActivityMin: 51, context: ctx, childWake: 0 })
      state = "armed"; armReason = "idle"; push("armed", { reason: "idle", context: ctx })
    }
    if (turn % spawnEvery === 0) {
      if (state === "watching") { children.push(clock + rnd(150, 400) * 1000); wake(active + 1) }
      else { blocked++; push("tool_call_blocked", { tool: "task_create" }) }
    }
    // children that finished during this turn
    for (let i = children.length - 1; i >= 0; i--) if (children[i] <= clock) { children.splice(i, 1); clock += 2000; wake(active - 1) }
    clock += rnd(5, 20) * 1000
    push("agent_settled", { total: active, state })
    if (state === "armed" && active === 0) {
      state = "handoff_requested"; push("handoff_requested", { at: idle ? "idle" : "agent_settled", context: ctx })
      clock += 90_000; ctx += 4000; msgs++
      push("message_end", { input: 2000, output: 900, cacheRead: ctx - 3000, cacheWrite: 200, context: ctx })
      push("agent_settled", { total: 0, state })
      push("successor_found", { chars: 320 })
      const row = { t: T(), session: id, cwd, reason: "rollover", startedAt: started, peakContext: peak, messages: msgs, cacheRead: cr, output: outp, rereadRatio: +(cr / outp).toFixed(1), rollovers: 1, blocked, state: "rollover", armReason }
      summary.push(row)
      clock += 3000
      push("rollover", { newSession: rollTo, parentSession: `C:/Users/u/.omo/agent/sessions/${id}.jsonl` })
      break
    }
    if (!rollTo && turn === 14) break
  }
  if (state !== "handoff_requested") {
    clock += 60_000
    summary.push({ t: T(), session: id, cwd, reason: "quit", startedAt: started, peakContext: peak, messages: msgs, cacheRead: cr, output: outp, rereadRatio: +(cr / outp).toFixed(1), rollovers: 0, blocked, state })
  }
  writeFileSync(join(out, "sessions", `${id}.jsonl`), L.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

session("a1f0-main", { rollTo: "b2e1-main" })
session("b2e1-main", { parent: "C:/Users/u/.omo/agent/sessions/a1f0-main.jsonl", rollTo: "c3d2-main", hot: true })
session("c3d2-main", { parent: "C:/Users/u/.omo/agent/sessions/b2e1-main.jsonl" })
clock += 3600_000
session("d4c3-short", { spawnEvery: 5 })
session("e5f4-idle", { rollTo: "f6g5-main", spawnEvery: 9, idle: true })
writeFileSync(join(out, "summary.jsonl"), summary.map((l) => JSON.stringify(l)).join("\n") + "\n")
writeFileSync(join(out, "config.json"), JSON.stringify({ budgetTokens: 150_000, rereadRatioMax: 150 }, null, 2) + "\n")
console.log(`wrote ${summary.length} sessions to ${out}`)
