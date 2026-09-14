# rpc-session-rollover-sidecar

## Outcome and boundaries

Build SearchAd-owned deterministic RPC tooling, not a third LLM session. It owns one classic stdio Senpi main process, measures context, compacts first, and replaces the session only at a proven quiet boundary. The fresh session receives the same durable work, Goal objective, todos, and next action. Ambiguous delivery stops safely instead of creating another main.

This is a decision-complete execution plan, not an implementation receipt. Planning changes exactly this file and `.omo/ulw-execute/rpc-session-rollover-sidecar-prompt.md`. Execution is a separate `/ulw-execute rpc-session-rollover-sidecar` invocation on Windows. No commit is authorized.

**Decisions:** Python 3.11 standard-library controller plus a small project-local JavaScript ESM extension bridge; existing Python dev tools and Node test runner; no dependency or global-setting changes. All code, test, fixture, and executable QA-script edits route `category=implementer`, including remediation. `unspecified-high` is only the accepted broad non-implementation synthesis/review boundary. Never reroute code to it when a provider quota is exhausted.

**Alternatives considered:** (A) a pure external RPC observer with Markdown extraction; (B) an external controller with a narrow, deterministic in-process bridge. Choose B: RPC does not expose complete Goal/todo/wake-source state or an atomic switch-admission guard. A cannot prove zero monitors from idle polls, cannot reliably pause Goal, and mistakes accepted prompts for durable execution. A shared multi-session host was also rejected: extra routing/attachment ownership is unnecessary here and risks another writer. The bridge does not summarize, reason, call a model, initiate replacement, or bypass task ownership.

## Authoritative inputs and surveyed surface

Read these at execution bootstrap; retain hashes/version information in the execution receipt. Installed documentation defines wire behavior; current SearchAd files define work state; the dated memory defines user policy. Do not use the abandoned inherited draft as authority.

- `C:/dev/searchad/.omo/boulder.json` (schema 2).
- `C:/dev/searchad/.omo/plans/stage11-monthly-reports.md`.
- `C:/dev/searchad/.omo/ulw-execute/ledger.jsonl` (102 parsed records at planning).
- `C:/dev/searchad/.omo/ulw-execute/stage11-monthly-reports-handoff.md`.
- `C:/dev/searchad/pyproject.toml`, `uv.lock`, `.gitignore`; project uses Python >=3.11, strict basedpyright, pytest-socket, Ruff, and `testpaths=["tests"]`. Sidecar tests require explicit discovery outside product tests.
- `C:/Users/yjack/AppData/Roaming/npm/node_modules/omo-ai/plugin/skills/ulw-execute/SKILL.md`: Goal/todo registration, independent confirmation, column-zero checkboxes, Boulder status `active`. Its old category table, default shared ledger path, mandatory product worktree, and merge defaults are overridden by this narrower project-tooling plan: no product worktree, no Stage 11 ledger writes, no commit/merge.
- Installed Senpi `2026.9.12` at `C:/Users/yjack/AppData/Roaming/npm/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/`: `docs/rpc.md`, `docs/sessions.md`, `docs/session-format.md`, `docs/extensions.md`, `docs/compaction.md`, `docs/settings.md` (Goal Backstop table).
- Read-only compatibility references under that Senpi root: `dist/core/session-manager.js` (`newSession`, `_persist`), `dist/core/extensions/builtin/goal/{store-ref,store,transitions,command-registration,tool-registration,channel-state-subscriptions}.js`, `dist/core/extensions/builtin/todotools/todo-storage.js`, `dist/core/extensions/builtin/compaction/todo-bridge.js`, `dist/core/extensions/builtin/monitor-state-event.js`, and `dist/core/extensions/builtin/terminal/extension.js`.
- Authoritative memory, readable from Windows using the WSL filesystem share without launching a WSL OMO host: `/home/yjacket/.omo/memory/agents/ai-native-sdlc-d6873dbd/repo/reference/goal-ulw-session-operations.md`, `reference/searchad-model-routing-policy.md`, and `/home/yjacket/.omo/memory/agents/searchad-6cb2ff9a/repo/facts/searchad-omo-routing-stage11.md`. These are the actual WSL memory paths, not Windows session-store locations. Their binding decisions are restated below so Windows execution does not depend on a mounted memory share.

Survey findings: no project-local rollover implementation exists. Product scripts are Python and do not own RPC. `git log` places the integration base at `9d81a75` (Stage 10 completion); `git blame pyproject.toml` confirms the flat-layout and isolated test discovery predate this work. The Stage 11 ledger records false task loss when WSL reconciled Windows-owned tasks by Linux PID visibility. A record marked `lost` can still have a live Windows writer; terminal status alone is insufficient. The installed session manager does not persist a fresh JSONL file until its first assistant message. `new_session` and `set_session_name` therefore do not prove a new file exists.

### Stage 11 is a protected paused work

Planning baseline: work `stage11-monthly-reports`, `status="paused"`, `active_work_id="stage11-monthly-reports"`; session ids `senpi:01a092d1-a386-7081-b4b9-871c57f81082` and `senpi:01a09678-684d-7750-baef-8784162c9b93`; worktree `C:/dev/searchad-wt/stage11-monthly-reports-wave1`. Its plan is 6/16 checked. Todos 1-6 are confirmed. Todo 7 Fix5 is only a DoneClaim pending fresh independent verification; Todo 8 must not start. Branch/HEAD in the handoff: `feat/stage11-wave1`, `9d81a75235fa29f458cae4c1e7ec31e709e7405f`, empty index. Do not run that handoff prompt.

Execution may register only a new Boulder work `rpc-session-rollover-sidecar`, with this plan, status `active`, its actual prefixed main session id, and `worktree_path="C:/dev/searchad"`; it may select that new `active_work_id`. Preserve the Stage 11 object's exact serialized bytes, its paused status, ids, and path. No Stage 11 child, verifier, test, QA, artifact, ledger record, or worktree change is authorized. Pre-existing main-checkout dirty files remain untouched; an already-dirty Git status is not a sidecar failure.

## Allowed files

Execution sources and tests, all relative to `C:/dev/searchad`:

```text
.omo/tools/rpc_rollover/__init__.py
.omo/tools/rpc_rollover/__main__.py
.omo/tools/rpc_rollover/cli.py
.omo/tools/rpc_rollover/rpc.py
.omo/tools/rpc_rollover/policy.py
.omo/tools/rpc_rollover/host.py
.omo/tools/rpc_rollover/snapshot.py
.omo/tools/rpc_rollover/storage.py
.omo/tools/rpc_rollover/machine.py
.omo/tools/rpc_rollover/recovery.py
.omo/tools/rpc_rollover/qa.py
.omo/tools/rpc_rollover/bridge.mjs
.omo/tools/rpc_rollover/bridge-state.mjs
.omo/tools/rpc_rollover/bridge-compat.mjs
.omo/tools/rpc_rollover/README.md
.omo/tools/rpc_rollover/tests/conftest.py
.omo/tools/rpc_rollover/tests/fake_rpc.py
.omo/tools/rpc_rollover/tests/test_rpc.py
.omo/tools/rpc_rollover/tests/test_policy.py
.omo/tools/rpc_rollover/tests/test_host.py
.omo/tools/rpc_rollover/tests/test_snapshot.py
.omo/tools/rpc_rollover/tests/test_storage.py
.omo/tools/rpc_rollover/tests/test_machine.py
.omo/tools/rpc_rollover/tests/test_recovery.py
.omo/tools/rpc_rollover/tests/test_cli_qa.py
.omo/tools/rpc_rollover/tests/bridge.test.mjs
.omo/plans/rpc-session-rollover-sidecar.md
.omo/ulw-execute/rpc-session-rollover-sidecar-prompt.md
.omo/ulw-execute/rpc-session-rollover-sidecar-ledger.jsonl
.omo/boulder.json
```

Only the new work and `active_work_id` may change in Boulder. The sidecar-specific execution ledger replaces the default ULW ledger for this work; it records `event`, `plan`, `task`, `session_id`, `commands`, `artifact`, `adversarial_classes`, `cleanup`, DoneClaim, and independent verdicts. The old shared ledger is strictly read-only.

Runtime files may be created only below `.omo/rollover/rpc-session-rollover-sidecar/`: permanent `host.lock`, `owner.json`, `checkpoint.json`, `ledger.jsonl`, `sessions/`, `handoffs/`, `transactions/`, and owned atomic-write temporary files. Goal state generated by Senpi is under that owned session directory's `extensions/goal/`, not a global profile. No new `.gitignore` is necessary; `.omo` is already ignored. Evidence and QA-only fixtures go under `C:/dev/searchad-evidence/rollover-sidecar/`, never the Stage 11 evidence tree. Tests use temporary fixtures there, never production Boulder/task/session files.

Forbidden: `src/**`, `tests/**` at repo root, `scripts/**`, product docs/config, `pyproject.toml`, `uv.lock`, every Stage 11 artifact and every path under `C:/dev/searchad-wt/`; installed/package-managed files, global settings/credentials/memory, Git index/staging/commits, provider APIs/SDK calls, paid live tests, broad process kills, WSL OMO hosts. Do not fix unrelated failures. Report them separately; do not expand the allowlist silently.

## Runtime contract

### Ownership and CLI

- The Python controller starts exactly one Windows `node.exe` running `C:/Users/yjack/AppData/Roaming/npm/node_modules/omo-ai/bin/omo.js --mode rpc` with explicit `--session` and `--session-dir` under its owned runtime root and `--extension C:/dev/searchad/.omo/tools/rpc_rollover/bridge.mjs`. Use argv, never shell interpolation. It is the only stdin writer; no socket, `--listen`, `--multi-session`, interactive attach, or independently launched supervisor LLM.
- Set `OMO_RPC_CLIENT_CAPABILITIES=extension_events` only in the child environment. Do not change persisted settings. Keep runtime cwd `C:/dev/searchad`. Every source path is absolute after CLI validation. Reject a session that belongs to Stage 11 or lies outside the owned sessions directory; this version manages sessions it created, not adoption of an already-running TUI.
- `run --work-id rpc-session-rollover-sidecar --live` explicitly enables normal model-bearing `compact` and continuation `prompt` operations after an operator has launched this owned main. Implementation and QA never use `--live`. The implementation orchestrator does not migrate itself while its code is under construction.
- `status` is read-only JSON. `recover` reconciles the owned checkpoint and may resume only proven-safe unsent operations; it never implies a live prompt grant. `replay --scenario all --out` exercises the actual CLI/controller against the fake subprocess. `qa-probe --out` exercises installed Windows RPC with isolated runtime state and a hard request allowlist. `--help` has no side effects. No generic arbitrary RPC passthrough or provider fallback feature.
- Exit codes: 0 success; 2 invalid input/incompatible runtime; 3 wrong host/WSL; 4 blocked or ambiguous recovery; 5 owner already live; 6 transport/deadline failure; 7 malformed durable state. All nonzero exits include typed reason and a receipt; never swallow an error or silently clear a queue.

### Same-host Windows lock

Before importing Senpi, creating task/session files, or spawning any agent: require `sys.platform == "win32"`; reject `WSL_DISTRO_NAME`, `WSL_INTEROP`, Linux, UNC/project aliases, or a canonical root other than `C:/dev/searchad`. Reading these plan files from WSL is allowed; operating the sidecar or a task host from WSL against SearchAd is not.

Use a retained nonblocking `msvcrt.locking` byte-range lock on a permanent `host.lock` file. Never unlink or replace that lock inode. Under the lock, atomically write `owner.json` with schema version, normalized Windows hostname, OS, boot identity, controller PID/creation time, child PID/creation time, random owner nonce, canonical project/task-store/session paths, and current durable session id. PID reuse is not ownership. Capture native process creation/exit handles through `ctypes` Win32 calls; unknown access/liveness blocks recovery. Another host's metadata is rejected without rewriting it. A same-host stale owner is reclaimable only while the OS lock is held and both recorded process identities have definitely exited; do not kill an unrelated PID or infer Windows death through Linux `kill(pid, 0)`.

Before any spawn, inspect same-host process command lines for another OMO owner of the canonical task store or requested session, including the implementation orchestrator. If one exists, `run` fails with owner-live, not a second main. The zero-provider QA process uses its own task/agent/session root and cannot reconcile `.omo/senpi-task`. Wrap an owned real child in a Windows Job Object with kill-on-job-close, retain identity handles, and await actual process exit before replacement process launch. Assignment failure is fatal before any RPC mutation. Test fakes use the same lifecycle seam.

### Context policy and Backstop

Normalize the latest completed main assistant usage as **`input + cacheRead + cacheWrite`**. Never use cumulative session token totals, cost, output, compaction-summary LLM usage, or child usage as current main context. Streaming `message_update.usage` is provisional; `message_end.message.usage` is authoritative. Associate durable message identity through `entry_appended.entry.id`, not an invented message-end id. Duplicate completed records do not accumulate context.

Choose `COMPACT_TRIGGER_TOKENS=160_000`, inside the required 150-180K band. `180_000` is an urgent admission ceiling, not a claim that one tool response cannot overshoot it: hold further external prompts and compact at the next safe opportunity. **Compact first even at/above 180K.** Never abort live tools or children to hit a number. If an automatic compaction already owns the session, observe its terminal outcome instead of issuing another.

A successful compact with finite nonnegative `estimatedTokensAfter <= 120_000` returns to observation. `estimatedTokensAfter > 120_000`, a terminal compact failure, or an aborted compact requests rollover. A successful response missing the estimate is not a low-context success: refresh stats once; if still unknown, pause as `context_unknown` rather than guess. `get_session_stats.contextUsage.tokens` is a heuristic fallback when completed usage is unavailable; immediately after compaction it is normally null. In that epoch use the compact result's estimate until fresh assistant usage arrives, never the pre-compaction message's usage. Negative, boolean, NaN, infinite, missing required usage fields, and unrecognized provenance are unknown, not zero.

Backstop is **seconds**, not turns, tokens, rollover frequency, or a sleep delay. User policy: Codex main `1770` seconds (30-minute cache minus 30 seconds); Claude `claude-sdk-oauth` subscription main `3570` seconds (one hour minus 30 seconds). Claude usage-credit mode has a five-minute TTL and requires **270 seconds**. Unknown billing mode gets a conservative 270-second recommendation. `promptCache.goalBackstopMaxSeconds` controls only the Goal parked-wake-source recheck interval, clamped to 1..3600; normal child completion wakes immediately. The bridge reads the effective value when supported and records expected/actual/provider/billing-mode in the receipt. The sidecar neither changes global/project settings nor sends cache-ping prompts, changes provider, nor rolls over on this interval. A mismatch is a surfaced configuration warning, not silently repaired. Fake-clock tests test seconds and billing-mode selection, without real waiting.

Account exhaustion is not fixed by changing sessions. If compact fails for confirmed quota/usage-credit exhaustion, still capture the required rollover checkpoint, but block provider-bearing resume; a replacement may be prepared at the safe gate without sending a continuation prompt. Ordinary `rate_limit` or text `blocked` alone is not proof of exhausted credits. Unknown/final provider errors are recorded, not classified by a broad substring into an automatic retry loop. Development/tests have zero paid requests, including fallback providers.

### Exact RPC and bridge protocol

Each command has a unique client-owned `id`, generated as transaction UUID plus operation name and attempt number. IDs correlate replies; the server does **not** deduplicate requests. Encode one JSON object plus LF; accept CRLF by stripping one trailing CR. LF is the only delimiter; U+2028/U+2029 inside strings are data. Enforce 16,777,216-character record bounds with bounded buffering. Unknown additive event types are ignored and counted. Malformed known records, primitives, invalid UTF-8, partial EOF, or oversized records invalidate the safety snapshot and fail closed; log type/length/hash, not raw secret-bearing payloads. One malformed line must not desynchronize the next LF record. Never interpret malformed input as an empty queue/zero activity.

Core commands and required observables:

| Command | Fields / response contract |
| --- | --- |
| `get_protocol_info` | require `success:true`, `data.mode:"classic"`, `protocolVersion:1`; record installed version and capabilities |
| `get_state` | `data.sessionId`, `sessionFile`, `isStreaming`, `isCompacting`, `pendingMessageCount`, `model`, `thinkingLevel`, `autoCompactionEnabled`; this `sessionId` is durable in classic mode |
| `get_entries` | `data.entries`, `leafId`; walk active `parentId` chain, not append order across abandoned branches |
| `get_session_stats` | read current `contextUsage`, not cumulative `tokens`; save non-secret usage snapshot |
| `compact` | `customInstructions` requests preservation of Goal, exact todo statuses, authoritative paths, verified boundary, and next action; `response.data.estimatedTokensAfter` and `compaction_end.result.estimatedTokensAfter` describe rebuilt context |
| `new_session` | `parentSession` is exact old `get_state.sessionFile`, not a UUID; response only `data.cancelled`; cancelled true means no successful swap |
| `set_session_name` | deterministic work-id plus rollover generation; not proof of JSONL persistence |
| `prompt` | `message` is the immutable rebind message from checkpoint, starts `/ulw-execute rpc-session-rollover-sidecar`; idle only, omit `streamingBehavior`; success disposition is acceptance, not completion |

Consume `agent_start`, `agent_end`, `agent_settled`, `message_update`, `message_end`, `entry_appended`, `tool_execution_start/end`, `queue_update` (`steering`, `followUp`), `compaction_start/end`, retry/summarization-retry lifecycle, `model_changed`, `extension_error`, and `extension_event` named `terminal_monitor_state` with `data.activeCount` and `data.monitors`. `agent_end` is not a settle barrier. `compaction_end` includes `aborted`, `errorMessage`, `willRetry`; `willRetry:true` means the gate remains closed. Pair event and compact response once per transaction, whichever arrives first; contradictory terminal results block.

`session_replaced` is `{type:"session_replaced", durableSessionId, sessionFile, cwd, sessionName}`. Its durable identity is **not** a top-level routing `sessionId`. Subscribe before sending `new_session`; capture either event/response order. Require non-cancelled reply, different durable id, owned file path, matching cwd/parent lineage, and a fresh `get_state` confirming both id/file. A duplicate matching event is a no-op. A stale/foreign/conflicting identity or unsolicited replacement quarantines the transaction. `loaded_surfaces_changed` is not a bind or settle barrier.

The project-local bridge uses documented `pi.rpc.handle`, `pi.rpc.emit`, `pi.on`, `pi.appendEntry`, sessionManager read access, and fresh session contexts. Names below are **new project-owned handlers to implement**, not claimed built-in commands:

- `extension_request` name `searchad.rollover.snapshot`, data `{schema:1, ownerNonce, expectedSessionId}`: returns identity, leaf, Goal object, exact todo phases, terminal/background/child/detached-work counts and known flags, queue/idle state, bridge generation, monotonic activity revision, effective Backstop, model/thinking, and session header from the live manager. No provider call.
- `searchad.rollover.freeze`, data additionally `{transactionId, expectedRevision}`: closes external prompt admission, pauses the active Goal as a **system/user pause**, records a Goal block with reason `session_rollover`, and returns its prior state plus fence revision. It does not mark the Goal complete or fabricate the model's three-turn blocked audit. Existing blocked/paused Goal remains blocked/paused; no absent Goal is invented. Already-running work is allowed to finish; completions are never discarded.
- `searchad.rollover.restore`, data additionally `{transactionId, expectedSnapshotHash}`: reads only the immutable owned checkpoint, recreates the new Goal objective and exact phased todo state while fenced, returns read-back hashes, and leaves the new Goal paused. Idempotency key is transaction plus new durable id.
- `searchad.rollover.release`, data additionally `{transactionId, expectedRevision}`: only after matching identity, restored hashes, and accepted rebind receipt, restore prior active Goal/Boulder state and admit work. If the old Goal was paused/blocked, preserve it and do not auto-prompt. Admission of a single rebind prompt is a transaction-specific permit, not a permanent removal of the fence.
- `searchad.rollover.shutdown`: idle-only graceful `ctx.shutdown()` for owned QA/process cleanup.

Keep mutable bridge state scoped to the current extension generation. On replacement discard captured old `pi`, command context, and raw SessionManager references; `session_start` constructs a fresh state. Persist a small `transactions/identity-receipt.json` from the new bridge generation, binding transaction/old id/new id/file/parent/header, before exposing restore readiness. It supplements, never replaces, required `session_replaced` observation in a normal run.

Goal pause/resume has no public structured RPC command in this installation. Isolate the narrow read-only imports of installed `goal/store-ref.js` and `goal/store.js` inside `bridge-compat.mjs`; pin Senpi version 2026.9.12 and hash these imported contracts at bootstrap. Use `readGoal`, `updateGoal(...,{status:"paused"},"user")`, `createGoal`, and `updateGoal(...,{status:"active"},"user")` on the owned session's store. These change only project-owned runtime Goal files; never patch imports/package files. Reject changed/incompatible exports before mutation; no speculative adaptation. Recreate todos with the native `senpi.todo-state` custom entry `{schema:"v2", phases:[{name,tasks:[{content,status}]}]}` via `pi.appendEntry`, then re-read active branch data. Preserve pending/in_progress/completed/abandoned verbatim; unknown legacy states block with an explicit migration requirement rather than silently deleting work. The Goal block and objective-full text are separate from Markdown `## Goal`; Markdown is handoff display, not state authority.

### Safe-point gate and transaction order

Required sequence: **`observe -> compact -> safe-point -> checkpoint -> new_session -> session_replaced -> rebind -> observe`**. Persist these phase names; substates record pending/accepted/confirmed side effects. `observe -> compact` includes an admission freeze and an idle/pre-compact check before actually sending the compact command. Freeze intent is written first so a crash cannot strand an unexplained paused Goal. Successful compact below the post-limit restores prior active state and releases the fence without replacement.

All of these must hold together before compact and again before replacement; compact itself is excluded from the no-compaction check only while awaiting its outcome:

- Fresh matching `get_state`: not streaming, not compacting, pendingMessageCount zero. Latest queue snapshot is empty for both steering and follow-up; never issue `clear_queue` to force passage.
- Fully settled after the last agent_start, no retry/auto-compaction-retry pending, zero in-flight tools and detached/background jobs. Cold owned startup may establish settled from a verified bridge startup snapshot; absence of agent_start alone is not proof.
- Zero live child tasks, all task-store writers known on the same Windows host, and all final completion notifications for this main are delivered/consumed before the new leaf snapshot. Inspect `.omo/senpi-task/tasks/*.json` as task records, not arbitrary transcripts in children directories. For matching parent/root tasks use `notification.run_epoch/notified_epoch`, terminal result, host/process identity, and observed completion entry. Task statuses actually include `completed`, `error`, `cancelled`, `lost`; `lost`, unknown liveness, pending notifications, or a terminal record with a live owner blocks until authoritative reconciliation. Do not rewrite historical records. Foreign active tasks sharing the store also block; unrelated historical terminal tasks with proven no live owner do not require replaying notifications.
- Zero terminal monitors from a valid `terminal_monitor_state`/bridge snapshot, activeCount equal to monitors length, zero background/detached wake sources, no other continuation hold. Unknown never becomes zero after a delay. No two-idle-poll fallback. Snapshot subscriptions are installed before action and invalidated on generation change.
- Retained same-host lock; unchanged task-store snapshot digest, active leaf, Boulder expected hash, and bridge activity revision. No user/UI input or pending approval. New task admission remains fenced through the swap.

The bridge's `session_before_switch` is the **final in-process cancellable guard**, not a replacement initiator. It checks the persisted transaction, expected session/leaf/revision, fresh task-store/liveness snapshot and current idle/queue/monitor state immediately before authorizing this one `new_session`. Any intervening completion or activity increments revision, invalidates the permit, and cancels the switch. Synchronous guard decision must not await a provider or poll. A completion between external snapshot and this guard is processed in the old session; resnapshot after it settles. Preserve extension-owned continuations while frozen; do not silently consume or discard their messages to make the gate pass. If a channel cannot be fenced/reconciled, report blocked rather than claiming atomic admission.

### Durable checkpoint, handoff, and rebind

1. Under retained lock write transaction intent (schema, UUID, generation, owner, prior states) and flush/fsync it before freeze. No new_session may precede a complete checkpoint.
2. At the safe point capture Goal object/full objective, native todo phases/statuses, active plan and checked ids, work/branch/HEAD/cwd, protected dirty-path manifest, current model/thinking/queue modes/auto-compaction state, old durable id/file/leaf, source file hashes, usage source and compact result, next concrete action, latest independent verdict/DoneClaim distinction, and delivered child epochs. Snapshot identity fields are machine-validated; handoff text is inert data, never executable commands from tool output.
3. Atomically write immutable `transactions/<transactionId>/checkpoint.json` and `handoffs/<transactionId>.md` with temp-write, flush/fsync, same-volume replacement; update the current checkpoint pointer last. Handoff includes Goal block, all todos, exact authoritative file list, lineage, source hashes, reason, next action, and exact rebind message. If disk full/permission/fsync fails, do not send new_session. Files already committed remain evidence, not automatically deleted.
4. Pause only `works["rpc-session-rollover-sidecar"]` in Boulder, preserving its old active status in the transaction and transition metadata in the sidecar checkpoint (do not invent unsupported Boulder status values). Save original Boulder bytes in transaction evidence. Use expected-hash compare-and-swap and a targeted JSON member replacement preserving other serialized work objects; abort on any concurrent writer. Never overwrite a newer Boulder wholesale from backup.
5. Persist `new_session` send intent **before** the stdin write, then correlated acceptance and session_replaced receipt. Resolve event/state/bridge/header identity consistently. Missing event, cancelled swap, stale identity, or transport ambiguity never licenses an immediate resend.
6. Append `senpi:` plus the new durable id to this work's `session_ids` only if absent, while it is still paused. Preserve old membership and lineage; do not move or renumber completed plan checkboxes. Recreate Goal and todos through the bridge and prove read-back equality before continuation. Verify model/thinking survived replacement; use `set_thinking_level` with `scope:"turn"` only if required. A model mismatch blocks: do not use a global-persisting model/settings command as restore. Cwd/worktree mismatches block rather than switching to Stage 11.
7. Persist immutable rebind prompt and a one-use permit with transaction sentinel `searchad-rollover:<transactionId>`. The message begins `/ulw-execute rpc-session-rollover-sidecar`, directs reading this plan, current Boulder, the sidecar execution ledger, and the transaction handoff, and names the exact next unchecked boundary. Goal/todo machine state is already recreated; the main must not create a second Goal or redo confirmed tasks. Keep prompt <=1,000,000 characters; oversize handoff is referenced by owned path/hash instead of truncating its state.
8. Send exactly one normal `prompt` only for formerly active work with `--live` permission and no provider-exhaustion block. Require successful acceptance (`disposition:"started"`, not queued); journal user `entry_appended` sentinel when it arrives. `handled` is not proof that ULW started. Mark rebind confirmed only with a durable matching sentinel or explicit bridge receipt that survives recovery; restore Boulder `status:"active"` and prior active Goal state through the controlled release. A failed/unknown prompt remains paused/blocked. Never treat `userMessages == 1` as identity or dedup evidence.

### Crash recovery and idempotency

Durability is ordered side effects plus reconciliation, **not an exactly-once RPC claim**. IDs are correlation only. Every command has persisted unsent/send-intent/accepted/confirmed state. Operations proven unsent can run; operations with uncertain delivery must reconcile first. All recovery paths keep the old Goal paused and never spawn another main while a recorded owner might be live.

- Crash before complete checkpoint: restore the prior state only if ownership/identity/snapshot hashes still match and no switch intent exists; otherwise keep paused with a repair receipt.
- Crash after checkpoint, before send intent: reacquire same-host ownership, validate gate, then send once.
- Crash after new_session send intent but before event/rebind: if the original RPC process is still live, do not start another or attempt stdio reattachment. Await its known exit/recover through retained ownership; an orphan requires explicit same-host recovery. If identity receipt and a persisted replacement JSONL agree, resume that exact file. If replacement is not yet persisted, its live-manager header/receipt is evidence of allocation, not resumable disk state. **Do not automatically reissue new_session or recreate a lost in-memory replacement.** Return `blocked_ambiguous`, preserving both lineage and checkpoint for explicit operator reconciliation. An old-id get_state on a newly spawned old file cannot prove the prior swap never happened.
- Crash after event but before Boulder append/restore: match new id, file, parentSession, transaction, and prior hashes; repeat set-membership append and idempotent restore only. Never call new_session.
- Crash around prompt: exact transaction sentinel in the matching active branch is acceptance evidence; a different user message is not. If send intent exists without durable proof, do not resend. If already accepted, resume only that same session, never manufacture another continuation. Process death before the first assistant can lose both user entry and fresh file because of Senpi's lazy persistence; classify this as ambiguous, not a successful rebind.
- Crash after restore/release: compare native Goal/todo hashes and Boulder membership before changing anything; already-confirmed work returns to observe with no additional prompt. An actually complete work remains complete, not active again.
- Truncated ledger tail can be quarantined as an owned tail artifact under retained lock; malformed middle record/checkpoint/hash or an unsupported schema blocks without rewriting evidence. Preserve foreign files and never remove a lock/transaction owned by another nonce.

## Verification commands and discipline

All execution commands below are **Windows PowerShell**, from `C:/dev/searchad`; they are not Bash environment assignments. Planning did not run them. Use the existing Windows `uv`, Python, and Node; no install/download. Save exit codes explicitly; a piped log is not a successful command. Red logs capture intended behavioral failures, not accidental import-path/configuration failures. Independent gates run against final bytes once; fix caused failures, never skip/retry for luck.

Bootstrap command environment (save and restore prior process values in `finally`):

```powershell
Set-Location C:/dev/searchad
$env:PYTHONUTF8 = '1'
$env:PYTHONPATH = 'C:/dev/searchad/.omo/tools'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:UV_OFFLINE = '1'
```

Focused Python test commands for RED and then GREEN are given per todo. Every command retains repo pytest settings, including `--disable-socket`; no paid provider or live Naver/credential/delivery operation. The fake is a real subprocess with JSONL stdin/stdout and parent-controlled barrier commands; install the event subscriber before triggering the action, then await that exact state with a bounded 10-second deadline. No sleeps, delay polls, wait-for-time patterns, probabilistic races, retries-to-green, or mocks that bypass the assertion boundary. Time policy uses injected clock advancement. Tests assert parsed fields/status/identity/order/bytes/hash/call counts, not handoff prose or README wording.

Common final commands:

```powershell
uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests
node --test .omo/tools/rpc_rollover/tests/bridge.test.mjs
uv run --frozen --offline ruff check --no-cache --no-respect-gitignore .omo/tools/rpc_rollover
uv run --frozen --offline ruff format --check --no-cache --no-respect-gitignore .omo/tools/rpc_rollover
uv run --frozen --offline basedpyright .omo/tools/rpc_rollover
Get-ChildItem .omo/tools/rpc_rollover -Filter *.mjs -Recurse | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax gate failed' } }
uv run --frozen --offline python -m rpc_rollover --help
uv run --frozen --offline python -m rpc_rollover replay --scenario all --out C:/dev/searchad-evidence/rollover-sidecar/final-replay
uv run --frozen --offline python -m rpc_rollover qa-probe --out C:/dev/searchad-evidence/rollover-sidecar/qa-rpc
uv lock --check --offline
git -C C:/dev/searchad diff --check
```

Run severity-all LSP diagnostics on **every changed Python/JavaScript source and test** before build/static gates. If a diagnostics service is unavailable, record the blocker, not a clean result. Python bytecode is the build for this project-local tool; direct its output outside the repo, save/restore the environment:

```powershell
$env:PYTHONPYCACHEPREFIX = 'C:/dev/searchad-evidence/rollover-sidecar/build-cache'
uv run --frozen --offline python -m compileall -q .omo/tools/rpc_rollover
Remove-Item Env:PYTHONPYCACHEPREFIX
```

There is no product import, route, package, CI, or schema change and no sidecar hook into product startup. Do not run the paused Stage 11 suite or copy sidecar tests into root `tests/`. Scope proof is a full before/after content manifest of main checkout and protected worktree (exclude existing .git/.venv/cache operational directories), explicit Git status/index snapshot comparison, and protected Stage 11 file/object hashes. No main/product duplicate tests: each sidecar behavior has one owning test module; integration tests cross seams rather than repeat the same assertions in product tests. Note pre-existing `git diff --check` failures separately without changing unrelated files.

### Real RPC QA, zero paid calls

`qa-probe` is an actual execution of the controller's RPC client and bridge against the installed Windows OMO entry point, not a fake-only success. It uses an isolated agent/task/session root under its `--out`, no inherited auth/provider key variables, no global profile mutation, no auto-title flag, and disables discovered user extensions while explicitly loading the project bridge. The native builtins needed by the bridge remain enabled. It refuses any request outside `get_protocol_info`, `get_state`, `get_entries`, `get_session_stats`, `get_commands`, `new_session`, `set_session_name`, and the named bridge requests. **No real `compact`, normal `prompt`, `steer`, `follow_up`, `bash`, provider request, or Goal continuation is allowed during QA.** Fake RPC covers these model-bearing commands end-to-end.

Subscribe to responses, session_replaced, and terminal_monitor_state before each action; operation deadline 30 seconds, awaited events/process exits only. Sequence: probe protocol; read initial state/entries/stats and bridge snapshot; freeze the empty QA main; checkpoint a synthetic sidecar work in an isolated Boulder fixture; issue one new_session with exact old sessionFile as parentSession; await event plus noncancelled response; confirm id/file/cwd with get_state; name the session; read bridge readiness and live SessionManager header; restore a fixture Goal/todos while paused and read back exact machine state; call shutdown and await child/Job Object exit.

Required observables: classic v1; zero assistant/user model calls; terminal monitors known-zero; old/new ids differ; parent header matches old file; new bridge generation differs; old-context requests rejected; duplicate restore leaves one Goal and identical todo phases; isolated Boulder has exactly one appended new id and original foreign Stage 11 fixture bytes; no prompt/compact in sent transcript; controller and child exit; no owned process/handle remains. **Do not require a fresh JSONL to exist before an assistant response.** Record `session_file_persisted:false` and the header's origin `live_session_manager` when lazy persistence applies; verify that recovery then blocks rather than inventing disk durability.

Receipt files: `qa-rpc/transcript.jsonl` (non-secret control fields only), `qa-rpc/header.json`, `qa-rpc/qa-receipt.json`, `qa-rpc/cleanup.json`. Compact usage and live continuation are deliberately unverified against a paid provider, not marked PASS; wire behavior and zero-cost bridge/replacement behavior are tested on the real installation. Failure to obtain a required observable is a blocker, never permission to call a provider.

## Execution waves

All todos are HEAVY except documentation-only sections within Todo 9. Workers have disjoint file ownership; parallel cap is two implementers, consistent with the accepted provider limits. Subscribe to native child completion; do not arm a redundant monitor on an LLM child, and remove a real QA monitor immediately when its exact event fires. Each DoneClaim receives a fresh independent `omo-senpi-gate-reviewer` before its checkbox closes. Reviewer-authored executable probes/tests also route implementer; reviewers can supply data-only attack scenarios under evidence without editing code.

| Wave | Todos | Dependency / reason |
| --- | --- | --- |
| 1 | 1, 2 in parallel | independent wire and pure policy contracts |
| 2 | 3, 4 in parallel | both after 1; host ownership and bridge contracts |
| 3 | 5, 6 in parallel | snapshot after 2/4; storage after 3; no overlapping files |
| 4 | 7 then 8 | compose all seams, then recover exact crash windows |
| 5 | 9 | CLI/live surface and documentation use finalized contracts |
| Final | F1, F2 in parallel; F3 after both | isolated evidence roots, no overlapping real runtime store |

## TODOs

- [ ] 1. Implement strict RPC transport and deterministic subprocess harness.
  Recommended task executor category: `implementer`. Allowed files: `__init__.py`, `rpc.py`, `tests/conftest.py`, `tests/fake_rpc.py`, `tests/test_rpc.py` under the source root. Depends on: none.
  RED/GREEN: `test_lf_only_framing`, `test_malformed_invalidates_gate_without_desync`, `test_duplicate_response_consumed_once`, `test_response_event_orders`, `test_eof_rejects_pending_requests`. Include primitive/array/truncated/invalid-UTF8/oversized/Unicode-separator frames, unknown additive events, wrong request command/id, duplicate responses, and process death mid-record.
  Exact RED then GREEN command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_rpc.py`.
  QA: real stdio fake subprocess exchanges correlated get_state responses plus interleaved events; capture sent/received frames, prove bounded reader and zero orphan subprocesses. Artifacts: `task-1/red.txt`, `green.txt`, `rpc-transcript.jsonl`, `cleanup.json` under evidence root. Static/LSP common gates apply to these files. Always close pipes and wait for fake process exit in finally.

- [ ] 2. Implement context thresholds and Backstop policy, without turn-limit invention.
  Recommended task executor category: `implementer`. Allowed files: `policy.py`, `tests/test_policy.py`. Depends on: none.
  RED/GREEN: `test_normalized_context_excludes_output_and_children`, `test_compact_first_at_160k_and_180k`, `test_after_120000_stays_120001_rolls`, `test_compaction_epoch_invalidates_old_usage`, `test_missing_estimate_blocks`, `test_backstop_seconds_codex_claude_credit`, `test_rate_limit_is_not_credit_exhaustion`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_policy.py`.
  QA: pure policy invoked with 159999/160000/180000 and 120000/120001, cached-only usage, duplicated message, null stats after compact, NaN/negative/missing fields and billing-mode switch using a fake clock. Capture decision JSON; no actual waiting or paid calls. Artifacts: `task-2/red.txt`, `green.txt`, `policy-receipt.json`, `cleanup.json`. Common static/LSP gates; only temporary data removed.

- [ ] 3. Implement native Windows ownership and process lifecycle.
  Recommended task executor category: `implementer`. Allowed files: `host.py`, `tests/test_host.py`. Depends on: 1.
  RED/GREEN: `test_wsl_rejected_before_store_access`, `test_same_host_single_owner`, `test_foreign_host_lock_unchanged`, `test_pid_reuse_not_owner`, `test_stale_metadata_requires_both_exits`, `test_job_close_reaps_owned_child`, `test_existing_main_prevents_second_main`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_host.py`.
  QA: two real Windows controller contenders synchronized by events against one temp lock; exactly one obtains it. Spawn one fixture child, close its Job Object, await native exit; no image-name kill. Simulated WSL markers exit 3 before any write/spawn, foreign host and unknown liveness fail closed. Artifacts: `task-3/red.txt`, `green.txt`, `host-receipt.json`, `cleanup.json`. Common gates. Retain permanent production lock inode; remove only fixture roots after handles close.

- [ ] 4. Implement generation-safe deterministic bridge and switch guard.
  Recommended task executor category: `implementer`. Allowed files: `bridge.mjs`, `bridge-state.mjs`, `bridge-compat.mjs`, `tests/bridge.test.mjs`. Depends on: 1.
  RED/GREEN: `freeze-pauses-goal-not-completes`, `unknown-monitors-block`, `switch-guard-rejects-new-activity`, `concurrent-completion-invalidates-permit`, `stale-generation-cannot-restore`, `restore-todos-exactly-once`, `compat-version-fails-before-mutation`, `blocked-goal-never-auto-activated`.
  Exact command: `node --test .omo/tools/rpc_rollover/tests/bridge.test.mjs`.
  QA: invoke registered handlers through an in-memory ExtensionAPI harness preserving event ordering and actual Goal/todo persistence adapter semantics; verify all project handler schemas, revision fence, child-completion delivery, and old-context rejection. Actual installed bridge QA is mandatory in Todo 9; mocks alone do not prove compatibility. Adversarial: unknown wake sources, monitored/background jobs, user input during freeze, unsupported exports, corrupt restore hash, duplicate/foreign transaction. Artifacts: `task-4/red.txt`, `green.txt`, `bridge-receipt.json`, `cleanup.json`. LSP on all four files plus node syntax gates; no provider, package edit, or global state mutation.

- [ ] 5. Capture authoritative snapshots and build immutable handoffs.
  Recommended task executor category: `implementer`. Allowed files: `snapshot.py`, `tests/test_snapshot.py`. Depends on: 2, 4.
  RED/GREEN: `test_active_leaf_not_last_append`, `test_goal_object_not_markdown_guess`, `test_native_todo_statuses_preserved`, `test_terminal_record_live_owner_blocks`, `test_completion_epoch_must_be_consumed`, `test_snapshot_revision_changes_cancel_gate`, `test_prompt_data_cannot_change_work_scope`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_snapshot.py`.
  QA: real fixture task/JSONL/Goal files with branch forks, complete versus DoneClaim, delivered and pending epochs, lost-but-live owner, and malformed file snapshots. Assert machine snapshot hashes and byte-equal copied objective/todos, not prose sentences. Handoff references validated owned paths; malicious transcript text cannot select Stage 11 or a shell command. Artifacts: `task-5/red.txt`, `green.txt`, `snapshot.json`, `handoff.md`, `cleanup.json`. Common gates; fixture roots only.

- [ ] 6. Implement durable transaction storage and narrow Boulder transitions.
  Recommended task executor category: `implementer`. Allowed files: `storage.py`, `tests/test_storage.py`. Depends on: 3.
  RED/GREEN: `test_checkpoint_precedes_switch_intent`, `test_fsync_failure_prevents_send`, `test_boulder_cas_preserves_foreign_bytes`, `test_session_id_appended_once`, `test_status_restores_active_not_in_progress`, `test_disk_full_preserves_previous_checkpoint`, `test_foreign_temp_not_deleted`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_storage.py`.
  QA: real temp filesystem with deterministic failures before/after flush/rename/checkpoint pointer/Boulder CAS; preserve previous bytes, original foreign Stage 11 object, and append-only ledger. Malformed JSON/duplicate work keys/schema mismatch/junction escape/stale hashes fail before mutation. Use fixture Boulder, never live paused work. Artifacts: `task-6/red.txt`, `green.txt`, `storage-receipt.json`, `cleanup.json`; common gates. Delete only nonce-owned temp artifacts, preserve failed transaction evidence.

- [ ] 7. Compose the state machine and full fake-RPC transaction.
  Recommended task executor category: `implementer`. Allowed files: `machine.py`, `tests/test_machine.py`; scenario additions in `tests/fake_rpc.py` only after Todo 1 closes. Depends on: 1-6.
  RED/GREEN: `test_observe_compact_safe_point_checkpoint_replace_rebind`, `test_compact_under_limit_no_new_session`, `test_failure_or_over_limit_rollover`, `test_never_switch_with_live_child_or_monitor`, `test_concurrent_completion_before_guard`, `test_duplicate_session_replaced_one_rebind`, `test_stale_identity_no_prompt`, `test_cancelled_switch_stays_paused`, `test_provider_exhausted_no_paid_resume`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_machine.py`.
  QA: execute actual controller against real scripted subprocess; assert command envelopes, parentSession path, event/response ordering, one new id append, exact native restore readback, one permitted prompt, active restore only after acceptance proof. Inject malformed RPC, contradictory compact outcomes, failed prompt/queued/handled dispositions, and completion at the final guard boundary. No timer races. Artifacts: `task-7/red.txt`, `green.txt`, `sent.jsonl`, `machine-receipt.json`, `cleanup.json`; common gates. Cleanup waits on fixture child exit and preserves receipts.

- [ ] 8. Implement crash recovery with no duplicate main or continuation.
  Recommended task executor category: `implementer`. Allowed files: `recovery.py`, `tests/test_recovery.py`; narrowly needed `machine.py` recovery integration. Depends on: 7.
  RED/GREEN: `test_crash_between_checkpoint_and_rebind`, `test_new_session_send_intent_never_blindly_replayed`, `test_no_duplicate_main_after_owner_crash`, `test_live_old_owner_blocks_recovery`, `test_lazy_unpersisted_replacement_blocks`, `test_exact_prompt_sentinel_prevents_duplicate`, `test_unrelated_user_message_not_rebind`, `test_recovery_idempotent_twice`, `test_corrupt_middle_ledger_blocks`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_recovery.py`.
  QA: subprocess crash injection at every durable side-effect boundary, including checkpoint/new_session send/event/Boulder append/restore/prompt acceptance/release. Barriers report exact crash point before termination; restart only after actual exit. Count spawned mains, live process overlap, new_session sends, id appends, and prompt sentinels. Ambiguous empty-new-session and lost prompt receipt must return exit 4 with zero retry. Artifacts: `task-8/red.txt`, `green.txt`, `crash-matrix.json`, `cleanup.json`; common gates. No hidden retries, dropped child completions, foreign file deletion, or second model session.

- [ ] 9. Deliver CLI, installed-RPC QA, and operator documentation.
  Recommended task executor category: `implementer` for all code/tests/scripts; README prose may remain with that cohesive worker and gets no prose tests. Allowed files: `cli.py`, `__main__.py`, `qa.py`, `tests/test_cli_qa.py`, `README.md`. Depends on: 8.
  RED/GREEN: `test_cli_import_from_project_root`, `test_qa_request_allowlist_forbids_provider_commands`, `test_runtime_paths_reject_stage11`, `test_qa_lazy_header_is_not_disk_claim`, `test_status_read_only`, `test_cli_replay_exit_and_cleanup`, `test_prompt_requires_explicit_live_grant`.
  Exact command: `uv run --frozen --offline pytest -q -p no:cacheprovider .omo/tools/rpc_rollover/tests/test_cli_qa.py`.
  Run every common final command, including compileall and real `qa-probe`, once against final bytes. The CLI's replay gives runnable end-to-end proof of compact/prompt behavior using the fake; the installed RPC probe separately proves real replacement/bridge/native lifecycle without provider calls. README explains all commands, thresholds, Backstop seconds/caveat, paused Goal versus blocked transaction, explicit live opt-in, version-pinned bridge, lazy persistence, and manual ambiguous recovery. Artifacts: `task-9/red.txt`, `green.txt`, `static.txt`, `final-replay/`, `qa-rpc/`. Restore environment; remove owned build cache/QA runtime profiles/temp roots and await every handle/process close, preserving compact receipts and non-secret transcripts.

## Final Verification Wave

- [ ] F1. Independent contract, diagnostics, tests, and build gate.
  Executor: fresh `omo-senpi-gate-reviewer`, read-only source review. Independently run the complete Python suite, Node suite, Ruff, basedpyright, node syntax, external compileall, CLI help/replay, lock check and diff check commands above, with fresh evidence root `gates/f1/`; require all changed-file LSP results. Audit each plan requirement to test/QA evidence and confirm no prose pins, sleeps, timer-luck tests, type/lint suppression, duplicate product tests, or paid calls. Inspect the actual run evidence, not only the worker summary. Write `gates/f1-verdict.md`, verdict `confirmed` only on current bytes. Existing unrelated failures are recorded separately and never repaired under this plan. Cleanup owned cache/temp/process resources, preserving evidence.

- [ ] F2. Independent adversarial and actual Windows RPC gate.
  Executor: fresh `omo-senpi-gate-reviewer`. Supply data-only attack scenarios to the shipped replay CLI; any new executable test/probe edits must be delegated to implementer. Independently exercise malformed RPC, duplicate responses/events, stale durable identity/generation, concurrent child completion, lost-but-live child, unknown/nonzero monitors, foreign-host/WSL refusal, crash between checkpoint/rebind, lazy persistence, and **no duplicate main** / no duplicate prompt recovery. Run `uv run --frozen --offline python -m rpc_rollover qa-probe --out C:/dev/searchad-evidence/rollover-sidecar/gates/f2/qa-rpc` on the same Windows host using isolated QA state. Demand the real observables and provider-command absence specified above. Write `gates/f2-verdict.md`, machine attack matrix, transcript and cleanup receipt. Any unproven atomic guard or uncertain retry treated as success is `needs-fix`.

- [ ] F3. Scope, paused-work preservation, cleanup, and final DoneClaim.
  Executor: fresh `omo-senpi-gate-reviewer`, after F1/F2 confirmed and all child/QA monitors terminated. Compare baseline/final full content manifests and Git index/status. Only the enumerated allowlist may differ; Stage 11 plan/handoff/shared ledger and exact Boulder object, product files, worktree, settings, dependencies and package-managed files must be unchanged. Verify no real provider request, no installed-file edit, no lingering child/Job Object/handle/environment/cache/temp resource, no deleted foreign marker, and no stage/commit occurred. Retain only declared source, plan/prompt, sidecar execution evidence and legitimate runtime receipts; never blanket-delete a live runtime root. Write `gates/f3-verdict.md` and final DoneClaim with exact changed paths, commands/results, installed-RPC observables, cleanup, and explicitly untested paid-provider continuation. Only independent `confirmed` allows all checkboxes to close and this new Boulder work to complete. Stage 11 stays paused.

## Completion condition

The project-local sidecar and bridge satisfy the named tests and real zero-provider RPC QA; all three final gates are independently confirmed; only allowed files changed; no duplicate main or uncertain resend is possible; Stage 11 remains paused; no commit or paid provider test occurred. Live provider compaction/continuation is a later explicitly authorized operational launch, not an implementation verification shortcut.
