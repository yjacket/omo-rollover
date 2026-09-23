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
import { fileURLToPath } from "node:url"

import { runMachine, fold, manifest, EXIT, SUMMARY_VERSION } from "./idle-live/machine.mjs"
import { loadApproval } from "./idle-live/approval.mjs"
import { createClaudeCliAdapter } from "./idle-live/adapters/claude-cli.mjs"
import { startProxy, readProxyLog } from "./idle-live/proxy.mjs"
import { openLedger } from "./idle-live/ledger.mjs"
import { conflicting } from "./idle-live/processes.mjs"
import { EXPERIMENT_IDS } from "./idle-live/protocols.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
const PLANNER = path.join(repo, "scripts/idle-experiments.mjs")
const PROPOSAL = path.join(repo, "docs/idle-experiments-approval-proposal.json")
const DEFAULT_CLI = process.env.IDLE_LIVE_CLI ?? "claude"
const HEALTH_TIMEOUT_MS = 2000

const USAGE = `usage: node scripts/idle-live-runner.mjs --approval <file> --evidence <dir> [--resume <runId>] [--only <id>[,<id>]] [--dry-run] [--smoke] [--port <n>]`

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
  const opts = { approval: null, evidence: null, resume: null, only: null, dryRun: false, smoke: false, port: 0 }
  const takes = { "--approval": "approval", "--evidence": "evidence", "--resume": "resume", "--only": "only", "--port": "port" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") { opts.dryRun = true; continue }
    if (arg === "--smoke") { opts.smoke = true; continue }
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

// Real clock. `sleep` honours an AbortSignal and clears its timer, so a cancelled wait neither
// resolves late nor keeps the process alive.
const realClock = {
  now: () => Date.now(),
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
function fakeDeps(capabilities) {
  const events = []
  const requests = []
  return {
    clock: { now: () => Date.now(), sleep: async () => { throw Object.assign(new Error("dry run never sleeps"), { code: "dry_run" }) } },
    adapter: { capabilities, invoke: async () => { throw Object.assign(new Error("dry run never invokes"), { code: "dry_run" }) } },
    proxy: { port: 0, drainSince: async () => ({ records: [], cursor: 0 }), readLog: async () => [], close: async () => {} },
    ledger: {
      dir: null,
      append(event) { const rec = { seq: events.length, ts: new Date().toISOString(), ...event }; events.push(rec); return rec },
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
  const none = { started: false, inDoubt: [], interrupted: [], paidRequests: 0, unreadable: null }
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
  const interrupted = Object.entries(st.experiments).filter(([, x]) => x.status === "started").map(([key]) => key)
  return { started: st.startedAt !== null, inDoubt: st.inDoubt.slice(), interrupted, paidRequests: st.paidRequests, unreadable: null }
}

/** The summary for a failure the machine did not report itself, classified from the log. */
function classified(ctx, issues, extra = {}) {
  const s = logState(ctx.evidenceDir)
  const base = { runId: ctx.runId, evidenceDir: ctx.evidenceDir, paidRequestsIssued: s.paidRequests, inDoubt: s.inDoubt, interrupted: s.interrupted, ...extra }
  if (s.unreadable) return refusal([...issues, "event_log_unreadable"], { ...base, exitCode: EXIT.ABORTED, logError: s.unreadable })
  if (s.inDoubt.length || s.interrupted.length) return refusal(issues, { ...base, exitCode: EXIT.IN_DOUBT, resumable: true })
  if (s.started) return refusal(issues, { ...base, exitCode: EXIT.ABORTED })
  return refusal(issues, { ...base, exitCode: EXIT.PREFLIGHT })
}

// ------------------------------------------------------------ schedule table

function printSchedule(write, schedule, skippedArms) {
  const ms = (v) => (v >= 3600_000 ? `${(v / 3600_000).toFixed(1)}h` : `${Math.round(v / 60_000)}m`)
  const line = (c) => write(`# ${c.join("  ")}\n`)
  write("# idle-live dry run: preflight only, paidRequestsIssued=0\n")
  line(["ord", "experiment".padEnd(22), "unit ", "n", "calls(exp/max)", "wall  ", "perIdle", "perPlan", "largest call"])
  for (const r of schedule) {
    line([
      String(r.order).padEnd(3),
      `${r.experiment}${r.run ? `#${r.run}` : ""}`.padEnd(22),
      String(r.unit).padEnd(5),
      String(r.units),
      `${r.paidCallsExpected}/${r.paidCallsMax}`.padEnd(14),
      ms(r.expectedWallClockMs).padEnd(6),
      r.perIdleCapEq.toFixed(2).padEnd(7),
      r.perPlanCapEq.toFixed(2).padEnd(7),
      `${r.largestCall.label} ~${r.largestCall.predictedEq.toFixed(2)} eq (tier ${r.largestCall.tier})`,
    ])
  }
  for (const [experiment, arms] of Object.entries(skippedArms ?? {})) {
    for (const [arm, reason] of Object.entries(arms)) line(["skipped arm:", `${experiment}/${arm}`, reason])
  }
}

// ---------------------------------------------------------------------- main

/**
 * main(argv, io) -> exit code. Prints exactly one JSON summary line; never throws for a failure
 * it can classify. `io` is a TEST SEAM: tests replace the process/network effects (stdout,
 * stderr, startProxy, runMachine, createAdapter, conflicting, fetch) so main can be driven
 * without spawning, binding a real upstream, or paying. The CLI passes nothing.
 *
 * The seam FAILS CLOSED: once an `io` object is given, every live dependency (LIVE_DEPS) must be in
 * it, or main throws `live_dep_not_injected` before any effect - a test that forgets one must
 * never fall through to a real process scan, port bind, spawn or network call. Only the CLI's
 * seamless call (`io` undefined) uses the real dependencies; its behaviour is unchanged.
 */
const LIVE_DEPS = ["startProxy", "runMachine", "createAdapter", "conflicting", "fetch"]

export async function main(argv = process.argv.slice(2), io = undefined) {
  if (io !== undefined) {
    const missing = LIVE_DEPS.filter((k) => typeof io?.[k] !== "function")
    if (missing.length) {
      throw Object.assign(new Error(`main(argv, io): test seam lacks ${missing.join(", ")}; refusing to fall through to the live path`), { code: "live_dep_not_injected", missing })
    }
  }
  const env = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    startProxy,
    runMachine,
    createAdapter: createClaudeCliAdapter,
    conflicting,
    fetch: (...args) => globalThis.fetch(...args),
    ...io,
  }
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
  const check = loadApproval(approvalJson, { now: Date.now(), plannerSource, proposalJson })
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
    const deps = fakeDeps(capabilities)
    const summary = await env.runMachine(deps, approval, {
      runId: "dry-run",
      evidenceDir: null,
      dryRun: true,
      only: opts.only,
      ...shas,
    })
    if (summary.exitCode === EXIT.OK) printSchedule(env.stdout, summary.schedule, summary.experiments && deps.ledger.fold().events.find((e) => e.ev === "preflight")?.skippedArms)
    return finish({ ...summary, evidenceDirCreated: false })
  }

  if (!opts.evidence) return finish(refusal(["no_evidence_dir"]))

  // 3. live run (or --smoke): evidence directory, proxy, adapter, ledger.
  const runId = opts.resume ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
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
    const health = await env.fetch(`http://127.0.0.1:${opts.port}/__health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
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
    const adapter = env.createAdapter({ cli: DEFAULT_CLI, model: approval.target.modelId, spawn, workDir: evidenceDir, labelFile })
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest({
      runId,
      evidenceDir,
      startedAt: new Date().toISOString(),
      approvalPath: path.resolve(opts.approval),
      approvalSha256: sha256(approvalText),
      plannerSha256: shas.plannerSha256,
      proposalSha256: shas.proposalSha256,
      adapter: adapter.capabilities,
      cliVersion: process.env.IDLE_LIVE_CLI_VERSION ?? null,
      model: approval.target.modelId,
      order: approval.order,
      proxyPort: proxy.port,
      resumedFrom: opts.resume ?? null,
    }), null, 2)}\n`)

    // In-doubt reconciliation reads the historical proxy.jsonl through deps.proxy.readLog().
    const deps = {
      clock: realClock,
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("idle-live-runner.mjs")) {
  // main() classifies every failure itself; this guard only fires if printing the summary failed,
  // so nothing about the run can be claimed - in particular not that it is resumable.
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      process.stdout.write(`${JSON.stringify({ ...refusal(["runner_crashed_unclassified"], { detail: String(e?.message ?? e), paidRequestsIssued: null }), exitCode: EXIT.ABORTED })}\n`)
      process.exitCode = EXIT.ABORTED
    },
  )
}
