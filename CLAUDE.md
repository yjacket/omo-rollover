# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two standalone single-file Senpi/OMO extensions: `extension/rollover.ts` hands a long-running OMO main session off to a fresh session once context passes a token budget, plus a JSONL event log and a static dashboard; `extension/ulw-ledger-guard.ts` rewrites `read`/`bash` results of `.omo/ulw-execute/ledger.jsonl` into a ≤12 KB digest (README "ULW ledger guard"; no shared module between the two files by design). README.md is the authoritative spec: state machine, signals, goal pause, skill continuity, event log schema. Read it before changing behavior. `docs/field-notes.md` records live defects and why each design decision exists; `docs/microworld.html` is the reference visualization.

## Commands

```sh
node --test                                   # all tests (Node >= 22.6; .mjs tests import the .ts via built-in type stripping)
node --test --test-name-pattern="reload"      # single test by name substring
node dashboard/build.mjs                      # build dashboard/out/index.html from ~/.omo/rollover (or $OMO_ROLLOVER_DIR / dir arg)
node dashboard/build.mjs --sample             # from dashboard/sample/
node dashboard/sample/generate.mjs            # regenerate synthetic sample data
sh install.sh   |   .\install.ps1             # copy both extensions to ~/.omo/agent/extensions/, then /reload in omo
```

No build step, no lint, no dependencies. Never test against a live paid OMO session; the fake `pi`/`ctx` harness in `test/rollover.test.mjs` is the only runtime used.

## Architecture

- `extension/rollover.ts` exports pure helpers (`extractSuccessor`, `detectActiveSkill`, `withSkillToken`, `handoffPrompt`, `pauseGoal`, `CONTEXT_BUDGET_BLOCK`, ...) and `createRollover(pi, deps)`, which wires the state machine onto senpi hooks (`session_start`, `before_agent_start`, `message_end`, `tool_call`, `turn_end`, `agent_settled`, `session_shutdown`) and registers `/rollover`. The default export just calls `createRollover`. `deps` injects `env`, `now`, `pauseGoal` for tests.
- States: `watching -> armed -> handoff_requested -> rollover -> rolled_over`. Arming requires context >= budget; landing requires wake-source sum == 0 (unknown != zero) and no pending messages. Spawn tools `task`/`task_create` are blocked in every state except `watching`.
- Child sessions (env `OMO_SENPI_TASK_RPC_CHILD` / `SENPI_TASK_MEMBER*`) register nothing.
- Persistence under `~/.omo/rollover/`: `sessions/<id>.jsonl` events, `state/<id>.json` (atomic tmp+rename, restored on any `session_start`), `summary.jsonl`, `config.json`. Field list in `PERSISTED`.
- `pauseGoal` reaches senpi internals (`dist/core/extensions/builtin/goal/`) via bare import or `process.argv[1]`/`OMO_BIN`; both routes are fragile by design and logged as `goal_pause{ok,method}`.
- `dashboard/build.mjs` embeds the log data into one HTML file; no server.

## Conventions

- Tests drive the state machine end to end through the fake harness; add a test for every new event or transition, and check the JSONL shape when adding an event (README "Event log" lists them).
- When changing the handoff prompt or `<successor>` contract, update README and the tests that assert prompt text (`handoff instruction:` and `arm records activeSkill`).
- Commit messages follow `rollover: <what changed>` (see git log).
