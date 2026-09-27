// Protocol generators for the idle-cost live run (plan todo 3, Appendix A).
// Every generator is driven here with scripted StepResults: no timer, no clock, no network.
// Assertions pin machine-consumed values only (ids, kinds, offsets, statuses, reasons, numbers).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  filler, SITES, NULLP, OUTP, outp, promptOf,
  makeTask, scoreWork, scoreGuard, reexplainNeeded, handoffLossy,
  protocols, parity, schedule, RULES, EXPERIMENT_IDS, BIG_CONTEXT_MODE, contextFileOf, dialPrefixOf,
} from "../scripts/idle-live/protocols.mjs"

const MODEL = "claude-fable-5-1"
const RHO = 1 / 37
const EPOCH = 1_800_000_000_000
const STEP_MS = 4000 // scripted duration of every paid call
const approval = JSON.parse(readFileSync(new URL("../docs/idle-experiments-approval-proposal.json", import.meta.url), "utf8"))
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// ---------------------------------------------------------------- fixtures

// ctx per the todo: injected random, injected offset clock, mode carried across experiments.
function fakeCtx({ experiment, dial = true, resumeHit = null, run = 1, phase = null, approval: suppliedApproval = approval } = {}) {
  let uuids = 0
  let seeds = 0
  const ctx = {
    experiment,
    approval: suppliedApproval,
    random: { uuid: () => `uuid-${++uuids}`, seed: () => 1000 + ++seeds },
    mode: { resumeHit },
    dialPrefix: dial ? { prompt: makeTask(77).ctxPrompt, sessionId: "P-dial" } : null,
    now: () => ctx.clock,
    priors: { cacheWrite1h: [102000, 143000], cacheRead: [5390000, 5550000] },
    run,
    phase,
    clock: 0,
  }
  return ctx
}

const usage = ({ inp = 2, w5 = 0, w1 = 0, rd = 3437, out = 4 } = {}) => ({
  input_tokens: inp,
  cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  cache_read_input_tokens: rd,
  output_tokens: out,
  service_tier: "standard",
})
const DIAL_HIT = () => usage({ rd: 145655, w1: 0 })
const DIAL_MISS = () => usage({ rd: 3035, w1: 140000 })
const PING = () => usage()
const iso = (ms) => new Date(EPOCH + ms).toISOString()

const record = (step, u, over = {}) => ({
  stepId: step.id,
  ts_req: iso(step.atOffsetMs),
  ts: iso(step.atOffsetMs + STEP_MS),
  model: MODEL,
  stop_reason: "end_turn",
  status: 200,
  usage: u,
  text: null,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  ...over,
})
const result = (rec, { ticks = 0, late = false, anomalies = [] } = {}) => ({
  record: rec,
  anomalies,
  ticks: { "unified-5h": ticks, "unified-7d": 0, "unified-7d_oi": 0 },
  late,
  meters: {},
})

// Drives a generator to completion. The fake clock jumps to each step's completion, so
// offsets computed from ctx.now() are deterministic and replayable.
async function drive(ctx, gen, respond, { max = 3000 } = {}) {
  const requests = []
  let next = await gen.next()
  while (!next.done) {
    const step = next.value
    requests.push(step)
    if (requests.length > max) throw new Error("runaway generator")
    ctx.clock = Math.max(ctx.clock, step.atOffsetMs) + STEP_MS
    next = await gen.next(respond(step, requests.length - 1, requests))
  }
  return { requests, result: next.value }
}

const run = (experiment, opts, respond) => {
  const ctx = fakeCtx({ experiment, ...opts })
  return drive(ctx, protocols[experiment](ctx), respond).then((r) => ({ ...r, ctx }))
}
const roles = (requests) => requests.map((r) => r.role)
const count = (requests, pred) => requests.filter(pred).length

// -------------------------------------------------------- filler and prompts

test("filler is the verbatim 2026-09-19 generator: same seed, same bytes", () => {
  assert.equal(
    filler(7, 3),
    "Weather station log (synthetic test data, seed 7)\nid,site,date,temp_c,humidity,wind_kph,pressure_hpa\n1,Bristol,2020-01-24,29.2,69,41.7,1004.3\n2,Exeter,2022-07-21,14.4,72,20.6,989.4\n3,Kendal,2024-03-08,1.9,36,23.5,1012.1",
  )
  assert.equal(SITES.length, 20)
  assert.equal(SITES[0], "Aberdeen")
  assert.equal(filler(7, 4800).split("\n").length, 4802)
  assert.equal(filler(7, 100), filler(7, 100))
  assert.notEqual(filler(7, 100), filler(8, 100))
  assert.equal(NULLP, "Hi! Quick connectivity check of my CLI setup. Please respond with just the word OK.")
  assert.equal(OUTP, "Please list the integers from 1 to 2000, one per line, with no other text before or after.")
  assert.equal(outp(2000), OUTP)
  assert.equal(outp(1000), "Please list the integers from 1 to 1000, one per line, with no other text before or after.")
})

test("promptOf carries sha256, chars and a tokens estimate (29.4/filler line, chars/3.4 otherwise)", () => {
  const p = promptOf(NULLP)
  assert.equal(p.text, NULLP)
  assert.equal(p.sha256, sha(NULLP))
  assert.equal(p.chars, NULLP.length)
  assert.equal(p.tokensEst, Math.round(NULLP.length / 3.4))
  assert.equal(p.fillerLines, 0)
  const body = filler(3, 2000)
  const q = promptOf(`${body}\n\n${NULLP}`, { fillerLines: 2000, fillerChars: body.length })
  assert.equal(q.fillerLines, 2000)
  assert.equal(q.tokensEst, Math.round(2000 * 29.4 + (2 + NULLP.length) / 3.4))
})

// ------------------------------------------------------------ synthetic task

test("makeTask is deterministic per seed and its ground truth matches the lines it hands out", () => {
  const a = makeTask(11)
  const b = makeTask(11)
  assert.deepEqual(a, b)
  assert.equal(a.ctxPrompt.sha256, b.ctxPrompt.sha256)
  assert.notEqual(makeTask(12).ctxPrompt.sha256, a.ctxPrompt.sha256)
  assert.equal(a.seed, 11)
  assert.equal(a.workSteps.length, 6)
  assert.equal(makeTask(11, { steps: 8 }).workSteps.length, 8)
  assert.equal(makeTask(11, { steps: 8 }).workSteps[5].prompt.sha256, a.workSteps[5].prompt.sha256, "the 8-step task extends the 6-step one")
  // CTX prompt = brief + 4800-line log + NULLP suffix, hashed like every other prompt.
  assert.ok(a.ctxPrompt.text.startsWith("[BRIEF]"))
  assert.ok(a.ctxPrompt.text.includes(`Weather station log (synthetic test data, seed 11)`))
  assert.ok(a.ctxPrompt.text.endsWith(`\n\n${NULLP}`))
  assert.equal(a.ctxPrompt.fillerLines, 4800)
  assert.equal(a.ctxPrompt.sha256, sha(a.ctxPrompt.text))
  assert.ok(a.ctxPrompt.tokensEst > 141000 && a.ctxPrompt.tokensEst < 143000, `ctx tokens ${a.ctxPrompt.tokensEst}`)
  // Guard facts appear in the brief and identify one real log line.
  const g = a.guardAnswer
  assert.ok(/^\d+$/.test(g.id))
  assert.ok(SITES.includes(g.site))
  assert.equal(typeof g.threshold, "number")
  assert.ok(a.brief.includes(g.id) && a.brief.includes(g.site) && a.brief.includes(String(g.threshold)))
  assert.ok(/WX-\d{4}/.test(a.brief))
  const log = filler(11, 4800).split("\n").slice(2)
  const line = log[Number(g.id) - 1]
  assert.equal(line.split(",")[0], g.id)
  assert.equal(line.split(",")[1], g.site)
  for (const step of a.workSteps) {
    assert.equal(step.lines.length, 40)
    assert.ok(step.truth.length >= 0 && step.truth.length <= 3, `window ${step.k} has ${step.truth.length} true ids`)
    const expected = step.lines.filter((l) => l.split(",")[1] === g.site && Number(l.split(",")[3]) > g.threshold).map((l) => l.split(",")[0])
    assert.deepEqual(step.truth, expected)
    assert.equal(step.lines[0].split(",")[0], String(step.a))
    assert.equal(step.lines[39].split(",")[0], String(step.a + 39))
    assert.ok(step.prompt.text.startsWith(`Step ${step.k}: here are log lines ${step.a}..${step.a + 39}`))
    assert.ok(step.prompt.text.includes(`at site ${g.site}`))
    assert.equal(step.prompt.sha256, sha(step.prompt.text))
  }
  assert.ok(a.workSteps.some((s) => s.truth.length > 0), "at least one window has a true id")
  assert.ok(a.parkPrompt.includes("handoff note"))
  assert.equal(a.restorePrompts.R1("HANDOFF-TEXT").text, "You are taking over an interrupted session. Here is the handoff:\nHANDOFF-TEXT\nConfirm by listing the key facts, one per line.")
  assert.equal(a.restorePrompts.R2.text, "Before we continue: what is the next step, and is there anything you are missing that you would need to ask me about?")
  assert.equal(a.restorePrompts.R3.text, "Quick check: which record id is under investigation, at which site, and what is the alert threshold? Answer as 'id, site, threshold'.")
  assert.equal(a.guardPromptRaw.text, `I'm back. ${a.restorePrompts.R3.text}`)
})

test("scorers are exact-match and never throw on odd input", () => {
  assert.equal(scoreWork("12, 40", ["12", "40"]).correct, true)
  assert.equal(scoreWork("40,12", ["12", "40"]).correct, true)
  assert.equal(scoreWork("12", ["12", "40"]).correct, false)
  assert.equal(scoreWork("12, 40, 41", ["12", "40"]).correct, false)
  assert.equal(scoreWork("none", []).correct, true)
  assert.equal(scoreWork("None.", []).correct, true)
  assert.equal(scoreWork("none", ["12"]).correct, false)
  assert.equal(scoreWork("", ["12"]).correct, false)
  assert.equal(scoreWork(null, []).correct, false)
  assert.deepEqual(scoreWork("12, 40", ["12", "40"]).answered, ["12", "40"])
  const g = { id: "1234", site: "Leeds", threshold: 25 }
  assert.equal(scoreGuard("1234, Leeds, 25.0", g).correct, true)
  assert.equal(scoreGuard("id 1234 at leeds, threshold 25", g).correct, true)
  assert.equal(scoreGuard("1234, Hull, 25.0", g).correct, false)
  assert.equal(scoreGuard("12345, Leeds, 25.0", g).correct, false)
  assert.equal(scoreGuard(null, g).correct, false)
  assert.equal(reexplainNeeded("I would need the log lines to proceed; please paste them."), true)
  assert.equal(reexplainNeeded("Could you share the data again?"), true)
  assert.equal(reexplainNeeded("Next step: escalate to the site lead. Nothing is missing."), false)
  assert.equal(reexplainNeeded(null), false)
  assert.equal(handoffLossy("ticket WX-1000, record 1234 at Leeds", g), false)
  assert.equal(handoffLossy("ticket WX-1000 at Leeds", g), true)
  assert.equal(handoffLossy(null, g), true)
})

// --------------------------------------------------------- (a) fable-write-tick

const fableResponder = ({ preTickAt = 12, postTickAt = { 1: 14, 2: 9 }, writeTicks = 0, delayedOn = null, missAt = null, late = null, nullRecordAt = null } = {}) => (step) => {
  if (missAt && step.role === missAt.role && step.n === missAt.n) return result(record(step, DIAL_MISS()))
  if (late && step.role === late.role && step.n === late.n) return result(record(step, PING()), { late: true })
  if (nullRecordAt && step.role === nullRecordAt.role && step.n === nullRecordAt.n) return result(null, { anomalies: ["unexpected_request_count"] })
  if (step.role === "pre_walk") return result(record(step, DIAL_HIT()), { ticks: step.n === preTickAt ? 1 : 0 })
  if (step.role === "post_walk") return result(record(step, DIAL_HIT()), { ticks: step.n === postTickAt[step.unit.index] ? 1 : 0 })
  if (step.role === "write") return result(record(step, usage({ w1: 71300 })), { ticks: writeTicks })
  if (step.role === "hold") return result(record(step, PING()), { ticks: step.unit.index === 1 && step.n === delayedOn ? 1 : 0 })
  throw new Error(`unexpected role ${step.role}`)
}

test("fable-write-tick: pre-walk until a tick, WRITE-2400, 7 hold pings at the exact offsets, post-walk until a tick; block 2 chains", async () => {
  const { requests, result: r } = await run("fable-write-tick", {}, fableResponder({ delayedOn: 5 }))
  const pre = requests.slice(0, 12)
  assert.deepEqual(roles(pre), Array(12).fill("pre_walk"))
  assert.deepEqual(pre.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  for (const s of pre) {
    assert.equal(s.kind, "dial")
    assert.equal(s.phase, "observe")
    assert.equal(s.arm, "fable-write-1h")
    assert.equal(s.session.mode, "ephemeral")
    assert.equal(s.session.id, null)
    assert.equal(s.prompt.sha256, makeTask(77).ctxPrompt.sha256, "a dial re-sends the hot prefix bytes")
    assert.equal(s.expect.hit, true)
    assert.equal(s.dominantField, "cacheRead")
    assert.equal(s.scopeId, "fable-write-tick/block-1")
    assert.deepEqual(s.unit, { kind: "block", index: 1 })
  }
  for (let i = 1; i < 12; i++) assert.equal(pre[i].atOffsetMs, pre[i - 1].atOffsetMs + STEP_MS + RULES.dialSpacingMs, "6 s dial spacing")
  assert.equal(pre[0].resetMarginMs, RULES.fable.resetMarginMs, "the block's first step carries the reset margin")
  const write = requests[12]
  assert.equal(write.role, "write")
  assert.equal(write.kind, "write")
  assert.equal(write.prompt.fillerLines, 2400)
  assert.ok(write.prompt.text.endsWith(`\n\n${NULLP}`))
  assert.equal(write.prompt.tokensEst, Math.round(2400 * 29.4 + (2 + NULLP.length) / 3.4))
  assert.equal(write.session.mode, "ephemeral")
  assert.equal(write.dominantField, "cacheWrite1h")
  assert.equal(write.expect.ttlLane, "1h")
  const hold = requests.slice(13, 20)
  assert.deepEqual(roles(hold), Array(7).fill("hold"))
  const writeDone = write.atOffsetMs + STEP_MS
  assert.deepEqual(hold.map((s) => s.atOffsetMs - writeDone), [5000, 15000, 30000, 60000, 180000, 600000, 1800000])
  for (const s of hold) {
    assert.equal(s.kind, "ping")
    assert.equal(s.prompt.text, NULLP)
    assert.equal(s.toleranceMs, RULES.fable.holdToleranceMs)
  }
  const post = requests.slice(20, 34)
  assert.deepEqual(roles(post), Array(14).fill("post_walk"))
  assert.deepEqual(post.map((s) => s.n), Array.from({ length: 14 }, (_, i) => i + 1))
  // Block 2: the write comes first, no pre-walk.
  const b2 = requests.slice(34)
  assert.equal(b2.length, 1 + 7 + 9)
  assert.equal(b2[0].role, "write")
  assert.deepEqual(b2[0].unit, { kind: "block", index: 2 })
  assert.equal(b2[0].scopeId, "fable-write-tick/block-2")
  assert.notEqual(b2[0].prompt.sha256, write.prompt.sha256, "new seed per write")
  assert.deepEqual(roles(b2.slice(1, 8)), Array(7).fill("hold"))
  assert.deepEqual(roles(b2.slice(8)), Array(9).fill("post_walk"))
  assert.equal(requests.length, 51)
  assert.equal(new Set(requests.map((s) => s.id)).size, requests.length, "step ids unique")
  for (const s of requests) assert.equal(s.id, `fable-write-tick/${s.arm}/${s.index}`)
  assert.deepEqual(requests.map((s) => s.index), requests.map((_, i) => i))

  assert.equal(r.status, "valid")
  assert.equal(r.reason, null)
  assert.equal(r.experiment, "fable-write-tick")
  assert.equal(r.blocks.length, 2)
  const [b1r, b2r] = r.blocks
  assert.equal(b1r.chained, false)
  assert.deepEqual(b1r.preWalk, { reads: 12, ticked: true, early: null })
  assert.deepEqual(b1r.phi, [0, RHO])
  assert.equal(b1r.write.ticks, 0)
  assert.equal(b1r.write.cacheWrite1h, 71300)
  assert.equal(b1r.hold.delayedTicks, 1)
  assert.deepEqual(b1r.hold.tickedOn, [5])
  assert.equal(b1r.n, 1)
  assert.equal(b1r.m, 14)
  assert.equal(b1r.status, "valid")
  assert.equal(b2r.chained, true)
  assert.deepEqual(b2r.preWalk, { reads: 0, ticked: false, early: null })
  assert.deepEqual(b2r.phi, [0, RHO])
  assert.equal(b2r.n, 0)
  assert.equal(b2r.m, 9)
  assert.deepEqual(r.phaseAtEnd, [0, RHO])
  assert.equal(r.skippedArms["fable-write-5m"], "adapter_capability")
  assert.equal(r.steps.length, 51)
  assert.equal(r.steps[12].usage.cacheWrite1h, 71300)
  const p = parity("fable-write-tick", requests)
  assert.equal(p.ok, true)
  assert.equal(p.complete, true)
})

test("fable-write-tick: 35 reads without a tick gives phi in [35/37, 1)", async () => {
  const { requests, result: r } = await run("fable-write-tick", {}, fableResponder({ preTickAt: null }))
  assert.equal(count(requests, (s) => s.role === "pre_walk"), 35)
  assert.equal(requests[35].role, "write")
  assert.deepEqual(r.blocks[0].preWalk, { reads: 35, ticked: false, early: null })
  assert.deepEqual(r.blocks[0].phi, [35 * RHO, 1])
  assert.equal(r.status, "valid")
})

test("fable-write-tick: a dial miss aborts the experiment before any further paid call", async () => {
  const { requests, result: r } = await run("fable-write-tick", {}, fableResponder({ missAt: { role: "pre_walk", n: 3 } }))
  assert.equal(requests.length, 3)
  assert.equal(r.status, "aborted")
  assert.equal(r.reason, "dial_miss")
  assert.equal(r.blocks[0].status, "aborted")
  // A partial hit (large read but also a large write) is not a hit either.
  const partial = await run("fable-write-tick", {}, (step) => step.n === 2 ? result(record(step, usage({ rd: 145000, w1: 6000 }))) : fableResponder()(step))
  assert.equal(partial.requests.length, 2)
  assert.equal(partial.result.reason, "dial_miss")
  // A post-walk miss aborts too, after block 1's data is kept.
  const post = await run("fable-write-tick", {}, fableResponder({ missAt: { role: "post_walk", n: 2 } }))
  assert.equal(post.result.status, "aborted")
  assert.equal(post.result.reason, "dial_miss")
  assert.equal(post.requests.length, 12 + 1 + 7 + 2)
})

test("fable-write-tick: post-walk overrun, late step, missing record, missing usage and a reset inside the block", async () => {
  const overrun = await run("fable-write-tick", {}, fableResponder({ postTickAt: { 1: null } }))
  assert.equal(overrun.result.status, "aborted")
  assert.equal(overrun.result.reason, "post_walk_overrun")
  assert.equal(count(overrun.requests, (s) => s.role === "post_walk"), 40)
  assert.equal(overrun.requests.length, 12 + 1 + 7 + 40)

  const late = await run("fable-write-tick", {}, fableResponder({ late: { role: "hold", n: 4 } }))
  assert.equal(late.result.status, "void")
  assert.equal(late.result.reason, "late_step")
  assert.equal(late.requests.length, 12 + 1 + 4, "a late step is never rescheduled")

  const nullRecord = await run("fable-write-tick", {}, fableResponder({ nullRecordAt: { role: "pre_walk", n: 2 } }))
  assert.equal(nullRecord.result.status, "void")
  assert.equal(nullRecord.result.reason, "missing_record")
  assert.equal(nullRecord.requests.length, 2)
  assert.ok(nullRecord.result.anomalies.includes("unexpected_request_count"))

  const noUsage = await run("fable-write-tick", {}, (step) => step.n === 2 ? result(record(step, null)) : fableResponder()(step))
  assert.equal(noUsage.result.status, "void")
  assert.equal(noUsage.result.reason, "missing_usage")

  const noTicks = await run("fable-write-tick", {}, (step) => step.n === 2 ? { ...result(record(step, DIAL_HIT())), ticks: {} } : fableResponder()(step))
  assert.equal(noTicks.result.status, "void")
  assert.equal(noTicks.result.reason, "missing_ticks")

  const reset = await run("fable-write-tick", {}, (step) => step.role === "hold" && step.n === 2 ? result(record(step, PING()), { anomalies: ["reset_changed"] }) : fableResponder()(step))
  assert.equal(reset.result.status, "void")
  assert.equal(reset.result.reason, "reset_in_block")
  assert.equal(reset.requests.length, 12 + 1 + 2)

  const refusal = await run("fable-write-tick", {}, (step) => step.role === "write" ? result(record(step, usage({ w1: 71300 }), { stop_reason: "refusal" })) : fableResponder()(step))
  assert.equal(refusal.result.status, "aborted")
  assert.equal(refusal.result.reason, "refusal")

  const fallback = await run("fable-write-tick", {}, (step) => step.n === 1 ? result(record(step, DIAL_HIT(), { model: "claude-opus-4-8" })) : fableResponder()(step))
  assert.equal(fallback.result.status, "aborted")
  assert.equal(fallback.result.reason, "model_mismatch")
  assert.equal(fallback.requests.length, 1)
})

test("fable-write-tick: without a dial prefix nothing is issued; a chained phase from ctx skips the pre-walk and flags early ticks", async () => {
  const none = await run("fable-write-tick", { dial: false }, () => { throw new Error("must not issue") })
  assert.equal(none.requests.length, 0)
  assert.equal(none.result.status, "aborted")
  assert.equal(none.result.reason, "no_dial_prefix")

  const chained = await run("fable-write-tick", { phase: [0, RHO] }, fableResponder())
  assert.equal(chained.requests[0].role, "write")
  assert.equal(chained.result.blocks[0].chained, true)
  assert.deepEqual(chained.result.blocks[0].phi, [0, RHO])

  // A chained phase whose first dial ticks at phi_hat < 0.9 is foreign traffic: the gauge block is void.
  const early = await run("fable-write-tick", { phase: [0.5, 0.6] }, (step) => step.role === "pre_walk" ? result(record(step, DIAL_HIT()), { ticks: step.n === 2 ? 1 : 0 }) : fableResponder()(step))
  assert.equal(early.requests[0].role, "pre_walk", "a partial phase still needs walking")
  assert.equal(early.result.status, "void")
  assert.equal(early.result.reason, "early_tick")
  assert.equal(early.result.blocks[0].preWalk.early, true)
})

test("fable-write-tick: replaying the same StepResults yields identical StepRequests (resumable)", async () => {
  const a = await run("fable-write-tick", {}, fableResponder({ delayedOn: 3 }))
  const b = await run("fable-write-tick", {}, fableResponder({ delayedOn: 3 }))
  assert.deepEqual(a.requests, b.requests)
  assert.deepEqual(a.result, b.result)
})

// ------------------------------------------------------------ (b) output-quota

const outputResponder = ({ preTickAt = 5, tickAt = { 1: [10, 24], 2: [8, 20], 3: [6, 12] }, gateOut = 8000, holdTick = null } = {}) => (step) => {
  if (step.role === "pre_walk") return result(record(step, DIAL_HIT()), { ticks: step.n === preTickAt ? 1 : 0 })
  if (step.role === "gate") return result(record(step, usage({ rd: 3800, out: gateOut })), { ticks: (tickAt[step.unit.index] ?? []).includes(1) ? 1 : 0 })
  if (step.role === "loop") return result(record(step, usage({ rd: 3800, out: step.expect.outputTokensTarget })), { ticks: (tickAt[step.unit.index] ?? []).includes(step.n) ? 1 : 0 })
  if (step.role === "hold") return result(record(step, PING()), { ticks: holdTick && step.unit.index === holdTick.block && step.n === holdTick.n ? 1 : 0 })
  throw new Error(`unexpected role ${step.role}`)
}

test("output-quota: pre-walk capped at 30, gate, OUT-8K loop until 2 ticks, 4 hold pings; block 2 chains; block 3 only inside the budget", async () => {
  const { requests, result: r } = await run("output-quota", {}, outputResponder())
  assert.deepEqual(roles(requests.slice(0, 5)), Array(5).fill("pre_walk"))
  assert.equal(requests[0].resetMarginMs, RULES.output.resetMarginMs)
  const gate = requests[5]
  assert.equal(gate.role, "gate")
  assert.equal(gate.n, 1)
  assert.equal(gate.kind, "work")
  assert.equal(gate.prompt.text, outp(3000))
  assert.equal(gate.expect.outputTokensTarget, 8000)
  assert.equal(gate.dominantField, "billedModelOutput")
  assert.equal(gate.arm, "out-8k")
  assert.equal(gate.scopeId, "output-quota/block-1")
  const loop1 = requests.slice(6, 29)
  assert.deepEqual(roles(loop1), Array(23).fill("loop"))
  assert.deepEqual(loop1.map((s) => s.n), Array.from({ length: 23 }, (_, i) => i + 2))
  for (let i = 0; i < loop1.length; i++) assert.equal(loop1[i].atOffsetMs, requests[5 + i].atOffsetMs + STEP_MS + RULES.spacingMs, "3 s spacing")
  for (const s of loop1) {
    assert.equal(s.prompt.sha256, gate.prompt.sha256, "identical prompt, fresh session each time")
    assert.equal(s.session.mode, "ephemeral")
  }
  const hold1 = requests.slice(29, 33)
  assert.deepEqual(roles(hold1), Array(4).fill("hold"))
  const base = requests[28].atOffsetMs + STEP_MS + RULES.spacingMs
  assert.deepEqual(hold1.map((s) => s.atOffsetMs - base), [0, 60000, 120000, 180000])
  // Block 2 chains: first request is the gate.
  assert.equal(requests[33].role, "gate")
  assert.deepEqual(requests[33].unit, { kind: "block", index: 2 })
  assert.equal(count(requests, (s) => s.unit.index === 2 && s.kind === "work"), 20)
  assert.equal(count(requests, (s) => s.unit.index === 2 && s.role === "hold"), 4)
  assert.equal(count(requests, (s) => s.unit.index === 3), 0, "5 ticks spent of the 0.08 cap: block 3 does not fit")
  assert.equal(requests.length, 5 + 24 + 4 + 20 + 4)

  assert.equal(r.status, "valid")
  assert.equal(r.blocks.length, 2)
  assert.equal(r.blocks[0].status, "identified")
  assert.equal(r.blocks[0].N, 24)
  assert.equal(r.blocks[0].chained, false)
  assert.deepEqual(r.blocks[0].phi, [0, RHO])
  assert.deepEqual(r.blocks[0].tickedOn, [10, 24])
  assert.equal(r.blocks[0].cumulativeOut[24], 24 * 8000)
  assert.equal(r.blocks[0].cumulativeOut[23], 23 * 8000)
  assert.equal(r.blocks[0].outputs.length, 24)
  assert.equal(r.blocks[0].validShare, 1)
  assert.equal(r.blocks[1].chained, true)
  assert.equal(r.blocks[1].N, 20)
  assert.equal(r.blocks[1].phiSource, "chained_from_block_1")
  assert.equal(r.blocks[2], undefined)
  assert.equal(r.block3, "skipped:budget")
  const p = parity("output-quota", requests)
  assert.equal(p.ok, true)
  assert.equal(p.complete, true)
})

test("output-quota: block 3 (1..1700, ~4K) runs when the remaining budget allows", async () => {
  const { requests, result: r } = await run("output-quota", { phase: [0, RHO] }, outputResponder())
  assert.equal(requests[0].role, "gate", "a chained phase from the previous experiment skips the pre-walk")
  const b3 = requests.filter((s) => s.unit.index === 3)
  assert.ok(b3.length > 0, "4 ticks of the 0.08 cap leave >= 0.025")
  assert.equal(b3[0].role, "gate")
  assert.equal(b3[0].arm, "out-4k")
  assert.equal(b3[0].prompt.text, outp(1700))
  assert.equal(b3[0].expect.outputTokensTarget, 4000)
  assert.equal(r.blocks.length, 3)
  assert.equal(r.blocks[2].N, 12)
  assert.equal(r.status, "valid")
})

test("output-quota: prior plan spend can be the only reason block 3 is out of budget", async () => {
  const rerunApproval = structuredClone(approval)
  rerunApproval.plans["output-quota"].limits.maxTotalExperimentalSpend.value = 0.075
  rerunApproval.priorSpend = { perPlanUpperEq: { "output-quota": 0.01 } }
  const { requests, result: r } = await run("output-quota", { phase: [0, RHO], approval: rerunApproval }, outputResponder())
  assert.equal(r.block3, "skipped:budget", "four current ticks plus the prior leave 0.015, below the 0.025 block-3 reserve")
  assert.equal(requests.some((step) => step.unit.index === 3), false)
})

// Plan todo 21a (Amendment 2026-09-27): the first run's outp(2000) returned 5,106 output tokens,
// under the 6,000 gate. The prompts are recalibrated; the targets and the derived gates are not.
test("output-quota prompts: blocks 1-2 send outp(3000), block 3 outp(1700); gates stay 6000 / 3000", async () => {
  const gateAt = (outs) => (step) => step.role === "gate" ? result(record(step, usage({ rd: 3800, out: outs[step.unit.index] }))) : outputResponder()(step)
  const { requests, result: r } = await run("output-quota", { phase: [0, RHO] }, gateAt({ 1: 6000, 2: 6000, 3: 3000 }))
  assert.equal(r.status, "valid", "an output exactly at each derived gate passes it")
  assert.equal(r.blocks.length, 3)
  const work = (b) => requests.filter((s) => s.unit.index === b && s.kind === "work")
  for (const [b, n, target] of [[1, 3000, 8000], [2, 3000, 8000], [3, 1700, 4000]]) {
    assert.ok(work(b).length > 0)
    for (const s of work(b)) {
      assert.equal(s.prompt.text, outp(n), `block ${b}`)
      assert.equal(s.prompt.sha256, sha(outp(n)))
      assert.equal(s.expect.outputTokensTarget, target)
    }
  }
  assert.equal(work(1)[0].arm, "out-8k")
  assert.equal(work(3)[0].arm, "out-4k")

  const short1 = await run("output-quota", { phase: [0, RHO] }, gateAt({ 1: 5999 }))
  assert.equal(short1.result.reason, "short_output", "block 1 gate floor is 6000")
  const short3 = await run("output-quota", { phase: [0, RHO] }, gateAt({ 1: 8000, 2: 8000, 3: 2999 }))
  assert.equal(short3.result.status, "aborted")
  assert.equal(short3.result.reason, "short_output", "block 3 gate floor is 3000")
  assert.deepEqual(short3.requests.at(-1).unit, { kind: "block", index: 3 })
  assert.equal(short3.requests.at(-1).role, "gate")
})

test("output-quota: 64 requests without the 2nd tick returns upper_bound; a short gate output aborts", async () => {
  const ub = await run("output-quota", {}, outputResponder({ tickAt: { 1: [10] } }))
  assert.equal(count(ub.requests, (s) => s.unit.index === 1 && s.kind === "work"), 64)
  assert.equal(ub.requests.filter((s) => s.unit.index === 1).at(-1).role, "hold", "the hold still runs")
  assert.equal(count(ub.requests, (s) => s.unit.index === 2), 0, "no second block after a non-identified one")
  assert.equal(ub.result.status, "upper_bound")
  assert.equal(ub.result.reason, "no_second_tick_within_64")
  assert.equal(ub.result.blocks[0].status, "upper_bound")
  assert.equal(ub.result.blocks[0].N, 64)
  assert.equal(parity("output-quota", ub.requests).ok, true)

  const short = await run("output-quota", {}, outputResponder({ gateOut: 5999 }))
  assert.equal(short.requests.length, 5 + 1)
  assert.equal(short.result.status, "aborted")
  assert.equal(short.result.reason, "short_output")

  const truncated = await run("output-quota", {}, (step) => step.role === "gate" ? result(record(step, usage({ out: 8000 }), { stop_reason: "max_tokens" })) : outputResponder()(step))
  assert.equal(truncated.result.status, "aborted")
  assert.equal(truncated.result.reason, "short_output")

  // Loop requests below 6000 do not stop the loop but lower the block's valid share.
  const weak = await run("output-quota", {}, (step) => step.role === "loop" && step.n % 2 === 0 ? result(record(step, usage({ out: 5000 })), { ticks: step.n === 10 || step.n === 24 ? 1 : 0 }) : outputResponder({ tickAt: { 1: [10, 24], 2: [8, 20] } })(step))
  assert.ok(weak.result.blocks[0].validShare < 0.9)
  assert.ok(weak.result.blocks[0].flags.includes("invalid_output_share"))

  const delayed = await run("output-quota", {}, outputResponder({ holdTick: { block: 1, n: 2 } }))
  assert.equal(delayed.result.blocks[0].hold.delayedTicks, 1)
  assert.ok(delayed.result.blocks[0].flags.includes("delayed_tick_in_hold"))
  assert.equal(delayed.result.blocks[1].phiSource, "chained_from_block_1_hold")
})

// ----------------------------------------------------- (c) ttl-1h-unique-prefix

const TTL_OFFSETS = [0, 30000, 300000, 330000, 3300000, 3600000, 6600000, 6630000, 6900000, 6930000]
const TTL_HIT = () => usage({ rd: 62400, w1: 100 })
const TTL_MISS = () => usage({ rd: 3437, w1: 59400 })
const ttlResponder = ({ hit = { A: true, B: false, C: true, D: false }, pingHit = { A: true, C: true }, partial = [], late = null, badWrite = [] } = {}) => (step) => {
  if (late && step.role === late.role && step.prefix === late.prefix) return result(record(step, TTL_HIT()), { late: true })
  if (step.role === "write") return result(record(step, badWrite.includes(step.prefix) ? usage({ w1: 40000 }) : usage({ w1: 59400 })))
  if (step.role === "ping") return result(record(step, pingHit[step.prefix] ? TTL_HIT() : TTL_MISS()))
  if (step.role === "check") {
    if (partial.includes(step.prefix)) return result(record(step, usage({ rd: 30000, w1: 30000 })))
    return result(record(step, hit[step.prefix] ? TTL_HIT() : TTL_MISS()))
  }
  throw new Error(`unexpected role ${step.role}`)
}

test("ttl-1h-unique-prefix: the static schedule is the timing table with +-90 s tolerance", () => {
  const s = schedule("ttl-1h-unique-prefix")
  assert.equal(s.experiment, "ttl-1h-unique-prefix")
  assert.equal(s.unit, "run")
  assert.equal(s.maxUnits, 2)
  assert.equal(s.timed, true)
  assert.deepEqual(s.offsets, TTL_OFFSETS)
  assert.deepEqual(s.steps.map((x) => x.atOffsetMs), TTL_OFFSETS)
  assert.deepEqual(s.steps.map((x) => x.prefix), ["A", "B", "C", "D", "A", "C", "A", "B", "C", "D"])
  assert.deepEqual(s.steps.map((x) => x.kind), ["write", "write", "write", "write", "probe", "probe", "check", "check", "check", "check"])
  assert.deepEqual(s.steps.map((x) => x.arm), ["treatment", "control", "treatment", "control", "treatment", "treatment", "treatment", "control", "treatment", "control"])
  assert.deepEqual(s.steps.map((x) => x.run), [1, 1, 2, 2, 1, 2, 1, 1, 2, 2])
  for (const x of s.steps) assert.equal(x.toleranceMs, 90000)
  assert.equal(s.paidCallsPerRun, 5)
})

test("ttl-1h-unique-prefix: 10 timed steps, identical bytes per prefix, HIT/MISS/PARTIAL per thresholds", async () => {
  const { requests, result: r } = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder())
  assert.equal(requests.length, 10)
  assert.deepEqual(requests.map((s) => s.atOffsetMs), TTL_OFFSETS)
  assert.deepEqual(requests.map((s) => s.toleranceMs), Array(10).fill(90000))
  assert.deepEqual(requests.map((s) => s.prefix), ["A", "B", "C", "D", "A", "C", "A", "B", "C", "D"])
  assert.deepEqual(requests.map((s) => s.kind), ["write", "write", "write", "write", "probe", "probe", "check", "check", "check", "check"])
  assert.deepEqual(requests.map((s) => s.role), ["write", "write", "write", "write", "ping", "ping", "check", "check", "check", "check"])
  assert.deepEqual(requests.map((s) => s.scopeId), ["ttl-1h-unique-prefix/run-1", "ttl-1h-unique-prefix/run-1", "ttl-1h-unique-prefix/run-2", "ttl-1h-unique-prefix/run-2", "ttl-1h-unique-prefix/run-1", "ttl-1h-unique-prefix/run-2", "ttl-1h-unique-prefix/run-1", "ttl-1h-unique-prefix/run-1", "ttl-1h-unique-prefix/run-2", "ttl-1h-unique-prefix/run-2"])
  const byPrefix = (p) => requests.filter((s) => s.prefix === p)
  for (const p of ["A", "B", "C", "D"]) {
    const shas = new Set(byPrefix(p).map((s) => s.prompt.sha256))
    assert.equal(shas.size, 1, `prefix ${p} re-sends its exact bytes`)
    assert.equal(byPrefix(p)[0].prompt.fillerLines, 2000)
    assert.ok(byPrefix(p)[0].prompt.text.endsWith(`\n\n${NULLP}`))
    for (const s of byPrefix(p)) {
      assert.equal(s.session.mode, "ephemeral")
      assert.equal(s.expect.ttlLane, "1h")
    }
  }
  assert.equal(new Set(requests.map((s) => s.prompt.sha256)).size, 4, "four distinct prefixes")
  assert.equal(requests[0].dominantField, "cacheWrite1h")
  assert.equal(requests[4].dominantField, "cacheRead")
  assert.equal(requests[4].expect.hit, true)
  for (const s of requests) assert.equal(s.id, `ttl-1h-unique-prefix/${s.arm}/${s.index}`)
  assert.equal(new Set(requests.map((s) => s.id)).size, 10)

  assert.equal(r.status, "valid")
  assert.equal(r.runs.length, 2)
  assert.deepEqual(r.runs[0].checks, { treatment: "HIT", control: "MISS" })
  assert.deepEqual(r.runs[1].checks, { treatment: "HIT", control: "MISS" })
  assert.equal(r.runs[0].outcome, "renews")
  assert.equal(r.runs[0].status, "valid")
  assert.equal(r.runs[0].ping, "HIT")
  assert.deepEqual(r.runs[0].prefixes, { treatment: "A", control: "B" })
  assert.equal(r.runs[0].writes.treatment.cacheWrite1h, 59400)
  const p = parity("ttl-1h-unique-prefix", requests)
  assert.equal(p.ok, true)
  assert.equal(p.complete, true)
  assert.equal(parity("ttl-1h-unique-prefix", requests.slice(0, 9)).complete, false)
  const extra = parity("ttl-1h-unique-prefix", [...requests, requests[6]])
  assert.equal(extra.ok, false)
  assert.ok(extra.issues.some((i) => i.code === "overrun"))
})

test("ttl-1h-unique-prefix: a late check voids, PARTIAL is not HIT, invalid writes and ping misses invalidate one run only", async () => {
  const late = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ late: { role: "check", prefix: "A" } }))
  assert.equal(late.result.status, "void")
  assert.equal(late.result.reason, "late_step")
  assert.equal(late.requests.length, 7, "never rescheduled")

  const partial = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ partial: ["A"] }))
  assert.equal(partial.result.runs[0].checks.treatment, "PARTIAL")
  assert.equal(partial.result.runs[0].outcome, "uncertain")
  assert.equal(partial.result.runs[1].outcome, "renews")
  assert.equal(partial.result.status, "valid")

  const noRenew = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ hit: { A: false, B: false, C: false, D: false } }))
  assert.equal(noRenew.result.runs[0].outcome, "no_renewal")
  const noContrast = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ hit: { A: true, B: true, C: true, D: true } }))
  assert.equal(noContrast.result.runs[0].outcome, "no_contrast")

  const badWrite = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ badWrite: ["A"] }))
  assert.deepEqual(badWrite.requests.map((s) => s.prefix), ["A", "C", "D", "C", "C", "D"], "run 1's later steps (incl. B's write) are skipped, run 2 continues")
  assert.equal(badWrite.result.runs[0].status, "invalid")
  assert.equal(badWrite.result.runs[0].reason, "write_invalid")
  assert.equal(badWrite.result.runs[1].status, "valid")
  assert.equal(badWrite.result.status, "valid")

  const pingMiss = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ pingHit: { A: false, C: true } }))
  assert.equal(pingMiss.result.runs[0].status, "invalid")
  assert.equal(pingMiss.result.runs[0].reason, "ping_miss")
  assert.deepEqual(pingMiss.requests.map((s) => s.prefix), ["A", "B", "C", "D", "A", "C", "C", "D"])

  const bothBad = await run("ttl-1h-unique-prefix", { dial: false }, ttlResponder({ badWrite: ["A", "C"] }))
  assert.equal(bothBad.result.status, "void")
  assert.equal(bothBad.result.reason, "all_runs_invalid")
  assert.equal(bothBad.requests.length, 2, "each invalid write skips the rest of its run")

  const noUsage = await run("ttl-1h-unique-prefix", { dial: false }, (step) => step.prefix === "B" && step.role === "write" ? result(record(step, null)) : ttlResponder()(step))
  assert.equal(noUsage.result.status, "void")
  assert.equal(noUsage.result.reason, "missing_usage")
})

// --------------------------------------------------- (d) restore-decomposition

const BIG_HIT = (over = {}) => usage({ rd: 145700, w1: 300, out: 40, ...over })
const restoreResponder = (task, { gatePass = true, handoffHasId = true, parkOut = 1200, reexplain = false, rewriteAt = null, guardText = null, wrongWork = [], noText = null } = {}) => (step) => {
  const g = task.guardAnswer
  const handoff = `Handoff for ticket ${task.ticket}: record ${handoffHasId ? g.id : "(see log)"} at ${g.site} on ${g.date}, threshold ${g.threshold}. Decision: ${task.decision} Next: ${task.nextStep}`
  if (noText && step.role === noText) return result(record(step, BIG_HIT({ out: parkOut }), { text: null }))
  if (rewriteAt && step.role === rewriteAt) return result(record(step, usage({ rd: 3035, w1: 142681, out: 40 }), { text: handoff }))
  switch (step.role) {
    case "ctx_create": return result(record(step, usage({ w1: 142620 })))
    case "gate": return result(record(step, gatePass ? usage({ rd: 145655, w1: 200 }) : usage({ rd: 3035, w1: 142681 })))
    case "park_parent": return result(record(step, BIG_HIT({ out: parkOut }), { text: handoff }))
    case "r1": return result(record(step, usage({ w1: 1800, out: 120 }), { text: `ticket ${task.ticket}\nrecord ${g.id}\nsite ${g.site}` }))
    case "r2": return result(record(step, usage({ rd: 5200, w1: 200, out: 80 }), { text: reexplain ? "I would need the log lines to proceed; please share them." : `Next step: ${task.nextStep} Nothing missing.` }))
    case "guard": return result(record(step, usage({ rd: 5400, w1: 150, out: 20 }), { text: guardText ?? `${g.id}, ${g.site}, ${g.threshold}` }))
    case "resume_raw": return result(record(step, BIG_HIT({ out: 20 }), { text: guardText ?? `${g.id}, ${g.site}, ${g.threshold}` }))
    case "work": {
      const truth = task.workSteps[step.k - 1].truth
      const text = wrongWork.includes(step.k) ? "999" : truth.length ? truth.join(", ") : "none"
      return result(record(step, step.arm === "raw_path" || step.arm === "current_policy" ? BIG_HIT({ out: 30 }) : usage({ rd: 5600, w1: 900, out: 30 }), { text }))
    }
    case "end_ping": return result(record(step, PING()))
    case "warm": return result(record(step, usage({ rd: 145655, w1: 100 })))
    default: throw new Error(`unexpected role ${step.role}`)
  }
}

test("restore-decomposition run 1: gate PASS keeps --resume, phase labels on 1+3+6 and 1+6, quality and delays computed", async () => {
  const task = makeTask(1001)
  const { requests, result: r, ctx } = await run("restore-decomposition", { dial: false }, restoreResponder(task))
  assert.deepEqual(roles(requests), ["ctx_create", "gate", "park_parent", "r1", "r2", "guard", "work", "work", "work", "work", "work", "work", "resume_raw", "work", "work", "work", "work", "work", "work", "end_ping"])
  const [ctxCreate, gate, park, r1, r2, guard] = requests
  assert.equal(ctxCreate.kind, "write")
  assert.equal(ctxCreate.phase, "ctx_create")
  assert.equal(ctxCreate.arm, "shared")
  assert.equal(ctxCreate.seed, 1001)
  assert.deepEqual(ctxCreate.session, { id: "uuid-1", mode: "new" })
  assert.equal(ctxCreate.prompt.text, NULLP)
  assert.equal(ctxCreate.prompt.tokensEst, task.ctxPrompt.tokensEst, "the context write is priced as the whole context")
  assert.deepEqual(ctxCreate.systemPrompt, contextFileOf(task))
  for (const s of [gate, park, requests[12], ...requests.slice(13, 19)]) assert.deepEqual(s.systemPrompt, { file: `P-${task.seed}.txt`, sha256: contextFileOf(task).sha256, bytes: contextFileOf(task).bytes }, s.id)
  for (const s of requests.slice(3, 12)) assert.equal(s.systemPrompt, undefined, `${s.id}: the child never carries P`)
  assert.equal(ctxCreate.dominantField, "cacheWrite1h")
  assert.equal(ctxCreate.scopeId, "restore-decomposition/run-1")
  assert.equal(gate.atOffsetMs, ctxCreate.atOffsetMs + STEP_MS + RULES.restore.settleMs, "20 s settle after the context write")
  assert.equal(gate.kind, "probe")
  assert.equal(gate.phase, "resume_raw")
  assert.equal(gate.arm, "shared")
  assert.deepEqual(gate.session, { id: "uuid-1", mode: "resume" })
  assert.equal(gate.prompt.text, NULLP)
  assert.equal(gate.expect.hit, true)
  assert.equal(ctx.mode.resumeHit, true, "the gate sets the mode for exp 4/5")
  assert.equal(park.phase, "park_parent")
  assert.equal(park.arm, "park_path")
  assert.equal(park.kind, "work")
  assert.deepEqual(park.session, { id: "uuid-1", mode: "resume" })
  assert.equal(park.prompt.text, task.parkPrompt)
  assert.equal(park.needsText, true)
  assert.deepEqual(r1.session, { id: "uuid-2", mode: "new" })
  assert.equal(r1.phase, "restore_child")
  assert.ok(r1.prompt.text.includes(`record ${task.guardAnswer.id}`), "R1 carries the handoff text")
  assert.deepEqual(r2.session, { id: "uuid-2", mode: "resume" })
  assert.equal(r2.prompt.text, task.restorePrompts.R2.text)
  assert.equal(guard.prompt.text, task.restorePrompts.R3.text)
  assert.equal(guard.phase, "restore_child")
  const parkWork = requests.slice(6, 12)
  assert.deepEqual(parkWork.map((s) => s.k), [1, 2, 3, 4, 5, 6])
  for (const s of parkWork) {
    assert.equal(s.phase, "useful_work")
    assert.equal(s.arm, "park_path")
    assert.deepEqual(s.session, { id: "uuid-2", mode: "resume" })
    assert.equal(s.prompt.sha256, task.workSteps[s.k - 1].prompt.sha256)
  }
  const raw = requests[12]
  assert.equal(raw.phase, "resume_raw")
  assert.equal(raw.arm, "raw_path")
  assert.equal(raw.kind, "work")
  assert.deepEqual(raw.session, { id: "uuid-1", mode: "resume" })
  assert.equal(raw.prompt.text, task.guardPromptRaw.text)
  const rawWork = requests.slice(13, 19)
  for (const s of rawWork) {
    assert.equal(s.phase, "useful_work")
    assert.equal(s.arm, "raw_path")
    assert.deepEqual(s.session, { id: "uuid-1", mode: "resume" })
    assert.equal(s.prompt.sha256, task.workSteps[s.k - 1].prompt.sha256, "identical work prompts in both paths")
  }
  assert.equal(requests[19].kind, "ping")
  assert.equal(requests[19].phase, "observe")
  assert.deepEqual(requests.map((s) => s.index), requests.map((_, i) => i))
  assert.equal(new Set(requests.map((s) => s.id)).size, 20)
  // Restore ids are disjoint from useful_work ids (overlap check restore_ids_disjoint_from_useful_work).
  const restoreIds = requests.filter((s) => s.phase === "restore_child").map((s) => s.id)
  const workIds = requests.filter((s) => s.phase === "useful_work").map((s) => s.id)
  assert.equal(restoreIds.filter((id) => workIds.includes(id)).length, 0)

  assert.equal(r.status, "valid")
  assert.equal(r.run, 1)
  assert.equal(r.mode, BIG_CONTEXT_MODE)
  assert.equal(r.gate.pass, true)
  assert.equal(r.gate.cacheRead, 145655)
  assert.deepEqual(r.task, { seed: 1001, ticket: task.ticket, guardAnswer: task.guardAnswer })
  assert.deepEqual(r.dialPrefix, dialPrefixOf(task, "uuid-1"))
  assert.equal(r.sums.park_path.park_parent.cacheRead, 145700)
  assert.equal(r.sums.park_path.park_parent.billedModelOutput, 1200)
  assert.equal(r.sums.park_path.restore_child.cacheWrite1h, 1800 + 200 + 150)
  assert.equal(r.sums.park_path.useful_work.requests, 6)
  assert.equal(r.sums.raw_path.useful_work.requests, 6)
  assert.equal(r.sums.raw_path.useful_work.cacheRead, 6 * 145700)
  assert.equal(r.sums.shared.ctx_create.cacheWrite1h, 142620)
  assert.equal(r.sums.shared.resume_raw.cacheRead, 145655, "the gate row is recorded with its true cost")
  assert.equal(r.paths.park.resumeDelayMs, guard.atOffsetMs + STEP_MS - r1.atOffsetMs)
  assert.equal(r.paths.raw.resumeDelayMs, STEP_MS)
  assert.deepEqual(r.paths.park.quality, { guardCorrect: true, workCorrect: 6, workTotal: 6, reexplainNeeded: 0, handoffLossy: false })
  assert.deepEqual(r.paths.raw.quality, { guardCorrect: true, workCorrect: 6, workTotal: 6, reexplainNeeded: 0, handoffLossy: null })
  assert.equal(r.paths.park.completed, true)
  assert.deepEqual(r.flags, ["raw_context_includes_park_turn"])
  assert.equal(r.paidRequests, 20)
  const p = parity("restore-decomposition", requests)
  assert.equal(p.ok, true)
  assert.equal(p.complete, true)
})

test("restore-decomposition: gate FAIL stops the run (resume_gate_miss) - no rf-emulation fallback is paid for", async () => {
  const task = makeTask(1001)
  const { requests, result: r, ctx } = await run("restore-decomposition", { dial: false }, restoreResponder(task, { gatePass: false }))
  assert.equal(ctx.mode.resumeHit, false)
  assert.deepEqual(roles(requests), ["ctx_create", "gate"])
  assert.equal(r.status, "aborted")
  assert.equal(r.reason, "resume_gate_miss")
  assert.equal(r.mode, BIG_CONTEXT_MODE)
  assert.equal(r.gate.pass, false)
  assert.equal(r.gate.cacheWrite1h, 142681)
  assert.equal(r.paidRequests, 2)
})

test("restore-decomposition: handoff_lossy, reexplain, wrong answers, park output range, missing text, big-context rewrite, run 2 offsets", async () => {
  const task = makeTask(1001)
  const lossy = await run("restore-decomposition", { dial: false }, restoreResponder(task, { handoffHasId: false, reexplain: true, wrongWork: [2, 5], guardText: "1, Nowhere, 0", parkOut: 500 }))
  assert.equal(lossy.result.paths.park.quality.handoffLossy, true)
  assert.equal(lossy.result.paths.park.quality.reexplainNeeded, 1)
  assert.equal(lossy.result.paths.park.quality.workCorrect, 4)
  assert.equal(lossy.result.paths.park.quality.guardCorrect, false)
  assert.equal(lossy.result.paths.raw.quality.guardCorrect, false)
  assert.ok(lossy.result.flags.includes("handoff_lossy"))
  assert.ok(lossy.result.flags.includes("park_output_out_of_range"))
  assert.equal(lossy.result.status, "valid", "quality problems are recorded, not stops")
  assert.equal(lossy.requests.length, 20)

  const noText = await run("restore-decomposition", { dial: false }, restoreResponder(task, { noText: "park_parent" }))
  assert.equal(noText.result.status, "void")
  assert.equal(noText.result.reason, "missing_result_text")
  assert.equal(noText.requests.length, 3)

  const rewrite = await run("restore-decomposition", { dial: false }, restoreResponder(task, { rewriteAt: "park_parent" }))
  assert.equal(rewrite.result.status, "aborted")
  assert.equal(rewrite.result.reason, "big_context_rewrite")
  assert.equal(rewrite.requests.length, 3)

  const slow = await run("restore-decomposition", { dial: false }, (step) => step.role === "guard" ? result(record(step, usage(), { ts: iso(step.atOffsetMs + 200000), text: `${task.guardAnswer.id}, ${task.guardAnswer.site}, ${task.guardAnswer.threshold}` })) : restoreResponder(task)(step))
  assert.ok(slow.result.paths.park.resumeDelayMs > 120000)
  assert.ok(slow.result.flags.includes("resume_delay_exceeded"))
  assert.equal(slow.result.status, "valid")

  // Run 2 with the mode already known: no gate, ids offset so both runs stay unique.
  const run2 = await run("restore-decomposition", { dial: false, run: 2, resumeHit: true }, restoreResponder(makeTask(1001)))
  assert.equal(count(run2.requests, (s) => s.role === "gate"), 0)
  assert.equal(run2.requests.length, 19)
  assert.equal(run2.requests[0].index, 100)
  assert.equal(run2.requests[0].id, "restore-decomposition/shared/100")
  assert.equal(run2.requests[0].scopeId, "restore-decomposition/run-2")
  assert.deepEqual(run2.requests[0].unit, { kind: "run", index: 2 })
  assert.equal(run2.result.gate, null)
  assert.equal(run2.result.run, 2)
  assert.equal(run2.result.dialPrefix, null, "only run 1's context becomes the dial")
  assert.equal(parity("restore-decomposition", run2.requests).complete, true)
})

// ------------------------------------------------------------ (e) policy-effect

test("policy-effect: 3 pairs, candidate first, 4 warm pings at 60 s, 8 work steps per arm, per-arm totals", async () => {
  const tasks = [makeTask(1001, { steps: 8 }), makeTask(1002, { steps: 8 }), makeTask(1003, { steps: 8 })]
  const { requests, result: r } = await run("policy-effect", { dial: false, resumeHit: true }, (step) => restoreResponder(tasks[step.unit.index - 1])(step))
  const pairRoles = ["ctx_create", "park_parent", "r1", "r2", "guard", ...Array(8).fill("work"), "warm", "warm", "warm", "warm", "resume_raw", ...Array(8).fill("work"), "end_ping"]
  assert.equal(requests.length, 27 * 3)
  for (let i = 1; i <= 3; i++) {
    const pair = requests.filter((s) => s.unit.index === i)
    assert.deepEqual(roles(pair), pairRoles)
    assert.deepEqual(pair.map((s) => s.scopeId), Array(27).fill(`policy-effect/pair-${i}`))
    assert.equal(pair[0].seed, 1000 + i)
    assert.equal(pair[0].prompt.text, NULLP)
    assert.equal(pair[0].systemPrompt.sha256, contextFileOf(tasks[i - 1]).sha256)
    assert.equal(pair[0].arm, "shared")
    assert.equal(pair[1].arm, "shadow_candidate_policy")
    assert.equal(pair[1].atOffsetMs, pair[0].atOffsetMs + STEP_MS + RULES.restore.settleMs)
    assert.deepEqual(pair.slice(1, 13).map((s) => s.arm), Array(12).fill("shadow_candidate_policy"))
    assert.deepEqual(pair.slice(13, 26).map((s) => s.arm), Array(13).fill("current_policy"))
    const warm = pair.slice(13, 17)
    for (const w of warm) {
      assert.equal(w.kind, "probe")
      assert.equal(w.phase, "warm")
      assert.equal(w.prompt.text, NULLP)
      assert.deepEqual(w.session, { id: pair[0].session.id, mode: "resume" })
      assert.equal(w.expect.hit, true)
    }
    assert.deepEqual(warm.map((w) => w.atOffsetMs - warm[0].atOffsetMs), [0, 60000, 120000, 180000])
    assert.deepEqual(pair.slice(5, 13).map((s) => s.k), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual(pair.slice(18, 26).map((s) => s.k), [1, 2, 3, 4, 5, 6, 7, 8])
    for (let k = 0; k < 8; k++) assert.equal(pair[5 + k].prompt.sha256, pair[18 + k].prompt.sha256, "same task in both arms")
  }
  assert.equal(new Set(requests.map((s) => s.id)).size, requests.length)
  assert.equal(r.status, "valid")
  assert.equal(r.pairs.length, 3)
  const pr = r.pairs[0]
  assert.equal(pr.pair, 1)
  assert.equal(pr.seed, 1001)
  assert.equal(pr.arms.shadow_candidate_policy.state, "complete")
  assert.equal(pr.arms.current_policy.state, "complete")
  assert.equal(pr.arms.current_policy.warm.hits, 4)
  assert.equal(pr.arms.current_policy.warm.misses, 0)
  assert.equal(pr.arms.shadow_candidate_policy.totals.requests, 12)
  assert.equal(pr.arms.current_policy.totals.requests, 13)
  assert.equal(pr.arms.current_policy.totals.cacheRead, 4 * 145655 + 9 * 145700)
  assert.equal(pr.arms.shadow_candidate_policy.quality.workTotal, 8)
  assert.equal(pr.arms.shadow_candidate_policy.quality.workCorrect, 8)
  assert.equal(pr.arms.current_policy.resumeDelayMs, STEP_MS)
  assert.equal(pr.shared.ctx_create.cacheWrite1h, 142620)
  assert.equal(r.mode, BIG_CONTEXT_MODE)
  const p = parity("policy-effect", requests)
  assert.equal(p.ok, true)
  assert.equal(p.complete, true)
})

test("policy-effect: a second warm miss stops the current arm of that pair; the mode gate runs only when unknown", async () => {
  const tasks = [makeTask(1001, { steps: 8 }), makeTask(1002, { steps: 8 }), makeTask(1003, { steps: 8 })]
  let warmSeen = 0
  const { requests, result: r } = await run("policy-effect", { dial: false, resumeHit: true }, (step) => {
    if (step.role === "warm" && step.unit.index === 2) {
      warmSeen++
      return result(record(step, warmSeen <= 2 ? usage({ rd: 3035, w1: 142681 }) : usage({ rd: 145655, w1: 100 })))
    }
    return restoreResponder(tasks[step.unit.index - 1])(step)
  })
  const pair2 = requests.filter((s) => s.unit.index === 2)
  assert.equal(count(pair2, (s) => s.role === "warm"), 2, "stops after the second miss")
  assert.equal(count(pair2, (s) => s.arm === "current_policy"), 2)
  assert.equal(pair2.at(-1).role, "end_ping")
  assert.equal(requests.filter((s) => s.unit.index === 3).length, 27, "the next pair still runs")
  assert.equal(r.pairs[1].arms.current_policy.state, "warm_miss")
  assert.equal(r.pairs[1].arms.current_policy.warm.misses, 2)
  assert.equal(r.pairs[1].arms.shadow_candidate_policy.state, "complete")
  assert.equal(r.status, "valid")
  assert.equal(parity("policy-effect", requests).ok, true)
  assert.equal(parity("policy-effect", requests).complete, false)

  const gated = await run("policy-effect", { dial: false }, (step) => restoreResponder(tasks[step.unit.index - 1], { gatePass: false })(step))
  assert.equal(gated.requests[1].role, "gate")
  assert.equal(gated.requests[1].arm, "shared")
  assert.equal(count(gated.requests, (s) => s.role === "gate"), 1, "gate once, on pair 1")
  assert.deepEqual(roles(gated.requests), ["ctx_create", "gate"], "a gate miss stops the pairs: no fallback form")
  assert.equal(gated.result.status, "aborted")
  assert.equal(gated.result.reason, "resume_gate_miss")
})

// ------------------------------------------------------------- parity + schedule

test("output-quota schedule labels each block with the prompt actually sent", () => {
  const blocks = schedule("output-quota").blocks
  assert.deepEqual(blocks.map(({ prompt }) => prompt), ["outp(3000)", "outp(3000)", "outp(1700)"])
})

test("parity tables cover every experiment and reject unknown steps", () => {
  assert.deepEqual(EXPERIMENT_IDS, ["fable-write-tick", "output-quota", "ttl-1h-unique-prefix", "restore-decomposition", "policy-effect"])
  assert.deepEqual(Object.keys(protocols), EXPERIMENT_IDS)
  for (const id of EXPERIMENT_IDS) {
    const p = parity(id, [])
    assert.equal(p.ok, true, id)
    assert.equal(p.complete, false, id)
    const s = schedule(id)
    assert.equal(s.experiment, id)
    assert.ok(["block", "run", "pair"].includes(s.unit), id)
    assert.ok(Number.isInteger(s.maxUnits) && s.maxUnits >= 1, id)
    assert.ok(Number.isInteger(s.paidCallsMax) && s.paidCallsMax > 0, id)
  }
  const bogus = parity("fable-write-tick", [{ id: "x", arm: "fable-write-1h", role: "nope", unit: { kind: "block", index: 1 } }])
  assert.equal(bogus.ok, false)
  assert.equal(bogus.issues[0].code, "unexpected_step")
  const tooMany = parity("fable-write-tick", [{ arm: "fable-write-1h", role: "write", unit: { kind: "block", index: 3 } }])
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.issues.some((i) => i.code === "too_many_units"))
  assert.equal(parity("ghost", []).ok, false)
  assert.equal(schedule("ghost"), null)
  assert.equal(schedule("fable-write-tick").maxUnits, 2)
  assert.deepEqual(schedule("fable-write-tick").holdOffsetsMs, [5000, 15000, 30000, 60000, 180000, 600000, 1800000])
  assert.equal(schedule("output-quota").loopMax, 64)
  assert.equal(schedule("output-quota").preWalkMax, 30)
  assert.equal(schedule("restore-decomposition").paidCallsPerRun, 20)
  assert.equal(schedule("policy-effect").paidCallsPerPair, 27)
  assert.equal(schedule("policy-effect").maxUnits, 3)
})

test("binding numbers of Appendix A are exported", () => {
  assert.equal(RULES.rho, 1 / 37)
  assert.equal(RULES.dial.minCacheRead, 140000)
  assert.equal(RULES.dial.maxWrite1h, 5000)
  assert.equal(RULES.fable.preWalkMax, 35)
  assert.equal(RULES.fable.postWalkMax, 40)
  assert.equal(RULES.fable.writeLines, 2400)
  assert.equal(RULES.output.preWalkMax, 30)
  assert.equal(RULES.output.loopMax, 64)
  assert.equal(RULES.output.gateMinOutput, 6000)
  assert.equal(RULES.ttl.lines, 2000)
  assert.equal(RULES.ttl.toleranceMs, 90000)
  assert.equal(RULES.restore.gateMinCacheRead, 131040)
  assert.equal(RULES.policy.warmMinCacheRead, 140000)
  assert.equal(RULES.policy.pairs, 3)
})

// ------------------------------------------------------------- (g) source scan

test("protocol modules reference no network, timer, scheduler, write API, wall clock or ambient randomness", () => {
  const forbidden = ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:child_process", "node:worker_threads", "fetch(", "XMLHttpRequest", "setTimeout(", "setInterval(", "setImmediate(", "Atomics.wait", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "execSync", "spawnSync", "node:fs", "Date.now(", "Math.random(", "process."]
  for (const file of ["protocols.mjs", "task.mjs", "filler.mjs"]) {
    const src = readFileSync(new URL(`../scripts/idle-live/${file}`, import.meta.url), "utf8")
    for (const f of forbidden) assert.ok(!src.includes(f), `${file} must not reference ${f}`)
  }
})

// ------------------------------------------------------- lane M group C, item I5
// `scripts/idle-live-analyze.mjs:1704` names the roles the analyzer scores for quality:
// QUALITY_ROLES = { park_parent, r1, r2, guard, work, resume_raw }. A step whose assistant text the
// analyzer reads has to ASK for it: without `needsText` the machine writes no cli/<stepId>.json and
// the analyzer can only report `cli_artifact_missing` for that role.
const QUALITY_ROLES = ["park_parent", "r1", "r2", "guard", "work", "resume_raw"]

test("I5 every quality-scored role asks for its assistant text, and no other role pays for one", async () => {
  // restore-decomposition issues all six of them in one run
  const task = makeTask(1001)
  const restore = await run("restore-decomposition", { dial: false }, restoreResponder(task))
  for (const [name, { requests }] of [["restore-decomposition", restore]]) {
    const scored = requests.filter((r) => QUALITY_ROLES.includes(r.role))
    assert.ok(scored.length > 0, `${name}: no quality-scored step`)
    const silent = [...new Set(scored.filter((r) => r.needsText !== true).map((r) => r.role))]
    assert.deepEqual(silent, [], `${name}: roles the analyzer scores but that ask for no text: ${JSON.stringify(silent)}`)
    const wasteful = [...new Set(requests.filter((r) => !QUALITY_ROLES.includes(r.role) && r.needsText === true).map((r) => r.role))]
    assert.deepEqual(wasteful, [], `${name}: roles asking for text nobody scores: ${JSON.stringify(wasteful)}`)
  }
})
