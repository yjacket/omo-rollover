// Passthrough proxy 127.0.0.1:<port> -> upstream (default https://api.anthropic.com).
// Adapted from quota-test/2026-09-19/proxy.mjs. Logs one JSONL line per response to
// `logPath` with the 09-19 raw.jsonl fields (ts, ts_req, label, method, path, status,
// model, usage, stop_reason, error, msg_id, body_bytes, headers) plus `stepId`
// (request header x-idle-step) and `runId`. `label` = stepId when present, else the
// contents of `labelFile`. Never logs Authorization, cookies, or bodies.
// GET /__health -> { runId, logPath }.
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"

const DEFAULT_UPSTREAM = { host: "api.anthropic.com", port: 443, protocol: "https" }

function mergeUsage(base, delta) {
  if (!delta) return base
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(delta)) {
    if (v === null || v === undefined) continue
    if (typeof v === "object") out[k] = { ...(out[k] || {}), ...v }
    else out[k] = v // later value wins (message_delta carries cumulative output_tokens)
  }
  return out
}

export function parseBody(contentType, text) {
  let model = null, usage = null, stop_reason = null, error = null, msg_id = null
  if ((contentType || "").includes("text/event-stream")) {
    let sawStop = false
    let torn = false
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      let ev
      try { ev = JSON.parse(line.slice(5).trim()) } catch { torn = true; continue }
      if (ev.type === "message_start" && ev.message) {
        model = ev.message.model ?? model
        msg_id = ev.message.id ?? msg_id
        usage = mergeUsage(usage, ev.message.usage)
      } else if (ev.type === "message_delta") {
        usage = mergeUsage(usage, ev.usage)
        stop_reason = ev.delta?.stop_reason ?? stop_reason
      } else if (ev.type === "message_stop") {
        sawStop = true
      } else if (ev.type === "error") {
        error = ev.error?.type ?? "error"
      }
    }
    if (error === null && (torn || !sawStop)) error = "truncated_stream"
  } else {
    try {
      const j = JSON.parse(text)
      model = j.model ?? null
      usage = j.usage ?? null
      stop_reason = j.stop_reason ?? null
      msg_id = j.id ?? null
      if (j.type === "error") error = j.error?.type ?? "error"
    } catch {
      error = "unparseable_body"
    }
  }
  if (error === null && usage === null) error = "missing_usage"
  return { model, usage, stop_reason, error, msg_id }
}

function pickRatelimitHeaders(h) {
  const rl = {}
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith("anthropic-ratelimit") || k === "retry-after" || k === "request-id" || k === "x-should-retry") rl[k] = v
  }
  return rl
}

export async function startProxy({ port, logPath, runId, labelFile, upstream = DEFAULT_UPSTREAM }) {
  const up = { ...DEFAULT_UPSTREAM, ...upstream }
  const transport = up.protocol === "https" ? https : http
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const log = fs.openSync(logPath, "a")
  const records = []

  const readLabelFile = () => {
    if (!labelFile) return ""
    try { return fs.readFileSync(labelFile, "utf8").trim() } catch { return "" }
  }
  const write = (rec) => {
    records.push(rec)
    fs.writeSync(log, JSON.stringify(rec) + "\n")
    fs.fsyncSync(log)
  }

  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0]
    if (req.method === "GET" && pathname === "/__health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ runId, logPath }))
      return
    }
    const ts_req = new Date().toISOString()
    const stepHeader = req.headers["x-idle-step"]
    const stepId = typeof stepHeader === "string" && stepHeader !== "" ? stepHeader : null
    const base = () => ({ ts: new Date().toISOString(), ts_req, label: stepId ?? readLabelFile(), stepId, runId, method: req.method, path: pathname })

    const headers = { ...req.headers, host: up.host, "accept-encoding": "identity" }
    delete headers["connection"]
    const upReq = transport.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers }, (ur) => {
      const rl = pickRatelimitHeaders(ur.headers)
      const resHeaders = { ...ur.headers }
      delete resHeaders["content-encoding"]
      delete resHeaders["content-length"] // identity + chunked passthrough
      delete resHeaders["transfer-encoding"]
      res.writeHead(ur.statusCode, resHeaders)
      const chunks = []
      ur.on("data", (c) => { chunks.push(c); res.write(c) })
      ur.on("end", () => {
        res.end()
        const text = Buffer.concat(chunks).toString("utf8")
        const parsed = parseBody(ur.headers["content-type"], text)
        write({
          ...base(), status: ur.statusCode, model: parsed.model, usage: parsed.usage, stop_reason: parsed.stop_reason,
          error: parsed.error, msg_id: parsed.msg_id, body_bytes: text.length, headers: rl,
        })
      })
      ur.on("error", (e) => {
        try { res.end() } catch { /* client gone */ }
        write({ ...base(), status: ur.statusCode, model: null, usage: null, stop_reason: null, error: "upstream_stream_error:" + String(e), msg_id: null, body_bytes: null, headers: rl })
      })
    })
    upReq.on("error", (e) => {
      write({ ...base(), status: null, model: null, usage: null, stop_reason: null, error: "upstream_error:" + String(e), msg_id: null, body_bytes: null, headers: {} })
      if (!res.headersSent) res.writeHead(502)
      res.end("proxy upstream error")
    })
    req.pipe(upReq)
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })

  return {
    port: server.address().port,
    logPath,
    runId,
    async drainSince(cursor = 0) {
      return { records: records.slice(cursor), cursor: records.length }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.closeSync(log)
    },
  }
}
