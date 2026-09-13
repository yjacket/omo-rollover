// rollover: hand a long-running main session off to a fresh one once context
// passes a token budget.
//
//   watching ──tokens ≥ budget | reread ratio──▶ armed
//   armed    ──(turn_end | agent_settled) ∧ Σwake==0 ∧ !pending──▶ handoff_requested
//   handoff_requested ──agent_settled ∧ <successor> found ∧ Σwake==0 ∧ !pending──▶ rollover (/rollover)
//   (successor found but children live → rollover_deferred, re-checked on every agent_settled/turn_end)
//
// Signals: message_end (usage), wake_source_state (shared pi.events bus),
// turn_end (early landing inside a long single-agent run, steer-delivered),
// agent_settled, tool_call (blocks `task` and `task_create` while not watching).
// Inert in omo-task child sessions. Everything is logged as JSONL under
// ~/.omo/rollover/ (override with OMO_ROLLOVER_DIR) for dashboard/build.mjs.
// State survives /reload and --resume via ~/.omo/rollover/state/<sessionId>.json.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

export type State = "watching" | "armed" | "handoff_requested" | "rollover" | "rolled_over"
export type Config = { budgetTokens: number; rereadRatioMax: number }
export const DEFAULT_CONFIG: Config = { budgetTokens: 150_000, rereadRatioMax: 0 } // reread off by default: tool-only turns (output ≈ 50) make the ratio meaningless
const REREAD_STREAK = 3
const SPAWN_TOOLS = new Set(["task", "task_create"]) // exact names; task_output/list/cancel/get/update/send stay allowed
const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"]

export function isChildSession(env: Record<string, string | undefined> = process.env): boolean {
  // OMO_SENPI_TASK_RPC_CHILD=1 is set by omo-task for every spawned child
  // (plain task and team member); the SENPI_TASK_MEMBER_* pair is member-only.
  return CHILD_ENV.some((k) => (env[k] ?? "").length > 0)
}

export function rolloverDir(env: Record<string, string | undefined> = process.env): string {
  return env.OMO_ROLLOVER_DIR || join(homedir(), ".omo", "rollover")
}

export function loadConfig(dir: string): Config {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))
    return {
      budgetTokens: Number(raw.budgetTokens) > 0 ? Number(raw.budgetTokens) : DEFAULT_CONFIG.budgetTokens,
      rereadRatioMax: Number(raw.rereadRatioMax) > 0 ? Number(raw.rereadRatioMax) : 0,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(obj) + "\n")
}

/** Atomic write: tmp then rename. */
export function writeJsonAtomic(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, file)
}

// Counters (peak, messages, cacheRead, output, startedAt) ride along so the summary row survives /reload.
const PERSISTED = ["state", "mode", "blocked", "rereadStreak", "goalPaused", "rollovers", "armedAt", "handoffAskedCount", "peak", "messages", "cacheRead", "output", "startedAt"] as const

/** Text of the last assistant message on the current branch. */
export function lastAssistantText(entries: any[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.type !== "message" || e.message?.role !== "assistant") continue
    const c = e.message.content
    if (typeof c === "string") return c
    return (Array.isArray(c) ? c : []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")
  }
  return ""
}

export function extractSuccessor(text: string): string | null {
  const m = /<successor>([\s\S]*?)<\/successor>/.exec(text)
  const s = m?.[1]?.trim()
  return s ? s : null
}

export function handoffPrompt(cwd: string, sessionId: string, goalPaused: boolean): string {
  const file = join(cwd, ".omo", "rollover", `handoff-${sessionId}.md`)
  return [
    "[rollover] This session's context is over budget. Stop working; hand off now.",
    "Do NOT read any file, run any command, or spawn any task (task/task_create). Use only what is already in your context.",
    goalPaused ? "" : "First, if a goal is active, call the `update_goal` tool with status \"paused\".",
    `Write ${file} from memory (single write, max ~80 lines) with sections: Goal / Done / In progress / Next step / Key files / Constraints.`,
    "Then end your reply with the successor's first prompt wrapped as <successor>...</successor>, at most 25 lines.",
    "The successor starts with an empty context. Its prompt must tell it to read only the handoff file plus `tail -n 30 .omo/ulw-execute/ledger.jsonl`, and NOT to read ulw-execute/SKILL.md or the full ledger.",
  ]
    .filter(Boolean)
    .join("\n")
}

// Best-effort goal pause via senpi's internal store (path is version-specific).
async function pauseGoal(ctx: any): Promise<boolean> {
  try {
    const entry = (import.meta as any).resolve?.("@code-yeongyu/senpi") as string | undefined
    if (!entry) return false
    const base = dirname(new URL(entry).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
    const goal = join(base, "core", "extensions", "builtin", "goal")
    const store = await import(pathToFileURL(join(goal, "store.js")).href)
    const ref = await import(pathToFileURL(join(goal, "store-ref.js")).href)
    const r = ref.goalStoreRef(ctx.sessionManager, ctx.cwd ?? ctx.sessionManager.getCwd())
    const g = await store.readGoal(r)
    if (!g || g.status !== "active") return true
    await store.updateGoal(r, { status: "paused" }, "user")
    return true
  } catch {
    return false
  }
}

export type Deps = { env?: Record<string, string | undefined>; now?: () => Date; pauseGoal?: (ctx: any) => Promise<boolean> }

export function createRollover(pi: any, deps: Deps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const doPause = deps.pauseGoal ?? pauseGoal
  if (isChildSession(env)) return null

  const dir = rolloverDir(env)
  const config = loadConfig(dir)
  const st = {
    state: "watching" as State,
    mode: "auto" as "auto" | "on" | "off",
    reason: "",
    context: 0,
    peak: 0,
    messages: 0,
    cacheRead: 0,
    output: 0,
    rereadStreak: 0,
    wake: new Map<string, number>(),
    blocked: 0,
    handoffAskedCount: 0,
    goalPaused: false,
    successor: null as string | null,
    startedAt: now().toISOString(),
    armedAt: null as string | null,
    rollovers: 0,
  }

  let lastCtx: any = null
  const sid = (ctx: any) => String(ctx?.sessionManager?.getSessionId?.() ?? "unknown")
  const cwdOf = (ctx: any) => String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd())
  const log = (ctx: any, ev: string, extra: Record<string, unknown> = {}) =>
    appendJsonl(join(dir, "sessions", `${sid(ctx)}.jsonl`), { t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), ev, ...extra })
  const wakeTotal = (): number | null => (st.wake.size ? [...st.wake.values()].reduce((a, b) => a + b, 0) : null)
  const enabled = () => st.mode !== "off"
  const stateFile = (id: string) => join(dir, "state", `${id}.json`)
  const persist = (id: string) =>
    writeJsonAtomic(stateFile(id), Object.fromEntries([...PERSISTED.map((k) => [k, st[k]]), ["updatedAt", now().toISOString()]]))
  const restore = (id: string): boolean => {
    try {
      const saved = JSON.parse(readFileSync(stateFile(id), "utf8"))
      if (saved.state === "rolled_over") return false
      for (const k of PERSISTED) if (k in saved) (st as any)[k] = saved[k]
      return true
    } catch {
      return false
    }
  }
  const summary = (ctx: any, reason: string) =>
    appendJsonl(join(dir, "summary.jsonl"), {
      t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), reason, startedAt: st.startedAt,
      peakContext: st.peak, messages: st.messages, cacheRead: st.cacheRead, output: st.output,
      rereadRatio: st.output ? +(st.cacheRead / st.output).toFixed(1) : null, rollovers: st.rollovers, blocked: st.blocked, state: st.state,
    })

  async function arm(ctx: any, reason: string) {
    st.state = "armed"
    st.reason = reason
    st.armedAt = now().toISOString()
    log(ctx, "armed", { reason, context: st.context })
    st.goalPaused = await doPause(ctx)
    persist(sid(ctx))
    const why = reason === "budget" ? `budget ${config.budgetTokens} reached` : `reread ratio ≥ ${config.rereadRatioMax} for ${REREAD_STREAK} messages`
    ctx.ui?.notify?.(`rollover: armed (${why}, context=${st.context}). task/task_create blocked; handing off once children drain.`, "warning")
  }

  // Single guard for both landing points so the instruction is injected once.
  function requestHandoff(ctx: any, at: "turn_end" | "agent_settled"): boolean {
    if (st.state !== "armed" || wakeTotal() !== 0 || ctx.hasPendingMessages?.()) return false
    st.state = "handoff_requested"
    st.handoffAskedCount = 1
    log(ctx, "handoff_requested", { at, context: st.context })
    persist(sid(ctx))
    // Mid-run: steer so it lands before the next turn instead of after the whole run settles.
    pi.sendUserMessage(handoffPrompt(cwdOf(ctx), sid(ctx), st.goalPaused), at === "turn_end" ? { deliverAs: "steer" } : undefined)
    return true
  }

  // Successor in the last assistant reply → dispatch /rollover, but only once
  // nothing can wake this session (a live child would be orphaned by newSession).
  // Shared by agent_settled, turn_end and session_start (a /reload between the reply and settle).
  function tryRollover(ctx: any): boolean {
    const found = extractSuccessor(lastAssistantText(ctx.sessionManager?.getBranch?.() ?? [])) ?? st.successor // deferred: a child's result may have moved the last reply
    if (!found) return false
    st.successor = found
    const total = wakeTotal()
    if (total !== 0 || ctx.hasPendingMessages?.()) {
      log(ctx, "rollover_deferred", { total })
      return true // successor is in hand; stay in handoff_requested, no re-ask
    }
    st.state = "rollover"
    log(ctx, "successor_found", { chars: found.length })
    persist(sid(ctx))
    pi.sendUserMessage("/rollover", { expandPromptTemplates: true })
    return true
  }

  pi.on("session_start", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    const parent = ctx?.sessionManager?.getHeader?.()?.parentSession
    log(ctx, "session_start", parent ? { parent } : {})
    if (!restore(sid(ctx))) return
    log(ctx, "state_restored", { state: st.state })
    if (enabled() && (st.state === "handoff_requested" || st.state === "rollover")) tryRollover(ctx)
  })

  pi.on("message_end", async (ev: any, ctx: any) => {
    lastCtx = ctx
    const m = ev?.message
    if (m?.role !== "assistant" || !m.usage) return
    const u = m.usage
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    const input = n(u.input), output = n(u.output), cacheRead = n(u.cacheRead), cacheWrite = n(u.cacheWrite)
    const fromUsage = input + cacheRead + cacheWrite
    const live = ctx.getContextUsage?.()?.tokens
    // tokens is null right after compaction; fall back to the message's own usage.
    const context = typeof live === "number" ? live : fromUsage
    st.context = context
    st.peak = Math.max(st.peak, context)
    st.messages++
    st.cacheRead += cacheRead
    st.output += output
    const ratio = +(cacheRead / Math.max(1, output)).toFixed(1)
    log(ctx, "message_end", { input, output, cacheRead, cacheWrite, context, ratio })
    persist(sid(ctx)) // counters above feed the summary row; keep them across /reload
    if (!enabled() || st.state !== "watching" || context <= 0) return

    if (context >= config.budgetTokens) return arm(ctx, "budget")
    if (config.rereadRatioMax <= 0) return // opt-in: a tool-only turn has output ≈ 50, so the ratio spikes on any healthy session
    st.rereadStreak = ratio >= config.rereadRatioMax ? st.rereadStreak + 1 : 0
    if (st.rereadStreak >= REREAD_STREAK) return arm(ctx, "reread")
  })

  pi.on("tool_call", async (ev: any, ctx: any) => {
    if (!enabled() || st.state === "watching" || !SPAWN_TOOLS.has(ev?.toolName)) return
    st.blocked++
    log(ctx, "tool_call_blocked", { tool: ev.toolName })
    persist(sid(ctx))
    return { block: true, reason: "rollover: session handoff is pending; do not spawn new tasks. Let running children finish, then stop." }
  })

  pi.events?.on?.("wake_source_state", (d: any) => {
    if (!d?.source) return
    st.wake.set(String(d.source), Number(d.activeCount) || 0)
    if (lastCtx) log(lastCtx, "wake_source_state", { source: d.source, activeCount: d.activeCount, total: wakeTotal() })
  })

  pi.on("turn_end", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    if (st.state === "handoff_requested" && st.successor) { if (enabled()) tryRollover(ctx); return }
    if (st.state !== "armed") return
    log(ctx, "turn_end", { total: wakeTotal() })
    if (enabled()) requestHandoff(ctx, "turn_end")
  })

  pi.on("agent_settled", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    const total = wakeTotal()
    log(ctx, "agent_settled", { total, state: st.state })
    if (!enabled()) return
    if (st.state === "armed") {
      requestHandoff(ctx, "agent_settled")
      return
    }
    if (st.state === "handoff_requested") {
      if (tryRollover(ctx)) return
      log(ctx, "successor_missing", { retried: st.handoffAskedCount > 1 })
      if (st.handoffAskedCount < 2) {
        st.handoffAskedCount = 2
        persist(sid(ctx))
        pi.sendUserMessage("[rollover] Your reply did not contain a <successor>...</successor> block. Reply again with only the handoff file written and the successor prompt wrapped in <successor></successor>.")
        return
      }
      st.state = "armed"
      persist(sid(ctx))
      ctx.ui?.notify?.("rollover: no <successor> prompt after two asks; staying armed. Run /rollover manually.", "error")
    }
  })

  pi.on("session_shutdown", async (ev: any, ctx: any) => {
    if (ev?.reason === "reload") return
    summary(ctx, String(ev?.reason ?? "unknown"))
  })

  pi.registerCommand("rollover", {
    description: "rollover on|off|status|force — or no args: hand off to a fresh session now (refused while children run)",
    handler: async (args: string, ctx: any) => {
      const a = (args ?? "").trim()
      if (a === "on" || a === "off") { st.mode = a; persist(sid(ctx)); ctx.ui.notify(`rollover: ${a}`, "info"); return }
      if (a === "status") {
        ctx.ui.notify(`rollover: state=${st.state} mode=${st.mode} context=${st.context}/${config.budgetTokens} wake=${wakeTotal() ?? "unknown"} blocked=${st.blocked} goalPaused=${st.goalPaused}`, "info")
        return
      }
      const total = wakeTotal()
      if ((total ?? 0) > 0 && a !== "force") { // unknown wake still allows the manual path
        log(ctx, "rollover_refused", { total })
        ctx.ui.notify(`rollover: refused, wake total=${total ?? "unknown"} (children still running). Use /rollover force to override.`, "error")
        return
      }
      const prompt = st.successor ?? extractSuccessor(lastAssistantText(ctx.sessionManager?.getBranch?.() ?? []))
      if (!prompt) { ctx.ui.notify("rollover: no <successor> prompt found in the last assistant message.", "error"); return }
      const parentSession = ctx.sessionManager.getSessionFile()
      const oldId = sid(ctx), cwd = cwdOf(ctx)
      st.rollovers++
      summary(ctx, "rollover")
      await ctx.newSession({
        parentSession,
        withSession: async (c: any) => {
          // Only plain data captured; old pi/ctx are stale here.
          const newSession = String(c.sessionManager?.getSessionId?.() ?? "unknown")
          appendJsonl(join(dir, "sessions", `${oldId}.jsonl`), { t: now().toISOString(), session: oldId, cwd, ev: "rollover", newSession, parentSession })
          await c.sendUserMessage(prompt)
        },
      })
      st.state = "rolled_over"
      persist(oldId)
    },
  })

  return { st, config }
}

export default function (pi: any): void {
  createRollover(pi)
}
