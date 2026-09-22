# Idle-cost experiments: offline plans and dry-run runner

These are **plans**, not runs. `scripts/idle-experiments.mjs` prints the experiment designs that
AGENT_TASK section 7 asks for and refuses every execution path. It has no network client, no
request adapter, no timer and no scheduler, so no flag can make it spend quota. Nothing here
establishes a quota saving; every cost line stays coefficient-dependent until a
provenance-bearing coefficient record exists.

## Commands

```
node scripts/idle-experiments.mjs                 # all plans, dry-run (default), exit 0
node scripts/idle-experiments.mjs --plan=<id>     # one plan
node scripts/idle-experiments.mjs --json          # same content, machine-readable, exit 0
node scripts/idle-experiments.mjs --execute       # refused, exit 2, nothing runs
node scripts/idle-experiments.mjs --execute --help  # still refused, exit 2 (no flag outranks it)
node --test test/idle-experiments.test.mjs        # 28 safety tests
```

Machine consumers read the `machine` line of each plan, the `totals:` line, or `--json`
(`summaries[]`, `totals`, `observationCostBasis`). The prose layout is not a contract.

Plan ids: `output-quota`, `fable-write-tick`, `ttl-1h-unique-prefix`, `restore-decomposition`,
`policy-effect`.

## Safety contract (enforced by tests, not by prose)

| Rule | Where it is enforced |
|---|---|
| Default mode is dry-run; `executable` is `false` on every plan | `validatePlan` returns `executable_must_be_false`; CLI never flips it |
| `--execute` exits nonzero and issues nothing, whatever else is on the command line | the refusal is decided **before** parsing, so `--execute --help`, `--help --execute`, `--execute --json` and `--execute --nuke` all exit 2 with `no_execution_approval` and print nothing on stdout |
| No network, timer, scheduler or filesystem write | source scan test rejects `node:http(s)/net/tls/dgram/child_process/worker_threads`, `fetch(`, `setTimeout(`, `setInterval(`, `setImmediate(`, `Atomics.wait`, `writeFileSync`, `mkdirSync`, `execSync`, `spawnSync` |
| No side effects in any mode | CLI runs in a temp cwd; the directory stays empty after dry-run, `--execute` and a malformed command line |
| No invented measured quota | `invented_measured_quota` if `spend.measuredQuotaEstimate` is not `null`; `unsupported_spend_status` for anything but `coefficient_dependent`/`unknown` |
| All five approval settings stay unconfigured | every limit in `budget.limits` is `"unconfigured"`; `missing_required_limit`, `unknown_limit`, `malformed_limit`, `malformed_cap_value`, `negative_cap`, `numeric_cap_without_unit`, `wrong_limit_dimension`, `wrong_limit_unit_dimension`, `partial_spend_limits`, `budget_unit_conflict` |
| An explicit `0` is a real setting, not a missing one | `limitState()` returns `unconfigured` / `unlimited` / `numeric`, and `spendAllowance()` returns `unconfigured` / `zero` / `positive` / `unlimited`. A numeric `0` validates clean and means **zero allowed spend**; it is never conflated with `unconfigured` or `unlimited` |
| A zero spend cap binds the whole allowance | the most binding spend cap decides. If **either** `maxTotalExperimentalSpend` or `maxProactiveSpendPerIdle` is `0`, `spendAllowance()` is `zero` — a positive or even `unlimited` cap beside it cannot restore positive spend. A total of zero permits nothing at all |
| Approval currency is judged against an injected time | `validatePlan(plan, { now })` — never the wall clock. `malformed_approval_timestamp`, `cap_without_approval`, `approval_without_cap`, `approval_without_expiry`, `stale_budget_approval` (expiry must be after `now`, after `approvedAt` and after `preparedAt`), and `future_budget_approval` when `approvedAt` is **after** `now` — an approval that has not been granted yet is not a current approval |
| The block reason cannot go stale | `stale_block_reason` if `budget_unconfigured` is claimed while every limit is set; `missing_block_reason` if a limit is unconfigured and the reason is absent |
| Malformed input is reported, not thrown | `not_a_plan_object`, `bad_plan_id`, `malformed_prepared_at`, `no_requests`, `bad_request_count`, `bad_request_offset`, `paid_flag_mismatch`, `unknown_arm`, `expected_request_total_mismatch` |
| No extra request can be smuggled in, at a new offset **or** at an approved one | each arm declares `paidCalls: [{ offsetMin, count }]`; changing timing or multiplicity raises `arm_call_plan_mismatch`, the cross-check against `intendedPaidCalls` raises `intended_call_count_mismatch`, and `probeBudget` raises `probe_count_mismatch`. Tampering with a single field is not enough to pass |

Paid model requests and meter readings are counted separately: `expectedRequests` counts only
requests that would be billed, `expectedObservations` counts quota-meter readings.
`kind: "observation"` must have `paid: false`, everything else must have `paid: true`.

**A meter reading is not claimed to be free.** It is not a model request, but this repository has
no evidence about what reading the meter costs, so every plan carries
`observationCost: "unknown"` and the JSON output carries
`observationCostBasis: "unmetered_in_this_repository"`. `unsupported_observation_cost` rejects any
plan that claims otherwise — including one that claims `0`.

## The five plans

### 1. `output-quota` — 12 paid requests, 6 meter readings (cost unknown)

Three levels (~250, ~2000, ~8000 output tokens). Each level establishes **its own unique
prefix** with one cache write, then issues three bounded-output requests on that prefix, so the
input, cache-read and cache-write contributions are held constant while only the output varies.
`k_output` is reported as identifiable only if input/read/write stay constant and no quota
window resets mid-run; otherwise the result is `not_identifiable`, not a number.

### 2. `fable-write-tick` — 2 paid requests, 12 meter readings (cost unknown)

One 1h-lane write and one 5m-lane write, each alone in its observation window, each with gauge
readings at t-1, +1, +3, +10, +30 and +60 minutes so a **delayed tick** is captured instead of
assumed. The 6-tick and 8-tick readings stay as two hypotheses until a reset-free, single-request
window resolves them. The 5m coefficient is never reused as the 1h default.

### 3. `ttl-1h-unique-prefix` — 5 paid requests, 4 meter readings (cost unknown)

| Arm | Paid steps | Prefix |
|---|---|---|
| treatment | t+0 write, t+55min ping, t+110min check | `unique-prefix-A` |
| control | t+0 write, t+110min check | `unique-prefix-B` |

Exactly one intermediate probe exists (the t+55min ping), because a probe can itself renew the
TTL. The design fixes **exactly 5 intended paid calls** (`intendedPaidCalls: 5`), and each arm
declares them as `paidCalls: [{ offsetMin, count }]`, so multiplicity is pinned as well as
timing: a *second* call at the already-approved t+55min offset is rejected
(`arm_call_plan_mismatch`) even though no new offset appears. `intendedPaidCalls` is
cross-checked against `expectedRequests` and the per-arm totals, so editing one field to cover
the extra call raises `intended_call_count_mismatch` instead of passing. `probeBudget: 1` adds
`probe_count_mismatch`. A hit on the shared system/skill prefix is not a hit on the unique
experiment segment (`sharedSystemPrefixHitIsNotUniqueSegmentHit: true`). Renewal is
never inferred from `stop_reason` or message-end time; request arrival, response model, lane and
per-request usage are recorded together. One observation does not generalise to all sessions.

### 4. `restore-decomposition` — 19 paid requests, 4 meter readings (cost unknown)

Phase boundaries `warm | park_parent | restore_child | resume_raw | useful_work`, with per-request
`uncachedInput / cacheWrite5m / cacheWrite1h / cacheRead / billedModelOutput`. "First substantive
work" is the task-defined edit/command/verification, identical for both paths, not merely the
first response or tool call. Overlap checks are structured records, each with an `id` and the
`phases` it binds, so a consumer can match on the id instead of on prose:
`system_skill_prompt_not_double_counted` (`park_parent` / `restore_child`),
`restore_ids_disjoint_from_useful_work` (`restore_child` / `useful_work`) and
`parent_reads_logged_per_call` (`park_parent`). `Rw=6K` / `Rr=125K` remain unverified estimates
until this runs.

### 5. `policy-effect` — 24 paid requests, 4 meter readings (cost unknown)

Current policy (4 idle pings + 8 useful_work) versus the shadow candidate (1 park write + 3
restore + 8 useful_work) on **the same task with the same restore scope and the same completion
endpoint**. Outcomes: total quota per meter, resume delay, failure/re-explanation, rework. A run
whose quality guard trips counts as a failure, not as a cheaper result. One pair of runs is not a
general saving claim.

## Approval table (AGENT_TASK section 7 format)

All five approval settings below are `unconfigured` for every experiment, each with its own
dimension and its own unit — they are never expressed in a shared unit:
`maxProactiveSpendPerIdle` and `maxTotalExperimentalSpend` (spend), `maxResumeDelay` (time, e.g.
`ms`), `allowedQualityDegradation` (quality, e.g. `lost_context_events`) and
`minimumEvidenceForEnforcement` (evidence, e.g. `paired_runs`). `unconfigured` means *not set*;
a numeric `0` would mean *zero allowed*, and the two are never merged.

| Experiment | Measures | Call plan | Approval settings (all five `unconfigured`) | Stop conditions | Effect if not executed |
|---|---|---|---|---|---|
| output-quota | `k_output` with input/read/write held constant | 3 levels x (1 write + 3 bounded-output) = **12 paid**, 6 gauge | spend caps must be approved in a spend unit before the run; the other three settings keep their own units | quota reset, truncated/refused output, concurrent account use, unconfigured cap | `k_output` stays unknown; the DP keeps a scenario range and no output-side saving may be claimed |
| fable-write-tick | ticks per Fable write, 1h and 5m lanes apart | **2 paid** writes, 12 gauge | the spend cap must be expressed in the same meter as the quota gauge; `maxResumeDelay` stays in a time unit | any other request in a window, a reset boundary inside a window, gauge unsettled at t+60min | the 6/8-tick question stays open; both hypotheses stay in the record and no write coefficient is "measured" |
| ttl-1h-unique-prefix | does a t+55min ping renew the 1h TTL | treatment 3 + control 2 = **5 paid**, 4 gauge, no other probe | the spend cap must cover exactly 5 paid calls including 2 large prefix writes | unplanned request on either prefix, missed time window, lane/model change, failed step | TTL renewal stays uncertain; warm/cold/uncertain remain three states and enforcement may not rely on ping renewal |
| restore-decomposition | real read/write/output per phase and the true restore endpoint | park 12 + raw 7 = **19 paid**, 4 gauge | spend caps must be stated per meter if the account has several limit windows | cap exceeded, missing phase boundary, diverging task scope, incomparable meters | `Rw`/`Rr` stay unverified; restore cost keeps an explicit uncertainty range |
| policy-effect | total quota, resume delay, quality outcomes | 12 + 12 = **24 paid**, 4 gauge | this comparison needs all five: two spend caps, `maxResumeDelay` in a time unit, `allowedQualityDegradation` in a quality unit and `minimumEvidenceForEnforcement` in an evidence unit | task-scope divergence, quality guard trip, any live policy change, generalisation from one pair | the policy comparison stays unmeasured; shadow records stay recording-only and are not a quota saving |

Total if every plan were approved: **62 paid requests** and 30 meter readings whose own cost is
unknown. None of them can be issued from this repository; the dry-run reports
`paidRequestsPlanned=62 paidRequestsIssued=0 executable=0`.

## Approval proposal

The [approval proposal](idle-experiments-approval-proposal.md) (Korean, signable) and its [machine-readable copy](idle-experiments-approval-proposal.json) define the complete experimental limits and order for all five plans. The JSON carries `status: "proposed"` with `approvedAt: null` and is not an approval; it becomes an approval only when explicitly signed and updated. `scripts/idle-experiments.mjs --execute` still exits 2, and no runner exists yet to carry out the experiments.

## Contamination and stop conditions that apply to all five

- Concurrent requests or a second session on the same account make gauge deltas unattributable;
  never run two quota/TTL experiments on one account at the same time.
- A quota reset or budget rollover inside a run voids that run; windows are never stitched.
- Delayed gauge ticks and rounding can push cost into a neighbouring window: record the raw
  timestamps and attribute only inside a single-request, reset-free window.
- A failed, refused or model-fallback response is its own state: stop, do not auto-retry, and
  treat the cache state afterwards as unknown.
- A shared system/skill prefix hit is never counted as a unique-prefix hit.

## Why the runner cannot wait

The plans contain t+55min and t+110min steps, but the runner never sleeps, schedules or polls.
It prints the schedule; the timing belongs to an approved, separately reviewed runner. That is
why the source scan test forbids `setTimeout(`, `setInterval(`, `setImmediate(` and
`Atomics.wait`.

## DoneClaim

- **Task:** plan task 4 — "Prepare safe offline experiment plans and dry-run runner".
- **Scope touched:** `scripts/idle-experiments.mjs`, `test/idle-experiments.test.mjs`,
  `docs/idle-experiments.md`, and evidence under
  `.omo/ulw-execute/evidence/idle-cost-shadow/task4/`. No other file was modified by this task.
  Four of the five preserved dirty-baseline files (`README.md`, `README.ko.md`,
  `docs/field-notes.md`, `test/rollover.test.mjs`) are still byte-identical to the task-1
  manifest. The fifth, `extension/rollover.ts`, is **not**: it changed from `b9cca47f…` to
  `08f5bc24…` at 03:57 local, +643/-3 lines. That is a concurrent worker's idle-cost engine
  (`IDLE_COST_ENGINE_VERSION`, `convertUsage`, `cacheStateAtArrival`, …) consumed by
  `test/idle-cost.test.mjs`, not task-4 work — this task issued no edit to it and neither
  `scripts/idle-experiments.mjs` nor `test/idle-experiments.test.mjs` references it. It is
  recorded here rather than silently re-baselined; the task-4 scope suite passes against it.
- **Corrections applied after an independent review.** The first version of this task was
  returned `needs-fix` (`.omo/ulw-execute/evidence/idle-cost-shadow/verify4/findings.md`). Six
  defects were fixed, each with a failing-first regression: (1) a numeric `0` cap was rejected as
  `zero_cap_ambiguous`, conflating *zero allowed* with *not set* — zero is now a valid explicit
  setting; (2) the budget carried only three caps in one shared unit — it now carries all five
  approval settings, each with its own `value`/`unit`/`dimension`; (3) approval expiry was judged
  against `preparedAt` only — it is now judged against an injected `now`, so an expired approval
  cannot be rescued by an old preparation date; (4) meter readings were documented as costing
  "nothing" with no evidence — they are now `observationCost: "unknown"` with
  `observationCostBasis: "unmetered_in_this_repository"`, and a claimed `0` is rejected; (5) arms
  declared only offsets, so a second call at an already-approved offset passed — they now declare
  `paidCalls` with multiplicity, cross-checked against `intendedPaidCalls`; (6) `--execute --help`
  exited 0 — the refusal is now decided before parsing and no flag can outrank it. Tests that
  pinned prose were replaced with assertions on machine fields (`planSummary`, `limitState`,
  `spendAllowance`, the `machine=` line, structured `overlapChecks` ids).
- **RED history, corrected.** An earlier version of this claim overstated the artifact; this is what
  the logs actually contain, and the logs themselves were not edited.
  - `red-node-test.out.txt` (exit 1, 20 of 21 failing) is **synthetic**: it was produced against a
    deliberately unsafe stub, not by writing the tests first. Its budget test failed on undefined
    caps and its first validity test threw before reaching the `executable === false` check.
  - `red2a-missing-exports.out.txt` (exit 1) is a **module-load failure** — the new named exports did
    not exist yet. It demonstrates missing exports and proves nothing semantic.
  - `red2b-semantic.out.txt` (exit 1, 17 of 25 failing) was produced against **temporary
    compatibility stubs**, and contains **16 `AssertionError` entries plus one `TypeError`**
    (`Cannot set properties of undefined (setting 'extraLimit')`) — the missing-limit test died on
    its fixture, not at its intended assertion. Several other tests stopped early rather than
    exercising the behaviour they are named for: the TTL test stopped at `intendedPaidCalls`
    `undefined` vs `5`, *before* the multiplicity checks, and the approval test stopped at a
    malformed `approvedAt`, *before* its expiry assertions. The zero-cap fixture used the new
    limits schema against the old caps validator, so its
    `['no_budget_caps','approval_without_cap']` result is a **schema mismatch**, not specific proof
    of the old `zero_cap_ambiguous` behaviour. Of that batch, the `--execute --help` nonzero
    assertion is genuine targeted RED. The stubs were deleted in the fix; no scaffold remains in
    the shipped script.
  - `red3-recheck1-blockers.out.txt` (exit 1) **is** a genuine targeted RED, written before the
    corresponding fix: 3 of 28 tests failing, all three `ERR_ASSERTION` at their intended
    assertions — `output-quota must not assert that meter readings are free`, `a zero total
    experimental spend cap binds`, and `approval in the future must be rejected, got []`. The other
    25 tests passed unchanged, so the failures are attributable to the three new contracts alone.
  - Taken together: GREEN is sound, but these stages are **not** independent proof of a test-first
    implementation, and this document does not claim one.
- **Second review round (recheck1).** Three code defects and one inaccurate claim were returned and
  fixed: the `output-quota` approval row still said meter readings "cost nothing" (removed from the
  data, so it is gone from the dry-run and `--json` output too); a zero `maxTotalExperimentalSpend`
  beside a positive per-idle cap reported `spendAllowance: "positive"` (a zero cap now binds); and
  an `approvedAt` in the future validated as current (`future_budget_approval`). The RED summary
  above was corrected in the same round. The reviewer's own reproduction probe
  (`verify4/recheck1/probes.mjs`) now reports **29 of 29 cases PASS**, including
  `total-zero-proactive-positive` → allowance `zero` with `[]` issues and `approval-future` →
  `["future_budget_approval"]`.
- **GREEN:** `node --test test/idle-experiments.test.mjs` → 28/28 pass, exit 0 —
  `green-node-test.out.txt`. Scope suite
  `node --test test/rollover.test.mjs test/idle-experiments.test.mjs` → 94/94 pass (66 baseline +
  28 new), exit 0 — `full-suite-node-test.out.txt`. Both pass in a single run; no test sleeps,
  polls or waits on a timer.
- **Pre-existing failure, not mine:** a later `node --test test/*.mjs` glob run exits 1 because
  the concurrent task-2 worker added `test/quota-analysis.test.mjs`, whose
  `scripts/quota-analysis.mjs` does not exist yet (ERR_MODULE_NOT_FOUND). Task-4 scope re-runs
  clean: `node --test test/rollover.test.mjs test/idle-experiments.test.mjs` → 94/94, exit 0.
- **CLI (actually executed, outputs captured):** `node scripts/idle-experiments.mjs` → 5 plans,
  one `machine=` line each, `totals: plans=5 paidRequestsPlanned=62 paidRequestsIssued=0
  executable=0`, exit 0 (`cli-dry-run.out.txt`). `--execute` → exit 2 with
  `no_execution_approval` / `budget_unconfigured` / `no_request_adapter` and empty stdout
  (`cli-execute-refused.out.txt`); `--execute --help` → exit 2
  (`cli-execute-help-refused.out.txt`); `--help --execute` → exit 2
  (`cli-help-execute-refused.out.txt`); `--nuke` → exit 2 `unknown_argument`
  (`cli-unknown-arg.out.txt`). `--json` parses with `executed:false`, `requestsIssued:0`,
  `networkAdapter:null`, `scheduler:null`,
  `observationCostBasis:"unmetered_in_this_repository"`, `totals.observations:30`, and every
  summary `observationCost:"unknown"` (`cli-json.out.txt`).
- **Adversarial classes covered:** malformed_input (non-object plans, bad ids/counts/offsets,
  `NaN`/`Infinity`/negative caps, missing limits and units, broken totals, unknown flags and plan
  ids), stale_state (expired approval against an injected `now`, approval without cap, cap
  without approval, malformed timestamps, conflicting spend units, partial spend limits, a block
  reason that contradicts the budget), misleading_success_output (`--execute` exits nonzero on
  every path including with `--help`; no free-cost claim survives; source scan forbids
  network/timer/write APIs), dirty_worktree (temp-cwd side-effect check in all four modes; every
  temp cwd is removed in a `finally` block, and 26 leftover `idle-exp-*` directories from earlier
  runs were removed — receipt in `temp-cleanup-receipt.txt`), hung_commands (the CLI runs as a
  real child process under a 15s bound with `SIGKILL`; the tests assert `signal === null`, i.e.
  it terminated on its own rather than being killed).
- **Not claimed:** no measured coefficient, no quota estimate, no TTL fact and no saving. Every
  cost line stays coefficient-dependent, the cost of a meter reading is `unknown` rather than
  free, and all five approval settings are `unconfigured` — which is neither `0` nor `unlimited`.
  No commit was made.
