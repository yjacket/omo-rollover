// Todo 13: gauge attribution under a lagging ratelimit header, and the stop after a big-context
// fallback miss. The live run 20260925-161302 showed a header that does not carry the call's own
// charge (the todo-9 D1 fit: lag 0 and lag 2 infeasible, lag 1 feasible; per-call vs time-based
// settlement NOT established), so every fake here offers BOTH lag models:
//   * "call": a response's header shows the gauge as it stood BEFORE that call's own charge;
//   * "time": a charge is posted `delayMs` after the call ended, and a header shows only what
//     was posted by the time it was written.
// The fakes are local, minimal copies of the ones in test/idle-live-machine.test.mjs (that file
// exports none). Virtual clock only: sleep() jumps, nothing waits on wall time.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

import { EXIT, runMachine, fold } from "../scripts/idle-live/machine.mjs"
import { analyzeRun } from "../scripts/idle-live-analyze.mjs"
import { RULES, makeTask, EXPERIMENT_IDS } from "../scripts/idle-live/protocols.mjs"
import { METERS } from "../scripts/idle-live/gauge.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")
const APPROVAL = JSON.parse(readFileSync(join(repo, "docs/idle-experiments-approval-2026-09-23.json"), "utf8"))
const SHAS = {
  plannerSha256: sha256(readFileSync(join(repo, "scripts/idle-experiments.mjs"), "utf8")),
  proposalSha256: sha256(readFileSync(join(repo, "docs/idle-experiments-approval-proposal.json"), "utf8")),
}
const clone = (v) => JSON.parse(JSON.stringify(v))

const MODEL = "claude-fable-5-1"
const EPOCH = Date.UTC(2026, 8, 24, 0, 0, 0)
const RESET_5H = Math.floor((EPOCH + 12 * 3600_000) / 1000)
const RESET_7D = Math.floor((EPOCH + 5 * 86400_000) / 1000)
// The todo-9 D1 lag-1 fit: T 80.5K-89.5K write tokens per tick with an output weight >= 1.55.
const T_TOKENS = 89_000
const READ_TOKENS = 5_400_000
const OUT_RATIO = 2.5
const q = (x) => Math.round(x * 100) / 100

// ------------------------------------------------------------------ fakes

function fakeClock(start = EPOCH) {
  let now = start
  return {
    now: () => now,
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { code: "aborted" }))
      if (ms > 0) now += ms
      return Promise.resolve()
    },
  }
}

function memoryProxy({ history = [], records = [] } = {}) {
  const recs = [...records]
  return {
    port: 41999,
    runId: "lag-run",
    records: recs,
    history: [...history],
    push(r) { recs.push(r) },
    async drainSince(cursor = 0) { return { records: recs.slice(cursor), cursor: recs.length } },
    async readLog() { return [...this.history, ...recs] },
    async close() {},
  }
}

function memoryLedger({ events = [], requests = [] } = {}) {
  const ev = events.map(clone)
  const rq = requests.map(clone)
  const cli = new Map()
  return {
    dir: "<memory>",
    events: ev,
    requests: rq,
    cli,
    append(event) {
      const rec = { seq: ev.length, ts: "1970-01-01T00:00:00.000Z", ...event }
      ev.push(rec)
      return rec
    },
    fold() { return { events: ev.slice(), torn: false, lastSeq: ev.length ? ev[ev.length - 1].seq : -1 } },
    tail(n) { return ev.slice(Math.max(0, ev.length - n)) },
    writeRequestRecord(r) { rq.push(r) },
    readRequests() { return rq.slice() },
    writeCli(stepId, obj) { cli.set(stepId, obj) },
    readCli(stepId) { return cli.get(stepId) },
    writeSummary() {},
  }
}

/**
 * One cost accumulator in 5h ticks (acc), shown as floor(acc) on the 5h meter and scaled on the
 * 7d meters. `posts` is the charge history; the lag model decides which of it a header shows.
 */
function lagGauge({ clock, lag = { kind: "call" }, acc0 = 0.5, start = { "unified-5h": 0, "unified-7d": 0.65, "unified-7d_oi": 0.62 } } = {}) {
  let acc = acc0
  let posts = [{ t: -Infinity, acc: acc0 }]
  const divisor = { "unified-5h": 1, "unified-7d": 8, "unified-7d_oi": 4.5 }
  const resets = { "unified-5h": RESET_5H, "unified-7d": RESET_7D, "unified-7d_oi": RESET_7D }
  const visible = (at) => {
    if (lag.kind !== "time") return acc
    let v = acc0
    for (const p of posts) if (p.t + lag.delayMs <= at) v = p.acc
    return v
  }
  return {
    lag,
    acc: () => acc,
    charge(cost, at) { acc += cost; posts.push({ t: at, acc }) },
    headers(at, extra = {}) {
      const shown = visible(at)
      const h = { "anthropic-ratelimit-unified-status": "allowed" }
      for (const m of METERS) {
        const id = m.replace("unified-", "")
        h[`anthropic-ratelimit-unified-${id}-utilization`] = q(start[m] + (Math.floor(shown / divisor[m]) - Math.floor(acc0 / divisor[m])) * 0.01).toFixed(2)
        h[`anthropic-ratelimit-unified-${id}-reset`] = String(resets[m])
        h[`anthropic-ratelimit-unified-${id}-status`] = "allowed"
      }
      return { ...h, ...extra }
    },
    snapshot: () => ({ acc, posts: posts.map((p) => ({ ...p })) }),
    restore(s) { acc = s.acc; posts = s.posts.map((p) => ({ ...p })) },
  }
}

const usage = ({ inp = 12, w1 = 0, rd = 0, out = 4 } = {}) => ({
  input_tokens: inp,
  cache_creation_input_tokens: w1,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 },
  cache_read_input_tokens: rd,
  output_tokens: out,
  service_tier: "standard",
})
const costOf = (u) => (u ? (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) / T_TOKENS + (u.input_tokens ?? 0) / T_TOKENS + (u.cache_read_input_tokens ?? 0) / READ_TOKENS + (u.output_tokens ?? 0) * OUT_RATIO / T_TOKENS : 0)
const LINE_TOKENS = 29.4
const HOT = 145_655

function usageFor(step) {
  const lines = step.prompt?.fillerLines ?? 0
  switch (step.kind) {
    case "ping": return usage({ rd: 3437, out: 4 })
    case "dial": return usage({ rd: HOT, out: 6 })
    case "write": return usage({ w1: Math.round(lines * LINE_TOKENS), rd: 3, out: 20 })
    case "check":
      return step.arm === "treatment"
        ? usage({ rd: Math.round(RULES.ttl.lines * LINE_TOKENS) + 3000, out: 8 })
        : usage({ w1: Math.round(RULES.ttl.lines * LINE_TOKENS), rd: 3, out: 8 })
    case "probe":
      if (step.experiment === "ttl-1h-unique-prefix") return usage({ rd: Math.round(RULES.ttl.lines * LINE_TOKENS) + 3000, out: 6 })
      return usage({ rd: HOT, out: 6 })
    case "work":
      if (step.experiment === "output-quota") return usage({ rd: 3800, out: step.expect?.outputTokensTarget ?? 8000 })
      if (step.role === "park_parent") return usage({ rd: HOT, w1: 12, out: 1200 })
      if (step.role === "r1") return usage({ inp: step.prompt?.tokensEst ?? 400, out: 200 })
      if (step.phase === "restore_child") return usage({ rd: 4000 + (step.index % 10) * 50, out: 60 })
      if (step.phase === "useful_work" && step.session?.mode === "resume" && step.arm !== "raw_path" && step.arm !== "current_policy") return usage({ rd: 4500 + (step.k ?? 0) * 60, out: 30 })
      return usage({ rd: HOT, w1: 12, out: 30 })
    default: return usage({ rd: 3437, out: 4 })
  }
}

function textFor(step, tasks) {
  const task = tasks.get(`${step.experiment}/${step.unit?.index ?? 1}`) ?? null
  if (!task) return "OK"
  const g = task.guardAnswer
  switch (step.role) {
    case "park_parent":
      return [`Goal: close ticket ${task.ticket}.`, `Key facts: ticket ${task.ticket}; record id ${g.id}; site ${g.site}; date ${g.date}; alert threshold ${g.threshold}.0 C.`, `Decision: ${task.decision}`, `Next step: ${task.nextStep}`, "Done so far: read the brief and the log. To do next: score the windows the operator sends."].join("\n")
    case "r1": return `ticket ${task.ticket}\nrecord id ${g.id}\nsite ${g.site}\ndate ${g.date}\nthreshold ${g.threshold}`
    case "r2": return `Next step: ${task.nextStep} I have everything I need; nothing is missing.`
    case "guard":
    case "resume_raw": return `${g.id}, ${g.site}, ${g.threshold}`
    case "work": {
      const w = task.workSteps.find((s) => s.k === step.k)
      return w ? (w.truth.length ? w.truth.join(", ") : "none") : "none"
    }
    default: return "OK"
  }
}

/** Every invoke = one proxy record; the gauge is charged the usage cost (+ `foreignTicks`). */
function fakeAdapter({ proxy, gauge, clock, script = {} }) {
  const invoked = []
  const tasks = new Map()
  const truth = [] // { stepId, experiment, scopeId, cost } - the ground-truth charge of every call
  let msg = 0
  return {
    capabilities: { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model: MODEL },
    invoked,
    truth,
    async invoke(step, env, signal) {
      invoked.push(step.id)
      if (signal?.aborted) throw Object.assign(new Error("aborted before spawn"), { code: "aborted" })
      const s = script[step.id] ?? {}
      // the CLI never started: no proxy row, no charge - the call is in doubt
      if (s.throws) throw Object.assign(new Error("spawn failed"), { code: "spawn_failed" })
      // the landed adapter's refusal before spawn (P file checks): no proxy row, nothing spawned
      if (s.refuses) throw Object.assign(new Error("refused before spawn"), { code: s.refuses })
      if (step.role === "ctx_create" && Number.isInteger(step.seed)) {
        tasks.set(`${step.experiment}/${step.unit.index}`, makeTask(step.seed, { steps: step.experiment === "policy-effect" ? RULES.policy.workSteps : RULES.restore.workSteps }))
      }
      const startedMs = clock.now()
      const endedMs = startedMs + 1500
      const u = s.usage ?? usageFor(step)
      const cost = costOf(u) + (s.foreignTicks ?? 0)
      truth.push({ stepId: step.id, experiment: step.experiment, scopeId: step.scopeId ?? null, cost: costOf(u) })
      // "call" lag: the header is written before the call's own charge is posted.
      let headers
      if (gauge.lag.kind === "call") {
        headers = gauge.headers(endedMs)
        gauge.charge(cost, endedMs)
      } else {
        gauge.charge(cost, endedMs)
        headers = gauge.headers(endedMs)
      }
      msg += 1
      const text = textFor(step, tasks)
      proxy.push({
        ts_req: new Date(startedMs).toISOString(), ts: new Date(endedMs).toISOString(),
        label: step.id, stepId: step.id, runId: proxy.runId, method: "POST", path: "/v1/messages", status: 200,
        model: MODEL, usage: u, stop_reason: s.stop_reason ?? "end_turn", error: null, msg_id: `msg_${msg}`, body_bytes: 512,
        headers: { ...headers, "request-id": `req_${msg}` },
      })
      return { exitCode: 0, signal: null, stdoutJson: { type: "result", subtype: "success", is_error: false, result: text, session_id: step.session?.id ?? null, usage: u }, stdoutHead: null, stderrHead: "", startedMs, endedMs, error: null }
    },
  }
}

function harness({ lag = { kind: "call" }, script = {}, acc0 = 0.5, clockStart = EPOCH, ledger = memoryLedger(), proxy = memoryProxy(), gaugeState = null, seeds = [], uuids = [], opts = {}, tap = null, approval = APPROVAL } = {}) {
  const clock = fakeClock(clockStart)
  const gauge = lagGauge({ clock, lag, acc0 })
  if (gaugeState) gauge.restore(gaugeState)
  const adapter = fakeAdapter({ proxy, gauge, clock, script })
  const events = []
  let seedN = 0
  let uuidN = 0
  const deps = {
    clock, adapter, proxy, ledger,
    processes: { conflicting: async () => [] },
    random: {
      seed: () => (seedN < seeds.length ? seeds[seedN++] : 1000 + seedN++),
      uuid: () => (uuidN < uuids.length ? uuids[uuidN++] : `uuid-${String(++uuidN).padStart(2, "0")}`),
    },
    log: () => {},
    onEvent: (e) => { events.push(e); tap?.(e, { clock, gauge, proxy, ledger }) },
  }
  const runOpts = { runId: "lag-run", evidenceDir: "<memory>", baseUrl: "http://127.0.0.1:41999", ...SHAS, ...opts }
  return { deps, clock, gauge, proxy, adapter, ledger, events, run: (over = {}) => runMachine(deps, clone(approval), { ...runOpts, ...over }) }
}

// The live call shape of restore run 1 (requests.jsonl #4-#6 of 20260925-161302): the context
// write, the `--resume` gate that replayed the whole context (read 3,035 / write 143,423), and
// park_path/2, whose rf-emulation request rewrote the big context again (write 143,444, out 4,238).
// Since Amendment 2026-09-27 (todo 21b) there is no rf-emulation fallback: the same gate reading
// closes the run `aborted:resume_gate_miss` and park_path/2 is never issued.
const LIVE_SHAPE = {
  "restore-decomposition/shared/0": { usage: usage({ w1: 143_362, rd: 3035, out: 4 }) },
  "restore-decomposition/shared/1": { usage: usage({ w1: 143_423, rd: 3035, out: 4 }) },
  "restore-decomposition/park_path/2": { usage: usage({ w1: 143_444, rd: 3035, out: 4238 }) },
}
const FABLE_FIRST_READ = "fable-write-tick/fable-write-1h/0"
const FABLE_WRITE = "fable-write-tick/fable-write-1h/1"
const BIG_CONTEXT = ["policy-effect", "restore-decomposition"]
const LAGS = [
  { name: "one-call header lag", lag: { kind: "call" } },
  // shorter than the 20 s settle wait, longer than any gap the machine leaves inside a protocol
  { name: "time-based lag (settle after 5 s)", lag: { kind: "time", delayMs: 5_000 } },
]

const rowOf = (h, id) => h.ledger.requests.find((r) => r.stepId === id)
const endedOf = (events) => events.filter((e) => e.ev === "experiment_ended")
const verdicts = (events) => Object.fromEntries(endedOf(events).map((e) => [`${e.experiment}#${e.run ?? ""}`, `${e.status}:${e.reason ?? ""}`]))

// ================================================================= (a) attribution

for (const { name, lag } of LAGS) {
  test(`live replay under a ${name}: fable-write-tick's first read is charged 0 and its WRITE-2400 is admitted`, async () => {
    const h = harness({ lag, script: LIVE_SHAPE })
    await h.run()
    // restore run 1 closes at its gate miss (live it went on into the rf-emulation rewrite)
    assert.equal(verdicts(h.events)["restore-decomposition#1"], "aborted:resume_gate_miss")
    const first = rowOf(h, FABLE_FIRST_READ)
    assert.ok(first, "fable's first read was issued")
    assert.equal(first.accounting.scope, "fable-write-tick/block-1")
    assert.equal(first.accounting.spentObservedEq, 0, `the previous scope's late tick was charged to fable: ${JSON.stringify(first.accounting)}`)
    assert.equal(h.events.filter((e) => e.ev === "gate_refused" && e.experiment === "fable-write-tick").length, 0, "fable's WRITE-2400 was refused")
    assert.ok(h.adapter.invoked.includes(FABLE_WRITE), "fable's WRITE-2400 was issued")
    // the late ticks are still spend: of the scope whose calls caused them, and of the meter
    const restore = h.ledger.requests.filter((r) => r.accounting?.scope === "restore-decomposition/run-1")
    const restoreCharged = Math.max(...restore.map((r) => r.accounting.spentObservedEq))
    const restoreTruth = h.adapter.truth.filter((t) => t.scopeId === "restore-decomposition/run-1").reduce((a, t) => a + t.cost, 0)
    assert.ok(restoreCharged * 100 + 1e-9 >= Math.floor(restoreTruth), `restore run 1 is charged its own late ticks (${restoreCharged} vs truth ${restoreTruth.toFixed(3)} ticks)`)
  })
}

test("the settle reading is charged to the previous scope and the next scope's baseline is taken from it", async () => {
  const h = harness({ lag: { kind: "call" }, script: LIVE_SHAPE })
  await h.run()
  const ids = h.adapter.invoked
  const settleAt = ids.indexOf(FABLE_FIRST_READ) - 1
  const settle = h.ledger.requests.find((r) => r.stepId === ids[settleAt])
  assert.equal(settle.experiment, "preflight", "a settle PING outside every experiment precedes fable's first call")
  assert.equal(settle.kind, "ping")
  assert.deepEqual(settle.chargeTo, ["restore-decomposition/run-1", "plan:restore-decomposition"])
  assert.equal(settle.accounting.ticks["unified-5h"], 1, "the settle reading carries the gate's late tick")
  const started = h.events.find((e) => e.ev === "experiment_started" && e.experiment === "fable-write-tick")
  assert.equal(started.baselines["unified-5h"].util, settle.meters["unified-5h"].util, "fable's baseline is the settle reading")
  // the settle sleeps past any time-based posting delay before it reads
  const intentOf = (id) => h.events.find((e) => e.ev === "step_intent" && e.stepId === id)
  assert.ok(Date.parse(settle.ts_req) - Date.parse(rowOf(h, ids[settleAt - 1]).ts) >= RULES.restore.settleMs - 1500)
  assert.equal(intentOf(ids[settleAt]).chargeTo[0], "restore-decomposition/run-1")
})

const FULL = { seeds: [4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110, 4111, 4112], uuids: ["P1", "C1", "P2", "C2", "P3", "C3", "P4", "C4", "P5", "C5", "P6", "C6"] }

function capsOf(scope) {
  const [experiment] = scope.split("/")
  const limits = APPROVAL.plans[experiment]?.limits
  if (!limits) return null
  return scope.endsWith("/frame") ? limits.maxProactiveSpendPerIdle.value * 2 : limits.maxProactiveSpendPerIdle.value
}

for (const { name, lag } of LAGS) {
  for (const [shape, script] of [["the FULL fake-run schedule", {}], ["the live replay", LIVE_SHAPE]]) {
    test(`no scope ends above its cap + one gauge tick under a ${name} (${shape})`, async () => {
      const h = harness({ lag, script, seeds: FULL.seeds, uuids: FULL.uuids })
      const s = await h.run()
      assert.ok(s.exitCode === EXIT.OK || s.exitCode === EXIT.ABORTED, JSON.stringify(s.experiments))
      // attributed spend per scope: the largest spentObservedEq any row reported for it
      const charged = {}
      for (const r of h.ledger.requests) {
        const sc = r.accounting?.scope
        if (!sc || sc.startsWith("preflight/")) continue
        charged[sc] = Math.max(charged[sc] ?? 0, r.accounting.spentObservedEq ?? 0)
      }
      // ground truth per scope: the fake's own cost of every call issued under it
      const truth = {}
      for (const t of h.adapter.truth) {
        if (t.experiment === "preflight") continue
        const sc = t.experiment === "ttl-1h-unique-prefix" ? "ttl-1h-unique-prefix/frame" : t.scopeId
        truth[sc] = (truth[sc] ?? 0) + t.cost
      }
      assert.ok(Object.keys(charged).length > 3)
      for (const [sc, eqv] of Object.entries(charged)) {
        const cap = capsOf(sc)
        assert.ok(eqv <= cap + 0.01 + 1e-9, `${sc}: charged ${eqv} > cap ${cap} + 0.01`)
      }
      for (const [sc, ticks] of Object.entries(truth)) {
        const cap = capsOf(sc)
        // the protocol's own mispriced rf-emulation rewrites are not the gate's to bound
        if (script === LIVE_SHAPE && sc === "restore-decomposition/run-1") continue
        assert.ok(ticks * 0.01 <= cap + 0.01 + 1e-9, `${sc}: true spend ${(ticks * 0.01).toFixed(4)} > cap ${cap} + 0.01`)
      }
      // every meter cap is still enforced on the real cumulative window
      for (const m of METERS) {
        const meter = s.meters[m]
        if (meter.capEq !== null) assert.ok(meter.cumulativeUpperEq <= meter.capEq + 1e-9, `${m}: ${meter.cumulativeUpperEq} > ${meter.capEq}`)
      }
    })
  }
}

test("the phase carry refuses a tick the ticking call cannot explain", async () => {
  // fable's first read shows two ticks (the live #7 shape); its WRITE is then refused, so that read
  // is fable's last call. A known-cost read (1/37 tick) crosses at most one tick boundary, so the
  // phase [0, 1/37] it would carry is not established and output-quota must walk instead.
  const h = harness({ lag: { kind: "none" }, script: { [FABLE_FIRST_READ]: { foreignTicks: 2 } } })
  await h.run({ only: ["fable-write-tick", "output-quota"], dialPrefix: { seed: 77, sessionId: "P-dial" } })
  assert.equal(verdicts(h.events)["fable-write-tick#"], "aborted:cap_exceeded")
  const oq = h.events.find((e) => e.ev === "experiment_started" && e.experiment === "output-quota")
  assert.equal(oq.carryPhase, null, `an unexplained tick was carried: ${JSON.stringify(oq.carryPhase)}`)
  assert.ok(h.ledger.requests.some((r) => r.experiment === "output-quota" && r.role === "pre_walk"), "output-quota walks its own phase")
})

test("an explained tick still carries its phase across a quiet settle PING", async () => {
  // restore run 1's end PING ticks once on its own (the FULL fixture's shape): fable chains from it
  const END_PING = "restore-decomposition/shared/19"
  const h = harness({ lag: { kind: "none" }, script: { [END_PING]: { foreignTicks: 1 } }, seeds: FULL.seeds, uuids: FULL.uuids })
  await h.run({ only: ["restore-decomposition", "fable-write-tick"] })
  const last = h.ledger.requests.filter((r) => r.experiment === "restore-decomposition" && r.run === 1).at(-1)
  assert.equal(last.stepId, END_PING)
  assert.equal(last.kind, "ping")
  assert.equal(last.accounting.ticks["unified-5h"], 1)
  const settle = h.ledger.requests.find((r) => r.stepId === "preflight/settle/0")
  assert.equal(settle.accounting.ticks["unified-5h"], 0, "the settle reading is quiet")
  const fable = h.events.find((e) => e.ev === "experiment_started" && e.experiment === "fable-write-tick")
  assert.deepEqual(fable.carryPhase, [last.phase_ledger.phiLo, last.phase_ledger.phiHi], "the end PING's own phase, carried as the protocols chain across hold PINGs")
  assert.ok(fable.carryPhase[1] <= RULES.rho)
  assert.equal(h.ledger.requests.filter((r) => r.experiment === "fable-write-tick" && r.role === "pre_walk").length, 0, "fable chains instead of walking")
})

// ================================================================= (b) fallback miss

test("after the live replay's gate miss, later big-context experiments close with zero paid calls", async () => {
  const h = harness({ lag: { kind: "call" }, script: LIVE_SHAPE })
  const s = await h.run()
  const v = verdicts(h.events)
  assert.equal(v["restore-decomposition#1"], "aborted:resume_gate_miss")
  assert.equal(v["policy-effect#"], "aborted:fallback_mode_misses")
  assert.equal(v["restore-decomposition#2"], "aborted:fallback_mode_misses")
  const after = h.adapter.invoked.slice(h.adapter.invoked.indexOf("restore-decomposition/shared/1") + 1)
  assert.deepEqual(after.filter((id) => BIG_CONTEXT.some((x) => id.startsWith(`${x}/`))), [], "no big-context call after the miss")
  for (const e of endedOf(h.events).filter((x) => x.reason === "fallback_mode_misses")) assert.equal(e.paidRequests, 0)
  assert.equal(s.experiments["policy-effect"].status, "aborted")
  assert.equal(s.experiments["policy-effect"].reason, "fallback_mode_misses")
  assert.equal(s.experiments["policy-effect"].paidRequests, 0)
  // the TTL frame (not big-context) still runs
  assert.equal(v["ttl-1h-unique-prefix#"], "valid:")
  // the fold sees the same verdicts the live path wrote
  const folded = fold(h.ledger.events)
  assert.equal(folded.experiments["policy-effect"].reason, "fallback_mode_misses")
  assert.equal(folded.experiments["restore-decomposition#2"].reason, "fallback_mode_misses")
})

test("the analyzer reads the fallback-miss verdicts the machine recorded", async () => {
  const h = harness({ lag: { kind: "call" }, script: LIVE_SHAPE })
  await h.run()
  const analysis = analyzeRun(h.ledger.requests, h.ledger.events, { cli: Object.fromEntries(h.ledger.cli), runId: "lag-run" })
  assert.equal(analysis.experiments["policy-effect"].status, "aborted")
  assert.equal(analysis.experiments["policy-effect"].reason, "fallback_mode_misses")
  // restore-decomposition's worst unit stays run 1's own miss
  assert.equal(analysis.experiments["restore-decomposition"].status, "aborted")
  // the settle PINGs are not experiment rows
  assert.ok(!Object.keys(analysis.experiments).includes("preflight"))
})

// ================================================================= (c) resume-sysfile (todo 21b)

const isBig = (id) => BIG_CONTEXT.some((x) => id.startsWith(`${x}/`))
const GATE_MISS = { "restore-decomposition/shared/1": LIVE_SHAPE["restore-decomposition/shared/1"] }

test("a big_context_rewrite after a passed gate (resume-sysfile) closes the later big-context jobs with zero paid calls", async () => {
  const h = harness({ lag: { kind: "none" }, script: { "restore-decomposition/park_path/2": LIVE_SHAPE["restore-decomposition/park_path/2"] } })
  await h.run({ only: ["restore-decomposition", "policy-effect"] })
  const v = verdicts(h.events)
  assert.equal(v["restore-decomposition#1"], "aborted:big_context_rewrite")
  assert.equal(v["policy-effect#"], "aborted:fallback_mode_misses")
  assert.equal(v["restore-decomposition#2"], "aborted:fallback_mode_misses")
  assert.ok(!h.adapter.invoked.some((id) => id.startsWith("policy-effect/")))
})

test("resume-sysfile gate FAIL: run 1 closes resume_gate_miss, later big-context jobs close with zero calls; live, fold and analyzer agree", async () => {
  const h = harness({ lag: { kind: "none" }, script: GATE_MISS })
  const s = await h.run()
  const v = verdicts(h.events)
  assert.equal(v["restore-decomposition#1"], "aborted:resume_gate_miss")
  assert.equal(v["policy-effect#"], "aborted:fallback_mode_misses")
  assert.equal(v["restore-decomposition#2"], "aborted:fallback_mode_misses")
  assert.deepEqual(h.adapter.invoked.filter(isBig), ["restore-decomposition/shared/0", "restore-decomposition/shared/1"], "no big-context call after the gate")
  for (const e of endedOf(h.events).filter((x) => x.reason === "fallback_mode_misses")) {
    assert.equal(e.paidRequests, 0)
    assert.equal(e.decidedBy.experiment, "restore-decomposition")
  }
  assert.equal(v["ttl-1h-unique-prefix#"], "valid:", "experiments without the big context still run")
  assert.equal(s.experiments["policy-effect"].reason, "fallback_mode_misses")
  assert.equal(s.experiments["policy-effect"].paidRequests, 0)
  const folded = fold(h.ledger.events)
  assert.equal(folded.experiments["policy-effect"].reason, "fallback_mode_misses")
  assert.equal(folded.experiments["restore-decomposition#2"].reason, "fallback_mode_misses")
  const analysis = analyzeRun(h.ledger.requests, h.ledger.events, { cli: Object.fromEntries(h.ledger.cli), runId: "lag-run" })
  assert.equal(analysis.experiments["restore-decomposition"].reason, "resume_gate_miss")
  assert.equal(analysis.experiments["policy-effect"].reason, "fallback_mode_misses")
})

for (const [label, at] of [
  ["after the gate's mode_set, before its verdict", (e) => e.ev === "mode_set"],
  ["after the resume_gate_miss verdict", (e) => e.ev === "experiment_ended" && e.reason === "resume_gate_miss"],
]) {
  test(`crash cut ${label}: the resume closes every later big-context job without a call`, async () => {
    const c = await liveAndCut(at, { lag: { kind: "none" }, script: GATE_MISS })
    const v = verdicts(c.r.ledger.events)
    assert.equal(v["policy-effect#"], "aborted:fallback_mode_misses")
    assert.equal(v["restore-decomposition#2"], "aborted:fallback_mode_misses")
    assert.deepEqual(c.r.adapter.invoked.filter(isBig), [], "the resume issued no big-context call")
  })
}

test("step_intent logs the P file and sha for ctx_create and every later big-context call, never for the child", async () => {
  const h = harness({ lag: { kind: "none" } })
  await h.run({ only: ["restore-decomposition"] })
  const intents = h.events.filter((e) => e.ev === "step_intent" && e.experiment === "restore-decomposition" && e.run === 1)
  const withP = intents.filter((e) => e.systemPrompt)
  const roles = withP.map((e) => e.role)
  assert.deepEqual(roles, ["ctx_create", "gate", "park_parent", "resume_raw", ...Array(RULES.restore.workSteps).fill("work")])
  const seed = h.events.find((e) => e.ev === "experiment_started" && e.experiment === "restore-decomposition").seeds[0]
  for (const e of withP) assert.deepEqual(e.systemPrompt, { file: `P-${seed}.txt`, sha256: withP[0].systemPrompt.sha256, bytes: withP[0].systemPrompt.bytes })
  assert.ok(!intents.some((e) => e.phase === "restore_child" && e.systemPrompt))
  const ended = endedOf(h.events).find((e) => e.experiment === "restore-decomposition")
  assert.equal(ended.result.mode, "resume-sysfile")
})

test("a P file refused before spawn voids the step without doubt: no call, experiment aborted, run not in doubt", async () => {
  const h = harness({ lag: { kind: "none" }, script: { "restore-decomposition/shared/1": { refuses: "system_prompt_mismatch" } } })
  const s = await h.run({ only: ["restore-decomposition"] })
  const voided = h.events.find((e) => e.ev === "step_void" && e.stepId === "restore-decomposition/shared/1")
  assert.equal(voided.reason, "system_prompt_mismatch")
  assert.notEqual(voided.inDoubt, true)
  assert.equal(h.proxy.records.filter((r) => r.stepId === "restore-decomposition/shared/1").length, 0)
  assert.equal(verdicts(h.events)["restore-decomposition#1"], "aborted:system_prompt_mismatch")
  assert.notEqual(s.exitCode, EXIT.IN_DOUBT)
  assert.equal(fold(h.ledger.events).inDoubt.length, 0)
})

// ================================================================= crash cuts

/**
 * Runs the live replay once, recording the world (gauge, proxy, ledger sizes, clock) at every
 * event, and returns a resume for a cut right after event `at` (a predicate). `withRow`: the
 * cut's call reached the API and its proxy row exists (cut at step_intent only).
 */
async function liveAndCut(at, { withRow = false, lag = { kind: "call" }, script = LIVE_SHAPE, runOpts = {} } = {}) {
  const worlds = []
  const live = harness({
    lag, script,
    tap: (e, w) => worlds.push({ seq: e.seq, clock: w.clock.now(), gauge: w.gauge.snapshot(), proxy: w.proxy.records.length }),
  })
  const summary = await live.run(runOpts)
  const i = live.ledger.events.findIndex(at)
  assert.ok(i >= 0, "the cut event exists in the live run")
  const cutEvents = live.ledger.events.slice(0, i + 1)
  const cutEv = cutEvents[i]
  // the world at the cut, or - for an issued call - after its response
  const resultIdx = withRow ? live.ledger.events.findIndex((e) => e.ev === "step_result" && e.stepId === cutEv.stepId) : i
  const world = worlds[resultIdx]
  const resultIds = new Set(cutEvents.filter((e) => e.ev === "step_result").map((e) => e.stepId))
  const requests = live.ledger.requests.filter((r) => resultIds.has(r.stepId))
  const records = live.proxy.records.slice(0, world.proxy)
  const r = harness({
    lag, script,
    ledger: memoryLedger({ events: cutEvents, requests }),
    proxy: memoryProxy({ history: records }),
    gaugeState: world.gauge, clockStart: world.clock + 60_000,
  })
  const resumed = await r.run({ resume: true, ...runOpts })
  return { live, summary, r, resumed, cutIds: new Set(cutEvents.filter((e) => e.stepId).map((e) => e.stepId)) }
}

const isSettle = (e) => typeof e.stepId === "string" && e.stepId.startsWith("preflight/settle")

function assertResumedLikeLive({ live, summary, r, resumed, cutIds }, { interrupted = null } = {}) {
  // (iii) nothing the log already names is issued again
  for (const id of r.adapter.invoked) assert.ok(!cutIds.has(id), `resume re-issued ${id}`)
  // restore run 1's spend - including the late ticks the settle reading carried - is the live one
  assert.equal(resumed.experiments["restore-decomposition"].spentObservedEq, summary.experiments["restore-decomposition"].spentObservedEq)
  // the next scope is never charged the previous scope's tick
  const first = r.ledger.requests.find((x) => x.stepId === FABLE_FIRST_READ)
  if (first) assert.equal(first.accounting.spentObservedEq, 0)
  assert.equal(r.events.filter((e) => e.ev === "gate_refused" && e.experiment === "fable-write-tick").length, 0)
  // every verdict equals the live one, except the job the crash interrupted
  const lv = verdicts(live.ledger.events)
  const rv = verdicts(r.ledger.events)
  for (const [k, v] of Object.entries(lv)) {
    if (k === interrupted) assert.equal(rv[k], "void:interrupted_by_crash")
    else if (k.startsWith("output-quota")) continue // walks its own phase after a resume
    else assert.equal(rv[k], v, `${k}: resumed ${rv[k]} vs live ${v}`)
  }
  // no big-context call is issued after the recorded fallback miss
  assert.deepEqual(r.adapter.invoked.filter((id) => BIG_CONTEXT.some((x) => id.startsWith(`${x}/`))), [])
}

test("crash cut at the settle PING's intent without a proxy row: exit 4, nothing issued", async () => {
  const { r, resumed } = await liveAndCut((e) => e.ev === "step_intent" && isSettle(e))
  assert.equal(resumed.exitCode, EXIT.IN_DOUBT)
  assert.deepEqual(r.adapter.invoked, [])
})

test("crash cut at the settle PING's intent with its proxy row: reconciled to the previous scope, resumed like live", async () => {
  const c = await liveAndCut((e) => e.ev === "step_intent" && isSettle(e), { withRow: true })
  const rec = c.r.events.find((e) => e.ev === "step_result" && isSettle(e) && e.source === "proxy_reconciled")
  assert.ok(rec, "the settle PING is reconciled from proxy.jsonl")
  assert.deepEqual(rec.chargeTo, ["restore-decomposition/run-1", "plan:restore-decomposition"])
  assertResumedLikeLive(c)
})

test("crash cut between the settle PING's result and the next experiment: resumed like live", async () => {
  const c = await liveAndCut((e) => e.ev === "step_result" && isSettle(e))
  // the settle is already in the log: the resume does not settle again before its quiet check
  assert.ok(c.r.adapter.invoked[0].startsWith("preflight/baseline-r1/"), c.r.adapter.invoked.slice(0, 3).join(","))
  assertResumedLikeLive(c)
})

test("crash cut after the next experiment_started (before its first call): resumed like live", async () => {
  const c = await liveAndCut((e) => e.ev === "experiment_started" && e.experiment === "fable-write-tick")
  assertResumedLikeLive(c, { interrupted: "fable-write-tick#" })
})

test("crash cut right after the fallback miss: the resume settles the previous scope first and closes big-context jobs without calls", async () => {
  const c = await liveAndCut((e) => e.ev === "experiment_ended" && e.reason === "resume_gate_miss")
  // the log's last paid call was restore run 1's: its late ticks are read before the quiet check
  assert.ok(c.r.adapter.invoked[0].startsWith("preflight/settle-r1/"), c.r.adapter.invoked.slice(0, 3).join(","))
  assertResumedLikeLive(c)
})

test("crash cut after policy-effect's fallback verdict: restore run 2 is closed the same way on resume", async () => {
  const c = await liveAndCut((e) => e.ev === "experiment_ended" && e.experiment === "policy-effect")
  assert.equal(verdicts(c.r.ledger.events)["restore-decomposition#2"], "aborted:fallback_mode_misses")
  assertResumedLikeLive(c)
})

// ================================================================= run-end settle

// The campaign's last paid call may still owe its charge when the run ends: the summary's meter
// totals are an UPPER bound, so the machine settles the meter once more before `run_ended`.
const TTL_LAST = "ttl-1h-unique-prefix/control/9"
const TTL_KEYS = ["ttl-1h-unique-prefix/frame", "plan:ttl-1h-unique-prefix"]
const lastIntentIs = (pred) => (e, i, arr) => pred(e) && !arr.slice(i + 1).some((x) => x.ev === "step_intent")
const trueTicks = (h, acc0 = 0.5) => Math.floor(h.gauge.acc()) - Math.floor(acc0)

for (const { name, lag } of LAGS) {
  test(`run end under a ${name}: the last call's owed ticks are in the summary's 5h upper bound`, async () => {
    // the last call owes at least two ticks its own header cannot show
    const h = harness({ lag, script: { [TTL_LAST]: { foreignTicks: 2 } } })
    const s = await h.run({ only: ["ttl-1h-unique-prefix"] })
    assert.equal(s.exitCode, EXIT.OK, JSON.stringify(s.experiments))
    const upper = s.meters["unified-5h"].cumulativeUpperEq
    assert.ok(upper * 100 + 1e-9 >= trueTicks(h), `5h upper ${upper} understates the true ${trueTicks(h)} ticks`)
    const ids = h.adapter.invoked
    assert.ok(ids.at(-1).startsWith("preflight/settle/"), `the run ends on a settle PING: ${ids.slice(-2).join(",")}`)
    const settle = rowOf(h, ids.at(-1))
    assert.deepEqual(settle.chargeTo, TTL_KEYS)
    assert.ok(settle.accounting.ticks["unified-5h"] >= 2, "the settle reading carries the owed ticks")
    assert.equal(s.unsettledTail, false)
    // the settle precedes run_ended
    const ended = h.ledger.events.findIndex((e) => e.ev === "run_ended")
    assert.ok(h.ledger.events.findIndex((e) => e.ev === "step_result" && e.stepId === ids.at(-1)) < ended)
  })
}

test("run end after a cap-driven campaign stop that followed a paid call: the meter is still settled", async () => {
  const approval = clone(APPROVAL)
  approval.campaignStop["unified-5h"] = 0.1
  const h = harness({ lag: { kind: "call" }, approval, seeds: FULL.seeds, uuids: FULL.uuids })
  const s = await h.run()
  const refused = h.events.find((e) => e.ev === "gate_refused" && e.reasons.some((r) => String(r.scope).startsWith("campaign-stop:")))
  assert.ok(refused, "the campaign-stop cap tripped")
  assert.equal(s.exitCode, EXIT.ABORTED)
  const ids = h.adapter.invoked
  assert.ok(ids.at(-1).startsWith("preflight/settle/"), ids.slice(-2).join(","))
  assert.ok(!ids.at(-2).startsWith("preflight/"), "the settled call was an experiment's")
  assert.equal(s.unsettledTail, false)
  assert.ok(s.meters["unified-5h"].cumulativeUpperEq * 100 + 1e-9 >= trueTicks(h))
})

test("run end after an operator cancel: no settle PING, and the summary flags the unread tail", async () => {
  const controller = new AbortController()
  const h = harness({
    lag: { kind: "call" }, script: { [TTL_LAST]: { foreignTicks: 2 } }, opts: { signal: controller.signal },
    tap: (e) => { if (e.ev === "step_result" && e.stepId === TTL_LAST) controller.abort() },
  })
  const s = await h.run({ only: ["ttl-1h-unique-prefix"] })
  assert.equal(h.adapter.invoked.at(-1), TTL_LAST, "nothing is issued after the cancel")
  assert.equal(s.unsettledTail, true)
  assert.equal(s.unsettledTailReason, "cancelled")
  assert.deepEqual(h.events.filter((e) => e.ev === "campaign_stop").map((e) => e.reason), ["cancelled"])
  assert.equal(s.exitCode, EXIT.ABORTED)
})

test("run end after a global stop rule (refusal): no settle PING, and the summary flags the unread tail", async () => {
  const h = harness({ lag: { kind: "call" }, script: { "ttl-1h-unique-prefix/treatment/2": { stop_reason: "refusal" } } })
  const s = await h.run({ only: ["ttl-1h-unique-prefix"] })
  assert.equal(h.adapter.invoked.at(-1), "ttl-1h-unique-prefix/treatment/2")
  assert.equal(s.unsettledTail, true)
  assert.equal(s.unsettledTailReason, "refusal")
  assert.equal(s.exitCode, EXIT.ABORTED)
})

test("run end with no paid call since the last quiet reading: no settle PING, tail not flagged", async () => {
  const tick = { foreignTicks: 1 }
  const h = harness({ lag: { kind: "none" }, script: { "preflight/baseline/1": tick, "preflight/baseline-2/1": tick, "preflight/baseline-3/1": tick } })
  const s = await h.run({ only: ["ttl-1h-unique-prefix"] })
  assert.ok(h.events.some((e) => e.ev === "quiet_check_failed"))
  assert.ok(!h.adapter.invoked.some((id) => id.startsWith("preflight/settle")))
  assert.equal(s.unsettledTail, false)
})

test("crash cut at the final settle's intent without a proxy row: exit 4, nothing issued", async () => {
  const { r, resumed } = await liveAndCut(lastIntentIs((e) => e.ev === "step_intent" && isSettle(e)))
  assert.equal(resumed.exitCode, EXIT.IN_DOUBT)
  assert.deepEqual(r.adapter.invoked, [])
  assert.equal(resumed.unsettledTail, true)
})

for (const [label, at, withRow] of [
  ["at the final settle's intent with its proxy row", lastIntentIs((e) => e.ev === "step_intent" && isSettle(e)), true],
  ["between the final settle's result and run_ended", lastIntentIs((e) => e.ev === "step_result" && isSettle(e)), false],
]) {
  test(`crash cut ${label}: resumed without re-issuing it, meters as live`, async () => {
    const { summary, r, resumed } = await liveAndCut(at, { withRow })
    assert.deepEqual(r.adapter.invoked, [], "nothing is issued")
    assert.equal(resumed.exitCode, summary.exitCode)
    assert.equal(resumed.unsettledTail, false)
    for (const m of METERS) assert.equal(resumed.meters[m].cumulativeUpperEq, summary.meters[m].cumulativeUpperEq, m)
  })
}

test("crash cut after the last experiment_ended, before the final settle: the resume settles the meter", async () => {
  const lastEnded = (e, i, arr) => e.ev === "experiment_ended" && !arr.slice(i + 1).some((x) => x.ev === "experiment_ended")
  const { summary, r, resumed } = await liveAndCut(lastEnded)
  assert.deepEqual(r.adapter.invoked, ["preflight/settle-r1/0"])
  assert.deepEqual(rowOf(r, "preflight/settle-r1/0").chargeTo, TTL_KEYS)
  assert.equal(resumed.unsettledTail, false)
  for (const m of METERS) assert.equal(resumed.meters[m].cumulativeUpperEq, summary.meters[m].cumulativeUpperEq, m)
})

// ================================================================= settle charges in the summary

// Gate B1 (st_01a0da1b): a settle charges the late tick to the settled experiment's plan scope
// AFTER that experiment ended, so its summary spend must be read from the scope, not from a
// snapshot taken at its end. Live summary == plan-scope charge == resumed summary.
const PLAN_OF = (r) => (Array.isArray(r.chargeTo) ? r.chargeTo[1] : `plan:${r.experiment}`)
function planCharges(h) {
  const out = {}
  for (const r of h.ledger.requests) {
    const t = r.accounting?.ticks?.["unified-5h"]
    if (!Number.isFinite(t)) continue
    const key = PLAN_OF(r)
    out[key] = (out[key] ?? 0) + Math.max(0, t)
  }
  return out
}
const q2 = (x) => Math.round(x * 100) / 100
function assertSummaryIsPlanCharge(h, s, label) {
  const charged = planCharges(h)
  for (const id of Object.keys(s.experiments)) {
    const ticks = charged[`plan:${id}`]
    if (ticks === undefined) continue
    assert.equal(s.experiments[id].spentObservedEq, q2(ticks * 0.01), `${label} ${id}: summary vs plan-scope charge`)
    assert.equal(s.experiments[id].spentUpperEq, q2(ticks * 0.01 + 0.01), `${label} ${id}: upper`)
  }
}

for (const { name, lag } of [...LAGS, { name: "no lag", lag: { kind: "none" } }]) {
  for (const [shape, script] of [["the live replay", LIVE_SHAPE], ["the FULL schedule", {}]]) {
    test(`summary spend per experiment is its plan-scope charge, settles included, under ${name} (${shape})`, async () => {
      const h = harness({ lag, script, seeds: FULL.seeds, uuids: FULL.uuids })
      const s = await h.run()
      assertSummaryIsPlanCharge(h, s, name)
      if (lag.kind === "call" && script === LIVE_SHAPE) {
        // the case the gate reproduced: the run-end settle reads the TTL frame's late tick
        const last = h.ledger.requests.at(-1)
        assert.ok(last.stepId.startsWith("preflight/settle/") && last.accounting.ticks["unified-5h"] >= 1, JSON.stringify(last.accounting.ticks))
      }
    })
  }
}

for (const { name, lag } of LAGS) {
  test(`a middle experiment's late tick read by the boundary settle is in its summary spend (${name})`, async () => {
    const only = { only: ["fable-write-tick", "output-quota"], dialPrefix: { seed: 77, sessionId: "P-dial" } }
    // deterministic: learn fable's last call, then make it owe one more tick than it shows
    const probe = harness({ lag })
    await probe.run(only)
    const fableLast = probe.adapter.invoked.filter((id) => id.startsWith("fable-write-tick/")).at(-1)
    const h = harness({ lag, script: { [fableLast]: { foreignTicks: 1 } } })
    const s = await h.run(only)
    const settle = h.ledger.requests.find((r) => r.stepId === "preflight/settle/0")
    assert.equal(settle.chargeTo[1], "plan:fable-write-tick", "the boundary settle is charged to fable")
    assert.ok(settle.accounting.ticks["unified-5h"] >= 1, "the boundary settle reads fable's late tick")
    assertSummaryIsPlanCharge(h, s, name)
  })
}

for (const { name, lag } of LAGS) {
  test(`live replay under ${name}: live summary == plan-scope charge == resumed summary of the settled log`, async () => {
    const lastSettleResult = (e, i, arr) => e.ev === "step_result" && isSettle(e) && !arr.slice(i + 1).some((x) => x.ev === "step_result")
    const { live, summary, r, resumed } = await liveAndCut(lastSettleResult, { lag })
    assert.deepEqual(r.adapter.invoked, [])
    assertSummaryIsPlanCharge(live, summary, "live")
    for (const id of Object.keys(summary.experiments)) {
      assert.equal(resumed.experiments[id].spentObservedEq, summary.experiments[id].spentObservedEq, `${id}: resumed vs live`)
      assert.equal(resumed.experiments[id].spentUpperEq, summary.experiments[id].spentUpperEq, `${id}: resumed vs live upper`)
    }
  })
}

// Gate N2 / mutant G10: the LIVE path must not settle after its last paid call is left in doubt.
test("run end after a live in-doubt last call: no settle PING, exit 4, tail flagged in_doubt_step", async () => {
  const h = harness({ lag: { kind: "call" }, script: { [TTL_LAST]: { throws: true } } })
  const s = await h.run({ only: ["ttl-1h-unique-prefix"] })
  assert.equal(h.adapter.invoked.at(-1), TTL_LAST, "nothing is issued after the in-doubt call")
  assert.ok(!h.adapter.invoked.some((id) => id.startsWith("preflight/settle")))
  assert.equal(s.exitCode, EXIT.IN_DOUBT)
  assert.deepEqual(s.inDoubt, [TTL_LAST])
  assert.equal(s.unsettledTail, true)
  assert.equal(s.unsettledTailReason, "in_doubt_step")
})

// ================================================================= todo 16: RN1/RN4 test pins

// RN1 (gate st_01a0da1b re-review 1): the B1 fix must be status-agnostic. output-quota/out-8k/0
// is the block's gate call (n=1); a short output closes the block, and so the whole experiment,
// `aborted:short_output` with exactly one call issued. It is made to owe one extra tick its own
// header (under lag) cannot show; only the run-end settle that follows reads it, charged to
// output-quota's plan scope AFTER the experiment already ended. Mutant R2 ("apply the summary fix
// to `valid` experiments only") would leave this void/aborted experiment's summary at the stale
// end-of-experiment snapshot (0 of the settled tick) instead of the plan-scope charge.
for (const { name, lag } of LAGS) {
  test(`RN1: a void/aborted experiment's late tick, settled after it ended, is in its summary spend (${name})`, async () => {
    const runOpts = { only: ["output-quota"], dialPrefix: { seed: 77, sessionId: "P-dial" } }
    // deterministic: learn output-quota's gate call (the dial preWalk length varies with the
    // cache-hit walk), then make that same call short and owe one more tick than its own header
    // (under lag) can show
    const probe = harness({ lag })
    await probe.run(runOpts)
    const OQ = probe.ledger.requests.find((x) => x.experiment === "output-quota" && x.role === "gate")?.stepId
    assert.ok(OQ, "the gate call was issued")
    const script = { [OQ]: { usage: usage({ rd: 3800, out: 1 }), foreignTicks: 1 } }
    const lastSettleResult = (e, i, arr) => e.ev === "step_result" && isSettle(e) && !arr.slice(i + 1).some((x) => x.ev === "step_result")
    const { live, summary, r, resumed } = await liveAndCut(lastSettleResult, { lag, script, runOpts })
    // no output-quota work call after the gate: the short gate closes the block (and experiment)
    const workAfterGate = live.ledger.requests.filter((x) => x.experiment === "output-quota" && x.kind === "work" && x.stepId !== OQ)
    assert.deepEqual(workAfterGate, [], "the short gate call closes output-quota")
    assert.equal(summary.experiments["output-quota"].status, "aborted")
    assert.equal(summary.experiments["output-quota"].reason, "short_output")
    const settle = live.ledger.requests.find((x) => isSettle(x))
    assert.ok(settle, "a run-end settle follows the void/aborted close")
    assert.deepEqual(settle.chargeTo, ["output-quota/block-1", "plan:output-quota"])
    assert.ok(settle.accounting.ticks["unified-5h"] >= 1, "the settle reads the late tick")
    const planTicks = live.ledger.requests.filter((x) => PLAN_OF(x) === "plan:output-quota").reduce((a, x) => a + Math.max(0, x.accounting?.ticks?.["unified-5h"] ?? 0), 0)
    assert.ok(planTicks >= 1)
    // live summary == the plan-scope charge (not the stale end-of-experiment snapshot)
    assert.equal(summary.experiments["output-quota"].spentObservedEq, q2(planTicks * 0.01), "summary vs plan-scope charge")
    assert.equal(summary.experiments["output-quota"].spentUpperEq, q2(planTicks * 0.01 + 0.01))
    // == the resumed summary of the same (fully settled) log
    assert.deepEqual(r.adapter.invoked, [])
    assert.equal(resumed.experiments["output-quota"].spentObservedEq, summary.experiments["output-quota"].spentObservedEq, "resumed vs live")
    assert.equal(resumed.experiments["output-quota"].spentUpperEq, summary.experiments["output-quota"].spentUpperEq, "resumed vs live upper")
  })
}

// RN4 (gate st_01a0da1b re-review 1): experiments that never ran must report the literal 0/0, not
// a read of their (empty, or preflight-charged) `plan:<id>` scope. A mutant that folds not-run
// experiments into the same scope-read as ran ones would leak a foreign tick charged to
// `plan:preflight` (the quiet-check PING) into a not-run experiment's summary; that mutant is not
// killed by the existing suite (its lag tests only cover experiments that ran).
test("RN4: experiments that never ran report 0/0 after a cap-driven campaign stop", async () => {
  const approval = clone(APPROVAL)
  approval.campaignStop["unified-5h"] = 0.02 // trips before ttl/policy-effect/restore-decomposition even start
  // a quiet-check tick charged into plan:preflight, so a scope-leaking mutant has something to leak
  const h = harness({ lag: { kind: "call" }, approval, seeds: FULL.seeds, uuids: FULL.uuids, script: { "preflight/baseline/0": { foreignTicks: 1 } } })
  const s = await h.run()
  const preflightTicks0 = h.ledger.requests.filter((x) => PLAN_OF(x) === "plan:preflight").reduce((a, x) => a + Math.max(0, x.accounting?.ticks?.["unified-5h"] ?? 0), 0)
  assert.ok(preflightTicks0 >= 1, "the quiet-check tick landed on plan:preflight")
  assert.equal(s.exitCode, EXIT.ABORTED)
  const notRun = EXPERIMENT_IDS.filter((id) => s.experiments[id].status === "not_run")
  assert.ok(notRun.length > 0, "at least one experiment never started")
  for (const id of notRun) {
    assert.equal(s.experiments[id].spentObservedEq, 0, `${id}: not-run spentObservedEq`)
    assert.equal(s.experiments[id].spentUpperEq, 0, `${id}: not-run spentUpperEq`)
  }
})

// On --dry-run no experiment record exists at all, so summaryOf takes its no-record branch - the
// only branch the campaign-stop test above never reaches (there every scheduled experiment has a
// not_run placeholder record). This test pins that branch: a mutant reporting its spend as null
// ("unknown") instead of 0, or dropping the dry_run reason, fails here (task-18/mutant-rn4-dry.txt).
test("RN4: experiments that never ran report 0/0 on the dry-run path", async () => {
  const h = harness({ lag: { kind: "call" } })
  const s = await h.run({ dryRun: true })
  assert.equal(s.dryRun, true)
  assert.equal(h.adapter.invoked.length, 0, "no call is issued on --dry-run")
  for (const id of EXPERIMENT_IDS) {
    assert.equal(s.experiments[id].status, "not_run")
    assert.equal(s.experiments[id].reason, "dry_run")
    assert.equal(s.experiments[id].spentObservedEq, 0, `${id}: dry-run spentObservedEq`)
    assert.equal(s.experiments[id].spentUpperEq, 0, `${id}: dry-run spentUpperEq`)
  }
})

// RN5 (todo 19, gate st_01a0da9f re-review 1 note RR5): the campaign-stop RN4 test above and the
// dry-run RN4 test above both reach summaryOf's RECORD branch - the campaign-stop path fills a
// `not_run` placeholder for every scheduled job before summaryOf ever runs (line ~1951), and the
// dry-run path never charges anything at all. Neither exercises the branch summaryOf takes when
// `st.experiments[id]` is genuinely absent (no placeholder) AFTER a charged tick: the smoke path
// (preflight + a quiet check, no experiment ever started). Here the quiet check's PING sees a
// foreign tick on every one of its 3 attempts, so `quiet_check_failed` stops the campaign before
// smokeRun ever creates an experiment record - `st.experiments` is empty for all five ids, and
// summaryOf's no-record branch is the ONLY branch in play. A mutant that reads spend from
// `plan:<id>` (or any scope) in that branch, instead of the literal 0, would leak the charged
// `plan:preflight` tick into every never-run experiment's summary; RN5 kills it
// (task-19/mutant.txt).
test("RN5: a campaign refused after a charged quiet-check tick (no experiment ever started) reports 0/0 for every experiment", async () => {
  const script = {
    "preflight/baseline/0": { foreignTicks: 1 },
    "preflight/baseline-2/0": { foreignTicks: 1 },
    "preflight/baseline-3/0": { foreignTicks: 1 },
  }
  const h = harness({ lag: { kind: "call" }, script })
  const s = await h.run({ smoke: true })
  assert.equal(s.exitCode, EXIT.ABORTED)
  assert.equal(s.smoke?.reason, "foreign_traffic", "the quiet check exhausted its 3 attempts")
  const preflightTicks = h.ledger.requests.filter((x) => PLAN_OF(x) === "plan:preflight").reduce((a, x) => a + Math.max(0, x.accounting?.ticks?.["unified-5h"] ?? 0), 0)
  assert.ok(preflightTicks >= 1, "the quiet-check tick landed on plan:preflight")
  for (const id of EXPERIMENT_IDS) {
    assert.equal(s.experiments[id]?.status, "not_run", `${id}: no experiment ever started`)
    assert.equal(s.experiments[id].spentObservedEq, 0, `${id}: spentObservedEq must not read the charged preflight tick`)
    assert.equal(s.experiments[id].spentUpperEq, 0, `${id}: spentUpperEq must not read the charged preflight tick`)
  }
})
