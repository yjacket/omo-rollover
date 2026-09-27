// Runner exit classification (plan todo 7, I12) and the proxy-log seam (I3).
// main() is driven in-process through its test seam (`io`): startProxy, runMachine, the adapter
// factory, the process scan and fetch are all fakes. Nothing spawns, nothing leaves loopback,
// nothing is paid. Appendix B: only exit 4 is resumable.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"

import { EXIT, manifest, runMachine, SUMMARY_VERSION, PREFLIGHT_ID } from "../scripts/idle-live/machine.mjs"
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

// The runner's clock is injected (io.now), so no test here depends on the host date. NOW_IN_WINDOW
// lies inside the signed approval's window (approvedAt 2026-09-22T17:50Z, approvalExpiresAt
// 2026-10-22T17:50Z); the approval-window tests below move it outside.
const NOW_IN_WINDOW = Date.parse("2026-09-26T00:00:00Z")
const APPROVED_AT = Date.parse(APPROVAL.approvedAt)
const EXPIRES_AT = Date.parse(APPROVAL.approvalExpiresAt)

// A copy of the signed approval (same fields), in a temp dir the test owns.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "idle-live-runner-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const approvalText = `${JSON.stringify(APPROVAL, null, 2)}\n`
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
    now: () => NOW_IN_WINDOW,
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

// RRN1 (todo 12 gate re-review 2, st_01a0d9db): a policy-effect id starts with the same letter
// as "preflight" - a mutant that excludes every id starting with "p" from `interrupted` (instead
// of just the PREFLIGHT_ID sentinel) would wrongly drop an open policy-effect experiment and
// silently promise nothing to resume.
const OPEN_POLICY_EFFECT = [
  { ev: "run_started", evidenceDir: null },
  { ev: "preflight", ok: true },
  { ev: "experiment_started", experiment: "policy-effect", run: null },
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

// B1 (todo 18): the approval window is judged by the injected clock, not the host date. The
// product refusal after expiry still happens through the runner, on both the dry run and the live
// path, before the machine runs or anything is probed, bound or created.
for (const [name, argv] of [
  ["--dry-run", (fx) => ["--dry-run", "--approval", fx.approval, "--evidence", fx.evidence]],
  ["live", (fx) => ["--approval", fx.approval, "--evidence", fx.evidence]],
]) {
  test(`B1 ${name}: an injected now after approvalExpiresAt refuses approval_expired, exit 2, nothing run`, async (t) => {
    const fx = fixture(t)
    const h = harness({ now: () => EXPIRES_AT + 60_000 })
    assert.equal(await main(argv(fx), h.io), EXIT.PREFLIGHT)
    const s = h.summary()
    assert.ok(s.issues.includes("approval_expired"), JSON.stringify(s.issues))
    assert.equal(s.resumable, false)
    assert.equal(s.paidRequestsIssued, 0)
    assert.equal(h.calls.runMachine, 0)
    assert.equal(h.calls.probeCli.length, 0)
    assert.equal(h.calls.startProxy, 0)
    assert.equal(existsSync(fx.evidence), false)
  })
}

test("B1 an injected now before approvedAt refuses approval_in_future, exit 2", async (t) => {
  const fx = fixture(t)
  const h = harness({ now: () => APPROVED_AT - 60_000 })
  assert.equal(await main(["--dry-run", "--approval", fx.approval, "--evidence", fx.evidence], h.io), EXIT.PREFLIGHT)
  assert.ok(h.summary().issues.includes("approval_in_future"), JSON.stringify(h.summary().issues))
  assert.equal(h.calls.runMachine, 0)
})

test("B1 the dry run hands the machine the injected clock, so preflight judges the same instant", async (t) => {
  const fx = fixture(t)
  let seenNow = null
  const h = harness({ runMachine: async (deps) => { seenNow = deps.clock.now(); return { v: SUMMARY_VERSION, runId: "dry-run", exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: null, paidRequestsIssued: 0, schedule: [] } } })
  assert.equal(await main(["--dry-run", "--approval", fx.approval, "--evidence", fx.evidence], h.io), EXIT.OK)
  assert.equal(seenNow, NOW_IN_WINDOW)
})

test("B1 the live path hands the machine the injected clock and names the run from it", async (t) => {
  const fx = fixture(t)
  let seen = null
  const h = harness({ runMachine: async (deps, approval, opts) => { seen = { now: deps.clock.now(), runId: opts.runId }; return { v: SUMMARY_VERSION, runId: opts.runId, exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: opts.evidenceDir, paidRequestsIssued: 0 } } })
  assert.equal(await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io), EXIT.OK)
  assert.deepEqual(seen, { now: NOW_IN_WINDOW, runId: "20260926-000000" })
  assert.equal(JSON.parse(readFileSync(join(fx.evidence, "20260926-000000", "run.json"), "utf8")).startedAt, "2026-09-26T00:00:00.000Z")
})

test("fresh-window is echoed only when requested and recorded in the live manifest", async (t) => {
  const fx = fixture(t)
  const output = () => ({ v: SUMMARY_VERSION, runId: "dry-run", exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: null, paidRequestsIssued: 0, schedule: [] })
  const plain = harness({ runMachine: async () => output() })
  assert.equal(await main(["--dry-run", "--approval", fx.approval, "--evidence", fx.evidence], plain.io), EXIT.OK)
  const flagged = harness({ runMachine: async (deps, approval, opts) => { assert.equal(opts.freshWindow, true); return output() } })
  assert.equal(await main(["--dry-run", "--fresh-window", "--approval", fx.approval, "--evidence", fx.evidence], flagged.io), EXIT.OK)
  assert.equal(flagged.stdout.join("").replace("# fresh-window: true\n", ""), plain.stdout.join(""))
  assert.match(flagged.stdout.join(""), /# fresh-window: true/)
  const live = harness({ runMachine: async (deps, approval, opts) => { assert.equal(opts.freshWindow, true); return { ...output(), runId: opts.runId, evidenceDir: opts.evidenceDir } } })
  assert.equal(await main(["--fresh-window", "--approval", fx.approval, "--evidence", fx.evidence], live.io), EXIT.OK)
  assert.equal(JSON.parse(readFileSync(join(fx.evidence, "20260926-000000", "run.json"), "utf8")).freshWindow, true)
})

test("resume preserves a recorded fresh-window gate even if the flag is omitted", async (t) => {
  const fx = fixture(t)
  const runId = "prior-run"
  const dir = seedRun(fx, runId, [{ ev: "run_started" }])
  const file = join(dir, "run.json")
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), freshWindow: true }, null, 2)}\n`)
  let seen = false
  const h = harness({ runMachine: async (deps, approval, opts) => { seen = opts.freshWindow; return { v: SUMMARY_VERSION, runId, exitCode: EXIT.OK, experiments: {}, meters: {}, resumable: false, evidenceDir: dir, paidRequestsIssued: 0 } } })
  assert.equal(await main(["--resume", runId, "--approval", fx.approval, "--evidence", fx.evidence], h.io), EXIT.OK)
  assert.equal(seen, true)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).freshWindow, true)
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

// N1 rework (gate st_01a0da3f): RRN1 and RRN2 stand alone at the top level, not nested inside
// another test's body (a nested test() call reports as a subtest of the enclosing one and a
// failing RRN1 also fails the unrelated in-doubt test).
test("RRN1: a crash with an open policy-effect experiment exits 4, resumable (kills a mutant that excludes every id starting with 'p')", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of OPEN_POLICY_EFFECT) deps.ledger.append(e)
      throw new Error("killed mid policy-effect")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.IN_DOUBT)
  assert.equal(s.exitCode, EXIT.IN_DOUBT)
  assert.equal(s.resumable, true)
  assert.deepEqual(s.interrupted, ["policy-effect"])
  assert.deepEqual(s.inDoubt, [])
})

test("RRN2: the runner imports PREFLIGHT_ID from machine.mjs instead of redeclaring it", () => {
  assert.equal(PREFLIGHT_ID, "preflight")
  const runnerSrc = readFileSync(new URL("../scripts/idle-live-runner.mjs", import.meta.url), "utf8")
  assert.ok(runnerSrc.includes("PREFLIGHT_ID"), "runner still uses PREFLIGHT_ID")
  assert.ok(runnerSrc.includes('import { runMachine, fold, manifest, isSmokeLog, EXIT, SUMMARY_VERSION, PREFLIGHT_ID } from "./idle-live/machine.mjs"'), "imported from machine.mjs")
  assert.ok(!/const PREFLIGHT_ID\s*=/.test(runnerSrc), "no local redeclaration")
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

// RN6 (todo 12 re-review 1): "preflight" (the baseline/re-baseline quiet check) is not one of
// Appendix A's approved jobs and never gets an experiment_ended - fold()'s `expOf` still creates
// an entry for it the moment its first PING step is logged, with status "started" forever after.
// ALL_ENDED (above) never exercises this because it holds no preflight step_intent/step_result at
// all; every REAL evidence dir does. Without excluding "preflight", a crash on a log that finished
// its one real job cleanly (run_ended{exitCode:0} already written) would still show "preflight" as
// perpetually interrupted and wrongly promise exit 4 / resumable:true for a run that needs no
// resuming - a resume --resume can't act on and the operator can't trust.
const ALL_ENDED_WITH_PREFLIGHT_STEPS = [
  { ev: "run_started", evidenceDir: null },
  { ev: "step_intent", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/1", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/1", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/2", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/2", experiment: "preflight" },
  { ev: "preflight", ok: true },
  { ev: "experiment_started", experiment: "fable-write-tick", run: null },
  { ev: "step_intent", stepId: "fable-write-tick/0", experiment: "fable-write-tick" },
  { ev: "step_result", stepId: "fable-write-tick/0", experiment: "fable-write-tick" },
  { ev: "experiment_ended", experiment: "fable-write-tick", run: null, status: "valid", reason: null },
  { ev: "run_ended", exitCode: 0, reason: "complete", paidRequests: 4 },
]

test("RN6 a crash after a clean run_ended, on a log that ran real preflight baseline PINGs, exits 3 (not the stuck exit-4 'preflight' would otherwise cause)", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of ALL_ENDED_WITH_PREFLIGHT_STEPS) deps.ledger.append(e)
      throw new Error("crash after run_ended somehow (e.g. proxy.close() throwing in the finally)")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED, "preflight alone must not be read as an interrupted job")
  assert.equal(s.resumable, false)
  assert.deepEqual(s.interrupted, [], "'preflight' is excluded - it is redone fresh on any resume, never resumed by key")
  assert.deepEqual(s.issues, ["runner_crashed"])
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

// ------------------------------------------------------ todo 12 rework (gate st_01a0d9db)
// N3/B1/N4: the smoke-resume refusal must be a PURE READ, before the proxy bind, the adapter
// creation or the run.json rewrite - so a refused --resume leaves the evidence dir byte-identical.

const SMOKE_BASELINE_IN_DOUBT = [
  { ev: "run_started", evidenceDir: null, smoke: true },
  { ev: "preflight", ok: true },
  { ev: "step_intent", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/1", experiment: "preflight" },
  { ev: "step_void", stepId: "preflight/baseline/1", experiment: "preflight", reason: "unknown_issue_state", inDoubt: true },
]

test("--resume on a smoke evidence dir (baseline PING in doubt, no smoke experiment key) refuses before any proxy bind, adapter creation or run.json rewrite", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100000"
  const evidenceDir = seedRun(fx, runId, SMOKE_BASELINE_IN_DOUBT)
  const before = readFileSync(join(evidenceDir, "run.json"), "utf8")
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["smoke_not_resumable"])
  // RB1 (todo 12 re-review 1): the refusal summary reports the FOLDED counts from this evidence
  // dir's own log, not the refusal() defaults (no inDoubt key, paidRequestsIssued 0) - the one
  // in-doubt baseline PING and its one paid step_result must both be visible to the operator.
  assert.deepEqual(s.inDoubt, ["preflight/baseline/1"])
  assert.equal(s.paidRequestsIssued, 1)
  assert.equal(h.calls.startProxy, 0, "no proxy bind")
  assert.equal(h.calls.runMachine, 0, "the machine was never entered")
  assert.equal(h.calls.createAdapter.length, 0, "no adapter created")
  assert.equal(readFileSync(join(evidenceDir, "run.json"), "utf8"), before, "run.json was never rewritten")
})

test("--resume --smoke on a smoke evidence dir also refuses before any side effect", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100100"
  seedRun(fx, runId, SMOKE_BASELINE_IN_DOUBT)
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId, "--smoke"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.deepEqual(s.issues, ["smoke_not_resumable"])
  assert.deepEqual(s.inDoubt, ["preflight/baseline/1"])
  assert.equal(s.paidRequestsIssued, 1)
  assert.equal(h.calls.startProxy, 0)
  assert.equal(h.calls.runMachine, 0)
})

// RB1: the folded counts must also be correct for a COMPLETED, valid smoke (nothing in doubt),
// not only an in-doubt one - a clean log must report inDoubt:[] and its real paid total, in both
// resume modes.
const SMOKE_COMPLETED = [
  { ev: "run_started", evidenceDir: null, smoke: true },
  { ev: "preflight", ok: true },
  { ev: "step_intent", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/1", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/1", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/2", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/2", experiment: "preflight" },
  { ev: "step_intent", stepId: "smoke/write/0", experiment: "smoke" },
  { ev: "step_result", stepId: "smoke/write/0", experiment: "smoke" },
  { ev: "step_intent", stepId: "smoke/dial/1", experiment: "smoke" },
  { ev: "step_result", stepId: "smoke/dial/1", experiment: "smoke" },
  { ev: "experiment_ended", experiment: "smoke", status: "complete", reason: null, paidRequests: 5 },
  { ev: "run_ended", exitCode: 0, reason: "complete", paidRequests: 5 },
]

test("RB1 --resume on a COMPLETED smoke evidence dir refuses with inDoubt:[] and the real paid total, not the refusal() defaults", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100150"
  seedRun(fx, runId, SMOKE_COMPLETED)
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.deepEqual(s.issues, ["smoke_not_resumable"])
  assert.deepEqual(s.inDoubt, [])
  assert.equal(s.paidRequestsIssued, 5)
})

test("RB1 --resume --smoke on a COMPLETED smoke evidence dir refuses with inDoubt:[] and the real paid total", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100160"
  seedRun(fx, runId, SMOKE_COMPLETED)
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId, "--smoke"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.deepEqual(s.issues, ["smoke_not_resumable"])
  assert.deepEqual(s.inDoubt, [])
  assert.equal(s.paidRequestsIssued, 5)
})

test("N4 --resume --smoke on a NON-smoke (campaign) evidence dir refuses exit 2, before any side effect", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100200"
  seedRun(fx, runId, IN_DOUBT_STEP) // no run_started.smoke - a real campaign log
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId, "--smoke"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.PREFLIGHT)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["smoke_resume_of_campaign"])
  assert.equal(h.calls.startProxy, 0)
  assert.equal(h.calls.runMachine, 0)
})

// Note 14 (todo 18): only a missing events.jsonl means "not a smoke log". Any other read error
// (here: the path is a directory) refuses the resume with a named issue before any proxy bind,
// adapter or machine run, and claims no paid count.
test("N14 --resume on an evidence dir whose events.jsonl cannot be read refuses event_log_unreadable before any side effect", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100400"
  const evidenceDir = seedRun(fx, runId, IN_DOUBT_STEP)
  rmSync(join(evidenceDir, "events.jsonl"))
  mkdirSync(join(evidenceDir, "events.jsonl"))
  const runJson = readFileSync(join(evidenceDir, "run.json"), "utf8")
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.deepEqual(s.issues, ["event_log_unreadable"])
  assert.equal(s.resumable, false)
  assert.equal(s.paidRequestsIssued, null)
  assert.equal(typeof s.logError, "string")
  assert.equal(h.calls.startProxy, 0)
  assert.equal(h.calls.runMachine, 0)
  assert.deepEqual(h.calls.createAdapter, [])
  assert.equal(readFileSync(join(evidenceDir, "run.json"), "utf8"), runJson, "run.json was never rewritten")
})

// RN3 (todo 12 re-review 1): the evidence dir is built entirely from this file's own committed
// fixtures/generators (SMOKE_BASELINE_IN_DOUBT + representative sibling-file content written
// in-test) - no untracked or out-of-repo absolute path (the earlier version of this test read
// another worktree's ignored w1 evidence, which fails in a fresh checkout that lacks that sibling
// worktree; see test/quota-analysis.test.mjs's realRawAvailable()/t.skip precedent for the
// alternative this test avoids needing).
test("N3 a refused --resume on a self-contained smoke evidence dir leaves every file byte-identical", async (t) => {
  const fx = fixture(t)
  const runId = "20260926-100300"
  const evidenceDir = seedRun(fx, runId, SMOKE_BASELINE_IN_DOUBT)
  // Representative sibling files a real smoke evidence dir also holds, written directly (not
  // copied from anywhere) so the byte-identical check covers more than just events.jsonl/run.json.
  writeFileSync(join(evidenceDir, "proxy.jsonl"), `${JSON.stringify({ ts: "2026-09-26T10:00:00.000Z", label: "preflight/baseline/0", stepId: "preflight/baseline/0", runId, method: "POST", path: "/v1/messages", status: 200 })}\n`)
  writeFileSync(join(evidenceDir, "label.txt"), "preflight/baseline/1\n")
  writeFileSync(join(evidenceDir, "requests.jsonl"), `${JSON.stringify({ v: "idle-live-request/1", runId, stepId: "preflight/baseline/0", experiment: "preflight", method: "POST", path: "/v1/messages" })}\n`)
  writeFileSync(join(evidenceDir, "summary.json"), `${JSON.stringify({ v: SUMMARY_VERSION, runId, exitCode: EXIT.ABORTED }, null, 2)}\n`)
  const hashesOf = () => new Map(readdirSync(evidenceDir).map((f) => [f, sha256(readFileSync(join(evidenceDir, f)))]))
  const before = hashesOf()
  const h = harness()
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--resume", runId], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.deepEqual(s.issues, ["smoke_not_resumable"])
  assert.deepEqual([...hashesOf().entries()].sort(), [...before.entries()].sort(), "every file in the evidence dir is byte-identical after the refusal")
})

// N7: the runner's own crash classification (used when the MACHINE throws mid-flight, not on a
// --resume attempt) must not promise exit 4 resumable:true for a smoke dir just because it holds
// an in-doubt or open step.
const SMOKE_CRASH_IN_DOUBT = [
  { ev: "run_started", evidenceDir: null, smoke: true },
  { ev: "preflight", ok: true },
  { ev: "step_intent", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_result", stepId: "preflight/baseline/0", experiment: "preflight" },
  { ev: "step_intent", stepId: "preflight/baseline/1", experiment: "preflight" },
]

test("N7 the machine throwing mid-smoke (not a --resume attempt) is classified exit 3 resumable:false, never exit 4", async (t) => {
  const fx = fixture(t)
  const h = harness({
    runMachine: async (deps) => {
      for (const e of SMOKE_CRASH_IN_DOUBT) deps.ledger.append(e)
      throw new Error("killed mid-smoke baseline PING")
    },
  })
  const code = await main(["--approval", fx.approval, "--evidence", fx.evidence, "--smoke"], h.io)
  const s = h.summary()
  assert.equal(code, EXIT.ABORTED)
  assert.equal(s.resumable, false)
  assert.deepEqual(s.issues, ["runner_crashed", "smoke_not_resumable"])
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

// Plan todo 21a: the dry run states each output-quota block's prompt and derived gate, so the
// operator sees what a paid run would send before it sends it.
test("the dry-run table lists the output-quota prompts outp(3000) / outp(1700) with gates 6000 / 3000", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine })
  assert.equal(await main(ARGV.dry(fx), h.io), EXIT.OK)
  const blocks = h.stdout.join("").split("\n").filter((l) => l.startsWith("# output-quota/block-"))
    .map((l) => Object.fromEntries(l.slice(2).split(/\s{2,}/).slice(1).map((c) => c.split("="))))
  assert.deepEqual(blocks, [
    { arm: "out-8k", prompt: "outp(3000)", target: "8000", gateMinOutput: "6000" },
    { arm: "out-8k", prompt: "outp(3000)", target: "8000", gateMinOutput: "6000" },
    { arm: "out-4k", prompt: "outp(1700)", target: "4000", gateMinOutput: "3000", optional: "true" },
  ])
})

// Plan todo 21b: the dry run states how restore/policy send the big context.
test("the dry-run table lists the resume-sysfile argv for restore-decomposition and policy-effect", async (t) => {
  const fx = fixture(t)
  const h = harness({ runMachine })
  assert.equal(await main(ARGV.dry(fx), h.io), EXIT.OK)
  const rows = h.stdout.join("").split("\n").filter((l) => / (restore-decomposition|policy-effect)\/big-context /.test(` ${l.slice(2)} `))
    .map((l) => { const [id, ...cells] = l.slice(2).split(/\s{2,}/); return [id, Object.fromEntries(cells.map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]))] })
  assert.deepEqual(rows.map(([id]) => id), ["restore-decomposition/big-context", "policy-effect/big-context"])
  for (const [, r] of rows) {
    assert.equal(r.mode, "resume-sysfile")
    assert.equal(r.gateMiss, "resume_gate_miss")
    assert.deepEqual(r.ctx_create.split(" ").slice(0, 4), ["--append-system-prompt-file", "<file>", "--session-id", "<P>"])
    assert.deepEqual(r.later.split(" ").slice(0, 4), ["--append-system-prompt-file", "<file>", "--resume", "<P>"])
  }
  assert.ok(rows[1][1].laterRoles.split(",").includes("warm"))
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
  // todo 21b: the adapter writes and checks P files under the run's own evidence dir
  const runDir = h.calls.createAdapter[0].workDir
  assert.equal(h.calls.createAdapter[0].contextDir, join(runDir, "ctx"))
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
