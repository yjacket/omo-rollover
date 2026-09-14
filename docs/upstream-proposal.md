# Proposal for omo-ai: split `ulw-execute` resume state from the append-only ledger

Issue draft. Target: the `ulw-execute` / `ulw-loop` skills in omo-ai.

## Problem

`ulw-execute` appends one 1–2 KB JSON object per event (dispatch, done-claim, verification, remediation, ...) to
`<project>/.omo/ulw-execute/ledger.jsonl`, never rotates it, and tells the orchestrator that "plan and ledger are
the durable source of truth"; `ulw-loop` adds "after any compaction or context loss, re-read ... ledger FIRST".
An orchestrator therefore reads the whole file, in overlapping `offset/limit` slices, on every resume, compaction
and goal-continuation.

Measured on one real run (SearchAd Stage 11, 2026-09-13 → 09-15, see `docs/field-notes.md` in this repo):

- ledger grew to **224 events / 315 KB** (no timestamp field, 98 distinct `task` values, 46 event kinds);
- the original orchestrator session (`01a092d1`) read it **63 times** in a single session;
- goal-continuation after a handoff re-read plan + ledger + child transcripts for **+90K tokens** of context;
- a successor session read the previous session's JSONL 3× and one child transcript 6×.

What the orchestrator actually needs on resume is the latest event per task (which todo is dispatched /
done-claim / verified / completed) plus the last few events. That is ~10 KB of information carried in a 315 KB
file that only grows.

## Proposal

1. Keep the ledger append-only as evidence, unchanged.
2. Additionally maintain a small `.omo/ulw-execute/state.json` — the latest event per `task` (and per `event` for
   task-less events), written atomically (tmp + rename) on every ledger append:

   ```json
   { "updatedAt": "...", "events": 224, "tasks": { "<task>": { "n": 221, "event": "reverification-result", "session_id": "...", "verdict": "APPROVE" } } }
   ```

3. Change the resume instruction in `ulw-execute` and `ulw-loop` from "re-read the ledger FIRST" to
   "read `state.json`, then `tail -n 20 ledger.jsonl`; `grep` the ledger only for a specific task".
4. Optional: add a timestamp (`t`) to every ledger event; today there is none, so ordering is line order only.
5. Optional: rotate the ledger per plan (`ledger-<plan-slug>.jsonl`) so one long project does not accumulate
   every stage's evidence in one file.

## Why upstream

A client-side workaround exists (`extension/ulw-ledger-guard.ts` in this repo rewrites `read` results for the
ledger into a digest), but it can only shape reads that go through senpi's `read`/`bash` tools in the main session,
and it is a per-user install. The skill owns the file format and the resume instruction, so the durable fix
belongs there: separate state from evidence and tell the orchestrator to read the small one.
