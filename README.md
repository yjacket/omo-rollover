# omo-rollover

Senpi/OMO extension that hands a long-running main session off to a fresh
session once its context passes a token budget, plus a JSONL event log and a
static trend dashboard. `docs/microworld.html` is the reference visualization of
the intended behavior.

## What it does

```
watching ──context ≥ budget, or reread ratio ≥ max for 3 messages──▶ armed
armed    ──(turn_end | agent_settled) ∧ Σ wake_source_state == 0 ∧ !hasPendingMessages──▶ handoff_requested
handoff_requested ──agent_settled ∧ <successor> in last assistant reply──▶ rollover
```

- **armed**: goal paused (best effort), `task_create` blocked via `tool_call`
  with an error explaining the pending handoff. Running children drain naturally.
- **handoff_requested**: reached at the first `turn_end` with wake sum 0 (the
  instruction is steer-delivered, so it lands before the next turn of a long
  single-agent run), or at `agent_settled` once children drain. One guard, so
  it is injected exactly once. One user message is injected: finish nothing new, write
  `<cwd>/.omo/rollover/handoff-<sessionId>.md` (goal, done, in-progress, next
  step, key files, constraints), end the reply with the successor's first prompt
  in `<successor>...</successor>`. Missing tag → asked once more → then
  `ctx.ui.notify` and back to armed.
- **rollover**: dispatches `/rollover`, whose handler calls
  `ctx.newSession({parentSession, withSession})` and sends the successor prompt
  in the new session.

Inert (no logging, no arming) in omo-task child sessions, detected by env
`OMO_SENPI_TASK_RPC_CHILD` (set for every spawned child) or `SENPI_TASK_MEMBER*`.

### Signals used

| signal | use |
|---|---|
| `message_end` (`message.usage`) | context = `ctx.getContextUsage().tokens`, falling back to `input + cacheRead + cacheWrite` when tokens is null (right after compaction) |
| `pi.events "wake_source_state"` | latest `activeCount` per source (`senpi-task`, `omo-dag`, senpi builtins); sum 0 = nothing can wake the parked main. No event yet = unknown, not zero |
| `turn_end` | after each LLM response + its tool calls; while armed and wake sum is 0, requests the handoff mid-run via `sendUserMessage(..., {deliverAs: "steer"})` |
| `agent_settled` | true idle; ANDed with the wake sum. Lands the handoff when children were still running at turn_end; also where the `<successor>` tag is extracted |
| `tool_call` | blocks `task_create` while not watching |

## Install

```powershell
.\install.ps1        # Windows
```
```sh
sh install.sh        # Git Bash / *nix
```

Copies `extension/rollover.ts` to `~/.omo/agent/extensions/rollover.ts`. Then
`/reload` in a running session (or restart). Commands:

- `/rollover status` – state, context, wake sum, blocked count
- `/rollover on|off` – override auto-detect
- `/rollover` – hand off now (needs a `<successor>` block in the last reply)

## Config

`~/.omo/rollover/config.json` (read at load):

```json
{ "budgetTokens": 150000, "rereadRatioMax": 150 }
```

`rereadRatioMax` compares `cacheRead / output` of each assistant message; three
consecutive messages over it arm the handoff even below the budget.
`OMO_ROLLOVER_DIR` overrides the data directory (used by the tests).

## Event log

`~/.omo/rollover/sessions/<sessionId>.jsonl`, one object per line:
`{t, session, cwd, ev, ...}` with `ev` ∈ `session_start{parent?}`,
`message_end{input,output,cacheRead,cacheWrite,context}`,
`wake_source_state{source,activeCount,total}`, `turn_end{total}` (only while
armed), `agent_settled{total}`, `armed{reason,context}`, `tool_call_blocked{tool}`,
`handoff_requested{at: "turn_end" | "agent_settled", context}`,
`successor_found|successor_missing`, `state_restored{state}`, `rollover{newSession,parentSession}`.
`~/.omo/rollover/summary.jsonl` gets one line per rollover and session shutdown
(peak context, messages, cacheRead/output ratio, blocked, rollovers).

## State persistence

The state machine is written to `~/.omo/rollover/state/<sessionId>.json` on
every transition (arm, handoff request, successor found, re-ask, blocked
spawn, `/rollover on|off`, rollover), atomically (tmp + rename). Fields:
`state, mode, blocked, rereadStreak, goalPaused, rollovers, armedAt,
handoffAskedCount, updatedAt`. Context is not stored; it is recomputed from
the next `message_end`. `session_start` (any reason) restores the file for
its session id and logs `state_restored{state}`. If the restored state is
`handoff_requested` (or `rollover`), the current branch is checked for a
`<successor>` right away and `/rollover` is dispatched, so a `/reload` that
lands between the model's reply and `agent_settled` still completes the
handoff. After a rollover the old session's file is kept with
`state: "rolled_over"`; resuming that session starts fresh, and the successor
has its own id.

## Dashboard

```sh
node dashboard/build.mjs            # reads ~/.omo/rollover (or $OMO_ROLLOVER_DIR, or a dir argument)
node dashboard/build.mjs --sample   # synthetic data from dashboard/sample/
```

Writes `dashboard/out/index.html` with the data embedded (open the file, no
server). Per-session-chain timeline (context area + budget line, main turns,
handoff turns, blocked markers, armed/rollover markers, wake-source lane,
session boundaries) and a trend table. Light and dark themes; only external
asset is Google Fonts. Regenerate the sample with
`node dashboard/sample/generate.mjs`.

## Tests

```sh
node --test
```

Node ≥ 22.6 (24 used here): tests are `.mjs` and import `extension/rollover.ts`
directly through Node's built-in type stripping. A fake `pi`/`ctx` drives the
state machine; no senpi and no LLM calls.

## Limits

- Never run against a paid live session. Verified only against senpi's
  `types.d.ts` / `docs/extensions.md` (2026.9.x) and the fake harness.
- Goal pause imports `dist/core/extensions/builtin/goal/store.js` by resolving
  `@code-yeongyu/senpi` from the extension's own module scope. If that fails
  (different loader, version, or path) the handoff prompt instead tells the model
  to call `update_goal` with status `paused`.
- The wake-source sum trusts the shared bus. Until at least one source has
  emitted, the sum is unknown (not zero) and an armed session will not land.
  omo-task emits `senpi-task` on session start, so in practice this resolves at
  startup; if it never does, `/rollover` still works manually.
- Previously a `/reload` (same session id, new extension instance) reset the
  state to `watching`, losing an armed or pending handoff; state persistence
  above resolves this. `session_shutdown` with reason `reload` still skips the
  summary line.
- `/rollover` relies on `pi.sendUserMessage("/rollover", {expandPromptTemplates: true})`
  dispatching a registered extension command.
- The `turn_end` landing depends on senpi honoring `deliverAs: "steer"` while
  the agent is streaming. If steer delivery is deferred, the handoff still
  arrives before the next model call at the latest; `agent_settled` remains
  the fallback when children are running. A single turn that itself runs very
  long (one huge tool call) is not interrupted.
