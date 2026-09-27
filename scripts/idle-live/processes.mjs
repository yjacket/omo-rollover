// The preflight needs command lines: tasklist CSV cannot identify idle bun-hosted omo sessions.
// Keep the OS boundary injected; a failed scan must make the preflight refuse to run.
import { exec as cpExec } from "node:child_process"
import { promisify } from "node:util"

export const PROCESS_CMD = "powershell.exe -NoProfile -NonInteractive -Command \"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|bun|node)\\.exe$' } | Select-Object Name,ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress -Depth 3\""
const defaultExec = promisify(cpExec)

export function parseProcesses(stdout) {
  if (!stdout.trim()) return []
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ""))
  if (!Array.isArray(parsed) && (typeof parsed !== "object" || parsed === null)) throw new Error("invalid process listing")
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    image: String(p.Name ?? "").toLowerCase(), pid: Number(p.ProcessId),
    parentPid: Number(p.ParentProcessId), commandLine: p.CommandLine ?? "",
  }))
}

export function processConflicts(rows, selfPid = process.pid) {
  const excluded = new Set([selfPid])
  // Ignore only this runner's children, never its ancestors (the host omo is a conflict).
  let changed
  do {
    changed = false
    for (const row of rows) if (excluded.has(row.parentPid) && !excluded.has(row.pid)) {
      excluded.add(row.pid)
      changed = true
    }
  } while (changed)
  return rows.filter(({ image, pid, commandLine }) => {
    if (excluded.has(pid)) return false
    if (image === "claude.exe") return true
    if (image !== "bun.exe" && image !== "node.exe") return false
    return /(?:omo-ai[\\/]bin[\\/]omo\.js|@code-yeongyu[\\/]senpi[\\/]dist[\\/]bundle[\\/]cli\.js|omo-health[\\/](?:bin[\\/])?omo-health\.mjs)/i.test(commandLine)
  })
}

export async function conflicting({ exec = defaultExec, selfPid = process.pid } = {}) {
  const { stdout } = await exec(PROCESS_CMD)
  return processConflicts(parseProcesses(stdout), selfPid)
}
