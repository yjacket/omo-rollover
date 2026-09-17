# omo-rollover

Senpi/OMO extension that hands a long-running main session off to a fresh
session once its context passes a token budget, plus a JSONL event log and a
static trend dashboard. `docs/microworld.html` is the reference visualization of
the intended behavior.

## What it does

```
watching ──context ≥ budget (or, opt-in, reread ratio ≥ max for 3 messages)──▶ armed
armed    ──(turn_end | agent_settled) ∧ Σ wake_source_state == 0 ∧ !hasPendingMessages──▶ handoff_requested
handoff_requested ──(agent_settled | turn_end) ∧ <successor> in last assistant reply ∧ Σ wake == 0 ∧ !hasPendingMessages──▶ rollover
```

- **armed**: goal paused (see "Goal pause" below), spawning tools blocked via `tool_call`
  with an error explaining the pending handoff. Block list is exactly `task` and
  `task_create` (omo-task exposes both names); `task_output`, `task_list`,
  `task_cancel`, `task_get`, `task_update`, `task_send` stay allowed so the main
  can still collect results. The block holds in every state except `watching`.
  Running children drain naturally.
- **handoff_requested**: reached at the first `turn_end` with wake sum 0 (the
  instruction is steer-delivered, so it lands before the next turn of a long
  single-agent run), or at `agent_settled` once children drain. One guard, so
  it is injected exactly once. One user message is injected: finish nothing new, write
  `<cwd>/.omo/rollover/handoff-<sessionId>.md` (goal, done, in-progress, next
  step, key files, constraints), end the reply with the successor's first prompt
  in `<successor>...</successor>`. Missing tag → asked once more → then
  `ctx.ui.notify` and back to armed. The instruction is deliberately strict
  (field session 01a09c07 spent 139K→234K of context on the handoff itself by
  re-reading ledger/plan files and spawning a task): write the file from what is
  already in context; do NOT read any file, run any command, or spawn any task;
  ~80 lines max; sections Goal / Done / In progress / Next step / Key files /
  Constraints; Do NOT kill any server, monitor, or background shell — list each
  under Key files as `port/PID/command` so the successor can reuse or stop it;
  `<successor>` ≤ 25 lines telling the successor to read only the
  handoff file plus `tail -n 30 .omo/ulw-execute/ledger.jsonl`, and not
  `ulw-execute/SKILL.md` or the full ledger. The extraction contract is unchanged.
- **deferred rollover**: a `<successor>` found while the wake sum is unknown or
  > 0 (or `hasPendingMessages()`) logs `rollover_deferred{total}` and stays in
  `handoff_requested` — no re-ask, the successor prompt is kept. Re-checked on
  every later `agent_settled` and `turn_end`; `/rollover` is dispatched once the
  sum reaches 0. Without this, `newSession` orphaned a child spawned during the
  handoff turn (field: task st_01a09c25 left `running` with the old parent).
- **rollover**: dispatches `/rollover`, whose handler calls
  `ctx.newSession({parentSession, withSession})` and sends the successor prompt
  in the new session. The handler itself refuses (notify + `rollover_refused{total}`)
  while the wake sum is > 0; `/rollover force` overrides. An unknown sum (no
  event yet) does not block the manual command.

Inert (no logging, no arming) in omo-task child sessions, detected by env
`OMO_SENPI_TASK_RPC_CHILD` (set for every spawned child) or `SENPI_TASK_MEMBER*`.

### Signals used

| signal | use |
|---|---|
| `message_end` (`message.usage`) | context = `ctx.getContextUsage().tokens`, falling back to `input + cacheRead + cacheWrite` when tokens is null (right after compaction) |
| `pi.events "wake_source_state"` | latest `activeCount` per source (`senpi-task`, `omo-dag`, senpi builtins); sum 0 = nothing can wake the parked main. No event yet = unknown, not zero |
| `turn_end` | after each LLM response + its tool calls; while armed and wake sum is 0, requests the handoff mid-run via `sendUserMessage(..., {deliverAs: "steer"})` |
| `agent_settled` | true idle; ANDed with the wake sum. Lands the handoff when children were still running at turn_end; also where the `<successor>` tag is extracted |
| `tool_call` | blocks `task` and `task_create` while not watching |
| `before_agent_start` | appends the context-budget block (below) to `event.systemPrompt` on every main-session turn while mode is not `off` |

### Goal pause

Arming pauses senpi's built-in goal so goal-continuation stops re-firing
between the handoff reply and the rollover (field: every state file had
`goalPaused:false`; without the pause the continuation re-read plan, ledger
and child transcripts for +90K context, and session 01a09c27 read the previous
session's JSONL 3× and one child transcript 6×). The old implementation used
`import.meta.resolve("@code-yeongyu/senpi")`, which never resolves from
`~/.omo/agent/extensions/` (no `node_modules` there). `pauseGoal` now:

1. tries the bare `import("@code-yeongyu/senpi")`, which senpi's extension
   loader aliases through jiti to `dist/index.js`, and uses it only if it
   exports `readGoal`, `updateGoal` and `goalStoreRef` (senpi 2026.9.13 does
   not; the entry re-exports session, tools, TUI and CLI pieces but nothing
   from `core/extensions/builtin/goal`);
2. else derives senpi's `dist/` from `process.argv[1]` (omo's launcher spawns
   `<senpi>/dist/cli.js`, so `dirname(argv[1])` is the dist; a direct
   `node <omo-ai>/bin/omo.js` maps to
   `<omo-ai>/node_modules/@code-yeongyu/senpi/dist`, and `OMO_BIN` set by the
   launcher gives the same root), checks that
   `core/extensions/builtin/goal/{store,store-ref}.js` exist, and imports them;
3. reads the goal via `goalStoreRef(sessionManager, cwd)` and, when it is
   `active`, calls `updateGoal(ref, {status: "paused"}, "user")` — the
   `active→paused` transition is only legal with source `user`;
4. logs `goal_pause{ok, method: "main"|"dist"|"none", error?}` every time.

If `ok` is false the handoff prompt keeps a model-side fallback: call
`update_goal` with status `blocked` and reason "session rollover handoff in
progress". `paused` is impossible there — the model-facing `update_goal` only
accepts `complete|blocked` — while `blocked` also stops goal-continuation and
`blocked→active` is a legal transition the successor (or user) can take
later. The tool itself may still reject `blocked` (it requires the blocker to
survive a few goal turns), so the direct pause is the one that matters.

omo's kibitzer nudges are a separate continuation source that this extension
does not control; the system-prompt block below is what limits their cost.

### Skill continuity

Field result: a successor of a `ulw-execute` session behaved as a generic
agent, not the orchestrator. Cause: the system prompt carries only skill
names/descriptions; a skill's body enters context only when the user invokes
it or the model reads SKILL.md. Our kickoff never invoked it. senpi
`docs/skills.md` (2026.9.13, "How Skills Work" / "Skill Invocation", lines
66-95):

> 3. When a task matches, the agent uses `read` ... to load the full SKILL.md
> (models don't always do this; use prompting or `/skill:name` to force it)
> ...
> ```
> /skill:brave-search           # Load and execute the skill
> $brave-search                 # Equivalent leading dollar invocation
> ```
> ...
> OmO Desktop skill chips serialize as `$skill:name`. Senpi expands that
> explicit form even when it appears inline. Bare inline dollar text remains
> literal ...
> After resolving the explicit tokens, Senpi removes only those tokens and
> wraps the remaining text once as the user request. Unknown tokens stay
> literal, duplicates are skipped, and at most five distinct skills expand per
> prompt.

Token grammar, from `dist/core/agent-session.js:149-150`:

```js
const LEADING_SKILL_INVOCATION_PATTERN = /^(?:\/skill:([a-zA-Z][a-zA-Z0-9:_-]*)|\$([a-zA-Z][a-zA-Z0-9:_-]*))(?=\s|$)/;
const INLINE_DOLLAR_SKILL_INVOCATION_PATTERN = /(^|\s)\$skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
```

Expansion happens only when the message is sent with the option, from
`dist/core/extensions/types.d.ts:1412-1420` (same on `ReplacedSessionContext`,
the `withSession` context, lines 539-542):

> Set expandPromptTemplates to dispatch extension commands and expand skill
> commands and prompt templates.
> `sendUserMessage(content, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;`

What the extension does:

1. **Detect at arm time.** `detectActiveSkill(branch, known, cwd)` scans the
   current branch's user messages in order for the earliest leading
   `/skill:<name>`, `$skill:<name>`, `$<name>` or `/<name>` token (`known` =
   names from `pi.getCommands()` with `source: "skill"`; the bare `$x` / `/x`
   forms count only when `x` is a known skill, so `/rollover status` and
   `$HOME` never match, while omo's `/ulw-execute <plan>` does). It also
   matches the stored form of an already-expanded invocation,
   `<skill-instruction name="<name>"` (senpi replaces a `/skill:` or `$skill:`
   token with the skill body before the message is persisted, so the raw
   token is not in the branch). Else, `<cwd>/.omo/boulder.json` with a
   truthy `active_work_id` means `ulw-execute`. Result is `st.activeSkill`
   (persisted) and `active_skill{name, source: "message"|"boulder"}` in the log.
2. **Handoff prompt.** With an active skill the prompt adds: the `<successor>`
   block must START with the line `` `$skill:<name>` `` (exact token, nothing
   before it), then the handoff instructions, because a new session only sees
   skill names.
3. **Kickoff.** `/rollover` sends the successor prompt with
   `{ expandPromptTemplates: true }`, so senpi expands the leading token into
   the skill body plus `<user-request>`. If the extracted successor lacks a
   leading invocation of that skill, `$skill:<name>\n` is prepended
   (`withSkillToken`). No active skill → prompt sent unchanged, still with the
   option (harmless: no token, nothing expands).

Limits: detection is text-based; a skill loaded by omo's own pointer/keyword
mechanism (`ulw` magic word) without any of the forms above is only caught
via boulder.json, i.e. only for `ulw-execute`.

### Context-budget system prompt block

`CONTEXT_BUDGET_BLOCK` (five lines) is appended to the system prompt of every
turn in a main session via `before_agent_start` (child sessions never register
the handler; `/rollover off` disables it): never read a whole ledger, plan,
prior-session JSONL or child transcript, use `tail`/`grep`/offset+limit; read a
file range once per session; for child tasks use `task_list`/`task_get`/
`task_output`, and treat `running` + residency `persisted_only` as dead
(cancel, do not investigate); write a rollover handoff from context only. The
`<successor>` guidance in the handoff prompt repeats the JSONL and
child-transcript rules for the next session.


## Install

```powershell
.\install.ps1        # Windows
```
```sh
sh install.sh        # Git Bash / *nix
```

Copies `extension/rollover.ts` to `~/.omo/agent/extensions/`. Then
`/reload` in a running session (or restart). Commands:

- `/rollover` or `/rollover help` – print the command list
- `/rollover status` – state, mode, reason, context/budget (source), wake sums, blocked count, idle clocks
- `/rollover auto|on|off` – `auto` (default) forces the handoff only in autonomous sessions (active goal or a ulw-* skill) and otherwise warns at budget; `on` always forces; `off` disables
- `/rollover now` – hand off now (needs a `<successor>` block in the last reply; refused while children run)
- `/rollover now force` – hand off even with children running (they are orphaned)
- `/rollover park` – manual idle-style handoff: the successor reports and waits for the user
- `/rollover limit <K> [save]` – session token budget in thousands; `save` also writes `config.json`
- `/rollover idle <minutes>|off` – idle-park threshold (see "Idle park")

## Config

`~/.omo/rollover/config.json` (read at load):

```json
{ "budgetTokens": 150000, "rereadRatioMax": 0 }
```

`rereadRatioMax` (opt-in, default off) compares `cacheRead / output` of each
assistant message; three consecutive messages over it arm the handoff even
below the budget. It is off by default because it fires on tool loops: a turn
that emits only a tool call has output ≈ 50 tokens, so a healthy 72K-context
session reads as ratio ≈ 1200 and armed at 96K in the field. Set a positive
value to re-enable; `0`, negative, or missing means off. The ratio is still
logged on every `message_end` (`ratio`) for the dashboard.
`OMO_ROLLOVER_DIR` overrides the data directory (used by the tests).

## Event log

`~/.omo/rollover/sessions/<sessionId>.jsonl`, one object per line:
`{t, session, cwd, ev, ...}` with `ev` ∈ `session_start{parent?}`,
`message_end{input,output,cacheRead,cacheWrite,context,ratio}`,
`wake_source_state{source,activeCount,total}`, `turn_end{total}` (only while
armed), `agent_settled{total}`, `armed{reason,context}`, `active_skill{name,source}`, `goal_pause{ok,method,error?}`, `tool_call_blocked{tool}`,
`command{verb}`, `user_input{source,streaming}`, `budget_notice{reason,context}`,
`handoff_requested{at: "turn_end" | "agent_settled" | "idle", context}`,
`successor_found|successor_missing`, `rollover_deferred{total,wake,reason?}`, `rollover_refused{total}`,
`state_restored{state}`, `rollover{newSession,parentSession}`.
`~/.omo/rollover/summary.jsonl` gets one line per rollover and session shutdown
(peak context, messages, cacheRead/output ratio, blocked, rollovers).

## State persistence

The state machine is written to `~/.omo/rollover/state/<sessionId>.json` on
every transition (arm, handoff request, successor found, re-ask, blocked
spawn, `/rollover on|off`, rollover), atomically (tmp + rename). Fields:
`state, mode, blocked, rereadStreak, goalPaused, rollovers, armedAt,
handoffAskedCount, peak, messages, cacheRead, output, startedAt, activeSkill, reason, budgetOverride, updatedAt`.
The counters are also written on every `message_end` so the summary row
(peak context, messages, ratio) survives a `/reload`; the live `context` is not
stored and is recomputed from the next `message_end`. `session_start` (any reason) restores the file for
its session id and logs `state_restored{state}`. If the restored state is
`handoff_requested` (or `rollover`), the current branch is checked for a
`<successor>` right away and `/rollover` is dispatched (or deferred: right after
a reload the wake sum is unknown until omo-task re-emits, so the dispatch
usually lands at the next `agent_settled`), so a `/reload` that lands between
the model's reply and `agent_settled` still completes the handoff. After a rollover the old session's file is kept with
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
- Goal pause depends on senpi's internal `dist/core/extensions/builtin/goal/`
  layout and on `process.argv[1]` / `OMO_BIN` pointing into the omo-ai install
  (see "Goal pause"). If neither route resolves, `goal_pause{ok:false}` is logged
  and the handoff prompt falls back to `update_goal` with status `blocked`.
- The context-budget block is advice in the system prompt, not enforcement;
  kibitzer nudges and other omo continuation sources are outside this extension.
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
