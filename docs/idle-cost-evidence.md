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

