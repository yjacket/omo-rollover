// RequestAdapter over the claude CLI (`claude.exe -p ...`), flags/env per
// quota-test/2026-09-19/run.mjs trial(). `spawn` is injected so tests never start the
// real binary. The prompt goes in via stdin; the label file is written before spawn as
// the proxy's fallback when the CLI drops ANTHROPIC_CUSTOM_HEADERS.
import fs from "node:fs"
import path from "node:path"

const STDERR_HEAD = 2000
const STDOUT_HEAD = 2000

const fail = (code, message) => Object.assign(new Error(message), { code })

export function createClaudeCliAdapter({ cli, model, spawn, workDir, labelFile, baseEnv = process.env }) {
  const capabilities = { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model }

  const sessionArgs = ({ id, mode }) => {
    if (mode === "resume") { if (!id) throw fail("bad_session_mode", "resume requires a session id"); return ["--resume", id] }
    if (mode === "new") { if (!id) throw fail("bad_session_mode", "new requires a session id"); return ["--session-id", id] }
    if (mode === "ephemeral") return ["--no-session-persistence"]
    throw fail("bad_session_mode", `unknown session mode: ${mode}`)
  }

  async function invoke(step, { stepHeader, baseUrl }, signal) {
    const tail = sessionArgs(step.session)
    if (signal?.aborted) throw fail("aborted", "aborted before spawn")
    const args = ["-p", "--model", model, "--output-format", "json", "--safe-mode", "--strict-mcp-config",
      "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk", "--effort", "low", "--max-turns", "1",
      "--fallback-model", model, ...tail]
    const env = {
      ...baseEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: `x-idle-step: ${stepHeader}`,
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    }
    if (labelFile) {
      fs.mkdirSync(path.dirname(labelFile), { recursive: true })
      fs.writeFileSync(labelFile, stepHeader)
    }

    const startedMs = Date.now()
    const child = spawn(cli, args, { cwd: workDir, env, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { err += d })

    const result = await new Promise((resolve, reject) => {
      let aborted = false
      let spawnFailed = null
      const onAbort = () => { aborted = true; child.kill("SIGTERM") }
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      signal?.addEventListener("abort", onAbort, { once: true })
      child.on("error", (e) => { cleanup(); spawnFailed = e; child.kill("SIGTERM") })
      child.on("close", (code, sig) => {
        cleanup()
        if (spawnFailed) reject(fail("spawn_failed", `spawn failed: ${spawnFailed.message}`))
        else if (aborted) resolve({ code, sig, aborted: true })
        else resolve({ code, sig })
      })
      child.stdin.on("error", () => { /* child exited before consuming stdin; close reports it */ })
      child.stdin.end(step.prompt.text)
    })
    const endedMs = Date.now()
    let stdoutJson = null
    try { stdoutJson = JSON.parse(out) } catch { /* reported via stdoutHead */ }
    
    let error = null
    if (result.aborted) {
      error = { code: "aborted", message: `claude killed on abort (signal ${result.sig})` }
    } else if (result.code !== 0) {
      error = { code: "nonzero_exit", message: `exit code ${result.code}` }
    } else if (stdoutJson === null) {
      error = { code: "stdout_not_json", message: "stdout is not valid JSON" }
    }
    
    return {
      exitCode: result.code,
      signal: result.sig,
      stdoutJson,
      stdoutHead: stdoutJson === null ? out.slice(0, STDOUT_HEAD) : null,
      stderrHead: err.slice(0, STDERR_HEAD),
      startedMs,
      endedMs,
      error,
    }
  }

  return { capabilities, invoke }
}
