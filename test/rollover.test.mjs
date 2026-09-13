// Fake `pi` harness: no senpi, no LLM. Run: node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRollover, extractSuccessor, lastAssistantText, handoffPrompt } from "../extension/rollover.ts"

function harness({ env = {}, branch = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rollover-"))
  const handlers = {}, bus = {}, sent = [], commands = {}, notes = []
  const pi = {
    on: (ev, h) => (handlers[ev] = h),
    events: { on: (ev, h) => (bus[ev] = h) },
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
    registerCommand: (name, def) => (commands[name] = def),
  }
  let tokens = 0
  const ctx = {
    cwd: "C:/work",
    ui: { notify: (m, k) => notes.push({ m, k }) },
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 0 }),
    hasPendingMessages: () => false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => "C:/sess/s1.jsonl", getCwd: () => "C:/work", getBranch: () => branch, getHeader: () => ({}) },
    newSession: async ({ withSession }) => {
      await withSession({ sessionManager: { getSessionId: () => "s2" }, sendUserMessage: async (t) => sent.push({ text: t, session: "s2" }) })
      return { cancelled: false }
    },
  }
  const ext = createRollover(pi, { env: { OMO_ROLLOVER_DIR: dir, ...env }, now: () => new Date(0), pauseGoal: async () => true })
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

test("reread ratio arms only after 3 consecutive messages", async () => {
  const h = harness()
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
  await h.commands.rollover.handler("", h.ctx)
  assert.deepEqual(h.sent.at(-1), { text: "Read handoff-s1.md then continue step 4.", session: "s2" })
  const roll = h.lines().find((l) => l.ev === "rollover")
  assert.deepEqual(roll, { t: "1970-01-01T00:00:00.000Z", session: "s1", cwd: "C:/work", ev: "rollover", newSession: "s2", parentSession: "C:/sess/s1.jsonl" })
  const summary = readFileSync(join(h.dir, "summary.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(summary.at(-1).reason, "rollover")
  assert.equal(summary.at(-1).peakContext, 160_000)
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
  assert.deepEqual(L[1], { t: L[1].t, session: "s1", cwd: "C:/work", ev: "message_end", input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, context: 10_000 })
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
