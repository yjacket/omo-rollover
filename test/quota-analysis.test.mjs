// Regression tests for the offline quota evidence aggregator.
//
// These tests pin machine-consumed values only: field names, enum values,
// counts, exit codes and arithmetic. No prose or report wording is asserted.
//
// Nothing here performs network I/O, spawns a model request or sleeps.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COEFFICIENT_STATUSES,
  PHASES,
  SCHEMA_VERSION,
  SOURCE_KINDS,
  UTILIZATION_RESOLUTION,
  buildEvidence,
  contiguousRuns,
  convertToQuota,
  dedupeRequests,
  extractMeters,
  findSensitive,
  meterWindows,
  normalizeRequest,
  normalizeUsage,
  parseArgs,
  perTickTokenRange,
  quantizationBounds,
  solveListPriceUnits,
  sumUsage,
} from '../scripts/quota-analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'scripts', 'quota-analysis.mjs');
const MAIN_RAW = 'C:/dev/omo/omo-rollover/quota-test/2026-09-19/raw.jsonl';

// ---------------------------------------------------------------- fixtures

function headers(over = {}) {
  return {
    'anthropic-ratelimit-unified-5h-utilization': '0.10',
    'anthropic-ratelimit-unified-5h-reset': '1789765800',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.39',
    'anthropic-ratelimit-unified-7d-reset': '1790078400',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'request-id': 'req_fixture',
    ...over,
  };
}

let seq = 0;
function rawRec(over = {}) {
  seq += 1;
  return {
    ts: '2026-09-18T18:38:55.507Z',
    ts_req: '2026-09-18T18:38:53.832Z',
    label: 'fx.block.step',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    model: 'claude-opus-5',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
      output_tokens: 4,
    },
    stop_reason: 'end_turn',
    error: null,
    msg_id: `msg_fixture_${seq}`,
    body_bytes: 10,
    headers: headers(),
    ...over,
  };
}

function tmpFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-analysis-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return { dir, path: p };
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

// ------------------------------------------------- A1: immutable raw usage

test('raw usage is preserved as exactly five billable fields plus an explicit unknown-TTL field', () => {
  const u = normalizeUsage({
    input_tokens: 7,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 55,
    cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
    output_tokens: 9,
  });
  assert.equal(u.uncachedInput, 7);
  assert.equal(u.cacheWrite5m, 40);
  assert.equal(u.cacheWrite1h, 60);
  assert.equal(u.cacheWriteUnknownTtl, 0);
  assert.equal(u.cacheRead, 55);
  assert.equal(u.billedModelOutput, 9);
  // The top-level cache_creation_input_tokens is the SUM of the two lanes in the
  // observed schema; adding both would double count the write.
  assert.equal(u.cacheWrite5m + u.cacheWrite1h + u.cacheWriteUnknownTtl, 100);
  assert.deepEqual(u.warnings, []);
  assert.ok(Object.isFrozen(u));
});

test('a missing TTL split is unknown, never silently zero and never silently 1h', () => {
  const u = normalizeUsage({
    input_tokens: 1,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    output_tokens: 2,
  });
  assert.equal(u.cacheWrite5m, null);
  assert.equal(u.cacheWrite1h, null);
  assert.equal(u.cacheWriteUnknownTtl, 1000);
  assert.ok(u.warnings.includes('cache_write_ttl_split_missing'));
});

test('an inconsistent TTL split is refused, not reconciled by arithmetic', () => {
  const u = normalizeUsage({
    input_tokens: 1,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    output_tokens: 0,
  });
  assert.ok(u.warnings.includes('cache_write_split_inconsistent'));
  assert.equal(u.cacheWrite5m, null);
  assert.equal(u.cacheWrite1h, null);
  assert.equal(u.cacheWriteUnknownTtl, 1000);
});

test('tool result text is input for the next request and is never counted as model output', () => {
  const u = normalizeUsage({
    input_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 11,
    tool_result_tokens: 4000,
    summary_document_tokens: 2200,
  });
  assert.equal(u.billedModelOutput, 11);
  assert.equal(u.toolResultTokens, 4000);
  assert.equal(u.summaryDocumentTokens, 2200);
  const totals = sumUsage([{ usage: u }]);
  assert.equal(totals.billedModelOutput, 11);
  assert.equal(totals.toolResultTokens, 4000);
  assert.ok(!('tool_result_tokens' in totals));
});

test('negative or non-numeric usage is rejected instead of coerced', () => {
  const neg = normalizeUsage({ input_tokens: -1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  assert.ok(neg.warnings.includes('negative_usage_value'));
  assert.equal(neg.uncachedInput, null);
  const bad = normalizeUsage({ input_tokens: 'many', cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  assert.ok(bad.warnings.includes('non_numeric_usage_value'));
  assert.equal(bad.uncachedInput, null);
});

// ------------------------------------------------------------ A1: dedup

test('a streaming snapshot and its final total for one message are counted once', () => {
  const streamed = rawRec({
    msg_id: 'msg_same',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
      output_tokens: 3,
    },
  });
  const final = rawRec({
    msg_id: 'msg_same',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
      output_tokens: 17,
    },
  });
  const reqs = [streamed, final].map((r, i) => normalizeRequest(r, i));
  const { requests, dropped } = dedupeRequests(reqs);
  assert.equal(requests.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'duplicate_message_id');
  // message_delta carries the cumulative output total: keep the maximum, never the sum.
  assert.equal(requests[0].usage.billedModelOutput, 17);
  const totals = sumUsage(requests);
  assert.equal(totals.billedModelOutput, 17);
  assert.equal(totals.cacheWrite1h, 100);
});

test('compaction iterations inside a parent total are not added on top of the parent', () => {
  const parent = normalizeRequest(
    rawRec({
      msg_id: 'msg_parent',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 },
        output_tokens: 30,
        iterations: [
          { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 },
          { input_tokens: 1, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 20 },
        ],
      },
    }),
    0,
  );
  assert.equal(parent.iterationCount, 2);
  assert.equal(parent.iterationAccounting, 'folded_into_parent_total');
  const totals = sumUsage([parent]);
  assert.equal(totals.cacheWrite1h, 300);
  assert.equal(totals.cacheRead, 500);
  assert.equal(totals.billedModelOutput, 30);
  assert.equal(totals.requests, 1);
});

test('two separate requests are two rows even when their usage is identical', () => {
  const a = normalizeRequest(rawRec({ msg_id: 'msg_a' }), 0);
  const b = normalizeRequest(rawRec({ msg_id: 'msg_b' }), 1);
  const { requests, dropped } = dedupeRequests([a, b]);
  assert.equal(requests.length, 2);
  assert.equal(dropped.length, 0);
  assert.equal(sumUsage(requests).cacheWrite1h, 200);
});

test('a duplicate message id with irreconcilable usage is reported as a conflict', () => {
  const a = normalizeRequest(rawRec({ msg_id: 'msg_c' }), 0);
  const b = normalizeRequest(
    rawRec({
      msg_id: 'msg_c',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 999,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 999 },
        output_tokens: 4,
      },
    }),
    1,
  );
  const { conflicts } = dedupeRequests([a, b]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'cacheWrite1h');
});

// ------------------------------------------------------- A2: meters & units

test('every rate limit meter is preserved separately and never summed into one scalar', () => {
  const m = extractMeters(
    headers({
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.65',
      'anthropic-ratelimit-unified-7d_oi-reset': '1790078400',
      'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    }),
  );
  assert.deepEqual(Object.keys(m).sort(), ['unified-5h', 'unified-7d', 'unified-7d_oi']);
  assert.equal(m['unified-5h'].utilization, 0.1);
  assert.equal(m['unified-5h'].resetEpoch, 1789765800);
  assert.equal(m['unified-7d_oi'].utilization, 0.65);
  assert.equal(m['unified-7d_oi'].resetEpoch, 1790078400);
  // Distinct reset epochs prove these are distinct windows, not one meter.
  assert.notEqual(m['unified-5h'].resetEpoch, m['unified-7d'].resetEpoch);
});

test('quota conversion refuses to run while any required coefficient is unidentified', () => {
  const totals = { uncachedInput: 10, cacheWrite5m: 0, cacheWrite1h: 100, cacheWriteUnknownTtl: 0, cacheRead: 20, billedModelOutput: 5 };
  const record = {
    modelId: 'claude-opus-5',
    quotaMeterOrCostUnit: 'unified-5h-utilization-tick',
    status: 'range_only',
    coefficients: { kInput: null, kWrite5: null, kWrite60: null, kRead: null, kOutput: null },
  };
  const q = convertToQuota(totals, record);
  assert.equal(q.value, null);
  assert.notEqual(q.value, 0);
  assert.deepEqual(q.missingCoefficients.sort(), ['kInput', 'kOutput', 'kRead', 'kWrite5', 'kWrite60']);
  assert.equal(q.reason, 'coefficients_unidentified');
});

test('quota conversion refuses an unknown TTL split even when every coefficient is known', () => {
  const totals = { uncachedInput: 0, cacheWrite5m: null, cacheWrite1h: null, cacheWriteUnknownTtl: 1000, cacheRead: 0, billedModelOutput: 0 };
  const record = {
    modelId: 'claude-opus-5',
    quotaMeterOrCostUnit: 'usd_list_price',
    status: 'derived_from_reported',
    coefficients: { kInput: 1, kWrite5: 1, kWrite60: 2, kRead: 1, kOutput: 1 },
  };
  const q = convertToQuota(totals, record);
  assert.equal(q.value, null);
  assert.equal(q.reason, 'cache_write_ttl_unknown');
});

test('a 5m coefficient is never substituted for the 1h lane', () => {
  const totals = { uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 100, cacheWriteUnknownTtl: 0, cacheRead: 0, billedModelOutput: 0 };
  const record = {
    modelId: 'claude-opus-5',
    quotaMeterOrCostUnit: 'usd_list_price',
    status: 'derived_from_reported',
    coefficients: { kInput: 1, kWrite5: 7, kWrite60: null, kRead: 1, kOutput: 1 },
  };
  const q = convertToQuota(totals, record);
  assert.equal(q.value, null);
  assert.deepEqual(q.missingCoefficients, ['kWrite60']);
});

test('two models are not aggregated into a shared quota scalar without a common measured meter', () => {
  const totals = { uncachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 100, cacheWriteUnknownTtl: 0, cacheRead: 0, billedModelOutput: 0 };
  const opus = {
    modelId: 'claude-opus-5',
    quotaMeterOrCostUnit: 'unified-5h-utilization-tick',
    status: 'range_only',
    coefficients: { kInput: null, kWrite5: null, kWrite60: null, kRead: null, kOutput: null },
  };
  const q = convertToQuota(totals, { ...opus, modelId: 'claude-fable-5-1' });
  assert.equal(q.value, null);
  assert.equal(q.crossModelAggregation, 'not_comparable');
});

// --------------------------------------------------- A3: windows and ticks

test('a reset epoch change starts a new window and never yields negative consumption', () => {
  const before = normalizeRequest(rawRec({ headers: headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.90' }) }), 0);
  const after = normalizeRequest(
    rawRec({
      headers: headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.02',
        'anthropic-ratelimit-unified-5h-reset': '1789783800',
      }),
    }),
    1,
  );
  const windows = meterWindows([before, after], 'unified-5h');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].resetEpoch, 1789765800);
  assert.equal(windows[1].resetEpoch, 1789783800);
  for (const w of windows) assert.ok(w.observedTicks >= 0);
  assert.ok(windows.every((w) => w.spansReset === false));
});

test('utilization resolution bounds are quantization bounds, not a confidence interval', () => {
  const b = quantizationBounds(6, UTILIZATION_RESOLUTION);
  assert.equal(b.rangeKind, 'quantization_bounds');
  assert.equal(b.statisticalConfidenceInterval, false);
  assert.ok(Math.abs(b.lowTicksExclusive - 5) < 1e-12);
  assert.ok(Math.abs(b.highTicksExclusive - 7) < 1e-12);

  const r = perTickTokenRange(713710, 6, UTILIZATION_RESOLUTION);
  assert.equal(r.rangeKind, 'quantization_bounds');
  assert.equal(r.statisticalConfidenceInterval, false);
  assert.equal(r.pointEstimate, null); // a midpoint would be an invented coefficient
  assert.equal(Math.round(r.lowTokensPerTick), Math.round(713710 / 7));
  assert.equal(Math.round(r.highTokensPerTick), Math.round(713710 / 5));

  const zero = perTickTokenRange(1000, 0, UTILIZATION_RESOLUTION);
  assert.equal(zero.highTokensPerTick, null);
  assert.equal(zero.identifiable, false);
});

test('label blocks interleaved with other blocks are not attributed as one contiguous run', () => {
  const reqs = [
    normalizeRequest(rawRec({ label: 'opus.WR.a' }), 0),
    normalizeRequest(rawRec({ label: 'opus.WR.b' }), 1),
    normalizeRequest(rawRec({ label: 'fable.probe.x', model: 'claude-fable-5-1' }), 2),
    normalizeRequest(rawRec({ label: 'opus.WR.c' }), 3),
  ];
  const runs = contiguousRuns(reqs, (r) => r.block);
  const wr = runs.filter((r) => r.key === 'opus.WR');
  assert.equal(wr.length, 2);
  assert.ok(wr.every((r) => r.contiguous === true));
  const block = runs.find((r) => r.key === 'fable.probe');
  assert.equal(block.requests.length, 1);
});

test('refusal requests report usage but their quota billing is recorded as uncertain', () => {
  const r = normalizeRequest(rawRec({ stop_reason: 'refusal', usage: { input_tokens: 2, cache_creation_input_tokens: 3416, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3416 }, output_tokens: 0 } }), 0);
  assert.equal(r.stopReason, 'refusal');
  assert.equal(r.billingStatus, 'uncertain');
  assert.equal(r.usage.cacheWrite1h, 3416); // usage is still preserved verbatim
  const ok = normalizeRequest(rawRec({}), 1);
  assert.equal(ok.billingStatus, 'assumed_billed');
});

// ------------------------------------------------- A2: coefficient records

test('list price units are solved from reported cost data and labelled as reported, not measured quota', () => {
  const trials = [
    { modelUsage: { m: { inputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, costUSD: 0.005, provider: 'firstParty', costBasis: 'list' } } },
    { modelUsage: { m: { inputTokens: 0, cacheCreationInputTokens: 1000, cacheReadInputTokens: 0, outputTokens: 0, costUSD: 0.01, provider: 'firstParty', costBasis: 'list' } } },
    { modelUsage: { m: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1000, outputTokens: 0, costUSD: 0.0005, provider: 'firstParty', costBasis: 'list' } } },
    { modelUsage: { m: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1000, costUSD: 0.025, provider: 'firstParty', costBasis: 'list' } } },
  ];
  const solved = solveListPriceUnits(trials);
  const m = solved.m;
  assert.equal(m.status, 'derived_from_reported');
  assert.equal(m.sourceKind, 'reported_unverified');
  assert.notEqual(m.sourceKind, 'measured');
  assert.ok(m.quotaMeterOrCostUnit.startsWith('usd_per_mtok'));
  assert.ok(Math.abs(m.usdPerMtok.input - 5) < 1e-6);
  assert.ok(Math.abs(m.usdPerMtok.cacheWrite - 10) < 1e-6);
  assert.ok(Math.abs(m.usdPerMtok.cacheRead - 0.5) < 1e-6);
  assert.ok(Math.abs(m.usdPerMtok.output - 25) < 1e-6);
  assert.ok(m.maxResidualUsd < 1e-9);
  // The write lane is not split by TTL in the reported cost data.
  assert.equal(m.ttlLane, 'unsplit_in_source');
});

test('an unidentifiable price system is reported unidentified rather than fitted', () => {
  const trials = [
    { modelUsage: { m: { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40, costUSD: 1 } } },
    { modelUsage: { m: { inputTokens: 20, cacheCreationInputTokens: 40, cacheReadInputTokens: 60, outputTokens: 80, costUSD: 2 } } },
  ];
  const solved = solveListPriceUnits(trials);
  assert.equal(solved.m.status, 'unidentified');
  assert.equal(solved.m.usdPerMtok, null);
  assert.equal(solved.m.reason, 'rank_deficient');
});

// ------------------------------------------------------- end to end evidence

function realRawAvailable() {
  return fs.existsSync(MAIN_RAW);
}

function realEvidence() {
  return buildEvidence({
    rawPath: MAIN_RAW,
    rawText: fs.readFileSync(MAIN_RAW, 'utf8'),
    trialsPath: path.join(path.dirname(MAIN_RAW), 'trials.jsonl'),
    trialsText: fs.readFileSync(path.join(path.dirname(MAIN_RAW), 'trials.jsonl'), 'utf8'),
    generatedAt: '2026-09-20T00:00:00.000Z',
  });
}

test('every coefficient record carries the full provenance field set and a legal status', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const required = [
    'modelId', 'provider', 'authLane', 'ttlLane', 'effortOrConfigIdentity',
    'quotaMeterOrCostUnit', 'validFrom', 'measuredAt', 'sourceKind', 'evidenceRef',
    'sampleCount', 'coefficients', 'observedRangeOrUncertainty', 'status', 'version',
  ];
  assert.ok(ev.coefficientRecords.length > 0);
  for (const rec of ev.coefficientRecords) {
    for (const f of required) assert.ok(f in rec, `${rec.modelId}/${rec.quotaMeterOrCostUnit} missing ${f}`);
    assert.ok(SOURCE_KINDS.includes(rec.sourceKind), `bad sourceKind ${rec.sourceKind}`);
    assert.ok(COEFFICIENT_STATUSES.includes(rec.status), `bad status ${rec.status}`);
    assert.equal(rec.version, SCHEMA_VERSION);
    if (rec.status === 'unidentified') {
      for (const v of Object.values(rec.coefficients)) assert.equal(v, null);
    }
  }
});

test('no coefficient is both unidentified and numeric, and no OAuth quota coefficient claims a point value', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const quotaRecs = ev.coefficientRecords.filter((r) => r.quotaMeterOrCostUnit.startsWith('unified-'));
  assert.ok(quotaRecs.length > 0);
  for (const rec of quotaRecs) {
    assert.notEqual(rec.sourceKind, 'api_assumption');
    for (const v of Object.values(rec.coefficients)) assert.equal(v, null);
    assert.equal(rec.observedRangeOrUncertainty.statisticalConfidenceInterval, false);
  }
});

test('the output coefficient stays unidentified because the Ot block has one request', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  assert.equal(ev.outputCoefficient.status, 'unidentified');
  assert.equal(ev.outputCoefficient.identifiable, false);
  assert.equal(ev.outputCoefficient.otBlockRequests, 1);
  assert.equal(ev.outputCoefficient.value, null);
});

test('the fable write tick question keeps both attribution hypotheses with quantization ranges', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const f = ev.fableWriteTicks;
  assert.equal(f.resolved, false);
  assert.deepEqual(f.hypotheses.map((h) => h.id).sort(), ['H6', 'H8']);
  const h6 = f.hypotheses.find((h) => h.id === 'H6');
  const h8 = f.hypotheses.find((h) => h.id === 'H8');
  assert.equal(h6.observedTicks, 6);
  assert.equal(h8.observedTicks, 8);
  assert.equal(h6.writeTokens, h8.writeTokens);
  for (const h of f.hypotheses) {
    assert.equal(h.perTickTokens.statisticalConfidenceInterval, false);
    assert.equal(h.perTickTokens.pointEstimate, null);
    assert.ok(h.evidenceFor.length > 0);
    assert.ok(h.evidenceAgainst.length > 0);
    assert.ok(h.neighborRequests.length > 0);
    for (const n of h.neighborRequests) {
      assert.match(n.requestId, /^req_/);
      assert.ok(n.ts);
      assert.equal(typeof n.utilization, 'number');
    }
  }
  // The delayed tick lands on a request that wrote nothing: that is the whole problem.
  assert.equal(f.delayedTick.cacheWrite1h, 0);
  assert.equal(f.delayedTick.deltaUtilization, 0.02);
  assert.match(f.delayedTick.requestId, /^req_/);
  // The tick is observed, but the capture cannot exclude unrelated concurrent account
  // usage, so lag must not be reported as established.
  assert.equal(f.lagObserved, true);
  assert.equal(f.lagExclusivelyEstablished, false);
  assert.ok(f.alternativeExplanations.length >= 2);
});

test('the fable read/write ratio is an observed range with no statistical interpretation', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const r = ev.fableReadWriteRatio;
  assert.equal(r.statisticalConfidenceInterval, false);
  assert.equal(r.pointEstimate, null);
  assert.ok(r.low > 0);
  assert.ok(r.high > r.low);
  assert.equal(r.rangeKind, 'quantization_bounds');
  assert.ok(Array.isArray(r.perHypothesis));
});

test('the third fable-only meter present in the raw headers is preserved', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  assert.ok(ev.meters['unified-7d_oi'], 'unified-7d_oi meter must be preserved');
  assert.equal(ev.meters['unified-7d_oi'].requests, 68);
  assert.deepEqual(ev.meters['unified-7d_oi'].models, ['claude-fable-5-1']);
  assert.notEqual(ev.meters['unified-7d_oi'].resetEpochs[0], ev.meters['unified-5h'].resetEpochs[0]);
});

test('a meter whose previous reading is not the adjacent request is unassigned, not attributed', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const recs = ev.coefficientRecords.filter((r) => r.quotaMeterOrCostUnit.startsWith('unified-'));
  assert.ok(recs.length > 0);
  for (const r of recs) {
    const gap = r.evidenceRef.baselineGapRequests;
    assert.equal(typeof gap, 'number');
    if (gap !== 1) {
      assert.equal(r.status, 'unassigned');
      assert.ok(r.observedRangeOrUncertainty.unattributableReason.length > 0);
    }
  }
  // The fable-only meter is not reported on opus requests, so its previous reading
  // before the fable write block sits far back behind unrelated traffic.
  const oiWrite = recs.find((r) => r.quotaMeterOrCostUnit.startsWith('unified-7d_oi') && r.evidenceRef.block === 'fable.WR');
  assert.ok(oiWrite);
  assert.ok(oiWrite.evidenceRef.baselineGapRequests > 1);
  assert.equal(oiWrite.status, 'unassigned');
});

test('the five report phases stay unassigned because the source has no phase boundary events', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  assert.deepEqual(Object.keys(ev.phases).sort(), [...PHASES].sort());
  for (const [name, p] of Object.entries(ev.phases)) {
    assert.equal(p.status, 'unassigned', `${name} must stay unassigned`);
    assert.equal(p.requests, 0);
    assert.ok(p.reason.length > 0);
  }
  assert.equal(ev.restoreCost.status, 'not_measured');
  assert.equal(ev.restoreCost.measured, null);
  assert.equal(ev.systemSkillOverlap.status, 'unresolved');
});

test('aggregation is deterministic and independent of wall clock', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  assert.deepEqual(realEvidence(), realEvidence());
});

test('totals agree with an independent recount of the raw file', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  // Independent recount: plain reduce over the file, no analyzer code involved.
  let requests = 0, w1 = 0, rd = 0, out = 0, w5 = 0, inp = 0;
  for (const line of fs.readFileSync(MAIN_RAW, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.path !== '/v1/messages' || !r.usage) continue;
    requests += 1;
    inp += r.usage.input_tokens;
    w5 += r.usage.cache_creation.ephemeral_5m_input_tokens;
    w1 += r.usage.cache_creation.ephemeral_1h_input_tokens;
    rd += r.usage.cache_read_input_tokens;
    out += r.usage.output_tokens;
  }
  assert.equal(ev.totals.requests, requests);
  assert.equal(ev.totals.uncachedInput, inp);
  assert.equal(ev.totals.cacheWrite5m, w5);
  assert.equal(ev.totals.cacheWrite1h, w1);
  assert.equal(ev.totals.cacheRead, rd);
  assert.equal(ev.totals.billedModelOutput, out);
  assert.equal(ev.totals.cacheWriteUnknownTtl, 0);
  // Non-billable transport rows must be excluded from billable totals but still counted.
  assert.equal(ev.inputIntegrity.nonBillableRows, 304);
  assert.equal(ev.inputIntegrity.malformedLines.length, 0);
  assert.equal(ev.inputIntegrity.duplicatesDropped, 0);
});

// -------------------------------------------------------------- sanitization

test('the evidence bundle contains no prompt text, body text or credential material', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const found = findSensitive(ev);
  assert.deepEqual(found, []);
  const text = JSON.stringify(ev);
  for (const needle of ['authorization', 'x-api-key', 'sk-ant', 'result_preview', 'stderr', 'Bearer ']) {
    assert.ok(!text.toLowerCase().includes(needle.toLowerCase()), `evidence leaked ${needle}`);
  }
});

test('findSensitive flags credential and body keys wherever they are nested', () => {
  const found = findSensitive({ a: { b: [{ authorization: 'Bearer x' }] }, c: { prompt_text: 'hi' } });
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => f.path.includes('authorization')));
});

// ---------------------------------------------------------------------- CLI

test('the CLI aggregates the real raw file and exits 0', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const res = runCli([MAIN_RAW, '--json']);
  assert.equal(res.code, 0);
  const ev = JSON.parse(res.stdout);
  assert.equal(ev.schemaVersion, SCHEMA_VERSION);
  assert.equal(ev.totals.requests, 299);
  assert.deepEqual(findSensitive(ev), []);
});

test('the CLI exits 2 on a missing input file and prints no success summary', () => {
  const res = runCli(['C:/definitely/not/here/raw.jsonl']);
  assert.equal(res.code, 2);
  assert.ok(!res.stdout.includes('"totals"'));
});

test('the CLI exits 3 on an unknown flag and 3 with no argument', () => {
  assert.equal(runCli(['--bogus']).code, 3);
  assert.equal(runCli([]).code, 3);
});

test('a file with only malformed lines exits 2 instead of reporting empty success', () => {
  const { path: p } = tmpFile('raw.jsonl', 'not json\n{oops\n');
  const res = runCli([p]);
  assert.equal(res.code, 2);
  assert.ok(!res.stdout.includes('"totals"'));
});

test('partially malformed input exits 5 and names the bad lines instead of claiming clean success', () => {
  const good = JSON.stringify(rawRec({ msg_id: 'msg_ok' }));
  const { path: p } = tmpFile('raw.jsonl', `${good}\nnot json\n${JSON.stringify(rawRec({ msg_id: 'msg_ok2' }))}\n`);
  const res = runCli([p, '--json']);
  assert.equal(res.code, 5);
  const ev = JSON.parse(res.stdout);
  assert.equal(ev.status, 'ok_with_integrity_warnings');
  assert.deepEqual(ev.inputIntegrity.malformedLines, [2]);
  assert.equal(ev.totals.requests, 2);
});

test('parseArgs rejects unknown flags and accepts the documented ones', () => {
  assert.equal(parseArgs(['--nope']).error, 'unknown_flag');
  assert.equal(parseArgs([]).error, 'missing_input');
  const ok = parseArgs(['raw.jsonl', '--json']);
  assert.equal(ok.error, null);
  assert.equal(ok.json, true);
  assert.equal(ok.input, 'raw.jsonl');
});

test('the analyzer source performs no network, timer or model call', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  for (const forbidden of ['node:http', 'node:https', 'fetch(', 'setTimeout', 'setInterval', 'child_process', 'execSync']) {
    assert.ok(!src.includes(forbidden), `analyzer must not reference ${forbidden}`);
  }
});

test('the CLI writes no file unless --out is given', () => {
  if (!realRawAvailable()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-analysis-out-'));
  const before = fs.readdirSync(dir);
  runCli([MAIN_RAW, '--json'], { cwd: dir });
  assert.deepEqual(fs.readdirSync(dir), before);
  const out = path.join(dir, 'ev.json');
  assert.equal(runCli([MAIN_RAW, '--out', out]).code, 0);
  assert.ok(fs.existsSync(out));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------- verify2 independent QA regressions
//
// Each fixture below is copied verbatim from the independent verify2 manual QA run
// (.omo/ulw-execute/evidence/idle-cost-shadow/verify2/*.jsonl). They are inlined so the
// regressions stay hermetic and do not depend on another lane's evidence directory.

const QA_BASE =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"base.only","msg_id":"msg_qa_b","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_b","anthropic-ratelimit-unified-5h-utilization":".1","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_REFUSAL =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"test.writes","msg_id":"msg_qa_12","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_12","anthropic-ratelimit-unified-5h-utilization":".12","anthropic-ratelimit-unified-5h-reset":"1000"},"stop_reason":"refusal"}';

const QA_MISSING_FIELD =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"qa.block.step","msg_id":"msg_qa_5","usage":{"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_5","anthropic-ratelimit-unified-5h-utilization":".1","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_NEGATIVE =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"qa.block.step","msg_id":"msg_qa_6","usage":{"input_tokens":-1,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_6","anthropic-ratelimit-unified-5h-utilization":".1","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_VALID_8 =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"qa.block.step","msg_id":"msg_qa_8","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_8","anthropic-ratelimit-unified-5h-utilization":".1","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_RESET_A =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"qa.block.step","msg_id":"msg_qa_9","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_9","anthropic-ratelimit-unified-5h-utilization":".9","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_RESET_B =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"qa.block.step","msg_id":"msg_qa_10","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7},"headers":{"request-id":"req_qa_10","anthropic-ratelimit-unified-5h-utilization":".02","anthropic-ratelimit-unified-5h-reset":"2000"}}';

const QA_TIER_STANDARD =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"test.writes.a","msg_id":"msg_qa_14","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7,"service_tier":"standard"},"headers":{"request-id":"req_qa_14","anthropic-ratelimit-unified-5h-utilization":".12","anthropic-ratelimit-unified-5h-reset":"1000"}}';

const QA_TIER_PRIORITY =
  '{"ts":"2026-09-19T00:00:00Z","ts_req":"2026-09-19T00:00:00Z","path":"/v1/messages","method":"POST","status":200,"model":"qa-model","label":"test.writes.b","msg_id":"msg_qa_15","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"cache_read_input_tokens":10,"output_tokens":7,"service_tier":"priority"},"headers":{"request-id":"req_qa_15","anthropic-ratelimit-unified-5h-utilization":".14","anthropic-ratelimit-unified-5h-reset":"1000"}}';

function qaEvidence(lines) {
  return buildEvidence({ rawPath: 'qa.jsonl', rawText: `${lines.join('\n')}\n`, generatedAt: 'QA' });
}

function qaCli(lines, extra = []) {
  const { dir, path: p } = tmpFile('qa.jsonl', `${lines.join('\n')}\n`);
  try {
    return runCli([p, ...extra]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// verify2 finding 1
test('a window containing uncertain billing is rejected outright, not measured', () => {
  const ev = qaEvidence([QA_BASE, QA_REFUSAL]);
  const recs = ev.coefficientRecords.filter((r) => r.evidenceRef.block === 'test.writes');
  assert.ok(recs.length > 0, 'the refusal block must still be reported');
  for (const r of recs) {
    assert.equal(r.observedRangeOrUncertainty.billingUncertainRequests, 1);
    // The gauge delta is shared, so deleting the refused row would keep a movement that
    // the remaining rows did not necessarily cause. The whole window is rejected.
    assert.equal(r.status, 'unassigned');
    assert.notEqual(r.sourceKind, 'measured');
    assert.equal(r.observedRangeOrUncertainty.tokensPerTick.identifiable, false);
    assert.match(r.observedRangeOrUncertainty.unattributableReason, /billing/i);
  }
  assert.equal(ev.blocks['test.writes'].utilizationAttribution, 'unassigned');
});

test('the shipped opus.Rt window carries uncertain billing and is therefore unassigned', (t) => {
  if (!realRawAvailable()) return t.skip('main raw.jsonl not present');
  const ev = realEvidence();
  const rt = ev.coefficientRecords.filter((r) => r.evidenceRef.block === 'opus.Rt');
  assert.ok(rt.length > 0);
  assert.ok(ev.blocks['opus.Rt'].billingUncertain > 0);
  for (const r of rt) {
    assert.equal(r.status, 'unassigned');
    assert.notEqual(r.sourceKind, 'measured');
  }
  assert.equal(ev.refusalBilling.status, 'uncertain');
});

// verify2 finding 2
test('an absent billable usage field stays unknown and is not a clean zero', () => {
  const u = normalizeUsage({
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
    cache_read_input_tokens: 10,
    output_tokens: 7,
  });
  assert.equal(u.uncachedInput, null);
  assert.ok(u.warnings.includes('usage_field_absent'));
  assert.ok(u.absentFields.includes('input_tokens'));
  const ev = qaEvidence([QA_MISSING_FIELD]);
  assert.equal(ev.totals.unknownFieldRequests.uncachedInput, 1);
  assert.equal(ev.status, 'ok_with_integrity_warnings');
});

test('absent and invalid usage propagate to the CLI status and exit 5', () => {
  // Asserted against the machine-readable bundle and the exit code only: the human
  // summary wording is not part of the contract and is deliberately not pinned.
  const missing = qaCli([QA_MISSING_FIELD], ['--json']);
  assert.equal(missing.code, 5);
  const missingEv = JSON.parse(missing.stdout);
  assert.equal(missingEv.status, 'ok_with_integrity_warnings');
  assert.equal(missingEv.totals.unknownFieldRequests.uncachedInput, 1);
  assert.equal(missingEv.inputIntegrity.usageWarningRequests, 1);
  assert.deepEqual(missingEv.inputIntegrity.usageWarningDetail[0].absentFields, ['input_tokens']);
  assert.ok(missingEv.inputIntegrity.usageWarningDetail[0].warnings.includes('usage_field_absent'));

  const negative = qaCli([QA_NEGATIVE], ['--json']);
  assert.equal(negative.code, 5);
  const negativeEv = JSON.parse(negative.stdout);
  assert.equal(negativeEv.status, 'ok_with_integrity_warnings');
  assert.equal(negativeEv.totals.unknownFieldRequests.uncachedInput, 1);
  assert.ok(negativeEv.inputIntegrity.usageWarningDetail[0].warnings.includes('negative_usage_value'));
});

// verify2 finding 3
test('a meter that crosses a reset publishes no cross-reset scalar delta', () => {
  const ev = qaEvidence([QA_RESET_A, QA_RESET_B]);
  const m = ev.meters['unified-5h'];
  assert.equal(m.crossesReset, true);
  assert.deepEqual(m.resetEpochs, [1000, 2000]);
  // last minus first across a reset is meaningless, so no scalar is published at all.
  assert.equal(m.observedTicks, null);
  assert.equal(m.observedDeltaUtilization, null);
  assert.ok(m.crossResetReason.length > 0);
  assert.equal(m.windows.length, 2);
  for (const w of m.windows) assert.ok(w.observedTicks >= 0);
});

// verify2 finding 4
test('a block mixing service tiers is not reported as one measured range', () => {
  const ev = qaEvidence([QA_BASE, QA_TIER_STANDARD, QA_TIER_PRIORITY]);
  const block = ev.blocks['test.writes'];
  assert.equal(block.requests, 2);
  assert.deepEqual(block.configIdentities, ['tier:priority', 'tier:standard']);
  assert.equal(block.homogeneousConfigIdentity, false);
  assert.equal(block.utilizationAttribution, 'unassigned');
  for (const r of ev.coefficientRecords.filter((x) => x.evidenceRef.block === 'test.writes')) {
    assert.equal(r.status, 'unassigned');
    assert.notEqual(r.sourceKind, 'measured');
    assert.match(r.observedRangeOrUncertainty.unattributableReason, /config|tier|identit/i);
  }
});

test('a block mixing low and high effort within the same service tier preserves full config identities and stays unassigned', () => {
  const low = { ...JSON.parse(QA_TIER_STANDARD), effort: 'low' };
  const high = { ...JSON.parse(QA_TIER_PRIORITY), effort: 'high' };
  high.usage.service_tier = 'standard';
  const identities = ['tier:standard|effort:high', 'tier:standard|effort:low'];
  assert.equal(normalizeRequest(low, 1).configIdentity, identities[1]);
  assert.equal(normalizeRequest(high, 2).configIdentity, identities[0]);
  const ev = qaEvidence([QA_BASE, JSON.stringify(low), JSON.stringify(high)]);
  const block = ev.blocks['test.writes'];
  assert.equal(block.requests, 2);
  assert.deepEqual(block.configIdentities, identities);
  assert.equal(block.homogeneousConfigIdentity, false);
  assert.equal(block.utilizationAttribution, 'unassigned');
  const recs = ev.coefficientRecords.filter((r) => r.evidenceRef.block === 'test.writes');
  assert.ok(recs.length > 0);
  for (const r of recs) {
    assert.equal(r.status, 'unassigned');
    assert.equal(r.sourceKind, 'unknown');
    assert.deepEqual(r.observedRangeOrUncertainty.configIdentities, identities);
    assert.deepEqual(r.observedRangeOrUncertainty.tokensPerTick, {
      lowTokensPerTick: null, highTokensPerTick: null, identifiable: false,
    });
  }
});

test('the CLI reports a primitive trials row alongside a valid trial with exit 5 and its line and type', () => {
  const { dir, path: rawPath } = tmpFile('raw.jsonl', `${QA_VALID_8}\n`);
  try {
    const trialsPath = path.join(dir, 'trials.jsonl');
    fs.writeFileSync(trialsPath, '{"modelUsage":{}}\n42\n');
    const cli = runCli([rawPath, '--json', '--trials', trialsPath], { timeout: 10_000 });
    assert.equal(cli.code, 5);
    const ev = JSON.parse(cli.stdout);
    assert.equal(ev.status, 'ok_with_integrity_warnings');
    assert.equal(ev.totals.requests, 1);
    assert.equal(ev.source.trials.rows, 1);
    assert.deepEqual(ev.source.trials.invalidRows, [{ line: 2, type: 'number' }]);
    assert.deepEqual(ev.inputIntegrity.invalidRows, []);
    assert.deepEqual(ev.source.trials.malformedLines, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// verify2 finding 5
test('a JSON primitive row is reported as structurally invalid instead of crashing', () => {
  const ev = qaEvidence([QA_VALID_8, '42']);
  assert.equal(ev.totals.requests, 1, 'the valid row must survive');
  assert.deepEqual(ev.inputIntegrity.invalidRows, [{ line: 2, type: 'number' }]);
  assert.equal(ev.status, 'ok_with_integrity_warnings');
  // A crash could not produce a parseable bundle or this exit code, so the machine
  // surface alone is a sufficient regression; the stderr wording is not pinned.
  const cli = qaCli([QA_VALID_8, '42'], ['--json']);
  assert.equal(cli.code, 5);
  const cliEv = JSON.parse(cli.stdout);
  assert.deepEqual(cliEv.inputIntegrity.invalidRows, [{ line: 2, type: 'number' }]);
  assert.equal(cliEv.totals.requests, 1);
  assert.equal(cliEv.status, 'ok_with_integrity_warnings');
});

// verify2 finding 6
test('a flag given without its value exits 3 instead of succeeding', () => {
  assert.equal(parseArgs(['raw.jsonl', '--out']).error, 'missing_flag_value');
  assert.equal(parseArgs(['raw.jsonl', '--markdown']).error, 'missing_flag_value');
  assert.equal(parseArgs(['raw.jsonl', '--trials']).error, 'missing_flag_value');
  // a following flag is not a value either
  assert.equal(parseArgs(['raw.jsonl', '--out', '--json']).error, 'missing_flag_value');
  const cli = qaCli([QA_VALID_8], ['--out']);
  assert.equal(cli.code, 3);
  assert.ok(!/^status:/m.test(cli.stdout), 'no success summary on a usage error');
});
