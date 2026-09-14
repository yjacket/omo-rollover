// ulw-ledger-guard: shape reads of `<project>/.omo/ulw-execute/ledger.jsonl` so an
// orchestrator that "re-reads the ledger FIRST" gets a ~12 KB digest (latest event per
// task + raw tail) instead of the whole append-only file (field: 224 events / 315 KB, read 63× in one session).
//
//   tool_result(read, path ends with .omo/ulw-execute/ledger.jsonl)   → digest built from the file on disk
//   tool_result(bash|eval, command mentions ledger.jsonl, result > 8 KB) → tail of the output only
//
// The file itself is never touched. Logs `ledger_read_shaped` to ~/.omo/rollover/sessions/<sid>.jsonl,
// persists `ledgerGuard` mode in ~/.omo/rollover/state/<sid>.json next to rollover's fields.
// Standalone file: the child-session check and the JSONL/atomic-write helpers are duplicated from
// rollover.ts on purpose — install copies single files into ~/.omo/agent/extensions/ with no shared module.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { homedir } from "node:os"

export const DIGEST_CAP = 12 * 1024
export const BASH_CAP = 8 * 1024
export const RAW_TAIL = 20
export const MAX_TASKS = 40
const LEDGER_RE = /(^|\/)\.omo\/ulw-execute\/ledger\.jsonl$/
const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"]

export function isChildSession(env: Record<string, string | undefined> = process.env): boolean {
  return CHILD_ENV.some((k) => (env[k] ?? "").length > 0)
}
export function rolloverDir(env: Record<string, string | undefined> = process.env): string {
  return env.OMO_ROLLOVER_DIR || join(homedir(), ".omo", "rollover")
}
function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(obj) + "\n")
}
function writeJsonAtomic(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, file)
}

export function isLedgerPath(p: unknown): boolean {
  return LEDGER_RE.test(String(p ?? "").replace(/\\/g, "/"))
}

const oneLine = (v: unknown, max = 120): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Digest of ledger text: header, latest event per task, raw tail. Malformed lines are counted. */
export function digestLedger(text: string, file: string): { digest: string; events: number; malformed: number } {
  const lines = text.split("\n").filter((l) => l.trim())
  type Row = { n: number; key: string; ev: any }
  const latest = new Map<string, Row>()
  let malformed = 0
  lines.forEach((l, i) => {
    let ev: any
    try { ev = JSON.parse(l) } catch { malformed++; return }
    if (!ev || typeof ev !== "object") { malformed++; return }
    const key = ev.task != null ? `task:${ev.task}` : `event:${ev.event}`
    latest.delete(key) // re-insert so Map order = last activity
    latest.set(key, { n: i + 1, key, ev })
  })
  const rows = [...latest.values()].reverse().slice(0, MAX_TASKS)
  const fmt = ({ n, key, ev }: Row) => {
    const when = ev.t ?? ev.timestamp ?? ev.ts ?? `#${n}`
    const sid = String(ev.session_id ?? ev.session ?? "").slice(-8)
    const extras: string[] = []
    for (const k of ["verdict", "status", "result", "state"]) if (ev[k] != null) extras.push(`${k}=${oneLine(ev[k])}`)
    for (const [k, v] of Object.entries(ev)) if (v && typeof v === "object" && !Array.isArray(v) && (v as any).verdict != null) extras.push(`${k}.verdict=${oneLine((v as any).verdict, 60)}`)
    return `${when}  ${ev.event ?? "?"}  ${key}${sid ? `  session=…${sid}` : ""}${extras.length ? "  " + extras.join(" ") : ""}`
  }
  const header = `[ulw-ledger-guard] ${file}: ${lines.length} events, ${Buffer.byteLength(text)} bytes${malformed ? `, ${malformed} malformed line(s)` : ""}. Digest by ulw-ledger-guard; full history in the file, use \`tail -n N\`/\`grep\` for specifics.`
  const table = [`--- latest event per task (${rows.length} of ${latest.size}, most recent first) ---`, ...rows.map(fmt)]
  let raw = lines.slice(-RAW_TAIL)
  const build = () => [header, ...table, `--- last ${raw.length} lines (raw) ---`, ...raw].join("\n")
  let digest = build()
  while (Buffer.byteLength(digest) > DIGEST_CAP && raw.length > 3) { raw = raw.slice(1); digest = build() } // ponytail: drop oldest raw lines; huge single lines get a hard slice below
  if (Buffer.byteLength(digest) > DIGEST_CAP) digest = digest.slice(0, DIGEST_CAP) + "\n…[truncated by ulw-ledger-guard]"
  return { digest, events: lines.length, malformed }
}

/** Keep only the last ~cap bytes of command output, cut at a line boundary. */
export function tailText(text: string, cap = BASH_CAP): string {
  const tail = text.slice(-cap)
  const nl = tail.indexOf("\n")
  return `[ulw-ledger-guard] output was ${Buffer.byteLength(text)} bytes; showing the tail only. Use \`tail -n N\`/\`grep\` for specifics.\n` + (nl >= 0 ? tail.slice(nl + 1) : tail)
}

const contentText = (content: any): string => (Array.isArray(content) ? content : []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")

export type Deps = { env?: Record<string, string | undefined>; now?: () => Date }

export function createLedgerGuard(pi: any, deps: Deps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  if (isChildSession(env)) return null
  const dir = rolloverDir(env)
  const st = { mode: "on" as "on" | "off", shaped: 0, notified: false }

  const sid = (ctx: any) => String(ctx?.sessionManager?.getSessionId?.() ?? "unknown")
  const cwdOf = (ctx: any) => String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd())
  const stateFile = (ctx: any) => join(dir, "state", `${sid(ctx)}.json`)
  const readState = (ctx: any): Record<string, unknown> => { try { return JSON.parse(readFileSync(stateFile(ctx), "utf8")) } catch { return {} } }
  const persist = (ctx: any) => writeJsonAtomic(stateFile(ctx), { ...readState(ctx), ledgerGuard: st.mode }) // read-modify-write: rollover owns the other keys
  const log = (ctx: any, extra: Record<string, unknown>) =>
    appendJsonl(join(dir, "sessions", `${sid(ctx)}.jsonl`), { t: now().toISOString(), session: sid(ctx), cwd: cwdOf(ctx), ev: "ledger_read_shaped", ...extra })

  function shaped(ctx: any, tool: string, path: string, bytesIn: number, text: string) {
    st.shaped++
    log(ctx, { path, bytesIn, bytesOut: Buffer.byteLength(text), tool })
    if (!st.notified) { st.notified = true; ctx.ui?.notify?.(`ledger-guard: shaping ledger.jsonl reads to a digest (/ledger-guard off to disable)`, "info") }
    return { content: [{ type: "text", text }] }
  }

  pi.on("session_start", async (_ev: any, ctx: any) => {
    const saved = readState(ctx).ledgerGuard
    if (saved === "on" || saved === "off") st.mode = saved
  })

  pi.on("tool_result", async (ev: any, ctx: any) => {
    if (st.mode === "off" || ev?.isError) return
    const tool = String(ev?.toolName ?? "")
    if (tool === "read") {
      const p = String(ev.input?.path ?? "")
      if (!isLedgerPath(p)) return
      const file = isAbsolute(p) ? p : join(cwdOf(ctx), p)
      let text: string
      try { text = readFileSync(file, "utf8") } catch { return } // not readable by us: leave the tool's own result alone
      const bytesIn = Buffer.byteLength(contentText(ev.content))
      return shaped(ctx, tool, file, bytesIn, digestLedger(text, file).digest)
    }
    if (tool === "bash" || tool === "eval" || tool === "powershell") {
      const cmd = String(ev.input?.command ?? ev.input?.code ?? "")
      if (!cmd.includes("ledger.jsonl")) return
      const out = contentText(ev.content)
      if (Buffer.byteLength(out) <= BASH_CAP) return
      return shaped(ctx, tool, cmd.slice(0, 200), Buffer.byteLength(out), tailText(out))
    }
  })

  pi.registerCommand("ledger-guard", {
    description: "ledger-guard on|off|status — shape reads of .omo/ulw-execute/ledger.jsonl into a digest",
    handler: async (args: string, ctx: any) => {
      const a = (args ?? "").trim()
      if (a === "on" || a === "off") { st.mode = a; persist(ctx); ctx.ui.notify(`ledger-guard: ${a}`, "info"); return }
      ctx.ui.notify(`ledger-guard: mode=${st.mode} shaped=${st.shaped}`, "info")
    },
  })

  return { st }
}

export default function (pi: any): void {
  createLedgerGuard(pi)
}
