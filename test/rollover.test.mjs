// Fake `pi` harness: no senpi, no LLM. Run: node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { createRollover, extractSuccessor, lastAssistantText, handoffPrompt, pauseGoal, detectActiveSkill, withSkillToken, CONTEXT_BUDGET_BLOCK } from "../extension/rollover.ts"

// Pass `dir` to build a second instance on the same data dir (= /reload or --resume).
function harness({ env = {}, branch = [], cwd = "C:/work", dir = mkdtempSync(join(tmpdir(), "rollover-")), pause = async () => ({ ok: true, method: "fake" }) } = {}) {
  const handlers = {}, bus = {}, sent = [], commands = {}, notes = []
  const pi = {
    on: (ev, h) => (handlers[ev] = h),
    events: { on: (ev, h) => (bus[ev] = h) },
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
    registerCommand: (name, def) => (commands[name] = def),
    getCommands: () => [{ name: "rollover", source: "extension" }, { name: "skill:ulw-execute", source: "skill" }, { name: "skill:ulw-loop", source: "skill" }],
  }
  let tokens = 0
  const ctx = {
    cwd,
    ui: { notify: (m, k) => notes.push({ m, k }) },
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 0 }),
    hasPendingMessages: () => false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => "C:/sess/s1.jsonl", getCwd: () => cwd, getBranch: () => branch, getHeader: () => ({}) },
    newSession: async ({ withSession }) => {
      await withSession({ sessionManager: { getSessionId: () => "s2" }, sendUserMessage: async (t, o) => sent.push({ text: t, session: "s2", opts: o }) })
      return { cancelled: false }
    },
  }
  const ext = createRollover(pi, { env: { OMO_ROLLOVER_DIR: dir, ...env }, now: () => new Date(0), pauseGoal: pause })
  const fire = (ev, e = {}) => handlers[ev]?.(e, ctx)
  const message = (context, extra = {}) => {
    tokens = context
    return fire("message_end", { message: { role: "assistant", usage: { input: 1000, output: 500, cacheRead: context - 1000, cacheWrite: 0, ...extra } } })
  }
  const wake = (activeCount, source = "senpi-task") => bus.wake_source_state?.({ source, activeCount })
  const spawn = () => fire("tool_call", { toolName: "task_create", input: {} })
  const lines = () => (existsSync(join(dir, "sessions", "s1.jsonl")) ? readFileSync(join(dir, "sessions", "s1.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [])
  return { dir, ctx, ext, handlers, sent, commands, notes, fire, message, wake, spawn, lines }
}

test("child session is inert: no handlers, no commands, no log", () => {
  const h = harness({ env: { OMO_SENPI_TASK_RPC_CHILD: "1" } })
  assert.equal(h.ext, null)
  assert.deepEqual(Object.keys(h.handlers), [])
  assert.deepEqual(Object.keys(h.commands), [])
  assert.equal(existsSync(join(h.dir, "sessions")), false)
})

test("overlap-spawning main with blocking lands after existing children drain", async () => {
  const h = harness()
  await h.fire("session_start")
  await h.message(50_000)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "watching")
  h.wake(2) // two children running, then context passes the budget
  await h.message(160_000)
  assert.equal(h.ext.st.state, "armed")
  const r = await h.spawn() // main keeps trying to spawn; every attempt is blocked
  assert.equal(r.block, true)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "armed", "still armed while children run")
  h.wake(1)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "armed")
  await h.spawn()
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.match(h.sent.at(-1).text, /<successor>/)
  assert.match(h.sent.at(-1).text, /handoff-s1\.md/)
  assert.equal(h.ext.st.blocked, 2)
})

test("without blocking (harness ignores block result and keeps spawning) never lands", async () => {
  const h = harness()
  await h.message(160_000)
  assert.equal(h.ext.st.state, "armed")
  let active = 1
  for (let i = 0; i < 20; i++) {
    await h.spawn()
    active++ // spawn ignored the block
    h.wake(active)
    await h.fire("agent_settled")
    active-- // one child finishes, one is always left
    h.wake(active)
    await h.fire("agent_settled")
    assert.equal(h.ext.st.state, "armed", `cycle ${i}`)
  }
  assert.equal(h.sent.length, 0)
})

test("terminal-monitors wake does not block landing once children drain", async () => {
  const h = harness()
  await h.commands.rollover.handler("on", h.ctx)
  h.wake(1, "terminal-monitors")
  h.wake(0, "senpi-task")
  await h.message(160_000)
  assert.equal(h.ext.st.state, "armed")
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.ok(h.lines().some((l) => l.ev === "handoff_requested"))
})

test("terminal-monitors: live senpi-task child still defers landing", async () => {
  const h = harness()
  await h.commands.rollover.handler("on", h.ctx)
  h.wake(1, "senpi-task")
  await h.message(160_000)
  assert.equal(h.ext.st.state, "armed")
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "armed")
  assert.equal(h.lines().some((l) => l.ev === "handoff_requested"), false)
})

test("terminal-monitors only (no child source reported) counts as unknown, not zero", async () => {
  const h = harness()
  await h.commands.rollover.handler("on", h.ctx)
  h.wake(1, "terminal-monitors")
  await h.message(160_000)
  assert.equal(h.ext.st.state, "armed")
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "armed")
  assert.equal(h.lines().some((l) => l.ev === "handoff_requested"), false)
})

test("wake sources unknown (no event yet) does not count as zero", async () => {
  const h = harness()
  await h.message(160_000)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "armed")
})

test("tokens null after compaction: falls back to message usage, no crash", async () => {
  const h = harness()
  h.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 200_000, percent: 0 })
  await h.message(20_000)
  assert.equal(h.ext.st.state, "watching")
  assert.equal(h.lines().at(-1).context, 20_000)
  h.ctx.getContextUsage = () => undefined
  await h.message(30_000)
  assert.equal(h.ext.st.context, 30_000)
})

test("reread ratio is off by default: tool-only turns never arm", async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) await h.message(96_000, { output: 62, cacheRead: 72_000, input: 100 })
  assert.equal(h.ext.st.state, "watching")
  assert.equal(h.ext.st.rereadStreak, 0)
  assert.equal(h.lines().at(-1).ratio, 1161.3, "ratio still logged for the dashboard")
})

test("reread ratio (opt-in via config) arms only after 3 consecutive messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollover-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ rereadRatioMax: 150 }))
  const h = harness({ dir })
  assert.equal(h.ext.config.rereadRatioMax, 150)
  const hot = { output: 100, cacheRead: 20_000, input: 100 }
  await h.message(21_000, hot)
  await h.message(21_000, hot)
  assert.equal(h.ext.st.state, "watching")
  await h.message(21_000, { output: 100, cacheRead: 100, input: 100 }) // streak reset
  await h.message(21_000, hot)
  await h.message(21_000, hot)
  assert.equal(h.ext.st.state, "watching")
  await h.message(21_000, hot)
  assert.equal(h.ext.st.state, "armed")
  assert.equal(h.ext.st.reason, "reread")
})

test("successor extraction, then /rollover dispatch and newSession", async () => {
  const branch = []
  const h = harness({ branch })
  await h.message(160_000)
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "wrote file.\n<successor>\nRead handoff-s1.md then continue step 4.\n</successor>" }] } })
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "rollover")
  assert.deepEqual(h.sent.at(-1), { text: "/rollover", opts: { expandPromptTemplates: true } })
  await h.commands.rollover.handler("now", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "Read handoff-s1.md then continue step 4.", session: "s2", opts: { expandPromptTemplates: true } })
  const roll = h.lines().find((l) => l.ev === "rollover")
  assert.deepEqual(roll, { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "rollover", newSession: "s2", parentSession: "C:/sess/s1.jsonl" })
  const summary = readFileSync(join(h.dir, "summary.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(summary.at(-1).reason, "rollover")
  assert.equal(summary.at(-1).peakContext, 160_000)
})

test("long single-agent run: handoff steered at first turn_end with wake 0, once; successor then /rollover", async () => {
  const branch = []
  const h = harness({ branch })
  h.wake(0)
  await h.message(50_000)
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "watching")
  assert.equal(h.sent.length, 0)
  await h.message(160_000) // budget passed mid-run, no children, run keeps going
  assert.equal(h.ext.st.state, "armed")
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /<successor>/)
  assert.deepEqual(h.sent[0].opts, { deliverAs: "steer" })
  await h.fire("turn_end") // run continues before the steer lands: no second injection
  await h.fire("turn_end")
  await h.fire("agent_settled") // settles without successor yet: re-ask path, still no duplicate handoff
  assert.equal(h.sent.filter((s) => /handoff-s1\.md/.test(s.text)).length, 1)
  assert.equal(h.lines().filter((l) => l.ev === "handoff_requested").length, 1)
  assert.equal(h.lines().find((l) => l.ev === "handoff_requested").at, "turn_end")
  assert.equal(h.lines().filter((l) => l.ev === "turn_end").length, 1, "turn_end logged only while armed")
  branch.push({ type: "message", message: { role: "assistant", content: "<successor>Read handoff-s1.md, continue.</successor>" } })
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "rollover")
  assert.deepEqual(h.sent.at(-1), { text: "/rollover", opts: { expandPromptTemplates: true } })
})

test("turn_end with children running does not land; agent_settled does once they drain", async () => {
  const h = harness()
  h.wake(2)
  await h.message(160_000)
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "armed")
  assert.equal(h.sent.length, 0)
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].opts, undefined)
  assert.equal(h.lines().find((l) => l.ev === "handoff_requested").at, "agent_settled")
})

test("missing successor tag: re-ask once, then notify and stay armed", async () => {
  const branch = [{ type: "message", message: { role: "assistant", content: "no tag here" } }]
  const h = harness({ branch })
  await h.message(160_000)
  h.wake(0)
  await h.fire("agent_settled")
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.match(h.sent.at(-1).text, /did not contain a <successor>/)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "armed")
  assert.equal(h.notes.at(-1).k, "error")
  assert.equal(h.lines().filter((l) => l.ev === "successor_missing").length, 2)
})

test("JSONL append shape and /rollover off", async () => {
  const h = harness()
  await h.fire("session_start")
  await h.message(10_000)
  h.wake(1, "omo-dag")
  h.wake(2, "senpi-task")
  await h.fire("agent_settled")
  const L = h.lines()
  assert.deepEqual(L.map((l) => l.ev), ["session_start", "message_end", "wake_source_state", "wake_source_state", "agent_settled"])
  for (const l of L) {
    assert.equal(l.t, "1970-01-01T00:00:00.000Z")
    assert.equal(l.session, "s1")
    assert.equal(l.cwd, "C:/work")
  }
  assert.deepEqual(L[1], { t: L[1].t, session: "s1", cwd: "C:/work", ev: "message_end", input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, context: 10_000, ratio: 18 })
  assert.equal(L[3].total, 3)
  assert.equal(L[4].total, 3)
  await h.commands.rollover.handler("off", h.ctx)
  await h.message(160_000)
  assert.equal(h.ext.st.state, "watching")
  assert.equal(await h.spawn(), undefined)
})

test("pure helpers", () => {
  assert.equal(extractSuccessor("x <successor>  hi </successor>"), "hi")
  assert.equal(extractSuccessor("<successor></successor>"), null)
  const entries = [
    { type: "message", message: { role: "user", content: "u" } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "a" }] } },
    { type: "message", message: { role: "user", content: "u2" } },
  ]
  assert.equal(lastAssistantText(entries), "a")
  assert.match(handoffPrompt("/w", "id", false), /update_goal/)
  assert.doesNotMatch(handoffPrompt("/w", "id", true), /update_goal/)
})

test("reload while armed: state restored from disk, not reset to watching", async () => {
  const h = harness()
  await h.fire("session_start")
  await h.message(160_000)
  await h.spawn()
  await h.fire("session_shutdown", { reason: "reload" })
  assert.equal(existsSync(join(h.dir, "summary.jsonl")), false, "reload skips the summary")
  const r = harness({ dir: h.dir })
  assert.equal(r.ext.st.state, "watching", "fresh instance before session_start")
  await r.fire("session_start")
  assert.equal(r.ext.st.state, "armed")
  assert.equal(r.ext.st.blocked, 1)
  assert.equal(r.ext.st.goalPaused, true)
  assert.equal(r.lines().at(-1).ev, "state_restored")
  assert.equal(r.lines().at(-1).state, "armed")
  assert.equal((await r.spawn()).block, true, "still blocking after reload")
})

test("reload between <successor> reply and agent_settled: session_start dispatches /rollover once", async () => {
  const branch = []
  const h = harness({ branch })
  await h.message(160_000)
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  branch.push({ type: "message", message: { role: "assistant", content: "<successor>Read handoff-s1.md, continue.</successor>" } })
  await h.fire("session_shutdown", { reason: "reload" })
  const r = harness({ dir: h.dir, branch })
  await r.fire("session_start") // wake sources unknown right after reload: successor kept, dispatch deferred
  assert.equal(r.ext.st.state, "handoff_requested")
  assert.deepEqual(r.lines().at(-1), { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "rollover_deferred", total: null, wake: {} })
  r.wake(0)
  await r.fire("agent_settled")
  assert.equal(r.ext.st.state, "rollover")
  assert.deepEqual(r.sent, [{ text: "/rollover", opts: { expandPromptTemplates: true } }])
  await r.fire("agent_settled") // no second dispatch
  assert.equal(r.sent.length, 1)
  await r.commands.rollover.handler("now", r.ctx)
  assert.equal(r.sent.at(-1).session, "s2")
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8")).state, "rolled_over")
  const again = harness({ dir: h.dir, branch }) // --resume of a rolled-over session starts fresh
  await again.fire("session_start")
  assert.equal(again.ext.st.state, "watching")
})

test("state file: shape, written atomically, no leftover tmp", async () => {
  const h = harness()
  await h.message(160_000)
  assert.deepEqual(readdirSync(join(h.dir, "state")), ["s1.json"])
  const saved = JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8"))
  assert.deepEqual(saved, {
    state: "armed", mode: "auto", blocked: 0, rereadStreak: 0, goalPaused: true, rollovers: 0,
    armedAt: "1970-01-01T00:00:00.000Z", handoffAskedCount: 0, peak: 160_000, messages: 1, cacheRead: 159_000, output: 500,
    startedAt: "1970-01-01T00:00:00.000Z", activeSkill: null, budgetOverride: null, updatedAt: "1970-01-01T00:00:00.000Z",
  })
  assert.equal("context" in saved, false)
  await h.commands.rollover.handler("off", h.ctx)
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8")).mode, "off")
  assert.deepEqual(readdirSync(join(h.dir, "state")), ["s1.json"])
})

test("summary counters survive a reload and land in the summary row", async () => {
  const h = harness()
  await h.fire("session_start")
  await h.message(100_000)
  await h.message(187_000)
  await h.fire("session_shutdown", { reason: "reload" })
  const r = harness({ dir: h.dir })
  await r.fire("session_start")
  assert.equal(r.ext.st.peak, 187_000)
  assert.equal(r.ext.st.messages, 2)
  await r.message(120_000)
  await r.fire("session_shutdown", { reason: "quit" })
  const row = readFileSync(join(h.dir, "summary.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1)
  assert.equal(row.peakContext, 187_000)
  assert.equal(row.messages, 3)
  assert.equal(row.cacheRead, 99_000 + 186_000 + 119_000)
  assert.equal(row.output, 1500)
  assert.equal(row.startedAt, "1970-01-01T00:00:00.000Z")
})

test("armed notify names the trigger and the budget", async () => {
  const h = harness()
  await h.message(160_000)
  assert.equal(h.notes.at(-1).m, "rollover: armed (budget 150000 reached, context=160000). task/task_create blocked; handing off once children drain.")
})

test("spawn block: `task` blocked while armed, task_output allowed", async () => {
  const h = harness()
  await h.message(160_000)
  assert.equal((await h.fire("tool_call", { toolName: "task", input: {} })).block, true)
  assert.equal(await h.fire("tool_call", { toolName: "task_output", input: {} }), undefined)
  assert.equal(await h.fire("tool_call", { toolName: "task_send", input: {} }), undefined)
  assert.equal(h.ext.st.blocked, 1)
  assert.equal(h.lines().at(-1).tool, "task")
})

test("successor found while a child is live: rollover_deferred, /rollover dispatched once after drain", async () => {
  const branch = []
  const h = harness({ branch })
  await h.message(160_000)
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  branch.push({ type: "message", message: { role: "assistant", content: "<successor>Read handoff-s1.md, continue.</successor>" } })
  h.wake(1) // model spawned via `task` before the block existed, or a child restarted
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "handoff_requested")
  assert.deepEqual(h.lines().at(-1), { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "rollover_deferred", total: 1, wake: { "senpi-task": 1 } })
  assert.equal(h.sent.filter((s) => s.text === "/rollover").length, 0)
  assert.equal(h.sent.filter((s) => /did not contain/.test(s.text)).length, 0, "no re-ask")
  await h.fire("turn_end")
  assert.equal(h.ext.st.state, "handoff_requested")
  h.wake(0)
  await h.fire("agent_settled")
  assert.equal(h.ext.st.state, "rollover")
  assert.equal(h.sent.filter((s) => s.text === "/rollover").length, 1)
  await h.fire("agent_settled")
  assert.equal(h.sent.filter((s) => s.text === "/rollover").length, 1)
})

test("/rollover refuses while children run; /rollover force proceeds", async () => {
  const branch = [{ type: "message", message: { role: "assistant", content: "<successor>go</successor>" } }]
  const h = harness({ branch })
  h.wake(1)
  await h.commands.rollover.handler("now", h.ctx)
  assert.equal(h.notes.at(-1).k, "error")
  assert.match(h.notes.at(-1).m, /refused.*wake total=1/)
  assert.equal(h.lines().at(-1).ev, "rollover_refused")
  assert.equal(h.sent.length, 0)
  await h.commands.rollover.handler("now force", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "go", session: "s2", opts: { expandPromptTemplates: true } })
  assert.equal(h.ext.st.state, "rolled_over")
})

test("bare /rollover and help print help; now performs the handoff", async () => {
  for (const arg of ["", "help"]) {
    const h = harness()
    await h.commands.rollover.handler(arg, h.ctx)
    assert.match(h.notes.at(-1).m, /now \[force\]/)
    assert.equal(h.sent.some((s) => s.session === "s2"), false, "no newSession")
    assert.equal(h.sent.some((s) => s.text === "/rollover"), false)
  }
  const branch = [{ type: "message", message: { role: "assistant", content: "<successor>go</successor>" } }]
  const h = harness({ branch })
  await h.commands.rollover.handler("now", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "go", session: "s2", opts: { expandPromptTemplates: true } })
  assert.equal(h.ext.st.state, "rolled_over")
})

test("/rollover now refuses while children run; now force proceeds", async () => {
  const branch = [{ type: "message", message: { role: "assistant", content: "<successor>go</successor>" } }]
  const h = harness({ branch })
  h.wake(1)
  await h.commands.rollover.handler("now", h.ctx)
  assert.equal(h.notes.at(-1).k, "error")
  assert.equal(h.sent.length, 0)
  await h.commands.rollover.handler("now force", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "go", session: "s2", opts: { expandPromptTemplates: true } })
})

test("/rollover limit <K> overrides the budget for this session and persists", async () => {
  const h = harness()
  await h.commands.rollover.handler("limit 200", h.ctx)
  await h.message(160_000)
  assert.equal(h.ext.st.state, "watching")
  await h.message(200_000)
  assert.equal(h.ext.st.state, "armed")
  const r = harness({ dir: h.dir })
  await r.fire("session_start")
  assert.equal(r.ext.st.budgetOverride, 200_000)
})

test("/rollover limit <K> save writes config.json; invalid input is an error", async () => {
  const h = harness()
  await h.commands.rollover.handler("limit 200 save", h.ctx)
  assert.equal(JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")).budgetTokens, 200_000)
  await h.commands.rollover.handler("limit abc", h.ctx)
  assert.equal(h.notes.at(-1).k, "error")
  assert.equal(h.ext.st.budgetOverride, 200_000)
})

test("handoff instruction: no read, no command, no spawn, size caps, successor read list", () => {
  const p = handoffPrompt("/w", "id", true)
  assert.match(p, /Do NOT read any file, run any command, or spawn any task/)
  assert.match(p, /80 lines/)
  assert.match(p, /25 lines/)
  assert.match(p, /Goal \/ Done \/ In progress \/ Next step \/ Key files \/ Constraints/)
  assert.match(p, /tail -n 30 \.omo\/ulw-execute\/ledger\.jsonl/)
  assert.match(p, /NOT to read ulw-execute\/SKILL\.md, the full ledger, any prior-session JSONL, or any child transcript/)
  assert.match(p, /<successor>\.\.\.<\/successor>/)
  assert.match(p, /Do NOT kill any server/)
})

test("handoff fallback when direct pause failed: update_goal blocked (paused is not model-settable)", () => {
  assert.match(handoffPrompt("/w", "id", false), /`update_goal` tool with status "blocked" and reason "session rollover handoff in progress"/)
  assert.doesNotMatch(handoffPrompt("/w", "id", false), /status "paused"/)
  assert.doesNotMatch(handoffPrompt("/w", "id", true), /update_goal/)
})

test("goal_pause logged on arm: ok:true via injected pause, ok:false keeps the prompt fallback", async () => {
  const h = harness()
  await h.message(160_000)
  assert.deepEqual(h.lines().find((l) => l.ev === "goal_pause"), { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "goal_pause", ok: true, method: "fake" })
  const f = harness({ pause: async () => ({ ok: false, method: "none", error: "nope" }) })
  await f.message(160_000)
  assert.equal(f.lines().find((l) => l.ev === "goal_pause").error, "nope")
  assert.equal(f.ext.st.goalPaused, false)
  f.wake(0)
  await f.fire("agent_settled")
  assert.match(f.sent.at(-1).text, /update_goal.*"blocked"/)
})

test("pauseGoal: no main-entry exports and no senpi dist → ok:false with error", async () => {
  const r = await pauseGoal({}, { env: {}, argv1: "/nowhere/bin/omo.js", importMain: async () => ({ VERSION: "x" }) })
  assert.equal(r.ok, false)
  assert.equal(r.method, "none")
  assert.match(r.error, /main entry has no goal store exports.*no senpi dist found/)
  const r2 = await pauseGoal({}, { env: {}, argv1: undefined, importMain: async () => { throw new Error("Cannot find package") } })
  assert.match(r2.error, /main: Cannot find package/)
})

test("pauseGoal: dist derived from argv[1] (senpi dist/cli.js) pauses an active goal with source user", async () => {
  const root = mkdtempSync(join(tmpdir(), "senpi-"))
  const goal = join(root, "dist", "core", "extensions", "builtin", "goal")
  mkdirSync(goal, { recursive: true })
  writeFileSync(join(goal, "store.js"), `export const calls=[]; export async function readGoal(){return {status:"active"}}; export async function updateGoal(r,u,s){calls.push([r,u,s])}`)
  writeFileSync(join(goal, "store-ref.js"), `export function goalStoreRef(sm,cwd){return {baseDir:cwd,threadId:sm.getSessionId()}}`)
  const ctx = { cwd: "C:/work", sessionManager: { getSessionId: () => "s1" } }
  const r = await pauseGoal(ctx, { env: {}, argv1: join(root, "dist", "cli.js"), importMain: async () => ({}) })
  assert.deepEqual(r, { ok: true, method: "dist" })
  const { calls } = await import(pathToFileURL(join(goal, "store.js")).href)
  assert.deepEqual(calls, [[{ baseDir: "C:/work", threadId: "s1" }, { status: "paused" }, "user"]])
  // OMO_BIN route (<omo-ai>/bin/omo.js → <omo-ai>/node_modules/@code-yeongyu/senpi/dist)
  const omo = mkdtempSync(join(tmpdir(), "omo-"))
  const dist2 = join(omo, "node_modules", "@code-yeongyu", "senpi", "dist")
  mkdirSync(join(dist2, "core", "extensions", "builtin", "goal"), { recursive: true })
  writeFileSync(join(dist2, "core", "extensions", "builtin", "goal", "store.js"), `export async function readGoal(){return null}; export async function updateGoal(){throw new Error("should not update")}`)
  writeFileSync(join(dist2, "core", "extensions", "builtin", "goal", "store-ref.js"), `export function goalStoreRef(){return {}}`)
  assert.deepEqual(await pauseGoal(ctx, { env: { OMO_BIN: join(omo, "bin", "omo.js") }, argv1: "/nowhere/x.js", importMain: async () => ({}) }), { ok: true, method: "dist" })
})

test("before_agent_start appends the context-budget block in main sessions only, not when off", async () => {
  const h = harness()
  const r = await h.fire("before_agent_start", { systemPrompt: "BASE" })
  assert.equal(r.systemPrompt, "BASE\n\n" + CONTEXT_BUDGET_BLOCK)
  assert.ok(CONTEXT_BUDGET_BLOCK.split("\n").length <= 10)
  assert.match(CONTEXT_BUDGET_BLOCK, /persisted_only/)
  assert.match(CONTEXT_BUDGET_BLOCK, /prior-session JSONL/)
  await h.commands.rollover.handler("off", h.ctx)
  assert.equal(await h.fire("before_agent_start", { systemPrompt: "BASE" }), undefined)
  const c = harness({ env: { OMO_SENPI_TASK_RPC_CHILD: "1" } })
  assert.equal(c.handlers.before_agent_start, undefined)
})

const user = (text) => ({ type: "message", message: { role: "user", content: text } })
const KNOWN = new Set(["ulw-execute", "ulw-loop"])

test("active skill: detected from /skill:, $skill:, $name, /name, expanded block; unknown bare names ignored", () => {
  assert.deepEqual(detectActiveSkill([user("/skill:ulw-execute plan-a")], new Set(), "/nope"), { name: "ulw-execute", source: "message" })
  assert.deepEqual(detectActiveSkill([user("hi"), user("  $ulw-execute")], KNOWN, "/nope"), { name: "ulw-execute", source: "message" })
  assert.deepEqual(detectActiveSkill([user("$skill:ulw-loop go")], new Set(), "/nope"), { name: "ulw-loop", source: "message" })
  assert.deepEqual(detectActiveSkill([user("/ulw-execute stage11")], KNOWN, "/nope"), { name: "ulw-execute", source: "message" })
  const expanded = 'The user explicitly invoked the "ulw-execute" skill.\n\n<skill-instruction name="ulw-execute" location="x">\nbody\n</skill-instruction>'
  assert.deepEqual(detectActiveSkill([user(expanded)], new Set(), "/nope"), { name: "ulw-execute", source: "message" })
  assert.equal(detectActiveSkill([user("$HOME is set"), user("/rollover status"), user("/ulw-execute x")], new Set(), "/nope"), null, "bare forms need a known skill")
  assert.equal(detectActiveSkill([user("use $skill:ulw-loop inline")], new Set(), "/nope"), null, "only leading tokens count")
  assert.equal(detectActiveSkill([user("/skill:ulw-loop"), user("/skill:ulw-execute")], new Set(), "/nope").name, "ulw-loop", "earliest wins")
})

test("active skill: .omo/boulder.json with active_work_id means ulw-execute; message token wins over it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "boulder-"))
  mkdirSync(join(cwd, ".omo"))
  writeFileSync(join(cwd, ".omo", "boulder.json"), JSON.stringify({ schema_version: 2, active_work_id: "w1", works: {} }))
  assert.deepEqual(detectActiveSkill([user("hello")], KNOWN, cwd), { name: "ulw-execute", source: "boulder" })
  assert.deepEqual(detectActiveSkill([user("/skill:ulw-loop")], KNOWN, cwd), { name: "ulw-loop", source: "message" })
  writeFileSync(join(cwd, ".omo", "boulder.json"), JSON.stringify({ active_work_id: null }))
  assert.equal(detectActiveSkill([], KNOWN, cwd), null)
  const h = harness({ cwd: mkdtempSync(join(tmpdir(), "boulder-")) })
  mkdirSync(join(h.ctx.cwd, ".omo"))
  writeFileSync(join(h.ctx.cwd, ".omo", "boulder.json"), JSON.stringify({ active_work_id: "w2" }))
  return h.message(160_000).then(() => {
    assert.equal(h.ext.st.activeSkill, "ulw-execute")
    assert.equal(h.lines().find((l) => l.ev === "active_skill").source, "boulder")
  })
})

test("arm records activeSkill (persisted, logged), handoff prompt demands the $skill: line, kickoff expands templates", async () => {
  const branch = [user("/skill:ulw-execute stage11"), user("more")]
  const h = harness({ branch })
  await h.message(160_000)
  assert.equal(h.ext.st.activeSkill, "ulw-execute")
  assert.deepEqual(h.lines().find((l) => l.ev === "active_skill"), { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "active_skill", name: "ulw-execute", source: "message" })
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8")).activeSkill, "ulw-execute")
  h.wake(0)
  await h.fire("agent_settled")
  const ask = h.sent.at(-1).text
  assert.match(ask, /<successor> block must START with the line `\$skill:ulw-execute`/)
  assert.ok(ask.indexOf("START with the line") < ask.indexOf("The successor starts with an empty context"))
  branch.push({ type: "message", message: { role: "assistant", content: "<successor>\n$skill:ulw-execute\nRead handoff-s1.md, continue.\n</successor>" } })
  await h.fire("agent_settled")
  await h.commands.rollover.handler("now", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "$skill:ulw-execute\nRead handoff-s1.md, continue.", session: "s2", opts: { expandPromptTemplates: true } })
})

test("kickoff: token prepended when the successor lacks it; none when no active skill", async () => {
  const reply = { type: "message", message: { role: "assistant", content: "<successor>Read handoff-s1.md, continue.</successor>" } }
  const h = harness({ branch: [user("$ulw-execute"), reply] })
  await h.message(160_000)
  assert.equal(h.ext.st.activeSkill, "ulw-execute")
  h.wake(0)
  await h.commands.rollover.handler("now", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "$skill:ulw-execute\nRead handoff-s1.md, continue.", session: "s2", opts: { expandPromptTemplates: true } })
  const n = harness({ branch: [user("fix the bug"), reply] })
  await n.message(160_000)
  assert.equal(n.ext.st.activeSkill, null)
  assert.equal(n.lines().some((l) => l.ev === "active_skill"), false)
  n.wake(0)
  await n.fire("agent_settled")
  assert.doesNotMatch(n.sent.at(-1).text, /\$skill:/)
  await n.commands.rollover.handler("now", n.ctx)
  assert.deepEqual(n.sent.at(-1), { text: "Read handoff-s1.md, continue.", session: "s2", opts: { expandPromptTemplates: true } })
  assert.equal(withSkillToken("/skill:ulw-execute go", "ulw-execute"), "/skill:ulw-execute go", "any leading invocation form is accepted")
  assert.equal(withSkillToken("$ulw-executed go", "ulw-execute"), "$skill:ulw-execute\n$ulw-executed go")
})

test("active skill restored across reload while armed", async () => {
  const h = harness({ branch: [user("/ulw-execute stage11")] })
  await h.fire("session_start")
  await h.message(160_000)
  await h.fire("session_shutdown", { reason: "reload" })
  const r = harness({ dir: h.dir })
  await r.fire("session_start")
  assert.equal(r.ext.st.activeSkill, "ulw-execute")
})
