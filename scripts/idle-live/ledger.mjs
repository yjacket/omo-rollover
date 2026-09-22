// Evidence-directory ledger. events.jsonl is append-only with fsync per append and is
// the only checkpoint truth; fold() ignores a torn last line. Also writes
// requests.jsonl, cli/<stepId>.json and summary.json.
import fs from "node:fs"
import path from "node:path"

const EVENTS = "events.jsonl"
const REQUESTS = "requests.jsonl"
const SUMMARY = "summary.json"

// Parse a JSONL file; a torn (non-JSON) final line is reported, not thrown.
function readJsonl(file) {
  let text
  try { text = fs.readFileSync(file, "utf8") } catch (e) {
    if (e.code === "ENOENT") return { rows: [], torn: false, goodBytes: 0 }
    throw e
  }
  const lines = text.split("\n")
  const rows = []
  let torn = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === "") continue
    try { rows.push(JSON.parse(line)) } catch (e) {
      if (i === lines.length - 1) { torn = true; break }
      throw new Error(`corrupt line ${i + 1} in ${file}: ${e.message}`)
    }
  }
  // byte length of the intact prefix (everything up to and including the last newline)
  const goodBytes = torn ? Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)) : Buffer.byteLength(text)
  return { rows, torn, goodBytes }
}

function appendSynced(file, line) {
  const fd = fs.openSync(file, "a")
  try {
    fs.writeSync(fd, line)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export const sanitizeStepId = (stepId) => String(stepId).replace(/[^A-Za-z0-9._-]/g, "_")

export function openLedger(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const eventsFile = path.join(dir, EVENTS)
  const requestsFile = path.join(dir, REQUESTS)
  const cliDir = path.join(dir, "cli")

  const fold = () => {
    const { rows, torn } = readJsonl(eventsFile)
    return { events: rows, torn, lastSeq: rows.length ? rows[rows.length - 1].seq : -1 }
  }
  const nextSeq = () => {
    const { rows, torn, goodBytes } = readJsonl(eventsFile)
    // a torn tail is the remains of a crashed append: drop it so the file stays clean JSONL
    if (torn) fs.truncateSync(eventsFile, goodBytes)
    return rows.length ? rows[rows.length - 1].seq + 1 : 0
  }
  const cliPath = (stepId) => path.join(cliDir, sanitizeStepId(stepId) + ".json")

  return {
    dir,
    append(event) {
      const rec = { seq: nextSeq(), ts: new Date().toISOString(), ...event }
      appendSynced(eventsFile, JSON.stringify(rec) + "\n")
      return rec
    },
    fold,
    tail(n) {
      const { events } = fold()
      return events.slice(Math.max(0, events.length - n))
    },
    writeRequestRecord(record) {
      appendSynced(requestsFile, JSON.stringify(record) + "\n")
    },
    readRequests() {
      return readJsonl(requestsFile).rows
    },
    writeCli(stepId, obj) {
      fs.mkdirSync(cliDir, { recursive: true })
      const file = cliPath(stepId)
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n")
      return file
    },
    readCli(stepId) {
      return JSON.parse(fs.readFileSync(cliPath(stepId), "utf8"))
    },
    writeSummary(summary) {
      fs.writeFileSync(path.join(dir, SUMMARY), JSON.stringify(summary, null, 2) + "\n")
    },
    readSummary() {
      return JSON.parse(fs.readFileSync(path.join(dir, SUMMARY), "utf8"))
    },
  }
}
