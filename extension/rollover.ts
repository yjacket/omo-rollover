// rollover: hand a long-running main session off to a fresh one once context
// passes a token budget.
//
//   watching ──tokens ≥ budget | reread ratio──▶ armed
//   armed    ──(turn_end | agent_settled) ∧ Σ child wake==0 ∧ !pending──▶ handoff_requested
//   handoff_requested ──agent_settled ∧ <successor> found ∧ Σ child wake==0 ∧ !pending──▶ rollover (/rollover now)
//   (successor found but children live → rollover_deferred, re-checked on every agent_settled/turn_end)
//
// Signals: before_agent_start (context-budget system prompt block), message_end (usage), wake_source_state (shared pi.events bus),
// turn_end (early landing inside a long single-agent run, steer-delivered),
// agent_settled, tool_call (blocks `task` and `task_create` while not watching).
// Inert in omo-task child sessions. Everything is logged as JSONL under
// ~/.omo/rollover/ (override with OMO_ROLLOVER_DIR) for dashboard/build.mjs.
// State survives /reload and --resume via ~/.omo/rollover/state/<sessionId>.json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

export type State = "watching" | "armed" | "handoff_requested" | "rollover" | "rolled_over"
export type Config = { budgetTokens: number; rereadRatioMax: number; idleMinutes: number; idleMinTokens: number; idleGraceMinutes: number }
export const DEFAULT_CONFIG: Config = { budgetTokens: 150_000, rereadRatioMax: 0, idleMinutes: 50, idleMinTokens: 100_000, idleGraceMinutes: 5 } // reread off by default: tool-only turns (output ≈ 50) make the ratio meaningless
const REREAD_STREAK = 3
const SPAWN_TOOLS = new Set(["task", "task_create"]) // exact names; task_output/list/cancel/get/update/send stay allowed
// Only child sessions would be orphaned by newSession; monitors/servers survive it, so they never gate landing.
const CHILD_WAKE_SOURCES = new Set(["senpi-task", "omo-dag"])
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
      idleMinutes: Number.isFinite(Number(raw.idleMinutes)) && Number(raw.idleMinutes) >= 0 ? Number(raw.idleMinutes) : DEFAULT_CONFIG.idleMinutes,
      idleMinTokens: Number(raw.idleMinTokens) > 0 ? Number(raw.idleMinTokens) : DEFAULT_CONFIG.idleMinTokens,
      idleGraceMinutes: Number(raw.idleGraceMinutes) > 0 ? Number(raw.idleGraceMinutes) : DEFAULT_CONFIG.idleGraceMinutes,
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
const PERSISTED = ["state", "mode", "reason", "blocked", "rereadStreak", "goalPaused", "rollovers", "armedAt", "handoffAskedCount", "peak", "messages", "cacheRead", "output", "startedAt", "activeSkill", "budgetOverride", "idleOverride", "lastNoticeContext"] as const

export const ROLLOVER_HELP = [
  "rollover commands:",
  "  /rollover now [force]  hand off to a fresh session now (force overrides live children)",
  "  /rollover park         idle-style handoff: successor reports and waits for the user",
  "  /rollover auto|on|off  auto (default): force only autonomous sessions; on: always; off: never",
  "  /rollover limit <K> [save]  session token budget in thousands (200 = 200K); save writes config.json",
  "  /rollover idle <minutes>|off  idle-park threshold (0/off disables)",
  "  /rollover status       state, mode, budget source, wake, idle clocks",
  "  /rollover help         this text",
].join("\n")

/** Text of one message entry (string or text parts). */
function messageText(e: any): string {
  const c = e?.message?.content
  if (typeof c === "string") return c
  return (Array.isArray(c) ? c : []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")
}

// Name grammar = senpi's LEADING_SKILL_INVOCATION_PATTERN (dist/core/agent-session.js:149).
const SKILL_NAME = "[a-zA-Z][a-zA-Z0-9:_-]*"
const SKILL_TOKEN = new RegExp(`^(?:(\\/skill:|\\$skill:)|([$/]))(${SKILL_NAME})(?=\\s|$)`)
const SKILL_BLOCK = new RegExp(`<skill-instruction name="(${SKILL_NAME})"`) // what senpi stores after expanding a /skill: or $skill: token
export type ActiveSkill = { name: string; source: "message" | "boulder" }

/**
 * Earliest skill workflow the user invoked on this branch, else ulw-execute when
 * `.omo/boulder.json` has an active work id. `known` = skill names from pi.getCommands();
 * the ambiguous `$name` / `/name` forms count only when the name is known.
 */
export function detectActiveSkill(entries: any[], known: Set<string>, cwd: string): ActiveSkill | null {
  for (const e of entries) {
    if (e?.type !== "message" || e.message?.role !== "user") continue
    const text = messageText(e)
    const m = SKILL_TOKEN.exec(text.trimStart())
    const name = m?.[3] ?? SKILL_BLOCK.exec(text)?.[1]
    if (!name) continue
    if (m?.[2] && !known.has(name)) continue // bare $x or /x: only when x is a skill (e.g. omo's `/ulw-execute plan`)
    return { name, source: "message" }
  }
  try {
    if (JSON.parse(readFileSync(join(cwd, ".omo", "boulder.json"), "utf8"))?.active_work_id) return { name: "ulw-execute", source: "boulder" }
  } catch {}
  return null
}

export type IdleInput = {
  nowMs: number; lastUserAtMs: number; lastActivityAtMs: number; context: number
  childWake: number | null; idle: boolean; pending: boolean; state: State
  mode: "auto" | "on" | "off"; idleMinutes: number
}
export type IdleVerdict = { park: true } | { park: false; why: "off" | "mode" | "state" | "recent_user" | "recent_activity" | "below_min" | "busy" | "pending" | "wake_unknown" | "children" }

// Pure idle-park decision; every input is passed in so tests can drive the table. No I/O, no Date.
export function idleVerdict(cfg: Config, i: IdleInput): IdleVerdict {
  if (i.idleMinutes <= 0) return { park: false, why: "off" }
  if (i.mode === "off") return { park: false, why: "mode" }
  if (i.state !== "watching") return { park: false, why: "state" }
  if (i.nowMs - i.lastUserAtMs < i.idleMinutes * 60_000) return { park: false, why: "recent_user" }
  if (i.nowMs - i.lastActivityAtMs < cfg.idleGraceMinutes * 60_000) return { park: false, why: "recent_activity" }
  if (i.context < cfg.idleMinTokens) return { park: false, why: "below_min" }
  if (!i.idle) return { park: false, why: "busy" }
  if (i.pending) return { park: false, why: "pending" }
  if (i.childWake === null) return { park: false, why: "wake_unknown" }
  if (i.childWake > 0) return { park: false, why: "children" }
  return { park: true }
}

export const AUTONOMOUS_SKILLS = new Set(["ulw-execute", "ulw-loop", "ultrawork", "mass-ulw", "hyperplan"])

/** Ensure the successor prompt opens with a skill invocation token so senpi expands the skill body. */
export function withSkillToken(prompt: string, skill: string | null): string {
  if (!skill) return prompt
  return new RegExp(`^(?:\\/skill:|\\$skill:|\\$)${skill}(?=\\s|$)`).test(prompt) ? prompt : `$skill:${skill}\n${prompt}`
}

/** Text of the last assistant message on the current branch. */
export function lastAssistantText(entries: any[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.type !== "message" || e.message?.role !== "assistant") continue
    return messageText(e)
  }
  return ""
}

export function extractSuccessor(text: string): string | null {
  const m = /<successor>([\s\S]*?)<\/successor>/.exec(text)
  const s = m?.[1]?.trim()
  return s ? s : null
}

export function handoffPrompt(cwd: string, sessionId: string, goalPaused: boolean, activeSkill: string | null = null, reason: "budget" | "reread" | "idle" = "budget"): string {
  const file = join(cwd, ".omo", "rollover", `handoff-${sessionId}.md`)
  // The successor's system prompt lists skill names only; the body loads only when senpi expands an invocation token.
  const skillLine = activeSkill
    ? `The <successor> block must START with the line \`$skill:${activeSkill}\` (that exact token, nothing before it), then the handoff instructions: a new session only sees skill names, so this token is what loads the ${activeSkill} instructions again.`
    : ""
  return [
    reason === "idle"
      ? "[rollover] No user input for a while; parking this session. Stop working; hand off now."
      : "[rollover] This session's context is over budget. Stop working; hand off now.",
    reason === "idle"
      ? "If your last reply asked the user something or is waiting on a decision, add a `Waiting on user` section with the question verbatim and make the successor's first line re-ask it."
      : "",
    "Do NOT read any file, run any command, or spawn any task (task/task_create). Use only what is already in your context.",
    "Do NOT kill any server, monitor, or background shell you started; under Key files list each one as `port/PID/command` so the successor can reuse or stop it.",
    // The model-facing update_goal only accepts complete|blocked (paused is user/system-only); blocked stops goal-continuation and blocked→active is legal later.
    goalPaused ? "" : "First, if a goal is active, call the `update_goal` tool with status \"blocked\" and reason \"session rollover handoff in progress\".",
    `Write ${file} from memory (single write, max ~80 lines) with sections: Goal / Done / In progress / Next step / Key files / Constraints.`,
    "Then end your reply with the successor's first prompt wrapped as <successor>...</successor>, at most 25 lines.",
    skillLine,
    "The successor starts with an empty context. Its prompt must tell it to read only the handoff file plus `tail -n 30 .omo/ulw-execute/ledger.jsonl`, and NOT to read ulw-execute/SKILL.md, the full ledger, any prior-session JSONL, or any child transcript.",
  ]
    .filter(Boolean)
    .join("\n")
}

// Appended to the system prompt of every main-session turn (field: goal-continuation re-reads of plan/ledger/child transcripts cost +90K).
export const CONTEXT_BUDGET_BLOCK = [
  "## Context budget",
  "- Never read a whole ledger, plan, prior-session JSONL, or child transcript. Use `tail`, `grep`, or offset+limit ranges.",
  "- Read a given file range at most once per session; afterwards rely on what is already in context.",
  "- For child tasks use task_list / task_get / task_output only. A task with status `running` and residency `persisted_only` is dead: task_cancel it, do not investigate it.",
  "- When asked to write a rollover handoff, write it from context only: no reads, no commands, no spawns.",
].join("\n")

export type PauseResult = { ok: boolean; method: "main" | "dist" | "none"; error?: string }
// The slice of senpi's main entry we probe for; the goal store may or may not be re-exported there.
export type PauseOpts = { env?: Record<string, string | undefined>; argv1?: string; importMain?: () => Promise<unknown> }
const errMsg = (e: unknown) => String(e instanceof Error ? e.message : e)
const goalCwd = (ctx: GoalCtx) => ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? process.cwd()
// Type guard: the main entry only counts when it re-exports the whole goal-store surface.
const isGoalStoreMain = (m: unknown): m is GoalStoreModule & GoalRefModule => {
  if (typeof m !== "object" || m === null) return false
  return "readGoal" in m && "updateGoal" in m && "goalStoreRef" in m
    && typeof m.readGoal === "function" && typeof m.updateGoal === "function" && typeof m.goalStoreRef === "function"
}
// The ctx surface the goal-store boundary needs.
export type GoalCtx = { cwd?: string; sessionManager?: { getCwd?: () => string; getSessionId?: () => unknown; getBranch?: () => unknown[] } }
const GOAL_REL = ["core", "extensions", "builtin", "goal"]

// Where senpi's dist may be: omo's launcher spawns `<senpi>/dist/cli.js` (so argv[1] is inside dist)
// and exports OMO_BIN=<omo-ai>/bin/omo.js; a direct `node bin/omo.js` has argv[1] = omo.js.
function senpiDistCandidates(env: Record<string, string | undefined>, argv1: string | undefined): string[] {
  const fromOmoBin = (bin: string) => join(dirname(dirname(bin)), "node_modules", "@code-yeongyu", "senpi", "dist")
  const out: string[] = []
  if (argv1) out.push(dirname(argv1), fromOmoBin(argv1))
  if (env.OMO_BIN) out.push(fromOmoBin(env.OMO_BIN))
  return out
}

// Goal pause via senpi's store. `import.meta.resolve` never worked here (no node_modules under
// ~/.omo/agent/extensions); the loader only aliases bare `import("@code-yeongyu/senpi")`, and that
// entry does not currently export the goal store, so the dist path derivation is the working route.
// Narrow views of senpi's goal store modules (dist/core/extensions/builtin/goal/{store,store-ref}.js).
export type GoalRef = unknown
export type GoalStoreModule = { readGoal: (ref: GoalRef) => Promise<{ status?: string } | null>; updateGoal: (ref: GoalRef, update: { status: string }, source?: string) => Promise<unknown> }
export type GoalRefModule = { goalStoreRef: (sessionManager: unknown, cwd: string) => GoalRef }
export type GoalStore = { store: GoalStoreModule; ref: GoalRefModule; method: "main" | "dist" }

// Load senpi's goal store modules via the main entry or a derived dist path. Never throws.
export async function loadGoalStore(opts: PauseOpts = {}): Promise<GoalStore | { error: string }> {
  const env = opts.env ?? process.env
  const argv1 = opts.argv1 ?? process.argv[1]
  const errors: string[] = []
  try {
    const m: unknown = await (opts.importMain ?? (() => import("@code-yeongyu/senpi")))()
    if (isGoalStoreMain(m)) return { store: m, ref: m, method: "main" }
    errors.push("main entry has no goal store exports")
  } catch (e) {
    errors.push(`main: ${errMsg(e)}`)
  }
  for (const dist of senpiDistCandidates(env, argv1)) {
    const goal = join(dist, ...GOAL_REL)
    if (!existsSync(join(goal, "store.js")) || !existsSync(join(goal, "store-ref.js"))) continue
    try {
      const store: GoalStoreModule = await import(pathToFileURL(join(goal, "store.js")).href)
      const ref: GoalRefModule = await import(pathToFileURL(join(goal, "store-ref.js")).href)
      return { store, ref, method: "dist" }
    } catch (e) {
      errors.push(`dist ${dist}: ${errMsg(e)}`)
    }
  }
  return { error: errors.concat("no senpi dist found").join("; ") }
}

// Read the goal's status without mutating it. Returns null on any failure.
export async function goalStatus(ctx: GoalCtx, opts: PauseOpts = {}): Promise<string | null> {
  try {
    const loaded = await loadGoalStore(opts)
    if (!("store" in loaded)) return null
    const r = loaded.ref.goalStoreRef(ctx.sessionManager, goalCwd(ctx))
    const g = await loaded.store.readGoal(r)
    return g?.status ?? null
  } catch {
    return null
  }
}

// ok:true means an active goal was actually paused by us — a no-op store read is not a pause.
export async function pauseGoal(ctx: GoalCtx, opts: PauseOpts = {}): Promise<PauseResult> {
  const loaded = await loadGoalStore(opts)
  if (!("store" in loaded)) return { ok: false, method: "none", error: loaded.error }
  const { store, ref, method } = loaded
  try {
    const r = ref.goalStoreRef(ctx.sessionManager, goalCwd(ctx))
    const g = await store.readGoal(r)
    if (g?.status !== "active") return { ok: false, method, error: `no active goal (status=${g?.status ?? "none"})` }
    await store.updateGoal(r, { status: "paused" }, "user")
    return { ok: true, method }
  } catch (e) {
    return { ok: false, method, error: errMsg(e) }
  }
}

// Undo a pause this extension made (idle park aborted). ok:true only when a paused goal was reactivated.
export async function resumeGoal(ctx: GoalCtx, opts: PauseOpts = {}): Promise<PauseResult> {
  const loaded = await loadGoalStore(opts)
  if (!("store" in loaded)) return { ok: false, method: "none", error: loaded.error }
  const { store, ref, method } = loaded
  try {
    const r = ref.goalStoreRef(ctx.sessionManager, goalCwd(ctx))
    const g = await store.readGoal(r)
    if (g?.status !== "paused") return { ok: false, method, error: `no paused goal (status=${g?.status ?? "none"})` }
    await store.updateGoal(r, { status: "active" }, "user")
    return { ok: true, method }
  } catch (e) {
    return { ok: false, method, error: errMsg(e) }
  }
}

export type TimerHandle = ReturnType<typeof setInterval>
export type Deps = { env?: Record<string, string | undefined>; now?: () => Date; pauseGoal?: (ctx: GoalCtx) => Promise<PauseResult>; resumeGoal?: (ctx: GoalCtx) => Promise<PauseResult>; goalStatus?: (ctx: GoalCtx) => Promise<string | null>; timer?: { setInterval: (fn: () => void, ms: number) => TimerHandle; clearInterval: (id: TimerHandle) => void } }

export function createRollover(pi: any, deps: Deps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const doPause = deps.pauseGoal ?? pauseGoal
  const doResume = deps.resumeGoal ?? resumeGoal
  const doGoalStatus = deps.goalStatus ?? goalStatus
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
    activeSkill: null as string | null,
    budgetOverride: null as number | null,
    idleOverride: null as number | null,
    lastNoticeContext: null as number | null,
    autonomous: null as boolean | null, // arm-time verdict; not persisted
    lastIdleWhy: null as string | null,
  }

  let lastCtx: any = null
  // In-memory clocks only: a resumed/reloaded session must never park immediately.
  let lastUserAt = now().getTime()
  let lastActivityAt = now().getTime()
  let lastVerdict = "-"
  const knownSkills = () => new Set<string>((pi.getCommands?.() ?? []).filter((c: any) => c?.source === "skill").map((c: any) => String(c.name).replace(/^skill:/, "")))
  // Autonomous = a ulw-family skill is driving this session or a goal is active. Never throws;
  // the verdict is stored on st.autonomous so /rollover status reflects the last evaluation.
  const isAutonomous = async (ctx: GoalCtx): Promise<boolean> => {
    let skill: ActiveSkill | null = null
    let goal: string | null = null
    try {
      skill = detectActiveSkill(ctx.sessionManager?.getBranch?.() ?? [], knownSkills(), cwdOf(ctx))
      goal = await doGoalStatus(ctx)
    } catch {
      goal = null
    }
    const autonomous = (!!skill && AUTONOMOUS_SKILLS.has(skill.name)) || goal === "active"
    st.autonomous = autonomous
    if (skill) { st.activeSkill = skill.name; log(ctx, "active_skill", skill) }
    log(ctx, "autonomy", { autonomous, skill: skill?.name ?? null, goal })
    return autonomous
  }
  const sid = (ctx: any) => String(ctx?.sessionManager?.getSessionId?.() ?? "unknown")
  const cwdOf = (ctx: any) => String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd())
  const log = (ctx: any, ev: string, extra: Record<string, unknown> = {}) =>
    appendJsonl(join(dir, "sessions", `${sid(ctx)}.jsonl`), { t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), ev, ...extra })
  const wakeTotal = (): number | null => (st.wake.size ? [...st.wake.values()].reduce((a, b) => a + b, 0) : null)
  // null while no child source has reported (unknown != zero); otherwise the sum over child sources only.
  const childWakeTotal = (): number | null => {
    let seen = false, sum = 0
    for (const s of CHILD_WAKE_SOURCES) if (st.wake.has(s)) { seen = true; sum += st.wake.get(s)! }
    return seen ? sum : null
  }
  const enabled = () => st.mode !== "off"
  const budget = () => st.budgetOverride ?? config.budgetTokens
  const stateFile = (id: string) => join(dir, "state", `${id}.json`)
  const persist = (id: string) => {
    let other = {} // keep keys owned by sibling extensions
    try { other = JSON.parse(readFileSync(stateFile(id), "utf8")) } catch {}
    writeJsonAtomic(stateFile(id), { ...other, ...Object.fromEntries(PERSISTED.map((k) => [k, st[k]])), updatedAt: now().toISOString() })
  }
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
      armReason: st.reason || null,
    })

  // Throttled notify: fires only when context grew >= 50K since the last notice; arm() resets
  // lastNoticeContext per arm episode so the armed notice is never suppressed by an earlier warning.
  const notice = (ctx: any, text: string, kind: string) => {
    if (st.lastNoticeContext != null && st.context - st.lastNoticeContext < 50_000) return false
    st.lastNoticeContext = st.context
    persist(sid(ctx))
    ctx.ui?.notify?.(text, kind)
    return true
  }

  // Cancel an idle-park attempt: back to watching, drop the held successor, and undo a goal pause we made.
  async function abortIdle(ctx: GoalCtx) {
    st.state = "watching"
    st.reason = ""
    st.handoffAskedCount = 0
    st.successor = null // the held successor was written for the parked session
    if (st.goalPaused) {
      st.goalPaused = false
      const resume = await doResume(ctx)
      log(ctx, "goal_resume", resume)
    }
    log(ctx, "idle_aborted", {})
    persist(sid(ctx))
  }

  async function arm(ctx: any, reason: string) {
    const seenUserAt = lastUserAt
    const autonomous = await isAutonomous(ctx)
    const why = reason === "budget" ? `budget ${budget()} reached` : reason === "idle" ? "idle park" : `reread ratio ≥ ${config.rereadRatioMax} for ${REREAD_STREAK} messages`
    // auto (the default) only forces a handoff in autonomous sessions; manual park (idle) always arms.
    if (st.mode === "auto" && reason !== "idle" && !autonomous) {
      if (notice(ctx, `rollover: budget reached (${why}) — auto mode, not an autonomous session (no active goal, no ulw skill). /rollover on to force, /rollover now to hand off now.`, "warning"))
        log(ctx, "budget_notice", { reason, context: st.context, budget: budget() })
      return
    }
    if (stopped) return // shutdown landed while autonomy was in flight
    // User input during the autonomy await invalidates an idle attempt before it arms.
    if (reason === "idle" && lastUserAt !== seenUserAt) { await abortIdle(ctx); return }
    st.state = "armed"
    st.reason = reason
    st.armedAt = now().toISOString()
    st.lastNoticeContext = null // new arm episode: the armed notice must not be throttled away
    log(ctx, "armed", { reason, context: st.context })
    const pause = await doPause(ctx)
    log(ctx, "goal_pause", pause)
    if (stopped || st.state !== "armed") {
      // Aborted (or shut down) while the pause was in flight: undo a pause that landed after the abort.
      if (reason === "idle" && pause.ok) { const resume = await doResume(ctx); log(ctx, "goal_resume", resume) }
      return
    }
    if (reason === "idle" && lastUserAt !== seenUserAt) {
      // A typed command bypasses the input hook but still moves lastUserAt: the attempt is cancelled.
      // Invalidate FIRST (abortIdle flips state synchronously) so no hook can send while the resume awaits.
      await abortIdle(ctx)
      if (pause.ok) { const resume = await doResume(ctx); log(ctx, "goal_resume", resume) }
      return
    }
    st.goalPaused = pause.ok
    persist(sid(ctx))
    notice(ctx, `rollover: armed (${why}, context=${st.context}). task/task_create blocked; handing off once children drain.`, "warning")
  }

  // Single guard for both landing points so the instruction is injected once.
  function requestHandoff(ctx: any, at: "turn_end" | "agent_settled" | "idle"): boolean {
    if (stopped || !enabled() || st.state !== "armed" || childWakeTotal() !== 0 || ctx.hasPendingMessages?.()) return false
    st.state = "handoff_requested"
    st.handoffAskedCount = 1
    log(ctx, "handoff_requested", { at, context: st.context })
    persist(sid(ctx))
    // Mid-run: steer so it lands before the next turn instead of after the whole run settles.
    pi.sendUserMessage(handoffPrompt(cwdOf(ctx), sid(ctx), st.goalPaused, st.activeSkill, st.reason === "idle" ? "idle" : (st.reason as "budget" | "reread")), at === "turn_end" ? { deliverAs: "steer" } : undefined)
    return true
  }

  // Successor in the last assistant reply → dispatch /rollover now, but only once
  // nothing can wake this session (a live child would be orphaned by newSession).
  // Shared by agent_settled, turn_end and session_start (a /reload between the reply and settle).
  async function tryRollover(ctx: any): Promise<boolean> {
    const found = extractSuccessor(lastAssistantText(ctx.sessionManager?.getBranch?.() ?? [])) ?? st.successor // deferred: a child's result may have moved the last reply
    if (!found) return false
    st.successor = found
    const total = childWakeTotal()
    if (total !== 0 || ctx.hasPendingMessages?.()) {
      log(ctx, "rollover_deferred", { total, wake: Object.fromEntries(st.wake) })
      return true // successor is in hand; stay in handoff_requested, no re-ask
    }
    // auto lands only for sessions authorized at arm time (st.autonomous / goalPaused by us) or still autonomous now; idle parks always land.
    if (st.mode === "auto" && st.reason !== "idle" && !st.goalPaused && !(st.autonomous ?? (await isAutonomous(ctx)))) {
      log(ctx, "rollover_deferred", { total, wake: Object.fromEntries(st.wake), reason: "not_autonomous" })
      notice(ctx, "rollover: auto mode — not an autonomous session; staying. /rollover now to hand off.", "warning")
      return true
    }
    // Shutdown or an abort (idle input cancels synchronously during the await) invalidates the dispatch.
    // A restored "rollover" state must still redispatch — only a non-handoff state means cancelled.
    if (stopped || (st.state !== "handoff_requested" && st.state !== "rollover")) return true
    st.state = "rollover"
    log(ctx, "successor_found", { chars: found.length })
    persist(sid(ctx))
    pi.sendUserMessage("/rollover now", { expandPromptTemplates: true })
    return true
  }

  pi.on("session_start", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    lastUserAt = now().getTime() // a reload/resume must never park immediately
    lastActivityAt = now().getTime()
    const parent = ctx?.sessionManager?.getHeader?.()?.parentSession
    log(ctx, "session_start", parent ? { parent } : {})
    if (!restore(sid(ctx))) return
    rearm() // a resumed session gets a fresh timer against its restored override
    log(ctx, "state_restored", { state: st.state })
    if (enabled() && (st.state === "handoff_requested" || st.state === "rollover")) await tryRollover(ctx)
  })

  // Main sessions only (child sessions returned null above); off with /rollover off.
  pi.on("before_agent_start", async (ev: any) => {
    if (!enabled()) return
    return { systemPrompt: `${ev?.systemPrompt ?? ""}\n\n${CONTEXT_BUDGET_BLOCK}` }
  })

  pi.on("input", async (ev: any, ctx: any) => {
    lastCtx = ctx
    log(ctx, "user_input", { source: ev?.source, streaming: ev?.streamingBehavior ?? null })
    if (ev?.source !== "extension") {
      lastUserAt = now().getTime()
      if (st.reason === "idle" && (st.state === "armed" || st.state === "handoff_requested")) {
        await abortIdle(ctx)
        ctx.ui?.notify?.("rollover: idle park aborted by user input", "info")
      }
    }
  })

  pi.on("message_end", async (ev: any, ctx: any) => {
    lastCtx = ctx
    lastActivityAt = now().getTime()
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
    // Lane the turn actually ran on (a session mixes lanes under model fallback); prompt-cache TTL is per lane.
    const provider = typeof m.provider === "string" ? m.provider : ctx.model?.provider
    log(ctx, "message_end", { input, output, cacheRead, cacheWrite, context, ratio, provider })
    persist(sid(ctx)) // counters above feed the summary row; keep them across /reload
    if (!enabled() || st.state !== "watching" || context <= 0) return

    if (context >= budget()) return arm(ctx, "budget")
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
    if (st.state === "handoff_requested" && st.successor) { if (enabled()) await tryRollover(ctx); return }
    if (st.state !== "armed") return
    log(ctx, "turn_end", { total: wakeTotal() })
    if (enabled()) requestHandoff(ctx, "turn_end")
  })

  pi.on("agent_settled", async (_ev: any, ctx: any) => {
    lastCtx = ctx
    lastActivityAt = now().getTime()
    const total = wakeTotal()
    log(ctx, "agent_settled", { total, state: st.state })
    if (!enabled()) return
    if (st.state === "armed") {
      requestHandoff(ctx, "agent_settled")
      return
    }
    if (st.state === "handoff_requested") {
      if (await tryRollover(ctx)) return
      // Shutdown, mode-off, or an idle abort during the await: the old session must not send.
      if (stopped || !enabled() || st.state !== "handoff_requested") return
      log(ctx, "successor_missing", { retried: st.handoffAskedCount > 1 })
      if (st.handoffAskedCount < 2) {
        st.handoffAskedCount = 2
        persist(sid(ctx))
        pi.sendUserMessage("[rollover] Your reply did not contain a <successor>...</successor> block. Reply again with only the handoff file written and the successor prompt wrapped in <successor></successor>.")
        return
      }
      st.state = "armed"
      persist(sid(ctx))
      ctx.ui?.notify?.("rollover: no <successor> prompt after two asks; staying armed. Run /rollover now manually.", "error")
    }
  })

  pi.on("session_shutdown", async (ev: any, ctx: any) => {
    stopped = true
    if (idleTimer != null) { timer.clearInterval(idleTimer); idleTimer = null }
    if (ev?.reason === "reload") return
    summary(ctx, String(ev?.reason ?? "unknown"))
  })

  const timer = deps.timer ?? { setInterval, clearInterval }
  const effectiveIdleMinutes = () => st.idleOverride ?? config.idleMinutes
  let idleTimer: TimerHandle | null = null
  let stopped = false
  function rearm() {
    if (idleTimer != null) { timer.clearInterval(idleTimer); idleTimer = null }
    if (effectiveIdleMinutes() > 0 && !stopped) {
      idleTimer = timer.setInterval(() => void tick(), 60_000)
      idleTimer.unref?.()
    }
  }
  async function tick() {
    const ctx = lastCtx
    if (!ctx || stopped) return
    // An armed-for-idle session that survived a turn without user input still wants its handoff —
    // but only while the extension is enabled and the runtime still reports idle.
    if (st.state === "armed" && st.reason === "idle") {
      if (enabled() && ctx.isIdle?.() === true) requestHandoff(ctx, "idle")
      return
    }
    const input: IdleInput = {
      nowMs: now().getTime(), lastUserAtMs: lastUserAt, lastActivityAtMs: lastActivityAt,
      context: ctx.getContextUsage?.()?.tokens ?? st.context, childWake: childWakeTotal(),
      idle: ctx.isIdle?.() === true, pending: !!ctx.hasPendingMessages?.(),
      state: st.state, mode: st.mode, idleMinutes: effectiveIdleMinutes(),
    }
    const v = idleVerdict(config, input)
    const sinceUserMin = Math.round((input.nowMs - lastUserAt) / 60_000)
    const sinceActivityMin = Math.round((input.nowMs - lastActivityAt) / 60_000)
    lastVerdict = v.park ? "park" : `skip:${v.why}`
    if (!v.park) {
      // Time gates are silent; log only actionable skips, and only when the reason changed since the last tick.
      if (["busy", "pending", "wake_unknown", "children"].includes(v.why) && v.why !== st.lastIdleWhy)
        log(ctx, "idle_skip", { why: v.why, sinceUserMin, sinceActivityMin, context: input.context, childWake: input.childWake })
      st.lastIdleWhy = v.why
      return
    }
    log(ctx, "idle_park", { sinceUserMin, sinceActivityMin, context: input.context, childWake: input.childWake })
    await arm(ctx, "idle") // arm() itself aborts on mid-arm user input
    if (stopped || st.state !== "armed") return
    // The runtime may have gone busy while arm() was awaiting; re-check before sending.
    if (ctx.isIdle?.() !== true) { await abortIdle(ctx); return }
    requestHandoff(ctx, "idle")
  }
  rearm()

  pi.registerCommand("rollover", {
    description: "rollover now [force] | park | auto|on|off | limit <K> [save] | idle <min>|off | status | help",
    handler: async (args: string, ctx: any) => {
      lastUserAt = now().getTime() // typed commands bypass the input hook
      const [verb = "", ...rest] = (args ?? "").trim().split(/\s+/)
      log(ctx, "command", { verb })
      if (verb === "" || verb === "help") { ctx.ui.notify(ROLLOVER_HELP, "info"); return }
      if (verb === "on" || verb === "off" || verb === "auto") { st.mode = verb; persist(sid(ctx)); ctx.ui.notify(`rollover: ${verb}`, "info"); return }
      if (verb === "status") {
        const mins = (ms: number) => `${(ms / 60_000).toFixed(1)}m`
        ctx.ui.notify(`rollover: state=${st.state} mode=${st.mode} reason=${st.reason || "-"} context=${st.context}/${budget()} (${st.budgetOverride != null ? "session" : "config"}) wake=${wakeTotal() ?? "unknown"} childWake=${childWakeTotal() ?? "unknown"} blocked=${st.blocked} goalPaused=${st.goalPaused} idle=${effectiveIdleMinutes() > 0 ? effectiveIdleMinutes() + "m" : "off"} sinceUser=${mins(now().getTime() - lastUserAt)} sinceActivity=${mins(now().getTime() - lastActivityAt)} lastVerdict=${lastVerdict} autonomous=${st.autonomous ?? "unknown"}`, "info")
        return
      }
      if (verb === "idle") {
        if (rest[0] === undefined) {
          const mins = (ms: number) => `${(ms / 60_000).toFixed(1)}m`
          ctx.ui.notify(`rollover: idle=${effectiveIdleMinutes() > 0 ? effectiveIdleMinutes() + "m" : "off"} sinceUser=${mins(now().getTime() - lastUserAt)} sinceActivity=${mins(now().getTime() - lastActivityAt)} lastVerdict=${lastVerdict}`, "info")
          return
        }
        const m = rest[0] === "off" ? 0 : Number(rest[0])
        if (!Number.isInteger(m) || m < 0) { ctx.ui.notify(`rollover: idle needs whole minutes or off, e.g. /rollover idle 30`, "error"); return }
        st.idleOverride = m
        persist(sid(ctx))
        rearm()
        ctx.ui.notify(`rollover: idle=${m > 0 ? m + "m" : "off"} (session)`, "info")
        return
      }
      if (verb === "limit") {
        const m = /^(\d+)(k?)$/i.exec(rest[0] ?? "")
        const k = m ? Number(m[1]) * (m[2] ? 1000 : (Number(m[1]) < 1000 ? 1000 : 1)) : NaN
        if (!Number.isFinite(k) || k <= 0) { ctx.ui.notify(`rollover: limit needs a positive number, e.g. /rollover limit 200`, "error"); return }
        st.budgetOverride = k
        persist(sid(ctx))
        if (rest[1] === "save") {
          let existing: Record<string, unknown> = {}
          try { existing = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) } catch {}
          writeJsonAtomic(join(dir, "config.json"), { ...existing, budgetTokens: k })
          ctx.ui.notify(`rollover: limit=${Math.round(k / 1000)}K (saved)`, "info")
        } else {
          ctx.ui.notify(`rollover: limit=${Math.round(k / 1000)}K (session)`, "info")
        }
        return
      }
      if (verb === "park") {
        if (!enabled() || st.state !== "watching" || childWakeTotal() !== 0) {
          ctx.ui.notify(`rollover: park refused (state=${st.state}, childWake=${childWakeTotal() ?? "unknown"})`, "error")
          return
        }
        await arm(ctx, "idle")
        requestHandoff(ctx, "idle")
        return
      }
      if (verb !== "now") { ctx.ui.notify(`rollover: unknown verb "${verb}". ${ROLLOVER_HELP.split("\n")[0]} — /rollover help`, "error"); return }
      const total = childWakeTotal()
      if ((total ?? 0) > 0 && rest[0] !== "force") { // unknown wake still allows the manual path
        log(ctx, "rollover_refused", { total })
        ctx.ui.notify(`rollover: refused, wake total=${total ?? "unknown"} (children still running). Use /rollover now force to override.`, "error")
        return
      }
      const found = st.successor ?? extractSuccessor(lastAssistantText(ctx.sessionManager?.getBranch?.() ?? []))
      if (!found) { ctx.ui.notify("rollover: no <successor> prompt found in the last assistant message.", "error"); return }
      const prompt = withSkillToken(found, st.activeSkill) + (st.reason === "idle" ? `\n[rollover] Parked idle at ${now().toISOString()}. Read the handoff, report in <= 5 lines, then wait for the user.` : "")
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
          await c.sendUserMessage(prompt, { expandPromptTemplates: true }) // expands the leading $skill: token into the skill body
        },
      })
      st.state = "rolled_over"
      persist(oldId)
    },
  })

  return { st, config, clocks: () => ({ lastUserAt, lastActivityAt }), tick, rearm, isAutonomous }
}

export default function (pi: any): void {
  createRollover(pi)
}
