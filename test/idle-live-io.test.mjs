import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { test } from "node:test"

import { createClaudeCliAdapter } from "../scripts/idle-live/adapters/claude-cli.mjs"
import { openLedger } from "../scripts/idle-live/ledger.mjs"
import { conflicting } from "../scripts/idle-live/processes.mjs"
import { startProxy } from "../scripts/idle-live/proxy.mjs"

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "idle-live-io-"))
const readJsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))

const RL_HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.12",
  "anthropic-ratelimit-unified-5h-reset": "1790000000",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.05",
  "anthropic-ratelimit-unified-status": "allowed",
  "request-id": "req_abc",
}

// Fake upstream: `handler(req, body, res)` decides the response. Never touches the network beyond loopback.
async function withUpstream(handler, fn) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => handler(req, Buffer.concat(chunks), res))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    return await fn({ host: "127.0.0.1", port: server.address().port, protocol: "http" })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withProxy(upstream, dir, fn, extra = {}) {
  const logPath = path.join(dir, "proxy.jsonl")
  const handle = await startProxy({ port: 0, logPath, runId: "run-1", labelFile: path.join(dir, "label.txt"), upstream, ...extra })
  try {
    return await fn(handle, logPath)
  } finally {
    await handle.close()
  }
}

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-ant-secret", cookie: "a=b", ...headers },
    body,
  })

test("proxy: JSON upstream response is logged with label from x-idle-step, usage, verbatim headers, no secrets", async () => {
  const dir = tmpDir()
  try {
    let seenAuth = null
    let seenStep = null
    await withUpstream((req, body, res) => {
      seenAuth = req.headers.authorization
      seenStep = req.headers["x-idle-step"]
      assert.equal(body.toString(), '{"model":"claude-fable-5-1"}')
      res.writeHead(200, { "content-type": "application/json", ...RL_HEADERS })
      res.end(JSON.stringify({
        id: "msg_1", type: "message", model: "claude-fable-5-1", stop_reason: "end_turn",
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 3400, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
      }))
    }, (upstream) => withProxy(upstream, dir, async (handle, logPath) => {
      const health = await fetch(`http://127.0.0.1:${handle.port}/__health`)
      assert.deepEqual(await health.json(), { runId: "run-1", logPath })

      const r = await post(handle.port, '{"model":"claude-fable-5-1"}', { "x-idle-step": "t/a/0" })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get("anthropic-ratelimit-unified-5h-utilization"), "0.12")
      const j = await r.json()
      assert.equal(j.id, "msg_1")
      // upstream got the auth header forwarded (passthrough) and the step header
      assert.equal(seenAuth, "Bearer sk-ant-secret")
      assert.equal(seenStep, "t/a/0")

      const { records, cursor } = await handle.drainSince(0)
      assert.equal(records.length, 1)
      assert.equal(cursor, 1)
      const rec = records[0]
      assert.equal(rec.label, "t/a/0")
      assert.equal(rec.stepId, "t/a/0")
      assert.equal(rec.runId, "run-1")
      assert.equal(rec.method, "POST")
      assert.equal(rec.path, "/v1/messages")
      assert.equal(rec.status, 200)
      assert.equal(rec.model, "claude-fable-5-1")
      assert.equal(rec.stop_reason, "end_turn")
      assert.equal(rec.msg_id, "msg_1")
      assert.equal(rec.error, null)
      assert.deepEqual(rec.usage, { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 3400, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })
      assert.deepEqual(rec.headers, RL_HEADERS)
      assert.equal(typeof rec.body_bytes, "number")
      assert.ok(rec.ts_req <= rec.ts)
      const raw = readFileSync(logPath, "utf8")
      assert.deepEqual(readJsonl(logPath), records)
      assert.ok(!/authorization|sk-ant|cookie/i.test(raw), "no secrets in log")
      assert.ok(!raw.includes('"model":"claude-fable-5-1"}'), "no request body in log")

      const again = await handle.drainSince(cursor)
      assert.deepEqual(again, { records: [], cursor: 1 })
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proxy: SSE usage is merged from message_start and message_delta; label falls back to label file", async () => {
  const dir = tmpDir()
  try {
    writeFileSync(path.join(dir, "label.txt"), "fallback/x/1\n")
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-fable-5-1","usage":{"input_tokens":20,"cache_creation_input_tokens":59400,"cache_read_input_tokens":0,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":59400}}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    await withUpstream((req, body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", ...RL_HEADERS })
      for (const chunk of sse) res.write(chunk)
      res.end()
    }, (upstream) => withProxy(upstream, dir, async (handle) => {
      const r = await post(handle.port, "{}")
      assert.equal(await r.text(), sse.join(""))
      const { records } = await handle.drainSince(0)
      assert.equal(records.length, 1)
      const rec = records[0]
      assert.equal(rec.label, "fallback/x/1")
      assert.equal(rec.stepId, null)
      assert.equal(rec.model, "claude-fable-5-1")
      assert.equal(rec.msg_id, "msg_2")
      assert.equal(rec.stop_reason, "end_turn")
      assert.deepEqual(rec.usage, { input_tokens: 20, cache_creation_input_tokens: 59400, cache_read_input_tokens: 0, output_tokens: 42, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 59400 } })
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proxy: malformed upstream bodies (non-JSON, truncated SSE, error events) yield records with error set and the proxy keeps serving", async () => {
  const dir = tmpDir()
  try {
    let mode = "garbage"
    await withUpstream((req, body, res) => {
      if (mode === "garbage") {
        res.writeHead(200, { "content-type": "application/json", ...RL_HEADERS })
        res.end("<html>not json")
      } else if (mode === "truncated") {
        res.writeHead(200, { "content-type": "text/event-stream", ...RL_HEADERS })
        res.write('data: {"type":"message_start","message":{"id":"msg_3","model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        res.write('data: {"type":"message_delta","usage":{"output_tok')
        res.end()
      } else if (mode === "apierror") {
        res.writeHead(529, { "content-type": "application/json", "request-id": "req_err" })
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }))
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "msg_ok", model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }))
      }
    }, (upstream) => withProxy(upstream, dir, async (handle) => {
      let r = await post(handle.port, "{}", { "x-idle-step": "e/a/0" })
      assert.equal(r.status, 200)
      await r.text()
      mode = "truncated"
      r = await post(handle.port, "{}", { "x-idle-step": "e/a/1" })
      await r.text()
      mode = "apierror"
      r = await post(handle.port, "{}", { "x-idle-step": "e/a/2" })
      assert.equal(r.status, 529)
      await r.text()
      mode = "ok"
      r = await post(handle.port, "{}", { "x-idle-step": "e/a/3" })
      assert.equal(r.status, 200)
      await r.text()

      const { records } = await handle.drainSince(0)
      assert.equal(records.length, 4)
      const byStep = Object.fromEntries(records.map((x) => [x.stepId, x]))
      assert.equal(byStep["e/a/0"].usage, null)
      assert.equal(byStep["e/a/0"].error, "unparseable_body")
      assert.equal(byStep["e/a/1"].error, "truncated_stream")
      assert.equal(byStep["e/a/1"].msg_id, "msg_3")
      assert.equal(byStep["e/a/2"].error, "overloaded_error")
      assert.equal(byStep["e/a/2"].status, 529)
      assert.deepEqual(byStep["e/a/2"].headers, { "request-id": "req_err" })
      assert.equal(byStep["e/a/3"].error, null)
      assert.deepEqual(byStep["e/a/3"].usage, { input_tokens: 1, output_tokens: 1 })
      // misleading_success_output: a record without usage must carry an error
      for (const rec of records) if (rec.usage === null) assert.notEqual(rec.error, null)
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proxy: upstream connection failure -> 502 to the client and a record with error, no usage", async () => {
  const dir = tmpDir()
  try {
    // grab a port then release it so the upstream is guaranteed closed
    const probe = http.createServer()
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const deadPort = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    await withProxy({ host: "127.0.0.1", port: deadPort, protocol: "http" }, dir, async (handle) => {
      const r = await post(handle.port, "{}", { "x-idle-step": "d/a/0" })
      assert.equal(r.status, 502)
      await r.text()
      const { records } = await handle.drainSince(0)
      assert.equal(records.length, 1)
      assert.equal(records[0].stepId, "d/a/0")
      assert.equal(records[0].usage, null)
      assert.equal(records[0].status, null)
      assert.match(records[0].error, /^upstream_error:/)
      const health = await fetch(`http://127.0.0.1:${handle.port}/__health`)
      assert.equal((await health.json()).runId, "run-1")
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ledger: append fsyncs, fold ignores a torn last line, fold is deterministic, tail/readAll/writers", () => {
  const dir = tmpDir()
  try {
    const ledger = openLedger(dir)
    ledger.append({ type: "run_started", runId: "r1" })
    ledger.append({ type: "step_intent", stepId: "a/b/0" })
    ledger.append({ type: "step_result", stepId: "a/b/0", ok: true })
    const eventsFile = path.join(dir, "events.jsonl")
    const lines = readFileSync(eventsFile, "utf8").split("\n")
    assert.equal(lines.length, 4)
    assert.equal(lines[3], "")
    const first = JSON.parse(lines[0])
    assert.equal(first.type, "run_started")
    assert.equal(first.seq, 0)
    assert.equal(typeof first.ts, "string")

    // stale_state: crash mid-append leaves a torn line
    writeFileSync(eventsFile, readFileSync(eventsFile, "utf8") + '{"type":"step_intent","stepId":"a/b/1","se', { flag: "w" })
    const f1 = ledger.fold()
    const f2 = ledger.fold()
    assert.deepEqual(f1, f2)
    assert.equal(f1.events.length, 3)
    assert.equal(f1.torn, true)
    assert.equal(f1.lastSeq, 2)
    assert.deepEqual(f1.events.map((e) => e.type), ["run_started", "step_intent", "step_result"])
    assert.deepEqual(ledger.tail(2).map((e) => e.stepId), ["a/b/0", "a/b/0"])

    // appending after a torn line starts on a fresh line and continues seq
    ledger.append({ type: "run_ended" })
    const f3 = ledger.fold()
    assert.equal(f3.torn, false)
    assert.equal(f3.events.length, 4)
    assert.equal(f3.events[3].seq, 3)

    // requests.jsonl / cli / summary
    ledger.writeRequestRecord({ v: "idle-live-request/1", stepId: "a/b/0", usage: { input_tokens: 1 } })
    ledger.writeRequestRecord({ v: "idle-live-request/1", stepId: "a/b/1", usage: null })
    assert.deepEqual(ledger.readRequests().map((r) => r.stepId), ["a/b/0", "a/b/1"])
    const cliPath = ledger.writeCli("exp/arm:1/0", { exitCode: 0, stdoutJson: { result: "OK" } })
    assert.ok(cliPath.startsWith(path.join(dir, "cli")))
    assert.ok(!/[/:]/.test(path.basename(cliPath).replace(/\.json$/, "")))
    assert.deepEqual(JSON.parse(readFileSync(cliPath, "utf8")), { exitCode: 0, stdoutJson: { result: "OK" } })
    assert.deepEqual(ledger.readCli("exp/arm:1/0"), { exitCode: 0, stdoutJson: { result: "OK" } })
    ledger.writeSummary({ v: "idle-live-summary/1", runId: "r1", exitCode: 0 })
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")), { v: "idle-live-summary/1", runId: "r1", exitCode: 0 })
    assert.deepEqual(ledger.readSummary(), { v: "idle-live-summary/1", runId: "r1", exitCode: 0 })
    assert.equal(ledger.dir, dir)

    // empty dir: fold of a missing events file
    const empty = openLedger(path.join(dir, "sub"))
    assert.deepEqual(empty.fold(), { events: [], torn: false, lastSeq: -1 })
    assert.deepEqual(empty.readRequests(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- adapter -----------------------------------------------------------------

function fakeChild({ stdout = "", stderr = "", code = 0, neverClose = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdinChunks = []
  child.stdin = new Writable({
    write(chunk, enc, cb) { child.stdinChunks.push(Buffer.from(chunk)); cb() },
    final(cb) {
      child.stdinEnded = true
      cb()
      if (neverClose) return
      queueMicrotask(() => {
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        child.emit("close", code, null)
      })
    },
  })
  child.killed = false
  child.kill = (sig) => {
    child.killed = true
    child.killSignal = sig
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, sig || "SIGTERM") })
    return true
  }
  return child
}

function fakeSpawn(opts) {
  const calls = []
  const spawn = (cmd, args, options) => {
    const child = fakeChild(opts)
    calls.push({ cmd, args, options, child })
    return child
  }
  spawn.calls = calls
  return spawn
}

const BASE_FLAGS = ["-p", "--model", "claude-fable-5-1", "--output-format", "json", "--safe-mode", "--strict-mcp-config",
  "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk", "--effort", "low", "--max-turns", "1", "--fallback-model", "claude-fable-5-1"]

const step = (mode, id = "sess-1") => ({
  id: "fable-write-tick/w/3",
  experiment: "fable-write-tick", arm: "w", index: 3, kind: "ping", phase: "observe",
  prompt: { text: "Hi! Please respond with just the word OK.", sha256: "x", chars: 41, tokensEst: 12 },
  session: { id, mode },
})

test("adapter: capabilities and flags/env for new / resume / ephemeral sessions; prompt via stdin; label file written", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ result: "OK", usage: { input_tokens: 1 } }), stderr: "warn\n" })
    const labelFile = path.join(dir, "label.txt")
    const adapter = createClaudeCliAdapter({ cli: "C:/fake/claude.exe", model: "claude-fable-5-1", spawn, workDir: dir, labelFile })
    assert.deepEqual(adapter.capabilities, { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model: "claude-fable-5-1" })

    const res = await adapter.invoke(step("new"), { stepHeader: "fable-write-tick/w/3", baseUrl: "http://127.0.0.1:18321" })
    assert.equal(res.exitCode, 0)
    assert.deepEqual(res.stdoutJson, { result: "OK", usage: { input_tokens: 1 } })
    assert.equal(res.stderrHead, "warn\n")
    assert.equal(typeof res.startedMs, "number")
    assert.ok(res.endedMs >= res.startedMs)

    assert.equal(spawn.calls.length, 1)
    const call = spawn.calls[0]
    assert.equal(call.cmd, "C:/fake/claude.exe")
    assert.deepEqual(call.args, [...BASE_FLAGS, "--session-id", "sess-1"])
    assert.equal(call.options.cwd, dir)
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"])
    const env = call.options.env
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18321")
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-idle-step: fable-write-tick/w/3")
    assert.equal(env.MAX_THINKING_TOKENS, "0")
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1")
    assert.equal(env.DISABLE_AUTOUPDATER, "1")
    assert.equal(env.DISABLE_TELEMETRY, "1")
    assert.equal(env.DISABLE_ERROR_REPORTING, "1")
    assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path)
    assert.equal(Buffer.concat(call.child.stdinChunks).toString("utf8"), "Hi! Please respond with just the word OK.")
    assert.equal(call.child.stdinEnded, true)
    assert.equal(readFileSync(labelFile, "utf8"), "fable-write-tick/w/3")

    await adapter.invoke(step("resume", "sess-2"), { stepHeader: "fable-write-tick/w/3", baseUrl: "http://127.0.0.1:1" })
    assert.deepEqual(spawn.calls[1].args, [...BASE_FLAGS, "--resume", "sess-2"])
    await adapter.invoke(step("ephemeral", null), { stepHeader: "fable-write-tick/w/3", baseUrl: "http://127.0.0.1:1" })
    assert.deepEqual(spawn.calls[2].args, [...BASE_FLAGS, "--no-session-persistence"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: non-JSON stdout -> stdoutJson null with exit code kept; stderrHead is bounded", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ stdout: "not json", stderr: "e".repeat(5000), code: 1 })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const res = await adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" })
    assert.equal(res.exitCode, 1)
    assert.equal(res.stdoutJson, null)
    assert.equal(res.stdoutHead, "not json")
    assert.equal(res.stderrHead.length, 2000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: unknown session mode rejects with bad_session_mode before spawning", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({})
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    await assert.rejects(adapter.invoke(step("weird"), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }), (e) => e.code === "bad_session_mode" && /weird/.test(e.message))
    await assert.rejects(adapter.invoke(step("new", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }), (e) => e.code === "bad_session_mode")
    await assert.rejects(adapter.invoke(step("resume", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }), (e) => e.code === "bad_session_mode")
    assert.equal(spawn.calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: hung child is killed on abort signal and the invoke rejects with aborted", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ neverClose: true })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const ac = new AbortController()
    const p = adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }, ac.signal)
    const stdinDone = new Promise((resolve) => spawn.calls[0].child.stdin.on("finish", resolve))
    await stdinDone
    const closed = new Promise((resolve) => spawn.calls[0].child.on("close", resolve))
    ac.abort()
    await closed
    assert.equal(spawn.calls[0].child.killed, true)
    const res = await p
    assert.equal(res.error.code, "aborted")

    // already-aborted signal: no spawn at all
    const ac2 = new AbortController()
    ac2.abort()
    await assert.rejects(adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }, ac2.signal), (e) => e.code === "aborted")
    assert.equal(spawn.calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: spawn error rejects with spawn_failed", async () => {
  const dir = tmpDir()
  try {
    const spawn = () => {
      const child = fakeChild({ neverClose: true })
      queueMicrotask(() => child.emit("error", new Error("ENOENT")))
      return child
    }
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    await assert.rejects(adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }), (e) => e.code === "spawn_failed" && /ENOENT/.test(e.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: non-zero exit with non-JSON stdout -> error.code nonzero_exit, keeps exitCode", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ stdout: "not-json", stderr: "", code: 7 })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const res = await adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" })
    assert.equal(res.exitCode, 7)
    assert.equal(res.stdoutJson, null)
    assert.equal(res.error.code, "nonzero_exit")
    assert.ok(/exit code 7/.test(res.error.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: zero exit with non-JSON stdout -> error.code stdout_not_json", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ stdout: "not-json", stderr: "", code: 0 })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const res = await adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" })
    assert.equal(res.exitCode, 0)
    assert.equal(res.stdoutJson, null)
    assert.equal(res.error.code, "stdout_not_json")
    assert.ok(/JSON/.test(res.error.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: zero exit with valid JSON stdout -> error is null", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ result: "OK", usage: { input_tokens: 1 } }), stderr: "", code: 0 })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const res = await adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" })
    assert.equal(res.exitCode, 0)
    assert.deepEqual(res.stdoutJson, { result: "OK", usage: { input_tokens: 1 } })
    assert.equal(res.error, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adapter: abort signal -> error.code aborted (resolves with error field, does not throw)", async () => {
  const dir = tmpDir()
  try {
    const spawn = fakeSpawn({ neverClose: true })
    const adapter = createClaudeCliAdapter({ cli: "x", model: "m", spawn, workDir: dir, labelFile: path.join(dir, "label.txt") })
    const ac = new AbortController()
    const p = adapter.invoke(step("ephemeral", null), { stepHeader: "s", baseUrl: "http://127.0.0.1:1" }, ac.signal)
    const stdinDone = new Promise((resolve) => spawn.calls[0].child.stdin.on("finish", resolve))
    await stdinDone
    ac.abort()
    const res = await p
    assert.equal(res.error.code, "aborted")
    assert.ok(/aborted|killed/.test(res.error.message.toLowerCase()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- processes ---------------------------------------------------------------

test("processes.conflicting parses tasklist CSV and ignores the header / no-tasks message", async () => {
  const calls = []
  const csv = '"Image Name","PID","Session Name","Session#","Mem Usage"\r\n"claude.exe","1234","Console","1","100,000 K"\r\n"claude.exe","5678","Console","1","200,000 K"\r\n'
  const exec = async (cmd) => { calls.push(cmd); return { stdout: csv, stderr: "" } }
  assert.deepEqual(await conflicting({ exec }), [{ image: "claude.exe", pid: 1234 }, { image: "claude.exe", pid: 5678 }])
  assert.equal(calls.length, 1)
  assert.match(calls[0], /tasklist \/FI "IMAGENAME eq claude.exe" \/FO CSV/)

  const none = async () => ({ stdout: "INFO: No tasks are running which match the specified criteria.\r\n", stderr: "" })
  assert.deepEqual(await conflicting({ exec: none }), [])
  const failing = async () => { throw new Error("boom") }
  await assert.rejects(conflicting({ exec: failing }), /boom/)
  assert.ok(!existsSync(path.join(os.tmpdir(), "never-created-marker-idle-live")))
})

// I3: in-doubt reconciliation on --resume needs the HISTORICAL proxy.jsonl (rows a crashed
// process wrote), not only the records the current process can drain.
const jsonUpstream = (req, body, res) => {
  res.writeHead(200, { "content-type": "application/json", ...RL_HEADERS })
  res.end(JSON.stringify({ id: "msg_new", type: "message", model: "claude-test", usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: "end_turn" }))
}

test("proxy: readLog returns every record of the run's proxy.jsonl, including a previous process's, and drops only a torn final line", async () => {
  const dir = tmpDir()
  try {
    const logPath = path.join(dir, "proxy.jsonl")
    const old = (i) => JSON.stringify({ stepId: `old/${i}`, msg_id: `m${i}`, runId: "run-1" })
    // The previous process was killed mid-append: two complete rows and a torn tail.
    writeFileSync(logPath, `${old(1)}\n${old(2)}\n{"stepId":"old/3","msg`)
    await withUpstream(jsonUpstream, (upstream) =>
      withProxy(upstream, dir, async (handle) => {
        assert.deepEqual((await handle.readLog()).map((r) => r.msg_id), ["m1", "m2"], "stale rows are read, the torn tail is not")
        assert.deepEqual((await handle.drainSince(0)).records, [], "drainSince stays this-process-only")
        const res = await post(handle.port, JSON.stringify({ model: "claude-test" }), { "x-idle-step": "new/1" })
        await res.text()
        const rows = await handle.readLog()
        assert.deepEqual(rows.map((r) => r.msg_id), ["m1", "m2", "msg_new"], "the new record follows the history and is never glued to the torn tail")
        assert.equal(rows[2].stepId, "new/1")
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proxy: readLog rejects interior corruption, keeps a complete unterminated last row, and reads an empty log as []", async () => {
  const dir = tmpDir()
  try {
    const logPath = path.join(dir, "proxy.jsonl")
    const row = (i) => JSON.stringify({ stepId: `s/${i}`, msg_id: `m${i}` })
    await withUpstream(jsonUpstream, async (upstream) => {
      await withProxy(upstream, dir, async (handle) => {
        assert.deepEqual(await handle.readLog(), [], "a fresh log is empty, not corrupt")
      })
      writeFileSync(logPath, `${row(1)}\n{"stepId":"s/2","msg\n${row(3)}\n`)
      await withProxy(upstream, dir, async (handle) => {
        await assert.rejects(() => handle.readLog(), (e) => {
          assert.equal(e.code, "proxy_log_corrupt")
          assert.match(e.message, /line 2/)
          return true
        }, "a corrupt interior line would hide a paid call from reconciliation")
      })
      writeFileSync(logPath, `${row(1)}\n${row(2)}`) // complete last row, no newline
      await withProxy(upstream, dir, async (handle) => {
        const res = await post(handle.port, JSON.stringify({ model: "claude-test" }), { "x-idle-step": "s/3" })
        await res.text()
        assert.deepEqual((await handle.readLog()).map((r) => r.msg_id), ["m1", "m2", "msg_new"])
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// I19 (gate mutant P7): the torn tail is cut at a BYTE offset. With multibyte rows before it, a cut
// counted in UTF-16 units would land inside a complete row and destroy it.
test("proxy: a torn tail after multibyte rows is truncated byte-exactly; every complete row survives", async () => {
  const dir = tmpDir()
  try {
    const logPath = path.join(dir, "proxy.jsonl")
    const rows = [
      JSON.stringify({ stepId: "s/1", msg_id: "m1", error: "caf\u00e9 \u00fcber" }),
      JSON.stringify({ stepId: "s/2", msg_id: "m2", error: "\ud55c\uae00 \ub85c\uadf8 emoji \ud83d\ude80" }),
    ]
    const kept = `${rows[0]}\n${rows[1]}\n`
    writeFileSync(logPath, `${kept}{"stepId":"s/3","error":"\ud55c\uae00 \ud83d`) // killed mid-append
    assert.ok(Buffer.byteLength(kept, "utf8") > kept.length, "the fixture must contain multibyte characters before the cut")
    await withUpstream(jsonUpstream, (upstream) =>
      withProxy(upstream, dir, async (handle) => {
        assert.deepEqual((await handle.readLog()).map((r) => r.msg_id), ["m1", "m2"])
      }),
    )
    assert.ok(readFileSync(logPath).equals(Buffer.from(kept, "utf8")), "the file is exactly the complete rows, byte for byte")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// I19 (c), gate repro C8: a proxy that cannot bind (the port is held, e.g. by the same run's live
// proxy) must not touch the log - the owner may be mid-append, so its "torn" tail is not debris.
test("proxy: a start refused with EADDRINUSE leaves proxy.jsonl byte-for-byte untouched", async () => {
  const dir = tmpDir()
  const holder = http.createServer((req, res) => res.end())
  try {
    await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve))
    const logPath = path.join(dir, "proxy.jsonl")
    const before = `{"stepId":"a","msg_id":"m1"}\n{"stepId":"b","ms`
    writeFileSync(logPath, before)
    await assert.rejects(
      startProxy({ port: holder.address().port, logPath, runId: "run-1", labelFile: null, upstream: { host: "127.0.0.1", port: 9, protocol: "http" } }),
      (e) => e.code === "EADDRINUSE",
    )
    assert.equal(readFileSync(logPath, "utf8"), before, "the torn-looking tail of a live owner is left alone")
  } finally {
    await new Promise((resolve) => holder.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
