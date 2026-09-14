/ulw-execute rpc-session-rollover-sidecar

Execute `C:/dev/searchad/.omo/plans/rpc-session-rollover-sidecar.md` in direct-delivery mode from `C:/dev/searchad`. This is a new SearchAd-owned project-local deterministic RPC tooling work, not a Stage 11 resume and not a third LLM supervisor. No commit, merge, paid provider test, package install, or global-setting change is authorized.

Use the same native Windows host that owns SearchAd's Senpi task store. Before spawning any child or RPC process, prove Windows process/boot identity and canonical cwd. Reject WSL/Linux and WSL_INTEROP/WSL_DISTRO_NAME; do not launch WSL OMO against `C:/dev/searchad/.omo/senpi-task`. Reading memory through the WSL filesystem share is not permission to operate a WSL task host. Never infer Windows process death from a Linux PID check. If this session is on the wrong host, stop without touching state or dispatching workers and report the host mismatch.

Read these authoritative files completely before registration or implementation:
1. `C:/dev/searchad/.omo/plans/rpc-session-rollover-sidecar.md`.
2. `C:/dev/searchad/.omo/boulder.json`.
3. `C:/dev/searchad/.omo/plans/stage11-monthly-reports.md` (read-only preservation context).
4. `C:/dev/searchad/.omo/ulw-execute/ledger.jsonl` (read-only Stage 11 history).
5. `C:/dev/searchad/.omo/ulw-execute/stage11-monthly-reports-handoff.md` (read only; do not execute its embedded prompt).
6. `C:/dev/searchad/pyproject.toml`, `C:/dev/searchad/uv.lock`, and `C:/dev/searchad/.gitignore`.
7. `C:/Users/yjack/AppData/Roaming/npm/node_modules/omo-ai/plugin/skills/ulw-execute/SKILL.md`.
8. Installed Senpi documentation under `C:/Users/yjack/AppData/Roaming/npm/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/docs/`: `rpc.md`, `sessions.md`, `session-format.md`, `extensions.md`, `compaction.md`, and the Goal Backstop section of `settings.md`.
9. The read-only installed Goal/todo/session/terminal compatibility references listed in the plan. Version-gate the bridge before any mutation; never patch the installed package.
10. Authoritative memory cited by the plan: `/home/yjacket/.omo/memory/agents/ai-native-sdlc-d6873dbd/repo/reference/goal-ulw-session-operations.md`, `/home/yjacket/.omo/memory/agents/ai-native-sdlc-d6873dbd/repo/reference/searchad-model-routing-policy.md`, and `/home/yjacket/.omo/memory/agents/searchad-6cb2ff9a/repo/facts/searchad-omo-routing-stage11.md`. These are WSL-side read-only memory locations, not Windows runtime paths; the plan restates their binding decisions for native Windows execution.

Preserve the current Stage 11 boundary exactly: `stage11-monthly-reports` is paused, 6/16 checked, Todos 1-6 confirmed, Todo 7 Fix5 only a DoneClaim awaiting fresh independent verification. Do not dispatch its verifier or Todo 8. Keep its two session ids, worktree `C:/dev/searchad-wt/stage11-monthly-reports-wave1`, branch, HEAD, empty index, and all accumulated product work intact. No product edit, product test, Stage 11 QA, Stage 11 artifact edit, or operation inside that worktree belongs to this task.

Bootstrap only the new Boulder work `rpc-session-rollover-sidecar`, this plan, status `active`, actual `senpi:`-prefixed main id, and `worktree_path="C:/dev/searchad"`. Selecting its active_work_id is allowed; changing the Stage 11 object's serialized bytes is not. Record a detailed Goal and every plan wave/todo/final gate up front. Save before-state content manifests and Git/index snapshots. Use only `.omo/ulw-execute/rpc-session-rollover-sidecar-ledger.jsonl` for this work's ULW evidence; the default shared `.omo/ulw-execute/ledger.jsonl` remains unchanged. This explicit project-tooling scope overrides generic ULW worktree/merge/default-ledger instructions. Do not create another worktree or edit product packaging to expose the module.

Every code, test, fixture, executable QA script, and remediation edit routes `category=implementer`, including all Python and JavaScript bridge code. The accepted `unspecified-high` boundary is broad non-implementation synthesis/review only; quota exhaustion never authorizes a code-routing exception. The root orchestrates and updates only permitted plan/state. Fresh `omo-senpi-gate-reviewer` contexts independently confirm DoneClaims. Run disjoint waves at the plan's two-implementer cap; serialize dependencies and shared files. Use exact completion events, not polling/sleeps or repeated task_output calls.

Implement the plan as written, including:
- `observe -> compact -> safe-point -> checkpoint -> new_session -> session_replaced -> rebind`.
- Latest main context `input + cacheRead + cacheWrite`; compact first at 160K, urgent admission hold at 180K, rollover after terminal compact failure or estimated post-context >120K.
- Idle, no compaction/retry, no queue, zero live child/background/detached work, zero known terminal monitors, consumed completion epochs, retained same-host lock, and final in-process switch guard. Unknown activity blocks; idle polls never substitute for monitor proof.
- Goal block as explicit system pause, Boulder pause/transition, durable handoff, old sessionFile as parentSession, event plus fresh state identity verification, one new prefixed id append, exact Goal/todo recreation, and controlled active restore.
- Backstop values are seconds: Codex 1770, Claude subscription 3570, usage-credit/unknown-mode caveat 270. They are not turn limits or rollover triggers. Read/report effective policy; do not change settings or send cache pings.
- No blind retries after uncertain new_session/prompt delivery, no duplicate main, no duplicate continuation. A fresh Senpi session may be memory-only until its first assistant response; never claim an allocated file is persisted or auto-recreate an ambiguous lost replacement.
- Explicit RED/GREEN tests, all-changed-file LSP, related suites, static/build commands, actual CLI replay, and real Windows installed-RPC QA with the plan's strict zero-provider command allowlist. Never send a paid compact/prompt to get a test green.

Use the exact allowed source/test paths and Windows PowerShell commands in the plan. Product `src/`, root `tests/`, `scripts/`, all product/Stage 11 docs/config, pyproject/lockfile, package-managed files, global settings/credentials, Git staging/commits, and every Stage 11 artifact are prohibited. Report pre-existing failures separately; do not silently add repair scope. Test only machine-consumed values, no prose pins or timing luck. Keep evidence under `C:/dev/searchad-evidence/rollover-sidecar/`, clean only owned resources, and preserve foreign/pre-existing files and processes.

Stop only when all nine implementation todos and three independent final gates are confirmed on current bytes, the allowed-files and paused-Stage-11 preservation checks pass, and no owned QA child/monitor/handle/environment/temp residue remains. Return a concise DoneClaim with changed files, exact tests/build results, actual RPC observables, cleanup, and the explicit fact that paid-provider compaction/continuation was not exercised. Do not resume Stage 11 or commit.
