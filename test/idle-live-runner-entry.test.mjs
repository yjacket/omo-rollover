// The runner's main-module check (plan todo 18, note 7). Importing scripts/idle-live-runner.mjs
// must never start a run: not without a script argument (`node -e`, where process.argv[1] is
// absent), and not from another script whose name happens to end like the runner's. Children are
// spawned with no arguments for the runner, so even a wrongly started main would only refuse
// (no_approval) - nothing is paid or bound.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const RUNNER_URL = new URL("../scripts/idle-live-runner.mjs", import.meta.url).href
const IMPORT = `const m = await import(${JSON.stringify(RUNNER_URL)}); process.stdout.write("imported:" + typeof m.main + "\\n")`
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000 })

test("N7 importing the runner under node -e (no argv[1]) neither throws nor runs main", () => {
  const r = node(["--input-type=module", "-e", IMPORT])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "imported:function\n", "no run summary: main did not start")
})

test("N7 importing the runner from a script whose name ends in idle-live-runner.mjs does not run main", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "idle-live-entry-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const wrapper = join(dir, "not-the-idle-live-runner.mjs")
  writeFileSync(wrapper, `${IMPORT}\n`)
  const r = node([wrapper])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "imported:function\n", "no run summary: main did not start")
})
