// Fake `pi` harness for ulw-ledger-guard: no senpi, no LLM. Run: node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLedgerGuard, digestLedger, isLedgerPath, DIGEST_CAP, BASH_CAP } from "../extension/ulw-ledger-guard.ts"

const ev = (task, event, i, extra = {}) => JSON.stringify({ event, plan: "p.md", task, session_id: `senpi:0000${i}`, commands: ["x".repeat(400)], ...extra })
function ledgerLines(n = 60) {
  const out = []
  for (let i = 0; i < n; i++) out.push(ev(`task-${i % 7}`, i % 2 ? "done-claim" : "task-dispatched", i, i % 5 === 0 ? { verdict: `V${i}` } : {}))
  return out
}

function harness({ env = {}, lines = ledgerLines(), dir = mkdtempSync(join(tmpdir(), "ledger-guard-")) } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"))
  const ledger = join(cwd, ".omo", "ulw-execute", "ledger.jsonl")
  mkdirSync(join(cwd, ".omo", "ulw-execute"), { recursive: true })
  writeFileSync(ledger, lines.join("\n") + "\n")
  const handlers = {}, commands = {}, notes = []
  const pi = { on: (e, h) => (handlers[e] = h), registerCommand: (n, d) => (commands[n] = d), events: { on() {} } }
  const ctx = { cwd, ui: { notify: (m, k) => notes.push({ m, k }) }, sessionManager: { getSessionId: () => "s1", getCwd: () => cwd } }
  const ext = createLedgerGuard(pi, { env: { OMO_ROLLOVER_DIR: dir, ...env }, now: () => new Date(0) })
  const fire = (e, x = {}) => handlers[e]?.(x, ctx)
  const read = (path, input = {}) => fire("tool_result", { toolName: "read", input: { path, ...input }, content: [{ type: "text", text: "RAW FILE CONTENT" }], isError: false })
  const bash = (command, text) => fire("tool_result", { toolName: "bash", input: { command }, content: [{ type: "text", text }], isError: false })
  const log = () => (existsSync(join(dir, "sessions", "s1.jsonl")) ? readFileSync(join(dir, "sessions", "s1.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [])
  return { dir, cwd, ledger, ctx, ext, handlers, commands, notes, fire, read, bash, log, lines }
}

test("isLedgerPath: normalizes backslashes, ignores other files", () => {
  assert.ok(isLedgerPath("C:\\p\\.omo\\ulw-execute\\ledger.jsonl"))
  assert.ok(isLedgerPath(".omo/ulw-execute/ledger.jsonl"))
  assert.ok(!isLedgerPath("C:/p/.omo/ulw-execute/ledger.jsonl.bak"))
  assert.ok(!isLedgerPath("C:/p/ledger.jsonl"))
})

test("read of ledger (with offset/limit) → digest with per-task latest events and raw tail; logged; notified once", async () => {
  const h = harness()
  const r = await h.read(".omo\\ulw-execute\\ledger.jsonl", { offset: 100, limit: 50 })
  const text = r.content[0].text
  assert.match(text, /^\[ulw-ledger-guard\] .*ledger\.jsonl: 60 events, \d+ bytes\. Digest by ulw-ledger-guard/)
  assert.doesNotMatch(text, /RAW FILE CONTENT/)
  // 7 distinct tasks; latest for task-3 is line 60 (i=59, done-claim), task-2 is line 59 (i=58, task-dispatched)
  assert.match(text, /latest event per task \(7 of 7/)
  assert.match(text, /#60  done-claim  task:task-3  session=…i:000059/)
  assert.match(text, /#59  task-dispatched  task:task-2/)
  // ordering by last activity: task-3 row before task-2 row
  assert.ok(text.indexOf("task:task-3") < text.indexOf("task:task-2"))
  // verdict one-liner: task-6 latest is i=55, verdict V55; task-1 latest (i=57) has none
  assert.match(text, /task:task-6.*verdict=V55/)
  assert.doesNotMatch(text, /task:task-1.*verdict/)
  // raw last 20 lines verbatim
  assert.match(text, /--- last 20 lines \(raw\) ---/)
  for (const l of h.lines.slice(-20)) assert.ok(text.includes(l), "raw tail line present")
  assert.ok(!text.includes(h.lines[0]), "old lines not in digest")
  assert.ok(Buffer.byteLength(text) <= DIGEST_CAP + 64)
  // log + notify
  const L = h.log()
  assert.equal(L.length, 1)
  assert.equal(L[0].ev, "ledger_read_shaped")
  assert.equal(L[0].tool, "read")
  assert.equal(L[0].bytesIn, Buffer.byteLength("RAW FILE CONTENT"))
  assert.equal(L[0].bytesOut, Buffer.byteLength(text))
  assert.match(L[0].path, /ledger\.jsonl$/)
  assert.equal(h.notes.length, 1)
  await h.read(h.ledger)
  assert.equal(h.notes.length, 1, "notify once per session")
  assert.equal(h.log().length, 2)
})

test("events without task are keyed per event; malformed lines counted", () => {
  const lines = [ev("a", "task-dispatched", 1), "{not json", JSON.stringify({ event: "phase-completed", session_id: "x" }), "", JSON.stringify({ event: "phase-completed", session_id: "y" })]
  const d = digestLedger(lines.join("\n"), "f")
  assert.equal(d.events, 4)
  assert.equal(d.malformed, 1)
  assert.match(d.digest, /4 events, \d+ bytes, 1 malformed line\(s\)/)
  assert.match(d.digest, /#4  phase-completed  event:phase-completed/)
  assert.doesNotMatch(d.digest, /#3  phase-completed/)
})

test("size cap: many tasks with 2 KB events → at most 40 tasks, whole digest ≤ 12 KB", () => {
  const lines = []
  for (let i = 0; i < 120; i++) lines.push(ev(`t-${i}`, "task-dispatched", i, { big: "y".repeat(2000) }))
  const d = digestLedger(lines.join("\n"), "f")
  assert.ok(Buffer.byteLength(d.digest) <= DIGEST_CAP + 64, `size ${Buffer.byteLength(d.digest)}`)
  assert.match(d.digest, /\(40 of 120, most recent first\)/)
  assert.match(d.digest, /#120  task-dispatched  task:t-119/)
})

test("read of an unrelated file is untouched", async () => {
  const h = harness()
  assert.equal(await h.read("C:/p/src/index.ts"), undefined)
  assert.equal(await h.read(join(h.cwd, ".omo", "ulw-execute", "ledger.jsonl.bak")), undefined)
  assert.equal(h.log().length, 0)
})

test("bash output referencing ledger.jsonl: over 8 KB → tail-shaped, under 8 KB untouched, unrelated command untouched", async () => {
  const h = harness()
  const big = Array.from({ length: 300 }, (_, i) => `line ${i} ${"z".repeat(40)}`).join("\n")
  assert.ok(Buffer.byteLength(big) > BASH_CAP)
  const r = await h.bash("cat .omo/ulw-execute/ledger.jsonl", big)
  const text = r.content[0].text
  assert.match(text, /^\[ulw-ledger-guard\] output was \d+ bytes; showing the tail only/)
  assert.ok(text.includes("line 299 "))
  assert.ok(!text.includes("line 0 "))
  assert.ok(Buffer.byteLength(text) <= BASH_CAP + 200)
  assert.equal(await h.bash("tail -n 30 .omo/ulw-execute/ledger.jsonl", "small"), undefined)
  assert.equal(await h.bash("cat other.log", big), undefined)
  assert.deepEqual(h.log().map((l) => l.tool), ["bash"])
})

test("/ledger-guard off disables shaping and persists; on re-enables; status notifies", async () => {
  const h = harness()
  await h.commands["ledger-guard"].handler("off", h.ctx)
  assert.equal(await h.read(h.ledger), undefined)
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8")).ledgerGuard, "off")
  await h.commands["ledger-guard"].handler("status", h.ctx)
  assert.match(h.notes.at(-1).m, /mode=off shaped=0/)
  await h.commands["ledger-guard"].handler("on", h.ctx)
  assert.ok(await h.read(h.ledger))
})

test("state file coexists with rollover fields; mode restored on session_start", async () => {
  const h = harness()
  mkdirSync(join(h.dir, "state"), { recursive: true })
  writeFileSync(join(h.dir, "state", "s1.json"), JSON.stringify({ state: "armed", mode: "auto", blocked: 2, activeSkill: "ulw-execute" }))
  await h.commands["ledger-guard"].handler("off", h.ctx)
  const saved = JSON.parse(readFileSync(join(h.dir, "state", "s1.json"), "utf8"))
  assert.deepEqual(saved, { state: "armed", mode: "auto", blocked: 2, activeSkill: "ulw-execute", ledgerGuard: "off" })
  const h2 = harness({ dir: h.dir })
  assert.equal(h2.ext.st.mode, "on")
  await h2.fire("session_start")
  assert.equal(h2.ext.st.mode, "off")
})

test("child session is inert", () => {
  const h = harness({ env: { OMO_SENPI_TASK_RPC_CHILD: "1" } })
  assert.equal(h.ext, null)
  assert.deepEqual(Object.keys(h.handlers), [])
  assert.deepEqual(Object.keys(h.commands), [])
  const h2 = harness({ env: { SENPI_TASK_MEMBER_TASK_ID: "t1" } })
  assert.equal(h2.ext, null)
})
