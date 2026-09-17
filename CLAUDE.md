# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Senpi/OMO extension: `extension/rollover.ts` hands a long-running OMO main session off to a fresh session once context passes a token budget, plus a JSONL event log and a static dashboard. README.md is the authoritative spec: state machine, signals, goal pause, skill continuity, event log schema. Read it before changing behavior. `docs/field-notes.md` records live defects and why each design decision exists; `docs/microworld.html` is the reference visualization.

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

- `extension/rollover.ts` exports pure helpers (`extractSuccessor`, `detectActiveSkill`, `withSkillToken`, `handoffPrompt`, `pauseGoal`, `resumeGoal`, `goalStatus`, `loadGoalStore`, `idleVerdict`, `CONTEXT_BUDGET_BLOCK`, ...) and `createRollover(pi, deps)`, which wires the state machine onto senpi hooks (`session_start`, `before_agent_start`, `input`, `message_end`, `tool_call`, `turn_end`, `agent_settled`, `session_shutdown`) and registers `/rollover` (`now [force]`, `park`, `auto|on|off`, `limit <K> [save]`, `idle <min>|off`, `status`, `help`). The default export just calls `createRollover`. `deps` injects `env`, `now`, `pauseGoal`, `resumeGoal`, `goalStatus`, `timer` for tests; the returned object also exposes `tick`, `rearm`, `isAutonomous`, and `clocks()` so tests drive the idle path without real time.
- States: `watching -> armed -> handoff_requested -> rollover -> rolled_over`. Arming requires context >= budget (or an idle park); landing requires the child-session wake sum (`senpi-task`, `omo-dag` only) == 0 (unknown != zero) and no pending messages. `auto` mode (default) forces the handoff only in autonomous sessions (active goal or ulw-* skill). Spawn tools `task`/`task_create` are blocked in every state except `watching`.
- Child sessions (env `OMO_SENPI_TASK_RPC_CHILD` / `SENPI_TASK_MEMBER*`) register nothing.
- Persistence under `~/.omo/rollover/`: `sessions/<id>.jsonl` events, `state/<id>.json` (atomic tmp+rename, restored on any `session_start`), `summary.jsonl`, `config.json`. Field list in `PERSISTED`.
- `pauseGoal`/`resumeGoal`/`goalStatus` reach senpi internals (`dist/core/extensions/builtin/goal/`) via bare import or `process.argv[1]`/`OMO_BIN`; both routes are fragile by design and logged as `goal_pause{ok,method}` / `goal_resume{ok,method}`. `pauseGoal` returns ok:true only when an active goal was actually paused — a no-op read is not authorization to land in auto mode.
- `dashboard/build.mjs` embeds the log data into one HTML file; no server.

## Conventions

- Tests drive the state machine end to end through the fake harness; add a test for every new event or transition, and check the JSONL shape when adding an event (README "Event log" lists them).
- When changing the handoff prompt or `<successor>` contract, update README and the tests that assert prompt text (`handoff instruction:` and `arm records activeSkill`).
- Commit messages follow `rollover: <what changed>` (see git log).
