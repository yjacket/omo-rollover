// rollover: hand a long-running main session off to a fresh one once context
// passes a token budget.
//
//   watching ──tokens ≥ budget | reread ratio──▶ armed
//   armed    ──agent_settled ∧ Σwake==0 ∧ !pending──▶ handoff_requested
//   handoff_requested ──agent_settled ∧ <successor> found──▶ rollover (/rollover)
//
// Signals: message_end (usage), wake_source_state (shared pi.events bus),
// agent_settled, tool_call (blocks task_create while armed).
// Inert in omo-task child sessions. Everything is logged as JSONL under
// ~/.omo/rollover/ (override with OMO_ROLLOVER_DIR) for dashboard/build.mjs.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

export type State = "watching" | "armed" | "handoff_requested" | "rollover"
export type Config = { budgetTokens: number; rereadRatioMax: number }
export const DEFAULT_CONFIG: Config = { budgetTokens: 150_000, rereadRatioMax: 150 }
const REREAD_STREAK = 3
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
      rereadRatioMax: Number(raw.rereadRatioMax) > 0 ? Number(raw.rereadRatioMax) : DEFAULT_CONFIG.rereadRatioMax,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(obj) + "\n")
}

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
    "[rollover] This session's context is over budget. Do NOT start new work and do NOT spawn tasks.",
    goalPaused ? "" : "First, if a goal is active, call the `update_goal` tool with status \"paused\".",
    `Write a handoff file at ${file} with these sections: Goal, Done, In progress, Next step, Key files, Constraints.`,
    "Then end your reply with the exact first prompt for your successor session, wrapped as <successor>...</successor>.",
    "The successor starts with an empty context: the prompt must tell it to read the handoff file first and what to do next.",
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
    retried: false,
    goalPaused: false,
    successor: null as string | null,
    startedAt: now().toISOString(),
    rollovers: 0,
  }

  let lastCtx: any = null
  const sid = (ctx: any) => String(ctx?.sessionManager?.getSessionId?.() ?? "unknown")
  const cwdOf = (ctx: any) => String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd())
  const log = (ctx: any, ev: string, extra: Record<string, unknown> = {}) =>
    appendJsonl(join(dir, "sessions", `${sid(ctx)}.jsonl`), { t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), ev, ...extra })
  const wakeTotal = (): number | null => (st.wake.size ? [...st.wake.values()].reduce((a, b) => a + b, 0) : null)
  const enabled = () => st.mode !== "off"
  const summary = (ctx: any, reason: string) =>
    appendJsonl(join(dir, "summary.jsonl"), {
      t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), reason, startedAt: st.startedAt,
      peakContext: st.peak, messages: st.messages, cacheRead: st.cacheRead, output: st.output,
      rereadRatio: st.output ? +(st.cacheRead / st.output).toFixed(1) : null, rollovers: st.rollovers, blocked: st.blocked, state: st.state,
    })

  async function arm(ctx: any, reason: string) {
    st.state = "armed"
    st.reason = reason
    log(ctx, "armed", { reason, context: st.context })
    st.goalPaused = await doPause(ctx)
    ctx.ui?.notify?.(`rollover: armed (${reason}, context=${st.context}). task_create blocked; handing off once children drain.`, "warning")
  }

  function requestHandoff(ctx: any) {
    st.state = "handoff_requested"
    log(ctx, "handoff_requested", { context: st.context })
    pi.sendUserMessage(handoffPrompt(cwdOf(ctx), sid(ctx), st.goalPaused))
  }

  pi.on("session_start", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    const parent = ctx?.sessionManager?.getHeader?.()?.parentSession
    log(ctx, "session_start", parent ? { parent } : {})
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
    log(ctx, "message_end", { input, output, cacheRead, cacheWrite, context })
    if (!enabled() || st.state !== "watching" || context <= 0) return

    if (context >= config.budgetTokens) return arm(ctx, "budget")
    const ratio = cacheRead / Math.max(1, output)
    st.rereadStreak = ratio >= config.rereadRatioMax ? st.rereadStreak + 1 : 0
    if (st.rereadStreak >= REREAD_STREAK) return arm(ctx, "reread")
  })

  pi.on("tool_call", async (ev: any, ctx: any) => {
    if (!enabled() || st.state === "watching" || ev?.toolName !== "task_create") return
    st.blocked++
    log(ctx, "tool_call_blocked", { tool: ev.toolName })
    return { block: true, reason: "rollover: session handoff is pending; do not spawn new tasks. Let running children finish, then stop." }
  })

  pi.events?.on?.("wake_source_state", (d: any) => {
    if (!d?.source) return
    st.wake.set(String(d.source), Number(d.activeCount) || 0)
    if (lastCtx) log(lastCtx, "wake_source_state", { source: d.source, activeCount: d.activeCount, total: wakeTotal() })
  })

  pi.on("agent_settled", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    const total = wakeTotal()
    log(ctx, "agent_settled", { total, state: st.state })
    if (!enabled()) return
    if (st.state === "armed") {
      if (total === 0 && !ctx.hasPendingMessages?.()) requestHandoff(ctx)
      return
    }
    if (st.state === "handoff_requested") {
      const found = extractSuccessor(lastAssistantText(ctx.sessionManager?.getBranch?.() ?? []))
      if (found) {
        st.successor = found
        st.state = "rollover"
        log(ctx, "successor_found", { chars: found.length })
        pi.sendUserMessage("/rollover", { expandPromptTemplates: true })
        return
      }
      log(ctx, "successor_missing", { retried: st.retried })
      if (!st.retried) {
        st.retried = true
        pi.sendUserMessage("[rollover] Your reply did not contain a <successor>...</successor> block. Reply again with only the handoff file written and the successor prompt wrapped in <successor></successor>.")
        return
      }
      st.state = "armed"
      ctx.ui?.notify?.("rollover: no <successor> prompt after two asks; staying armed. Run /rollover manually.", "error")
    }
  })

  pi.on("session_shutdown", async (ev: any, ctx: any) => {
    if (ev?.reason === "reload") return
    summary(ctx, String(ev?.reason ?? "unknown"))
  })

  pi.registerCommand("rollover", {
    description: "rollover on|off|status — or no args: hand off to a fresh session now",
    handler: async (args: string, ctx: any) => {
      const a = (args ?? "").trim()
      if (a === "on" || a === "off") { st.mode = a; ctx.ui.notify(`rollover: ${a}`, "info"); return }
      if (a === "status") {
        ctx.ui.notify(`rollover: state=${st.state} mode=${st.mode} context=${st.context}/${config.budgetTokens} wake=${wakeTotal() ?? "unknown"} blocked=${st.blocked} goalPaused=${st.goalPaused}`, "info")
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
    },
  })

  return { st, config }
}

export default function (pi: any): void {
  createRollover(pi)
}
