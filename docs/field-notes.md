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

## Terminal monitors deferred a rollover (2026-09-15)

- Symptom: session 01a0a5e4 deferred its rollover 17:52:27–17:55:25 because wake source
  `terminal-monitors=1` while `senpi-task` was 0 the whole time. A persistent monitor would defer forever.
- Root cause: `wakeTotal()` summed all six senpi wake sources (senpi-task, omo-dag, ask-user,
  terminal-monitors, terminal-background-sessions, senpi-codemode), so a terminal monitor counted as a
  live child.
- Decision: the landing gate counts child sources only (`senpi-task`, `omo-dag`). `newSession` keeps PTY
  processes alive — senpi `terminal/extension.js` `session_shutdown` only writes a manifest — so monitors
  and servers do not need to block a handoff; the handoff prompt records them instead.
- Known limit: the successor of a ulw-plan session cannot spawn plan-consultant/plan-reviewer until the
  user re-runs `/skill:ulw-plan` there — the skill token alone does not reopen senpi's per-session plan
  gate (observed 2026-09-17).

## Prompt-cache TTL is per lane; only claude-sdk-oauth holds 1h (2026-09-16, re-measured 2026-09-18)

Method: for every assistant turn in the senpi transcript take `provider`, `usage.cacheRead`,
`usage.cacheWrite`, and the timestamp; list every gap >= 5 min between consecutive turns and read the
returning turn's cacheRead. A TTL expiry shows as cacheRead 0 + full rewrite; a partial read followed by a
large write is a prompt-prefix change, not expiry. Sessions mix lanes under model fallback, so the lane is
read per turn, never per session (the first pass in 2026-09-16 labelled whole sessions and got two of three
wrong; `message_end.provider` now logs it directly).

| lane | session | gaps (min) -> returning cacheRead | reading |
|---|---|---|---|
| claude-sdk-oauth / claude-fable-5-1 | 01a0a635 | 59 -> 222K read / 1.4K write (full hit); 249 -> 0 | >= 59 min retention. One data point. The 20-min gap (15.7K read / 90K write) was a prefix change, not expiry |
| github-copilot / claude-fable-5-1 | 01a0a77e | 7, 13, 14, 20, 54, 63, 169, 245 -> all 0 | < 7 min, i.e. the 5m tier. Eight of eight cold |
| devin / swe-2-max | 01a0a0fb | 5-26 -> mostly 0; one 7-min gap warm (161K), one 10-min partial (8K) | ~5-10 min, noisy; cacheWrite is always 0 on this lane so the Anthropic 5m/1h framing does not map |
| pi-ai direct Anthropic (api.anthropic.com), OpenAI lanes | - | unmeasured | code default 5m (see below) |

- The 59-min claude-sdk-oauth hit is genuine: the transcript has no entry of any kind between the two
  turns (no goal backstop turn, no cache-keepalive ping), so nothing re-warmed the prefix.
- Why claude-sdk-oauth differs: that lane streams through the bundled Claude Code binary, which picks the
  TTL itself — env `ENABLE_PROMPT_CACHING_1H` -> 1h, else a remote flag
  (`tengu_prompt_cache_1h_config.allowlist`) -> `{ttl:"1h", reason:"subscriber"}`, else 5m. The 1h branch
  is inferred from the hit, not observed: senpi persists usage normalized to
  `{input,output,cacheRead,cacheWrite,totalTokens,cost}` and the API's `cache_creation.ephemeral_1h_input_tokens`
  breakdown never reaches the transcript. It depends on the remote flag and can change without notice.
- Every other lane goes through pi-ai `anthropic-messages.js getCacheControl`: `ttl:"1h"` only when
  `cacheRetention === "long"` (model/provider config or env `PI_CACHE_RETENTION=long`) AND the base URL host
  is `api.anthropic.com`; otherwise 5m. github-copilot fails the host check, so it can never be 1h through
  config. senpi has no `promptCache.ttl` key — nothing to configure for the copilot lane.
- `promptCache.goalBackstopMaxSeconds` is the goal-monitor re-check period (senpi `goal/cache-warm.js`), a
  real LLM turn. Its default 270s is "5m TTL minus 30s so the re-check lands inside the cache"; the 1770s in
  use places re-checks ~30 min apart, inside the cache only on the claude-sdk-oauth lane.
- Overnight evidence (searchad 01a0a77e, copilot lane): idle gaps 65min/3h/4h with all wake sources 0; each return was a
  user-typed message paying a cold cache write at 165K/184K/196K context (~$16 of writes overnight). This
  is the cost the idle park exists to cap.
- Why idleMinutes=50 / idleMinTokens=100K: on the claude-sdk-oauth lane a park before ~50 min of silence
  still lands the successor inside the warm window (the successor's first turn reuses the cached prefix
  instead of paying a cold write), and 100K is the floor where a handoff is worth the re-read cost — below
  it the successor's cold-start reads cost more than the context saved. On the copilot lane the cache is
  gone by 7 min, so 50 min buys nothing there: the return pays a cold write whether it parks or not, and a
  per-lane idle default (short for 5m lanes) is the open follow-up.
- Why not a keepalive ping instead of parking: a synthetic turn every ~4 min would hold the cache warm
  but burns output tokens forever — at ~150K context a keepalive turn costs roughly 150K cache-read +
  ~1K output every 4 minutes, i.e. ~2.2M cache-read tokens/hour just to keep a dead session warm — and
  keeps a dead session looking alive; parking hands off once and stops paying. Deferral is deliberately not TTL-based: the timer checks wall-clock idleness
  (lastUserAt/lastActivityAt), not cache expiry — a session with live children or pending messages
  skips parking regardless of how warm the cache is (wake_unknown never parks).

## Settings in use at the end of the observation

`~/.omo/rollover/config.json`: `{"budgetTokens": 200000, "rereadRatioMax": 0}`.
Codex main model context window is reported by omo's status line as ~650K (local catalog says 272K); Anthropic
4.6+ models bill the full 1M window at a flat rate, so there is no "2× above 200K" cliff to design around.
