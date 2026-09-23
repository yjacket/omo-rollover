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

import { main } from "../scripts/idle-live-runner.mjs"
import { EXIT, manifest } from "../scripts/idle-live/machine.mjs"
import { openLedger } from "../scripts/idle-live/ledger.mjs"

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
function harness(overrides = {}) {
  const stdout = []
  const calls = { startProxy: 0, runMachine: 0, fetch: 0 }
  const proxy = fakeProxy()
  const io = {
    stdout: (s) => stdout.push(s),
    stderr: () => {},
    startProxy: async () => { calls.startProxy += 1; return proxy },
    runMachine: async () => { calls.runMachine += 1; throw new Error("runMachine not scripted") },
    createAdapter: () => ({ capabilities: { ttlLanes: ["1h"] }, invoke: async () => { throw new Error("never invoked") } }),
    conflicting: async () => [],
    fetch: async () => { calls.fetch += 1; throw new Error("fetch not scripted") },
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
const LIVE_DEPS = ["startProxy", "runMachine", "createAdapter", "conflicting", "fetch"]
for (const missing of LIVE_DEPS) {
  test(`a test seam without ${missing} throws live_dep_not_injected before touching anything`, async (t) => {
    const fx = fixture(t)
    const io = {
      stdout: () => {},
      stderr: () => {},
      startProxy: async () => { throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }) },
      runMachine: async () => { throw new Error("never reached") },
      createAdapter: () => ({ capabilities: {}, invoke: async () => { throw new Error("never invoked") } }),
      conflicting: async () => [],
      fetch: async () => { throw new Error("never fetched") },
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

test("an empty test seam throws; only the CLI (no seam at all) may use the real dependencies", async () => {
  await assert.rejects(main(["--dry-run"], {}), (e) => e.code === "live_dep_not_injected")
})
