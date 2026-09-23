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
// Without --approval pointing at an APPROVED artifact nothing is issued: exit 2. The approval is
// bound to the planner and proposal bytes by sha256, so plan drift refuses the run.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { runMachine, manifest, EXIT, SUMMARY_VERSION } from "./idle-live/machine.mjs"
import { loadApproval } from "./idle-live/approval.mjs"
import { createClaudeCliAdapter } from "./idle-live/adapters/claude-cli.mjs"
import { startProxy } from "./idle-live/proxy.mjs"
import { openLedger } from "./idle-live/ledger.mjs"
import { conflicting } from "./idle-live/processes.mjs"
import { EXPERIMENT_IDS } from "./idle-live/protocols.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
const PLANNER = path.join(repo, "scripts/idle-experiments.mjs")
const PROPOSAL = path.join(repo, "docs/idle-experiments-approval-proposal.json")
const DEFAULT_CLI = process.env.IDLE_LIVE_CLI ?? "claude"

const USAGE = `usage: node scripts/idle-live-runner.mjs --approval <file> --evidence <dir> [--resume <runId>] [--only <id>[,<id>]] [--dry-run] [--smoke] [--port <n>]`

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex")
const readText = (file) => fs.readFileSync(file, "utf8")
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

/** One JSON line and the exit code; nothing else is ever printed to stdout. */
function finish(summary, code) {
  out(summary)
  process.exitCode = code
  return code
}

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

// The proxy's JSONL log, read back for in-doubt reconciliation on --resume. startProxy() only
// exposes the records of the CURRENT process, so the runner reads the file itself.
export const proxyLogReader = (logPath) => ({
  async records() {
    let text
    try {
      text = fs.readFileSync(logPath, "utf8")
    } catch (e) {
      if (e.code === "ENOENT") return []
      throw e
    }
    const lines = text.split("\n")
    const rows = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch (e) {
        // Only the LAST line may be torn - that is what a kill mid-append leaves. A bad line
        // anywhere before it means rows are missing from the middle of the evidence, and skipping
        // it would hide a paid call from reconciliation.
        if (i === lines.length - 1) break
        throw Object.assign(new Error(`${logPath} line ${i + 1} is not JSON: ${e.message}`), { code: "proxy_log_corrupt", line: i + 1 })
      }
    }
    return rows
  },
})

// ------------------------------------------------------------ schedule table

function printSchedule(schedule, skippedArms) {
  const ms = (v) => (v >= 3600_000 ? `${(v / 3600_000).toFixed(1)}h` : `${Math.round(v / 60_000)}m`)
  const line = (c) => process.stdout.write(`# ${c.join("  ")}\n`)
  process.stdout.write("# idle-live dry run: preflight only, paidRequestsIssued=0\n")
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

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    process.stderr.write(`${USAGE}\n`)
    return finish(refusal([parsed.error], { arg: parsed.arg ?? null }), EXIT.PREFLIGHT)
  }
  const opts = parsed.opts
  if (opts.help) {
    process.stderr.write(`${USAGE}\n`)
    return finish(refusal(["help"]), EXIT.PREFLIGHT)
  }
  if (!opts.approval) {
    process.stderr.write(`${USAGE}\n`)
    return finish(refusal(["no_approval"]), EXIT.PREFLIGHT)
  }

  // 1. approval: parsed, signed, current, and bound to the planner + proposal bytes.
  let approvalText
  try {
    approvalText = readText(opts.approval)
  } catch (e) {
    return finish(refusal(["approval_unreadable"], { detail: String(e.code ?? e.message) }), EXIT.PREFLIGHT)
  }
  let approvalJson = null
  try {
    approvalJson = JSON.parse(approvalText)
  } catch {
    return finish(refusal(["approval_not_json"]), EXIT.PREFLIGHT)
  }
  const plannerSource = readText(PLANNER)
  const proposalJson = readText(PROPOSAL)
  const check = loadApproval(approvalJson, { now: Date.now(), plannerSource, proposalJson })
  if (!check.ok) return finish(refusal(check.issues, { approvalPath: opts.approval }), EXIT.PREFLIGHT)
  const approval = check.approval
  const shas = { plannerSha256: sha256(plannerSource), proposalSha256: sha256(proposalJson) }

  const capabilities = { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model: approval.target.modelId }

  // 2. dry run: preflight on fake deps. Nothing is created, nothing is spawned, nothing is paid.
  if (opts.dryRun) {
    const deps = fakeDeps(capabilities)
    const summary = await runMachine(deps, approval, {
      runId: "dry-run",
      evidenceDir: null,
      dryRun: true,
      only: opts.only,
      ...shas,
    })
    if (summary.exitCode === EXIT.OK) printSchedule(summary.schedule, summary.experiments && deps.ledger.fold().events.find((e) => e.ev === "preflight")?.skippedArms)
    return finish({ ...summary, evidenceDirCreated: false }, summary.exitCode)
  }

  if (!opts.evidence) return finish(refusal(["no_evidence_dir"]), EXIT.PREFLIGHT)

  // 3. live run (or --smoke): evidence directory, proxy, adapter, ledger.
  const runId = opts.resume ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
  const evidenceDir = path.resolve(opts.evidence, runId)
  fs.mkdirSync(evidenceDir, { recursive: true })
  const manifestPath = path.join(evidenceDir, "run.json")
  if (opts.resume) {
    // The recorded manifest must still describe THIS approval (Appendix B "Checkpoint / resume").
    let recorded = null
    try {
      recorded = JSON.parse(readText(manifestPath))
    } catch {
      return finish(refusal(["resume_manifest_missing"], { evidenceDir }), EXIT.PREFLIGHT)
    }
    if (recorded.approval?.sha256 !== sha256(approvalText) || recorded.approval?.plannerSha256 !== shas.plannerSha256) {
      return finish(refusal(["resume_approval_drift"], { evidenceDir }), EXIT.PREFLIGHT)
    }
    if (!opts.port && Number.isInteger(recorded.proxyPort)) opts.port = recorded.proxyPort
  }

  const logPath = path.join(evidenceDir, "proxy.jsonl")
  const labelFile = path.join(evidenceDir, "label.txt")
  let proxy
  try {
    proxy = await startProxy({ port: opts.port, logPath, runId, labelFile })
  } catch (e) {
    // EADDRINUSE: another runner may own this port. It is only ours if it answers with our runId.
    if (e.code !== "EADDRINUSE") throw e
    const health = await fetch(`http://127.0.0.1:${opts.port}/__health`).then((r) => r.json()).catch(() => null)
    const code = health?.runId === runId ? EXIT.IN_DOUBT : EXIT.IN_DOUBT
    return finish({ ...refusal(["proxy_port_in_use"], { evidenceDir, health }), exitCode: code, resumable: true }, code)
  }

  const ledger = openLedger(evidenceDir)
  const adapter = createClaudeCliAdapter({ cli: DEFAULT_CLI, model: approval.target.modelId, spawn, workDir: evidenceDir, labelFile })
  const controller = new AbortController()
  const onSignal = () => controller.abort()
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

  const deps = {
    clock: realClock,
    adapter,
    proxy,
    proxyLog: proxyLogReader(logPath),
    ledger,
    processes: { conflicting: () => conflicting() },
    random: { uuid: () => crypto.randomUUID(), seed: () => crypto.randomInt(1, 2 ** 31 - 1) },
    log: (line) => process.stderr.write(`${line}\n`),
  }

  let summary
  try {
    summary = await runMachine(deps, approval, {
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
  return finish(summary, summary.exitCode)
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("idle-live-runner.mjs")) {
  main().catch((e) => {
    out({ ...refusal(["runner_crashed"], { detail: String(e?.message ?? e) }), exitCode: EXIT.IN_DOUBT, resumable: true })
    process.exitCode = EXIT.IN_DOUBT
  })
}
