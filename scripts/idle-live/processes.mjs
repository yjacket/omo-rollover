// Lists other claude.exe processes (Windows tasklist CSV). `exec` is injected:
// `exec(cmd) -> Promise<{ stdout, stderr }>`; the default uses child_process.
import { exec as cpExec } from "node:child_process"
import { promisify } from "node:util"

const IMAGE = "claude.exe"
export const TASKLIST_CMD = `tasklist /FI "IMAGENAME eq ${IMAGE}" /FO CSV`

const defaultExec = promisify(cpExec)

// Parse one CSV line of double-quoted fields (tasklist never emits embedded quotes).
const csvFields = (line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1])

export function parseTasklistCsv(stdout) {
  const rows = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('"')) continue // INFO: No tasks ... / blank
    const f = csvFields(line)
    if (f[0] === "Image Name") continue // header
    const pid = Number(f[1])
    if (!Number.isInteger(pid)) continue
    rows.push({ image: f[0], pid })
  }
  return rows
}

export async function conflicting({ exec = defaultExec } = {}) {
  const { stdout } = await exec(TASKLIST_CMD)
  return parseTasklistCsv(stdout)
}
