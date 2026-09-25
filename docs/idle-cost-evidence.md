# Idle cost evidence: re-aggregated quota measurements

Source: `C:/dev/omo/omo-rollover/quota-test/2026-09-19/raw.jsonl` (sha256 `39fc7eb7356614d4d568d70347e88b5ddc5bfd062c0fc318bc43df3e83d57467`, 603 JSON lines).
Reported CLI trials: `C:/dev/omo/omo-rollover/quota-test/2026-09-19/trials.jsonl` (sha256 `ed52eb71e2ec3b8ef4bf3b5f307dd20641b90e5b69a4969d8bb39eb247c32e75`, 304 rows).

Reproduce:

```
node scripts/quota-analysis.mjs C:/dev/omo/omo-rollover/quota-test/2026-09-19/raw.jsonl --out docs/idle-cost-evidence.json --markdown docs/idle-cost-evidence.md
node --test test/quota-analysis.test.mjs
```

Machine readable form, including every request identifier cited below: `docs/idle-cost-evidence.json`.

**These figures do not establish any quota saving for any policy.** They bound how much
a quota gauge moved during a calibration capture, nothing more.

## 1. Raw usage totals

603 captured rows: 299 `/v1/messages` responses with usage and 304 non-billable transport rows.
Duplicates dropped: 0. Usage conflicts: 0. Malformed lines: 0. Structurally invalid rows: 0. Requests with usage warnings: 0.

| field | tokens |
| --- | --- |
| `uncachedInput` | 4,122 |
| `cacheWrite5m` | 4 |
| `cacheWrite1h` | 9,395,995 |
| `cacheWriteUnknownTtl` | 0 |
| `cacheRead` | 20,555,717 |
| `billedModelOutput` | 2,840 |
| requests | 299 |

Double counting guards applied:

- cache_creation_input_tokens is a total of the two TTL lanes and is never added to them
- streaming snapshots and final totals sharing a message id collapse to one request with the maximum cumulative output
- compaction iterations are folded into the parent total and never added on top
- tool result and summary tokens are tracked apart from billed model output

## 2. Quota meters

Each meter is its own limit window. They are never summed into one scalar.

| meter | requests | models | utilization | observed ticks | reset |
| --- | --- | --- | --- | --- | --- |
| `unified-5h` | 299 | claude-fable-5-1, claude-opus-4-8, claude-opus-5 | 0.12 -> 0.27 | 15 | 2026-09-18T21:10:00.000Z |
| `unified-7d` | 299 | claude-fable-5-1, claude-opus-4-8, claude-opus-5 | 0.39 -> 0.42 | 3 | 2026-09-22T12:00:00.000Z |
| `unified-7d_oi` | 68 | claude-fable-5-1 | 0.65 -> 0.68 | 3 | 2026-09-22T12:00:00.000Z |

## 3. Coefficient records

Utilization is published at 0.01 granularity, so a window that moved `t` ticks bounds
true consumption strictly between `t-1` and `t+1` ticks. Those are arithmetic bounds from
the display granularity. **They are not confidence intervals, and no point estimate is
published, because a midpoint would be an invented coefficient.**

| block | model | meter | component | tokens | ticks | tokens per tick | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opus.N | claude-opus-5 | `unified-5h-utilization-tick` | cacheRead | 17,899 | 0 | not identifiable | unidentified |
| opus.N | claude-opus-5 | `unified-7d-utilization-tick` | cacheRead | 17,899 | 1 | 8,950 to unbounded | range_only |
| opus.probe | claude-opus-5 | `unified-5h-utilization-tick` | cacheWrite1h | 26,771 | 0 | not identifiable | unidentified |
| opus.probe | claude-opus-5 | `unified-7d-utilization-tick` | cacheWrite1h | 26,771 | 0 | not identifiable | unidentified |
| opus.Wt | claude-opus-5 | `unified-5h-utilization-tick` | cacheWrite1h | 1,071,883 | 2 | 357,294 to 1,071,883 | range_only |
| opus.Wt | claude-opus-5 | `unified-7d-utilization-tick` | cacheWrite1h | 1,071,883 | 0 | not identifiable | unidentified |
| opus.Rt | claude-opus-5 | `unified-5h-utilization-tick` | cacheRead | 540,350 | 1 | not attributable | unassigned |
| opus.Rt | claude-opus-5 | `unified-7d-utilization-tick` | cacheRead | 540,350 | 0 | not attributable | unassigned |
| opus.Rf | claude-opus-5 | `unified-5h-utilization-tick` | cacheRead | 8,682,836 | 1 | 4,341,418 to unbounded | range_only |
| opus.Rf | claude-opus-5 | `unified-7d-utilization-tick` | cacheRead | 8,682,836 | 0 | not identifiable | unidentified |
| fable.WR | claude-fable-5-1 | `unified-5h-utilization-tick` | cacheWrite1h | 713,710 | 6 | 101,959 to 142,742 | range_only |
| fable.WR | claude-fable-5-1 | `unified-7d-utilization-tick` | cacheWrite1h | 713,710 | 1 | 356,855 to unbounded | range_only |
| fable.WR | claude-fable-5-1 | `unified-7d_oi-utilization-tick` | cacheWrite1h | 713,710 | 2 | not attributable | unassigned |
| fable.Rf | claude-fable-5-1 | `unified-5h-utilization-tick` | cacheRead | 7,431,842 | 2 | 2,477,281 to 7,431,842 | range_only |
| fable.Rf | claude-fable-5-1 | `unified-7d-utilization-tick` | cacheRead | 7,431,842 | 1 | 3,715,921 to unbounded | range_only |
| fable.Rf | claude-fable-5-1 | `unified-7d_oi-utilization-tick` | cacheRead | 7,431,842 | 1 | 3,715,921 to unbounded | range_only |
| opus.Ot | claude-opus-5 | `unified-5h-utilization-tick` | cacheRead | 2,578 | 0 | not identifiable | unidentified |
| opus.Ot | claude-opus-5 | `unified-7d-utilization-tick` | cacheRead | 2,578 | 0 | not identifiable | unidentified |

Why each rejected window is not a measurement:

- `opus.Rt` / `unified-5h-utilization-tick`: the window mixes configuration identities (tier:standard|thinking:present, tier:unreported), so the service tier or effort behind the movement is not determined; 57 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `opus.Rt` / `unified-7d-utilization-tick`: the window mixes configuration identities (tier:standard|thinking:present, tier:unreported), so the service tier or effort behind the movement is not determined; 57 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `fable.WR` / `unified-7d_oi-utilization-tick`: the previous reading of this meter is not the immediately preceding request, so traffic in the gap may account for the movement

### Reported cost units (not quota)

These are the per-token unit prices re-derived exactly from the CLI's own `costUSD`
figures by solving the four-unknown system over all trials. They are a *reported*
accounting basis, `sourceKind: reported_unverified`. They are not a measurement of the
subscription quota meter and must not be substituted for one.

| model | input | cache write | cache read | output | max residual (USD) |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5 | 5.00 | 10.00 | 0.50 | 24.99 | 2.6e-8 |
| claude-fable-5-1 | 10.00 | 20.00 | 0.25 | 50.00 | 4.3e-15 |
| claude-opus-4-8 | 5.00 | 10.00 | 0.50 | 25.00 | 4.5e-15 |

The cost data does not split the write lane by TTL, so neither `kWrite5` nor `kWrite60`
is filled from it.

## 4. Fable write tick attribution: unresolved

A tick landed on `fable.WR.end` (req_011CfBRuv522sVohA29kxEqs, 2026-09-18T19:08:04.975Z) which wrote **0 1h tokens and 0 5m tokens** yet moved the gauge 0.23 -> 0.25 (+0.02), 5.064s after req_011CfBRuY5S2kh2D9HiAGWkj.

This is **consistent with** a lagging gauge, but the capture does not establish that.
The proxy sees only its own requests, so unrelated concurrent usage on the same account
meter cannot be ruled out. Admissible explanations, none excluded by this data:

- the gauge lags, and this tick is deferred accounting for an earlier write in the same block
- usage unrelated to this capture consumed the same shared account meter during the window; the proxy only sees its own requests, so concurrent traffic is unobservable here
- the gauge aggregates server side on an interval boundary that happens to fall on this request rather than on the request that caused the consumption

Either way the block boundary is ambiguous, so both attributions survive.

| hypothesis | attribution | ticks | write tokens | tokens per tick | read ticks left for the following run |
| --- | --- | --- | --- | --- | --- |
| **H6** | lag_is_contained_within_the_write_block | 6 | 713,710 | 101,959 to 142,742 | 2 |
| **H8** | lag_extends_into_the_following_read_run | 8 | 713,710 | 79,301 to 101,959 | 0 |

**H6** window: req_011CfBRpvRD6kJ8R2jdrxsVA (2026-09-18T19:06:56.699Z, u=0.19) -> req_011CfBRuv522sVohA29kxEqs (2026-09-18T19:08:04.975Z, u=0.25), reset epoch 1789765800.

- for:
  - the gauge returns to a flat value on the first request of the following run, so the lag tail ends inside the write block
  - the following run consists of cache reads that do move the same gauge later in the capture, which requires a nonzero read cost
- against:
  - a tick landed on a request that wrote nothing, so either the accounting lags by an unmeasured amount or unrelated concurrent account usage moved the same meter; neither is excluded

**H8** window: req_011CfBRpvRD6kJ8R2jdrxsVA (2026-09-18T19:06:56.699Z, u=0.19) -> req_011CfBSHurygaDsi5LXkUWbS (2026-09-18T19:13:03.960Z, u=0.27), reset epoch 1789765800.

- for:
  - the delayed tick on a zero-write request is consistent with a lagging gauge, and nothing in the capture bounds how far such a lag can reach
  - the two later ticks fall while the same prefix is only being read, with no new write in this capture to explain them
- against:
  - the later ticks are separated by tens of requests and several minutes, which is a long tail for a lag that was otherwise one request long
  - under this attribution the fable read cost would be zero over millions of read tokens, which the opus read block contradicts

Not resolved here: gauge_granularity, unmeasured accounting lag, and unobservable concurrent account usage. Discriminating experiment: docs/idle-experiments.md fable write tick plan (not executed).

### Neighbouring requests around the delayed tick

| index | request id | ts | label | 1h write | read | output | 5h utilization |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 242 | req_011CfBRtnqAfbcSEuocWKvs5 | 2026-09-18T19:07:49.773Z | fable.WR.r.1 | 142,742 | 3,035 | 4 | 0.21 |
| 243 | req_011CfBRuAvD4pyHzucHmuTAb | 2026-09-18T19:07:54.756Z | fable.WR.r.2 | 142,803 | 3,035 | 4 | 0.21 |
| 244 | req_011CfBRuY5S2kh2D9HiAGWkj | 2026-09-18T19:07:59.911Z | fable.WR.r.3 | 142,864 | 3,035 | 4 | 0.23 |
| 245 | req_011CfBRuv522sVohA29kxEqs | 2026-09-18T19:08:04.975Z | fable.WR.end | 0 | 3,437 | 4 | 0.25 |
| 246 | req_011CfBRv54kbPt5qyJLuDYij | 2026-09-18T19:08:07.062Z | fable.Rf.start | 0 | 3,437 | 4 | 0.25 |
| 247 | req_011CfBRvSniWBBHtxm7SuKM9 | 2026-09-18T19:08:13.312Z | fable.Rf.rf.0.seed15385162 | 0 | 145,655 | 4 | 0.25 |
| 248 | req_011CfBRvuSbJNSi27zZPJ8io | 2026-09-18T19:08:20.013Z | fable.Rf.rf.1.seed15385162 | 0 | 145,655 | 4 | 0.25 |

## 5. Fable read/write ratio

read quota cost per token divided by 1h write quota cost per token, same model and meter.

Observed range: **0.0137 to 0.0576**, identifiable only under H6.

This is a quantization bound, not a confidence interval, and it carries no point estimate.
- H6: 0.0137 to 0.0576
- H8: not identifiable (no_read_tick_left_under_this_attribution)

## 6. Output coefficient

Status: **unidentified** (value `null`, not zero). The output block holds 1 request(s) totalling 4 output tokens.

the output block stopped at one request before any output-dominated trial ran, so no window isolates output from read and write.

## 7. Phases, restore and system/skill overlap

| phase | status | requests |
| --- | --- | --- |
| `warm` | unassigned | 0 |
| `park_parent` | unassigned | 0 |
| `restore_child` | unassigned | 0 |
| `resume_raw` | unassigned | 0 |
| `useful_work` | unassigned | 0 |

the capture is a synthetic quota calibration run: it contains no idle refresh, handoff, restore or useful-work boundary event, so no request can be assigned to this phase.

Restore cost: **not_measured**. earlier restore estimates are carried as reported values only; this capture contains no restore phase, so no measured write/read/output decomposition exists. Earlier estimates (Rw 6K tokens, Rr 125K tokens) are carried as `reported_unverified` and are not measurements.

System/skill overlap: **unresolved**. system prompt, skill payload, handoff and restore contributions cannot be separated without per-phase request attribution, which this capture does not carry.

Refusal billing: **uncertain**. 136 refused requests reported 7,297,181 1h write and 3,569,231 read tokens. refused responses report usage but the gauge cannot be read at request granularity, so neither "charged" nor "free" is established; any coefficient window containing an uncertain-billing request is rejected as unassigned rather than measured, because the gauge delta is shared and deleting those rows would retain movement the remaining rows did not necessarily cause.

Blocks whose gauge movement cannot be attributed:

- `fable.gate` (2 requests, 1 run(s)): multiple models inside one run: the meter cannot be split between them; the window mixes configuration identities (tier:standard, tier:standard|thinking:present), so the service tier or effort behind the movement is not determined; 1 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `opus.WR` (82 requests, 2 run(s)): block is interleaved with other blocks, so gauge movement cannot be attributed to it; the window mixes configuration identities (tier:standard, tier:standard|thinking:present, tier:unreported), so the service tier or effort behind the movement is not determined; 73 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `fable.probe` (3 requests, 1 run(s)): multiple models inside one run: the meter cannot be split between them; the window mixes configuration identities (tier:standard, tier:standard|thinking:present), so the service tier or effort behind the movement is not determined; 1 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `fable.probe2` (10 requests, 1 run(s)): multiple models inside one run: the meter cannot be split between them; the window mixes configuration identities (tier:standard, tier:standard|thinking:present), so the service tier or effort behind the movement is not determined; 4 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured
- `opus.Rt` (63 requests, 1 run(s)): the window mixes configuration identities (tier:standard|thinking:present, tier:unreported), so the service tier or effort behind the movement is not determined; 57 request(s) in this window have uncertain billing, so the whole window is rejected rather than measured

## 8. Audit of the earlier report

Every claim below was re-checked against the raw capture rather than carried over.

| verdict | claim | observed |
| --- | --- | --- |
| **contradicted** | the observed unified headers contain no model specific extra bucket | {"meterId":"unified-7d_oi","requests":68,"models":["claude-fable-5-1"],"utilization":[0.65,0.68]} |
| **contradicted** | ephemeral_5m is always 0 in this capture | {"requestsWith5mWrite":1,"detail":[{"requestId":"req_011CfBQR9z1Eav4UK9XK1kew","label":"opus.Rt.r.0","cacheWrite5m":4}]} |
| **contradicted** | CLI cost basis for claude-fable-5-1 is read 0.30 and output 25.00 usd per Mtok | {"input":10.000000000261723,"cacheWrite":20.000000000000032,"cacheRead":0.25000000000003,"output":49.99999999877934} |
| **confirmed** | CLI cost basis for claude-opus-5 is input 5.00, write 10.00, read 0.50, output 25.00 usd per Mtok | {"input":4.999386893644572,"cacheWrite":10.000000065750648,"cacheRead":0.5000001518903138,"output":24.99370869593442} |
| **range_too_narrow** | fable read/write quota ratio is about 0.022 within 0.019 to 0.026 | {"low":0.013719152187112083,"high":0.057620439185870745,"rangeKind":"quantization_bounds"} |
| **unresolved** | the fable write block consumed 6 ticks | {"hypotheses":[{"id":"H6","observedTicks":6},{"id":"H8","observedTicks":8}],"lagObserved":true,"lagExclusivelyEstablished":false} |
| **unverifiable** | refused requests appear not to be charged | {"refusalRequests":136} |
| **confirmed_in_substance** | the output coefficient block ran zero trials | {"opusOtRequests":1} |

- contradicted: the observed unified headers contain no model specific extra bucket -> a third quota window exists on one model and must be preserved as its own meter.
- contradicted: ephemeral_5m is always 0 in this capture -> the 5m and 1h write lanes must stay separate fields even though the 1h lane dominates.
- contradicted: CLI cost basis for claude-fable-5-1 is read 0.30 and output 25.00 usd per Mtok -> the reported price ratios used to sanity check the quota ratios were wrong for this model.
- range_too_narrow: fable read/write quota ratio is about 0.022 within 0.019 to 0.026 -> the quantization bounds are far wider than the reported interval, and the reported interval has no stated statistical meaning.
- unresolved: the fable write block consumed 6 ticks -> both the 6 tick and 8 tick attributions survive the evidence; neither is selected here.
- unverifiable: refused requests appear not to be charged -> per-request billing is below the gauge granularity, so no charge conclusion follows from the capture.
- confirmed_in_substance: the output coefficient block ran zero trials -> one probe request exists but no output-dominated trial, so the output coefficient stays unidentified.

## 9. Limits

- utilization is reported at 0.01 granularity, so no per-request quota cost is observable
- a tick landed on a request with no write; a lagging gauge and unrelated concurrent account usage both remain admissible explanations
- the capture observes only its own proxied requests, so it cannot rule out other traffic on the same account meter
- no quota coefficient is published as a point value; only quantization bounds are
- nothing here establishes quota savings for any policy

## 10. Adversarial probe coverage

| class | applicable | result |
| --- | --- | --- |
| `malformed_input` | true | lines are reported by line number, bad fields become unknown rather than zero, exit code 2 or 5 as appropriate |
| `stale_state` | true | meter windows split on the reset epoch and consumption is never computed across a reset |
| `dirty_worktree` | true | this task writes only its four owned paths plus its evidence directory; no other file is staged or modified |
| `misleading_success_output` | true | exit 5 with an explicit integrity status for partial input, exit 2 for no usable request, and null rather than 0 for every unknown quantity |
| `flaky_tests` | true | generatedAt is injected by the caller and the same input yields a byte identical bundle |
| `injected_content_in_source_data` | true | labels, identifiers and counters only; a sanitizer walk refuses to emit if any credential or body key appears |
| `cancel_resume` | false | the aggregator is a single synchronous pass with no resumable or long running state |
| `hung_commands` | false | no network, no timer, no subprocess and no unbounded loop exists in this path |
| `repeated_interruptions` | false | the command is idempotent and writes nothing unless --out is given |

## 2026-09-26 live run (runId 20260925-161302)

Hand-appended by plan todo 9. Sections 1-10 above are the unchanged 2026-09-19 output of `scripts/quota-analysis.mjs`. Re-running the reproduce command at the top of this file rewrites both files and would drop this section and the appended records. If you regenerate, merge by hand.

**Source.**

- Run: `.omo/ulw-execute/evidence/idle-live-run/live/20260925-161302`. The directory is gitignored and stays untracked in worktree w2.
- Time: UTC 2026-09-25 16:13:02-18:14:37, which is KST 2026-09-26 01:13-03:14.
- Model and CLI: model `claude-fable-5-1`, claude CLI 2.1.278, 1h TTL lane only.
- Raw files: `requests.jsonl` has 22 rows (sha256 `05ea9e7aca8203bece685c8c277a6bf936bbbff61ef1a4ab1782e941f37a8886`) and `events.jsonl` has 62 rows (sha256 `0ba89423479b803f737132621b3691f6a66226af3f431baf8a404d7f7fa39e84`).
- Runner: exit 3, 22 paid calls.

**Analysis.** `node scripts/idle-live-analyze.mjs .omo/ulw-execute/evidence/idle-live-run/live/20260925-161302 --md docs/idle-live-results.md` (exit 0). The result is copied byte for byte to `docs/idle-live-results.json`, and the root causes are in `docs/idle-live-results.md`. Every number below was recomputed independently from the raw rows and matched the analyzer output (task-9 `verify.mjs`: 257 MATCH, 0 MISMATCH).

**These figures do not establish any quota saving for any policy.**

### Window status per experiment

`sourceKind` is the analyzer's window verdict. A clean window can produce `measured`; every other window produces `unknown`.

| experiment | status (reason) | window | sourceKind | paid calls | 5h spend as recorded by the runner |
| --- | --- | --- | --- | --- | --- |
| `fable-write-tick` | aborted (`cap_exceeded`) | not clean: `gauge_moved_without_own_call` on its only call | unknown | 1 | 0.02 |
| `output-quota` | aborted (`short_output`) | clean, but the gate call failed | measured window, no coefficient | 1 | 0.00 |
| `ttl-1h-unique-prefix` | **contaminated** (`anomalies_present`). The machine recorded it `valid`; the analyzer's stricter verdict stands (todo-8 gate ruling Q3). | not clean: `gauge_moved_without_own_call` on `treatment/0` | unknown | 10 | 0.05 |
| `restore-decomposition` (runs 1 and 2) | aborted (`big_context_rewrite`) | not clean: anomalies on `shared/1` and `park_path/101` | unknown | 5 | 0.07 |
| `policy-effect` | aborted (`big_context_rewrite`) | clean, 2 calls; aborted on the first pair | measured window, no coefficient | 2 | 0.02 |

The per-experiment 5h spend is gauge-derived and uses the runner's lag-0 attribution, which this run's data rejects (see "Gauge lag" below). Only the meter totals are attribution-free.

### Spend per meter (sourceKind: measured gauge movement; one reset window each)

| meter | start -> end | observed | upper bound | cap |
| --- | --- | --- | --- | --- |
| `unified-5h` | 0.00 -> 0.16 | 0.16 | 0.17 (0.18 if the last call's cost is not yet shown, under lag 1) | 0.53 |
| `unified-7d` | 0.01 -> 0.03 | 0.02 | 0.03 (at most 0.04 under lag 1) | 0.12 |
| `unified-7d_oi` | 0.00 -> 0.04 | 0.04 | 0.05 (at most 0.06 under lag 1) | 0.12 |

### Raw usage (sourceKind: measured tokens; never modified)

| group (experiment, run, phase) | calls | input | cacheRead | cacheWrite1h | cacheWrite5m | output |
| --- | --- | --- | --- | --- | --- | --- |
| preflight pings | 3 | 6 | 8,096 | 4,048 | 0 | 12 |
| restore run 1 ctx_create | 1 | 2 | 3,035 | 143,362 | 0 | 4 |
| restore run 1 resume gate (`--resume`) | 1 | 2 | 3,035 | 143,423 | 0 | 4 |
| restore run 1 park_parent (rf-emulation) | 1 | 2 | 3,035 | 143,444 | 0 | 4,238 |
| fable DIAL (pre-walk) | 1 | 2 | 146,397 | 0 | 0 | 4 |
| output-quota OUT-8K gate | 1 | 2 | 3,035 | 1,009 | 0 | 5,106 |
| policy pair 1 ctx_create | 1 | 2 | 3,035 | 143,342 | 0 | 57 |
| policy pair 1 park_parent (rf-emulation) | 1 | 2 | 3,035 | 143,424 | 0 | 1,117 |
| restore run 2 ctx_create | 1 | 2 | 3,035 | 143,404 | 0 | 4 |
| restore run 2 park_parent (rf-emulation) | 1 | 2 | 3,035 | 143,486 | 0 | 3,812 |
| ttl writes A, B, C, D | 4 | 8 | 12,140 | 238,655 | 0 | 16 |
| ttl 55-min pings A, C | 2 | 4 | 125,299 | 0 | 0 | 8 |
| ttl 110-min checks A, B, C, D | 4 | 8 | 131,369 | 119,426 | 0 | 16 |
| **total** | 22 | 44 | 447,581 | 1,367,023 | 0 | 14,398 |

### Coefficient records appended

Three records were appended to `coefficientRecords` at indices 21-23, one per meter: `unified-5h`, `unified-7d` and `unified-7d_oi` `-utilization-fraction`. They use the analyzer's engine shape and version `idle-live-analysis/1`. `liveRuns[0]` carries the provenance and the window statuses.

- Every coefficient is `null`: `uncachedInput`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead` and `billedModelOutput`.
- Every record is `sourceKind: "unknown"`, because no clean window identified a coefficient:
  - `cacheWrite1h`: `no_clean_fable_window`.
  - `billedModelOutput`: `experiment_not_valid:short_output` on 5h. The window itself was clean; the machine closed output-quota not valid for its own reason (short_output), which the analyzer now names directly in the reason code instead of the window-cleanliness label.
  - `cacheWrite5m`: `adapter_capability` (the CLI writes only 1h).
  - `cacheRead`: the 5.39M-5.55M prior only (`reported_unverified`).
  - `uncachedInput`: bounded above by `cacheWrite1h`.
- The 2026-09-19 records above are unchanged, and no coefficient was invented.

### TTL renewal (listed under status `contaminated`)

The result is read from usage, not from the gauge:

| run | 1h writes | 55-min read of the treatment prefix | 110-min checks | outcome |
| --- | --- | --- | --- | --- |
| 1 | A 59,602, B 59,703 | A HIT, read 62,637 | A HIT (read 62,637, write 0); B MISS (rewrote 59,703) | A HIT & B MISS |
| 2 | C 59,627, D 59,723 | C HIT, read 62,662 | C HIT (read 62,662, write 0); D MISS (rewrote 59,723) | C HIT & D MISS |

- The analyzer's verdict is `renews_at_55min`, with n = 2. Every step fell within ±90 s of its schedule.
- Because the window is contaminated, this result is **not** a `measured` record. Its status is contaminated, for the reason in the next point.
- The contamination is a gauge anomaly on the first TTL write. That call's header moved +2 ticks on a 59.6K write that costs about 0.4-0.75 tick depending on T. Under lag 1 that movement belongs to the previous call, restore run 2 `park_path/101`. The usage fields the verdict rests on are not affected by it, but promoting the verdict to `measured` would need an Appendix B amendment.

### Gauge lag (D1): what the data admits

Model (Appendix A section 0): the header shows floor(cumulative / 0.01), and the meter is linear in the five usage fields. Scan range:

- T is the number of 1h-write tokens per tick, scanned from 60K to 200K;
- read tokens per tick: 5.39M-5.55M;
- output weight: 0.5-12 times the write weight.

Results:

- **Lag 0** (a call's cost is shown on its own header) is infeasible over the whole scan. Direct case: `restore-decomposition/shared/0` wrote 143,362 1h tokens and its own header stayed at 0.00; that needs T > 147K.
- **Lag 2** is infeasible over the whole scan.
- **Lag 1** is feasible only for T = 80.5K-89.5K with an output weight of at least 1.55.
  - That T range lies inside the 09-19 H8 interval (79.3K-102K) and outside the prior 102K-143K.
  - At the prior 102K-143K no lag model fits.

So the data rejects "lag 0 at the prior price". It admits lag 1 only at a T below the prior. This depends on the floor-and-linear assumptions and does not separate a per-call lag from time-based settlement. **Consequently T stays `unknown` here and is not recorded as measured.** The fit is model-dependent and comes from contaminated windows.

What changes under lag 1 (task-9 `d1-lag-output.txt`):

| scope | 5h ticks under lag 0 | 5h ticks under lag 1 |
| --- | --- | --- |
| restore run 1 | 3 | 5 |
| fable-write-tick | 2 | 0 |
| output-quota | 0 | 1 |
| policy pair 1 | 2 | 3 |
| restore run 2 | 4 | 4 |
| ttl frame | 5 | 3 + unseen last-call tail |

- The fable `cap_exceeded` abort does not occur under lag 1. Projected spend would be 0 + 1 tick against the 2-tick cap.
- The TTL anomaly moves to restore run 2.
- The meter upper bounds each rise by at most 0.01.
- No coefficient interval changes, because none was produced.

### AGENT_TASK A3 items after this run

- **Fable write tick 6/8:** not measured (fable-write-tick aborted). The lag-1 fit above falls inside H8, but it is `unknown`, not a measurement. H6/H8 from 2026-09-19 stay unresolved.
- **Output quota:** not measured. One OUT-8K call produced 5,106 output tokens (104 thinking) with `end_turn`, below the 6,000 gate. k_out stays unknown.
- **Fable read/write ratio:** not measured by this run. The 2026-09-19 range of 0.0137-0.0576 (H6 only) stands as recorded.
- **Restore cost Rw/Rr:** not measured. Every big-context request after the context write, whether `--resume` or rf-emulation, was a full rewrite: read 3,035, 1h write 143.4K-143.5K. So no park/restore decomposition exists. The earlier Rw 6K / Rr 125K estimates remain `reported_unverified`.
- **System/skill overlap:** unresolved. The only separable piece is the 3,035-token system-prompt read, which appears on every cache miss (measured usage).
- **Park generation:** measured usage, but on a rewritten context, so not representative. Three `park_parent` calls, each with one big-context request that missed (read 3,035):

  | park_parent call | 1h write | output |
  | --- | --- | --- |
  | restore run 1 | 143,444 | 4,238 |
  | policy pair 1 | 143,424 | 1,117 |
  | restore run 2 | 143,486 | 3,812 |

### Policy answer

**NO_DECISION** (`evidence_incomplete`): restore-decomposition and policy-effect aborted, so no phase cost model exists.

- The engine was not run at either end of the prior range.
- V = 0 baseline. No return forecast q was measured or invented.

### Unknown after this run

`cacheWrite5m` (skipped by adapter capability), `uncachedInput`, `cacheRead` (prior only), T, k_out, the return forecast q, skillRestoreEq / sharedLossEq / parkQualityEq, the restore and park decomposition, and the exact bytes by which a `--resume` replay differs (no request bodies were captured).
