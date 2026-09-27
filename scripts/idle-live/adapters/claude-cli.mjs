// RequestAdapter over the claude CLI (`claude.exe -p ...`), flags/env per
// quota-test/2026-09-19/run.mjs trial(). `spawn` is injected so tests never start the
// real binary. The prompt goes in via stdin; the label file is written before spawn as
// the proxy's fallback when the CLI drops ANTHROPIC_CUSTOM_HEADERS.
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const STDERR_HEAD = 2000
const STDOUT_HEAD = 2000

const fail = (code, message) => Object.assign(new Error(message), { code })

// Set on every spawn of the CLI, the paid calls and the --version probe alike.
const QUIET_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
})

export const CLI_PROBE_TIMEOUT_MS = 10_000
const VERSION_LINE = /^(\d+\.\d+\.\d+\S*)(?: \(Claude Code\))?$/
const realTimer = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) }

/**
 * probeCliVersion({ cli, spawn, baseEnv, timer }) -> version string, e.g. "2.1.278".
 * Runs `<cli> --version` (no shell, no API call) with the same quiet env as a paid call, bounded by
 * CLI_PROBE_TIMEOUT_MS. Rejects with code spawn_failed | exit_nonzero | timeout |
 * version_unparseable; the output must be exactly one version line, optionally " (Claude Code)".
 */
export function probeCliVersion({ cli, spawn, baseEnv = process.env, timer = realTimer }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let handle = null
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      if (handle !== null) timer.clear(handle)
      fn(value)
    }
    let child
    try {
      child = spawn(cli, ["--version"], { env: { ...baseEnv, ...QUIET_ENV }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (e) {
      return settle(reject, fail("spawn_failed", `spawn failed: ${e?.message ?? e}`))
    }
    let out = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", () => {})
    handle = timer.set(() => {
      child.kill("SIGTERM")
      settle(reject, fail("timeout", `${cli} --version did not exit within ${CLI_PROBE_TIMEOUT_MS} ms`))
    }, CLI_PROBE_TIMEOUT_MS)
    child.on("error", (e) => settle(reject, fail("spawn_failed", `spawn failed: ${e.message}`)))
    child.on("close", (code, sig) => {
      if (code !== 0) return settle(reject, fail("exit_nonzero", `${cli} --version exited ${code ?? sig}`))
      const m = VERSION_LINE.exec(out.trim())
      if (!m) return settle(reject, fail("version_unparseable", `unexpected --version output: ${JSON.stringify(out.slice(0, 200))}`))
      settle(resolve, m[1])
    })
  })
}

// The system prompt file flag the task-20 capture (claude.exe 2.1.278) showed puts the file's bytes at
// the end of system[2], under its 1h breakpoint. P is ~204 KB: Windows argv (32,767 chars) cannot carry
// it as --append-system-prompt text (spawn ENAMETOOLONG).
export const SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file"
const SAFE_NAME = /^[A-Za-z0-9._-]+$/
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

/**
 * prepareSystemPrompt(ref, contextDir) -> absolute path of the verified file, or throws before any
 * spawn: system_prompt_missing | system_prompt_mismatch | bad_system_prompt. A ref that carries
 * `text` (the context write) creates the file once - UTF-8, no BOM - and never overwrites a file of
 * that name holding other bytes. Every call re-reads the file and checks its sha256.
 */
export function prepareSystemPrompt(ref, contextDir) {
  if (!contextDir || typeof ref?.file !== "string" || !SAFE_NAME.test(ref.file) || typeof ref.sha256 !== "string") {
    throw fail("bad_system_prompt", "system prompt file reference or context dir is invalid")
  }
  const file = path.join(contextDir, ref.file)
  if (typeof ref.text === "string") {
    const bytes = Buffer.from(ref.text, "utf8")
    if (sha256(bytes) !== ref.sha256) throw fail("system_prompt_mismatch", `${ref.file}: text does not hash to the recorded sha256`)
    fs.mkdirSync(contextDir, { recursive: true })
    try {
      fs.writeFileSync(file, bytes, { flag: "wx" })
    } catch (e) {
      if (e.code !== "EEXIST") throw e
    }
  }
  let onDisk
  try {
    onDisk = fs.readFileSync(file)
  } catch (e) {
    if (e.code === "ENOENT") throw fail("system_prompt_missing", `${ref.file} is missing`)
    throw e
  }
  if (sha256(onDisk) !== ref.sha256) throw fail("system_prompt_mismatch", `${ref.file} does not hash to the recorded sha256`)
  return file
}

/** cliArgs({ model, session, systemPromptPath }) -> the argv of one call (no shell, prompt via stdin). */
export function cliArgs({ model, session, systemPromptPath = null }) {
  return ["-p", "--model", model, "--output-format", "json", "--safe-mode", "--strict-mcp-config",
    "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk", "--effort", "low", "--max-turns", "1",
    "--fallback-model", model, ...(systemPromptPath ? [SYSTEM_PROMPT_FILE_FLAG, systemPromptPath] : []), ...sessionArgs(session)]
}

function sessionArgs({ id, mode }) {
  if (mode === "resume") { if (!id) throw fail("bad_session_mode", "resume requires a session id"); return ["--resume", id] }
  if (mode === "new") { if (!id) throw fail("bad_session_mode", "new requires a session id"); return ["--session-id", id] }
  if (mode === "ephemeral") return ["--no-session-persistence"]
  throw fail("bad_session_mode", `unknown session mode: ${mode}`)
}

export function createClaudeCliAdapter({ cli, model, spawn, workDir, labelFile, contextDir = null, baseEnv = process.env }) {
  const capabilities = { ttlLanes: ["1h"], resume: true, maxOutputTokens: null, model }

  async function invoke(step, { stepHeader, baseUrl }, signal) {
    sessionArgs(step.session)
    if (signal?.aborted) throw fail("aborted", "aborted before spawn")
    // the P file is verified (and, for the context write, created) before anything is spawned
    const systemPromptPath = step.systemPrompt ? prepareSystemPrompt(step.systemPrompt, contextDir) : null
    const args = cliArgs({ model, session: step.session, systemPromptPath })
    const env = {
      ...baseEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: `x-idle-step: ${stepHeader}`,
      MAX_THINKING_TOKENS: "0",
      ...QUIET_ENV,
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
