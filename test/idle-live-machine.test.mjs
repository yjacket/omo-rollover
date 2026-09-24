// Machine + runner tests for the idle-cost live run (plan todo 5, Appendix B "Testability").
// Everything runs on injected fakes: fakeClock (virtual ms), fakeAdapter (scripted per stepId,
// pushes proxy records like the real CLI would), memoryProxy, memoryLedger. No real timer, no
// sleep, no polling, no spawn, no network. Async waits subscribe to deps.onEvent and await the
// exact event; the only real timer in this file is the failure bound of `within`, which never
// fires on a passing run (same convention as test/rollover.test.mjs).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { EXIT, SUMMARY_VERSION, campaignStopOf, runMachine, sequence, fold, preflight, manifest } from "../scripts/idle-live/machine.mjs"
import { RULES, EXPERIMENT_IDS, makeTask } from "../scripts/idle-live/protocols.mjs"
import { METERS } from "../scripts/idle-live/gauge.mjs"
import { openLedger } from "../scripts/idle-live/ledger.mjs"
// Read-only: M7 asserts the landed analyzer can resolve ground truth from `experiment_started`.
import { analyzeRun } from "../scripts/idle-live-analyze.mjs"
import { proxyLogReader } from "../scripts/idle-live-runner.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const APPROVAL_PATH = join(repo, "docs/idle-experiments-approval-2026-09-23.json")
const PROPOSAL_PATH = join(repo, "docs/idle-experiments-approval-proposal.json")
const PLANNER_PATH = join(repo, "scripts/idle-experiments.mjs")
const APPROVAL = JSON.parse(readFileSync(APPROVAL_PATH, "utf8"))
const PROPOSAL_JSON = readFileSync(PROPOSAL_PATH, "utf8")
const PLANNER_SRC = readFileSync(PLANNER_PATH, "utf8")
const SHAS = { plannerSha256: sha256(PLANNER_SRC), proposalSha256: sha256(PROPOSAL_JSON) }

const MODEL = "claude-fable-5-1"
const EPOCH = Date.UTC(2026, 8, 24, 0, 0, 0) // fixed virtual start: deterministic evidence
const RESET_5H = Math.floor((EPOCH + 12 * 3600_000) / 1000) // far enough out that the clean run never crosses it
const RESET_7D = Math.floor((EPOCH + 5 * 86400_000) / 1000)
const T_TOKENS = 89_000 // fake truth: write tokens per 5h tick (Appendix A's H8 point; WRITE-2400 = 0.79 tick)
const READ_TOKENS = 5_400_000
const OUT_RATIO = 2.5
const clone = (v) => JSON.parse(JSON.stringify(v))
const approvalWith = (over) => ({ ...clone(APPROVAL), ...over })

// Await a deferred signal with a failure bound (test/rollover.test.mjs convention).
const within = (p, ms = 5000) => {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("signal never fired")), ms) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}

// ------------------------------------------------------------------ fakeClock

// Virtual ms. sleep() jumps straight to the wake it was asked for (the machine sleeps
// sequentially), so a 5-hour protocol costs no wall time and `now()` stays deterministic.
function fakeClock(start = EPOCH) {
  let now = start
  let sleeps = 0
  let slept = 0
  return {
    now: () => now,
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { code: "aborted" }))
      if (!(ms > 0)) return Promise.resolve()
      sleeps += 1
      slept += ms
      now += ms
      return Promise.resolve()
    },
    set(ms) { now = ms },
    stats: () => ({ sleeps, slept }),
  }
}

// ----------------------------------------------------------------- memoryProxy

function memoryProxy({ port = 41999, runId = "fake" } = {}) {
  const records = []
  const history = [] // proxy.jsonl lines a previous (crashed) process wrote: readable, not drainable
  let closed = false
  return {
    port,
    runId,
    logPath: "<memory>",
    records,
    history,
    push(rec) { records.push(rec) },
    seed(rec) { history.push(rec) },
    async drainSince(cursor = 0) { return { records: records.slice(cursor), cursor: records.length } },
    async readLog() { return [...history, ...records] },
    async close() { closed = true },
    closed: () => closed,
  }
}

// ---------------------------------------------------------------- memoryLedger

// Same contract as scripts/idle-live/ledger.mjs openLedger(), in memory: seq per append,
// event.ts wins over the wall clock, torn tails impossible.
function memoryLedger(dir = "<memory>") {
  const events = []
  const requests = []
  const cli = new Map()
  let summary = null
  return {
    dir,
    events,
    requests,
    cli,
    append(event) {
      const rec = { seq: events.length, ts: "1970-01-01T00:00:00.000Z", ...event }
      events.push(rec)
      return rec
    },
    fold() { return { events: events.slice(), torn: false, lastSeq: events.length ? events[events.length - 1].seq : -1 } },
    tail(n) { return events.slice(Math.max(0, events.length - n)) },
    writeRequestRecord(record) { requests.push(record) },
    readRequests() { return requests.slice() },
    writeCli(stepId, obj) { cli.set(stepId, obj); return `<memory>/cli/${stepId}.json` },
    readCli(stepId) {
      if (!cli.has(stepId)) throw Object.assign(new Error("no cli artifact"), { code: "ENOENT" })
      return cli.get(stepId)
    },
    writeSummary(s) { summary = s },
    readSummary() { return summary },
  }
}

// ------------------------------------------------------------------ fake gauge

// One shared cost accumulator drives every meter, exactly as a real account would: the unified
// gauge shows floor(cumulative / 0.01) per meter, only moves when a paid call costs enough, and
// rolls its window (util back to 0, new epoch) once the clock passes the reset.
const q = (x) => Math.round(x * 100) / 100
const secToMs = (s) => s * 1000
function fakeGauge({ clock, start = { "unified-5h": 0.3, "unified-7d": 0.65, "unified-7d_oi": 0.62 }, resets = { "unified-5h": RESET_5H, "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D }, divisor = { "unified-5h": 1, "unified-7d": 8, "unified-7d_oi": 4.5 }, status = "allowed", accStart = 0, omitMeters = [], windowMs = 5 * 3600_000 } = {}) {
  let acc = accStart
  const base = { ...start }
  const zero = {}
  for (const m of METERS) zero[m] = accStart
  const g = {
    status,
    resets: { ...resets },
    omit: new Set(omitMeters),
    acc: () => acc,
    add(cost) { acc += cost },
    // A delayed tick: move the accumulator onto the next whole 5h tick.
    nudgeToTick() { acc = Math.ceil(acc + 1e-9) },
    bumpMeter(meter, eq) { base[meter] = q(base[meter] + eq) }, // foreign traffic on one meter
    // The WHOLE world, so a resumed process can continue the one the crash left - the fractional
    // tick phase included. Restarting from a rounded utilization is a different world.
    snapshot: () => ({ acc, base: { ...base }, zero: { ...zero }, resets: { ...g.resets }, status: g.status }),
    restore(s) {
      acc = s.acc
      Object.assign(base, s.base)
      Object.assign(zero, s.zero)
      g.resets = { ...s.resets }
      g.status = s.status
    },
    setReset(meter, epochSec) { g.resets[meter] = epochSec; zero[meter] = acc; base[meter] = 0 },
    rollWindow(meter) { g.setReset(meter, Math.floor((clock.now() + windowMs) / 1000)) },
    headers(extra = {}) {
      const h = { "anthropic-ratelimit-unified-status": g.status }
      for (const m of METERS) {
        if (clock.now() >= secToMs(g.resets[m])) g.rollWindow(m)
        if (g.omit.has(m)) continue
        const id = m.replace("unified-", "")
        h[`anthropic-ratelimit-unified-${id}-utilization`] = q(base[m] + Math.floor((acc - zero[m]) / divisor[m]) * 0.01).toFixed(2)
        h[`anthropic-ratelimit-unified-${id}-reset`] = String(g.resets[m])
        h[`anthropic-ratelimit-unified-${id}-status`] = g.status
      }
      return { ...h, ...extra }
    },
  }
  return g
}

// ---------------------------------------------------------------- fakeAdapter

const usage = ({ inp = 12, w5 = 0, w1 = 0, rd = 0, out = 4 } = {}) => ({
  input_tokens: inp,
  cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  cache_read_input_tokens: rd,
  output_tokens: out,
  service_tier: "standard",
})
const costOf = (u) => (u ? (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) / T_TOKENS + (u.input_tokens ?? 0) / T_TOKENS + (u.cache_read_input_tokens ?? 0) / READ_TOKENS + (u.output_tokens ?? 0) * OUT_RATIO / T_TOKENS : 0)
const LINE_TOKENS = 29.4
const HOT = 145_655 // a hot 4800-line prefix read

// Usage per step shape (Appendix A section 0 table).
function usageFor(step) {
  const lines = step.prompt?.fillerLines ?? 0
  switch (step.kind) {
    case "ping":
      return usage({ rd: 3437, out: 4 })
    case "dial":
      return usage({ rd: HOT, out: 6 })
    case "write":
      return usage({ w1: Math.round(lines * LINE_TOKENS), rd: 3, out: 20 })
    case "check":
      // TTL outcome: treatment renews (HIT), control expires (MISS).
      return step.arm === "treatment"
        ? usage({ rd: Math.round(RULES.ttl.lines * LINE_TOKENS) + 3000, w1: 0, out: 8 })
        : usage({ w1: Math.round(RULES.ttl.lines * LINE_TOKENS), rd: 3, out: 8 })
    case "probe":
      if (step.experiment === "ttl-1h-unique-prefix") return usage({ rd: Math.round(RULES.ttl.lines * LINE_TOKENS) + 3000, out: 6 })
      return usage({ rd: HOT, out: 6 }) // resume gate + warm pings on the big context
    case "work":
      if (step.experiment === "output-quota") return usage({ rd: 3800, out: step.expect?.outputTokensTarget ?? 8000 })
      if (step.role === "park_parent") return usage({ rd: HOT, w1: 12, out: 1200 })
      if (step.role === "r1") return usage({ inp: step.prompt?.tokensEst ?? 400, rd: 0, out: 200 })
      if (step.phase === "restore_child") return usage({ rd: 4000 + (step.index % 10) * 50, out: 60 })
      if (step.phase === "useful_work" && step.session?.mode === "resume" && step.arm !== "raw_path" && step.arm !== "current_policy") {
        return usage({ rd: 4500 + (step.k ?? 0) * 60, out: 30 })
      }
      return usage({ rd: HOT, w1: 12, out: 30 }) // big-context work / resume_raw
    default:
      return usage({ rd: 3437, out: 4 })
  }
}

// The assistant text the protocol scores (only for needsText steps). Correct by construction
// so the fake run is a clean, fully-scored experiment.
function textFor(step, tasks) {
  const task = tasks.get(`${step.experiment}/${step.unit?.index ?? 1}`) ?? null
  if (!task) return "OK"
  const g = task.guardAnswer
  switch (step.role) {
    case "park_parent":
      return [
        `Goal: close ticket ${task.ticket}.`,
        `Key facts: ticket ${task.ticket}; record id ${g.id}; site ${g.site}; date ${g.date}; alert threshold ${g.threshold}.0 C.`,
        `Decision: ${task.decision}`,
        `Next step: ${task.nextStep}`,
        "Done so far: read the brief and the log. To do next: score the windows the operator sends.",
      ].join("\n")
    case "r1":
      return `ticket ${task.ticket}\nrecord id ${g.id}\nsite ${g.site}\ndate ${g.date}\nthreshold ${g.threshold}`
    case "r2":
      return `Next step: ${task.nextStep} I have everything I need; nothing is missing.`
    case "guard":
    case "resume_raw":
      return `${g.id}, ${g.site}, ${g.threshold}`
    case "work": {
      const w = task.workSteps.find((s) => s.k === step.k)
      return w ? (w.truth.length ? w.truth.join(", ") : "none") : "none"
    }
    default:
      return "OK"
  }
}

/**
 * fakeAdapter: scripted per stepId. Every invoke pushes exactly one proxy record (the CLI's
 * one /v1/messages call) unless the script says otherwise, and moves the fake gauge by the
 * cost of the usage it reports.
 * script[stepId] = { usage, headers, model, stop_reason, status, exitCode, error, is_error,
 *                    stdoutJson, records (0|2), nudgeTick, bump: {meter, eq}, hang, gaugeStatus }
 */
function fakeAdapter({ proxy, gauge, script = {}, capabilities = { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model: MODEL }, clock } = {}) {
  const invoked = []
  const tasks = new Map()
  let msg = 0
  // Resolved the moment a hanging invoke is entered, so a cancellation test can subscribe to the
  // in-flight signal BEFORE it starts the run.
  let enter
  const entered = new Promise((resolve) => { enter = resolve })
  return {
    capabilities,
    invoked,
    tasks,
    entered,
    async invoke(step, env, signal) {
      invoked.push({ id: step.id, stepHeader: env?.stepHeader ?? null, baseUrl: env?.baseUrl ?? null, at: clock.now() })
      // The landed adapter refuses to spawn once the signal is aborted (adapters/claude-cli.mjs),
      // so a cancelled campaign can never reach the API again. The attempt is still recorded in
      // `invoked`, so a machine that issues after a cancel is visible to a test.
      if (signal?.aborted) throw Object.assign(new Error("aborted before spawn"), { code: "aborted" })
      const s = script[step.id] ?? {}
      if (s.hang) {
        enter(step.id)
        // The landed adapter (scripts/idle-live/adapters/claude-cli.mjs) RESOLVES a structured
        // abort - it kills the child and reports {error:{code:"aborted"},stdoutJson:null,
        // exitCode:null}. `hang:"throw"` keeps the rejecting variant (spawn failure).
        return await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            if (s.hang === "throw") reject(Object.assign(new Error("aborted"), { code: "aborted" }))
            else resolve({ exitCode: null, signal: "SIGTERM", stdoutJson: null, stdoutHead: null, stderrHead: "", startedMs: clock.now(), endedMs: clock.now(), error: { code: "aborted", message: "claude killed on abort (signal SIGTERM)" } })
          }, { once: true })
        })
      }
      if (step.role === "ctx_create" && Number.isInteger(step.seed)) {
        tasks.set(`${step.experiment}/${step.unit.index}`, makeTask(step.seed, { steps: step.experiment === "policy-effect" ? RULES.policy.workSteps : RULES.restore.workSteps }))
      }
      const startedMs = clock.now()
      const u = s.usage === undefined ? usageFor(step) : s.usage
      if (s.nudgeTick) gauge.nudgeToTick()
      // `deferCharge`: the response is served but the gauge has not posted its cost yet - Appendix
      // A delayed accounting. The charge lands on a later call (see `bump`).
      if (!s.deferCharge) gauge.add(costOf(u))
      if (s.bump) gauge.bumpMeter(s.bump.meter, s.bump.eq)
      if (s.rollReset) gauge.rollWindow(s.rollReset === true ? "unified-5h" : s.rollReset)
      if (s.omitMeters) for (const m of s.omitMeters) gauge.omit.add(m)
      const dropMeters = s.dropMeters ?? [] // this response only: the gauge headers are missing
      if (s.gaugeStatus) gauge.status = s.gaugeStatus
      msg += 1
      const text = s.text === undefined ? textFor(step, tasks) : s.text
      const rec = {
        ts_req: new Date(startedMs).toISOString(),
        ts: new Date(startedMs + 1500).toISOString(),
        label: step.id,
        stepId: step.id,
        runId: proxy.runId,
        method: "POST",
        path: "/v1/messages",
        status: s.status ?? 200,
        model: s.model ?? MODEL,
        usage: u,
        stop_reason: s.stop_reason ?? "end_turn",
        error: s.error === undefined ? (u ? null : "missing_usage") : s.error,
        msg_id: `msg_${String(msg).padStart(4, "0")}`,
        body_bytes: 512,
        headers: gauge.headers({ "request-id": `req_${String(msg).padStart(4, "0")}`, ...(s.headers ?? {}) }),
      }
      for (const m of dropMeters) {
        const id = m.replace("unified-", "")
        for (const suffix of ["utilization", "reset", "status"]) delete rec.headers[`anthropic-ratelimit-unified-${id}-${suffix}`]
      }
      const count = s.records === undefined ? 1 : s.records
      for (let i = 0; i < count; i++) proxy.push(i === 0 ? rec : { ...rec, stepId: null, label: "", msg_id: `${rec.msg_id}_extra` })
      if (s.hangAfterRow) {
        // The request reached the API and its row is in proxy.jsonl; the operator cancel then
        // kills the CLI, so the adapter reports the structured abort for a call that DID happen.
        enter(step.id)
        await new Promise((resolve) => { signal?.addEventListener("abort", resolve, { once: true }) })
        return { exitCode: null, signal: "SIGTERM", stdoutJson: null, stdoutHead: null, stderrHead: "", startedMs, endedMs: clock.now(), error: { code: "aborted", message: "claude killed on abort (signal SIGTERM)" } }
      }
      const endedMs = startedMs + 1500
      const stdoutJson = s.stdoutJson === undefined
        ? { type: "result", subtype: "success", is_error: s.is_error ?? false, result: text, session_id: step.session?.id ?? null, usage: u }
        : s.stdoutJson
      return { exitCode: s.exitCode ?? 0, signal: null, stdoutJson, stdoutHead: null, stderrHead: s.stderrHead ?? "", startedMs, endedMs, error: s.error_result ?? null }
    },
  }
}

// -------------------------------------------------------------------- harness

function harness({ approval = clone(APPROVAL), script = {}, gauge: gaugeOpts = {}, capabilities, conflicts = [], ledger = memoryLedger(), seeds = [], uuids = [], clockStart = EPOCH, opts = {}, tap = null } = {}) {
  const clock = fakeClock(clockStart)
  const gauge = fakeGauge({ clock, ...gaugeOpts })
  const proxy = memoryProxy({ runId: opts.runId ?? "fake-run" })
  const adapter = fakeAdapter({ proxy, gauge, script, capabilities, clock })
  const events = []
  const logs = []
  const listeners = new Set()
  let seedN = 0
  let uuidN = 0
  const deps = {
    clock,
    adapter,
    proxy,
    ledger,
    processes: { conflicting: async () => conflicts },
    random: {
      seed: () => (seedN < seeds.length ? seeds[seedN++] : 1000 + seedN++),
      uuid: () => (uuidN < uuids.length ? uuids[uuidN++] : `uuid-${String(++uuidN).padStart(2, "0")}`),
    },
    log: (line) => logs.push(line),
    onEvent: (e) => { events.push(e); tap?.(e); for (const l of [...listeners]) l(e) },
  }
  const runOpts = { runId: "fake-run", evidenceDir: ledger.dir, baseUrl: `http://127.0.0.1:${proxy.port}`, ...SHAS, ...opts }
  return {
    deps, clock, gauge, proxy, adapter, ledger, events, logs, approval, runOpts,
    // Subscribe BEFORE triggering, then await the exact event (no polling, no sleep).
    on(pred) {
      return new Promise((resolve) => {
        const hit = events.find(pred)
        if (hit) return resolve(hit)
        const l = (e) => { if (pred(e)) { listeners.delete(l); resolve(e) } }
        listeners.add(l)
      })
    },
    run: (over = {}) => runMachine(deps, approval, { ...runOpts, ...over }),
    pre: (over = {}) => preflight(deps, approval, { ...runOpts, ...over }),
    ev: (name) => events.filter((e) => e.ev === name),
    ids: () => adapter.invoked.map((i) => i.id),
  }
}

const tmp = (name) => mkdtempSync(join(tmpdir(), `idle-live-${name}-`))

// ==================================================================== group A
// sequence, preflight, approval refusal matrix, capability skip, dry run

test("sequence re-orders the approved plan per Appendix A section 6: restore run 1 first, ttl last", () => {
  const jobs = sequence(APPROVAL)
  assert.deepEqual(jobs.map((j) => [j.experiment, j.run ?? null]), [
    ["restore-decomposition", 1],
    ["fable-write-tick", null],
    ["output-quota", null],
    ["policy-effect", null],
    ["restore-decomposition", 2],
    ["ttl-1h-unique-prefix", null],
  ])
  assert.deepEqual(sequence(APPROVAL, ["ttl-1h-unique-prefix"]).map((j) => j.experiment), ["ttl-1h-unique-prefix"])
  assert.deepEqual(sequence(APPROVAL, ["nope"]), [])
  assert.deepEqual(new Set(sequence(APPROVAL).map((j) => j.experiment)), new Set(EXPERIMENT_IDS))
})

test("preflight passes on the signed approval and refuses every broken approval (no paid call)", async () => {
  const ok = harness()
  const pre = await ok.pre()
  assert.equal(pre.ok, true, `unexpected issues: ${JSON.stringify(pre.issues)}`)
  assert.deepEqual(pre.issues, [])
  assert.equal(ok.adapter.invoked.length, 0)
  assert.equal(ok.ev("preflight").length, 1)
  assert.equal(ok.ev("preflight")[0].ok, true)

  const matrix = [
    ["not_approved", { status: "proposed" }],
    ["approval_expired", { approvalExpiresAt: "2026-09-22T00:00:00Z" }],
    ["approval_in_future", { approvedAt: "2026-12-01T00:00:00Z" }],
    ["model_mismatch", { target: { ...clone(APPROVAL.target), modelId: "claude-other-1" } }],
    ["planner_sha_drift", { plannerSha256: "0".repeat(64) }],
    ["proposal_sha_drift", { proposalSha256: "0".repeat(64) }],
    ["order_mismatch", { order: ["fable-write-tick"] }],
    ["unknown_cap_semantics", { capSemantics: "literal_one_call" }],
  ]
  for (const [issue, over] of matrix) {
    const h = harness({ approval: approvalWith(over) })
    const p = await h.pre()
    assert.equal(p.ok, false, issue)
    assert.ok(p.issues.includes(issue), `${issue} missing from ${JSON.stringify(p.issues)}`)
    const summary = await h.run()
    assert.equal(summary.exitCode, EXIT.PREFLIGHT, issue)
    assert.equal(summary.v, SUMMARY_VERSION)
    assert.ok(summary.issues.includes(issue))
    assert.equal(h.adapter.invoked.length, 0, `${issue} must not issue a paid call`)
    assert.equal(h.ledger.requests.length, 0)
  }
})

test("preflight refuses when another claude.exe is running", async () => {
  const h = harness({ conflicts: [{ image: "claude.exe", pid: 4242 }] })
  const p = await h.pre()
  assert.equal(p.ok, false)
  assert.ok(p.issues.includes("conflicting_process"))
  assert.deepEqual(p.conflicts, [{ image: "claude.exe", pid: 4242 }])
  const s = await h.run()
  assert.equal(s.exitCode, EXIT.PREFLIGHT)
  assert.equal(h.adapter.invoked.length, 0)
})

test("the 5m write arm is skipped from adapter capabilities, and no 5m request is ever issued", async () => {
  const h = harness()
  const p = await h.pre()
  assert.deepEqual(p.skippedArms["fable-write-tick"], { "fable-write-5m": "adapter_capability" })
  assert.equal(h.ev("preflight")[0].skippedArms["fable-write-tick"]["fable-write-5m"], "adapter_capability")
  // the signed approval also declares the arm skipped, so a 5m-capable adapter keeps the
  // declaration; with the declaration removed, capabilities alone decide.
  const undeclared = clone(APPROVAL)
  delete undeclared.skippedArmReasons
  const wide = harness({ approval: undeclared, capabilities: { ttlLanes: ["1h", "5m"], resume: true, maxOutputTokens: null, model: MODEL } })
  const p2 = await wide.pre()
  assert.equal(p2.skippedArms["fable-write-tick"], undefined)
  const narrow = harness({ approval: undeclared })
  assert.deepEqual((await narrow.pre()).skippedArms["fable-write-tick"], { "fable-write-5m": "adapter_capability" })
})

test("--dry-run prints the schedule, issues zero paid requests and exits 0", async () => {
  const h = harness()
  const s = await h.run({ dryRun: true })
  assert.equal(s.exitCode, EXIT.OK)
  assert.equal(s.paidRequestsIssued, 0)
  assert.equal(h.adapter.invoked.length, 0)
  assert.equal(h.proxy.records.length, 0)
  const order = s.schedule.map((r) => `${r.experiment}${r.run ? `#${r.run}` : ""}`)
  assert.deepEqual(order, ["restore-decomposition#1", "fable-write-tick", "output-quota", "policy-effect", "restore-decomposition#2", "ttl-1h-unique-prefix"])
  assert.ok(order.indexOf("restore-decomposition#1") < order.indexOf("fable-write-tick"), "restore run 1 writes the dial prefix before exp 1")
  for (const row of s.schedule) {
    assert.equal(typeof row.order, "number")
    assert.equal(typeof row.unit, "string")
    assert.equal(typeof row.paidCallsExpected, "number")
    assert.equal(typeof row.paidCallsMax, "number")
    assert.equal(typeof row.expectedWallClockMs, "number")
    assert.equal(typeof row.perIdleCapEq, "number")
    assert.equal(typeof row.perPlanCapEq, "number")
    assert.ok(row.largestCall.predictedEq <= row.perIdleCapEq, `${row.experiment}: largest call must fit the per-idle cap`)
  }
  const fable = s.schedule.find((r) => r.experiment === "fable-write-tick")
  assert.equal(fable.perIdleCapEq, 0.02)
  assert.equal(fable.perPlanCapEq, 0.04)
  assert.equal(fable.unit, "block")
  assert.equal(fable.units, 2)
  assert.deepEqual(fable.skippedArms, { "fable-write-5m": "adapter_capability" })
})

test("a largest call that cannot fit its per-idle cap is a preflight refusal", async () => {
  const tight = clone(APPROVAL)
  tight.plans["restore-decomposition"].limits.maxProactiveSpendPerIdle.value = 0.01
  const h = harness({ approval: tight })
  const p = await h.pre()
  assert.equal(p.ok, false)
  assert.ok(p.issues.some((i) => i.startsWith("predicted_cost_exceeds_cap:restore-decomposition")), JSON.stringify(p.issues))
})

// ==================================================================== group B
// the step loop: gate, intent, invoke, drain, checks, result, metadata, anomalies

const ONLY_TTL = ["ttl-1h-unique-prefix"]
const TTL = "ttl-1h-unique-prefix"
const ttlId = (arm, i) => `${TTL}/${arm}/${i}`
const DIAL = { seed: 77, sessionId: "P-dial" }
const META = ["role", "unit", "n", "k", "prefix"]

function assertMetadata(o, where) {
  assert.equal(typeof o.role, "string", `${where}: role`)
  assert.ok(o.unit && typeof o.unit === "object" && ["block", "run", "pair"].includes(o.unit.kind) && Number.isInteger(o.unit.index), `${where}: unit ${JSON.stringify(o.unit)}`)
  for (const f of ["n", "k"]) assert.ok(o[f] === null || typeof o[f] === "number", `${where}: ${f}`)
  assert.ok(o.prefix === null || typeof o.prefix === "string", `${where}: prefix`)
  for (const f of META) assert.ok(Object.hasOwn(o, f), `${where}: missing ${f}`)
}

test("a timed experiment runs end to end: baselines, offsets, one record per step, valid outcome", async () => {
  const h = harness()
  const s = await h.run({ only: ONLY_TTL })
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments[TTL]))
  assert.equal(s.experiments[TTL].status, "valid")
  assert.equal(s.experiments[TTL].reason, null)
  // 3 baseline PINGs establish the meter zero, then the 10 timed TTL steps in table order.
  assert.deepEqual(h.ids(), [
    "preflight/baseline/0", "preflight/baseline/1", "preflight/baseline/2",
    ttlId("treatment", 0), ttlId("control", 1), ttlId("treatment", 2), ttlId("control", 3),
    ttlId("treatment", 4), ttlId("treatment", 5), ttlId("treatment", 6), ttlId("control", 7),
    ttlId("treatment", 8), ttlId("control", 9),
  ])
  assert.equal(s.experiments[TTL].paidRequests, 10)
  assert.equal(s.paidRequestsIssued, 13)
  // every invoke carries the step header the proxy labels on
  for (const i of h.adapter.invoked) assert.equal(i.stepHeader, i.id)
  // event order per experiment: started, then intent/result pairs, then ended
  const seq = h.events.map((e) => e.ev)
  assert.deepEqual(seq.slice(0, 3), ["run_started", "preflight", "step_intent"], "the baseline block runs before the first experiment")
  assert.equal(seq.indexOf("experiment_started"), 2 + 2 * 3, "3 baseline intent/result pairs, then the experiment")
  assert.equal(seq[seq.length - 1], "run_ended")
  assert.deepEqual(h.ev("experiment_ended").map((e) => [e.experiment, e.status]), [[TTL, "valid"]])
  assert.equal(h.ev("step_intent").length, 13)
  assert.equal(h.ev("step_result").length, 13)
  assert.equal(h.ev("step_void").length, 0)
  assert.equal(h.ev("gate_refused").length, 0)
  // the TTL table's absolute offsets are honoured from the experiment t0
  const t0 = h.ev("experiment_started").find((e) => e.experiment === TTL).t0
  const byId = new Map(h.ledger.requests.map((r) => [r.stepId, r]))
  assert.equal(byId.get(ttlId("treatment", 6)).ts_req, new Date(t0 + 6_600_000).toISOString())
  assert.equal(byId.get(ttlId("control", 9)).ts_req, new Date(t0 + 6_930_000).toISOString())
  // the outcome the protocol computed: a read at 55 min renews the 1h TTL in both runs
  const ended = h.ev("experiment_ended")[0]
  assert.deepEqual(ended.result.runs.map((r) => r.outcome), ["renews", "renews"])
  assert.deepEqual(ended.result.runs.map((r) => r.status), ["valid", "valid"])
  assert.equal(ended.parity.ok, true, JSON.stringify(ended.parity.issues))
  assert.equal(ended.parity.complete, true)
  // exactly one request record per step, with the run id and label the proxy logged
  assert.equal(h.ledger.requests.length, 13)
  for (const r of h.ledger.requests) {
    assert.equal(r.v, "idle-live-request/1")
    assert.equal(r.runId, "fake-run")
    assert.equal(r.label, r.stepId)
    assert.equal(r.model, MODEL)
    assert.equal(r.error, null)
    assert.equal(r.status, 200)
    assert.deepEqual(r.anomalies, [])
    assert.equal(typeof r.promptSha256, "string")
    assert.ok(!("text" in r) && !("prompt" in r), "prompt text and assistant text never reach requests.jsonl")
    assert.equal(typeof r.accounting.gateOk, "boolean")
    assert.equal(typeof r.accounting.spentUpperEq, "number")
    // the baseline block is ungated by design (no meter reading exists yet); everything else
    // carries the caps the gate projected against
    if (r.experiment === "preflight") assert.deepEqual([r.accounting.gated, r.accounting.caps], [false, []])
    else assert.ok(r.accounting.gated && r.accounting.caps.length >= 3, `${r.stepId} caps`)
    assert.equal(typeof r.phase_ledger.phiLo, "number")
  }
})

test("the producer metadata contract holds on every request record and every step event", async () => {
  const h = harness()
  await h.run({ only: ONLY_TTL })
  assert.ok(h.ledger.requests.length >= 13)
  for (const r of h.ledger.requests) assertMetadata(r, `record ${r.stepId}`)
  for (const e of [...h.ev("step_intent"), ...h.ev("step_result")]) assertMetadata(e, `${e.ev} ${e.stepId}`)
  // the five fields are copied verbatim from the StepRequest protocols.mjs emitted
  const check = h.ledger.requests.find((r) => r.stepId === ttlId("control", 9))
  assert.equal(check.role, "check")
  assert.deepEqual(check.unit, { kind: "run", index: 2 })
  assert.equal(check.prefix, "D")
  assert.equal(check.n, null)
  assert.equal(check.k, null)
  assert.equal(check.run, 2, "run is derivable for run/pair units")
  const intent = h.ev("step_intent").find((e) => e.stepId === ttlId("control", 9))
  for (const f of META) assert.deepEqual(intent[f], check[f], `intent.${f}`)
  const walk = h.ledger.requests.find((r) => r.stepId === "preflight/baseline/1")
  assert.equal(walk.role, "baseline_ping")
  assert.equal(walk.n, 2)
})

test("needsText steps get cli/<stepId>.json with the CLI JSON and stderr head, never the prompt", async () => {
  const h = harness()
  const s = await h.run({ only: ["restore-decomposition"], dialPrefix: DIAL })
  assert.equal(s.experiments["restore-decomposition"].status, "valid", JSON.stringify(s.experiments["restore-decomposition"]))
  const written = [...h.ledger.cli.keys()]
  // park_parent, r2, guard, 6 work (park path), resume_raw, 6 work (raw path) = 16 per run, x2
  // 17 per run: the analyzer's quality roles are park_parent, r1, r2, guard, work x6 and
  // resume_raw + work x6 on the raw path (r1 joined them with item I5)
  assert.equal(written.length, 2 * 17)
  const park = h.ledger.readCli(written.find((k) => k.endsWith("/2")))
  assert.equal(park.stepId, "restore-decomposition/park_path/2")
  assert.equal(park.exitCode, 0)
  assert.equal(park.stdoutJson.is_error, false)
  assert.ok(park.stdoutJson.result.includes("record id"))
  assert.equal(typeof park.stderrHead, "string")
  assert.ok(!JSON.stringify(park).includes("Weather station log"), "the 4800-line prompt is never written")
  // steps the protocol does not score keep no artifact
  assert.ok(!h.ledger.cli.has("restore-decomposition/shared/0"))
  // run 1 = 20 steps (the resume-hit gate included), run 2 = 19 (the mode is already known)
  assert.equal(s.experiments["restore-decomposition"].paidRequests, 39)
})

// M1: an adapter/CLI delivery failure must reach the VERDICT, not just the anomaly list. The gate
// reproduced rows adapter-error, cli-is-error, stdout-null and stdout-garbage-string all returning
// a valid experiment and exit 0 (the last one with no anomaly at all).
test("M1 adapter error, is_error, garbage stdout and missing usage leave the experiment non-valid", async () => {
  const last = ttlId("control", 9)
  const cases = [
    ["adapter_error", { error_result: { code: "nonzero_exit", message: "exit code 1" }, exitCode: 1 }],
    ["cli_is_error", { is_error: true }],
    ["cli_stdout_not_json", { stdoutJson: null, exitCode: 0 }],
    ["cli_stdout_not_json", { stdoutJson: "garbage", exitCode: 0 }], // a string is not a CLI result object
    ["usage_missing", { usage: null }],
  ]
  for (const [anomaly, script] of cases) {
    const h = harness({ script: { [last]: script } })
    const s = await h.run({ only: ONLY_TTL })
    const rec = h.ledger.requests.find((r) => r.stepId === last)
    const ev = h.ev("step_result").find((e) => e.stepId === last)
    const label = `${anomaly} ${JSON.stringify(script)}`
    assert.ok(rec.anomalies.includes(anomaly), `${label}: anomalies ${JSON.stringify(rec.anomalies)}`)
    assert.equal(ev.clean, false, `${label}: step must not be clean`)
    assert.notEqual(s.experiments[TTL].status, "valid", `${label}: experiment must not be valid`)
    assert.ok(["void", "aborted"].includes(s.experiments[TTL].status), `${label}: ${s.experiments[TTL].status}`)
    assert.ok(typeof s.experiments[TTL].reason === "string" && s.experiments[TTL].reason.length > 0, `${label}: needs a reason`)
    assert.ok(!s.experiments[TTL].reason.includes("null"), label)
  }
  // the evidence of the failed call is still recorded, and the adapter error is carried verbatim
  const err = harness({ script: { [last]: { error_result: { code: "nonzero_exit", message: "exit code 1" }, exitCode: 1 } } })
  const s = await err.run({ only: ONLY_TTL })
  assert.equal(err.ledger.requests.find((r) => r.stepId === last).adapterError.code, "nonzero_exit")
  assert.equal(s.experiments[TTL].reason, "adapter_error")
  assert.equal(s.exitCode, EXIT.OK, "a void experiment with a reason is still terminal")
  const noUsage = harness({ script: { [last]: { usage: null } } })
  const s2 = await noUsage.run({ only: ONLY_TTL })
  assert.equal(noUsage.ledger.requests.find((r) => r.stepId === last).usage, null)
  assert.equal(s2.experiments[TTL].status, "void")
})

test("a second request inside one step aborts the experiment and stops the campaign", async () => {
  const h = harness({ script: { [ttlId("treatment", 4)]: { records: 2 } } })
  const s = await h.run({ only: ONLY_TTL })
  assert.equal(s.experiments[TTL].status, "aborted")
  assert.equal(s.experiments[TTL].reason, "unexpected_request_count")
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(h.ids().at(-1), ttlId("treatment", 4), "no further paid call after the mismatch")
  const rec = h.ledger.requests.find((r) => r.stepId === ttlId("treatment", 4))
  assert.ok(rec.anomalies.includes("unexpected_request_count"))
  assert.equal(rec.accounting.requestCount, 2)
})

test("a refusal stops the campaign before the next run starts", async () => {
  const h = harness({ script: { "restore-decomposition/park_path/3": { stop_reason: "refusal" } } })
  const s = await h.run({ only: ["restore-decomposition"], dialPrefix: DIAL })
  assert.equal(s.experiments["restore-decomposition"].status, "aborted")
  assert.equal(s.experiments["restore-decomposition"].reason, "refusal")
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(h.ev("experiment_started").length, 1, "run 2 never starts")
  assert.equal(h.ev("campaign_stop").length, 1)
  assert.equal(h.ev("campaign_stop")[0].reason, "refusal")
  assert.equal(h.ids().at(-1), "restore-decomposition/park_path/3")
})

test("a model that is not echoed and a non-allowed status abort the experiment", async () => {
  const wrong = harness({ script: { [ttlId("control", 1)]: { model: "claude-other-1" } } })
  const a = await wrong.run({ only: ONLY_TTL })
  assert.equal(a.experiments[TTL].reason, "model_mismatch")
  assert.equal(a.exitCode, EXIT.ABORTED)
  const blocked = harness({ script: { [ttlId("control", 1)]: { gaugeStatus: "blocked" } } })
  const b = await blocked.run({ only: ONLY_TTL })
  assert.equal(b.experiments[TTL].reason, "status_not_allowed")
  assert.equal(blocked.ids().at(-1), ttlId("control", 1))
})

test("a cap trip refuses the step before invoking, aborts and exits 3", async () => {
  const tight = clone(APPROVAL)
  tight.plans[TTL].limits.maxProactiveSpendPerIdle.value = 0.01
  const h = harness({ approval: tight })
  const s = await h.run({ only: ONLY_TTL })
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.experiments[TTL].status, "aborted")
  assert.equal(s.experiments[TTL].reason, "cap_exceeded")
  const refused = h.ev("gate_refused")
  assert.equal(refused.length, 1)
  assert.ok(refused[0].reasons.some((r) => r.code === "cap_exceeded" && r.scope.startsWith("idle:")))
  const refusedId = refused[0].stepId
  assert.ok(!h.ids().includes(refusedId), "the refused step is never invoked")
  assert.ok(h.ledger.requests.every((r) => r.stepId !== refusedId))
})

test("the predictive gate refuses an unpredictable oversized call without invoking", async () => {
  // Priors that price writes but not reads: preflight still admits the plan (its largest calls
  // are writes), and the first read-priced 58.8K call has no basis above the 20K unpriced bound.
  const h = harness()
  const s = await h.run({ only: ONLY_TTL, priors: { cacheWrite1h: [102000, 143000] } })
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.experiments[TTL].reason, "unpredictable_call")
  assert.equal(h.ev("gate_refused").length, 1)
  assert.equal(h.ev("gate_refused")[0].stepId, ttlId("treatment", 4), "the 55-min A ping is read-priced")
  assert.ok(h.ev("gate_refused")[0].reasons.some((r) => r.code === "unpredictable_call" && r.tokens > 20000))
  assert.ok(!h.ids().includes(ttlId("treatment", 4)), "the unpredictable call is never issued")
  assert.equal(h.ids().length, 3 + 4, "the four writes were predictable, the read was not")
})

test("a reset epoch change inside a block voids the experiment and never stitches the windows", async () => {
  const h = harness({ gauge: { accStart: 0.95 }, script: { "fable-write-tick/fable-write-1h/2": { rollReset: true } } })
  const s = await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.equal(s.experiments["fable-write-tick"].status, "void")
  assert.equal(s.experiments["fable-write-tick"].reason, "reset_in_block")
  assert.equal(s.exitCode, EXIT.OK)
  const rec = h.ledger.requests.find((r) => r.stepId === "fable-write-tick/fable-write-1h/2")
  assert.ok(rec.anomalies.includes("reset_changed"))
  assert.equal(rec.accounting.sameWindow, false)
  assert.equal(s.meters["unified-5h"].windows, 2, "the window is closed, not stitched")
  assert.ok(s.meters["unified-5h"].cumulativeUpperEq >= 0.02)
})

test("a gauge decrease inside one reset epoch is an anomaly", async () => {
  const h = harness({ script: { [ttlId("treatment", 4)]: { bump: { meter: "unified-5h", eq: -0.02 } } } })
  await h.run({ only: ONLY_TTL })
  const rec = h.ledger.requests.find((r) => r.stepId === ttlId("treatment", 4))
  assert.ok(rec.anomalies.includes("gauge_decreased_same_epoch"), JSON.stringify(rec.anomalies))
  assert.ok(h.ev("step_result").find((e) => e.stepId === ttlId("treatment", 4)).anomalies.includes("gauge_decreased_same_epoch"))
})

test("gauge movement beyond the predicted bound is gauge_moved_without_own_call and counts as spend", async () => {
  const h = harness({ script: { [ttlId("control", 1)]: { bump: { meter: "unified-5h", eq: 0.05 } } } })
  const s = await h.run({ only: ONLY_TTL })
  const rec = h.ledger.requests.find((r) => r.stepId === ttlId("control", 1))
  assert.ok(rec.anomalies.includes("gauge_moved_without_own_call"), JSON.stringify(rec.anomalies))
  assert.ok(rec.accounting.unexplainedTicks >= 4)
  assert.ok(s.meters["unified-5h"].cumulativeUpperEq >= 0.05, "unexplained movement is counted as spend")
})

test("the campaign stop rule on 7d_oi stops the run with exit 3", async () => {
  const h = harness({ script: { [ttlId("treatment", 0)]: { bump: { meter: "unified-7d_oi", eq: 0.11 } } } })
  const s = await h.run({ only: ONLY_TTL })
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(h.ev("campaign_stop").length, 1)
  assert.equal(h.ev("campaign_stop")[0].meter, "unified-7d_oi")
  assert.equal(s.experiments[TTL].status, "aborted")
  assert.equal(s.experiments[TTL].reason, "campaign_stop")
  assert.ok(h.ids().length <= 5, `stopped early, issued ${h.ids().length}`)
})

test("the scheduler places the 5h reset between blocks and re-baselines after it", async () => {
  const resetAt = Math.floor((EPOCH + 60 * 60_000) / 1000)
  const h = harness({ gauge: { accStart: 0.95, resets: { "unified-5h": resetAt, "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } } })
  const s = await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.equal(s.experiments["fable-write-tick"].status, "valid", JSON.stringify(s.experiments["fable-write-tick"]))
  const waits = h.ev("reset_wait")
  assert.equal(waits.length, 1)
  assert.equal(waits[0].experiment, "fable-write-tick")
  assert.equal(waits[0].untilMs, resetAt * 1000 + 120_000)
  const order = h.events.filter((e) => ["step_result", "reset_wait"].includes(e.ev))
  const w = order.findIndex((e) => e.ev === "reset_wait")
  assert.equal(order[w - 1].unit.index, 1)
  assert.equal(order.slice(w + 1).find((e) => e.experiment === "fable-write-tick").unit.index, 2)
  assert.ok(h.ids().includes("preflight/rebaseline/0"), "a PING re-baselines the new window")
  assert.equal(s.meters["unified-5h"].windows, 2)
  for (const r of h.ledger.requests) assert.ok(!r.anomalies.includes("reset_changed"), `${r.stepId} straddles the reset`)
  const ended = h.ev("experiment_ended")[0]
  assert.deepEqual(ended.result.blocks.map((b) => b.status), ["valid", "valid"])
  assert.equal(ended.parity.complete, true)
})

test("a meter the response never carries is recorded as absent, not as 0", async () => {
  const h = harness({ gauge: { omitMeters: ["unified-7d_oi"] } })
  const s = await h.run({ only: ONLY_TTL })
  assert.equal(s.experiments[TTL].status, "valid")
  assert.deepEqual(s.meters["unified-7d_oi"], { windows: 0, cumulativeUpperEq: null, capEq: 0.12, absent: true })
  const rec = h.ledger.requests[0]
  assert.deepEqual(rec.meters["unified-7d_oi"], { absent: true })
  assert.ok(rec.meters["unified-5h"].util > 0)
})


// ==================================================================== group C
// crash / resume / in-doubt reconciliation, fold determinism, abort, smoke

// A crash fixture built from a REAL run: keep the events up to and including one step_intent,
// so the log has an intent with no result - exactly what a crash between spawn and result leaves.
async function crashFixture({ stepId = ttlId("treatment", 4), withProxyRecord = true } = {}) {
  const first = harness()
  const s = await first.run({ only: ONLY_TTL })
  assert.equal(s.exitCode, EXIT.OK, "the fixture source run must be clean")
  const cut = first.ledger.events.findIndex((e) => e.ev === "step_intent" && e.stepId === stepId)
  assert.ok(cut > 0)
  const events = first.ledger.events.slice(0, cut + 1)
  const seen = new Set(events.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  const proxyRecords = first.proxy.records.filter((r) => seen.has(r.stepId) || (withProxyRecord && r.stepId === stepId))
  const t0 = events.find((e) => e.ev === "experiment_started" && e.experiment === TTL).t0
  // requests.jsonl and cli/ of the crashed process: written before their step_result event
  const requests = first.ledger.requests.filter((r) => seen.has(r.stepId))
  const cli = new Map([...first.ledger.cli].filter(([k]) => seen.has(k)))
  return { events, requests, cli, proxyRecords, t0, crashedAt: Date.parse(events[events.length - 1].ts), stepId }
}

function resumeHarness(fixture, { clockStart, script = {}, gauge, world, approval, opts = {} } = {}) {
  const ledger = memoryLedger()
  for (const e of fixture.events) ledger.events.push(e)
  for (const r of fixture.requests ?? []) ledger.requests.push(r)
  for (const [k, v] of fixture.cli ?? []) ledger.cli.set(k, v)
  const h = harness({ ledger, script, gauge, approval, opts, clockStart: clockStart ?? fixture.crashedAt + 1000 })
  // An EXACT-WORLD resume: the new process finds the gauge exactly as the crashed one left it,
  // fractional tick phase and window epochs included. Anything less is a different world, and a
  // summary difference would say more about the harness than about the machine.
  if (world) h.gauge.restore(world)
  for (const r of fixture.proxyRecords) h.proxy.seed(r) // proxy.jsonl from the crashed process
  return h
}

test("a crashed step with a proxy record is reconciled from the proxy and never re-invoked", async () => {
  const fx = await crashFixture({ withProxyRecord: true })
  const h = resumeHarness(fx)
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const reconciled = h.ev("step_result").find((e) => e.stepId === fx.stepId)
  assert.ok(reconciled, "the in-doubt step gets a synthesized result")
  assert.equal(reconciled.source, "proxy_reconciled")
  assert.ok(reconciled.anomalies.includes("proxy_reconciled"))
  assert.ok(!h.ids().includes(fx.stepId), "a step in doubt is NEVER re-invoked")
  assert.equal(h.ev("run_resumed").length, 1)
  // Appendix B revision 2 (4): the experiment in progress at the crash is CLOSED after the
  // reconcile. Its unissued steps are never issued - continuing it across a resume is exactly the
  // behaviour gate rounds 3-6 kept finding new ways to diverge on.
  assert.deepEqual(h.ids(), [], "and the interrupted experiment is not continued")
  assert.equal(s.experiments[TTL].status, "void")
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash")
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments[TTL]))
  assert.equal(s.resumable, false)
})

test("a crashed step without a proxy record is void, in doubt, and exits 4", async () => {
  const fx = await crashFixture({ withProxyRecord: false })
  const h = resumeHarness(fx)
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const voided = h.ev("step_void").find((e) => e.stepId === fx.stepId)
  assert.ok(voided)
  assert.equal(voided.reason, "unknown_issue_state")
  assert.equal(s.exitCode, EXIT.IN_DOUBT)
  assert.equal(s.resumable, true)
  assert.deepEqual(s.inDoubt, [fx.stepId])
  assert.equal(s.experiments[TTL].status, "void")
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash", "the crash closed it; the doubt is reported in inDoubt")
  assert.equal(h.ids().length, 0, "nothing is invoked after an unresolved in-doubt step")
})

test("a timed experiment interrupted by a crash is never stitched back together", async () => {
  // Under revision 2 there is no "late after a resume" case left to get wrong: the interrupted
  // experiment is closed outright, so a timed step whose window passed during the downtime is
  // never even considered - it simply is not issued.
  const fx = await crashFixture({ withProxyRecord: true })
  const h = resumeHarness(fx, { clockStart: fx.t0 + 3_600_000 + 90_001 })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(h.ids(), [], "no step of the interrupted run is issued after the downtime")
  assert.equal(h.ev("step_void").filter((e) => e.reason === "late_step").length, 0, "and none has to be voided as late")
  assert.equal(s.experiments[TTL].status, "void")
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash")
  assert.equal(s.exitCode, EXIT.OK, "a void experiment with a reason is terminal")
})


test("fold is deterministic and ignores a torn final line", async () => {
  const h = harness()
  await h.run({ only: ONLY_TTL })
  const text = `${h.ledger.events.map((e) => JSON.stringify(e)).join("\n")}\n`
  const a = fold(h.ledger.events)
  const b = fold(h.ledger.events)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(JSON.stringify(fold(text)), JSON.stringify(a), "text and array fold alike")
  const torn = `${text}{"seq":999,"ev":"step_int`
  assert.equal(JSON.stringify(fold(torn)), JSON.stringify(a), "a torn final line folds to the same state")
  assert.equal(a.runId, "fake-run")
  assert.equal(a.experiments[TTL].status, "valid")
  assert.deepEqual(a.inDoubt, [])
  assert.equal(a.paidRequests, 13)
  assert.equal(a.ended.exitCode, 0)
})

// M3: the real adapter RESOLVES a structured abort; only a spawn failure throws. Both must leave
// the step uncertain (the gate observed exit 0, inDoubt [] and `void:missing_record` for the
// structured shape). The in-flight signal is subscribed BEFORE the run starts.
test("M3 an aborted in-flight invoke leaves the step in doubt, thrown or structured", async () => {
  const stepId = ttlId("control", 1)
  for (const mode of ["structured", "throw"]) {
    const controller = new AbortController()
    const h = harness({ script: { [stepId]: { hang: mode === "throw" ? "throw" : true } }, opts: { signal: controller.signal } })
    const inFlight = h.adapter.entered // subscribed before the trigger, never polled
    const run = h.run({ only: ONLY_TTL })
    assert.equal(await within(inFlight), stepId, mode)
    controller.abort()
    const s = await within(run)
    assert.equal(s.exitCode, EXIT.IN_DOUBT, `${mode}: an uncertain call is exit 4`)
    assert.deepEqual(s.inDoubt, [stepId], mode)
    assert.equal(s.resumable, true, mode)
    assert.equal(h.ev("step_void").find((e) => e.stepId === stepId).reason, "unknown_issue_state", mode)
    assert.equal(h.ev("step_result").filter((e) => e.stepId === stepId).length, 0, `${mode}: no result is synthesized`)
    assert.equal(h.ids().filter((i) => i === stepId).length, 1, `${mode}: invoked once, never retried`)
    assert.equal(s.experiments[TTL].status, "void", mode)
    // the operator cancel ended the experiment (I16); the call itself stays in doubt, above
    assert.equal(s.experiments[TTL].reason, "cancelled", mode)
  }
})

test("--smoke does preflight, 3 PINGs, one WRITE-2000 and one DIAL read of it", async () => {
  const h = harness()
  const s = await h.run({ smoke: true })
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.smoke))
  assert.deepEqual(h.ids(), ["preflight/baseline/0", "preflight/baseline/1", "preflight/baseline/2", "smoke/write/0", "smoke/dial/1"])
  assert.equal(s.smoke.write.cacheWrite1h, Math.round(2000 * 29.4))
  assert.ok(s.smoke.dial.cacheRead >= 0.9 * 59_400)
  assert.equal(s.smoke.dial.hit, true)
  assert.equal(s.smoke.thresholdCacheRead, 0.9 * 59_400)
  const recs = h.ledger.requests.filter((r) => r.experiment === "smoke")
  assert.equal(recs[0].promptSha256, recs[1].promptSha256, "the dial read re-sends the write's exact bytes")
  assert.equal(h.ev("experiment_ended").find((e) => e.experiment === "smoke").status, "valid")
})

test("--smoke fails loudly when the DIAL read is not a cache hit", async () => {
  const h = harness({ script: { "smoke/dial/1": { usage: usage({ rd: 3000, w1: 58_800 }) } } })
  const s = await h.run({ smoke: true })
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.smoke.dial.hit, false)
  assert.equal(s.experiments["fable-write-tick"].status, "not_run")
  assert.equal(h.ev("experiment_ended").find((e) => e.experiment === "smoke").reason, "smoke_dial_miss")
})

// ==================================================================== group D
// the full five-experiment run, its committed evidence fixture, and the source scan

const FIXTURE = join(repo, "test/fixtures/idle-live-run/fake-run")
const FIXTURE_DIR_NAME = "test/fixtures/idle-live-run/fake-run"
// Appendix A section 6 order, with the two delayed ticks that keep the fake run realistic:
// restore run 1's end PING carries a late tick (so exp 1 chains its phase from it instead of
// walking), and output-quota block 2's last hold PING carries one (so block 3 is out of budget).
const FULL_SCRIPT = { "restore-decomposition/shared/19": { nudgeTick: true } }

function writeFixture(dir, h) {
  writeFileSync(join(dir, "proxy.jsonl"), h.proxy.records.map((r) => `${JSON.stringify(r)}\n`).join(""))
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(manifest({
    runId: "fake-run",
    evidenceDir: FIXTURE_DIR_NAME,
    approvalPath: "docs/idle-experiments-approval-2026-09-23.json",
    approvalSha256: sha256(readFileSync(APPROVAL_PATH, "utf8")),
    plannerSha256: SHAS.plannerSha256,
    proposalSha256: SHAS.proposalSha256,
    adapter: h.adapter.capabilities,
    cliVersion: "fake-adapter/1",
    order: APPROVAL.order,
    startedAt: new Date(EPOCH).toISOString(),
  }), null, 2)}\n`)
}

const FIXTURE_FILES = ["run.json", "events.jsonl", "requests.jsonl", "proxy.jsonl", "summary.json"]

test("the FULL five-experiment run completes under the fake clock and writes the committed fixture", async (t) => {
  const dir = tmp("fake-run")
  t.after(() => rmSync(dir, { recursive: true, force: true })) // no temp dir survives a failure
  const ledger = openLedger(dir)
  const h = harness({ ledger, script: FULL_SCRIPT, seeds: [4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110, 4111, 4112], uuids: ["P1", "C1", "P2", "C2", "P3", "C3", "P4", "C4", "P5", "C5", "P6", "C6"], opts: { runId: "fake-run", evidenceDir: FIXTURE_DIR_NAME } })
  const s = await h.run()
  // The campaign must fold onto the INJECTED clock: hours of modelled time, no real waiting. A
  // wall-clock bound would make this assertion depend on machine load - it passed or failed by
  // timing luck under a parallel mutation sweep - so the fact is asserted where it lives: the
  // fake clock advanced by the campaign's own span, and `machine.mjs references no process,
  // network, timer or file system` already forbids the machine a real timer.
  const modelledMs = h.deps.clock.now() - EPOCH
  assert.ok(modelledMs > 3 * 60 * 60_000, `the campaign spans hours of modelled time, got ${modelledMs}ms`)
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
  for (const id of EXPERIMENT_IDS) {
    assert.ok(["valid", "upper_bound"].includes(s.experiments[id].status), `${id}: ${JSON.stringify(s.experiments[id])}`)
  }
  assert.deepEqual(s.experiments["fable-write-tick"].skippedArms, { "fable-write-5m": "adapter_capability" })
  // the run order of Appendix A section 6, one experiment_started per job
  assert.deepEqual(h.ev("experiment_started").map((e) => `${e.experiment}${e.run ? `#${e.run}` : ""}`), [
    "restore-decomposition#1", "fable-write-tick", "output-quota", "policy-effect", "restore-decomposition#2", "ttl-1h-unique-prefix",
  ])
  assert.deepEqual(h.ev("experiment_ended").map((e) => [`${e.experiment}${e.run ? `#${e.run}` : ""}`, e.status]), [
    ["restore-decomposition#1", "valid"], ["fable-write-tick", "valid"], ["output-quota", "valid"],
    ["policy-effect", "valid"], ["restore-decomposition#2", "valid"], ["ttl-1h-unique-prefix", "valid"],
  ])
  for (const e of h.ev("experiment_ended")) assert.equal(e.parity.ok, true, `${e.experiment} parity: ${JSON.stringify(e.parity.issues)}`)
  for (const e of h.ev("experiment_ended")) assert.equal(e.parity.complete, true, `${e.experiment} incomplete`)
  // exp 1 chains its phase from exp 4's delayed tick instead of paying for a pre-walk
  const requests = ledger.readRequests()
  assert.equal(requests.filter((r) => r.role === "pre_walk").length, 0)
  // every record carries the producer metadata contract and no prompt text
  for (const r of requests) assertMetadata(r, r.stepId)
  assert.equal(h.ev("gate_refused").length, 0, "the approved plan fits its caps end to end")
  assert.equal(h.ev("step_void").length, 0)
  assert.equal(requests.length, s.paidRequestsIssued)
  assert.ok(s.meters["unified-5h"].cumulativeUpperEq < s.meters["unified-5h"].capEq)
  assert.ok(s.meters["unified-7d_oi"].cumulativeUpperEq < 0.11, "the campaign stop rule is never approached")

  writeFixture(dir, h)
  if (process.env.IDLE_LIVE_FIXTURE_UPDATE === "1") {
    rmSync(FIXTURE, { recursive: true, force: true })
    mkdirSync(join(FIXTURE, "cli"), { recursive: true })
    for (const f of FIXTURE_FILES) writeFileSync(join(FIXTURE, f), readFileSync(join(dir, f)))
    for (const f of readdirSync(join(dir, "cli"))) writeFileSync(join(FIXTURE, "cli", f), readFileSync(join(dir, "cli", f)))
  }
  // the committed fixture IS this run's output, byte for byte
  const same = (a, b) => readFileSync(a).equals(readFileSync(b)) // Buffer.equals: no megabyte diffs
  for (const f of FIXTURE_FILES) {
    assert.ok(existsSync(join(FIXTURE, f)), `fixture ${f} is missing - regenerate with IDLE_LIVE_FIXTURE_UPDATE=1`)
    assert.ok(same(join(dir, f), join(FIXTURE, f)), `${f} differs from the committed fixture - regenerate with IDLE_LIVE_FIXTURE_UPDATE=1`)
  }
  const cliFiles = readdirSync(join(dir, "cli")).sort()
  assert.deepEqual(cliFiles, readdirSync(join(FIXTURE, "cli")).sort())
  for (const f of cliFiles) assert.ok(same(join(dir, "cli", f), join(FIXTURE, "cli", f)), `cli/${f} differs from the committed fixture`)
})

test("machine.mjs references no process, network, timer or file system", () => {
  const src = readFileSync(join(repo, "scripts/idle-live/machine.mjs"), "utf8")
  // the exact list test/idle-experiments.test.mjs applies to the planner
  for (const forbidden of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:child_process", "node:worker_threads", "fetch(", "XMLHttpRequest", "setTimeout(", "setInterval(", "setImmediate(", "Atomics.wait", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "execSync", "spawnSync"]) {
    assert.ok(!src.includes(forbidden), `machine.mjs must not reference ${forbidden}`)
  }
  for (const extra of ["node:fs", "node:os", "node:path", "process.", "Date.now("]) {
    assert.ok(!src.includes(extra), `machine.mjs must not reference ${extra}`)
  }
})

// ==================================================================== group E
// the runner CLI contract: no paid path is reachable without an approved artifact

const RUNNER = join(repo, "scripts/idle-live-runner.mjs")
// The CLI is exercised as a child process (same convention as test/idle-experiments.test.mjs).
// Only the refusal paths and --dry-run are driven here: they spawn nothing and touch no network.
function cli(args, cwd = repo) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: "utf8", timeout: 60_000 })
  const lines = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("#"))
  let json = null
  try { json = JSON.parse(lines[lines.length - 1]) } catch { /* reported through .out */ }
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr, json, comments: r.stdout.split("\n").filter((l) => l.startsWith("#")) }
}

test("the runner refuses to do anything without an approved artifact", () => {
  const none = cli([])
  assert.equal(none.code, EXIT.PREFLIGHT)
  assert.equal(none.signal, null, "the CLI exits on its own")
  assert.deepEqual(none.json.issues, ["no_approval"])
  assert.equal(none.json.paidRequestsIssued, 0)

  const proposal = cli(["--approval", "docs/idle-experiments-approval-proposal.json", "--dry-run", "--evidence", "tmp/dry2"])
  assert.equal(proposal.code, EXIT.PREFLIGHT)
  assert.ok(proposal.json.issues.includes("not_approved"), JSON.stringify(proposal.json.issues))
  assert.equal(existsSync(join(repo, "tmp/dry2")), false, "a refused run creates no evidence directory")

  const bad = cli(["--nuke"])
  assert.equal(bad.code, EXIT.PREFLIGHT)
  assert.deepEqual(bad.json.issues, ["unknown_argument"])

  const unknownExperiment = cli(["--approval", APPROVAL_PATH, "--only", "nope", "--dry-run", "--evidence", "tmp/dry3"])
  assert.equal(unknownExperiment.code, EXIT.PREFLIGHT)
  assert.deepEqual(unknownExperiment.json.issues, ["unknown_experiment"])
})

test("--dry-run prints the schedule and issues nothing (approval timestamps normalised to now)", (t) => {
  // The signed artifact carries approvedAt 2026-09-23T15:50:00Z; on a host whose UTC clock has
  // not reached it the runner correctly refuses (approval_in_future), so this check uses a copy
  // with the same bytes and an approvedAt that is already past.
  const dir = tmp("cli")
  t.after(() => rmSync(dir, { recursive: true, force: true })) // no temp dir survives a failure
  const file = join(dir, "approval-now.json")
  const json = clone(APPROVAL)
  json.approvedAt = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z")
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  const dry = cli(["--dry-run", "--approval", file, "--evidence", join(dir, "evidence")])
  assert.equal(dry.code, EXIT.OK, dry.out + dry.err)
  assert.equal(dry.json.paidRequestsIssued, 0)
  assert.equal(dry.json.evidenceDirCreated, false)
  assert.equal(existsSync(join(dir, "evidence")), false)
  assert.ok(dry.comments.some((l) => l.includes("paidRequestsIssued=0")))
  const order = dry.json.schedule.map((r) => `${r.experiment}${r.run ? `#${r.run}` : ""}`)
  assert.ok(order.indexOf("restore-decomposition#1") < order.indexOf("fable-write-tick"))
  assert.deepEqual(order[order.length - 1], "ttl-1h-unique-prefix")
})

// ==================================================================== group M
// Gate remediation round 1: each test reproduces one independently observed blocker.

// M2: the gate's `reconciled-spend-cap` probe. A response recovered from proxy.jsonl was PAID
// for; its spend must reach every applicable cap scope before the next gate runs.
test("M2 a reconciled proxy response is attributed to its caps before the next gate", async () => {
  const stepId = ttlId("treatment", 0)
  const fx = await crashFixture({ stepId, withProxyRecord: true })
  // the historical response shows the 5h gauge three ticks higher in the SAME epoch: that run's
  // 0.03 per-idle cap is already spent by the call we only learn about on resume
  const row = fx.proxyRecords.find((r) => r.stepId === stepId)
  row.headers["anthropic-ratelimit-unified-5h-utilization"] = "0.33"
  const h = resumeHarness(fx)
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const reconciled = h.ev("step_result").find((e) => e.stepId === stepId)
  assert.equal(reconciled.source, "proxy_reconciled")
  assert.equal(reconciled.ticks["unified-5h"], 3, "the reconciled tick delta is measured")
  assert.equal(reconciled.accounting.spentUpperEq, 0.04, "and attributed to the run scope")
  assert.deepEqual(h.ids(), [], "and no further paid call is made")
  // Under revision 2 the interrupted experiment is closed, so the recovered spend is not tested by
  // its next step - it is tested by being IN the run's accounting: the meter carries the recovered
  // ticks, and every cap a later fresh experiment is gated against is computed from them.
  assert.equal(s.experiments[TTL].status, "void")
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash")
  assert.equal(s.meters["unified-5h"].cumulativeUpperEq, 0.04, "the recovered tick is in the cumulative meter")
  assert.equal(s.paidRequestsIssued, h.ledger.requests.length, "and the recovered call is paid for")
})

// M4: the baseline block is a paid block like any other. The gate saw a refusal on baseline/0
// followed by 12 more calls and exit 0, and a foreign tick in the quiet check ignored entirely.
test("M4 a global stop rule on a baseline PING stops the campaign before any experiment", async () => {
  const h = harness({ script: { "preflight/baseline/0": { stop_reason: "refusal" } } })
  const s = await h.run({ only: ONLY_TTL })
  assert.deepEqual(h.ids(), ["preflight/baseline/0"], "one call, then the campaign stops")
  assert.equal(h.ev("campaign_stop").length, 1)
  assert.equal(h.ev("campaign_stop")[0].reason, "refusal")
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.experiments[TTL].status, "not_run")

  const wrongModel = harness({ script: { "preflight/baseline/1": { model: "claude-other-1" } } })
  const s2 = await wrongModel.run({ only: ONLY_TTL })
  assert.deepEqual(wrongModel.ids(), ["preflight/baseline/0", "preflight/baseline/1"])
  assert.equal(s2.exitCode, EXIT.ABORTED)
  assert.equal(wrongModel.ev("campaign_stop")[0].reason, "model_mismatch")

  const blocked = harness({ script: { "preflight/baseline/2": { gaugeStatus: "blocked" } } })
  const s3 = await blocked.run({ only: ONLY_TTL })
  assert.equal(blocked.ids().length, 3)
  assert.equal(s3.exitCode, EXIT.ABORTED)
  assert.equal(blocked.ev("campaign_stop")[0].reason, "status_not_allowed")
})

test("M4 a foreign tick in the quiet check retries at 10 minutes, three attempts, then refuses", async () => {
  const bump = { bump: { meter: "unified-5h", eq: 0.01 } }
  const h = harness({ script: { "preflight/baseline/1": bump, "preflight/baseline-2/1": bump, "preflight/baseline-3/1": bump } })
  const s = await h.run({ only: ONLY_TTL })
  const retries = h.ev("quiet_retry")
  assert.equal(retries.length, 2, "two retries after the first and second failed quiet checks")
  assert.deepEqual(retries.map((e) => e.waitMs), [600_000, 600_000])
  assert.deepEqual(retries.map((e) => e.attempt), [1, 2])
  assert.equal(h.ev("quiet_check_failed").length, 1)
  assert.equal(h.ev("quiet_check_failed")[0].attempts, 3)
  assert.equal(h.ids().length, 9, "3 PINGs x 3 attempts and not one experiment call")
  assert.ok(h.ids().every((i) => i.startsWith("preflight/")), JSON.stringify(h.ids()))
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.experiments[TTL].status, "not_run")
  assert.ok(h.clock.stats().slept >= 2 * 600_000, "the retry waits on the injected clock")

  // a quiet gauge still starts the campaign on the first attempt
  const quiet = harness()
  const ok = await quiet.run({ only: ONLY_TTL })
  assert.equal(quiet.ev("quiet_retry").length, 0)
  assert.equal(ok.exitCode, EXIT.OK)
})

// M5: the gate's `I2-missing-gauge-learns-cheaper-call` probe. A response that omits the 5h gauge
// was turned into a zero-tick observation, which then priced a 141K-token context write at one
// tick instead of the prior's two and admitted a call the conservative basis refuses.
test("M5 an absent, reset or anomalous gauge reading is never a zero-tick observation", async () => {
  const tight = clone(APPROVAL)
  tight.plans["restore-decomposition"].limits.maxTotalExperimentalSpend.value = 0.02
  const h = harness({
    approval: tight,
    // the first context write reports 150K write tokens but carries no 5h gauge at all
    script: { "restore-decomposition/shared/0": { usage: usage({ w1: 150_000, rd: 3, out: 20 }), dropMeters: ["unified-5h"] } },
  })
  const s = await h.run({ only: ["restore-decomposition"], dialPrefix: DIAL })
  const first = h.ledger.requests.find((r) => r.stepId === "restore-decomposition/shared/0")
  assert.deepEqual(first.meters["unified-5h"], { absent: true }, "the missing meter is absent, not 0")
  assert.equal(first.accounting.predictionTier, 2, "the first write is priced from the prior")
  const second = "restore-decomposition/shared/100"
  assert.ok(!h.ids().includes(second), "the run-2 context write must not be admitted from an absent reading")
  const refused = h.ev("gate_refused").find((e) => e.stepId === second)
  assert.ok(refused, `no refusal; refusals seen: ${JSON.stringify(h.ev("gate_refused").map((e) => e.stepId))}`)
  assert.equal(refused.predictedTicks, 2, "the prior prices a 141K write at two ticks")
  assert.ok(refused.reasons.some((r) => r.code === "cap_exceeded" && r.scope === "plan-total:restore-decomposition"), JSON.stringify(refused.reasons))
  assert.ok(!h.ledger.requests.some((r) => r.stepId === second))
  assert.equal(s.exitCode, EXIT.ABORTED)

  // a step whose reading straddled a reset, and a step that carried any anomaly, are equally unusable
  const reset = harness({ gauge: { accStart: 0.95 }, script: { "fable-write-tick/fable-write-1h/2": { rollReset: true } } })
  await reset.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  const straddled = reset.ledger.requests.find((r) => r.stepId === "fable-write-tick/fable-write-1h/2")
  assert.equal(straddled.accounting.sameWindow, false)
  assert.ok(straddled.anomalies.includes("reset_changed"))
  assert.equal(straddled.accounting.learnedBound, false, "a reset reading never becomes a price bound")
  // ... and since R2-B4, neither does a clean one: an immediate zero delta has not settled, so
  // NO response tightens a bound in-run and every call is priced from the approved prior.
  assert.deepEqual([...new Set(reset.ledger.requests.map((r) => r.accounting.learnedBound))], [false])
})

// M6: the gate's `resume-two-proxy-records` probe. Reconciliation used `find`, so a step answered
// twice was collapsed into one row with requestCount 1 and the experiment stayed valid.
test("M6 two historical proxy rows for one in-doubt step abort the experiment", async () => {
  const stepId = ttlId("control", 9)
  const fx = await crashFixture({ stepId, withProxyRecord: true })
  const row = fx.proxyRecords.find((r) => r.stepId === stepId)
  fx.proxyRecords.push({ ...clone(row), msg_id: `${row.msg_id}_second` }) // the CLI retried under us
  const h = resumeHarness(fx)
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const ev = h.ev("step_result").find((e) => e.stepId === stepId)
  assert.equal(ev.source, "proxy_reconciled")
  assert.ok(ev.anomalies.includes("unexpected_request_count"), JSON.stringify(ev.anomalies))
  assert.equal(ev.accounting.requestCount, 2, "the complete matching set is counted")
  // The one-response rule still fires on the reconcile itself (both rows kept, both attributed);
  // the experiment's own verdict is now the crash closure, per revision 2 (4).
  assert.equal(s.experiments[TTL].status, "void")
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash")
  assert.deepEqual(h.ids(), [], "nothing is re-invoked")
  const recs = h.ledger.requests.filter((r) => r.stepId === stepId)
  assert.equal(recs.length, 2, "both responses are kept as evidence")
  assert.deepEqual(recs.map((r) => r.msgId), [row.msg_id, `${row.msg_id}_second`])
  assert.ok(recs.every((r) => r.anomalies.includes("unexpected_request_count")))
  // one row still reconciles cleanly
  const single = await crashFixture({ stepId, withProxyRecord: true })
  const h2 = resumeHarness(single)
  const s2 = await h2.run({ resume: "fake-run", only: ONLY_TTL })
  assert.equal(h2.ev("step_result").find((e) => e.stepId === stepId).accounting.requestCount, 1)
  assert.equal(s2.experiments[TTL].reason, "interrupted_by_crash", "one row reconciles cleanly, and the crash still closes the run")
})

// M7: Appendix B says `experiment_started` records {t0, baselines, seeds, sessionIds}. The draws
// were only written under `pool`, so the landed analyzer's seedOf() found nothing and every
// quality field of experiments 4 and 5 came back `ground_truth_unavailable` - the run would have
// produced no scored work at all.
test("M7 experiment_started carries top-level seeds and sessionIds the analyzer can read", async () => {
  const h = harness()
  await h.run({ only: ["restore-decomposition", "policy-effect"], dialPrefix: DIAL })
  const started = h.ev("experiment_started")
  const restore1 = started.find((e) => e.experiment === "restore-decomposition" && e.run === 1)
  assert.ok(Array.isArray(restore1.seeds) && restore1.seeds.length === 1, `seeds: ${JSON.stringify(restore1.seeds)}`)
  assert.ok(Array.isArray(restore1.sessionIds) && restore1.sessionIds.length === 2, `sessionIds: ${JSON.stringify(restore1.sessionIds)}`)
  assert.deepEqual(restore1.seeds, restore1.pool.seeds, "the top-level draws are the pool")
  assert.deepEqual(restore1.sessionIds, restore1.pool.uuids)
  assert.ok(Number.isFinite(restore1.t0) && restore1.baselines, "t0 and baselines stay")
  const policy = started.find((e) => e.experiment === "policy-effect")
  // seedOf() indexes a multi-unit experiment by position and skips any event that HAS a run key
  assert.ok(!("run" in policy), "a job that is not per-run must not carry a null run key")
  assert.equal(policy.seeds.length, 3)

  const analysis = analyzeRun(h.ledger.requests, h.ledger.events, { cli: Object.fromEntries(h.ledger.cli), runId: "fake-run" })
  const restoreRun = analysis.experiments["restore-decomposition"].findings.runs.find((r) => r.run === 1)
  assert.ok(Number.isFinite(restoreRun.quality.groundTruth.seed), `restore ground truth unresolved: ${JSON.stringify(restoreRun.quality.groundTruth)}`)
  assert.equal(restoreRun.quality.groundTruth.source, "makeTask(seed) from experiment_started")
  assert.notEqual(restoreRun.quality.park_path.guardCorrect.reason, "ground_truth_unavailable", "restore quality is unscored")
  // resolving the seed is only half of it: the analyzer must also be able to READ the answer text
  // out of cli/<stepId>.json, whose documented shape carries it in `result`.
  for (const arm of ["park_path", "raw_path"]) {
    const q = restoreRun.quality[arm]
    assert.equal(typeof q.guardCorrect.value, "boolean", `restore ${arm} guardCorrect: ${JSON.stringify(q.guardCorrect)}`)
    assert.ok(Number.isFinite(q.workCorrect.value), `restore ${arm} workCorrect: ${JSON.stringify(q.workCorrect)}`)
    assert.deepEqual(q.artifactsMissing, [], `restore ${arm}: the scorer could not read an artifact`)
  }
  const pair = analysis.experiments["policy-effect"].findings.pairs.find((p) => p.pair === 1)
  assert.ok(Number.isFinite(pair.groundTruth.seed), `policy ground truth unresolved: ${JSON.stringify(pair.groundTruth)}`)
  assert.notEqual(pair.arms.current_policy.quality.guardCorrect.reason, "ground_truth_unavailable", "policy quality is unscored")
})

// M8: a checkpoint whose `anomalies` field is not an array was normalised to [] on resume, so a
// step that had been recorded as refused, late or short replayed CLEAN and the experiment came
// out `valid` from evidence nobody can read.
test("M8 a checkpoint whose anomalies are not an array is never replayed clean", async () => {
  for (const corrupt of [null, "refusal", { 0: "refusal" }, 7]) {
    const label = JSON.stringify(corrupt) ?? "null"
    const fx = await crashFixture({ withProxyRecord: true })
    const victim = fx.events.filter((e) => e.ev === "step_result" && e.experiment === TTL)[1]
    assert.ok(Array.isArray(victim.anomalies), "the source checkpoint is well formed")
    const events = fx.events.map((e) => (e === victim ? { ...e, anomalies: corrupt } : e))
    const h = resumeHarness({ ...fx, events })
    const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
    assert.notEqual(s.experiments[TTL].status, "valid", `${label}: an unreadable checkpoint must not read as clean`)
    assert.equal(s.experiments[TTL].status, "void", label)
    // Since revision 2 the crash closure is the verdict of the interrupted experiment; the
    // malformed checkpoint no longer needs its own reason because the run is not continued from
    // it at all. What matters is unchanged: it never reads as clean, and nothing is re-issued.
    assert.equal(s.experiments[TTL].reason, "interrupted_by_crash", label)
    assert.deepEqual(h.ids(), [], `${label}: a voided experiment is not paid for again`)
    assert.deepEqual(s.inDoubt, [], `${label}: an unreadable checkpoint is not an uncertain call`)
    assert.equal(s.resumable, false, label)
  }
  // the same fixture with the field intact reaches the same place
  const ok = await crashFixture({ withProxyRecord: true })
  const s = await resumeHarness(ok).run({ resume: "fake-run", only: ONLY_TTL })
  assert.equal(s.experiments[TTL].reason, "interrupted_by_crash")
})

// M9: the runner reads the crashed process's proxy.jsonl to reconcile in-doubt steps. A torn
// FINAL line is a normal crash artifact; a corrupt line anywhere before it means rows are missing
// from the middle of the evidence, and silently skipping it hides a paid call.
test("M9 the proxy log reader ignores only a torn final line and rejects interior corruption", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "idle-proxylog-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logPath = join(dir, "proxy.jsonl")
  const row = (i) => JSON.stringify({ stepId: `s/${i}`, msg_id: `m${i}` })

  writeFileSync(logPath, `${row(1)}\n${row(2)}\n${row(3)}`) // no trailing newline, complete
  assert.equal((await proxyLogReader(logPath).records()).length, 3)

  writeFileSync(logPath, `${row(1)}\n${row(2)}\n{"stepId":"s/3","msg`) // killed mid-append
  const torn = await proxyLogReader(logPath).records()
  assert.deepEqual(torn.map((r) => r.msg_id), ["m1", "m2"], "the torn tail is dropped, the rest is read")

  writeFileSync(logPath, `${row(1)}\n{"stepId":"s/2","msg\n${row(3)}\n`) // corruption in the middle
  await assert.rejects(() => proxyLogReader(logPath).records(), (e) => {
    assert.equal(e.code, "proxy_log_corrupt")
    assert.match(e.message, /line 2/)
    return true
  }, "an interior corrupt line must never be skipped")

  assert.deepEqual(await proxyLogReader(join(dir, "absent.jsonl")).records(), [], "no log yet is not corruption")
})

test("M9 a proxy log that cannot be read leaves the resume in doubt, never short", async () => {
  const fx = await crashFixture({ withProxyRecord: true })
  const h = resumeHarness(fx)
  h.proxy.readLog = async () => { throw Object.assign(new Error("proxy.jsonl line 2 is not JSON"), { code: "proxy_log_corrupt" }) }
  await assert.rejects(h.run({ resume: "fake-run", only: ONLY_TTL }), /proxy_log_corrupt|not JSON/)
  assert.deepEqual(h.ids(), [], "nothing is invoked against evidence that cannot be read")
})

// =============================================================== group R2
// Gate remediation round 2: each test reproduces one retained variants.mjs row.



// R2-B2 (rows `M3-cancel-resume-proxy-false` / `M3-cancel-resume-proxy-true`): resume the
// machine's OWN cancellation checkpoint, not a log artificially cut at step_intent. The
// `step_void{inDoubt:true}` it wrote folded to state "void", and only state "intent" reached the
// reconciliation loop - so the uncertain step was never examined again: exit 0, inDoubt [], and a
// proxy response that showed up later was never recovered.
test("R2-B2 an unresolved issuance survives its own checkpoint and is reconciled later", async () => {
  const stepId = ttlId("control", 1)
  // the response that call would have produced, taken from an identical clean run
  const reference = harness()
  await reference.run({ only: ONLY_TTL })
  const answered = reference.proxy.records.find((r) => r.stepId === stepId)
  assert.ok(answered, "reference response")

  for (const present of [false, true]) {
    const controller = new AbortController()
    const h = harness({ script: { [stepId]: { hang: true } }, opts: { signal: controller.signal } })
    const inFlight = h.adapter.entered
    const run = h.run({ only: ONLY_TTL })
    assert.equal(await within(inFlight), stepId)
    controller.abort()
    const first = await within(run)
    assert.equal(first.exitCode, EXIT.IN_DOUBT, `${present}: the cancelled run is in doubt`)
    const checkpoint = h.ledger.events.findLast((e) => e.ev === "step_void" && e.stepId === stepId)
    assert.equal(checkpoint.inDoubt, true, "the machine checkpointed the uncertainty itself")

    // resume that complete log, with and without the response appearing in proxy.jsonl later
    const fx = {
      events: h.ledger.events,
      requests: h.ledger.requests,
      cli: h.ledger.cli,
      proxyRecords: present ? [...h.proxy.records, clone(answered)] : [...h.proxy.records],
      crashedAt: Date.parse(h.ledger.events[h.ledger.events.length - 1].ts),
    }
    const r = resumeHarness(fx)
    const again = await r.run({ resume: "fake-run", only: ONLY_TTL })
    assert.deepEqual(r.ids(), [], `${present}: an uncertain call is NEVER re-issued`)
    const reconciled = r.ev("step_result").filter((e) => e.stepId === stepId && e.source === "proxy_reconciled")
    if (present) {
      assert.equal(reconciled.length, 1, "the response that appeared later is recovered")
      assert.ok(reconciled[0].anomalies.includes("proxy_reconciled"))
      assert.deepEqual(again.inDoubt, [], "and the step is no longer uncertain")
      assert.equal(r.ledger.requests.filter((q) => q.stepId === stepId).length, 1, "its spend is recorded")
    } else {
      assert.equal(reconciled.length, 0)
      assert.equal(again.exitCode, EXIT.IN_DOUBT, "still uncertain, still exit 4")
      assert.deepEqual(again.inDoubt, [stepId])
      assert.equal(again.resumable, true, "and still resumable, on this resume and every later one")
      assert.equal(r.ev("step_void").filter((e) => e.stepId === stepId && e.inDoubt === true).length, 1)
    }
  }
})

// R2-B3 (rows `M4-rebaseline-refusal` / `-model` / `-429` / `-500`): after a planned reset wait
// the re-baseline PING is a paid call under the same global stop rules. maybeResetWait() awaited
// baselineBlock() but DISCARDED its fatal result, so runStep() walked straight on into the gate,
// the intent and the invoke of the experiment step that was waiting - one more paid call after a
// campaign stop was already written.
test("R2-B3 a stop rule on the re-baseline PING stops before the waiting step is issued", async () => {
  const resetAt = Math.floor((EPOCH + 60 * 60_000) / 1000)
  const gauge = { accStart: 0.95, resets: { "unified-5h": resetAt, "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } }
  const shapes = [
    ["refusal", { stop_reason: "refusal" }],
    ["model_mismatch", { model: "claude-other-1" }],
    ["http_error", { status: 429 }],
    ["http_error", { status: 500 }],
    ["status_not_allowed", { gaugeStatus: "blocked" }],
  ]
  for (const [reason, script] of shapes) {
    const label = `${reason} ${JSON.stringify(script)}`
    const h = harness({ gauge, script: { "preflight/rebaseline/0": script } })
    const s = await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
    const at = h.ids().indexOf("preflight/rebaseline/0")
    assert.ok(at >= 0, `${label}: the re-baseline PING must have been issued`)
    assert.deepEqual(h.ids().slice(at + 1), [], `${label}: NOT ONE call after the stop`)
    const stop = h.ev("campaign_stop")
    assert.equal(stop.length, 1, label)
    assert.equal(stop[0].reason, reason, label)
    assert.equal(s.exitCode, EXIT.ABORTED, label)
    assert.notEqual(s.experiments["fable-write-tick"].status, "valid", label)
  }
  // the same wait with a clean re-baseline still continues
  const ok = harness({ gauge })
  const s = await ok.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.equal(ok.ev("campaign_stop").length, 0)
  assert.equal(s.experiments["fable-write-tick"].status, "valid")
  assert.ok(ok.ids().indexOf("preflight/rebaseline/0") < ok.ids().length - 1, "the waiting step runs after a clean re-baseline")
})


// R2-B4 (row `M5-delayed`): Appendix A's delayed accounting means the gauge can charge a call
// several calls after it happened. An immediate same-epoch zero delta is therefore NOT proof that
// the call cost less than a tick - it is silence that has not settled yet. The machine learned a
// bound from it anyway, and the tick that arrived later came too late: the run-2 context write
// was then admitted at a learned 1-tick price (an in-run learning tier caps.mjs no longer has),
// where the prior prices it at 2 and the 0.02 plan cap refuses it.
test("R2-B4 an unsettled zero-delta reading never tightens a price bound", async () => {
  const tight = clone(APPROVAL)
  tight.plans["restore-decomposition"].limits.maxTotalExperimentalSpend.value = 0.02
  const h = harness({
    approval: tight,
    script: {
      // a 150K-token context write whose charge is not posted on its own response ...
      "restore-decomposition/shared/0": { usage: usage({ w1: 150_000, rd: 3, out: 20 }), deferCharge: true },
      // ... it lands later, on the run-1 end ping
      "restore-decomposition/shared/19": { bump: { meter: "unified-5h", eq: 0.01 } },
    },
  })
  await h.run({ only: ["restore-decomposition"], dialPrefix: DIAL })
  const first = h.ledger.requests.find((r) => r.stepId === "restore-decomposition/shared/0")
  assert.equal(first.meters["unified-5h"].sameWindow, true, "present, same window, no anomaly ...")
  assert.deepEqual(first.anomalies, [])
  assert.equal(first.accounting.ticks["unified-5h"], 0, "... and its own response shows no tick")
  assert.equal(first.accounting.learnedBound, false, "but silence that has not settled is not a measured sub-tick cost")
  // the delayed charge did arrive, on a later call
  assert.equal(h.ledger.requests.find((r) => r.stepId === "restore-decomposition/shared/19").accounting.ticks["unified-5h"], 1)
  // and the second context write is priced from the PRIOR, never from that unsettled reading
  const second = h.ledger.requests.find((r) => r.stepId === "restore-decomposition/shared/100")
  const refused = h.ev("gate_refused").find((e) => e.stepId === "restore-decomposition/shared/100")
  assert.ok(second || refused, "the run-2 context write was neither issued nor refused")
  assert.equal(second ? second.accounting.predictionTier : 2, 2, "tier 2: the prior speaks")
  assert.equal(second ? second.accounting.predictedTicksForThisCall : refused.predictedTicks, 2, "a 141K write costs two ticks under the prior")
  // no response anywhere in the campaign may claim an in-run bound
  assert.deepEqual([...new Set(h.ledger.requests.map((r) => r.accounting.learnedBound))], [false])
})

// =============================================================== group R3
// Gate remediation round 3: resume must HONOR the recorded log (Appendix B "Resume verdict
// contract", decision 2026-09-23).

// A crash fixture cut after ANY recorded event, from a run with arbitrary options - the round-2
// helper only ever cut after a protocol step's result, which is why the preflight block's
// recorded verdicts went unexamined.
async function crashAfterEvent({ script = {}, gauge, opts, runOpts = { only: ONLY_TTL }, at }) {
  const first = harness({ script, gauge, opts })
  const live = await first.run(runOpts)
  const cut = first.ledger.events.findIndex(at)
  assert.ok(cut > 0, "the cut event was never recorded")
  const events = first.ledger.events.slice(0, cut + 1)
  const seen = new Set(events.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  return {
    live,
    liveHarness: first,
    fixture: {
      events,
      requests: first.ledger.requests.filter((r) => seen.has(r.stepId)),
      cli: new Map([...first.ledger.cli].filter(([k]) => seen.has(k))),
      proxyRecords: first.proxy.records.filter((r) => seen.has(r.stepId)),
      crashedAt: Date.parse(events[events.length - 1].ts),
    },
  }
}





// R3-B2 (row `X-campaign-stop-then-operator-resume`): the summary advertised every non-zero,
// non-preflight exit as resumable, and `--resume` never read the folded `campaign_stop`. An
// operator following that advice restarted a campaign the stop rule had ended: run 2 of the
// experiment began and 19 more paid calls went out.
test("R3-B2 a recorded campaign stop is final, and only an in-doubt run is resumable", async () => {
  const stepId = "restore-decomposition/park_path/3"
  const live = harness({ script: { [stepId]: { stop_reason: "refusal" } } })
  const ls = await live.run({ only: ["restore-decomposition"], dialPrefix: DIAL })
  assert.equal(ls.exitCode, EXIT.ABORTED)
  assert.equal(live.ev("campaign_stop").length, 1)
  assert.equal(ls.resumable, false, "exit 3 is a stop, not a pause")
  assert.deepEqual(live.ev("experiment_started").map((e) => e.run ?? null), [1], "run 2 never started live")

  const h = resumeHarness({
    events: live.ledger.events,
    requests: live.ledger.requests,
    cli: live.ledger.cli,
    proxyRecords: live.proxy.records,
    crashedAt: Date.parse(live.ledger.events[live.ledger.events.length - 1].ts),
  })
  const s = await h.run({ resume: "fake-run", only: ["restore-decomposition"], dialPrefix: DIAL })
  assert.deepEqual(h.ids(), [], "resuming a stopped campaign issues NOTHING")
  assert.deepEqual(h.ev("experiment_started"), [], "and starts no further run")
  assert.equal(s.exitCode, EXIT.ABORTED, "the stop is reported again")
  assert.equal(s.resumable, false)
  assert.equal(s.stopped, "campaign_stop", "one label for one situation, live or resumed")

  // the exit-code/resumable contract itself
  const clean = await harness().run({ only: ONLY_TTL })
  assert.equal(clean.exitCode, EXIT.OK)
  assert.equal(clean.resumable, false, "exit 0 is not resumable")
  const doubt = await crashFixture({ withProxyRecord: false })
  const dh = resumeHarness(doubt)
  const ds = await dh.run({ resume: "fake-run", only: ONLY_TTL })
  assert.equal(ds.exitCode, EXIT.IN_DOUBT)
  assert.equal(ds.resumable, true, "only exit 4 is resumable")
})

// R3-B2: a run that already ended on a terminal exit code is not a resume target either.
test("R3-B2 resuming a run that already ended terminal issues nothing", async () => {
  const live = harness()
  const ls = await live.run({ only: ONLY_TTL })
  assert.equal(ls.exitCode, EXIT.OK)
  assert.ok(live.ledger.events.some((e) => e.ev === "run_ended"))
  const h = resumeHarness({
    events: live.ledger.events,
    requests: live.ledger.requests,
    cli: live.ledger.cli,
    proxyRecords: live.proxy.records,
    crashedAt: Date.parse(live.ledger.events[live.ledger.events.length - 1].ts),
  })
  // even when the resume names a job the finished run never touched: `run_ended` is terminal,
  // and re-opening it would spend outside the campaign the approval bounded.
  const s = await h.run({ resume: "fake-run", only: [TTL, "output-quota"] })
  assert.deepEqual(h.ids(), [], "a finished run is not re-run, and not extended, by a resume")
  // Since R4/M10 a closed run reports the conclusion the ORIGINAL run reached, not a label of its
  // own: this log ended `complete`, so the resumed summary says so too.
  assert.equal(s.stopped, "complete")
  assert.equal(s.experiments[TTL].status, "valid")
  assert.equal(s.resumable, false)
})

// R3-B3 (Appendix B "Resume verdict contract"): the re-baseline after a reset wait is the SAME
// three-PING bounded quiet check as preflight. A single PING cannot tell a foreign tick from this
// run's own delayed accounting, so the old one-PING re-baseline would abort a healthy campaign on
// its own charge - and could equally miss real foreign traffic it happened not to sample.
test("R3-B3 the re-baseline is a bounded three-PING quiet check, not a single PING", async () => {
  const resetAt = Math.floor((EPOCH + 60 * 60_000) / 1000)
  const gauge = { accStart: 0.95, resets: { "unified-5h": resetAt, "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } }

  // a clean reset wait re-baselines with three PINGs and proceeds
  const clean = harness({ gauge })
  const cs = await clean.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  const rebaselines = clean.ids().filter((i) => i.startsWith("preflight/rebaseline"))
  assert.deepEqual(rebaselines, ["preflight/rebaseline/0", "preflight/rebaseline/1", "preflight/rebaseline/2"])
  assert.equal(clean.ev("quiet_retry").length, 0)
  assert.equal(cs.experiments["fable-write-tick"].status, "valid")

  // One foreign tick inside the re-baseline check: retry after 10 minutes, quiet on the retry,
  // proceed. The tick is placed on the SECOND PING: the first one's delta crosses the reset
  // epoch and is unreadable by construction, so the quiet check can only read PINGs 2 and 3.
  const once = harness({ gauge, script: { "preflight/rebaseline/1": { bump: { meter: "unified-5h", eq: 0.01 } } } })
  const os = await once.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  const retries = once.ev("quiet_retry")
  assert.equal(retries.length, 1, `one retry; ids: ${JSON.stringify(once.ids().filter((i) => i.startsWith("preflight/")))}`)
  assert.equal(retries[0].waitMs, 600_000)
  assert.ok(once.ids().includes("preflight/rebaseline-2/0"), "the retry is a fresh three-PING attempt")
  assert.equal(once.ev("quiet_check_failed").length, 0)
  assert.equal(os.exitCode, EXIT.OK)
  assert.equal(os.experiments["fable-write-tick"].status, "valid", "a single foreign tick does not end a healthy campaign")

  // persistent foreign traffic: three attempts, then refuse, with zero experiment calls after it
  const bump = { bump: { meter: "unified-5h", eq: 0.01 } }
  const always = harness({ gauge, script: { "preflight/rebaseline/1": bump, "preflight/rebaseline-2/1": bump, "preflight/rebaseline-3/1": bump } })
  const as = await always.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.equal(always.ev("quiet_retry").length, 2)
  assert.equal(always.ev("quiet_check_failed").length, 1)
  assert.equal(always.ev("quiet_check_failed")[0].attempts, 3)
  assert.ok(always.clock.stats().slept >= 2 * 600_000, "the retries wait on the injected clock")
  const lastRebaseline = always.ids().lastIndexOf("preflight/rebaseline-3/2")
  assert.deepEqual(always.ids().slice(lastRebaseline + 1), [], "not one experiment call after the refusal")
  assert.equal(as.exitCode, EXIT.ABORTED)
  assert.notEqual(as.experiments["fable-write-tick"].status, "valid")
})

// =============================================================== group R4
// Gate remediation round 4. Rounds 3 and 4 each found another place where --resume re-derived
// state differently from the live path, so this round removes the divergence structurally:
// a resumed run walks the SAME loop, and every step whose outcome is already in the log is
// served from the log instead of being invoked. These tests pin the cases the gate reproduced.

const RESET_GAUGE = (mins) => ({ accStart: 0.95, resets: { "unified-5h": Math.floor((EPOCH + mins * 60_000) / 1000), "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } })
const firstExperimentCall = (ids) => ids.findIndex((i) => !i.startsWith("preflight/"))



// R4-B3 (rows `R4-B3-{rebaseline,preflight}-gauge-decrease-on-ping2`): a same-epoch DECREASE is
// not quiet. The clamp that stops a decrease cancelling a real tick also made the decrease
// itself invisible, so the block reported quiet and the campaign proceeded.
test("R4-B3 a same-epoch gauge decrease in a quiet check is not quiet", async () => {
  const drop = { bump: { meter: "unified-5h", eq: -0.01 } }
  // preflight
  const pre = harness({ script: { "preflight/baseline/1": drop } })
  await pre.run({ only: ONLY_TTL })
  const dropped = pre.ledger.requests.find((r) => r.stepId === "preflight/baseline/1")
  assert.ok(dropped.anomalies.includes("gauge_decreased_same_epoch"), JSON.stringify(dropped.anomalies))
  assert.ok(pre.ev("quiet_retry").length > 0 || pre.ev("quiet_check_failed").length > 0, "a decrease re-enters the bounded retry")
  assert.ok(firstExperimentCall(pre.ids()) !== 3, "the campaign does not proceed on an unexplained decrease")
  // re-baseline
  const gauge = RESET_GAUGE(60)
  const reb = harness({ gauge, script: { "preflight/rebaseline/1": drop } })
  await reb.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.ok(reb.ev("quiet_retry").length > 0 || reb.ev("quiet_check_failed").length > 0, "the same rule in the re-baseline block")
  assert.ok(reb.ids().some((i) => i.startsWith("preflight/rebaseline-2/")), "the retry attempt is issued")
  // and the clamp still holds: a decrease can never cancel a real tick
  const both = harness({ script: { "preflight/baseline/1": { bump: { meter: "unified-5h", eq: 0.01 } }, "preflight/baseline/2": drop } })
  await both.run({ only: ONLY_TTL })
  assert.equal(both.ev("quiet_retry")[0].ticks, 1, "the tick is not cancelled by the later decrease")
})

// R4-B4 (row `R4-B2-experiment_ended-stop-rule-then-crash-before-campaign_stop`): campaign_stop is
// appended AFTER experiment_ended, so a kill between the two left a log whose recorded verdict was
// a global stop rule with no stop event - and the resume started the next run.
test("R4-B4 a recorded stop-rule verdict stops the campaign even without its campaign_stop event", async () => {
  const stepId = "restore-decomposition/park_path/3"
  const { live, fixture, liveHarness } = await crashAfterEvent({
    script: { [stepId]: { stop_reason: "refusal" } },
    runOpts: { only: ["restore-decomposition"], dialPrefix: DIAL },
    at: (e) => e.ev === "experiment_ended" && e.experiment === "restore-decomposition",
  })
  assert.equal(live.exitCode, EXIT.ABORTED)
  // The producer now writes campaign_stop BEFORE the experiment_ended it follows from, so this
  // window no longer exists going forward. The CONSUMER rule still has to hold - for logs written
  // before that change, and for any other way the two events get separated - so the log is
  // reconstructed here: a recorded stop-rule verdict with no campaign_stop anywhere.
  const stopIdx = liveHarness.ledger.events.findIndex((e) => e.ev === "campaign_stop")
  const endIdx = liveHarness.ledger.events.findIndex((e) => e.ev === "experiment_ended")
  assert.ok(stopIdx >= 0 && stopIdx < endIdx, "the stop is appended before the verdict it follows from")
  fixture.events = fixture.events.filter((e) => e.ev !== "campaign_stop")
  assert.ok(fixture.events.some((e) => e.ev === "experiment_ended" && e.reason === "refusal"), "the verdict is in the log")
  const h = resumeHarness(fixture)
  const s = await h.run({ resume: "fake-run", only: ["restore-decomposition"], dialPrefix: DIAL })
  assert.deepEqual(h.ids(), [], "a recorded stop-rule verdict is a campaign stop: nothing is issued")
  assert.equal(s.exitCode, EXIT.ABORTED)
  // Since revision 2 nothing is walked: run 1 keeps its recorded verdict and run 2, which the
  // stop rule forbade, never starts.
  assert.deepEqual(h.ev("experiment_started").map((e) => e.run ?? null), [], "no experiment starts")
  assert.equal(s.experiments["restore-decomposition"].reason, "refusal", "run 1 keeps its recorded verdict")
})

// M10 (plan todo 5): the crash-prefix resume property. Gate rounds 3 and 4 each found another
// place where --resume re-derived state differently from the live path, one case per round. This
// test states the property those cases all violate, over whole campaigns rather than hand-picked
// cuts: cut the event log after EVERY event, resume that prefix, and require that
//   (a) no stepId is ever invoked twice across the original run plus the resume;
//   (b) a cut that leaves nothing in doubt reaches the SAME terminal summary as the
//       uninterrupted run - exit code, per-experiment status and reason, and paid calls;
//   (c) a cut that leaves a step in doubt is exit 4 or a proxy reconcile, never a re-issue.
// =============================================================== group R5
// Gate remediation round 5. The seam held - 1,274 exact-world crash prefixes re-issued nothing -
// but four resume-only branches OUTSIDE it still let a resumed run reach a different summary than
// the uninterrupted one. The binding rule for this round: resume takes no shortcut around the
// live loop, and no state from the end of the log is injected before the replay reaches the event
// that produced it.

// An exact-world crash fixture: the whole fake world is snapshotted at the cut, so the resume
// continues the world the crash left instead of a fresh one.
async function exactWorldCut({ script = {}, gauge, runOpts, at, approval }) {
  const worlds = []
  let live
  live = harness({ script, gauge, approval, tap: () => { worlds[live.ledger.events.length - 1] = live.gauge.snapshot() } })
  const summary = await live.run(runOpts)
  const cut = live.ledger.events.findIndex(at)
  assert.ok(cut > 0, "the cut event was never recorded")
  const events = live.ledger.events.slice(0, cut + 1)
  const seen = new Set(events.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  return {
    live,
    summary,
    world: worlds[cut] ?? live.gauge.snapshot(),
    fixture: {
      events,
      requests: live.ledger.requests.filter((r) => seen.has(r.stepId)),
      cli: new Map([...live.ledger.cli].filter(([k]) => seen.has(k))),
      proxyRecords: live.proxy.records.filter((r) => seen.has(r.stepId)),
      crashedAt: Date.parse(events[events.length - 1].ts),
    },
  }
}



// R5-B3 (row V11): a recorded meter-cap stop is a stop. Live, a gate refusal on a meter cap (or
// an in-doubt step) ends the campaign; on resume neither reason was in the stop set, and the
// concluded-experiment shortcut dropped the stop as well - so the resumed run PAID for a call the
// live stop had forbidden.
test("R5-B3 a recorded meter-cap stop stops the resumed campaign too", async () => {
  const capped = clone(APPROVAL)
  capped.perMeterCumulativeCaps["unified-5h"] = 0.025
  const { summary, fixture, world, live } = await exactWorldCut({
    approval: capped,
    runOpts: { only: ["restore-decomposition", ...ONLY_TTL], dialPrefix: DIAL },
    at: (e) => e.ev === "experiment_ended" && e.experiment === "restore-decomposition" && e.run === 2,
  })
  assert.equal(summary.exitCode, EXIT.ABORTED, "the live run stops on the meter cap")
  assert.ok(live.ev("gate_refused").some((e) => e.reasons.some((r) => r.code === "cap_exceeded" && String(r.scope).startsWith("meter:"))), "on a meter scope")
  const h = resumeHarness(fixture, { world, approval: capped, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ["restore-decomposition", ...ONLY_TTL], dialPrefix: DIAL })
  assert.deepEqual(h.ids(), [], "NOT ONE call after a recorded meter-cap stop")
  assert.equal(s.exitCode, summary.exitCode)
  assert.equal(s.experiments[TTL].status, summary.experiments[TTL].status, "and the later experiment is reported as the live run reported it")
  assert.equal(s.experiments[TTL].reason, summary.experiments[TTL].reason)
})


// ==================================================================== M10
// The crash-prefix resume property under Appendix B "Resume verdict contract, revision 2".
// Rounds 3-6 each found a new way for a CONTINUED experiment to diverge from the uninterrupted
// one across downtime, so continuation is gone and the property is about what the log decides:
//   (a) no stepId or PING id is ever invoked twice across the original run plus the resume;
//   (b) experiments ended before the cut keep identical verdicts, the experiment in progress is
//       void:interrupted_by_crash and issues nothing more, experiments that never started are
//       terminal, and every campaign-level stop is honored identically;
//   (c) an in-doubt cut reconciles or exits 4, never re-issues;
//   (d) no step straddles a reset epoch, and fresh quiet-check PINGs keep their 60 s spacing on
//       the real clock.

const CAP = (path, value) => { const a = clone(APPROVAL); path(a, value); return a }
const M10_CAMPAIGNS = () => [
  { name: "clean FULL five-experiment run", runOpts: { dialPrefix: DIAL } },
  { name: "two reset waits and re-baselines", gauge: { accStart: 0.95, windowMs: 40 * 60_000, resets: { "unified-5h": Math.floor((EPOCH + 10 * 60_000) / 1000), "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } }, runOpts: { only: ["fable-write-tick"], dialPrefix: DIAL }, resetWaits: 2 },
  { name: "refusal on a baseline PING", script: { "preflight/baseline/1": { stop_reason: "refusal" } }, runOpts: { only: ONLY_TTL } },
  { name: "refusal on a re-baseline PING", gauge: RESET_GAUGE(60), script: { "preflight/rebaseline/0": { stop_reason: "refusal" } }, runOpts: { only: ["fable-write-tick"], dialPrefix: DIAL }, resetWaits: 1 },
  { name: "refusal on an experiment step", script: { [ttlId("control", 3)]: { stop_reason: "refusal" } }, runOpts: { only: ONLY_TTL } },
  { name: "transient quiet-check tick", script: { "preflight/baseline/1": { bump: { meter: "unified-5h", eq: 0.01 } } }, runOpts: { only: ONLY_TTL } },
  { name: "persistent quiet-check tick", script: { "preflight/baseline/1": { bump: { meter: "unified-5h", eq: 0.01 } }, "preflight/baseline-2/1": { bump: { meter: "unified-5h", eq: 0.01 } }, "preflight/baseline-3/1": { bump: { meter: "unified-5h", eq: 0.01 } } }, runOpts: { only: ONLY_TTL } },
  { name: "gauge decrease in a quiet check", script: { "preflight/baseline/1": { bump: { meter: "unified-5h", eq: -0.01 } } }, runOpts: { only: ONLY_TTL } },
  { name: "meter-cap stop", approval: CAP((a, v) => { a.perMeterCumulativeCaps["unified-5h"] = v }, 0.025), runOpts: { only: ["restore-decomposition", ...ONLY_TTL], dialPrefix: DIAL } },
  { name: "per-idle cap trip", approval: CAP((a, v) => { a.plans["output-quota"].limits.maxProactiveSpendPerIdle.value = v }, 0.02), runOpts: { only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL } },
  { name: "per-plan cap trip", approval: CAP((a, v) => { a.plans["fable-write-tick"].limits.maxTotalExperimentalSpend.value = v }, 0.02), runOpts: { only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL } },
  { name: "reset wait inside the resume", gauge: { accStart: 0.95, windowMs: 40 * 60_000, resets: { "unified-5h": Math.floor((EPOCH + 10 * 60_000) / 1000), "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } }, runOpts: { only: ["fable-write-tick", "output-quota"], dialPrefix: DIAL }, resetWaits: 1 },
  { name: "operator cancel", cancelAt: (e) => e.ev === "step_result" && e.stepId === ttlId("treatment", 2), runOpts: { only: ONLY_TTL } },
]

const M10_MAX_CUTS = 30 // per campaign; evenly sampled when the log is longer
const verdictOfSummary = (s) => Object.fromEntries(Object.entries(s.experiments).map(([k, v]) => [k, `${v.status}:${v.reason ?? ""}`]))

async function m10LiveRun(c) {
  const worlds = []
  let live
  const controller = c.cancelAt ? new AbortController() : null
  live = harness({
    gauge: c.gauge, script: c.script, approval: c.approval,
    opts: controller ? { signal: controller.signal } : {},
    tap: (e) => {
      worlds[live.ledger.events.length - 1] = live.gauge.snapshot()
      if (c.cancelAt?.(e)) controller.abort()
    },
  })
  const summary = await live.run(c.runOpts)
  return { live, summary, worlds }
}

async function m10Resume(c, live, worlds, i, downtimeMs) {
  const cut = live.ledger.events.slice(0, i + 1)
  const seen = new Set(cut.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  const fixture = {
    events: cut,
    requests: live.ledger.requests.filter((r) => seen.has(r.stepId)),
    cli: new Map([...live.ledger.cli].filter(([k]) => seen.has(k))),
    proxyRecords: live.proxy.records.filter((r) => seen.has(r.stepId)),
    crashedAt: Date.parse(cut[cut.length - 1].ts),
  }
  const h = resumeHarness(fixture, {
    gauge: c.gauge, script: c.script, approval: c.approval,
    world: worlds[i] ?? live.gauge.snapshot(),
    clockStart: fixture.crashedAt + downtimeMs,
  })
  const s = await h.run({ resume: "fake-run", ...c.runOpts })
  return { h, s, cut, seen }
}

test("M10 crash-prefix resume under revision 2, at zero, 20 and 75 minutes of downtime", async (t) => {
  let cuts = 0
  const per = []
  for (const c of M10_CAMPAIGNS()) {
    const { live, summary, worlds } = await m10LiveRun(c)
    const events = live.ledger.events
    if (c.resetWaits) assert.ok(live.ev("reset_wait").length >= c.resetWaits, `${c.name}: expected >= ${c.resetWaits} reset waits, got ${live.ev("reset_wait").length}`)
    const liveStopped = events.some((e) => e.ev === "campaign_stop")
    const step = Math.max(1, Math.ceil(events.length / M10_MAX_CUTS))
    let n = 0
    for (let i = 0; i < events.length; i += step) {
      for (const downtimeMs of [0, 20 * 60_000, 75 * 60_000]) {
        cuts += 1
        n += 1
        const label = `${c.name} @ cut ${i + 1}/${events.length} (${events[i].ev}${events[i].stepId ? `:${events[i].stepId}` : ""}) +${downtimeMs / 60_000}m`
        const { h, s, cut, seen } = await m10Resume(c, live, worlds, i, downtimeMs)

        // (a) nothing is issued twice
        const issuedTwice = h.ids().filter((id) => cut.some((e) => e.ev === "step_intent" && e.stepId === id))
        assert.deepEqual(issuedTwice, [], `${label}: re-issued a call the log already intended; ids=${JSON.stringify(h.ids().slice(0,6))} exps=${JSON.stringify(verdictOfSummary(s))}`)
        assert.deepEqual([...new Set(h.ids())], h.ids(), `${label}: issued a call twice within the resume`)

        // (b) an experiment the CUT ended keeps its verdict, and the one in progress is closed
        const ended = new Map(cut.filter((e) => e.ev === "experiment_ended").map((e) => [`${e.experiment}#${e.run ?? ""}`, `${e.status}:${e.reason ?? ""}`]))
        // the summary aggregates an experiment's runs, so compare the ones that have a single run
        const runsOf = (id) => new Set(events.filter((e) => e.ev === "experiment_started" && e.experiment === id).map((e) => e.run ?? null))
        for (const [key, verdict] of ended) {
          const id = key.split("#")[0]
          if (runsOf(id).size !== 1 || !s.experiments[id]) continue
          assert.equal(`${s.experiments[id].status}:${s.experiments[id].reason ?? ""}`, verdict, `${label}: ${key} lost its recorded verdict`)
        }
        const started = new Set(cut.filter((e) => e.ev === "experiment_started").map((e) => `${e.experiment}#${e.run ?? ""}`))
        for (const key of started) {
          if (ended.has(key)) continue
          const id = key.split("#")[0]
          // the experiment in progress at the crash is closed and issues nothing more. The summary
          // aggregates runs, so a single-run experiment must read exactly void:interrupted_by_crash
          // and a multi-run one must at least not come back valid.
          assert.notEqual(s.experiments[id].status, "valid", `${label}: the interrupted ${key} must not be valid`)
          if (runsOf(id).size === 1) assert.equal(`${s.experiments[id].status}:${s.experiments[id].reason}`, "void:interrupted_by_crash", `${label}: ${key}`)
          assert.deepEqual(h.ids().filter((x) => x.startsWith(`${id}/`) && cut.some((e) => e.ev === "step_intent" && e.stepId === x)), [], `${label}: the interrupted ${key} issued more steps`)
        }
        // the stop holds from the DECIDING event, with or without its campaign_stop marker
        const deciding = cut.some((e) => e.ev === "campaign_stop")
          || cut.some((e) => e.ev === "quiet_check_failed")
          || cut.some((e) => e.ev === "gate_refused" && (e.reasons ?? []).some((r) => r.code === "cap_exceeded" && (String(r.scope).startsWith("meter:") || String(r.scope).startsWith("campaign-stop:"))))
          || cut.some((e) => e.ev === "step_result" && (e.anomalies ?? []).some((a) => ["refusal", "model_mismatch", "status_not_allowed", "http_error", "unexpected_request_count"].includes(a)))
        // Revision 2 (5): an experiment that never started RUNS FRESH, so it must reach a verdict of
        // its own. `not_run` is honest only while this resume can issue NOTHING - a campaign-level
        // stop recorded in the cut or taken here, or a step still in doubt. Nothing is demanded in
        // that case: the census shows a refusing resume also reports `aborted:cap_exceeded` and
        // `aborted:refusal` for experiments whose own gate or verdict decided before the stop.
        const refusing = deciding || s.inDoubt.length > 0 || h.ev("campaign_stop").length > 0
        const startedIds = new Set(cut.filter((e) => e.ev === "experiment_started").map((e) => e.experiment))
        // an experiment this campaign never scheduled (`--only`) is not "never started" - it is out
        // of the run, and `not_run` is all the summary can say about it
        const scheduled = new Set(c.runOpts?.only ?? EXPERIMENT_IDS)
        for (const [id, v] of Object.entries(s.experiments)) {
          if (startedIds.has(id) || !scheduled.has(id)) continue
          if (!refusing) {
            // A campaign that could run leaves no scheduled experiment unaccounted for. The accepted
            // set is the one these campaigns actually produce over their 927 resumes: never
            // `not_run`, and never `void` - nothing voids a FRESH experiment in any of them. In the
            // clean campaign it is the live run's own verdict, `valid` or `upper_bound` for
            // output-quota whose 5m arm the adapter cannot serve, with the one exception revision 2
            // (5) allows: the resume carries all recorded spend AND pays for its own fresh
            // preflight, so a tight per-idle cap can refuse an experiment the live run completed.
            const cappedByItsOwnScope = v.status === "aborted" && v.reason === "cap_exceeded"
              && h.ev("gate_refused").some((e) => e.experiment === id && (e.reasons ?? []).some((r) => r.code === "cap_exceeded"))
            const accepted = c.name === "clean FULL five-experiment run" ? ["valid", "upper_bound"] : ["valid", "upper_bound", "aborted"]
            assert.ok(accepted.includes(v.status) || cappedByItsOwnScope, `${label}: ${id} is ${v.status}:${v.reason}, not one of ${JSON.stringify(accepted)}`)
          }
          assert.notEqual(v.reason, "no_dial_prefix", `${label}: ${id} lost run-level state the log holds`)
        }
        if (deciding) {
          assert.deepEqual(h.ids(), [], `${label}: a recorded campaign-level stop must refuse all issuance`)
          assert.equal(s.exitCode, EXIT.ABORTED, label)
        }
        if (cut.some((e) => e.ev === "campaign_stop")) {
          assert.deepEqual(h.ids(), [], `${label}: a recorded campaign stop must refuse all issuance`)
          assert.equal(s.exitCode, EXIT.ABORTED, label)
        }
        if (liveStopped && cut.some((e) => e.ev === "campaign_stop")) {
          assert.equal(s.exitCode, summary.exitCode, `${label}: the stop is reported as the live run reported it`)
        }

        // (c) an in-doubt cut is exit 4 or a reconcile, never a re-issue
        if (s.inDoubt.length > 0) {
          assert.equal(s.exitCode, EXIT.IN_DOUBT, `${label}: in doubt must be exit 4`)
          assert.equal(s.resumable, true, label)
          for (const id of s.inDoubt) assert.ok(!h.ids().includes(id), `${label}: re-issued the in-doubt step ${id}`)
        } else {
          assert.equal(s.resumable, false, `${label}: only exit 4 is resumable`)
        }

        // (d) no step straddles a reset epoch, and fresh quiet-check PINGs keep 60 s spacing
        for (const r of h.ledger.requests) {
          if (seen.has(r.stepId)) continue
          assert.ok(!r.anomalies.includes("reset_changed"), `${label}: ${r.stepId} was issued across a reset epoch`)
        }
        const freshPings = h.ledger.requests.filter((r) => !seen.has(r.stepId) && r.stepId.startsWith("preflight/")).map((r) => Date.parse(r.ts_req))
        for (let k = 1; k < freshPings.length; k++) {
          const gap = freshPings[k] - freshPings[k - 1]
          assert.ok(gap >= 60_000 - 1, `${label}: fresh quiet-check PINGs are ${gap} ms apart, not 60 s`)
        }
      }
    }
    per.push(`${c.name}=${n}`)
  }
  t.diagnostic(`M10: ${cuts} resumes over ${M10_CAMPAIGNS().length} campaigns at 0/20/75 min downtime (${per.join(", ")})`)
  assert.ok(cuts >= 300, `expected a meaningful number of resumes, got ${cuts}`)
})

// R6-B1 (rows N7, N7c, N10, N8): the resumed stop decision was not the live one. A per-idle or
// per-plan cap trip aborts only its own experiment, live and resumed alike; an operator cancel is
// a campaign-level stop and is recorded BEFORE any cleanup, so a log truncated during the
// wind-down still says the campaign was stopped on purpose.
test("R6-B1 one stop predicate: a per-idle cap aborts its experiment, a cancel stops the campaign", async () => {
  const capped = clone(APPROVAL)
  capped.plans["output-quota"].limits.maxProactiveSpendPerIdle.value = 0.02
  const { live, summary, fixture, world } = await exactWorldCut({
    approval: capped,
    runOpts: { only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL },
    at: (e) => e.ev === "experiment_ended" && e.experiment === "output-quota",
  })
  assert.ok(live.ev("gate_refused").some((e) => e.reasons.some((r) => r.code === "cap_exceeded" && String(r.scope).startsWith("idle:"))), "the live run trips a per-idle cap")
  assert.equal(live.ev("campaign_stop").length, 0, "which is NOT a campaign-level stop")
  assert.equal(summary.experiments[TTL].status, "valid", "so the live run goes on to the next experiment")
  const h = resumeHarness(fixture, { approval: capped, world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
  assert.equal(s.experiments["output-quota"].status, summary.experiments["output-quota"].status, "the capped experiment keeps its recorded verdict")
  assert.equal(s.experiments[TTL].status, "valid", "and the experiment that never started still runs")
  assert.ok(h.ids().some((i) => i.startsWith(`${TTL}/`)), "on the real clock, after a fresh preflight")
  assert.ok(h.ids().some((i) => i.startsWith("preflight/baseline-r1/")), `the fresh preflight has its own ids: ${JSON.stringify(h.ids().slice(0, 4))}`)

  // an operator cancel inside a free wait is campaign-level and is recorded first
  const controller = new AbortController()
  const gauge = RESET_GAUGE(60)
  const cancel = harness({ gauge, opts: { signal: controller.signal }, tap: (e) => { if (e.ev === "reset_wait") controller.abort() } })
  const cs = await cancel.run({ only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL })
  const stop = cancel.ev("campaign_stop")
  assert.equal(stop.length, 1, "the cancel is recorded as a campaign stop")
  assert.equal(stop[0].reason, "cancelled")
  const idx = cancel.ledger.events.findIndex((e) => e.ev === "campaign_stop")
  const endIdx = cancel.ledger.events.findIndex((e) => e.ev === "experiment_ended")
  assert.ok(idx < endIdx, "and it is appended BEFORE any cleanup event")
  assert.equal(cs.exitCode, EXIT.ABORTED)
  // ... and a resume from a log cut before run_ended issues nothing
  const cut = cancel.ledger.events.slice(0, cancel.ledger.events.findIndex((e) => e.ev === "run_ended"))
  const seen = new Set(cut.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  const rh = resumeHarness({ events: cut, requests: cancel.ledger.requests.filter((r) => seen.has(r.stepId)), cli: new Map(), proxyRecords: cancel.proxy.records.filter((r) => seen.has(r.stepId)), crashedAt: Date.parse(cut[cut.length - 1].ts) }, { gauge })
  const rs = await rh.run({ resume: "fake-run", only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL })
  assert.deepEqual(rh.ids(), [], "a cancelled campaign issues nothing on resume")
  assert.equal(rs.exitCode, EXIT.ABORTED)
})

// R6-B2 (rows N1, N9, N2): the replay clock and the real clock met at a reset wait, so fresh
// quiet-check PINGs went out 0 s apart and a step could be issued across a reset epoch. Under
// revision 2 the interrupted experiment is closed and the next one starts fresh on the real
// clock, so there is one clock and the spacing is the live spacing.
test("R6-B2 after downtime the fresh preflight keeps 60 s spacing and no step straddles an epoch", async () => {
  const gauge = RESET_GAUGE(60)
  for (const downtime of [20 * 60_000, 75 * 60_000]) {
    const { fixture, world } = await exactWorldCut({
      gauge,
      runOpts: { only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL },
      at: (e) => e.ev === "reset_wait",
    })
    const h = resumeHarness(fixture, { gauge, world, clockStart: fixture.crashedAt + downtime })
    const s = await h.run({ resume: "fake-run", only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL })
    const label = `${downtime / 60_000} min`
    const pings = h.ledger.requests.filter((r) => r.stepId.startsWith("preflight/")).map((r) => Date.parse(r.ts_req))
    assert.ok(pings.length >= 3, `${label}: a fresh preflight runs`)
    for (let i = 1; i < pings.length; i++) {
      assert.ok(pings[i] - pings[i - 1] >= 60_000 - 1, `${label}: PINGs ${pings[i] - pings[i - 1]} ms apart, not 60 s`)
    }
    // The instrument itself must be measured inside one window: no PING of the fresh quiet check
    // may straddle the epoch. (A later experiment whose own block outlives the window is a
    // different matter - the machine voids it `reset_in_block`, exactly as it does live.)
    for (const r of h.ledger.requests.filter((x) => x.stepId.startsWith("preflight/"))) {
      assert.ok(!r.anomalies.includes("reset_changed"), `${label}: ${r.stepId} straddles a reset epoch`)
    }
    assert.equal(s.experiments["fable-write-tick"].reason, "interrupted_by_crash", `${label}: the interrupted experiment is closed`)
    assert.ok(["valid", "void"].includes(s.experiments[TTL].status), `${label}: the one that never started runs fresh and terminates: ${JSON.stringify(s.experiments[TTL])}`)
    assert.ok(h.ids().some((i) => i.startsWith(`${TTL}/`)), `${label}: and it really runs`)
  }
})

// R6-B3 (rows N5, N11): a concluded experiment's resume reached its reset wait before its
// recorded verdict was honored, and issued fresh paid PINGs - and a 10-minute quiet-retry sleep -
// for an experiment the log had already ended. Revision 2 (1): it issues nothing.
test("R6-B3 an experiment the log ended issues nothing on resume", async () => {
  const gauge = RESET_GAUGE(60)
  const { fixture, world } = await exactWorldCut({
    gauge,
    runOpts: { only: ["fable-write-tick"], dialPrefix: DIAL },
    at: (e) => e.ev === "experiment_ended" && e.experiment === "fable-write-tick",
  })
  const h = resumeHarness(fixture, { gauge, world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.deepEqual(h.ids(), [], `an ended experiment is not paid for again: ${JSON.stringify(h.ids())}`)
  assert.equal(h.ev("reset_wait").length, 0, "and its reset wait is not re-decided")
  assert.equal(h.clock.stats().slept, 0, "nor waited out again")
  const recorded = fixture.events.findLast((e) => e.ev === "experiment_ended" && e.experiment === "fable-write-tick")
  assert.equal(s.experiments["fable-write-tick"].status, recorded.status, "its recorded verdict stands")
  assert.equal(s.experiments["fable-write-tick"].reason, recorded.reason)
})

// R6-B4 (mutation iv-a): a PING whose response carries no 5h reading says NOTHING about the
// gauge. Counting it as quiet passed the whole round-5 suite, so the quiet check could be
// satisfied by silence. Revision 2 (6): missing is never quiet evidence.
test("R6-B4 a quiet-check PING without a 5h reading is not quiet evidence", async () => {
  const h = harness({ script: { "preflight/baseline/1": { dropMeters: ["unified-5h"] } } })
  await h.run({ only: ONLY_TTL })
  const blind = h.ledger.requests.find((r) => r.stepId === "preflight/baseline/1")
  assert.deepEqual(blind.meters["unified-5h"], { absent: true }, "the PING came back with no 5h reading")
  assert.ok(h.ev("quiet_retry").length > 0 || h.ev("quiet_check_failed").length > 0, "a blind PING re-enters the bounded retry")
  assert.ok(h.ids().some((i) => i.startsWith("preflight/baseline-2/")), "the attempt is repeated, not accepted")
  const firstExperiment = h.ids().findIndex((i) => !i.startsWith("preflight/"))
  assert.ok(firstExperiment !== 3, "the campaign does not start on an unmeasured instrument")
})

// =============================================================== group R7
// Appendix B "Resume verdict contract, revision 2, clarification A": the stop predicate is ONE
// pure function of the event log, `campaignStopOf(events)`. The live path decides a
// campaign-level stop only by appending the deciding event and evaluating that same function, so
// live and resume cannot hold different rules.

// R7-B1 (row i, DIAG7-i): `resetWaits` started at 0 in every process, so a resumed run that took
// its own reset wait re-issued `preflight/rebaseline/<n>` - ids the log already held. A later
// crash on such a call was then "reconciled" from the ORIGINAL call's proxy row, and an
// unresolved issuance silently disappeared.
test("R7-B1 a resumed process never issues an id the log already holds", async () => {
  const gauge = { accStart: 0.95, windowMs: 40 * 60_000, resets: { "unified-5h": Math.floor((EPOCH + 10 * 60_000) / 1000), "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D } }
  const runOpts = { only: ["fable-write-tick", "output-quota"], dialPrefix: DIAL }
  const worlds = []
  let live
  live = harness({ gauge, tap: () => { worlds[live.ledger.events.length - 1] = live.gauge.snapshot() } })
  await live.run(runOpts)
  const firstWait = live.ledger.events.findIndex((e) => e.ev === "reset_wait")
  assert.ok(firstWait > 0, "the live run takes a reset wait")
  let checked = 0
  for (let i = firstWait; i < live.ledger.events.length; i += 7) {
    for (const downtime of [0, 20 * 60_000]) {
      const cut = live.ledger.events.slice(0, i + 1)
      const seen = new Set(cut.filter((e) => e.ev === "step_result").map((e) => e.stepId))
      const recorded = new Set(cut.filter((e) => e.ev === "step_intent").map((e) => e.stepId))
      const h = resumeHarness({
        events: cut,
        requests: live.ledger.requests.filter((r) => seen.has(r.stepId)),
        cli: new Map(),
        proxyRecords: live.proxy.records.filter((r) => seen.has(r.stepId)),
        crashedAt: Date.parse(cut[cut.length - 1].ts),
      }, { gauge, world: worlds[i] ?? live.gauge.snapshot(), clockStart: Date.parse(cut[cut.length - 1].ts) + downtime })
      await h.run({ resume: "fake-run", ...runOpts })
      checked += 1
      const reused = h.ids().filter((id) => recorded.has(id))
      assert.deepEqual(reused, [], `cut ${i + 1} +${downtime / 60_000}m: re-issued ids the log already holds`)
      assert.deepEqual([...new Set(h.ids())], h.ids(), `cut ${i + 1}: issued an id twice within the resume`)
    }
  }
  assert.ok(checked >= 20, `expected a meaningful sweep, got ${checked}`)
})

// R7-B2 (retained rows V9, V9b, r7 row k): the runner never passes a dial prefix, and the fold's
// recorded one was not restored, so fable and output-quota - experiments that had never started -
// aborted `no_dial_prefix` on the runner's own resume path.
test("R7-B2 a resume inherits the recorded dial prefix, with no test-only option", async () => {
  const { summary, fixture, world, live } = await exactWorldCut({
    runOpts: { dialPrefix: DIAL },
    at: (e) => e.ev === "dial_prefix",
  })
  assert.equal(summary.exitCode, EXIT.OK)
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
  // exactly what the runner does: --resume with no dialPrefix option at all
  const s = await h.run({ resume: "fake-run" })
  for (const id of ["fable-write-tick", "output-quota"]) {
    assert.notEqual(s.experiments[id].reason, "no_dial_prefix", `${id} lost the recorded dial prefix`)
    assert.ok(["valid", "void", "upper_bound"].includes(s.experiments[id].status), `${id}: ${JSON.stringify(s.experiments[id])}`)
  }
  assert.ok(live.ev("dial_prefix").length > 0, "the log records the dial prefix")
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))

  // retained row V9: the crash falls between the producing run's last call and its `dial_prefix`
  // record. The prefix is a pure function of that run's recorded seed, so the experiments that
  // never started must still run.
  const early = await exactWorldCut({ runOpts: { dialPrefix: DIAL }, at: (e) => e.ev === "mode_set" })
  assert.ok(!early.fixture.events.some((e) => e.ev === "dial_prefix"), "the crash cut before the record")
  const eh = resumeHarness(early.fixture, { world: early.world, clockStart: early.fixture.crashedAt })
  const es = await eh.run({ resume: "fake-run" })
  for (const id of ["fable-write-tick", "output-quota"]) {
    assert.notEqual(es.experiments[id].reason, "no_dial_prefix", `${id}: the recorded seed rebuilds the prefix`)
  }
  assert.equal(es.exitCode, EXIT.OK, JSON.stringify(es.experiments))
})

// R7-B3 (rows d, e, j1, j2 and retained M6-2/M6-3, R4-B2-campaign-stop-scope, R4-B2-meter-cap):
// the resume kept its own copy of the stop rules and missed three kinds of campaign-level stop the
// live path had taken. All three are now the same pure predicate over the log.
test("R7-B3 every campaign-level stop the log records is honored on resume", async () => {
  // (b) a meter-cap gate_refused whose campaign_stop the crash cut off
  const capped = clone(APPROVAL)
  capped.perMeterCumulativeCaps["unified-5h"] = 0.02
  const meter = await exactWorldCut({
    approval: capped,
    runOpts: { only: ONLY_TTL },
    at: (e) => e.ev === "gate_refused",
  })
  assert.equal(meter.summary.exitCode, EXIT.ABORTED, "the live run stops on the meter cap")
  const mh = resumeHarness(meter.fixture, { approval: capped, world: meter.world, clockStart: meter.fixture.crashedAt })
  const ms = await mh.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(mh.ids(), [], "a recorded meter-cap refusal stops the resume before the preflight")
  assert.equal(ms.exitCode, EXIT.ABORTED)
  // retained row N3: and it stays final however often the log is resumed again
  const again = resumeHarness({
    events: mh.ledger.events,
    requests: mh.ledger.requests,
    cli: mh.ledger.cli,
    proxyRecords: mh.proxy.records,
    crashedAt: Date.parse(mh.ledger.events[mh.ledger.events.length - 1].ts),
  }, { approval: capped, world: meter.world })
  const as_ = await again.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(again.ids(), [], "a recorded stop means zero further calls, every time")
  assert.equal(as_.exitCode, EXIT.ABORTED)

  // (c) a failed quiet check, whose campaign_stop the crash cut off
  const bump = { bump: { meter: "unified-5h", eq: 0.01 } }
  const quiet = await exactWorldCut({
    script: { "preflight/baseline/1": bump, "preflight/baseline-2/1": bump, "preflight/baseline-3/1": bump },
    runOpts: { only: ONLY_TTL },
    at: (e) => e.ev === "quiet_check_failed",
  })
  assert.equal(quiet.summary.exitCode, EXIT.ABORTED)
  const qh = resumeHarness(quiet.fixture, { world: quiet.world, clockStart: quiet.fixture.crashedAt })
  const qs = await qh.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(qh.ids(), [], "a recorded quiet_check_failed stops the resume")
  assert.equal(qs.exitCode, EXIT.ABORTED)

  // (a) a response RECONCILED in this resume that carries a stop rule: the predicate is evaluated
  // after reconciliation, so the recovered refusal stops this run exactly as it stopped the live one
  const stepId = ttlId("treatment", 4)
  const fx = await crashFixture({ stepId, withProxyRecord: true })
  const row = fx.proxyRecords.find((r) => r.stepId === stepId)
  row.stop_reason = "refusal"
  const rh = resumeHarness(fx)
  const rs = await rh.run({ resume: "fake-run", only: ONLY_TTL })
  const reconciled = rh.ev("step_result").find((e) => e.stepId === stepId)
  assert.ok(reconciled.anomalies.includes("refusal"), "the recovered response carries the stop rule")
  assert.deepEqual(rh.ids(), [], "which stops the campaign: nothing is issued")
  assert.equal(rs.exitCode, EXIT.ABORTED)
  assert.equal(rh.ev("campaign_stop").length, 1, "and the marker is written")
})

// R7-B4 (row c3, DIAG7-c): a cancel that lands while a call is IN FLIGHT wrote only the step_void.
// It must be recorded first, the call must stay in doubt, and a later resume that recovers the row
// must stop the campaign.
test("R7-B4 a cancel during an in-flight call is recorded first and stops the resumed campaign", async () => {
  const stepId = ttlId("control", 1)
  const controller = new AbortController()
  const h = harness({ script: { [stepId]: { hang: true } }, opts: { signal: controller.signal } })
  const entered = h.adapter.entered
  const run = h.run({ only: ONLY_TTL })
  assert.equal(await within(entered), stepId)
  controller.abort()
  const s = await within(run)
  const stopIdx = h.ledger.events.findIndex((e) => e.ev === "campaign_stop")
  const voidIdx = h.ledger.events.findIndex((e) => e.ev === "step_void" && e.stepId === stepId)
  assert.ok(stopIdx >= 0, "the cancel is recorded")
  assert.equal(h.ledger.events[stopIdx].reason, "cancelled")
  assert.ok(stopIdx < voidIdx, "before any other write")
  assert.equal(s.exitCode, EXIT.IN_DOUBT, "and the in-flight call stays in doubt")
  assert.deepEqual(s.inDoubt, [stepId])

  // the response turns up later: the resume reconciles it and then stops, issuing nothing
  const reference = harness()
  await reference.run({ only: ONLY_TTL })
  const answered = clone(reference.proxy.records.find((r) => r.stepId === stepId))
  const rh = resumeHarness({
    events: h.ledger.events,
    requests: h.ledger.requests,
    cli: h.ledger.cli,
    proxyRecords: [...h.proxy.records, answered],
    crashedAt: Date.parse(h.ledger.events[h.ledger.events.length - 1].ts),
  })
  const rs = await rh.run({ resume: "fake-run", only: ONLY_TTL })
  assert.equal(rh.ev("step_result").filter((e) => e.source === "proxy_reconciled").length, 1, "the recovered call is reconciled")
  assert.deepEqual(rh.ids(), [], "and the cancelled campaign issues nothing")
  assert.equal(rs.exitCode, EXIT.ABORTED)
  assert.deepEqual(rs.inDoubt, [], "the doubt is settled")
})

// R7-B5 (mutations vi, vii, v-b): three behaviours that no shipped test pinned after the round-6
// deletions. Each assertion below is what the corresponding mutation breaks.
test("R7-B5 a recorded preflight delivery failure stops the resume (mutation vi)", async () => {
  const { summary, fixture, world } = await exactWorldCut({
    script: { "preflight/baseline/1": { usage: null } },
    runOpts: { only: ONLY_TTL },
    at: (e) => e.ev === "step_result" && e.stepId === "preflight/baseline/1",
  })
  assert.equal(summary.exitCode, EXIT.ABORTED, "the live run refuses: the instrument was never established")
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(h.ids(), [], "NOT ONE call after a recorded baseline delivery failure")
  assert.equal(s.exitCode, EXIT.ABORTED)
})

test("R7-B5 a recorded stop-rule step_result stops the resume (mutation vii)", async () => {
  const { summary, fixture, world } = await exactWorldCut({
    script: { "fable-write-tick/fable-write-1h/3": { stop_reason: "refusal" } },
    runOpts: { only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL },
    at: (e) => e.ev === "step_result" && e.stepId === "fable-write-tick/fable-write-1h/3",
  })
  assert.equal(summary.exitCode, EXIT.ABORTED)
  assert.ok(!fixture.events.some((e) => e.ev === "campaign_stop"), "the crash cut the marker off")
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ["fable-write-tick", ...ONLY_TTL], dialPrefix: DIAL })
  assert.deepEqual(h.ids(), [], "the recorded refusal is the stop, with or without its marker")
  assert.equal(s.exitCode, EXIT.ABORTED)
})

test("R7-B5 a resume gates against all recorded spend (mutation v-b)", async () => {
  const tight = clone(APPROVAL)
  tight.plans["restore-decomposition"].limits.maxTotalExperimentalSpend.value = 0.03
  const { fixture, world, live } = await exactWorldCut({
    approval: tight,
    runOpts: { only: ["restore-decomposition"], dialPrefix: DIAL },
    at: (e) => e.ev === "experiment_ended" && e.experiment === "restore-decomposition" && e.run === 1,
  })
  const spentLive = live.ledger.requests.length
  assert.ok(spentLive > 10, "run 1 spent a measurable amount")
  const h = resumeHarness(fixture, { approval: tight, world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ["restore-decomposition"], dialPrefix: DIAL })
  // run 2 never started, so it runs fresh - but under the cap the recorded spend already used
  const refused = h.ev("gate_refused")
  assert.ok(refused.length > 0, `run 2 must be gated against the recorded spend; it issued ${h.ids().length} calls`)
  assert.ok(refused.some((e) => e.reasons.some((r) => r.code === "cap_exceeded" && String(r.scope).startsWith("plan-total:"))), JSON.stringify(refused[0]?.reasons))
  assert.ok(h.ids().filter((i) => !i.startsWith("preflight/")).length <= 1, `at most the refused call is issued: ${JSON.stringify(h.ids())}`)
  assert.equal(s.experiments["restore-decomposition"].status, "aborted")
})

// N1 (gate note, binding under clarification A (v), probe7-roll): a quiet-check attempt whose
// delta cannot be read - the 5h window rolled under it, or the reading is missing or anomalous -
// proves nothing. It must be retried inside the bounded retry, never passed on the one delta that
// happened to remain readable.
test("N1 a quiet-check attempt with an unreadable delta is retried, not passed on the other delta", async () => {
  const h = harness({ gauge: RESET_GAUGE(1.5) })
  const s = await h.run({ only: ONLY_TTL })
  const pings = h.ids().filter((id) => id.startsWith("preflight/"))
  const rolled = h.ledger.requests.filter((r) => r.stepId.startsWith("preflight/") && (r.anomalies.includes("reset_changed") || r.meters["unified-5h"]?.sameWindow === false))
  assert.ok(rolled.length > 0, "the 5h window rolls under the first attempt")
  assert.ok(pings.some((id) => id.startsWith("preflight/baseline-2/")), `the attempt is retried, not accepted: ${JSON.stringify(pings)}`)
  const attempt2 = h.ledger.requests.filter((r) => r.stepId.startsWith("preflight/baseline-2/"))
  assert.equal(attempt2.length, 3, "the retry is the same bounded three-PING check")
  for (const r of attempt2) assert.equal(r.meters["unified-5h"]?.sameWindow, true, "and every delta of the retry IS readable, in one window")
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
  assert.equal(s.experiments[TTL].status, "valid", "and the quiet attempt that IS readable lets the campaign run")
})

// Clarification A (i): `campaignStopOf` IS the contract surface - the live path and a resume both
// decide a campaign-level stop by appending the deciding event and asking this one function. Each
// record below is a decision the live run takes; each non-record below is one it does not.
test("R7-B3 campaignStopOf: the deciding records, read directly", () => {
  const stops = [
    ["an explicit marker", { ev: "campaign_stop", reason: "cancelled" }, "cancelled"],
    ["a meter cap refusal", { ev: "gate_refused", reasons: [{ code: "cap_exceeded", scope: "meter:unified-5h", meter: "unified-5h" }] }, "cap_exceeded"],
    ["a campaign-stop scope refusal", { ev: "gate_refused", reasons: [{ code: "cap_exceeded", scope: "campaign-stop:unified-7d_oi" }] }, "campaign_stop"],
    ["a disallowed account status", { ev: "gate_refused", reasons: [{ code: "status_not_allowed" }] }, "status_not_allowed"],
    ["an unresolved issuance", { ev: "step_void", stepId: "a/b/0", inDoubt: true }, "in_doubt_step"],
    ["a failed quiet check", { ev: "quiet_check_failed", reason: "foreign_traffic" }, "foreign_traffic"],
    ["an experiment aborted by foreign traffic", { ev: "experiment_ended", status: "aborted", reason: "foreign_traffic" }, "foreign_traffic"],
    ["an experiment aborted by a global stop rule", { ev: "experiment_ended", status: "aborted", reason: "refusal" }, "refusal"],
    ["a response carrying a global stop rule", { ev: "step_result", experiment: TTL, anomalies: ["refusal"] }, "refusal"],
    ["a preflight PING that was never delivered", { ev: "step_result", experiment: "preflight", anomalies: ["usage_missing"] }, "usage_missing"],
  ]
  for (const [what, ev, reason] of stops) {
    assert.equal(campaignStopOf([{ ev: "run_started" }, ev])?.reason, reason, `${what} stops the campaign`)
  }
  const notStops = [
    ["a per-idle cap trip", { ev: "gate_refused", reasons: [{ code: "cap_exceeded", scope: "idle:fable-write-tick" }] }],
    ["a per-plan cap trip", { ev: "gate_refused", reasons: [{ code: "cap_exceeded", scope: "plan-total:restore-decomposition" }] }],
    ["an experiment aborted for its own reason", { ev: "experiment_ended", status: "aborted", reason: "no_dial_prefix" }],
    ["a delivery failure outside the preflight", { ev: "step_result", experiment: TTL, anomalies: ["usage_missing"] }],
    ["a void step that is not in doubt", { ev: "step_void", stepId: "a/b/0", reason: "late_step" }],
    ["a gate refusal whose only reason is the doubt itself", { ev: "gate_refused", reasons: [{ code: "in_doubt_step" }] }],
    ["a run that ended in doubt", { ev: "run_ended", exitCode: EXIT.IN_DOUBT }],
  ]
  for (const [what, ev] of notStops) {
    assert.equal(campaignStopOf([{ ev: "run_started" }, ev]), null, `${what} does not stop the campaign`)
  }
  // and the doubt - unlike every other deciding record - lifts when the response is recovered
  const doubted = [{ ev: "step_void", stepId: "a/b/0", inDoubt: true }]
  assert.equal(campaignStopOf(doubted)?.reason, "in_doubt_step", "while it is unresolved, it stops the campaign")
  assert.equal(campaignStopOf([...doubted, { ev: "step_result", stepId: "a/b/0", source: "proxy_reconciled", anomalies: [] }]), null, "reconciling it lifts the stop")
  assert.equal(campaignStopOf([{ ev: "run_ended", exitCode: EXIT.OK }])?.source, "run_ended", "a terminal run is over")
  assert.equal(campaignStopOf([]), null)
  assert.equal(campaignStopOf(null), null)
})

// R7-B3 (revision 2 (3) and (5) together): an unresolved issuance stops the campaign - no fresh
// experiment may be planned against an unknown meter state - but it is the ONE stop that lifts,
// because a later resume can recover the response. So it is never written as a durable marker.
test("R7-B3 the in-doubt stop lifts when the response is recovered, and leaves no durable marker", async () => {
  const fx = await crashFixture({ withProxyRecord: false })
  const only = [TTL, "fable-write-tick"]
  const first = resumeHarness(fx)
  const s1 = await first.run({ resume: "fake-run", only, dialPrefix: DIAL })
  assert.deepEqual(first.ids(), [], "while the issuance is unresolved, nothing is planned against it")
  assert.equal(s1.exitCode, EXIT.IN_DOUBT)
  assert.deepEqual(s1.inDoubt, [fx.stepId])
  assert.deepEqual(first.ev("campaign_stop"), [], "and the liftable stop is NOT recorded as a marker")

  // the proxy row turns up: the doubt is settled, and the campaign carries on with what never ran
  const reference = harness()
  await reference.run({ only: ONLY_TTL })
  const row = clone(reference.proxy.records.find((r) => r.stepId === fx.stepId))
  const second = resumeHarness({
    events: first.ledger.events,
    requests: first.ledger.requests,
    cli: first.ledger.cli,
    proxyRecords: [...first.proxy.records, row],
    crashedAt: Date.parse(first.ledger.events[first.ledger.events.length - 1].ts),
  })
  const s2 = await second.run({ resume: "fake-run", only, dialPrefix: DIAL })
  assert.equal(second.ev("step_result").filter((e) => e.source === "proxy_reconciled").length, 1)
  assert.deepEqual(s2.inDoubt, [], "the doubt is settled")
  assert.equal(s2.experiments[TTL].reason, "interrupted_by_crash", "the interrupted experiment stays closed")
  assert.equal(s2.experiments["fable-write-tick"].status, "valid", `the experiment that never started runs: ${JSON.stringify(s2.experiments["fable-write-tick"])}`)
  assert.equal(s2.exitCode, EXIT.OK)
})

// =============================================================== group R8
// Appendix B revision 2, clarification A (v) - "a quiet-check attempt is quiet only if EVERY delta
// of it is readable in one window with zero ticks; an attempt with an unreadable delta
// (reset_changed, missing, anomalous) is retried within the bounded retry".
//
// Exactly ONE PING of a block is expected to cross a reset: the first PING of the FIRST attempt,
// and only when the block follows a planned wait (the re-baseline) or a downtime (a resumed
// preflight). A window that moves under any other PING is an unreadable delta: the anomaly stays
// in that PING's step_result, the attempt is not quiet, and the bounded retry runs.

const rebaselinePings = (h) =>
  h.ledger.requests.filter((r) => r.stepId.startsWith("preflight/rebaseline")).map((r) => `${r.stepId}:${r.meters["unified-5h"]?.sameWindow}:${JSON.stringify(r.anomalies)}`)

test("R8-B1 a re-baseline PING whose window moved under it is an unreadable delta, on PING 2 and on PING 3", async () => {
  for (const moved of ["preflight/rebaseline/1", "preflight/rebaseline/2"]) {
    const h = harness({ gauge: RESET_GAUGE(60), script: { [moved]: { rollReset: true } } })
    const s = await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
    const observed = JSON.stringify({ moved, quiet: h.ev("quiet_retry").map((e) => e.arm), reb: rebaselinePings(h) })
    assert.ok(h.ids().includes("preflight/rebaseline-2/0"), `the attempt with an unreadable delta is retried: ${observed}`)
    assert.equal(h.ev("quiet_retry").length, 1, observed)
    assert.equal(h.ev("quiet_retry")[0].reason, "gauge_moved", observed)
    const rec = h.ledger.requests.find((r) => r.stepId === moved)
    assert.ok(rec.anomalies.includes("reset_changed"), `the move is recorded on the PING it happened to: ${observed}`)
    // the step the block is holding up is not issued on the strength of that attempt
    const ids = h.ids()
    const between = ids.slice(ids.indexOf("preflight/rebaseline/2") + 1, ids.indexOf("preflight/rebaseline-2/0"))
    assert.deepEqual(between, [], `nothing is issued between the unreadable attempt and its retry: ${JSON.stringify(ids)}`)
    assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
  }
})

test("R8-B1 a retry attempt's own first PING is not expected to roll: a move on rebaseline-2/0 is retried", async () => {
  const h = harness({
    gauge: RESET_GAUGE(60),
    // attempt 1 fails on a foreign tick; ten minutes later attempt 2 starts INSIDE the new window,
    // so a window move under its first PING proves nothing either.
    script: { "preflight/rebaseline/1": { bump: { meter: "unified-5h", eq: 0.01 } }, "preflight/rebaseline-2/0": { rollReset: true } },
  })
  await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  const observed = JSON.stringify({ quiet: h.ev("quiet_retry").map((e) => `${e.arm}:${e.reason}`), reb: rebaselinePings(h) })
  assert.ok(h.ids().includes("preflight/rebaseline-3/0"), `attempt 2 is not accepted on an unreadable delta: ${observed}`)
  assert.deepEqual(h.ev("quiet_retry").map((e) => e.reason), ["foreign_tick", "gauge_moved"], observed)
  assert.ok(h.ledger.requests.find((r) => r.stepId === "preflight/rebaseline-2/0").anomalies.includes("reset_changed"), observed)
})

test("R8-B1 controls: the PING that IS expected to roll stays quiet evidence", async () => {
  // the re-baseline's own first PING crosses the reset by design - it must NOT be flagged or retried
  const plain = harness({ gauge: RESET_GAUGE(60) })
  await plain.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.deepEqual(plain.ev("quiet_retry"), [], `the planned roll is not a retry: ${JSON.stringify(rebaselinePings(plain))}`)
  assert.deepEqual(plain.ledger.requests.find((r) => r.stepId === "preflight/rebaseline/0").anomalies, [], "and it carries no anomaly")
  // a preflight PING 3 move IS retried (unchanged by this round)
  const pre = harness({ script: { "preflight/baseline/2": { rollReset: true } } })
  await pre.run({ only: ONLY_TTL })
  assert.ok(pre.ids().includes("preflight/baseline-2/0"), `preflight control: ${JSON.stringify(pre.ids())}`)
})

test("R8-B1 control: a resumed preflight's first PING may roll, its later PINGs may not", async () => {
  const fx = await crashFixture({ withProxyRecord: true })
  const ok = resumeHarness(fx, { script: { "preflight/baseline-r1/0": { rollReset: true } }, clockStart: fx.crashedAt + 90 * 60_000 })
  await ok.run({ resume: "fake-run", only: [TTL, "fable-write-tick"], dialPrefix: DIAL })
  assert.deepEqual(ok.ev("quiet_retry"), [], "downtime may have rolled the window under PING 1")
  const late = resumeHarness(fx, { script: { "preflight/baseline-r1/2": { rollReset: true } }, clockStart: fx.crashedAt + 90 * 60_000 })
  await late.run({ resume: "fake-run", only: [TTL, "fable-write-tick"], dialPrefix: DIAL })
  assert.ok(late.ids().includes("preflight/baseline-r1-2/0"), `a move on PING 3 is retried: ${JSON.stringify(late.ids())}`)
})

// Clarification A (ii) - "an abort signal (operator cancel) appends campaign_stop{reason:
// "cancelled"} before any other write, also while a call is in flight; that call stays in doubt
// (exit 4 until reconciled, then exit 3 with zero calls)".
//
// The signal is read at the ISSUANCE SEAM: before any step_intent, and immediately after invoke
// returns. A cancelled campaign never writes another intent, never starts another experiment, and
// never invents an in-doubt step for a call that was never spawned.

const cancelFixture = (h) => ({
  events: h.ledger.events, requests: h.ledger.requests, cli: h.ledger.cli, proxyRecords: h.proxy.records,
  crashedAt: Date.parse(h.ledger.events[h.ledger.events.length - 1].ts),
})

test("R8-B2 a cancel while a call is in flight is recorded first, also when that call reached the API", async () => {
  const target = "output-quota/out-8k/2"
  const controller = new AbortController()
  let idsAtAbort = 0
  const h = harness({
    script: { [target]: { hangAfterRow: true } },
    opts: { signal: controller.signal },
  })
  const run = h.run({ only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
  assert.equal(await within(h.adapter.entered), target, "the call reached the API")
  idsAtAbort = h.ids().length
  controller.abort()
  const s = await within(run)
  const ev = h.ledger.events
  const stop = ev.findIndex((e) => e.ev === "campaign_stop" && e.reason === "cancelled")
  const after = ev.slice(stop + 1).map((e) => e.ev)
  const observed = JSON.stringify({ exit: s.exitCode, invokedAfterAbort: h.ids().slice(idsAtAbort), after })
  assert.ok(stop >= 0, `the cancel is recorded: ${observed}`)
  assert.equal(ev.findIndex((e) => e.ev === "step_result" && e.stepId === target) > stop, true, `before the call's own result: ${observed}`)
  assert.deepEqual(h.ids().slice(idsAtAbort), [], `nothing is invoked after the cancel: ${observed}`)
  assert.ok(!after.includes("step_intent") && !after.includes("experiment_started"), `no issuance record follows the cancel: ${observed}`)
  assert.equal(s.exitCode, EXIT.ABORTED, observed)
  assert.equal(s.resumable, false, observed)
  // and the recorded cancel is final: a resume issues nothing and exits 3
  const r = resumeHarness(cancelFixture(h))
  const rs = await r.run({ resume: "fake-run", only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
  assert.deepEqual(r.ids(), [], "a resume of a cancelled campaign issues nothing")
  assert.equal(rs.exitCode, EXIT.ABORTED)
  assert.equal(rs.resumable, false)
})

test("R8-B2 the same cancel in the LAST experiment is recorded too", async () => {
  const target = ttlId("treatment", 4)
  const controller = new AbortController()
  const h = harness({ script: { [target]: { hangAfterRow: true } }, opts: { signal: controller.signal } })
  const run = h.run({ only: ONLY_TTL })
  assert.equal(await within(h.adapter.entered), target, "the call reached the API")
  controller.abort()
  const s = await within(run)
  const markers = h.ev("campaign_stop")
  assert.equal(markers.length, 1, `the cancel is recorded even with no later job to refuse: ${JSON.stringify(h.ledger.events.slice(-4).map((e) => e.ev))}`)
  assert.equal(markers[0].reason, "cancelled")
  assert.notEqual(s.exitCode, EXIT.OK, "a cancelled campaign never reports success")
  assert.equal(s.exitCode, EXIT.ABORTED, JSON.stringify(s.experiments))
})

test("R8-B2 a cancel before the first issuance writes the marker and no intent at all", async () => {
  const controller = new AbortController()
  controller.abort()
  const h = harness({ opts: { signal: controller.signal } })
  const s = await within(h.run({ only: ONLY_TTL }))
  const ev = h.ledger.events
  const stop = ev.findIndex((e) => e.ev === "campaign_stop")
  assert.ok(stop >= 0, `the cancel is recorded: ${JSON.stringify(ev.map((e) => e.ev))}`)
  assert.equal(ev[stop].reason, "cancelled")
  assert.deepEqual(ev.filter((e) => e.ev === "step_intent"), [], "no intent is ever written")
  assert.deepEqual(h.ids(), [], "and nothing is invoked")
  assert.deepEqual(s.inDoubt, [], "a call that was never spawned is not in doubt")
  assert.equal(s.exitCode, EXIT.ABORTED, JSON.stringify(s))
  assert.equal(s.resumable, false)
  const r = resumeHarness(cancelFixture(h))
  const rs = await r.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(r.ids(), [], "and a resume issues nothing")
  assert.equal(rs.exitCode, EXIT.ABORTED)
  assert.equal(rs.resumable, false)
})

test("R8-B2 a cancel that lands between an invoke return and the next job stops the campaign there", async () => {
  const controller = new AbortController()
  let idsAtAbort = 0
  const h = harness({
    opts: { signal: controller.signal },
    // the cancel arrives in the gap between one completed call and the next issuance
    tap: (e) => { if (e.ev === "step_result" && e.experiment === "output-quota" && !controller.signal.aborted) { controller.abort(); idsAtAbort = h.ids().length } },
  })
  const s = await within(h.run({ only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL }))
  const ev = h.ledger.events
  const stop = ev.findIndex((e) => e.ev === "campaign_stop" && e.reason === "cancelled")
  assert.ok(stop >= 0, `the cancel is recorded: ${JSON.stringify(ev.map((e) => e.ev))}`)
  assert.deepEqual(h.ids().slice(idsAtAbort), [], "no further call is issued")
  assert.deepEqual(ev.slice(stop + 1).filter((e) => e.ev === "step_intent"), [], "and no further intent is written")
  assert.equal(s.exitCode, EXIT.ABORTED, JSON.stringify(s.experiments))
})

// R8-B4: two clarification-A behaviours whose mutations survived the whole round-7 suite.

// (iv) "fresh experiments inherit the recorded run-level state the protocols need (dial_prefix,
// restore mode)". Without the mode, policy-effect re-measures it with its own PAID resume-hit
// gate call - one call more than the live run, for a fact the log already holds.
test("R8-B4 a resume inherits the recorded restore mode, and pays no call to re-measure it", async () => {
  for (const at of ["mode_set", "dial_prefix"]) {
    const { live, fixture, world } = await exactWorldCut({ runOpts: { dialPrefix: DIAL }, at: (e) => e.ev === at })
    const recorded = live.ev("mode_set").at(-1)
    assert.ok(fixture.events.some((e) => e.ev === "mode_set"), `the cut keeps the recorded mode (${at})`)
    const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
    const s = await h.run({ resume: "fake-run" })
    const started = h.ev("experiment_started").filter((e) => e.experiment !== "preflight")
    assert.ok(started.length > 0, `fresh experiments run (${at})`)
    for (const e of started) assert.equal(e.mode?.resumeHit, recorded.resumeHit, `${at}: ${e.experiment} starts with the recorded mode`)
    assert.deepEqual(h.ev("mode_set"), [], `${at}: nothing is re-measured, so no new mode_set`)
    // 218 = the live run's 215 plus this resume's own three fresh preflight PINGs. Without the
    // recorded mode it is 219: policy-effect pays one gated call to re-measure a recorded fact.
    assert.equal(s.paidRequestsIssued, 218, `${at}: paid calls, ${JSON.stringify(s.experiments)}`)
    assert.equal(s.exitCode, EXIT.OK)
  }
})

// (i) "campaign_stop stays an explicit marker written as early as possible", and a campaign-level
// stop is decided ONLY by appending the deciding event and evaluating campaignStopOf on it. A
// failed quiet check is such an event, at the preflight and at a re-baseline alike.
test("R8-B4 a failed quiet check writes its campaign_stop marker, preflight and re-baseline alike", async () => {
  const tick = { bump: { meter: "unified-5h", eq: 0.01 } }
  const pre = harness({ script: { "preflight/baseline/1": tick, "preflight/baseline-2/1": tick, "preflight/baseline-3/1": tick } })
  const ps = await pre.run({ only: ONLY_TTL })
  assert.equal(pre.ev("quiet_check_failed").length, 1, "the deciding event is appended")
  assert.deepEqual(pre.ev("campaign_stop").map((e) => e.reason), ["foreign_traffic"], `and the marker follows it: ${JSON.stringify(pre.ev("campaign_stop"))}`)
  assert.equal(ps.stopped, "campaign_stopped", JSON.stringify(ps))
  assert.equal(ps.exitCode, EXIT.ABORTED)

  const reb = harness({
    gauge: RESET_GAUGE(60),
    script: { "preflight/rebaseline/1": tick, "preflight/rebaseline-2/1": tick, "preflight/rebaseline-3/1": tick },
  })
  const rs = await reb.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.equal(reb.ev("quiet_check_failed").length, 1)
  assert.deepEqual(reb.ev("campaign_stop").map((e) => e.reason), ["foreign_traffic"], `re-baseline marker: ${JSON.stringify(reb.ev("campaign_stop"))}`)
  assert.equal(rs.stopped, "campaign_stop", JSON.stringify(rs))
  assert.equal(rs.exitCode, EXIT.ABORTED)
})

// Adversarial: cancel_resume + repeated_interruptions. A cancelled campaign is resumed twice; the
// verdict never softens, no call is ever issued again, and no id is issued twice across the three
// processes' logs.
test("R8 adversarial: a cancelled campaign stays exit 3 across two further processes, with no id issued twice", async () => {
  const target = "output-quota/out-8k/2"
  const controller = new AbortController()
  const p1 = harness({ script: { [target]: { hangAfterRow: true } }, opts: { signal: controller.signal } })
  const run = p1.run({ only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
  assert.equal(await within(p1.adapter.entered), target)
  controller.abort()
  const s1 = await within(run)
  assert.equal(s1.exitCode, EXIT.ABORTED)

  const logs = [p1]
  let prev = p1
  for (const n of [2, 3]) {
    const h = resumeHarness(cancelFixture(prev))
    const s = await h.run({ resume: "fake-run", only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
    assert.deepEqual(h.ids(), [], `process ${n} issues nothing`)
    assert.equal(s.exitCode, EXIT.ABORTED, `process ${n}: ${JSON.stringify(s.experiments)}`)
    assert.equal(s.resumable, false, `process ${n} is not resumable`)
    logs.push(h)
    prev = h
  }
  // each resume inherits the whole prior log, so the LAST one is the cumulative record of all
  // three processes: no id may appear in it twice.
  const intents = prev.ledger.events.filter((e) => e.ev === "step_intent").map((e) => e.stepId)
  assert.deepEqual([...new Set(intents)], intents, `no id is issued twice: ${JSON.stringify(intents)}`)
  const invoked = logs.flatMap((h) => h.ids())
  assert.deepEqual([...new Set(invoked)], invoked, `no call is made twice: ${JSON.stringify(invoked)}`)
})

// =============================================================== group R9
// Clarification A (ii): "an abort signal (operator cancel) appends campaign_stop{reason:
// "cancelled"} before any other write". A resumed process's ONLY await before it decides whether
// to issue anything is the preflight process scan (`deps.processes.conflicting()`), and when that
// resume has nothing to issue - a recorded stop, an unresolved in-doubt step, or no fresh job left
// - it never reaches a step seam. The cancel must still be recorded there.

/** a harness whose process scan fires the operator's cancel, as a real Ctrl+C during the scan does */
function cancelDuringScan(h, controller) {
  let at = -1
  h.deps.processes.conflicting = async () => {
    at = h.ledger.events.length
    controller.abort()
    return []
  }
  return () => ({ abortedAfter: at, writesAfter: h.ledger.events.slice(at).map((e) => `${e.ev}${e.stepId ? `:${e.stepId}` : ""}`) })
}

test("R9-B1 a resume with nothing left to issue records the cancel it took during its process scan", async () => {
  // S17: every experiment of the log ended, the crash cut the run_ended - so this resume reports
  // the verdicts and issues nothing. The cancel lands in the scan.
  const { fixture, world } = await exactWorldCut({ runOpts: { only: ONLY_TTL }, at: (e) => e.ev === "experiment_ended" && e.experiment === TTL })
  assert.ok(!fixture.events.some((e) => e.ev === "run_ended"), "the crash cut the run_ended")
  const controller = new AbortController()
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt, opts: { signal: controller.signal } })
  const probe = cancelDuringScan(h, controller)
  const s = await within(h.run({ resume: "fake-run", only: ONLY_TTL }))
  const seen = probe()
  assert.deepEqual(h.ev("campaign_stop").map((e) => e.reason), ["cancelled"], `the cancel is recorded: ${JSON.stringify(seen)}`)
  assert.equal(seen.writesAfter[0], "campaign_stop", `and it is the first record this process writes after the cancel: ${JSON.stringify(seen.writesAfter)}`)
  assert.notEqual(s.exitCode, EXIT.OK, "a cancelled process never reports success")
  assert.equal(s.exitCode, EXIT.ABORTED, JSON.stringify(s))
  assert.equal(s.resumable, false)
  assert.deepEqual(h.ids(), [], "and it issues nothing")

  // the marker is final: every later resume honours it
  let prev = h
  for (const n of [2, 3]) {
    const r = resumeHarness({ events: prev.ledger.events, requests: prev.ledger.requests, cli: prev.ledger.cli, proxyRecords: prev.proxy.records, crashedAt: Date.parse(prev.ledger.events.at(-1).ts) })
    const rs = await r.run({ resume: "fake-run", only: ONLY_TTL })
    assert.deepEqual(r.ids(), [], `process ${n} issues nothing`)
    assert.equal(rs.exitCode, EXIT.ABORTED, `process ${n}: ${JSON.stringify(rs)}`)
    assert.equal(rs.resumable, false, `process ${n} is not resumable`)
    prev = r
  }
})

test("R9-B1 a resume whose in-doubt step is unresolved records the cancel, and the next resume pays nothing", async () => {
  // S18: an unresolved in-doubt step skips the quiet check too, so no step seam is reached. Without
  // the marker the NEXT resume reconciles the row and then runs the rest of the campaign - paid.
  const fx = await crashFixture({ withProxyRecord: false })
  const only = [TTL, "fable-write-tick"]
  const controller = new AbortController()
  const h = resumeHarness(fx, { opts: { signal: controller.signal } })
  const probe = cancelDuringScan(h, controller)
  const s = await within(h.run({ resume: "fake-run", only, dialPrefix: DIAL }))
  const seen = probe()
  assert.deepEqual(h.ev("campaign_stop").map((e) => e.reason), ["cancelled"], `the cancel is recorded: ${JSON.stringify(seen)}`)
  assert.equal(seen.writesAfter[0], "campaign_stop", `first record after the cancel: ${JSON.stringify(seen.writesAfter)}`)
  assert.deepEqual(h.ids(), [], "nothing is issued")
  // the genuinely spawned call is still unsettled, so this process is in doubt
  assert.equal(s.exitCode, EXIT.IN_DOUBT, JSON.stringify(s))
  assert.deepEqual(s.inDoubt, [fx.stepId])

  // the row turns up: the next resume reconciles it and then honours the cancel - 0 calls, exit 3
  const reference = harness()
  await reference.run({ only: ONLY_TTL })
  const row = clone(reference.proxy.records.find((r) => r.stepId === fx.stepId))
  const r2 = resumeHarness({ events: h.ledger.events, requests: h.ledger.requests, cli: h.ledger.cli, proxyRecords: [...h.proxy.records, row], crashedAt: Date.parse(h.ledger.events.at(-1).ts) })
  const s2 = await r2.run({ resume: "fake-run", only, dialPrefix: DIAL })
  assert.equal(r2.ev("step_result").filter((e) => e.source === "proxy_reconciled").length, 1, "the row is reconciled")
  assert.deepEqual(r2.ids(), [], "and NOT ONE call is issued after a recorded cancel")
  assert.equal(s2.exitCode, EXIT.ABORTED, JSON.stringify(s2))
  assert.equal(s2.resumable, false)
})

test("R9-B1 a fresh run cancelled during its process scan records the marker first", async () => {
  const controller = new AbortController()
  const h = harness({ opts: { signal: controller.signal } })
  const probe = cancelDuringScan(h, controller)
  const s = await within(h.run({ only: ONLY_TTL }))
  const seen = probe()
  assert.equal(seen.writesAfter[0], "campaign_stop", `the marker is the first record after the cancel: ${JSON.stringify(seen.writesAfter)}`)
  assert.equal(h.ev("campaign_stop")[0].reason, "cancelled")
  assert.deepEqual(h.ids(), [], "no PING is issued")
  assert.equal(s.exitCode, EXIT.ABORTED, JSON.stringify(s))

  // and a signal already aborted when the machine starts puts the marker before every other write
  const pre = new AbortController()
  pre.abort()
  const h2 = harness({ opts: { signal: pre.signal } })
  const s2 = await within(h2.run({ only: ONLY_TTL }))
  assert.equal(h2.ledger.events[0].ev, "campaign_stop", `strictly first: ${JSON.stringify(h2.ledger.events.map((e) => e.ev))}`)
  assert.deepEqual(h2.ids(), [])
  assert.equal(s2.exitCode, EXIT.ABORTED, JSON.stringify(s2))
})

// Clarification A (v) again, on the weekly meters. `unreadable` only looks at the 5h reading, so a
// window that moves on 7d or 7d_oi alone is caught by the ANOMALY term - `reset_changed` on a PING
// that was not the expected crossing. Mutation G9-l (the anomaly term ignoring reset_changed)
// survived the whole round-8 suite; these rows kill it.
test("R9-N4 a weekly-meter window roll under a quiet-check PING is an unreadable delta too", async () => {
  for (const meter of ["unified-7d", "unified-7d_oi"]) {
    const h = harness({ script: { "preflight/baseline/1": { rollReset: meter } } })
    const s = await h.run({ only: ONLY_TTL })
    const rec = h.ledger.requests.find((r) => r.stepId === "preflight/baseline/1")
    const observed = JSON.stringify({ meter, quiet: h.ev("quiet_retry").map((e) => `${e.arm}:${e.reason}`), anomalies: rec.anomalies, m5SameWindow: rec.meters["unified-5h"]?.sameWindow, rolled: rec.meters[meter]?.sameWindow })
    assert.equal(rec.meters["unified-5h"]?.sameWindow, true, `only the weekly window moved: ${observed}`)
    assert.ok(rec.anomalies.includes("reset_changed"), `the move is recorded on the PING it happened to: ${observed}`)
    assert.ok(h.ids().includes("preflight/baseline-2/0"), `the attempt is retried, not passed on the 5h delta alone: ${observed}`)
    assert.deepEqual(h.ev("quiet_retry").map((e) => e.reason), ["gauge_moved"], observed)
    assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
  }
  // and the re-baseline block reads it the same way
  const reb = harness({ gauge: RESET_GAUGE(60), script: { "preflight/rebaseline/1": { rollReset: "unified-7d" } } })
  await reb.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  assert.ok(reb.ids().includes("preflight/rebaseline-2/0"), `re-baseline: ${JSON.stringify(reb.ids().filter((x) => x.startsWith("preflight/")))}`)
})

// ============================================================ lane M group B
// I4. Appendix A section 3 interleaves the TTL frame's two runs on ONE gauge (run-1 issues
// treatment/0, control/1, treatment/4, treatment/6, control/7; run-2 the rest), so a tick posted
// while either run's call is in flight is charged to whichever run happened to be issuing. A
// per-RUN 0.03 cap is therefore not a property of the run: the same frame refuses run 1 and passes
// run 2 purely on posting order. The cap is enforced on the FRAME - both runs, one scope, 0.06.
test("I4 the ttl per-idle cap is enforced on the interleaved frame, not on one run's share of it", async () => {
  const tick = { bump: { meter: "unified-5h", eq: 0.01 } }
  // two extra ticks land on run-1's calls; run-1's own share reaches 0.03 while the FRAME is 0.04
  const h = harness({ script: { [ttlId("treatment", 0)]: tick, [ttlId("treatment", 4)]: tick } })
  const s = await h.run({ only: ONLY_TTL })
  const refusals = h.ev("gate_refused").map((e) => `${e.stepId}:${(e.reasons ?? []).map((r) => r.scope).join(",")}`)
  const byScope = h.ledger.requests.filter((r) => r.experiment === TTL).reduce((m, r) => { m[r.accounting?.scope] = (m[r.accounting?.scope] ?? 0) + 1; return m }, {})
  const observed = JSON.stringify({ refusals, byScope, exp: s.experiments[TTL] })
  assert.deepEqual(refusals, [], `no run's share of the frame may refuse a call the frame can afford: ${observed}`)
  assert.equal(s.experiments[TTL].status, "valid", observed)
  assert.equal(s.experiments[TTL].paidRequests, 10, observed)
  // the gate reads ONE scope for the whole frame
  assert.deepEqual(Object.keys(byScope), [`${TTL}/frame`], observed)
  assert.ok(s.experiments[TTL].spentObservedEq <= 0.06, observed)
})

test("I4 the frame cap still refuses a frame that would exceed 0.06", async () => {
  const tick = { bump: { meter: "unified-5h", eq: 0.01 } }
  // the frame's first six calls in issue order (T0 C1 T2 C3 T4 T5), each carrying one extra tick
  const bumped = [ttlId("treatment", 0), ttlId("control", 1), ttlId("treatment", 2), ttlId("control", 3), ttlId("treatment", 4), ttlId("treatment", 5)]
  const script = Object.fromEntries(bumped.map((id) => [id, tick]))
  const h = harness({ script })
  const s = await h.run({ only: ONLY_TTL })
  const refused = h.ev("gate_refused")
  const observed = JSON.stringify({ refused: refused.map((e) => `${e.stepId}:${(e.reasons ?? []).map((r) => `${r.code}@${r.scope}`).join(",")}`), exp: s.experiments[TTL], issued: h.ids() })
  // every scripted tick targets a real call of the frame, and every call the frame admitted carried
  // its tick up to the refusal (the refused call is never invoked, so its tick cannot land)
  const clean = harness()
  await clean.run({ only: ONLY_TTL })
  assert.deepEqual(bumped.filter((id) => !clean.ids().includes(id)), [], `a scripted id is not a call of the frame: ${observed}`)
  const admitted = h.ids().filter((id) => id.startsWith(`${TTL}/`))
  assert.deepEqual(admitted, bumped.slice(0, admitted.length), `every admitted call carried its tick: ${observed}`)
  assert.equal(refused[0]?.stepId, bumped[admitted.length], `the frame stops at the next ticked call: ${observed}`)
  assert.ok(refused.length > 0, `a frame over 0.06 is refused: ${observed}`)
  assert.ok(refused.some((e) => (e.reasons ?? []).some((r) => r.code === "cap_exceeded" && r.scope === `idle:${TTL}/frame`)), observed)
  assert.equal(s.experiments[TTL].status, "aborted", observed)
})

// I8. `experiments[id].paidRequests` counted protocol steps, so a fatal last call and a multi-row
// reconciliation left it below the rows actually recorded in requests.jsonl. The summary must
// count what was paid for, and the run-level total must equal the rows on disk.
const rowsOf = (h, id) => h.ledger.requests.filter((r) => r.experiment === id).length

test("I8 a fatal last call is still a paid request in the experiment's own count", async () => {
  const h = harness({ script: { [ttlId("control", 9)]: { stop_reason: "refusal" } } })
  const s = await h.run({ only: ONLY_TTL })
  const observed = JSON.stringify({ exp: s.experiments[TTL], rows: rowsOf(h, TTL), runLevel: s.paidRequestsIssued, totalRows: h.ledger.requests.length })
  assert.equal(s.experiments[TTL].paidRequests, rowsOf(h, TTL), `per-experiment count equals its request rows: ${observed}`)
  assert.equal(s.paidRequestsIssued, h.ledger.requests.length, `run-level total equals requests.jsonl: ${observed}`)
})

test("I8 a two-row response is counted once per row, per experiment and per run", async () => {
  const h = harness({ script: { [ttlId("treatment", 2)]: { records: 2 } } })
  const s = await h.run({ only: ONLY_TTL })
  const observed = JSON.stringify({ exp: s.experiments[TTL], rows: rowsOf(h, TTL), runLevel: s.paidRequestsIssued, totalRows: h.ledger.requests.length })
  assert.equal(s.paidRequestsIssued, h.ledger.requests.length, `run-level total equals requests.jsonl: ${observed}`)
  assert.equal(s.experiments[TTL].paidRequests, rowsOf(h, TTL), `per-experiment count equals its request rows: ${observed}`)
})

test("I8 a two-row reconciliation counts both rows in the experiment's own count", async () => {
  const fx = await crashFixture({ withProxyRecord: true })
  const extra = clone(fx.proxyRecords.find((r) => r.stepId === fx.stepId))
  extra.msg_id = `${extra.msg_id}_dup`
  const h = resumeHarness({ ...fx, proxyRecords: [...fx.proxyRecords, extra] })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const reconciled = h.ledger.requests.filter((r) => r.stepId === fx.stepId).length
  const observed = JSON.stringify({ exp: s.experiments[TTL], rows: rowsOf(h, TTL), reconciled, runLevel: s.paidRequestsIssued, totalRows: h.ledger.requests.length })
  assert.equal(reconciled, 2, `both rows are kept as evidence: ${observed}`)
  assert.equal(s.experiments[TTL].paidRequests, rowsOf(h, TTL), `per-experiment count equals its request rows: ${observed}`)
  assert.equal(s.paidRequestsIssued, h.ledger.requests.length, observed)
})

test("I8 a resume reports the recorded spend of an experiment that ended before the crash", async () => {
  const { live, fixture, world } = await exactWorldCut({ runOpts: { only: ONLY_TTL }, at: (e) => e.ev === "experiment_ended" && e.experiment === TTL })
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const observed = JSON.stringify({ resumed: s.experiments[TTL], live: live.summary?.experiments?.[TTL] ?? null })
  assert.equal(s.experiments[TTL].paidRequests, 10, observed)
  assert.ok(s.experiments[TTL].spentObservedEq > 0, `the recorded spend is reported, not zeroed: ${observed}`)
  assert.equal(s.experiments[TTL].spentObservedEq, 0.04, observed)
  assert.equal(s.experiments[TTL].spentUpperEq, 0.05, observed)
})

// I11. A reconciled response whose requests.jsonl row is missing was charged one tick silently.
// The charge is right (conservative), the silence is not: the reading is unknown, and the log must
// say so.
test("I11 a recorded response with no requests.jsonl row records request_row_missing", async () => {
  const { fixture, world } = await exactWorldCut({ runOpts: { only: ONLY_TTL }, at: (e) => e.ev === "experiment_ended" && e.experiment === TTL })
  const dropped = fixture.requests.filter((r) => r.stepId !== ttlId("control", 1))
  assert.equal(dropped.length, fixture.requests.length - 1, "exactly one row is missing")
  const h = resumeHarness({ ...fixture, requests: dropped }, { world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const flagged = h.ev("row_missing")
  const observed = JSON.stringify({ flagged: flagged.map((e) => e.stepId), exp: s.experiments[TTL] })
  assert.deepEqual(flagged.map((e) => e.stepId), [ttlId("control", 1)], `the missing row is recorded, not assumed: ${observed}`)
  assert.equal(flagged[0].anomalies?.[0], "request_row_missing", observed)
  assert.equal(flagged[0].charged, 1, `and the conservative tick charge is kept: ${observed}`)
})

// What one process leaves on disk, as the next process finds it (proxy.jsonl includes the lines
// earlier processes wrote).
const processLog = (h) => ({ events: h.ledger.events, requests: h.ledger.requests, cli: h.ledger.cli, proxyRecords: [...h.proxy.history, ...h.proxy.records], crashedAt: Date.parse(h.ledger.events.at(-1).ts) })

// The summary says what the evidence on disk says: every per-experiment count equals that
// experiment's request rows, the run total equals the file, and no id is issued twice.
function assertCountsMatchRows(tag, h, s) {
  const rows = h.ledger.requests
  assert.equal(s.paidRequestsIssued, rows.length, `${tag}: run total ${s.paidRequestsIssued} vs ${rows.length} rows`)
  for (const [id, v] of Object.entries(s.experiments)) {
    const own = rows.filter((r) => r.experiment === id).length
    if (v.paidRequests === 0 && own === 0) continue
    assert.equal(v.paidRequests, own, `${tag}: ${id} says ${v.paidRequests}, the file has ${own}`)
  }
  assert.deepEqual([...new Set(h.ids())], h.ids(), `${tag}: a call was issued twice`)
}

// B1 (lane M group B gate). restore-decomposition is TWO jobs (run 1, run 2). A resume used to
// re-state each ended job with the EXPERIMENT's aggregate count, the fold stored that as the JOB's
// count, and the next resume summed it again: +1 job per process. Crashed processes P1 are cut
// from one uninterrupted run; P2..Pn each resume the log the previous process left.
const REST = "restore-decomposition"
const REST_TTL = { only: [REST, ...ONLY_TTL], dialPrefix: DIAL }
async function restoreChain({ at, processes }) {
  const { fixture, world } = await exactWorldCut({ runOpts: REST_TTL, at })
  const out = []
  let fx = fixture
  let wd = world
  for (let i = 2; i <= processes; i++) {
    const h = resumeHarness(fx, { world: wd, clockStart: fx.crashedAt })
    const s = await h.run({ resume: "fake-run", ...REST_TTL })
    out.push({ tag: `P${i}`, h, s })
    fx = processLog(h)
    wd = undefined
  }
  return out
}

// the Nth step_intent of restore run 2 (a cut predicate for findIndex, which walks the log once)
const nthRestoreRun2Intent = (nth) => {
  let seen = -1
  return (e) => {
    if (e.ev === "experiment_started" && e.experiment === REST && e.run === 2) seen = 0
    if (seen < 0 || e.ev !== "step_intent") return false
    seen += 1
    return seen === nth
  }
}
const RESTORE_CHAINS = [
  // an in-doubt TTL call (no proxy row): exit 4 -> exit 4 -> exit 4
  { name: "a ttl call in doubt", processes: 4, exits: [EXIT.IN_DOUBT, EXIT.IN_DOUBT, EXIT.IN_DOUBT], at: (e) => e.ev === "step_intent" && e.stepId === ttlId("treatment", 2) },
  // an in-doubt call inside restore run 2 itself
  { name: "a restore run-2 call in doubt", processes: 4, exits: [EXIT.IN_DOUBT, EXIT.IN_DOUBT, EXIT.IN_DOUBT], at: nthRestoreRun2Intent(3) },
  // a crash after restore run 2 ended: P2 runs ttl fresh and ends, P3 resumes the ended log
  { name: "a crash after restore run 2 ended", processes: 3, exits: null, at: (e) => e.ev === "experiment_ended" && e.experiment === REST && e.run === 2 },
]
for (const shape of RESTORE_CHAINS) {
  test(`I8 a two-job experiment's count equals its rows in every process of a resume chain: ${shape.name}`, async () => {
    const chain = await restoreChain(shape)
    const observed = JSON.stringify(chain.map(({ tag, h, s }) => ({ tag, exit: s.exitCode, paid: s.experiments[REST]?.paidRequests, rows: rowsOf(h, REST), runTotal: s.paidRequestsIssued, file: h.ledger.requests.length })))
    if (shape.exits) assert.deepEqual(chain.map(({ s }) => s.exitCode), shape.exits, `the chain has the intended shape: ${observed}`)
    for (const { tag, h, s } of chain) assertCountsMatchRows(tag, h, s)
    assert.ok(chain.every(({ h }) => rowsOf(h, REST) > 0), observed)
  })
}

// N10. A resume states a verdict only for the job it CLOSES (the one interrupted by the crash). A job
// whose experiment_ended is already in the log keeps that verdict (revision 2 (1)); stating it again
// on every resume only grew the log, and was the carrier of B1.
const endedJobs = (h) => h.ledger.events.filter((e) => e.ev === "experiment_ended").map((e) => `${e.experiment}#${e.run ?? ""}:${e.source ?? "live"}`).toSorted()
test("I8 a resume chain states each job's verdict exactly once", async () => {
  // the ttl job is closed by the first resume; both restore jobs ended live
  const ttlChain = (await restoreChain(RESTORE_CHAINS[0])).at(-1).h
  assert.deepEqual(endedJobs(ttlChain), [`${REST}#1:live`, `${REST}#2:live`, `${TTL}#:resume`].toSorted())
  const ttlClosed = ttlChain.ledger.events.find((e) => e.ev === "experiment_ended" && e.experiment === TTL)
  assert.equal(ttlClosed.reason, "interrupted_by_crash")
  assert.equal(ttlClosed.paidRequests, rowsOf(ttlChain, TTL), "the closing verdict carries its own job's count")
  // restore run 2 is closed by the first resume: its verdict carries run 2's rows, not the experiment's
  const restChain = (await restoreChain(RESTORE_CHAINS[1])).at(-1).h
  assert.deepEqual(endedJobs(restChain), [`${REST}#1:live`, `${REST}#2:resume`].toSorted())
  const run2Closed = restChain.ledger.events.find((e) => e.ev === "experiment_ended" && e.experiment === REST && e.run === 2)
  const run2Rows = restChain.ledger.requests.filter((r) => r.experiment === REST && r.run === 2).length
  assert.ok(run2Rows > 0 && run2Rows < rowsOf(restChain, REST), `run 2 is one of two jobs: ${run2Rows} of ${rowsOf(restChain, REST)}`)
  assert.equal(run2Closed.paidRequests, run2Rows, "the closing verdict carries run 2's own count")
})

// B2 (lane M group B gate). A step whose one drained proxy record carries no step label has no
// response of its own - but that record WAS a paid call. It gets exactly one row, not a primary
// row plus the record again as an extra.
test("I8 an unlabelled drained record is written once: rows equal the paid counts, live and resumed", async () => {
  const target = ttlId("treatment", 2)
  const h = harness()
  const push = h.proxy.push
  h.proxy.push = (r) => push(r?.stepId === target ? { ...r, stepId: null, label: "" } : r)
  const s = await h.run({ only: ONLY_TTL })
  const targetRows = h.ledger.requests.filter((r) => r.stepId === target)
  const observed = JSON.stringify({ targetRows: targetRows.map((r) => r.accounting?.source ?? "adapter"), exp: s.experiments[TTL], rows: rowsOf(h, TTL), runTotal: s.paidRequestsIssued, file: h.ledger.requests.length })
  assert.ok(h.ev("step_result").find((e) => e.stepId === target).anomalies.includes("unexpected_request_count"), observed)
  assert.equal(targetRows.length, 1, `one drained record, one row: ${observed}`)
  assertCountsMatchRows("live", h, s)
  const r = resumeHarness(processLog(h))
  assertCountsMatchRows("resumed", r, await r.run({ resume: "fake-run", only: ONLY_TTL }))
})

// Follow-up item 11: the same shape on the IN-DOUBT path. The adapter failed and none of the drained
// records is the step's own, so the call stays in doubt (exit 4) - but every drained record was a
// paid call and gets exactly one row, live and after a resume that still cannot settle the step.
for (const n of [1, 2]) {
  test(`I8 an adapter failure with ${n} unlabelled drained record(s) writes one row per record, live and resumed`, async () => {
    const target = ttlId("treatment", 2)
    const h = harness({ script: { [target]: { error_result: { code: "boom" }, records: n } } })
    const push = h.proxy.push
    h.proxy.push = (r) => push(r?.stepId === target ? { ...r, stepId: null, label: "" } : r)
    const s = await h.run({ only: ONLY_TTL })
    const targetRows = h.ledger.requests.filter((r) => r.stepId === target)
    const observed = JSON.stringify({ exit: s.exitCode, inDoubt: s.inDoubt, targetRows: targetRows.map((r) => [r.accounting?.source, r.accounting?.requestCount]), exp: s.experiments[TTL], runTotal: s.paidRequestsIssued, file: h.ledger.requests.length })
    assert.deepEqual([s.exitCode, s.inDoubt], [EXIT.IN_DOUBT, [target]], `the call stays in doubt: ${observed}`)
    assert.equal(targetRows.length, n, `one row per drained record: ${observed}`)
    assert.ok(targetRows.every((r) => r.accounting?.requestCount === n), `each row is a paid request: ${observed}`)
    assertCountsMatchRows("live", h, s)
    const r = resumeHarness(processLog(h))
    const s2 = await r.run({ resume: "fake-run", only: ONLY_TTL })
    assert.deepEqual([s2.exitCode, s2.inDoubt], [EXIT.IN_DOUBT, [target]], JSON.stringify(s2))
    assertCountsMatchRows("resumed", r, s2)
  })
}

// I25 (lane M group D gate note N5): the fold adds a step_void's `accounting.requestCount` to the
// paid counts. A value that is not a non-negative integer is not a count - a negative one would
// subtract paid calls - so the fold rejects the log the way it rejects a corrupt line.
test("I25 the fold rejects a step_void whose requestCount is not a non-negative integer", async () => {
  // Given: a real in-doubt log whose step_void carries the count of its one drained record
  const target = ttlId("treatment", 2)
  const h = harness({ script: { [target]: { error_result: { code: "boom" }, records: 1 } } })
  const push = h.proxy.push
  h.proxy.push = (r) => push(r?.stepId === target ? { ...r, stepId: null, label: "" } : r)
  await h.run({ only: ONLY_TTL })
  const victim = h.ledger.events.find((e) => e.ev === "step_void" && e.stepId === target)
  assert.equal(victim.accounting.requestCount, 1, "the source log is well formed")
  assert.doesNotThrow(() => fold(h.ledger.events), "the intact log folds")
  for (const bad of [-1, 1.5, "1", null]) {
    // When: the fold reads that count corrupted
    const events = h.ledger.events.map((e) => (e === victim ? { ...e, accounting: { requestCount: bad } } : e))
    // Then: it refuses the log instead of subtracting or skipping paid calls
    assert.throws(() => fold(events), /corrupt step_void/, JSON.stringify(bad))
  }
})

// N5 (lane M group B gate). The proxy is in the request path, so a call it never logged was never
// paid. Its row stays as evidence of what the CLI said, but every count reads the same number:
// the calls the proxy logged.
test("I8 a call the proxy never saw is counted the same way live, on resume and in the run total", async () => {
  const target = ttlId("treatment", 2)
  const h = harness()
  const push = h.proxy.push
  h.proxy.push = (r) => (r?.stepId === target ? undefined : push(r))
  const s = await h.run({ only: ONLY_TTL })
  const logged = h.proxy.records
  const ttlLogged = logged.filter((r) => r.stepId.startsWith(`${TTL}/`)).length
  const r = resumeHarness(processLog(h))
  const s2 = await r.run({ resume: "fake-run", only: ONLY_TTL })
  const observed = JSON.stringify({ logged: logged.length, ttlLogged, live: [s.paidRequestsIssued, s.experiments[TTL].paidRequests], resumed: [s2.paidRequestsIssued, s2.experiments[TTL].paidRequests] })
  assert.equal(h.ledger.requests.filter((x) => x.stepId === target).length, 1, `the unseen call keeps its row: ${observed}`)
  assert.equal(s.paidRequestsIssued, logged.length, `live run total: ${observed}`)
  assert.equal(s.experiments[TTL].paidRequests, ttlLogged, `live experiment count: ${observed}`)
  assert.equal(s2.paidRequestsIssued, logged.length, `resumed run total: ${observed}`)
  assert.equal(s2.experiments[TTL].paidRequests, ttlLogged, `resumed experiment count: ${observed}`)
  // the marker a consumer reads: the unpaid row says requestCount 0, every paid row at least 1
  const counts = h.ledger.requests.map((x) => [x.stepId, x.accounting?.requestCount])
  assert.deepEqual(counts.filter(([, n]) => !(n >= 1)), [[target, 0]], `only the unseen call's row is unpaid: ${JSON.stringify(counts)}`)
})

// N2 / GM5. The tick charged for a result whose row is missing is not just reported, it is SPENT:
// it reaches the frame and the plan before anything else is gated. With C1's row gone its reading
// is unknown, so the next row's delta absorbs whatever C1 moved and C1 itself is charged one tick:
// exactly +0.01 over the same resume with every row present.
test("I11 the tick charged for a missing row reaches the frame and the plan spend", async () => {
  const fx = await crashFixture({ stepId: ttlId("treatment", 4), withProxyRecord: true })
  const gone = ttlId("control", 1)
  const control = resumeHarness(fx)
  const sc = await control.run({ resume: "fake-run", only: ONLY_TTL })
  const h = resumeHarness({ ...fx, requests: fx.requests.filter((r) => r.stepId !== gone) })
  const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
  const frameOf = (x) => x.ledger.requests.find((r) => r.stepId === fx.stepId && r.accounting?.source === "proxy_reconciled").accounting
  const observed = JSON.stringify({ control: [frameOf(control), sc.experiments[TTL]], dropped: [frameOf(h), s.experiments[TTL]] })
  assert.deepEqual(h.ev("row_missing").map((e) => [e.stepId, e.charged]), [[gone, 1]], observed)
  assert.equal(frameOf(h).scope, `${TTL}/frame`, observed)
  assert.equal(frameOf(h).spentObservedEq, q(frameOf(control).spentObservedEq + 0.01), `frame: ${observed}`)
  assert.equal(frameOf(h).spentUpperEq, q(frameOf(control).spentUpperEq + 0.01), `frame: ${observed}`)
  assert.equal(s.experiments[TTL].spentObservedEq, q(sc.experiments[TTL].spentObservedEq + 0.01), `plan: ${observed}`)
  assert.equal(s.experiments[TTL].spentUpperEq, q(sc.experiments[TTL].spentUpperEq + 0.01), `plan: ${observed}`)
})

// N1 (I4-d). A reconciled ttl row reports its FRAME's spend, and the resume attributes every
// recorded result to the frame before it reconciles - not to the protocol's run scope. Values are
// the gate's GATE-P7 measurement (the frame spend up to and including the reconciled call).
test("I4 a reconciled ttl row reports the frame spend recorded before the crash", async () => {
  const ORDER = ["treatment/0", "control/1", "treatment/2", "control/3", "treatment/4", "treatment/5", "treatment/6", "control/7", "treatment/8", "control/9"]
  for (const [n, obs, up] of [[4, 0.02, 0.03], [9, 0.04, 0.05]]) {
    const fx = await crashFixture({ stepId: `${TTL}/${ORDER[n]}`, withProxyRecord: true })
    const h = resumeHarness(fx)
    await h.run({ resume: "fake-run", only: ONLY_TTL })
    const row = h.ledger.requests.find((r) => r.stepId === fx.stepId).accounting
    const ev = h.ev("step_result").find((e) => e.stepId === fx.stepId).accounting
    const observed = JSON.stringify({ n, row, ev })
    assert.deepEqual([row.scope, row.spentObservedEq, row.spentUpperEq], [`${TTL}/frame`, obs, up], observed)
    assert.deepEqual([ev.scope, ev.spentObservedEq, ev.spentUpperEq], [`${TTL}/frame`, obs, up], observed)
  }
})

// Adversarial for this lane: cancel_resume + repeated_interruptions + misleading_success_output.
// Across a chain of processes the summary keeps saying what the evidence on disk says, including
// when a cancelled call and a two-row reconciliation are in the chain: P1 is cancelled with a call
// in flight that left no row, P2 recovers TWO rows for it from proxy.jsonl, and P3 counts the
// whole run again from the log alone.
test("I8 adversarial: summary counts equal requests.jsonl across a three-process chain", async () => {
  const target = ttlId("treatment", 2)
  const controller = new AbortController()
  const p1 = harness({ script: { [target]: { hang: true } }, opts: { signal: controller.signal } })
  const run = p1.run({ only: ONLY_TTL })
  assert.equal(await within(p1.adapter.entered), target)
  controller.abort()
  const s1 = await within(run)
  assertCountsMatchRows("P1", p1, s1)
  assert.equal(s1.exitCode, EXIT.IN_DOUBT)

  // the call DID reach the API, twice: proxy.jsonl holds two responses for it (the reading of the
  // last call before it, so the reconciliation moves no gauge)
  const before = p1.proxy.records.find((r) => r.stepId === ttlId("control", 1))
  const twin = (i) => ({ ...clone(before), stepId: target, label: target, msg_id: `${before.msg_id}_late${i}` })
  let prev = { ...processLog(p1), proxyRecords: [...p1.proxy.records, twin(1), twin(2)] }
  const intents = []
  let p3 = null
  for (const tag of ["P2", "P3"]) {
    const h = resumeHarness(prev)
    const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
    assertCountsMatchRows(tag, h, s)
    assert.equal(h.ledger.requests.filter((r) => r.stepId === target).length, 2, `${tag}: both recovered rows are on disk`)
    assert.deepEqual(h.ids(), [], `${tag} issues nothing after a recorded cancel`)
    assert.equal(s.exitCode, EXIT.ABORTED, `${tag}: ${JSON.stringify(s)}`)
    intents.push(...h.ledger.events.filter((e) => e.ev === "step_intent").map((e) => e.stepId))
    prev = processLog(h)
    p3 = h
  }
  assert.equal(p3.ev("step_result").length, 0, "P3 counted the run from the log, not from its own calls")
  // the cumulative log of the last process holds each id once
  const last = prev.events.filter((e) => e.ev === "step_intent").map((e) => e.stepId)
  assert.deepEqual([...new Set(last)], last, `an id appears twice in the chain: ${JSON.stringify(last)}`)
})

// ------------------------------------------------------- lane M group C, items I13 and I16
// I13. `mode_set` records what the restore run measured about `--resume`. It was written AFTER
// `experiment_ended`, so a crash in that gap lost it and the next restore/policy run re-measured it
// with its own paid gate call. The verdict is written last; what the run LEARNED is written first.
test("I13 a crash between the restore verdict and the mode loses neither, and pays no extra call", async () => {
  const { live, fixture, world } = await exactWorldCut({ runOpts: { dialPrefix: DIAL }, at: (e) => e.ev === "experiment_ended" && e.experiment === "restore-decomposition" && e.run === 1 })
  const recorded = live.ev("mode_set").at(-1)
  assert.ok(recorded, "the live run measured a mode")
  assert.ok(fixture.events.some((e) => e.ev === "mode_set"), `the cut keeps the mode the run measured: ${JSON.stringify(fixture.events.slice(-3).map((e) => e.ev))}`)
  const h = resumeHarness(fixture, { world, clockStart: fixture.crashedAt })
  const s = await h.run({ resume: "fake-run" })
  const started = h.ev("experiment_started").filter((e) => e.experiment !== "preflight")
  const observed = JSON.stringify({ paid: s.paidRequestsIssued, reMeasured: h.ev("mode_set").length, starts: started.map((e) => `${e.experiment}:${e.mode?.resumeHit}`) })
  for (const e of started) assert.equal(e.mode?.resumeHit, recorded.resumeHit, `${e.experiment} inherits the recorded mode: ${observed}`)
  assert.deepEqual(h.ev("mode_set"), [], `nothing is re-measured, so no new mode_set: ${observed}`)
  assert.equal(s.paidRequestsIssued, 218, `and no extra gated call is paid: ${observed}`)
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
})

// I16. Clarification A (ii) records an operator cancel as `campaign_stop{cancelled}` and keeps the
// in-flight call in doubt until proxy.jsonl settles it. The EXPERIMENT it interrupted was ended by
// the cancel, not by the adapter's structured abort, so its reason is `cancelled` - otherwise the
// analyzer reports an adapter failure for a run the operator stopped on purpose.
test("I16 a cancelled in-flight call closes its experiment void:cancelled, not void:adapter_error", async () => {
  const target = "output-quota/out-8k/2"
  const controller = new AbortController()
  const h = harness({ script: { [target]: { hangAfterRow: true } }, opts: { signal: controller.signal } })
  const run = h.run({ only: ["output-quota", ...ONLY_TTL], dialPrefix: DIAL })
  assert.equal(await within(h.adapter.entered), target, "the call reached the API")
  controller.abort()
  const s = await within(run)
  const ended = h.ev("experiment_ended").filter((e) => e.experiment === "output-quota")
  const observed = JSON.stringify({ ended: ended.map((e) => `${e.status}:${e.reason}`), exp: s.experiments["output-quota"], anomalies: h.ledger.requests.find((r) => r.stepId === target)?.anomalies })
  assert.deepEqual(h.ev("campaign_stop").map((e) => e.reason), ["cancelled"], observed)
  assert.equal(s.experiments["output-quota"].reason, "cancelled", `the operator stopped it, the adapter did not fail it: ${observed}`)
  assert.equal(s.experiments["output-quota"].status, "void", observed)
  // the call itself is still recorded with what the adapter reported
  assert.ok(h.ledger.requests.find((r) => r.stepId === target).anomalies.includes("adapter_error"), `the call keeps its own evidence: ${observed}`)
  assert.equal(s.exitCode, EXIT.ABORTED, observed)
})

test("I16 a cancel with no proxy row still keeps the call in doubt (clarification A (ii))", async () => {
  const target = ttlId("treatment", 2)
  const controller = new AbortController()
  const h = harness({ script: { [target]: { hang: true } }, opts: { signal: controller.signal } })
  const run = h.run({ only: ONLY_TTL })
  assert.equal(await within(h.adapter.entered), target)
  controller.abort()
  const s = await within(run)
  assert.deepEqual(s.inDoubt, [target], "a call with no row is unresolved, whatever the cancel said")
  assert.equal(s.exitCode, EXIT.IN_DOUBT, JSON.stringify(s))
  assert.deepEqual(h.ev("campaign_stop").map((e) => e.reason), ["cancelled"])
  assert.equal(`${s.experiments[TTL].status}:${s.experiments[TTL].reason}`, "void:cancelled", "the operator ended the experiment, not the call")
  // a later resume recovers the call from proxy.jsonl: the call is settled, the verdict stays the cancel's
  const before = h.proxy.records.find((r) => r.stepId === ttlId("control", 1))
  const late = { ...clone(before), stepId: target, label: target, msg_id: `${before.msg_id}_late` }
  const r = resumeHarness({ ...processLog(h), proxyRecords: [...h.proxy.records, late] })
  const s2 = await r.run({ resume: "fake-run", only: ONLY_TTL })
  assert.deepEqual(s2.inDoubt, [], JSON.stringify(s2))
  assert.equal(`${s2.experiments[TTL].status}:${s2.experiments[TTL].reason}`, "void:cancelled", JSON.stringify(s2.experiments[TTL]))
  assert.equal(s2.exitCode, EXIT.ABORTED, JSON.stringify(s2))
})

// ------------------------------------------------------- lane M group C, item I14
// (a) Round-10 note N2: a log can hold BOTH the deciding record and its own campaign_stop. The
// predicate returns the FIRST deciding record in log order - the deciding event, which precedes the
// marker - so every later resume used to append another marker for a stop the log already states.
// The marker is written only when the log holds none.
test("I14 a resume of an already-marked stop writes no second marker", async () => {
  const tick = { bump: { meter: "unified-5h", eq: 0.01 } }
  const { summary, fixture, world } = await exactWorldCut({
    script: { "preflight/baseline/1": tick, "preflight/baseline-2/1": tick, "preflight/baseline-3/1": tick },
    runOpts: { only: ONLY_TTL },
    at: (e) => e.ev === "campaign_stop",
  })
  assert.equal(summary.exitCode, EXIT.ABORTED)
  const seeded = fixture.events.length
  assert.ok(fixture.events.some((e) => e.ev === "quiet_check_failed"), "the deciding event is in the log")
  assert.equal(fixture.events.filter((e) => e.ev === "campaign_stop").length, 1, "and so is its one marker")
  let prev = fixture
  for (const n of [1, 2]) {
    const h = resumeHarness(prev, { world, clockStart: prev.crashedAt })
    const s = await h.run({ resume: "fake-run", only: ONLY_TTL })
    const fresh = h.ledger.events.slice(n === 1 ? seeded : prev.events.length).filter((e) => e.ev === "campaign_stop")
    assert.deepEqual(fresh, [], `resume ${n} re-states a stop the log already holds: ${JSON.stringify(fresh.map((e) => e.reason))}`)
    assert.equal(h.ledger.events.filter((e) => e.ev === "campaign_stop").length, 1, `resume ${n}: the log still holds exactly one marker`)
    assert.deepEqual(h.ids(), [], `resume ${n} issues nothing`)
    assert.equal(s.exitCode, EXIT.ABORTED, `resume ${n}: ${JSON.stringify(s)}`)
    prev = { events: h.ledger.events, requests: h.ledger.requests, cli: h.ledger.cli, proxyRecords: h.proxy.records, crashedAt: Date.parse(h.ledger.events.at(-1).ts) }
  }
})

// (d) Round-10 note N7: the shipped R9-N4 rows pin 7d and 7d_oi at the preflight and 7d at a
// re-baseline. The 4th cell of that matrix - 7d_oi rolling under a re-baseline PING - held only by a
// reviewer script. The anomaly term is meter-agnostic; this says so in the suite.
test("I14 a 7d_oi window roll under a re-baseline PING is an unreadable delta too", async () => {
  const h = harness({ gauge: RESET_GAUGE(60), script: { "preflight/rebaseline/1": { rollReset: "unified-7d_oi" } } })
  const s = await h.run({ only: ["fable-write-tick"], dialPrefix: DIAL })
  const rec = h.ledger.requests.find((r) => r.stepId === "preflight/rebaseline/1")
  const observed = JSON.stringify({ quiet: h.ev("quiet_retry").map((e) => `${e.arm}:${e.reason}`), anomalies: rec.anomalies, m5: rec.meters["unified-5h"]?.sameWindow, oi: rec.meters["unified-7d_oi"]?.sameWindow })
  assert.equal(rec.meters["unified-5h"]?.sameWindow, true, `only the 7d_oi window moved: ${observed}`)
  assert.ok(rec.anomalies.includes("reset_changed"), `the move is recorded on the PING it happened to: ${observed}`)
  assert.ok(h.ids().includes("preflight/rebaseline-2/0"), `the attempt is retried: ${observed}`)
  assert.deepEqual(h.ev("quiet_retry").map((e) => e.reason), ["gauge_moved"], observed)
  assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
})
