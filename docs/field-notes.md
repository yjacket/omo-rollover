# Field notes — SearchAd Stage 11 observation (2026-09-13 → 09-15)

Why this extension exists, what was observed in the first live deployment, and what is still unverified.
Session ids are OMO (senpi) main sessions in `C:/dev/searchad`; logs live in `~/.omo/rollover/sessions/<id>.jsonl`.

## Origin

- Goal: hand a long-running OMO main session off to a fresh session when its context passes a budget, without
  cutting a subagent mid-flight.
- A prior plan (`searchad/.omo/plans/rpc-session-rollover-sidecar.md`, 28 files, Python RPC controller + JS
  bridge, Windows locks, 7-window crash recovery) was rejected. Its authors assumed the session had to be
  driven from outside over `--mode rpc`; that loses the TUI, cannot attach to a running session, and the
  ownership/lock/recovery machinery exists only because of that choice.
- Everything needed is available in-process to a senpi extension: `getContextUsage()`, `message_end` usage,
  `wake_source_state` on `pi.events` (the same signal the Goal backstop uses), `agent_settled`, `turn_end`,
  `tool_call` blocking, `newSession({parentSession, withSession})`, and `sendUserMessage(..., {expandPromptTemplates})`.

## Timeline of defects found live (each fixed in this repo)

| Session | Observation | Fix |
|---|---|---|
| 01a09bd4 | Armed at 56K but never landed: one continuous 6-minute agent run, no children, `agent_settled` never fired | `turn_end` early landing when wake sources are 0 |
| 01a09bd4 | `/reload` between the `<successor>` reply and the next settle reset in-memory state; rollover lost | Per-session state file, restored on `session_start` |
| 01a09c07 | `reread` ratio (cacheRead/output ≥150 ×3) armed at 96K on a healthy session: tool-only turns emit ~50 output tokens | Reread trigger off by default |
| 01a09c07 | Model spawned a child with the `task` tool during handoff; only `task_create` was blocked; rollover proceeded with a live child (orphan `st_01a09c25`, `running` + `persisted_only`) | Block `task` and `task_create`; defer rollover until wake total is 0; `/rollover force` |
| 01a09c07 | Handoff phase itself cost 139K→234K: the model re-read ledger/plan to write the handoff | Handoff instruction forbids reads/commands/spawns, ≤80 lines |
| all | `goalPaused:false` everywhere: `import.meta.resolve("@code-yeongyu/senpi")` fails from `~/.omo/agent/extensions/`; failure was swallowed. Goal-continuation re-fired after the handoff reply and the model "resumed" by re-reading everything | Resolve senpi `dist/` from `process.argv[1]` (senpi's `dist/cli.js`); log `goal_pause`; fallback asks the model for `update_goal blocked` (the tool cannot set `paused`) |
| 01a09c47 | Successor started without the `ulw-execute` skill body (system prompt carries only skill names); it read SKILL.md by hand and behaved like a generic agent | Detect the active skill, force `$skill:<name>` as the successor's first line, send kickoff with `expandPromptTemplates: true` |

## The bigger finding: rollover was amplifying waste until resume reads were fixed

Per-session peak context and large tool results (input > 15K on one message):

| Session | Duration | First → peak | Big tool results | Outcome |
|---|---|---|---|---|
| bd4 | 43 min | 33K → 187K | 3 | audit only, rollover |
| bfc / c02 / c04 | 3–6 min each | 23K → 70–92K | 2–3 | budget 40K test, immediate rollover |
| c07 | 35 min | 23K → 233K | 9 | reread false arm, handoff spawn |
| c27 | 36 min | 23K → 230K | 9 | armed at 190K, handoff only |
| c47 | 4 h 50 min | 24K → 308K | **1** | all real work (Todos 8, 10, 11, 12, F1–F4) |

Sessions bd4…c27 did zero plan progress. Each successor spent 100–190K re-reading on resume: `ulw-execute/SKILL.md`
(72K chars), the full plan (47K), `.omo/ulw-execute/ledger.jsonl` (240K, read in overlapping offset slices 6×),
prior-session JSONL transcripts, child transcripts. The rollover then paid the same bootstrap again.
c47 was the first session under `searchad/AGENTS.md` (ledger `tail -n 30`, no re-reads); it worked for five hours
and hit the usage limit on cumulative cacheRead (22.9M tokens over 123 turns at ~190K average), not on context.

Consequences for this extension:
- `before_agent_start` now injects a short context-budget block into the system prompt of main sessions.
- The successor prompt tells the next session what not to read.
- The budget threshold matters less than the resume cost. With a ~120K resume, 150K leaves 30K of work per
  cycle; 180–200K is the practical range. With a ~60K resume, ~120K is cost-optimal (per-turn cost is linear in
  context; rollover overhead ≈ 3 handoff turns + resume reads).

## Ledger note (ULW skill, not this repo)

`.omo/ulw-execute/ledger.jsonl` is append-only evidence written by the `ulw-execute` skill (one 1–2 KB JSON object
per dispatch/claim/verify event). The skill never rotates it and calls it the "durable source of truth", so
orchestrators read it whole on resume. The original Stage 11 orchestrator (01a092d1, before any rollover work)
already read it 63 times. Mitigation used: project `AGENTS.md` rule + this extension's prompt block. A real fix is
upstream: separate state (last event per todo) from evidence, or rotate per plan.

## Not yet verified live

1. `goal_pause` result on a real arm (expect `ok:true, method:"dist"`).
2. Handoff-phase context growth ≤ 15K with the no-read instruction.
3. Successor's first message contains the expanded skill body (`$skill:ulw-execute` + `expandPromptTemplates`).
4. `deliverAs:"steer"` delivery of the handoff instruction at `turn_end` (observed once, 01a09c07 at 18:59:23).

When 1–3 hold, lower `budgetTokens` from 200K to 180K and re-measure.

## Settings in use at the end of the observation

`~/.omo/rollover/config.json`: `{"budgetTokens": 200000, "rereadRatioMax": 0}`.
Codex main model context window is reported by omo's status line as ~650K (local catalog says 272K); Anthropic
4.6+ models bill the full 1M window at a flat rate, so there is no "2× above 200K" cliff to design around.
