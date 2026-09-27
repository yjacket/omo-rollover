#!/usr/bin/env node
// CLI entry for the idle-cost live run (plan todo 5, Appendix B "Module boundaries").
//
//   node scripts/idle-live-runner.mjs --approval <file> --evidence <dir>
//                                     [--resume <runId>] [--only <id>[,<id>]]
//                                     [--dry-run] [--smoke] [--port <n>]
//
// This file is the ONLY place in the runner stack that may touch the process, the network, a
// timer or the file system: it builds `deps` and hands them to the pure state machine in
// scripts/idle-live/machine.mjs. It prints exactly ONE JSON summary line on stdout (the dry run
// prefixes a human-readable schedule with `#` comment lines) and exits with the machine's code:
//   0 every experiment terminal | 2 preflight refusal | 3 aborted by a cap or a stop rule
//   4 in doubt after a crash (resumable with --resume <runId>)
//
// A failure the machine does not report itself (a thrown error, a proxy that cannot bind) is
// classified from the evidence dir's event log, never assumed resumable (Appendix B: only exit 4
// is resumable): exit 4 only when the log holds a state --resume can act on (an in-doubt step, or
// an experiment_started without experiment_ended); exit 2 when the log holds no run_started (bad
// arguments, unwritable evidence dir, port in use, proxy start failure); exit 3 otherwise - the run
// stopped live with nothing left for a resume to reconcile.
//
// Without --approval pointing at an APPROVED artifact nothing is issued: exit 2. The approval is
// bound to the planner and proposal bytes by sha256, so plan drift refuses the run.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { runMachine, fold, manifest, isSmokeLog, EXIT, SUMMARY_VERSION, PREFLIGHT_ID } from "./idle-live/machine.mjs"
import { loadApproval } from "./idle-live/approval.mjs"
import { createClaudeCliAdapter, probeCliVersion } from "./idle-live/adapters/claude-cli.mjs"
import { startProxy, readProxyLog } from "./idle-live/proxy.mjs"
import { openLedger } from "./idle-live/ledger.mjs"
import { conflicting } from "./idle-live/processes.mjs"
import { EXPERIMENT_IDS, OUTPUT_BLOCKS, BIG_CONTEXT_FORM } from "./idle-live/protocols.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
const PLANNER = path.join(repo, "scripts/idle-experiments.mjs")
const PROPOSAL = path.join(repo, "docs/idle-experiments-approval-proposal.json")
const HEALTH_TIMEOUT_MS = 2000

/**
 * The CLI the live run spawns: a non-empty IDLE_LIVE_CLI, else the npm package's claude.exe under
 * %APPDATA% (as quota-test/2026-09-19/run.mjs:22). npm's `claude` / `claude.cmd` shims cannot be
 * started by spawn without a shell, so a bare name is never the default. null (APPDATA unset and no
 * override) is refused as cli_unavailable / cli_path_unresolved, never guessed.
 */
export function resolveCli(env) {
  if (env.IDLE_LIVE_CLI) return env.IDLE_LIVE_CLI
  if (!env.APPDATA) return null
  return path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
}

const USAGE = `usage: node scripts/idle-live-runner.mjs --approval <file> --evidence <dir> [--resume <runId>] [--only <id>[,<id>]] [--dry-run] [--smoke] [--fresh-window] [--port <n>]`

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex")
const readText = (file) => fs.readFileSync(file, "utf8")

const refusal = (issues, extra = {}) => ({
  v: SUMMARY_VERSION,
  runId: null,
  exitCode: EXIT.PREFLIGHT,
  experiments: {},
  meters: {},
  resumable: false,
  evidenceDir: null,
  paidRequestsIssued: 0,
  issues,
  ...extra,
})

// ------------------------------------------------------------------ arguments

export function parseArgs(argv) {
  const opts = { approval: null, evidence: null, resume: null, only: null, dryRun: false, smoke: false, freshWindow: false, port: 0 }
  const takes = { "--approval": "approval", "--evidence": "evidence", "--resume": "resume", "--only": "only", "--port": "port" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") { opts.dryRun = true; continue }
    if (arg === "--smoke") { opts.smoke = true; continue }
    if (arg === "--fresh-window") { opts.freshWindow = true; continue }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue }
    const key = takes[arg]
    if (!key) return { error: "unknown_argument", arg }
    const value = argv[++i]
    if (value === undefined) return { error: "missing_value", arg }
    opts[key] = value
  }
  if (opts.only !== null) {
    const ids = String(opts.only).split(",").map((s) => s.trim()).filter(Boolean)
    if (!ids.length || ids.some((id) => !EXPERIMENT_IDS.includes(id))) return { error: "unknown_experiment", arg: opts.only }
    opts.only = ids
  }
  if (opts.port !== 0) {
    const port = Number(opts.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: "bad_port", arg: opts.port }
    opts.port = port
  }
  if (opts.dryRun && opts.smoke) return { error: "dry_run_and_smoke", arg: "--smoke" }
  return { opts }
}

// -------------------------------------------------------------------- deps

// Real sleep for the live clock (its `now` is the injected io.now). It honours an AbortSignal and
// clears its timer, so a cancelled wait neither resolves late nor keeps the process alive.
const realClock = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { code: "aborted" }))
      let onAbort = null
      const timer = setTimeout(() => {
        if (onAbort) signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      if (signal) {
        onAbort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error("aborted"), { code: "aborted" }))
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }),
}

// Dry-run deps: no network, no spawn, no file system, no timer. Only preflight runs on these.
// `now` is the runner's injected clock (io.now), so preflight judges the approval at the same
// instant loadApproval did.
function fakeDeps(capabilities, now) {
  const events = []
  const requests = []
  return {
    clock: { now, sleep: async () => { throw Object.assign(new Error("dry run never sleeps"), { code: "dry_run" }) } },
    adapter: { capabilities, invoke: async () => { throw Object.assign(new Error("dry run never invokes"), { code: "dry_run" }) } },
    proxy: { port: 0, drainSince: async () => ({ records: [], cursor: 0 }), readLog: async () => [], close: async () => {} },
    ledger: {
      dir: null,
      append(event) { const rec = { seq: events.length, ts: new Date(now()).toISOString(), ...event }; events.push(rec); return rec },
      fold: () => ({ events: events.slice(), torn: false, lastSeq: events.length - 1 }),
      tail: (n) => events.slice(-n),
      writeRequestRecord: (r) => requests.push(r),
      readRequests: () => requests.slice(),
      writeCli: () => null,
      readCli: () => { throw Object.assign(new Error("no artifact"), { code: "ENOENT" }) },
      writeSummary: () => {},
    },
    processes: { conflicting: async () => [] }, // a dry run does not scan the process table
    random: { uuid: () => "00000000-0000-4000-8000-000000000000", seed: () => 0 },
    log: () => {},
  }
}

// A proxy.jsonl reader for callers without a live proxy handle. The live runner does NOT use it:
// the machine reads history through deps.proxy.readLog(). Same rule, same code (readProxyLog).
export const proxyLogReader = (logPath) => ({ records: () => readProxyLog(logPath) })

// Why the live run could not create `dir`, checked WITHOUT creating anything (the dry run must
// leave no trace): the nearest existing ancestor must be a writable directory. null = creatable.
function evidenceBlocker(dir) {
  let p = path.resolve(dir)
  for (;;) {
    let st
    try {
      st = fs.statSync(p)
    } catch (e) {
      if (e.code !== "ENOENT") return String(e.code ?? e.message)
      const up = path.dirname(p)
      if (up === p) return "ENOENT"
      p = up
      continue
    }
    if (!st.isDirectory()) return "ENOTDIR"
    try {
      fs.accessSync(p, fs.constants.W_OK)
    } catch (e) {
      return String(e.code ?? e.message)
    }
    return null
  }
}

// ------------------------------------------------------- failure classification

/**
 * What the evidence dir's event log says a failure left behind. `started` is false when no
 * run_started was ever written; `inDoubt` are issued steps the log never resolved and
 * `interrupted` are experiments started and never ended - the two states --resume acts on
 * (Appendix B, resume verdict contract revision 2, items 3 and 4). `unreadable` is set when the
 * log exists but cannot be read or folded: nothing about it can be claimed.
 */
export function logState(evidenceDir) {
  const none = { started: false, inDoubt: [], interrupted: [], paidRequests: 0, smoke: false, unreadable: null }
  if (!evidenceDir) return none
  let text
  try {
    text = fs.readFileSync(path.join(evidenceDir, "events.jsonl"), "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return none
    return { ...none, started: null, paidRequests: null, unreadable: String(e.code ?? e.message) }
  }
  let st
  try {
    st = fold(text)
  } catch (e) {
    return { ...none, started: null, paidRequests: null, unreadable: String(e.message) }
  }
  // RN6 (todo 12 re-review 1): "preflight" (the baseline/re-baseline quiet check) never gets an
  // experiment_ended - it is not one of Appendix A's approved jobs, and a resume ALWAYS redoes it
  // fresh regardless of what the log holds for it (revision 2 (5); resumeFromLog never looks it up
  // by job key either, since pre.jobs never contains "preflight"). fold()'s lazy `expOf` still
  // creates an entry for it with status "started" the moment its first PING step is logged, and
  // that status never changes - so EVERY real evidence dir that ever ran its quiet check would
  // otherwise show "preflight" as perpetually interrupted, even a run that finished cleanly. That
  // is not a state --resume can act on, so it must not promise exit 4 / resumable:true on its own.
  const interrupted = Object.entries(st.experiments).filter(([key, x]) => key !== PREFLIGHT_ID && x.status === "started").map(([key]) => key)
  // N7 (todo 12 rework): a smoke evidence dir is never resumable even when the MACHINE itself
  // throws mid-flight (not a --resume attempt at all) - this classification path must not promise
  // exit 4 / resumable:true for one just because it happens to hold an in-doubt or open step.
  return { started: st.startedAt !== null, inDoubt: st.inDoubt.slice(), interrupted, paidRequests: st.paidRequests, smoke: isSmokeLog(text), unreadable: null }
}

/** The summary for a failure the machine did not report itself, classified from the log. */
function classified(ctx, issues, extra = {}) {
  const s = logState(ctx.evidenceDir)
  const base = { runId: ctx.runId, evidenceDir: ctx.evidenceDir, paidRequestsIssued: s.paidRequests, inDoubt: s.inDoubt, interrupted: s.interrupted, ...extra }
  if (s.unreadable) return refusal([...issues, "event_log_unreadable"], { ...base, exitCode: EXIT.ABORTED, logError: s.unreadable })
  if (s.smoke) return refusal([...issues, "smoke_not_resumable"], { ...base, exitCode: EXIT.ABORTED, resumable: false })
  if (s.inDoubt.length || s.interrupted.length) return refusal(issues, { ...base, exitCode: EXIT.IN_DOUBT, resumable: true })
  if (s.started) return refusal(issues, { ...base, exitCode: EXIT.ABORTED })
  return refusal(issues, { ...base, exitCode: EXIT.PREFLIGHT })
}

// ------------------------------------------------------------ schedule table

function printSchedule(write, schedule, skippedArms, freshWindow = false) {
  const ms = (v) => (v >= 3600_000 ? `${(v / 3600_000).toFixed(1)}h` : `${Math.round(v / 60_000)}m`)
  const line = (c) => write(`# ${c.join("  ")}\n`)
  write("# idle-live dry run: preflight only, paidRequestsIssued=0\n")
  if (freshWindow) write("# fresh-window: true\n")
  line(["ord", "experiment".padEnd(22), "unit ", "n", "calls(exp/max)", "wall  ", "perIdle/scope", "perPlan", "largest call"])
  for (const r of schedule) {
    line([
      String(r.order).padEnd(3),
      `${r.experiment}${r.run ? `#${r.run}` : ""}`.padEnd(22),
      String(r.unit).padEnd(5),
      String(r.units),
      `${r.paidCallsExpected}/${r.paidCallsMax}`.padEnd(14),
      ms(r.expectedWallClockMs).padEnd(6),
      // the scope the cap is enforced on (the JSON row's perIdleScope): ttl's 0.06 is per frame
      `${r.perIdleCapEq.toFixed(2)}/${r.perIdleScope}`.padEnd(13),
      r.perPlanCapEq.toFixed(2).padEnd(7),
      ...(r.priorPlanUpperEq === undefined ? [] : [`priorPlan=${r.priorPlanUpperEq.toFixed(2)}`, `priorMeters=${JSON.stringify(r.priorMeterUpperEq)}`]),
      `${r.largestCall.label} ~${r.largestCall.predictedEq.toFixed(2)} eq (tier ${r.largestCall.tier})`,
    ])
  }
  for (const [experiment, arms] of Object.entries(skippedArms ?? {})) {
    for (const [arm, reason] of Object.entries(arms)) line(["skipped arm:", `${experiment}/${arm}`, reason])
  }
  // what each output-quota block would send and the output its gate requires
  if (schedule.some((r) => r.experiment === "output-quota")) {
    for (const b of OUTPUT_BLOCKS) {
      line([`output-quota/block-${b.block}`, `arm=${b.arm}`, `prompt=outp(${b.n})`, `target=${b.target}`, `gateMinOutput=${b.gateMinOutput}`, ...(b.optional ? ["optional=true"] : [])])
    }
  }
  // how restore-decomposition and policy-effect send their big context (Amendment 2026-09-27)
  const f = BIG_CONTEXT_FORM
  for (const id of Object.keys(f.laterRoles)) {
    if (!schedule.some((r) => r.experiment === id)) continue
    line([`${id}/big-context`, `mode=${f.mode}`, `file=${f.file}`, `ctx_create=${f.ctxCreate}`, `laterRoles=${f.laterRoles[id].join(",")}`, `later=${f.later}`, `gateMiss=${f.gateMiss}`])
  }
}

// ---------------------------------------------------------------------- main

/**
 * main(argv, io) -> exit code. Prints exactly one JSON summary line; never throws for a failure
 * it can classify. `io` carries the process/network effects: the CLI entry passes the real ones
 * (REAL_IO); tests pass fakes, so main can be driven without spawning, binding a real upstream, or
 * paying.
 *
 * The live deps are OPT-IN and the seam FAILS CLOSED: every live dependency (LIVE_DEPS) must be a
 * function in `io`, or main throws `live_dep_not_injected` before any effect. That includes no `io`
 * at all - a test that forgets the seam, or one dep, never falls through to a real process scan,
 * port bind, spawn or network call. Each dep is read once and the value checked is the value used,
 * so inherited or non-enumerable deps are honoured, never silently replaced by the real ones.
 * stdout, stderr, timeoutSignal (the health-probe bound) and now (the clock the approval window,
 * preflight and the run's timestamps are judged by; () -> epoch ms) are optional: they cause no
 * live effect, and a seam without them gets the real ones. `env` (an object, read once) is where the CLI
 * path is resolved from and what the probe and the adapter pass to the CLI; a seam without it gets
 * process.env. probeCli(cli, env) -> version is the `<cli> --version` preflight (I28).
 */
const LIVE_DEPS = ["startProxy", "runMachine", "createAdapter", "conflicting", "fetch", "probeCli"]
const OPTIONAL_DEPS = ["stdout", "stderr", "timeoutSignal", "now"]
const REAL_IO = Object.freeze({
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  now: () => Date.now(),
  startProxy,
  runMachine,
  createAdapter: createClaudeCliAdapter,
  conflicting,
  fetch: (...args) => globalThis.fetch(...args),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  probeCli: (cli, env) => probeCliVersion({ cli, spawn, baseEnv: env }),
})

export async function main(argv = process.argv.slice(2), io = undefined) {
  const env = {}
  const missing = []
  for (const k of LIVE_DEPS) {
    const dep = io?.[k]
    if (typeof dep === "function") env[k] = dep
    else missing.push(k)
  }
  if (missing.length) {
    throw Object.assign(new Error(`main(argv, io): live deps not injected: ${missing.join(", ")}; refusing to fall through to the live path`), { code: "live_dep_not_injected", missing })
  }
  for (const k of OPTIONAL_DEPS) {
    const dep = io[k]
    env[k] = typeof dep === "function" ? dep : REAL_IO[k]
  }
  const processEnv = io.env
  env.processEnv = processEnv && typeof processEnv === "object" ? processEnv : process.env
  const ctx = { runId: null, evidenceDir: null }
  const finish = (summary) => {
    env.stdout(`${JSON.stringify(summary)}\n`)
    return summary.exitCode
  }
  try {
    return await run(argv, env, ctx, finish)
  } catch (e) {
    const s = logState(ctx.evidenceDir)
    const issue = s.started === false ? "runner_crashed_before_run_started" : "runner_crashed"
    return finish(classified(ctx, [issue], { detail: String(e?.message ?? e) }))
  }
}

async function run(argv, env, ctx, finish) {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    env.stderr(`${USAGE}\n`)
    return finish(refusal([parsed.error], { arg: parsed.arg ?? null }))
  }
  const opts = parsed.opts
  if (opts.help) {
    env.stderr(`${USAGE}\n`)
    return finish(refusal(["help"]))
  }
  if (!opts.approval) {
    env.stderr(`${USAGE}\n`)
    return finish(refusal(["no_approval"]))
  }

  // 1. approval: parsed, signed, current, and bound to the planner + proposal bytes.
  let approvalText
  try {
    approvalText = readText(opts.approval)
  } catch (e) {
    return finish(refusal(["approval_unreadable"], { detail: String(e.code ?? e.message) }))
  }
  let approvalJson = null
  try {
    approvalJson = JSON.parse(approvalText)
  } catch {
    return finish(refusal(["approval_not_json"]))
  }
  const plannerSource = readText(PLANNER)
  const proposalJson = readText(PROPOSAL)
  let capBasisBytes
  if (approvalJson.capMultiplier !== undefined) {
    try { capBasisBytes = readText(path.join(repo, "docs/idle-experiments-approval-2026-09-23.json")) }
    catch { return finish(refusal(["cap_basis_sha_drift"])) }
  }
  const check = loadApproval(approvalJson, { now: env.now(), plannerSource, proposalJson, capBasisBytes })
  if (!check.ok) return finish(refusal(check.issues, { approvalPath: opts.approval }))
  const approval = check.approval
  const shas = { plannerSha256: sha256(plannerSource), proposalSha256: sha256(proposalJson) }

  const capabilities = { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model: approval.target.modelId }

  // 2. dry run: preflight on fake deps. Nothing is created, nothing is spawned, nothing is paid.
  if (opts.dryRun) {
    if (opts.evidence) {
      const blocker = evidenceBlocker(opts.evidence)
      if (blocker) return finish(refusal(["evidence_dir_unwritable"], { evidenceDir: path.resolve(opts.evidence), detail: blocker }))
    }
    const deps = fakeDeps(capabilities, env.now)
    const summary = await env.runMachine(deps, approval, {
      runId: "dry-run",
      evidenceDir: null,
      dryRun: true,
      only: opts.only,
      freshWindow: opts.freshWindow,
      ...shas,
    })
    if (summary.exitCode === EXIT.OK) printSchedule(env.stdout, summary.schedule, summary.experiments && deps.ledger.fold().events.find((e) => e.ev === "preflight")?.skippedArms, opts.freshWindow)
    return finish({ ...summary, evidenceDirCreated: false })
  }

  if (!opts.evidence) return finish(refusal(["no_evidence_dir"]))

  // 3a. the CLI must start before anything paid can be scheduled (live, --smoke, --resume): `<cli>
  // --version`, no API call. Refused before the evidence dir or the proxy exist, so a resumable log
  // is left exactly as it was. The probed version is what run.json records.
  const cli = resolveCli(env.processEnv)
  if (!cli) return finish(refusal(["cli_unavailable"], { cli, cliError: { code: "cli_path_unresolved", message: "IDLE_LIVE_CLI and APPDATA are both unset" } }))
  let cliVersion
  try {
    cliVersion = await env.probeCli(cli, env.processEnv)
  } catch (e) {
    return finish(refusal(["cli_unavailable"], { cli, cliError: { code: String(e?.code ?? "probe_failed"), message: String(e?.message ?? e) } }))
  }

  // 3. live run (or --smoke): evidence directory, proxy, adapter, ledger.
  const runId = opts.resume ?? new Date(env.now()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
  const evidenceDir = path.resolve(opts.evidence, runId)
  ctx.runId = runId
  try {
    fs.mkdirSync(evidenceDir, { recursive: true })
  } catch (e) {
    return finish(refusal(["evidence_dir_unwritable"], { runId, evidenceDir, detail: String(e.code ?? e.message) }))
  }
  ctx.evidenceDir = evidenceDir
  const manifestPath = path.join(evidenceDir, "run.json")
  if (opts.resume) {
    // The recorded manifest must still describe THIS approval (Appendix B "Checkpoint / resume").
    let recorded = null
    try {
      recorded = JSON.parse(readText(manifestPath))
    } catch {
      return finish(refusal(["resume_manifest_missing"], { evidenceDir }))
    }
    if (recorded.approval?.sha256 !== sha256(approvalText) || recorded.approval?.plannerSha256 !== shas.plannerSha256) {
      return finish(refusal(["resume_approval_drift"], { evidenceDir }))
    }
    if (!opts.port && Number.isInteger(recorded.proxyPort)) opts.port = recorded.proxyPort
    if (recorded.freshWindow === true) opts.freshWindow = true
    // N3/B1/N4 (todo 12 rework). The smoke-resume refusal is a PURE READ of this evidence dir's
    // own events.jsonl - it must happen before the proxy bind and before run.json is rewritten
    // below, so a refused --resume leaves the evidence dir byte-identical. A smoke evidence dir
    // (run_started.smoke:true, on every path it can stop on) is never resumable; a non-smoke
    // (campaign) evidence dir resumed with --smoke would run a smoke inside that log, re-using ids
    // it already holds, so that is refused too.
    // Only a missing log means "no smoke log here"; any other read error means nothing about this
    // dir can be claimed, so the resume is refused before any side effect (as classified() does).
    let rawEvents = ""
    try {
      rawEvents = readText(path.join(evidenceDir, "events.jsonl"))
    } catch (e) {
      if (e.code !== "ENOENT") {
        return finish(refusal(["event_log_unreadable"], { runId, evidenceDir, exitCode: EXIT.ABORTED, paidRequestsIssued: null, logError: String(e.code ?? e.message) }))
      }
    }
    const smokeLog = isSmokeLog(rawEvents)
    if (smokeLog || opts.smoke) {
      // RB1 (todo 12 re-review 1): the applied Appendix B amendment says the refusal summary
      // reports the folded inDoubt and paid counts - true at the machine layer, but the runner is
      // the only layer the real CLI reaches for a smoke dir, so it must report them too, not the
      // refusal() defaults (inDoubt absent, paidRequestsIssued 0). The text is already read.
      const folded = fold(rawEvents)
      const base = { runId, evidenceDir, resumable: false, inDoubt: folded.inDoubt, paidRequestsIssued: folded.paidRequests }
      if (smokeLog) return finish(refusal(["smoke_not_resumable"], { ...base, exitCode: EXIT.ABORTED }))
      return finish(refusal(["smoke_resume_of_campaign"], { ...base, exitCode: EXIT.PREFLIGHT }))
    }
  }

  const logPath = path.join(evidenceDir, "proxy.jsonl")
  const labelFile = path.join(evidenceDir, "label.txt")
  let proxy
  try {
    proxy = await env.startProxy({ port: opts.port, logPath, runId, labelFile })
  } catch (e) {
    if (e.code !== "EADDRINUSE") return finish(classified(ctx, ["proxy_start_failed"], { detail: String(e.code ?? e.message) }))
    // The port answering with OUR runId is a live runner of this same run: a second one must never
    // start beside it. Any other answer (or none) is a foreign owner. Either way this process issues
    // nothing, and whether the run is resumable is what the log says - not the port.
    const health = await env.fetch(`http://127.0.0.1:${opts.port}/__health`, { signal: env.timeoutSignal(HEALTH_TIMEOUT_MS) })
      .then((r) => r.json())
      .catch(() => null)
    const issue = health?.runId === runId ? "proxy_port_held_by_this_run" : "proxy_port_in_use"
    return finish(classified(ctx, [issue], { health }))
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  let summary
  try {
    const ledger = openLedger(evidenceDir)
    // P files (the restore/policy big context) live beside the run's evidence, one per seed
    const adapter = env.createAdapter({ cli, model: approval.target.modelId, spawn, workDir: evidenceDir, labelFile, contextDir: path.join(evidenceDir, "ctx"), baseEnv: env.processEnv })
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest({
      runId,
      evidenceDir,
      startedAt: new Date(env.now()).toISOString(),
      approvalPath: path.resolve(opts.approval),
      approvalSha256: sha256(approvalText),
      plannerSha256: shas.plannerSha256,
      proposalSha256: shas.proposalSha256,
      adapter: adapter.capabilities,
      cliVersion,
      model: approval.target.modelId,
      order: approval.order,
      proxyPort: proxy.port,
      resumedFrom: opts.resume ?? null,
      priorSpend: approval.priorSpend ?? null,
      freshWindow: opts.freshWindow,
    }), null, 2)}\n`)

    // In-doubt reconciliation reads the historical proxy.jsonl through deps.proxy.readLog().
    const deps = {
      clock: { now: env.now, sleep: realClock.sleep },
      adapter,
      proxy,
      ledger,
      processes: { conflicting: () => env.conflicting() },
      random: { uuid: () => crypto.randomUUID(), seed: () => crypto.randomInt(1, 2 ** 31 - 1) },
      log: (line) => env.stderr(`${line}\n`),
    }

    summary = await env.runMachine(deps, approval, {
      runId,
      evidenceDir,
      resume: opts.resume ? runId : null,
      only: opts.only,
      smoke: opts.smoke,
      freshWindow: opts.freshWindow,
      baseUrl: `http://127.0.0.1:${proxy.port}`,
      signal: controller.signal,
      ...shas,
    })
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await proxy.close()
  }
  return finish(summary)
}

// Main-module check: true only when this file is the script node was started with. argv[1] is
// absent under `node -e` / the REPL, and another script that merely imports the runner (whatever
// its name) must not start a run.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // main() classifies every failure itself; this guard only fires if printing the summary failed,
  // so nothing about the run can be claimed - in particular not that it is resumable.
  main(process.argv.slice(2), REAL_IO).then(
    (code) => { process.exitCode = code },
    (e) => {
      process.stdout.write(`${JSON.stringify({ ...refusal(["runner_crashed_unclassified"], { detail: String(e?.message ?? e), paidRequestsIssued: null }), exitCode: EXIT.ABORTED })}\n`)
      process.exitCode = EXIT.ABORTED
    },
  )
}
