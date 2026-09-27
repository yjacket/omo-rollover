// Todo 21b: restore-decomposition and policy-effect send every big-context request as a resumed
// session whose context P sits in a system prompt file (task-20 follow-up capture, form f2r):
//   ctx_create  = base argv + --append-system-prompt-file <ctx>/P-<seed>.txt --session-id <P>, stdin NULLP
//   later calls = base argv + the same file + --resume <P>, stdin = the step's own text
// The argv and stdin are read back from the spawned fake, not from a builder.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"

import { createClaudeCliAdapter } from "../scripts/idle-live/adapters/claude-cli.mjs"
import { protocols, makeTask, NULLP, RULES, BIG_CONTEXT_MODE, contextFileOf } from "../scripts/idle-live/protocols.mjs"

const MODEL = "claude-fable-5-1"
const sha = (x) => createHash("sha256").update(x).digest("hex")
const approval = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-proposal.json", import.meta.url), "utf8"))
const BASE = ["-p", "--model", MODEL, "--output-format", "json", "--safe-mode", "--strict-mcp-config",
  "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk", "--effort", "low", "--max-turns", "1", "--fallback-model", MODEL]
const FLAG = "--append-system-prompt-file"

// ------------------------------------------------------------------ fakes

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdinChunks = []
  child.stdin = new Writable({
    write(chunk, enc, cb) { child.stdinChunks.push(Buffer.from(chunk)); cb() },
    final(cb) {
      cb()
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: "result", result: "OK", usage: { input_tokens: 1 } }))
        child.stderr.end("")
        child.emit("close", 0, null)
      })
    },
  })
  child.kill = () => true
  return child
}
function fakeSpawn() {
  const calls = []
  const spawn = (cmd, args, options) => {
    const child = fakeChild()
    calls.push({ cmd, args, options, child, stdin: () => Buffer.concat(child.stdinChunks).toString("utf8") })
    return child
  }
  spawn.calls = calls
  return spawn
}

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "idle-sysfile-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, ctxDir: path.join(dir, "ctx") }
}
const adapterIn = ({ dir, ctxDir }, spawn) => createClaudeCliAdapter({ cli: "C:/fake/claude.exe", model: MODEL, spawn, workDir: dir, labelFile: path.join(dir, "label.txt"), contextDir: ctxDir })
const env = (step) => ({ stepHeader: step.id, baseUrl: "http://127.0.0.1:1" })

// Minimal scripted responses: every big-context call hits, the gate passes unless told otherwise.
const usage = ({ w1 = 0, rd = 3437, out = 4 } = {}) => ({ input_tokens: 2, cache_creation_input_tokens: w1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 }, cache_read_input_tokens: rd, output_tokens: out })
function responder(tasks, { gatePass = true } = {}) {
  return (step) => {
    const task = tasks[(step.unit?.index ?? 1) - 1]
    const g = task.guardAnswer
    const text = {
      park_parent: `Handoff for ticket ${task.ticket}: record ${g.id} at ${g.site} on ${g.date}, threshold ${g.threshold}.`,
      r1: `ticket ${task.ticket}\nrecord ${g.id}`, r2: "Nothing missing.", guard: `${g.id}, ${g.site}, ${g.threshold}`, resume_raw: `${g.id}, ${g.site}, ${g.threshold}`,
    }[step.role] ?? (step.role === "work" ? "none" : "OK")
    const u = step.role === "ctx_create" ? usage({ w1: 142620 })
      : step.role === "gate" ? (gatePass ? usage({ rd: 145655, w1: 200 }) : usage({ rd: 3035, w1: 143423 }))
      : step.role === "park_parent" ? usage({ rd: 145700, w1: 300, out: 1200 })
      : usage({ rd: 145700, w1: 300, out: 30 })
    return { record: { ts_req: 0, ts: 1, model: MODEL, stop_reason: "end_turn", usage: u, text, headers: { "anthropic-ratelimit-unified-status": "allowed" } }, anomalies: [], ticks: { "unified-5h": 0 }, late: false, meters: {} }
  }
}
function fakeCtx(experiment, { resumeHit = null, dialPrefix = null, run = 1 } = {}) {
  let uuids = 0
  let seeds = 0
  const ctx = { experiment, approval, random: { uuid: () => `uuid-${++uuids}`, seed: () => 1000 + ++seeds }, mode: { resumeHit }, dialPrefix, now: () => ctx.clock, priors: null, run, phase: null, clock: 0 }
  return ctx
}
async function drive(ctx, respond) {
  const gen = protocols[ctx.experiment](ctx)
  const steps = []
  let next = await gen.next()
  while (!next.done) {
    steps.push(next.value)
    if (steps.length > 500) throw new Error("runaway generator")
    ctx.clock = Math.max(ctx.clock, next.value.atOffsetMs) + 4000
    next = await gen.next(respond(next.value))
  }
  return { steps, result: next.value }
}
// Replays every protocol step through the real adapter; returns what was spawned.
async function spawnAll(t, steps) {
  const where = scratch(t)
  const spawn = fakeSpawn()
  const adapter = adapterIn(where, spawn)
  const seen = []
  for (const step of steps) {
    const before = spawn.calls.length
    await adapter.invoke(step, env(step))
    assert.equal(spawn.calls.length, before + 1, `${step.id} spawned once`)
    const call = spawn.calls.at(-1)
    seen.push({ step, args: call.args, stdin: call.stdin() })
  }
  return { ...where, seen }
}
const P_OF = (task) => task.ctxPrompt.text.slice(0, -("\n\n" + NULLP).length)

// ------------------------------------------------------------------ tests

test("restore-decomposition: ctx_create and every later big-context call spawn the resume-sysfile argv/stdin with one P file", async (t) => {
  const task = makeTask(1001)
  const ctx = fakeCtx("restore-decomposition")
  const { steps, result } = await drive(ctx, responder([task]))
  assert.equal(result.status, "valid")
  assert.equal(result.mode, BIG_CONTEXT_MODE)
  const { ctxDir, seen } = await spawnAll(t, steps)
  const file = path.join(ctxDir, "P-1001.txt")
  const bytes = readFileSync(file)
  assert.equal(bytes.toString("utf8"), P_OF(task), "the file holds the brief + log without the NULLP suffix")
  assert.notEqual(bytes[0], 0xef, "no BOM")
  const pSha = sha(bytes)
  assert.deepEqual(contextFileOf(task), { file: "P-1001.txt", sha256: pSha, bytes: bytes.length, text: P_OF(task) })

  const byRole = (role, arm) => seen.filter((x) => x.step.role === role && (!arm || x.step.arm === arm))
  const [create] = byRole("ctx_create")
  assert.deepEqual(create.args, [...BASE, FLAG, file, "--session-id", "uuid-1"])
  assert.equal(create.stdin, NULLP)
  const big = [...byRole("gate"), ...byRole("park_parent"), ...byRole("resume_raw"), ...byRole("work", "raw_path")]
  assert.equal(big.length, 1 + 1 + 1 + RULES.restore.workSteps)
  for (const x of big) {
    assert.deepEqual(x.args, [...BASE, FLAG, file, "--resume", "uuid-1"], x.step.id)
    assert.equal(x.step.systemPrompt.sha256, pSha, `${x.step.id} carries the same P sha`)
  }
  assert.equal(byRole("gate")[0].stdin, NULLP)
  assert.equal(byRole("park_parent")[0].stdin, task.parkPrompt)
  assert.equal(byRole("resume_raw")[0].stdin, task.guardPromptRaw.text)
  for (const x of byRole("work", "raw_path")) assert.equal(x.stdin, task.workSteps[x.step.k - 1].prompt.text)
  // restore_child and its work stay on the child session, without P
  for (const x of [...byRole("r1"), ...byRole("r2"), ...byRole("guard"), ...byRole("work", "park_path")]) {
    assert.ok(!x.args.includes(FLAG), x.step.id)
    assert.deepEqual(x.args.slice(-2), [x.step.role === "r1" ? "--session-id" : "--resume", "uuid-2"])
  }
  assert.deepEqual(byRole("end_ping")[0].args, [...BASE, "--no-session-persistence"])
  // the context write is still priced as the whole context
  assert.equal(steps[0].prompt.tokensEst, task.ctxPrompt.tokensEst)
  assert.equal(steps[0].prompt.fillerLines, RULES.restore.lines)
})

test("policy-effect: warm pings, park, raw and work run on each pair's own P file (sha keyed per seed)", async (t) => {
  const tasks = [1001, 1002, 1003].map((s) => makeTask(s, { steps: RULES.policy.workSteps }))
  const ctx = fakeCtx("policy-effect", { resumeHit: true })
  const { steps, result } = await drive(ctx, responder(tasks))
  assert.equal(result.status, "valid")
  assert.equal(result.mode, BIG_CONTEXT_MODE)
  const { ctxDir, seen } = await spawnAll(t, steps)
  const shas = new Set()
  for (let i = 1; i <= 3; i++) {
    const file = path.join(ctxDir, `P-${1000 + i}.txt`)
    const pair = seen.filter((x) => x.step.unit.index === i)
    const parent = pair[0].step.session.id
    assert.deepEqual(pair[0].args, [...BASE, FLAG, file, "--session-id", parent])
    const warm = pair.filter((x) => x.step.role === "warm")
    assert.equal(warm.length, RULES.policy.warmPings)
    for (const x of [...warm, ...pair.filter((y) => ["park_parent", "resume_raw"].includes(y.step.role)), ...pair.filter((y) => y.step.arm === "current_policy" && y.step.role === "work")]) {
      assert.deepEqual(x.args, [...BASE, FLAG, file, "--resume", parent], x.step.id)
    }
    for (const x of warm) assert.equal(x.stdin, NULLP)
    shas.add(sha(readFileSync(file)))
  }
  assert.equal(shas.size, 3, "three seeds, three distinct P files")
})

test("the dial prefix replays ctx_create's shape: ephemeral, same P file, stdin NULLP", async (t) => {
  const task = makeTask(1001)
  const restore = await drive(fakeCtx("restore-decomposition"), responder([task]))
  const dp = restore.result.dialPrefix
  assert.equal(dp.sessionId, "uuid-1")
  assert.equal(dp.prompt.text, NULLP)
  assert.equal(dp.systemPrompt.sha256, contextFileOf(task).sha256)
  const ctx = fakeCtx("fable-write-tick", { dialPrefix: dp })
  const gen = protocols["fable-write-tick"](ctx)
  const first = (await gen.next()).value
  assert.equal(first.kind, "dial")
  const { ctxDir, seen } = await spawnAll(t, [restore.steps[0], first])
  assert.deepEqual(seen[1].args, [...BASE, FLAG, path.join(ctxDir, "P-1001.txt"), "--no-session-persistence"])
  assert.equal(seen[1].stdin, NULLP)
})

test("gate FAIL closes the run resume_gate_miss after ctx_create + gate; a known miss issues nothing", async () => {
  const task = makeTask(1001)
  const ctx = fakeCtx("restore-decomposition")
  const { steps, result } = await drive(ctx, responder([task], { gatePass: false }))
  assert.deepEqual(steps.map((s) => s.role), ["ctx_create", "gate"])
  assert.equal(result.status, "aborted")
  assert.equal(result.reason, "resume_gate_miss")
  assert.equal(result.gate.pass, false)
  assert.equal(ctx.mode.resumeHit, false)

  const policy = fakeCtx("policy-effect")
  const p = await drive(policy, responder([1001, 1002, 1003].map((s) => makeTask(s, { steps: 8 })), { gatePass: false }))
  assert.deepEqual(p.steps.map((s) => s.role), ["ctx_create", "gate"])
  assert.equal(p.result.reason, "resume_gate_miss")

  for (const id of ["restore-decomposition", "policy-effect"]) {
    const known = await drive(fakeCtx(id, { resumeHit: false }), () => { throw new Error("no step may be issued") })
    assert.equal(known.steps.length, 0, id)
    assert.equal(known.result.status, "aborted")
    assert.equal(known.result.reason, "fallback_mode_misses")
  }
})

test("P file checks before spawn: a restarted adapter verifies the file; missing, tampered or stale files spawn nothing", async (t) => {
  const task = makeTask(1001)
  const { steps } = await drive(fakeCtx("restore-decomposition"), responder([task]))
  const create = steps[0]
  const gate = steps.find((s) => s.role === "gate")
  const where = scratch(t)
  const spawn = fakeSpawn()
  await adapterIn(where, spawn).invoke(create, env(create))
  const file = path.join(where.ctxDir, "P-1001.txt")

  // cancel_resume: a new process (new adapter) resumes on the file the first one wrote
  const spawn2 = fakeSpawn()
  await adapterIn(where, spawn2).invoke(gate, env(gate))
  assert.deepEqual(spawn2.calls[0].args, [...BASE, FLAG, file, "--resume", "uuid-1"])

  const refused = async (step, code) => {
    const s = fakeSpawn()
    await assert.rejects(adapterIn(where, s).invoke(step, env(step)), (e) => e.code === code)
    assert.equal(s.calls.length, 0, `${code}: nothing spawned`)
  }
  const good = readFileSync(file)
  writeFileSync(file, Buffer.concat([good.subarray(0, good.length - 1), Buffer.from("X")]))
  await refused(gate, "system_prompt_mismatch")
  // a stale file of the same name is never overwritten by ctx_create
  await refused(create, "system_prompt_mismatch")
  assert.notEqual(sha(readFileSync(file)), create.systemPrompt.sha256)
  rmSync(file)
  await refused(gate, "system_prompt_missing")
  assert.equal(existsSync(file), false)
})
