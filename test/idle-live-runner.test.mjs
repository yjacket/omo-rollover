// Runner exit classification (plan todo 7, I12) and the proxy-log seam (I3).
// main() is driven in-process through its test seam (`io`): startProxy, runMachine, the adapter
// factory, the process scan and fetch are all fakes. Nothing spawns, nothing leaves loopback,
// nothing is paid. Appendix B: only exit 4 is resumable.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"

import { EXIT, manifest, runMachine } from "../scripts/idle-live/machine.mjs"
import { openLedger } from "../scripts/idle-live/ledger.mjs"

// Process-level tripwires (I19 b), installed BEFORE the runner is imported: processes.mjs binds its
// exec at load time. Any real spawn, process scan, bind, connect or fetch a test slips through to is
// recorded and throws, so no test in this file can reach a live effect, and the last test fails if
// one tried.
const tripped = []
const trip = (name) => function tripwire() {
  tripped.push(name)
  throw Object.assign(new Error(`runner test tripwire: ${name}`), { code: "TEST_TRIPWIRE" })
}
{
  const require = createRequire(import.meta.url)
  const cp = require("node:child_process")
  for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[k] = trip(`child_process.${k}`)
  const net = require("node:net")
  net.Server.prototype.listen = trip("net.Server.listen")
  net.connect = trip("net.connect")
  net.createConnection = trip("net.createConnection")
  globalThis.fetch = async () => trip("fetch")()
  syncBuiltinESMExports()
}
const { main } = await import("../scripts/idle-live-runner.mjs")

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const APPROVAL = JSON.parse(readFileSync(join(repo, "docs/idle-experiments-approval-2026-09-23.json"), "utf8"))
const PLANNER_SHA = createHash("sha256").update(readFileSync(join(repo, "scripts/idle-experiments.mjs"), "utf8"), "utf8").digest("hex")
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// A copy of the signed approval with an approvedAt already in the past (same as the machine
// tests), so the checks do not depend on the host clock having passed the signing time.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "idle-live-runner-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const json = JSON.parse(JSON.stringify(APPROVAL))
  json.approvedAt = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z")
  const approvalText = `${JSON.stringify(json, null, 2)}\n`
  const approval = join(dir, "approval.json")
  writeFileSync(approval, approvalText)
  return { dir, approval, approvalText, evidence: join(dir, "evidence") }
}

function fakeProxy(port = 18999) {
  const proxy = { port, closed: 0, readLog: async () => [], drainSince: async () => ({ records: [], cursor: 0 }), async close() { this.closed += 1 } }
  return proxy
}

// Collects stdout; every call must end with exactly one JSON summary line.
// The env is injected (I28), so the resolved CLI path never depends on the host's APPDATA.
const FAKE_APPDATA = "C:/fake/AppData/Roaming"
const FAKE_DEFAULT_CLI = join(FAKE_APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")

function harness(overrides = {}) {
  const stdout = []
  const calls = { startProxy: 0, runMachine: 0, fetch: 0, probeCli: [], createAdapter: [] }
  const proxy = fakeProxy()
  const io = {
    stdout: (s) => stdout.push(s),
    stderr: () => {},
    env: { APPDATA: FAKE_APPDATA },
    startProxy: async () => { calls.startProxy += 1; return proxy },
    runMachine: async () => { calls.runMachine += 1; throw new Error("runMachine not scripted") },
    createAdapter: (opts) => { calls.createAdapter.push(opts); return { capabilities: { ttlLanes: ["1h"] }, invoke: async () => { throw new Error("never invoked") } } },
    conflicting: async () => [],
    fetch: async () => { calls.fetch += 1; throw new Error("fetch not scripted") },
    probeCli: async (cli, env) => { calls.probeCli.push({ cli, env }); return "2.1.278" },
    ...overrides,
  }
  const summary = () => {
    const lines = stdout.join("").split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    assert.equal(lines.length, 1, `exactly one JSON summary line, got: ${JSON.stringify(lines)}`)
    return JSON.parse(lines[0])
  }
  return { io, stdout, calls, proxy, summary }
}

const inUse = () => Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })

// Seeds a crashed run: run.json bound to this approval, and the given events.
function seedRun(fx, runId, events) {
  const evidenceDir = join(fx.evidence, runId)
  const ledger = openLedger(evidenceDir)
  for (const e of events) ledger.append(e)
  writeFileSync(join(evidenceDir, "run.json"), `${JSON.stringify(manifest({ runId, evidenceDir, approvalSha256: sha256(fx.approvalText), plannerSha256: PLANNER_SHA, proxyPort: 18999 }), null, 2)}\n`)
  return evidenceDir
}

const OPEN_EXPERIMENT = [
  { ev: "run_started", evidenceDir: null },
  { ev: "preflight", ok: true },
  { ev: "experiment_started", experiment: "fable-write-tick", run: null },
]
const IN_DOUBT_STEP = [
  { ev: "run_started", evidenceDir: null },
  { ev: "preflight", ok: true },
  { ev: "experiment_started", experiment: "fable-write-tick", run: null },
  { ev: "step_intent", stepId: "fable-write-tick/0", experiment: "fable-write-tick" },
  { ev: "experiment_ended", experiment: "fable-write-tick", run: null, status: "void", reason: "unknown_issue_state" },
]
const ALL_ENDED = [
  { ev: "run_started", evidenceDir: null },
  { ev: "preflight", ok: true },
  { ev: "experiment_started", experiment: "fable-write-tick", run: null },
  { ev: "step_intent", stepId: "fable-write-tick/0", experiment: "fable-write-tick" },
  { ev: "step_result", stepId: "fable-write-tick/0", experiment: "fable-write-tick" },
  { ev: "experiment_ended", experiment: "fable-write-tick", run: null, status: "valid", reason: null },
]

// ------------------------------------------------------------- before run_started: exit 2

test("bad arguments exit 2, resumable:false, one JSON line", async () => {
  const h = harness()
  assert.equal(await main(["--nuke"], h.io), EXIT.PREFLIGHT)
  const s = h.summary()
  assert.equal(s.exitCode, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["unknown_argument"])
  assert.equal(h.calls.startProxy, 0)
})

test("an evidence path that cannot be created exits 2 with a reason, resumable:false", async (t) => {
  const fx = fixture(t)
  const file = join(fx.dir, "a-file")
  writeFileSync(file, "not a directory\n")
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", join(file, "evidence")], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.exitCode, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["evidence_dir_unwritable"])
  assert.equal(s.paidRequestsIssued, 0)
  assert.equal(h.calls.startProxy, 0)
  assert.equal(h.calls.runMachine, 0)
})

test("--dry-run refuses an evidence path the live run could not create, and creates nothing", async (t) => {
  const fx = fixture(t)
  const file = join(fx.dir, "a-file")
  writeFileSync(file, "not a directory\n")
  const h = harness()
  const code = await main(["--dry-run", "--approval", fx.approval, "--evidence", join(file, "evidence")], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["evidence_dir_unwritable"])
  assert.equal(s.detail, "ENOTDIR")
  assert.equal(s.paidRequestsIssued, 0)
  assert.equal(h.calls.runMachine, 0, "refused before preflight runs")
  assert.equal(readFileSync(file, "utf8"), "not a directory\n")
})

test("--dry-run with a creatable evidence path that does not exist yet still passes and creates nothing", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine: async () => ({ v: "idle-live-summary/1", runId: "dry-run", exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: null, paidRequestsIssued: 0, schedule: [] }) })
  const code = await main(["--dry-run", "--approval", fx.approval, "--evidence", join(fx.evidence, "deeper")], h.io)
  assert.equal(code, EXIT.OK)
  assert.equal(h.summary().evidenceDirCreated, false)
  assert.equal(existsSync(fx.evidence), false)
})

test("a port held by a foreign process (EADDRINUSE, other runId) exits 2 proxy_port_in_use, resumable:false", async (t) => {
  const fx = fixture(t)
  const h = harness({
    startProxy: async () => { throw inUse() },
    fetch: async () => ({ json: async () => ({ runId: "someone-else" }) }),
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--port", "18999"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.exitCode, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["proxy_port_in_use"])
  assert.equal(s.health.runId, "someone-else")
})

test("a port with no answering owner (EADDRINUSE, health unreachable) exits 2, resumable:false", async (t) => {
  const fx = fixture(t)
  const h = harness({ startProxy: async () => { throw inUse() } })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--port", "18999"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["proxy_port_in_use"])
  assert.equal(s.health, null)
})

test("a proxy that fails to start for another reason exits 2 proxy_start_failed, resumable:false", async (t) => {
  const fx = fixture(t)
  const h = harness({ startProxy: async () => { throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) } })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["proxy_start_failed"])
  assert.equal(s.detail, "EACCES")
})

test("a crash in the machine before run_started is written exits 2, resumable:false, and closes the proxy", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine: async () => { throw new Error("boom before any event") } })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.exitCode, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["runner_crashed_before_run_started"])
  assert.equal(s.detail, "boom before any event")
  assert.equal(h.proxy.closed, 1)
})

// ------------------------------------------------------------- after run_started

test("a crash after run_started with an experiment_started and no experiment_ended exits 4, resumable", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of OPEN_EXPERIMENT) deps.ledger.append(e)
      throw new Error("killed mid experiment")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.IN_DOUBT)
  assert.equal(s.exitCode, EXIT.IN_DOUBT)
  assert.equal(s.resumable, true)
  assert.ok(s.runId, "a resumable summary names the runId to pass to --resume")
  assert.deepEqual(s.interrupted, ["fable-write-tick"])
  assert.deepEqual(s.inDoubt, [])
  assert.equal(h.proxy.closed, 1)
})

test("a crash after run_started with an in-doubt step exits 4, resumable, and lists the step", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of IN_DOUBT_STEP) deps.ledger.append(e)
      throw new Error("killed after the intent")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.IN_DOUBT)
  assert.equal(s.resumable, true)
  assert.deepEqual(s.inDoubt, ["fable-write-tick/0"])
  assert.deepEqual(s.interrupted, [])
})

test("a crash after run_started with nothing resumable exits 3, resumable:false", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of ALL_ENDED) deps.ledger.append(e)
      throw new Error("crash between experiments")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["runner_crashed"])
  assert.equal(s.detail, "crash between experiments")
})

// ------------------------------------------------------------- --resume

test("--resume on an in-doubt log with the port held by this run's own proxy exits 4, resumable", async (t) => {
  const fx = fixture(t)
  const runId = "20260923-160000"
  seedRun(fx, runId, IN_DOUBT_STEP)
  const h = harness({
    startProxy: async () => { throw inUse() },
    fetch: async () => ({ json: async () => ({ runId }) }),
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.IN_DOUBT)
  assert.equal(s.resumable, true)
  assert.deepEqual(s.issues, ["proxy_port_held_by_this_run"])
  assert.equal(s.runId, runId)
  assert.deepEqual(s.inDoubt, ["fable-write-tick/0"])
})

test("--resume on a log with nothing resumable and the port in use exits 3, resumable:false", async (t) => {
  const fx = fixture(t)
  const runId = "20260923-170000"
  seedRun(fx, runId, ALL_ENDED)
  const h = harness({
    startProxy: async () => { throw inUse() },
    fetch: async () => ({ json: async () => ({ runId: "someone-else" }) }),
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["proxy_port_in_use"])
})

// ------------------------------------------------------------- I3: the proxy handle's readLog

test("the live path hands the machine the proxy handle's readLog, not a runner-owned reader", async (t) => {
  const fx = fixture(t)
  let seen = null
  const h = harness({
    runMachine: async (deps, approval, opts) => {
      seen = deps
      return { v: "idle-live-summary/1", runId: opts.runId, exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: opts.evidenceDir, paidRequestsIssued: 0 }
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  assert.equal(code, EXIT.OK)
  assert.equal(h.summary().exitCode, EXIT.OK)
  assert.equal(seen.proxy, h.proxy)
  assert.equal(seen.proxyLog, undefined, "no second reader: the machine reads history through deps.proxy.readLog")
  assert.equal(typeof seen.proxy.readLog, "function")
  assert.equal(h.proxy.closed, 1)
  assert.equal(existsSync(join(seen.ledger.dir, "run.json")), true)
})

// ------------------------------------------------------------- I19 (a): gate survivors R5-R7, R10

// R5/R6: a log that exists but cannot be folded proves nothing - never "no run", never resumable.
for (const [name, corrupt] of [
  ["interior-corrupt", (dir) => appendFileSync(join(dir, "events.jsonl"), `{not json\n${JSON.stringify({ ev: "preflight", ok: true })}\n`)],
  ["a directory", (dir) => { rmSync(join(dir, "events.jsonl"), { force: true }); mkdirSync(join(dir, "events.jsonl")) }],
]) {
  test(`a crash that leaves an unreadable event log (${name}) exits 3 event_log_unreadable, resumable:false, paid unknown`, async (t) => {
    const fx = fixture(t)
    const h = harness({
      runMachine: async (deps) => {
        for (const e of OPEN_EXPERIMENT) deps.ledger.append(e)
        corrupt(deps.ledger.dir)
        throw new Error("crash over a damaged log")
      },
    })
    const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
    const s = h.summary()
    assert.equal(code, EXIT.ABORTED)
    assert.equal(s.exitCode, EXIT.ABORTED)
    assert.equal(s.resumable, false, "an unreadable log must never advertise a resume")
    assert.deepEqual(s.issues, ["runner_crashed", "event_log_unreadable"])
    assert.equal(s.paidRequestsIssued, null, "the paid count cannot be claimed from an unreadable log")
    assert.equal(typeof s.logError, "string")
    assert.equal(h.proxy.closed, 1)
  })
}

// R7: an events.jsonl that exists but never got a run_started (a cancel recorded before the run's
// bookkeeping, or an empty file) is "no run began": exit 2, not 3.
for (const [name, write] of [
  ["campaign_stop{cancelled} only", (deps) => deps.ledger.append({ ev: "campaign_stop", reason: "cancelled" })],
  ["empty", (deps) => writeFileSync(join(deps.ledger.dir, "events.jsonl"), "")],
]) {
  test(`a crash whose event log holds no run_started (${name}) exits 2, resumable:false`, async (t) => {
    const fx = fixture(t)
    const h = harness({ runMachine: async (deps) => { write(deps); throw new Error("crash before the run began") } })
    const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
    const s = h.summary()
    assert.equal(code, EXIT.PREFLIGHT)
    assert.equal(s.resumable, false)
    assert.deepEqual(s.issues, ["runner_crashed_before_run_started"])
  })
}

// R10: the /__health probe of a port owner is bounded. A silent owner only ever ends through the
// signal main passes. The fake never waits: handed a live AbortSignal it rejects at once (standing
// in for the 2 s timeout firing); handed none, it rejects too, and the assertion below fails - an
// unbounded probe is caught as a failed test, never as a hung one.
test("the port-owner health probe carries an abort signal, so a silent owner cannot hang the runner", async (t) => {
  const fx = fixture(t)
  const seen = []
  const h = harness({
    startProxy: async () => { throw inUse() },
    fetch: async (url, init) => {
      seen.push({ url, signal: init?.signal })
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--port", "18999"], h.io)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, "http://127.0.0.1:18999/__health")
  assert.ok(seen[0].signal instanceof AbortSignal, "the probe must be bounded by a signal")
  assert.equal(seen[0].signal.aborted, false, "the bound is a timeout, not an already-aborted signal")
  assert.equal(code, EXIT.PREFLIGHT)
  const s = h.summary()
  assert.deepEqual(s.issues, ["proxy_port_in_use"])
  assert.equal(s.health, null)
})

// ------------------------------------------------------------- I19 (b): fail-closed test seam

// Driving main() with a seam that lacks any live dependency must throw BEFORE any effect: no
// evidence dir, no port bind, no process scan, no spawn. Each case below would otherwise stop at
// an injected EACCES proxy failure, so even without the guard nothing here reaches a real machine.
const LIVE_DEPS = ["startProxy", "runMachine", "createAdapter", "conflicting", "fetch", "probeCli"]
for (const missing of LIVE_DEPS) {
  test(`a test seam without ${missing} throws live_dep_not_injected before touching anything`, async (t) => {
    const fx = fixture(t)
    const io = {
      stdout: () => {},
      stderr: () => {},
      env: { APPDATA: FAKE_APPDATA },
      startProxy: async () => { throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) },
      runMachine: async () => { throw new Error("never reached") },
      createAdapter: () => ({ capabilities: {}, invoke: async () => { throw new Error("never invoked") } }),
      conflicting: async () => [],
      fetch: async () => { throw new Error("never fetched") },
      probeCli: async () => "2.1.278",
    }
    delete io[missing]
    await assert.rejects(main(["--approval", fx.approval, "--evidence", fx.evidence], io), (e) => {
      assert.equal(e.code, "live_dep_not_injected")
      assert.match(e.message, new RegExp(`\\b${missing}\\b`))
      return true
    })
    assert.equal(existsSync(fx.evidence), false, "nothing was created before the guard fired")
  })
}

test("an empty test seam throws; only the CLI entry, which passes the real dependencies, may use them", async () => {
  await assert.rejects(main(["--dry-run"], {}), (e) => e.code === "live_dep_not_injected")
})

// Gate I19 N1 (G4): a dep that is present but not a function is as missing as an absent one.
for (const bad of [true, {}, "fn"]) {
  test(`a test seam whose deps are ${JSON.stringify(bad)} (not functions) throws, naming every one`, async (t) => {
    const fx = fixture(t)
    const io = { stdout: () => {}, stderr: () => {}, ...Object.fromEntries(LIVE_DEPS.map((k) => [k, bad])) }
    await assert.rejects(main(["--approval", fx.approval, "--evidence", fx.evidence], io), (e) => {
      assert.equal(e.code, "live_dep_not_injected")
      assert.deepEqual(e.missing, LIVE_DEPS)
      return true
    })
    assert.equal(existsSync(fx.evidence), false)
  })
}

// Gate I19 B2 (and G6): the live deps are opt-in. A test that passes no seam, undefined or null must
// throw before any bind, scan or spawn - never fall through to the real ones.
const ARGV = {
  live: (fx) => ["--approval", fx.approval, "--evidence", fx.evidence],
  dry: (fx) => ["--dry-run", "--approval", fx.approval, "--evidence", fx.evidence],
}
for (const [name, call] of [
  ["main(argv)", (argv) => main(argv)],
  ["main(argv, null)", (argv) => main(argv, null)],
]) {
  for (const [mode, argv] of Object.entries(ARGV)) {
    test(`${name} (${mode}) throws live_dep_not_injected before any bind, scan or spawn`, async (t) => {
      const fx = fixture(t)
      const before = tripped.length
      await assert.rejects(call(argv(fx)), (e) => {
        assert.equal(e.code, "live_dep_not_injected")
        assert.deepEqual(e.missing, LIVE_DEPS)
        return true
      })
      assert.deepEqual(tripped.slice(before), [], "no real effect was attempted")
      assert.equal(existsSync(fx.evidence), false)
    })
  }
}

// Gate I19 B1: main must use exactly the deps the guard validated. A seam whose deps are inherited
// or non-enumerable passes a typeof check but is dropped by an object spread; its fakes must still
// be the ones called, with no real effect.
const SEAM_SHAPES = {
  "a class instance (deps on its prototype)": (deps) => {
    class Seam {}
    for (const [k, v] of Object.entries(deps)) Seam.prototype[k] = v
    return new Seam()
  },
  "Object.create(deps)": (deps) => Object.create(deps),
  "an object with non-enumerable deps": (deps) => Object.defineProperties({}, Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { value: v, enumerable: false }]))),
}
const DRY_OK = { v: "idle-live-summary/1", runId: "dry-run", exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: null, paidRequestsIssued: 0, schedule: [] }
for (const [name, shape] of Object.entries(SEAM_SHAPES)) {
  test(`a seam built as ${name} is used as given on the live path: its startProxy runs, nothing real`, async (t) => {
    const fx = fixture(t)
    const before = tripped.length
    const h = harness({ startProxy: async () => { h.calls.startProxy += 1; throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) } })
    const code = await main(ARGV.live(fx), shape(h.io))
    assert.equal(h.calls.startProxy, 1, "the seam's startProxy is the one called")
    assert.equal(code, EXIT.PREFLIGHT)
    assert.equal(h.summary().detail, "EACCES")
    assert.deepEqual(tripped.slice(before), [], "no real effect was attempted")
  })
  test(`a seam built as ${name} is used as given on the dry run: its runMachine and stdout run`, async (t) => {
    const fx = fixture(t)
    const before = tripped.length
    const h = harness({ runMachine: async () => { h.calls.runMachine += 1; return DRY_OK } })
    const code = await main(ARGV.dry(fx), shape(h.io))
    assert.equal(h.calls.runMachine, 1, "the seam's runMachine is the one called")
    assert.equal(code, EXIT.OK)
    assert.equal(h.summary().evidenceDirCreated, false, "the summary went to the seam's stdout")
    assert.deepEqual(tripped.slice(before), [], "no real effect was attempted")
  })
}

// Gate r2 N1: each dep is read from the seam exactly once, and the value checked is the value used.
// These getters hand out the fake on the first read and a different function on any later one.
test("main reads each seam dep exactly once and uses the value it checked", async (t) => {
  const fx = fixture(t)
  const before = tripped.length
  const h = harness({
    startProxy: async () => { h.calls.startProxy += 1; throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) },
    timeoutSignal: () => new AbortController().signal,
  })
  const reads = {}
  const later = () => { throw new Error("a dep read a second time was used") }
  const io = Object.defineProperties({}, Object.fromEntries(Object.entries(h.io).map(([k, v]) => [k, {
    enumerable: true,
    get: () => { reads[k] = (reads[k] ?? 0) + 1; return reads[k] === 1 ? v : later },
  }])))
  const code = await main(ARGV.live(fx), io)
  assert.deepEqual(reads, Object.fromEntries(Object.keys(h.io).map((k) => [k, 1])))
  assert.equal(h.calls.startProxy, 1, "the value read first is the one called")
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(h.summary().detail, "EACCES")
  assert.deepEqual(tripped.slice(before), [], "no real effect was attempted")
})

// Gate I19 N3: pin the health-probe bound itself. The signal factory is injected, so the value is
// observed without any timer running.
test("the port-owner health probe is bounded at 2000 ms by the signal main passes to fetch", async (t) => {
  const fx = fixture(t)
  const bounds = []
  const bound = new AbortController().signal
  let used = null
  const h = harness({
    startProxy: async () => { throw inUse() },
    timeoutSignal: (ms) => { bounds.push(ms); return bound },
    fetch: async (url, init) => { used = init?.signal; throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--port", "18999"], h.io)
  assert.deepEqual(bounds, [2000])
  assert.equal(used, bound, "the probe carries the bounded signal")
  assert.equal(code, EXIT.PREFLIGHT)
})

// Gate r2 N2: a seam without timeoutSignal gets the CLI's own factory, which must bound the probe
// with AbortSignal.timeout(2000). AbortSignal.timeout is replaced for this test only, so the bound is
// observed without a timer: a factory that never aborts, or ignores its ms, fails here.
test("the real health-probe signal factory is AbortSignal.timeout(2000), and fetch gets its signal", async (t) => {
  const fx = fixture(t)
  const timeouts = []
  const bound = new AbortController().signal
  t.mock.method(AbortSignal, "timeout", (ms) => { timeouts.push(ms); return bound })
  let used = null
  const h = harness({
    startProxy: async () => { throw inUse() },
    fetch: async (url, init) => { used = init?.signal; throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--port", "18999"], h.io)
  assert.deepEqual(timeouts, [2000])
  assert.equal(used, bound, "the probe carries the signal AbortSignal.timeout returned")
  assert.equal(code, EXIT.PREFLIGHT)
})

// ------------------------------------------------------------- I21: dry-run table scope

// The human table labels the per-idle cap with the scope the machine enforces (the JSON row's
// perIdleScope): ttl is gated per frame, restore-decomposition per run. Driven with the real,
// pure runMachine; the dry run uses fake deps only.
test("the dry-run table labels each per-idle cap with its enforced scope (ttl frame, restore run)", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine })
  const code = await main(ARGV.dry(fx), h.io)
  assert.equal(code, EXIT.OK)
  const table = h.stdout.join("").split("\n").filter((l) => l.startsWith("# ")).map((l) => l.slice(2).split(/\s{2,}/))
  const col = table.find((cells) => cells[0] === "ord").findIndex((c) => c.startsWith("perIdle"))
  const cell = (label) => table.find((cells) => cells[1] === label)[col]
  const rows = h.summary().schedule
  const cap = (id) => rows.find((r) => `${r.experiment}${r.run ? `#${r.run}` : ""}` === id).perIdleCapEq.toFixed(2)
  assert.equal(cell("ttl-1h-unique-prefix"), `${cap("ttl-1h-unique-prefix")}/frame`)
  assert.equal(cell("restore-decomposition#1"), `${cap("restore-decomposition#1")}/run`)
})

// ------------------------------------------------------------- I28: CLI resolution and --version probe

// npm installs only `claude` / `claude.cmd` shims; node spawn without a shell cannot start them.
// The runner defaults to the npm package's claude.exe (quota-test/2026-09-19/run.mjs:22) and, on
// every path that can pay, refuses in preflight unless `<cli> --version` starts and parses.
const { resolveCli } = await import("../scripts/idle-live-runner.mjs")
const { probeCliVersion, CLI_PROBE_TIMEOUT_MS } = await import("../scripts/idle-live/adapters/claude-cli.mjs")

test("I28 resolveCli: IDLE_LIVE_CLI wins, else the APPDATA npm claude.exe, else null (never a bare shim name)", () => {
  assert.equal(resolveCli({ APPDATA: FAKE_APPDATA }), FAKE_DEFAULT_CLI)
  assert.equal(resolveCli({ APPDATA: FAKE_APPDATA, IDLE_LIVE_CLI: "D:/tools/claude.exe" }), "D:/tools/claude.exe")
  assert.equal(resolveCli({ APPDATA: FAKE_APPDATA, IDLE_LIVE_CLI: "" }), FAKE_DEFAULT_CLI, "an empty override is no override")
  assert.equal(resolveCli({}), null, "no APPDATA and no override: nothing to spawn")
  assert.equal(resolveCli({ APPDATA: "" }), null)
})

test("I28 the live path probes the resolved default CLI with the injected env and hands the adapter the same path", async (t) => {
  const fx = fixture(t)
  const h = harness({ startProxy: async () => { throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) } })
  await main(ARGV.live(fx), h.io)
  assert.deepEqual(h.calls.probeCli.map((c) => c.cli), [FAKE_DEFAULT_CLI])
  assert.equal(h.calls.probeCli[0].env, h.io.env, "the probe sees the env the runner was given")
})

test("I28 IDLE_LIVE_CLI in the injected env is the path probed and the path the adapter spawns", async (t) => {
  const fx = fixture(t)
  const h = harness({
    env: { APPDATA: FAKE_APPDATA, IDLE_LIVE_CLI: "D:/tools/claude.exe" },
    runMachine: async (deps, approval, opts) => ({ v: "idle-live-summary/1", runId: opts.runId, exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: opts.evidenceDir, paidRequestsIssued: 0 }),
  })
  assert.equal(await main(ARGV.live(fx), h.io), EXIT.OK)
  assert.deepEqual(h.calls.probeCli.map((c) => c.cli), ["D:/tools/claude.exe"])
  assert.deepEqual(h.calls.createAdapter.map((c) => c.cli), ["D:/tools/claude.exe"])
})

const cliFailure = (code) => Object.assign(new Error(`probe failed: ${code}`), { code })
for (const code of ["spawn_failed", "exit_nonzero", "timeout", "version_unparseable"]) {
  test(`I28 a CLI probe that fails (${code}) refuses preflight: exit 2 cli_unavailable, resumable:false, nothing bound, spawned or paid`, async (t) => {
    const fx = fixture(t)
    const h = harness({ probeCli: async (cli) => { h.calls.probeCli.push({ cli }); throw cliFailure(code) } })
    const code_ = await main(ARGV.live(fx), h.io)
    const s = h.summary()
    assert.equal(code_, EXIT.PREFLIGHT)
    assert.equal(s.exitCode, EXIT.PREFLIGHT)
    assert.equal(s.resumable, false)
    assert.deepEqual(s.issues, ["cli_unavailable"])
    assert.equal(s.cli, FAKE_DEFAULT_CLI)
    assert.equal(s.cliError.code, code)
    assert.equal(s.paidRequestsIssued, 0)
    assert.equal(h.calls.probeCli.length, 1)
    assert.equal(h.calls.startProxy, 0)
    assert.equal(h.calls.runMachine, 0)
    assert.deepEqual(h.calls.createAdapter, [])
    assert.equal(existsSync(fx.evidence), false, "refused before the evidence dir exists")
  })
}

test("I28 with no APPDATA and no IDLE_LIVE_CLI the runner refuses cli_unavailable without spawning anything", async (t) => {
  const fx = fixture(t)
  const h = harness({ env: {} })
  assert.equal(await main(ARGV.live(fx), h.io), EXIT.PREFLIGHT)
  const s = h.summary()
  assert.deepEqual(s.issues, ["cli_unavailable"])
  assert.equal(s.cli, null)
  assert.equal(s.cliError.code, "cli_path_unresolved")
  assert.deepEqual(h.calls.probeCli, [])
  assert.equal(h.calls.startProxy, 0)
})

test("I28 --smoke probes the CLI and refuses when it cannot start", async (t) => {
  const fx = fixture(t)
  const h = harness({ probeCli: async (cli) => { h.calls.probeCli.push({ cli }); throw cliFailure("spawn_failed") } })
  assert.equal(await main([...ARGV.live(fx), "--smoke"], h.io), EXIT.PREFLIGHT)
  assert.deepEqual(h.summary().issues, ["cli_unavailable"])
  assert.equal(h.calls.probeCli.length, 1)
  assert.equal(h.calls.startProxy, 0)
})

test("I28 --resume probes the CLI and refuses before binding the proxy or touching the run", async (t) => {
  const fx = fixture(t)
  const runId = "20260925-090000"
  const evidenceDir = seedRun(fx, runId, IN_DOUBT_STEP)
  const eventsBefore = readFileSync(join(evidenceDir, "events.jsonl"), "utf8")
  const h = harness({ probeCli: async (cli) => { h.calls.probeCli.push({ cli }); throw cliFailure("spawn_failed") } })
  assert.equal(await main([...ARGV.live(fx), "--resume", runId], h.io), EXIT.PREFLIGHT)
  const s = h.summary()
  assert.deepEqual(s.issues, ["cli_unavailable"])
  assert.equal(s.resumable, false)
  assert.equal(h.calls.probeCli.length, 1)
  assert.equal(h.calls.startProxy, 0)
  assert.equal(h.calls.runMachine, 0)
  assert.equal(readFileSync(join(evidenceDir, "events.jsonl"), "utf8"), eventsBefore, "the resumable log is untouched")
})

test("I28 --dry-run never probes the CLI", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine: async () => DRY_OK, probeCli: async () => { throw new Error("dry run must not probe") } })
  assert.equal(await main(ARGV.dry(fx), h.io), EXIT.OK)
  assert.equal(h.summary().exitCode, EXIT.OK)
})

test("I28 run.json records the probed CLI version, not IDLE_LIVE_CLI_VERSION", async (t) => {
  const fx = fixture(t)
  let dir = null
  const h = harness({
    env: { APPDATA: FAKE_APPDATA, IDLE_LIVE_CLI_VERSION: "9.9.9" },
    runMachine: async (deps, approval, opts) => { dir = opts.evidenceDir; return { v: "idle-live-summary/1", runId: opts.runId, exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: opts.evidenceDir, paidRequestsIssued: 0 } },
  })
  assert.equal(await main(ARGV.live(fx), h.io), EXIT.OK)
  assert.equal(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).cliVersion, "2.1.278")
})

// probeCliVersion itself, driven with a fake spawn and a fake timer: nothing starts, nothing waits.
function probeChild({ stdout = "", code = 0, error = null, hang = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig ?? "SIGTERM"); return true }
  if (!hang) {
    queueMicrotask(() => {
      if (error) { child.emit("error", error); child.emit("close", -4058, null); return }
      if (stdout) child.stdout.emit("data", Buffer.from(stdout))
      child.emit("close", code, null)
    })
  }
  return child
}
function probeSpawn(childOpts) {
  const spawn = (cmd, args, options) => {
    const child = probeChild(childOpts)
    spawn.calls.push({ cmd, args, options, child })
    return child
  }
  spawn.calls = []
  return spawn
}
function fakeTimer() {
  const timer = { armed: [], cleared: [] }
  timer.set = (fn, ms) => { timer.armed.push({ fn, ms }); return timer.armed.length }
  timer.clear = (handle) => { timer.cleared.push(handle) }
  return timer
}
const probe = (spawn, timer = fakeTimer(), baseEnv = { PATH: "p" }) => probeCliVersion({ cli: "C:/fake/claude.exe", spawn, baseEnv, timer })

test("I28 probeCliVersion spawns `<cli> --version` without a shell, with the adapter's quiet env, and strips ' (Claude Code)'", async () => {
  const spawn = probeSpawn({ stdout: "2.1.278 (Claude Code)\n" })
  const timer = fakeTimer()
  assert.equal(await probe(spawn, timer), "2.1.278")
  assert.equal(spawn.calls.length, 1)
  const { cmd, args, options } = spawn.calls[0]
  assert.equal(cmd, "C:/fake/claude.exe")
  assert.deepEqual(args, ["--version"])
  assert.ok(!options.shell, "no shell: the path itself must be startable")
  assert.equal(options.env.PATH, "p", "the base env is passed through")
  assert.equal(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1")
  assert.equal(options.env.DISABLE_AUTOUPDATER, "1")
  assert.deepEqual(timer.armed.map((a) => a.ms), [CLI_PROBE_TIMEOUT_MS])
  assert.deepEqual(timer.cleared, [1], "the bound is cleared once the probe settles")
})

test("I28 probeCliVersion accepts a bare semver line", async () => {
  assert.equal(await probe(probeSpawn({ stdout: "2.1.278\r\n" })), "2.1.278")
})

for (const [name, childOpts, code] of [
  ["ENOENT", { error: Object.assign(new Error("spawn C:/fake/claude.exe ENOENT"), { code: "ENOENT" }) }, "spawn_failed"],
  ["a non-zero exit", { stdout: "2.1.278 (Claude Code)\n", code: 1 }, "exit_nonzero"],
  ["empty output", { stdout: "" }, "version_unparseable"],
  ["not a version", { stdout: "Welcome to Claude Code!\n" }, "version_unparseable"],
  ["a version buried in other text", { stdout: "update available\n2.1.278 (Claude Code)\n" }, "version_unparseable"],
]) {
  test(`I28 probeCliVersion rejects ${name} with ${code}`, async () => {
    const timer = fakeTimer()
    await assert.rejects(probe(probeSpawn(childOpts), timer), (e) => e.code === code)
    assert.deepEqual(timer.cleared, [1])
  })
}

test("I28 probeCliVersion rejects a synchronous spawn throw with spawn_failed", async () => {
  const spawn = () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }) }
  await assert.rejects(probe(spawn), (e) => e.code === "spawn_failed" && /EINVAL/.test(e.message))
})

test("I28 probeCliVersion rejects a hung CLI with timeout when its bound fires, and kills it", async () => {
  const spawn = probeSpawn({ hang: true })
  const timer = fakeTimer()
  let outcome = null
  probe(spawn, timer).then((version) => { outcome = { version } }, (error) => { outcome = { error } })
  assert.equal(timer.armed.length, 1)
  timer.armed[0].fn() // the bound firing, without any real time passing
  // One event-loop turn lets the settled promise's handlers run. A probe the bound does not settle
  // fails here instead of leaving the test pending forever.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outcome?.error?.code, "timeout", `the bound must reject the probe, got ${JSON.stringify(outcome)}`)
  assert.deepEqual(spawn.calls[0].child.kills, ["SIGTERM"])
})

// Must stay LAST: no test above reached a real spawn, scan, bind, connect or fetch.
test("no test in this file tripped a real effect", () => {
  assert.deepEqual(tripped, [])
})
