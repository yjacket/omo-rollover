#!/usr/bin/env node
// Offline quota evidence aggregator.
//
// Reads the proxy capture (raw.jsonl) produced by quota-test/<date>/proxy.mjs and
// re-derives every usage and quota-meter figure from the raw records. It performs
// no network access, issues no model requests, starts no timer and writes nothing
// unless --out is given.
//
// Design rules this file enforces (see .omo/plans/rollover-idle-cost-shadow.md task 2
// and rollover_agent_task/AGENT_TASK.md section A):
//   * raw usage is preserved as five immutable billable fields; an absent TTL split
//     is `unknown`, never 0 and never silently folded into the 1h lane;
//   * streaming snapshots / final totals and compaction iterations / parent totals
//     are each counted once;
//   * tool result text is input for the next request, never model output;
//   * every rate-limit meter is kept separate, with its own reset window;
//   * no coefficient is invented. Utilization is quantized to 0.01, so quota
//     coefficients are reported as quantization bounds with no point estimate, and
//     those bounds are explicitly not confidence intervals.
//
// Usage:
//   node scripts/quota-analysis.mjs <raw.jsonl> [--json] [--out <file>] [--markdown <file>]
//
// Exit codes:
//   0  aggregated cleanly
//   2  input missing, unreadable, or contains no usable request
//   3  command line usage error
//   5  aggregated, but the input has integrity warnings (malformed lines/conflicts)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'quota-analysis/1';

/** Observed reporting granularity of anthropic-ratelimit-*-utilization headers. */
export const UTILIZATION_RESOLUTION = 0.01;

export const SOURCE_KINDS = ['measured', 'reported_unverified', 'api_assumption', 'unknown'];

export const COEFFICIENT_STATUSES = [
  'measured',
  'range_only',
  'unidentified',
  'unassigned',
  'derived_from_reported',
];

/** Cost phases defined by AGENT_TASK A1. None of them is observable in a calibration capture. */
export const PHASES = ['warm', 'park_parent', 'restore_child', 'resume_raw', 'useful_work'];

const EXIT_OK = 0;
const EXIT_INPUT = 2;
const EXIT_USAGE = 3;
const EXIT_INTEGRITY = 5;

// ---------------------------------------------------------------- utilities

const round = (value, digits) => Number(value.toFixed(digits));

/** Utilization headers are decimal strings with 0.01 granularity; keep float noise out. */
const roundUtil = (value) => round(value, 4);

const ticksBetween = (from, to, resolution = UTILIZATION_RESOLUTION) =>
  Math.round(roundUtil(to - from) / resolution);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function blockOf(label) {
  if (typeof label !== 'string' || label === '') return 'unlabelled';
  return label.split('.').slice(0, 2).join('.');
}

// ----------------------------------------------------------- raw usage layer

function readCount(value, _field, warnings, options = {}) {
  if (value === undefined || value === null) {
    // A billable counter that the response never reported is unknown. Treating it as a
    // clean zero would silently invent a measurement.
    if (options.required) {
      if (!warnings.includes('usage_field_absent')) warnings.push('usage_field_absent');
      return { value: null, present: false, absent: true };
    }
    return { value: 0, present: false };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (!warnings.includes('non_numeric_usage_value')) warnings.push('non_numeric_usage_value');
    return { value: null, present: true };
  }
  if (value < 0) {
    if (!warnings.includes('negative_usage_value')) warnings.push('negative_usage_value');
    return { value: null, present: true };
  }
  return { value, present: true };
}

/**
 * Map a provider usage object onto the five immutable billable fields.
 *
 * The observed schema reports cache writes twice: `cache_creation_input_tokens` is
 * the total and `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` is the same
 * total split by TTL lane. Adding both would double count, so the split is treated as
 * authoritative and the total is used only as a consistency check.
 */
export function normalizeUsage(usage) {
  const warnings = [];
  const src = usage && typeof usage === 'object' ? usage : {};

  const absentFields = [];
  const required = (value, field) => {
    const read = readCount(value, field, warnings, { required: true });
    if (read.absent) absentFields.push(field);
    return read.value;
  };

  const uncachedInput = required(src.input_tokens, 'input_tokens');
  const cacheRead = required(src.cache_read_input_tokens, 'cache_read_input_tokens');
  const billedModelOutput = required(src.output_tokens, 'output_tokens');
  const writeTotal = required(src.cache_creation_input_tokens, 'cache_creation_input_tokens');

  const split = src.cache_creation;
  let cacheWrite5m = null;
  let cacheWrite1h = null;
  let cacheWriteUnknownTtl = 0;

  if (split && typeof split === 'object') {
    const w5 = readCount(split.ephemeral_5m_input_tokens, 'ephemeral_5m_input_tokens', warnings).value;
    const w1 = readCount(split.ephemeral_1h_input_tokens, 'ephemeral_1h_input_tokens', warnings).value;
    if (w5 === null || w1 === null) {
      warnings.push('cache_write_ttl_split_missing');
      cacheWriteUnknownTtl = writeTotal ?? 0;
    } else if (writeTotal !== null && w5 + w1 !== writeTotal) {
      // Do not reconcile by arithmetic: the lane attribution is simply not trustworthy.
      warnings.push('cache_write_split_inconsistent');
      cacheWriteUnknownTtl = writeTotal;
    } else {
      cacheWrite5m = w5;
      cacheWrite1h = w1;
    }
  } else if (writeTotal === 0) {
    // A zero write has an unambiguous split.
    cacheWrite5m = 0;
    cacheWrite1h = 0;
  } else {
    warnings.push('cache_write_ttl_split_missing');
    cacheWriteUnknownTtl = writeTotal;
  }

  // Tool results and summary documents are inputs to the NEXT request. They are kept
  // here only so that a caller can prove they were not added to model output.
  const toolResultTokens = readCount(src.tool_result_tokens, 'tool_result_tokens', warnings).value ?? 0;
  const summaryDocumentTokens = readCount(src.summary_document_tokens, 'summary_document_tokens', warnings).value ?? 0;

  return Object.freeze({
    uncachedInput,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteUnknownTtl,
    cacheRead,
    billedModelOutput,
    toolResultTokens,
    summaryDocumentTokens,
    cacheWriteReportedTotal: writeTotal,
    absentFields: Object.freeze(absentFields),
    warnings: Object.freeze(warnings),
  });
}

const BILLABLE_FIELDS = [
  'uncachedInput',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheWriteUnknownTtl',
  'cacheRead',
  'billedModelOutput',
];

export function sumUsage(records) {
  const totals = {
    requests: 0,
    uncachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnknownTtl: 0,
    cacheRead: 0,
    billedModelOutput: 0,
    toolResultTokens: 0,
    summaryDocumentTokens: 0,
    unknownFieldRequests: {},
  };
  for (const rec of records) {
    const u = rec.usage;
    totals.requests += 1;
    for (const f of BILLABLE_FIELDS) {
      const v = u[f];
      if (v === null) {
        totals.unknownFieldRequests[f] = (totals.unknownFieldRequests[f] ?? 0) + 1;
        continue;
      }
      totals[f] += v;
    }
    totals.toolResultTokens += u.toolResultTokens ?? 0;
    totals.summaryDocumentTokens += u.summaryDocumentTokens ?? 0;
  }
  return totals;
}

// -------------------------------------------------------------- meter layer

// A meter bucket id starts with a digit: 5h, 7d, 7d_oi. This deliberately excludes
// account-level unified attributes such as -overage-status or -representative-claim.
const METER_HEADER = /^anthropic-ratelimit-unified-([0-9][a-z0-9_]*)-(utilization|reset|status)$/;

export function extractMeters(headers) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const m = METER_HEADER.exec(String(rawKey).toLowerCase());
    if (!m) continue;
    const [, bucket, field] = m;
    const id = `unified-${bucket}`;
    if (!out[id]) out[id] = { meterId: id, utilization: null, resetEpoch: null, status: null };
    if (field === 'utilization') out[id].utilization = Number(rawValue);
    else if (field === 'reset') out[id].resetEpoch = Number(rawValue);
    else out[id].status = String(rawValue);
  }
  return out;
}

const ACCOUNT_HEADERS = [
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-representative-claim',
  'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-overage-disabled-reason',
  'anthropic-ratelimit-unified-fallback-percentage',
];

// ------------------------------------------------------------ request layer

/**
 * Identify the billing-relevant configuration of a request. An absent value is reported
 * as 'unreported' rather than assumed equal to a neighbouring request's tier.
 */
function configIdentityOf(raw) {
  const parts = [];
  parts.push(`tier:${raw.usage?.service_tier ?? 'unreported'}`);
  const effort = raw.effort ?? raw.usage?.effort ?? null;
  if (effort !== null) parts.push(`effort:${effort}`);
  if (raw.usage?.output_tokens_details?.thinking_tokens !== undefined) parts.push('thinking:present');
  return parts.join('|');
}

export function normalizeRequest(raw, index) {
  const usage = normalizeUsage(raw.usage);
  const label = typeof raw.label === 'string' ? raw.label : '';
  const iterations = Array.isArray(raw.usage?.iterations) ? raw.usage.iterations : [];
  const stopReason = raw.stop_reason ?? null;
  const httpStatus = typeof raw.status === 'number' ? raw.status : null;

  // A refusal still reports usage, but whether the subscription meter was charged for
  // it cannot be decided from the response alone. It is never silently treated as free
  // and never silently treated as billed.
  const billingStatus =
    stopReason === 'refusal' || raw.error || (httpStatus !== null && httpStatus >= 400)
      ? 'uncertain'
      : 'assumed_billed';

  return {
    index,
    label,
    block: blockOf(label),
    ts: raw.ts ?? null,
    tsRequestStart: raw.ts_req ?? null,
    model: raw.model ?? null,
    method: raw.method ?? null,
    endpoint: raw.path ?? null,
    httpStatus,
    stopReason,
    billingStatus,
    messageId: raw.msg_id ?? null,
    requestId: raw.headers?.['request-id'] ?? null,
    // Service tier, effort and thinking configuration change what a token costs. An
    // unreported value is recorded as 'unreported', never folded into a concrete tier.
    configIdentity: configIdentityOf(raw),
    responseByteLength: typeof raw.body_bytes === 'number' ? raw.body_bytes : null,
    // Compaction iterations are already included in the parent usage totals in this
    // schema, so they are recorded for provenance and never added on top.
    iterationCount: iterations.length,
    iterationAccounting: iterations.length ? 'folded_into_parent_total' : 'none',
    usage,
    meters: extractMeters(raw.headers),
    warnings: [...usage.warnings],
  };
}

export function dedupeRequests(requests) {
  const byId = new Map();
  const order = [];
  const dropped = [];
  const conflicts = [];

  for (const req of requests) {
    const key = req.messageId ?? req.requestId ?? `index:${req.index}`;
    if (!byId.has(key)) {
      byId.set(key, { ...req, usage: { ...req.usage, warnings: [...req.usage.warnings] } });
      order.push(key);
      continue;
    }
    const kept = byId.get(key);
    dropped.push({ index: req.index, messageId: req.messageId, requestId: req.requestId, reason: 'duplicate_message_id' });

    for (const f of BILLABLE_FIELDS) {
      const a = kept.usage[f];
      const b = req.usage[f];
      if (a === b) continue;
      if (f === 'billedModelOutput') {
        // message_delta carries a cumulative output total: take the maximum, never the sum.
        kept.usage[f] = a === null ? b : b === null ? a : Math.max(a, b);
        continue;
      }
      conflicts.push({ messageId: key, field: f, values: [a, b] });
      kept.usage[f] = a === null ? b : b === null ? a : Math.max(a, b);
    }
    kept.duplicateOf = (kept.duplicateOf ?? 0) + 1;
  }

  return { requests: order.map((k) => byId.get(k)), dropped, conflicts };
}

export function contiguousRuns(requests, keyFn) {
  const runs = [];
  for (const req of requests) {
    const key = keyFn(req);
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.requests.push(req);
      last.endIndex = req.index;
      continue;
    }
    runs.push({ key, startIndex: req.index, endIndex: req.index, requests: [req], contiguous: true });
  }
  return runs;
}

// -------------------------------------------------- quantization arithmetic

/**
 * A utilization gauge quantized to `resolution` that moved `observedTicks` steps
 * bounds the true consumption strictly between (t-1) and (t+1) ticks. These are
 * arithmetic bounds from the display granularity, not a statistical interval.
 */
export function quantizationBounds(observedTicks, resolution = UTILIZATION_RESOLUTION) {
  return {
    observedTicks,
    resolution,
    lowTicksExclusive: observedTicks - 1,
    highTicksExclusive: observedTicks + 1,
    lowUtilizationExclusive: round((observedTicks - 1) * resolution, 6),
    highUtilizationExclusive: round((observedTicks + 1) * resolution, 6),
    rangeKind: 'quantization_bounds',
    statisticalConfidenceInterval: false,
  };
}

export function perTickTokenRange(tokens, observedTicks, resolution = UTILIZATION_RESOLUTION) {
  const bounds = quantizationBounds(observedTicks, resolution);
  if (observedTicks <= 0) {
    return {
      tokens,
      observedTicks,
      identifiable: false,
      boundedAbove: false,
      lowTokensPerTick: null,
      highTokensPerTick: null,
      pointEstimate: null,
      rangeKind: 'quantization_bounds',
      statisticalConfidenceInterval: false,
      reason: 'no_observed_tick_in_window',
      bounds,
    };
  }
  const boundedAbove = observedTicks - 1 > 0;
  return {
    tokens,
    observedTicks,
    identifiable: true,
    boundedAbove,
    lowTokensPerTick: tokens / (observedTicks + 1),
    highTokensPerTick: boundedAbove ? tokens / (observedTicks - 1) : null,
    // A midpoint would be an invented coefficient, so none is published.
    pointEstimate: null,
    rangeKind: 'quantization_bounds',
    statisticalConfidenceInterval: false,
    bounds,
  };
}

/** Split a request sequence into per-reset windows for one meter; never span a reset. */
export function meterWindows(requests, meterId) {
  const windows = [];
  for (const req of requests) {
    const m = req.meters?.[meterId];
    if (!m || m.utilization === null || Number.isNaN(m.utilization)) continue;
    const last = windows[windows.length - 1];
    if (last && last.resetEpoch === m.resetEpoch) {
      last.endUtilization = m.utilization;
      last.lastIndex = req.index;
      last.requests += 1;
      continue;
    }
    windows.push({
      meterId,
      resetEpoch: m.resetEpoch,
      firstIndex: req.index,
      lastIndex: req.index,
      requests: 1,
      startUtilization: m.utilization,
      endUtilization: m.utilization,
      spansReset: false,
    });
  }
  for (const w of windows) {
    w.observedTicks = Math.max(0, ticksBetween(w.startUtilization, w.endUtilization));
    w.observedDeltaUtilization = roundUtil(w.endUtilization - w.startUtilization);
  }
  return windows;
}

// ------------------------------------------------- fable write tick analysis

function neighborView(requests, centerIndex, span, meterId) {
  const out = [];
  for (const req of requests) {
    if (Math.abs(req.index - centerIndex) > span) continue;
    const m = req.meters?.[meterId];
    out.push({
      index: req.index,
      requestId: req.requestId,
      messageId: req.messageId,
      ts: req.ts,
      tsRequestStart: req.tsRequestStart,
      label: req.label,
      model: req.model,
      stopReason: req.stopReason,
      cacheWrite1h: req.usage.cacheWrite1h,
      cacheWrite5m: req.usage.cacheWrite5m,
      cacheRead: req.usage.cacheRead,
      billedModelOutput: req.usage.billedModelOutput,
      utilization: m?.utilization ?? null,
      resetEpoch: m?.resetEpoch ?? null,
    });
  }
  return out;
}

/**
 * Re-aggregate the fable cache-write block around the delayed +0.02 tick.
 *
 * The capture shows a tick landing on a request that wrote nothing, which proves the
 * gauge lags at least one request. That makes the boundary of the write block
 * ambiguous, so both attributions are reported and neither is selected.
 */
export function analyzeFableWriteTicks(requests, options = {}) {
  const { model = 'claude-fable-5-1', writeBlockSuffix = 'WR', meterId = 'unified-5h' } = options;

  const runs = contiguousRuns(requests, (r) => `${r.model}|${r.block}`);
  const writeRun = runs.find(
    (r) => r.key === `${model}|${blockOf(`${model.split('-')[1]}.${writeBlockSuffix}`)}` ||
      (r.requests[0].model === model && r.requests[0].block.endsWith(`.${writeBlockSuffix}`)),
  );
  if (!writeRun) {
    return { available: false, resolved: false, reason: 'no_write_block_for_model', model, hypotheses: [] };
  }

  const writeRequests = writeRun.requests.filter((r) => (r.usage.cacheWrite1h ?? 0) > 0);
  const writeTokens = writeRequests.reduce((a, r) => a + (r.usage.cacheWrite1h ?? 0), 0);

  const baseline = requests.filter((r) => r.index < writeRun.startIndex).pop() ?? writeRun.requests[0];
  const baselineUtil = baseline.meters?.[meterId]?.utilization ?? null;
  const blockEnd = writeRun.requests[writeRun.requests.length - 1];
  const blockEndUtil = blockEnd.meters?.[meterId]?.utilization ?? null;

  // The block-local tick count (hypothesis H6).
  const shortTicks = ticksBetween(baselineUtil, blockEndUtil);

  // The following same-model run: if the lag extends past the write block, its ticks
  // belong to the writes instead of to its own reads (hypothesis H8).
  const nextRun = runs.find((r) => r.startIndex > writeRun.endIndex && r.requests[0].model === model);
  const tailEnd = nextRun ? nextRun.requests[nextRun.requests.length - 1] : blockEnd;
  const tailEndUtil = tailEnd.meters?.[meterId]?.utilization ?? blockEndUtil;
  const longTicks = ticksBetween(baselineUtil, tailEndUtil);

  // The delayed tick itself: a request inside the write run that wrote nothing yet moved the gauge.
  let delayedTick = null;
  let prev = baseline;
  for (const req of writeRun.requests) {
    const before = prev.meters?.[meterId]?.utilization ?? null;
    const after = req.meters?.[meterId]?.utilization ?? null;
    if (before !== null && after !== null && after > before && (req.usage.cacheWrite1h ?? 0) === 0 && (req.usage.cacheWrite5m ?? 0) === 0) {
      delayedTick = {
        index: req.index,
        requestId: req.requestId,
        messageId: req.messageId,
        ts: req.ts,
        tsRequestStart: req.tsRequestStart,
        label: req.label,
        cacheWrite1h: req.usage.cacheWrite1h,
        cacheWrite5m: req.usage.cacheWrite5m,
        cacheRead: req.usage.cacheRead,
        billedModelOutput: req.usage.billedModelOutput,
        utilizationBefore: before,
        utilizationAfter: after,
        deltaUtilization: roundUtil(after - before),
        precedingRequestId: prev.requestId,
        gapSeconds: round((Date.parse(req.ts) - Date.parse(prev.ts)) / 1000, 3),
      };
    }
    prev = req;
  }

  const nextRunReadTokens = nextRun
    ? nextRun.requests.reduce((a, r) => a + (r.usage.cacheRead ?? 0), 0)
    : 0;
  const nextRunTicks = nextRun
    ? ticksBetween(blockEndUtil, tailEndUtil)
    : 0;

  const center = delayedTick ? delayedTick.index : writeRun.endIndex;
  const neighbors = neighborView(requests, center, 3, meterId);

  const hypotheses = [
    {
      id: 'H6',
      observedTicks: shortTicks,
      attribution: 'lag_is_contained_within_the_write_block',
      window: {
        fromRequestId: baseline.requestId,
        fromIndex: baseline.index,
        fromTs: baseline.ts,
        fromUtilization: baselineUtil,
        toRequestId: blockEnd.requestId,
        toIndex: blockEnd.index,
        toTs: blockEnd.ts,
        toUtilization: blockEndUtil,
        resetEpoch: baseline.meters?.[meterId]?.resetEpoch ?? null,
      },
      writeRequests: writeRequests.length,
      writeTokens,
      perTickTokens: perTickTokenRange(writeTokens, shortTicks),
      readTicksLeftForNextRun: nextRunTicks,
      evidenceFor: [
        'the gauge returns to a flat value on the first request of the following run, so the lag tail ends inside the write block',
        'the following run consists of cache reads that do move the same gauge later in the capture, which requires a nonzero read cost',
      ],
      evidenceAgainst: [
        'a tick landed on a request that wrote nothing, so either the accounting lags by an unmeasured amount or unrelated concurrent account usage moved the same meter; neither is excluded',
      ],
      neighborRequests: neighbors,
    },
    {
      id: 'H8',
      observedTicks: longTicks,
      attribution: 'lag_extends_into_the_following_read_run',
      window: {
        fromRequestId: baseline.requestId,
        fromIndex: baseline.index,
        fromTs: baseline.ts,
        fromUtilization: baselineUtil,
        toRequestId: tailEnd.requestId,
        toIndex: tailEnd.index,
        toTs: tailEnd.ts,
        toUtilization: tailEndUtil,
        resetEpoch: tailEnd.meters?.[meterId]?.resetEpoch ?? null,
      },
      writeRequests: writeRequests.length,
      writeTokens,
      perTickTokens: perTickTokenRange(writeTokens, longTicks),
      readTicksLeftForNextRun: 0,
      evidenceFor: [
        'the delayed tick on a zero-write request is consistent with a lagging gauge, and nothing in the capture bounds how far such a lag can reach',
        'the two later ticks fall while the same prefix is only being read, with no new write in this capture to explain them',
      ],
      evidenceAgainst: [
        'the later ticks are separated by tens of requests and several minutes, which is a long tail for a lag that was otherwise one request long',
        'under this attribution the fable read cost would be zero over millions of read tokens, which the opus read block contradicts',
      ],
      neighborRequests: neighbors,
    },
  ];

  return {
    available: true,
    model,
    meterId,
    resolved: false,
    resolutionBlockedBy: 'gauge_granularity, unmeasured accounting lag, and unobservable concurrent account usage',
    discriminatingExperiment: 'docs/idle-experiments.md fable write tick plan (not executed)',
    // A tick on a request that wrote nothing is CONSISTENT with a lagging gauge, but the
    // capture cannot exclude other causes, so it is not treated as proof of lag.
    lagObserved: Boolean(delayedTick),
    lagExclusivelyEstablished: false,
    alternativeExplanations: delayedTick
      ? [
          'the gauge lags, and this tick is deferred accounting for an earlier write in the same block',
          'usage unrelated to this capture consumed the same shared account meter during the window; the proxy only sees its own requests, so concurrent traffic is unobservable here',
          'the gauge aggregates server side on an interval boundary that happens to fall on this request rather than on the request that caused the consumption',
        ]
      : [],
    delayedTick,
    writeBlock: {
      block: writeRun.requests[0].block,
      startIndex: writeRun.startIndex,
      endIndex: writeRun.endIndex,
      requests: writeRun.requests.length,
      writeRequests: writeRequests.length,
      writeTokens,
      requestIds: writeRun.requests.map((r) => r.requestId),
    },
    followingRun: nextRun
      ? {
          block: nextRun.requests[0].block,
          startIndex: nextRun.startIndex,
          endIndex: nextRun.endIndex,
          requests: nextRun.requests.length,
          readTokens: nextRunReadTokens,
          observedTicks: nextRunTicks,
          requestIds: [nextRun.requests[0].requestId, nextRun.requests[nextRun.requests.length - 1].requestId],
        }
      : null,
    hypotheses,
  };
}

function ratioFromHypothesis(h, readTokens, readTicks) {
  const write = h.perTickTokens;
  const read = perTickTokenRange(readTokens, readTicks);
  if (!write.identifiable || !read.identifiable || !write.boundedAbove || !read.boundedAbove) {
    return {
      hypothesisId: h.id,
      identifiable: false,
      low: null,
      high: null,
      pointEstimate: null,
      rangeKind: 'quantization_bounds',
      statisticalConfidenceInterval: false,
      reason: !read.identifiable
        ? 'no_read_tick_left_under_this_attribution'
        : 'one_sided_bound_only',
      writePerTick: write,
      readPerTick: read,
    };
  }
  // read-cost-per-token / write-cost-per-token == writeTokensPerTick / readTokensPerTick
  return {
    hypothesisId: h.id,
    identifiable: true,
    low: write.lowTokensPerTick / read.highTokensPerTick,
    high: write.highTokensPerTick / read.lowTokensPerTick,
    pointEstimate: null,
    rangeKind: 'quantization_bounds',
    statisticalConfidenceInterval: false,
    writePerTick: write,
    readPerTick: read,
  };
}

// -------------------------------------------------- reported cost unit solve

function gaussRank(rows, cols, tol = 1e-6) {
  const m = rows.map((r) => [...r]);
  let rank = 0;
  for (let c = 0; c < cols && rank < m.length; c += 1) {
    let pivot = -1;
    let best = tol;
    for (let r = rank; r < m.length; r += 1) {
      if (Math.abs(m[r][c]) > best) {
        best = Math.abs(m[r][c]);
        pivot = r;
      }
    }
    if (pivot < 0) continue;
    [m[rank], m[pivot]] = [m[pivot], m[rank]];
    for (let r = 0; r < m.length; r += 1) {
      if (r === rank) continue;
      const f = m[r][c] / m[rank][c];
      for (let k = c; k < cols; k += 1) m[r][k] -= f * m[rank][k];
    }
    rank += 1;
  }
  return rank;
}

function solveNormalEquations(featureRows, targets, n) {
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let idx = 0; idx < featureRows.length; idx += 1) {
    const f = featureRows[idx];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) A[i][j] += f[i] * f[j];
      b[i] += f[i] * targets[idx];
    }
  }
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    if (Math.abs(M[c][c]) < 1e-18) return null;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const x = [];
  for (let i = 0; i < n; i += 1) x.push(M[i][n] / M[i][i]);
  return x;
}

/**
 * Recover the per-token unit prices the CLI used for its own costUSD figures.
 *
 * This is an exact re-derivation of a REPORTED number, not a measurement of the
 * subscription quota meter, and it is labelled as such. It exists so that the price
 * table in earlier documents does not have to be copied on trust.
 */
export function solveListPriceUnits(trials) {
  const byModel = new Map();
  for (const t of trials) {
    for (const [model, mu] of Object.entries(t?.modelUsage ?? {})) {
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push(mu);
    }
  }

  const out = {};
  for (const [model, rows] of byModel) {
    const feat = (mu) => [
      Number(mu.inputTokens ?? 0),
      Number(mu.cacheCreationInputTokens ?? 0),
      Number(mu.cacheReadInputTokens ?? 0),
      Number(mu.outputTokens ?? 0),
    ];
    const distinct = [...new Set(rows.map((mu) => feat(mu).join(',')))].map((s) => s.split(',').map(Number));
    const rank = gaussRank(distinct, 4);
    const base = {
      modelId: model,
      provider: rows[0]?.provider ?? 'unknown',
      costBasis: rows[0]?.costBasis ?? 'unknown',
      contextWindow: rows[0]?.contextWindow ?? null,
      maxOutputTokens: rows[0]?.maxOutputTokens ?? null,
      sampleCount: rows.length,
      distinctPatterns: distinct.length,
      rank,
      quotaMeterOrCostUnit: 'usd_per_mtok_list_reported_by_cli',
      sourceKind: 'reported_unverified',
      ttlLane: 'unsplit_in_source',
    };
    if (rank < 4) {
      out[model] = { ...base, status: 'unidentified', usdPerMtok: null, maxResidualUsd: null, reason: 'rank_deficient' };
      continue;
    }
    const scaled = rows.map((mu) => feat(mu).map((v) => v / 1e6));
    const targets = rows.map((mu) => Number(mu.costUSD ?? 0));
    const x = solveNormalEquations(scaled, targets, 4);
    if (!x) {
      out[model] = { ...base, status: 'unidentified', usdPerMtok: null, maxResidualUsd: null, reason: 'singular_normal_equations' };
      continue;
    }
    let maxResidualUsd = 0;
    for (let i = 0; i < scaled.length; i += 1) {
      let pred = 0;
      for (let j = 0; j < 4; j += 1) pred += scaled[i][j] * x[j];
      maxResidualUsd = Math.max(maxResidualUsd, Math.abs(pred - targets[i]));
    }
    out[model] = {
      ...base,
      status: 'derived_from_reported',
      usdPerMtok: { input: x[0], cacheWrite: x[1], cacheRead: x[2], output: x[3] },
      maxResidualUsd,
      reason: null,
    };
  }
  return out;
}

// ------------------------------------------------------------- conversion

export function convertToQuota(totals, record) {
  const coefficients = record?.coefficients ?? {};
  const missingCoefficients = Object.entries(coefficients)
    .filter(([, v]) => v === null || v === undefined)
    .map(([k]) => k)
    .sort();

  const unit = String(record?.quotaMeterOrCostUnit ?? '');
  const crossModelAggregation = unit.startsWith('usd_per_mtok')
    ? 'comparable_in_reported_usd_only'
    : 'not_comparable';

  const base = { value: null, unit: record?.quotaMeterOrCostUnit ?? null, modelId: record?.modelId ?? null, missingCoefficients, crossModelAggregation };

  if ((totals.cacheWriteUnknownTtl ?? 0) > 0) {
    return { ...base, reason: 'cache_write_ttl_unknown' };
  }
  if (missingCoefficients.length > 0) {
    return { ...base, reason: 'coefficients_unidentified' };
  }
  const value =
    coefficients.kInput * (totals.uncachedInput ?? 0) +
    coefficients.kWrite5 * (totals.cacheWrite5m ?? 0) +
    coefficients.kWrite60 * (totals.cacheWrite1h ?? 0) +
    coefficients.kRead * (totals.cacheRead ?? 0) +
    coefficients.kOutput * (totals.billedModelOutput ?? 0);
  return { ...base, value, reason: null, coefficientVersion: record?.version ?? null };
}

// ------------------------------------------------------------ sanitization

const SENSITIVE_KEY = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /api[-_]?key/i,
  /(^|_)secret/i,
  /(^|_)password/i,
  /^prompt/i,
  /^body(?!Bytes$)/i,
  /result_preview/i,
  /^stderr$/i,
  /(access|refresh)_token/i,
];

const SENSITIVE_VALUE = [/sk-ant-/i, /^bearer\s+/i];

export function findSensitive(value, at = '$') {
  const found = [];
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      found.push(...findSensitive(v, `${at}[${i}]`));
    });
    return found;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${at}.${k}`;
      if (SENSITIVE_KEY.some((re) => re.test(k))) {
        found.push({ path: p, reason: 'sensitive_key' });
        continue;
      }
      found.push(...findSensitive(v, p));
    }
    return found;
  }
  if (typeof value === 'string' && SENSITIVE_VALUE.some((re) => re.test(value))) {
    found.push({ path: at, reason: 'sensitive_value' });
  }
  return found;
}

// --------------------------------------------------------------- evidence

function parseJsonl(text) {
  const rows = [];
  const malformedLines = [];
  const invalidRows = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines.push(i + 1);
      return;
    }
    // A syntactically valid JSON scalar or array is still not a capture record. It is
    // reported by line number instead of being fed to code that expects an object.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalidRows.push({
        line: i + 1,
        type: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
      });
      return;
    }
    rows.push(parsed);
  });
  return { rows, malformedLines, invalidRows, lineCount: lines.filter((l) => l.trim()).length };
}

function meterSummary(requests) {
  const out = {};
  for (const req of requests) {
    for (const [id, m] of Object.entries(req.meters)) {
      if (!out[id]) {
        out[id] = {
          meterId: id,
          requests: 0,
          models: new Set(),
          resetEpochSet: new Set(),
          statuses: new Set(),
          firstUtilization: m.utilization,
          lastUtilization: m.utilization,
          firstTs: req.ts,
          lastTs: req.ts,
        };
      }
      const e = out[id];
      e.requests += 1;
      if (req.model) e.models.add(req.model);
      if (m.resetEpoch !== null) e.resetEpochSet.add(m.resetEpoch);
      if (m.status) e.statuses.add(m.status);
      e.lastUtilization = m.utilization;
      e.lastTs = req.ts;
    }
  }
  const final = {};
  for (const [id, e] of Object.entries(out)) {
    const windows = meterWindows(requests, id);
    final[id] = {
      meterId: id,
      requests: e.requests,
      models: [...e.models].sort(),
      resetEpochs: [...e.resetEpochSet].sort((a, b) => a - b),
      resetIso: [...e.resetEpochSet].sort((a, b) => a - b).map((s) => new Date(s * 1000).toISOString()),
      statuses: [...e.statuses].sort(),
      firstUtilization: e.firstUtilization,
      lastUtilization: e.lastUtilization,
      // A last-minus-first delta across a reset subtracts readings from two different
      // limit windows and can even go negative, so no such scalar is published at all.
      crossesReset: e.resetEpochSet.size > 1,
      crossResetReason:
        e.resetEpochSet.size > 1
          ? 'the meter reset inside the capture, so a last minus first value would span two different limit windows; only per window values are published'
          : null,
      observedDeltaUtilization:
        e.resetEpochSet.size > 1 ? null : roundUtil(e.lastUtilization - e.firstUtilization),
      observedTicks:
        e.resetEpochSet.size > 1 ? null : ticksBetween(e.firstUtilization, e.lastUtilization),
      firstTs: e.firstTs,
      lastTs: e.lastTs,
      windows,
      aggregationRule: 'kept separate; never summed with another meter',
    };
  }
  return final;
}

/**
 * Every reason a block's gauge movement cannot be charged to that block. Any one of
 * these rejects the whole window: the delta is shared, so dropping the offending rows
 * would keep movement the remaining rows did not necessarily cause.
 */
function blockAttributionBlockers({ runs, models, configIdentities, billingUncertainCount }) {
  const blockers = [];
  if (runs !== 1) blockers.push('block is interleaved with other blocks, so gauge movement cannot be attributed to it');
  if (models.length !== 1) blockers.push('multiple models inside one run: the meter cannot be split between them');
  if (configIdentities.length !== 1)
    blockers.push(
      `the window mixes configuration identities (${configIdentities.join(', ')}), so the service tier or effort behind the movement is not determined`,
    );
  if (billingUncertainCount > 0)
    blockers.push(
      `${billingUncertainCount} request(s) in this window have uncertain billing, so the whole window is rejected rather than measured`,
    );
  return blockers;
}

function blockSummary(requests) {
  const runs = contiguousRuns(requests, (r) => r.block);
  const byBlock = new Map();
  for (const run of runs) {
    if (!byBlock.has(run.key)) byBlock.set(run.key, []);
    byBlock.get(run.key).push(run);
  }
  const out = {};
  for (const [block, blockRuns] of byBlock) {
    const all = blockRuns.flatMap((r) => r.requests);
    const totals = sumUsage(all);
    const models = [...new Set(all.map((r) => r.model))].sort();
    const configIdentities = [
      ...new Set(all.map((r) => r.configIdentity ?? '')),
    ].filter(Boolean).sort();
    const homogeneousConfigIdentity = configIdentities.length === 1;
    const billingUncertainCount = all.filter((r) => r.billingStatus === 'uncertain').length;
    out[block] = {
      block,
      requests: all.length,
      refusals: all.filter((r) => r.stopReason === 'refusal').length,
      billingUncertain: billingUncertainCount,
      models,
      configIdentities,
      homogeneousConfigIdentity,
      totals: { ...totals, unknownFieldRequests: totals.unknownFieldRequests },
      runs: blockRuns.map((r) => ({
        startIndex: r.startIndex,
        endIndex: r.endIndex,
        requests: r.requests.length,
        firstRequestId: r.requests[0].requestId,
        lastRequestId: r.requests[r.requests.length - 1].requestId,
        firstTs: r.requests[0].ts,
        lastTs: r.requests[r.requests.length - 1].ts,
      })),
      contiguous: blockRuns.length === 1,
      homogeneousModel: models.length === 1,
      utilizationAttribution: blockAttributionBlockers({
        runs: blockRuns.length,
        models,
        configIdentities,
        billingUncertainCount,
      }).length
        ? 'unassigned'
        : 'attributable_to_run',
      attributionReason:
        blockAttributionBlockers({
          runs: blockRuns.length,
          models,
          configIdentities,
          billingUncertainCount,
        }).join('; ') || null,
    };
  }
  return out;
}

function quotaCoefficientRecords({ requests, blocks, meters, evidenceRef, identity, validFrom, measuredAt }) {
  const records = [];
  for (const [block, info] of Object.entries(blocks)) {
    // Blocks that fail model or contiguity identity have no single run to anchor a
    // window on, so no record can be formed at all. Windows that fail only billing or
    // configuration identity DO form a record, reported as unassigned.
    if (!info.homogeneousModel || !info.contiguous) continue;
    const model = info.models[0];
    if (!model) continue;
    const run = info.runs[0];
    const runRequests = requests.filter((r) => r.index >= run.startIndex && r.index <= run.endIndex);
    for (const meterId of Object.keys(meters)) {
      const present = runRequests.filter((r) => r.meters[meterId]);
      if (present.length !== runRequests.length || present.length === 0) continue;
      const before = requests.filter((r) => r.index < run.startIndex && r.meters[meterId]).pop();
      if (!before) continue;
      const startUtil = before.meters[meterId].utilization;
      const endUtil = present[present.length - 1].meters[meterId].utilization;
      const resetBefore = before.meters[meterId].resetEpoch;
      const resetAfter = present[present.length - 1].meters[meterId].resetEpoch;
      if (resetBefore !== resetAfter) continue; // never compare across a reset
      const observedTicks = ticksBetween(startUtil, endUtil);
      const totals = info.totals;
      const dominant =
        totals.cacheWrite1h > 0 && totals.cacheRead < totals.cacheWrite1h
          ? 'cacheWrite1h'
          : totals.cacheRead > 0
            ? 'cacheRead'
            : null;
      if (!dominant) continue;
      const tokens = dominant === 'cacheWrite1h' ? totals.cacheWrite1h : totals.cacheRead;
      const range = perTickTokenRange(tokens, observedTicks);
      // The baseline reading must come from the request immediately before the run.
      // Some meters are only returned for some models, so the previous reading of a
      // meter can sit hundreds of requests back with unrelated traffic in between;
      // that gap makes the delta unattributable to this block.
      const baselineGapRequests = run.startIndex - before.index;
      const attributionBlockers = blockAttributionBlockers({
        runs: info.runs.length,
        models: info.models,
        configIdentities: info.configIdentities,
        billingUncertainCount: info.billingUncertain,
      });
      if (baselineGapRequests !== 1) {
        attributionBlockers.push(
          'the previous reading of this meter is not the immediately preceding request, so traffic in the gap may account for the movement',
        );
      }
      const attributable = attributionBlockers.length === 0;
      records.push({
        modelId: model,
        provider: identity.provider[model] ?? 'unknown',
        authLane: 'oauth_subscription',
        ttlLane: dominant === 'cacheWrite1h' ? 'ephemeral_1h' : 'not_applicable_read',
        effortOrConfigIdentity: identity.config,
        quotaMeterOrCostUnit: `${meterId}-utilization-tick`,
        validFrom,
        measuredAt,
        // An unattributable window is not a measurement of anything.
        sourceKind: attributable ? 'measured' : 'unknown',
        evidenceRef: {
          ...evidenceRef,
          block,
          indexRange: [run.startIndex, run.endIndex],
          baselineRequestId: before.requestId,
          baselineIndex: before.index,
          baselineGapRequests,
          firstRequestId: run.firstRequestId,
          lastRequestId: run.lastRequestId,
          resetEpoch: resetAfter,
        },
        sampleCount: info.requests,
        // No point coefficient is published: the gauge granularity only supports bounds.
        coefficients: { kInput: null, kWrite5: null, kWrite60: null, kRead: null, kOutput: null },
        observedRangeOrUncertainty: {
          dominantComponent: dominant,
          tokens,
          observedTicks,
          statisticalConfidenceInterval: false,
          rangeKind: 'quantization_bounds',
          tokensPerTick: attributable
            ? range
            : { lowTokensPerTick: null, highTokensPerTick: null, identifiable: false },
          contaminatingComponents: {
            uncachedInput: totals.uncachedInput,
            cacheWrite5m: totals.cacheWrite5m,
            cacheRead: dominant === 'cacheWrite1h' ? totals.cacheRead : totals.cacheWrite1h,
            billedModelOutput: totals.billedModelOutput,
          },
          billingUncertainRequests: info.billingUncertain,
          configIdentities: info.configIdentities,
          baselineGapRequests,
          unattributableReason: attributable ? null : attributionBlockers.join('; '),
        },
        status: !attributable ? 'unassigned' : range.identifiable ? 'range_only' : 'unidentified',
        version: SCHEMA_VERSION,
      });
    }
  }
  return records;
}

export function buildEvidence({ rawPath, rawText, trialsPath = null, trialsText = null, generatedAt = null }) {
  const { rows, malformedLines, invalidRows, lineCount } = parseJsonl(rawText);

  const messageRows = rows.filter((r) => r?.path === '/v1/messages' && r?.usage);
  const nonBillableRows = rows.length - messageRows.length;
  const transportErrorRows = rows.filter((r) => r && 'proxy_error' in r).length;

  const normalized = messageRows.map((r, i) => normalizeRequest(r, i));
  const { requests, dropped, conflicts } = dedupeRequests(normalized);

  const totals = sumUsage(requests);
  // Usage level validation problems are integrity problems: they must reach the CLI
  // status and exit code rather than being visible only inside the bundle.
  const usageWarningRequests = requests
    .filter((r) => r.usage.warnings.length > 0)
    .map((r) => ({
      requestId: r.requestId,
      index: r.index,
      warnings: [...r.usage.warnings],
      absentFields: [...(r.usage.absentFields ?? [])],
    }));
  const meters = meterSummary(requests);
  const blocks = blockSummary(requests);

  const tsValues = requests.map((r) => r.ts).filter(Boolean).sort();
  const validFrom = tsValues[0] ?? null;
  const measuredAt = tsValues[tsValues.length - 1] ?? null;

  // Configuration identity is read from the capture itself, not from any prior report.
  const serviceTiers = [...new Set(messageRows.map((r) => r.usage?.service_tier).filter(Boolean))].sort();
  const thinkingTokens = [...new Set(messageRows.map((r) => r.usage?.output_tokens_details?.thinking_tokens).filter((v) => v !== undefined))].sort();
  const accountHeaders = {};
  for (const h of ACCOUNT_HEADERS) {
    const seen = [...new Set(messageRows.map((r) => r.headers?.[h]).filter((v) => v !== undefined))];
    if (seen.length) accountHeaders[h] = seen.length === 1 ? seen[0] : seen;
  }

  let trials = [];
  let trialsIntegrity = { available: false, path: trialsPath, sha256: null, rows: 0, malformedLines: [], invalidRows: [] };
  if (trialsText !== null) {
    const parsedTrials = parseJsonl(trialsText);
    trials = parsedTrials.rows;
    trialsIntegrity = {
      available: true,
      path: trialsPath,
      sha256: sha256(trialsText),
      rows: trials.length,
      malformedLines: parsedTrials.malformedLines,
      invalidRows: parsedTrials.invalidRows,
    };
  }
  const listPrices = solveListPriceUnits(trials);

  const identity = {
    provider: Object.fromEntries(Object.entries(listPrices).map(([m, v]) => [m, v.provider])),
    config: {
      serviceTier: serviceTiers.length === 1 ? serviceTiers[0] : serviceTiers,
      thinkingTokensObserved: thinkingTokens,
      contextWindow: Object.fromEntries(Object.entries(listPrices).map(([m, v]) => [m, v.contextWindow])),
      maxOutputTokens: Object.fromEntries(Object.entries(listPrices).map(([m, v]) => [m, v.maxOutputTokens])),
      accountHeaders,
      note: 'identity fields are recorded to keep measurements from different conditions apart, not to assert that they change price',
    },
  };

  const evidenceRef = { file: rawPath, sha256: sha256(rawText) };

  const coefficientRecords = quotaCoefficientRecords({
    requests,
    blocks,
    meters,
    evidenceRef,
    identity,
    validFrom,
    measuredAt,
  });

  for (const [model, lp] of Object.entries(listPrices)) {
    coefficientRecords.push({
      modelId: model,
      provider: lp.provider,
      authLane: 'cli_reported_cost_accounting',
      ttlLane: lp.ttlLane,
      effortOrConfigIdentity: identity.config,
      quotaMeterOrCostUnit: lp.quotaMeterOrCostUnit,
      validFrom,
      measuredAt,
      sourceKind: lp.sourceKind,
      evidenceRef: { file: trialsIntegrity.path, sha256: trialsIntegrity.sha256, rows: lp.sampleCount, distinctPatterns: lp.distinctPatterns },
      sampleCount: lp.sampleCount,
      coefficients: lp.usdPerMtok
        ? {
            kInput: lp.usdPerMtok.input / 1e6,
            // The reported cost data does not split the write lane by TTL, so neither
            // TTL coefficient may be filled from it.
            kWrite5: null,
            kWrite60: null,
            kCacheWriteUnsplit: lp.usdPerMtok.cacheWrite / 1e6,
            kRead: lp.usdPerMtok.cacheRead / 1e6,
            kOutput: lp.usdPerMtok.output / 1e6,
          }
        : { kInput: null, kWrite5: null, kWrite60: null, kCacheWriteUnsplit: null, kRead: null, kOutput: null },
      observedRangeOrUncertainty: {
        statisticalConfidenceInterval: false,
        rangeKind: 'exact_solve_of_reported_values',
        maxResidualUsd: lp.maxResidualUsd,
        rank: lp.rank,
        usdPerMtok: lp.usdPerMtok,
        caveat: 'these are the unit prices the CLI used for its own cost figures; they are not a measurement of the subscription quota meter and must not be substituted for one',
      },
      status: lp.status,
      version: SCHEMA_VERSION,
    });
  }

  const fableWriteTicks = analyzeFableWriteTicks(requests);
  const fableReadRun = fableWriteTicks.followingRun;
  const perHypothesis = fableWriteTicks.available
    ? fableWriteTicks.hypotheses.map((h) =>
        ratioFromHypothesis(
          h,
          fableReadRun?.readTokens ?? 0,
          h.id === 'H6' ? (fableReadRun?.observedTicks ?? 0) : 0,
        ),
      )
    : [];
  const identifiableRatios = perHypothesis.filter((r) => r.identifiable);
  const fableReadWriteRatio = {
    definition: 'read quota cost per token divided by 1h write quota cost per token, same model and meter',
    low: identifiableRatios.length ? Math.min(...identifiableRatios.map((r) => r.low)) : null,
    high: identifiableRatios.length ? Math.max(...identifiableRatios.map((r) => r.high)) : null,
    pointEstimate: null,
    rangeKind: 'quantization_bounds',
    statisticalConfidenceInterval: false,
    identifiableUnderHypotheses: identifiableRatios.map((r) => r.hypothesisId),
    perHypothesis,
  };

  const otBlock = blocks['opus.Ot'] ?? null;
  const outputCoefficient = {
    status: 'unidentified',
    identifiable: false,
    value: null,
    otBlockRequests: otBlock?.requests ?? 0,
    otBlockOutputTokens: otBlock?.totals.billedModelOutput ?? 0,
    reason:
      'the output block stopped at one request before any output-dominated trial ran, so no window isolates output from read and write',
    followUp: 'docs/idle-experiments.md output quota plan (not executed)',
  };

  const phases = {};
  for (const p of PHASES) {
    phases[p] = {
      phase: p,
      status: 'unassigned',
      requests: 0,
      totals: null,
      reason:
        'the capture is a synthetic quota calibration run: it contains no idle refresh, handoff, restore or useful-work boundary event, so no request can be assigned to this phase',
    };
  }

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    status:
      malformedLines.length ||
      invalidRows.length ||
      conflicts.length ||
      trialsIntegrity.malformedLines.length ||
      trialsIntegrity.invalidRows.length ||
      usageWarningRequests.length ||
      Object.keys(totals.unknownFieldRequests).length
        ? 'ok_with_integrity_warnings'
        : 'ok',
    source: {
      raw: { path: rawPath, sha256: evidenceRef.sha256, jsonLines: lineCount },
      trials: trialsIntegrity,
      producedBy: 'quota-test proxy.mjs passthrough capture (response usage + unified rate limit headers only)',
      capturedFields: 'response usage counters and rate limit headers only; the source records carry no request payload, no response payload and no credential header',
    },
    inputIntegrity: {
      totalRows: rows.length,
      billableRows: messageRows.length,
      nonBillableRows,
      transportErrorRows,
      malformedLines,
      invalidRows,
      usageWarningRequests: usageWarningRequests.length,
      usageWarningDetail: usageWarningRequests,
      unknownBillableFields: totals.unknownFieldRequests,
      duplicatesDropped: dropped.length,
      duplicateDetail: dropped,
      usageConflicts: conflicts,
      requestsAfterDedup: requests.length,
      dedupKey: 'msg_id, falling back to request-id',
      doubleCountGuards: [
        'cache_creation_input_tokens is a total of the two TTL lanes and is never added to them',
        'streaming snapshots and final totals sharing a message id collapse to one request with the maximum cumulative output',
        'compaction iterations are folded into the parent total and never added on top',
        'tool result and summary tokens are tracked apart from billed model output',
      ],
    },
    totals,
    identity,
    meters,
    blocks,
    phases,
    coefficientRecords,
    outputCoefficient,
    fableWriteTicks,
    fableReadWriteRatio,
    restoreCost: {
      status: 'not_measured',
      measured: null,
      reportedEstimates: { Rw: '6K tokens', Rr: '125K tokens', sourceKind: 'reported_unverified' },
      treatment:
        'earlier restore estimates are carried as reported values only; this capture contains no restore phase, so no measured write/read/output decomposition exists',
    },
    systemSkillOverlap: {
      status: 'unresolved',
      reason:
        'system prompt, skill payload, handoff and restore contributions cannot be separated without per-phase request attribution, which this capture does not carry',
    },
    refusalBilling: {
      status: 'uncertain',
      refusalRequests: requests.filter((r) => r.stopReason === 'refusal').length,
      refusalCacheWrite1h: requests.filter((r) => r.stopReason === 'refusal').reduce((a, r) => a + (r.usage.cacheWrite1h ?? 0), 0),
      refusalCacheRead: requests.filter((r) => r.stopReason === 'refusal').reduce((a, r) => a + (r.usage.cacheRead ?? 0), 0),
      refusalBilledModelOutput: requests.filter((r) => r.stopReason === 'refusal').reduce((a, r) => a + (r.usage.billedModelOutput ?? 0), 0),
      reason:
        'refused responses report usage but the gauge cannot be read at request granularity, so neither "charged" nor "free" is established; any coefficient window containing an uncertain-billing request is rejected as unassigned rather than measured, because the gauge delta is shared and deleting those rows would retain movement the remaining rows did not necessarily cause',
    },
    reportAudit: buildReportAudit({ meters, requests, listPrices, fableWriteTicks, fableReadWriteRatio, messageRows }),
    adversarialProbes: adversarialProbeRecord(),
    limits: [
      'utilization is reported at 0.01 granularity, so no per-request quota cost is observable',
      'a tick landed on a request with no write; a lagging gauge and unrelated concurrent account usage both remain admissible explanations',
      'the capture observes only its own proxied requests, so it cannot rule out other traffic on the same account meter',
      'no quota coefficient is published as a point value; only quantization bounds are',
      'nothing here establishes quota savings for any policy',
    ],
  };

  return evidence;
}

function buildReportAudit({ meters, requests, listPrices, fableWriteTicks, fableReadWriteRatio, messageRows }) {
  const oi = meters['unified-7d_oi'] ?? null;
  const fiveMinRequests = requests.filter((r) => (r.usage.cacheWrite5m ?? 0) > 0);
  const fable = listPrices['claude-fable-5-1'] ?? null;
  const opus = listPrices['claude-opus-5'] ?? null;

  const items = [
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'the observed unified headers contain no model specific extra bucket',
      observed: oi
        ? { meterId: oi.meterId, requests: oi.requests, models: oi.models, utilization: [oi.firstUtilization, oi.lastUtilization] }
        : null,
      verdict: oi ? 'contradicted' : 'confirmed',
      impact: 'a third quota window exists on one model and must be preserved as its own meter',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'ephemeral_5m is always 0 in this capture',
      observed: {
        requestsWith5mWrite: fiveMinRequests.length,
        detail: fiveMinRequests.map((r) => ({ requestId: r.requestId, label: r.label, cacheWrite5m: r.usage.cacheWrite5m })),
      },
      verdict: fiveMinRequests.length === 0 ? 'confirmed' : 'contradicted',
      impact: 'the 5m and 1h write lanes must stay separate fields even though the 1h lane dominates',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'CLI cost basis for claude-fable-5-1 is read 0.30 and output 25.00 usd per Mtok',
      observed: fable?.usdPerMtok ?? null,
      verdict:
        fable?.usdPerMtok && (Math.abs(fable.usdPerMtok.cacheRead - 0.3) > 1e-6 || Math.abs(fable.usdPerMtok.output - 25) > 1e-6)
          ? 'contradicted'
          : 'confirmed',
      impact: 'the reported price ratios used to sanity check the quota ratios were wrong for this model',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'CLI cost basis for claude-opus-5 is input 5.00, write 10.00, read 0.50, output 25.00 usd per Mtok',
      observed: opus?.usdPerMtok ?? null,
      verdict:
        opus?.usdPerMtok &&
        Math.abs(opus.usdPerMtok.input - 5) < 1e-3 &&
        Math.abs(opus.usdPerMtok.cacheWrite - 10) < 1e-3 &&
        Math.abs(opus.usdPerMtok.cacheRead - 0.5) < 1e-3 &&
        Math.abs(opus.usdPerMtok.output - 25) < 1e-2
          ? 'confirmed'
          : 'contradicted',
      impact: 'the opus side of the reported price table re-derives exactly from the captured cost figures',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'fable read/write quota ratio is about 0.022 within 0.019 to 0.026',
      observed: { low: fableReadWriteRatio.low, high: fableReadWriteRatio.high, rangeKind: fableReadWriteRatio.rangeKind },
      verdict: 'range_too_narrow',
      impact:
        'the quantization bounds are far wider than the reported interval, and the reported interval has no stated statistical meaning',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'the fable write block consumed 6 ticks',
      observed: {
        hypotheses: fableWriteTicks.hypotheses?.map((h) => ({ id: h.id, observedTicks: h.observedTicks })) ?? [],
        lagObserved: fableWriteTicks.lagObserved,
        lagExclusivelyEstablished: fableWriteTicks.lagExclusivelyEstablished,
      },
      verdict: 'unresolved',
      impact: 'both the 6 tick and 8 tick attributions survive the evidence; neither is selected here',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'refused requests appear not to be charged',
      observed: { refusalRequests: requests.filter((r) => r.stopReason === 'refusal').length },
      verdict: 'unverifiable',
      impact: 'per-request billing is below the gauge granularity, so no charge conclusion follows from the capture',
    },
    {
      claimSource: 'quota-test/2026-09-19/REPORT.md',
      claim: 'the output coefficient block ran zero trials',
      observed: { opusOtRequests: messageRows.filter((r) => String(r.label).startsWith('opus.Ot')).length },
      verdict: 'confirmed_in_substance',
      impact: 'one probe request exists but no output-dominated trial, so the output coefficient stays unidentified',
    },
  ];
  return { checked: items.length, items };
}

// Probe classes are carried as values, not as object keys, so that the sanitizer
// below can keep its fail-closed key rules (a key starting with "prompt" is refused).
function adversarialProbeRecord() {
  return [
    {
      class: 'malformed_input',
      applicable: true,
      covered: 'unparseable lines, absent usage, negative and non numeric token counts, inconsistent TTL split, empty input',
      result: 'lines are reported by line number, bad fields become unknown rather than zero, exit code 2 or 5 as appropriate',
    },
    {
      class: 'stale_state',
      applicable: true,
      covered: 'a rate limit window that resets mid capture',
      result: 'meter windows split on the reset epoch and consumption is never computed across a reset',
    },
    {
      class: 'dirty_worktree',
      applicable: true,
      covered: 'the implementation worktree carries the preserved user baseline and files owned by concurrent tasks',
      result: 'this task writes only its four owned paths plus its evidence directory; no other file is staged or modified',
    },
    {
      class: 'misleading_success_output',
      applicable: true,
      covered: 'partially malformed input, zero usable requests, unknown coefficients',
      result: 'exit 5 with an explicit integrity status for partial input, exit 2 for no usable request, and null rather than 0 for every unknown quantity',
    },
    {
      class: 'flaky_tests',
      applicable: true,
      covered: 'no sleeps, no wall clock reads inside aggregation, deterministic ordering',
      result: 'generatedAt is injected by the caller and the same input yields a byte identical bundle',
    },
    {
      class: 'injected_content_in_source_data',
      applicable: true,
      covered: 'the capture holds no request or response body, and the aggregator copies no free text out of it',
      result: 'labels, identifiers and counters only; a sanitizer walk refuses to emit if any credential or body key appears',
    },
    { class: 'cancel_resume', applicable: false, reason: 'the aggregator is a single synchronous pass with no resumable or long running state' },
    { class: 'hung_commands', applicable: false, reason: 'no network, no timer, no subprocess and no unbounded loop exists in this path' },
    { class: 'repeated_interruptions', applicable: false, reason: 'the command is idempotent and writes nothing unless --out is given' },
  ];
}

// --------------------------------------------------------------- rendering

export function renderMarkdown(ev) {
  const L = [];
  const f = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
  const tok = (r) =>
    r.lowTokensPerTick === null
      ? 'not identifiable'
      : `${f(Math.round(r.lowTokensPerTick))} to ${r.highTokensPerTick === null ? 'unbounded' : f(Math.round(r.highTokensPerTick))}`;

  L.push('# Idle cost evidence: re-aggregated quota measurements');
  L.push('');
  L.push(`Source: \`${ev.source.raw.path}\` (sha256 \`${ev.source.raw.sha256}\`, ${ev.source.raw.jsonLines} JSON lines).`);
  if (ev.source.trials.available) L.push(`Reported CLI trials: \`${ev.source.trials.path}\` (sha256 \`${ev.source.trials.sha256}\`, ${ev.source.trials.rows} rows).`);
  L.push('');
  L.push('Reproduce:');
  L.push('');
  L.push('```');
  L.push(`node scripts/quota-analysis.mjs ${ev.source.raw.path} --out docs/idle-cost-evidence.json --markdown docs/idle-cost-evidence.md`);
  L.push('node --test test/quota-analysis.test.mjs');
  L.push('```');
  L.push('');
  L.push('Machine readable form, including every request identifier cited below: `docs/idle-cost-evidence.json`.');
  L.push('');
  L.push('**These figures do not establish any quota saving for any policy.** They bound how much');
  L.push('a quota gauge moved during a calibration capture, nothing more.');
  L.push('');

  L.push('## 1. Raw usage totals');
  L.push('');
  L.push(`${f(ev.inputIntegrity.totalRows)} captured rows: ${f(ev.inputIntegrity.billableRows)} \`/v1/messages\` responses with usage and ${f(ev.inputIntegrity.nonBillableRows)} non-billable transport rows.`);
  L.push(`Duplicates dropped: ${ev.inputIntegrity.duplicatesDropped}. Usage conflicts: ${ev.inputIntegrity.usageConflicts.length}. Malformed lines: ${ev.inputIntegrity.malformedLines.length}. Structurally invalid rows: ${ev.inputIntegrity.invalidRows.length}. Requests with usage warnings: ${ev.inputIntegrity.usageWarningRequests}.`);
  L.push('');
  L.push('| field | tokens |');
  L.push('| --- | --- |');
  for (const k of BILLABLE_FIELDS) L.push(`| \`${k}\` | ${f(ev.totals[k])} |`);
  L.push(`| requests | ${f(ev.totals.requests)} |`);
  L.push('');
  L.push('Double counting guards applied:');
  L.push('');
  for (const g of ev.inputIntegrity.doubleCountGuards) L.push(`- ${g}`);
  L.push('');

  L.push('## 2. Quota meters');
  L.push('');
  L.push('Each meter is its own limit window. They are never summed into one scalar.');
  L.push('');
  L.push('| meter | requests | models | utilization | observed ticks | reset |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const m of Object.values(ev.meters)) {
    const ticks = m.crossesReset ? 'not published (meter reset inside the capture)' : m.observedTicks;
    L.push(`| \`${m.meterId}\` | ${m.requests} | ${m.models.join(', ')} | ${m.firstUtilization} -> ${m.lastUtilization} | ${ticks} | ${m.resetIso.join(', ')} |`);
  }
  L.push('');

  L.push('## 3. Coefficient records');
  L.push('');
  L.push('Utilization is published at 0.01 granularity, so a window that moved `t` ticks bounds');
  L.push('true consumption strictly between `t-1` and `t+1` ticks. Those are arithmetic bounds from');
  L.push('the display granularity. **They are not confidence intervals, and no point estimate is');
  L.push('published, because a midpoint would be an invented coefficient.**');
  L.push('');
  L.push('| block | model | meter | component | tokens | ticks | tokens per tick | status |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of ev.coefficientRecords.filter((x) => x.quotaMeterOrCostUnit.startsWith('unified-'))) {
    const o = r.observedRangeOrUncertainty;
    const cell = r.status === 'unassigned' ? 'not attributable' : tok(o.tokensPerTick);
    L.push(`| ${r.evidenceRef.block} | ${r.modelId} | \`${r.quotaMeterOrCostUnit}\` | ${o.dominantComponent} | ${f(o.tokens)} | ${o.observedTicks} | ${cell} | ${r.status} |`);
  }
  L.push('');
  const rejected = ev.coefficientRecords.filter(
    (r) => r.quotaMeterOrCostUnit.startsWith('unified-') && r.status === 'unassigned',
  );
  if (rejected.length) {
    L.push('Why each rejected window is not a measurement:');
    L.push('');
    for (const r of rejected) {
      L.push(`- \`${r.evidenceRef.block}\` / \`${r.quotaMeterOrCostUnit}\`: ${r.observedRangeOrUncertainty.unattributableReason}`);
    }
    L.push('');
  }
  L.push('### Reported cost units (not quota)');
  L.push('');
  L.push('These are the per-token unit prices re-derived exactly from the CLI\'s own `costUSD`');
  L.push('figures by solving the four-unknown system over all trials. They are a *reported*');
  L.push('accounting basis, `sourceKind: reported_unverified`. They are not a measurement of the');
  L.push('subscription quota meter and must not be substituted for one.');
  L.push('');
  L.push('| model | input | cache write | cache read | output | max residual (USD) |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of ev.coefficientRecords.filter((x) => x.quotaMeterOrCostUnit.startsWith('usd'))) {
    const u = r.observedRangeOrUncertainty.usdPerMtok;
    if (!u) {
      L.push(`| ${r.modelId} | unidentified | unidentified | unidentified | unidentified | n/a |`);
      continue;
    }
    L.push(`| ${r.modelId} | ${u.input.toFixed(2)} | ${u.cacheWrite.toFixed(2)} | ${u.cacheRead.toFixed(2)} | ${u.output.toFixed(2)} | ${r.observedRangeOrUncertainty.maxResidualUsd.toExponential(1)} |`);
  }
  L.push('');
  L.push('The cost data does not split the write lane by TTL, so neither `kWrite5` nor `kWrite60`');
  L.push('is filled from it.');
  L.push('');

  L.push('## 4. Fable write tick attribution: unresolved');
  L.push('');
  const ft = ev.fableWriteTicks;
  if (ft.delayedTick) {
    const d = ft.delayedTick;
    L.push(`A tick landed on \`${d.label}\` (${d.requestId}, ${d.ts}) which wrote **${d.cacheWrite1h} 1h tokens and ${d.cacheWrite5m} 5m tokens** yet moved the gauge ${d.utilizationBefore} -> ${d.utilizationAfter} (+${d.deltaUtilization}), ${d.gapSeconds}s after ${d.precedingRequestId}.`);
    L.push('');
    L.push('This is **consistent with** a lagging gauge, but the capture does not establish that.');
    L.push('The proxy sees only its own requests, so unrelated concurrent usage on the same account');
    L.push('meter cannot be ruled out. Admissible explanations, none excluded by this data:');
    L.push('');
    for (const a of ft.alternativeExplanations ?? []) L.push(`- ${a}`);
    L.push('');
    L.push('Either way the block boundary is ambiguous, so both attributions survive.');
  }
  L.push('');
  L.push('| hypothesis | attribution | ticks | write tokens | tokens per tick | read ticks left for the following run |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const h of ft.hypotheses ?? []) {
    L.push(`| **${h.id}** | ${h.attribution} | ${h.observedTicks} | ${f(h.writeTokens)} | ${tok(h.perTickTokens)} | ${h.readTicksLeftForNextRun} |`);
  }
  L.push('');
  for (const h of ft.hypotheses ?? []) {
    L.push(`**${h.id}** window: ${h.window.fromRequestId} (${h.window.fromTs}, u=${h.window.fromUtilization}) -> ${h.window.toRequestId} (${h.window.toTs}, u=${h.window.toUtilization}), reset epoch ${h.window.resetEpoch}.`);
    L.push('');
    L.push('- for: ');
    for (const e of h.evidenceFor) L.push(`  - ${e}`);
    L.push('- against: ');
    for (const e of h.evidenceAgainst) L.push(`  - ${e}`);
    L.push('');
  }
  L.push(`Not resolved here: ${ft.resolutionBlockedBy}. Discriminating experiment: ${ft.discriminatingExperiment}.`);
  L.push('');
  L.push('### Neighbouring requests around the delayed tick');
  L.push('');
  L.push('| index | request id | ts | label | 1h write | read | output | 5h utilization |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const n of ft.hypotheses?.[0]?.neighborRequests ?? []) {
    L.push(`| ${n.index} | ${n.requestId} | ${n.ts} | ${n.label} | ${f(n.cacheWrite1h)} | ${f(n.cacheRead)} | ${f(n.billedModelOutput)} | ${n.utilization} |`);
  }
  L.push('');

  L.push('## 5. Fable read/write ratio');
  L.push('');
  const rr = ev.fableReadWriteRatio;
  L.push(`${rr.definition}.`);
  L.push('');
  if (rr.low !== null) {
    L.push(`Observed range: **${rr.low.toFixed(4)} to ${rr.high.toFixed(4)}**, identifiable only under ${rr.identifiableUnderHypotheses.join(', ')}.`);
  } else {
    L.push('Not identifiable under any surviving attribution.');
  }
  L.push('');
  L.push('This is a quantization bound, not a confidence interval, and it carries no point estimate.');
  for (const p of rr.perHypothesis) {
    L.push(`- ${p.hypothesisId}: ${p.identifiable ? `${p.low.toFixed(4)} to ${p.high.toFixed(4)}` : `not identifiable (${p.reason})`}`);
  }
  L.push('');

  L.push('## 6. Output coefficient');
  L.push('');
  L.push(`Status: **${ev.outputCoefficient.status}** (value \`null\`, not zero). The output block holds ${ev.outputCoefficient.otBlockRequests} request(s) totalling ${ev.outputCoefficient.otBlockOutputTokens} output tokens.`);
  L.push('');
  L.push(`${ev.outputCoefficient.reason}.`);
  L.push('');

  L.push('## 7. Phases, restore and system/skill overlap');
  L.push('');
  L.push('| phase | status | requests |');
  L.push('| --- | --- | --- |');
  for (const p of Object.values(ev.phases)) L.push(`| \`${p.phase}\` | ${p.status} | ${p.requests} |`);
  L.push('');
  L.push(`${Object.values(ev.phases)[0].reason}.`);
  L.push('');
  L.push(`Restore cost: **${ev.restoreCost.status}**. ${ev.restoreCost.treatment}. Earlier estimates (Rw ${ev.restoreCost.reportedEstimates.Rw}, Rr ${ev.restoreCost.reportedEstimates.Rr}) are carried as \`${ev.restoreCost.reportedEstimates.sourceKind}\` and are not measurements.`);
  L.push('');
  L.push(`System/skill overlap: **${ev.systemSkillOverlap.status}**. ${ev.systemSkillOverlap.reason}.`);
  L.push('');
  L.push(`Refusal billing: **${ev.refusalBilling.status}**. ${ev.refusalBilling.refusalRequests} refused requests reported ${f(ev.refusalBilling.refusalCacheWrite1h)} 1h write and ${f(ev.refusalBilling.refusalCacheRead)} read tokens. ${ev.refusalBilling.reason}.`);
  L.push('');
  const unassignedBlocks = Object.values(ev.blocks).filter((b) => b.utilizationAttribution === 'unassigned');
  if (unassignedBlocks.length) {
    L.push('Blocks whose gauge movement cannot be attributed:');
    L.push('');
    for (const b of unassignedBlocks) L.push(`- \`${b.block}\` (${b.requests} requests, ${b.runs.length} run(s)): ${b.attributionReason}`);
    L.push('');
  }

  L.push('## 8. Audit of the earlier report');
  L.push('');
  L.push('Every claim below was re-checked against the raw capture rather than carried over.');
  L.push('');
  L.push('| verdict | claim | observed |');
  L.push('| --- | --- | --- |');
  for (const i of ev.reportAudit.items) {
    L.push(`| **${i.verdict}** | ${i.claim} | ${JSON.stringify(i.observed).replace(/\|/g, '\\|').slice(0, 220)} |`);
  }
  L.push('');
  for (const i of ev.reportAudit.items.filter((x) => x.verdict !== 'confirmed')) {
    L.push(`- ${i.verdict}: ${i.claim} -> ${i.impact}.`);
  }
  L.push('');

  L.push('## 9. Limits');
  L.push('');
  for (const l of ev.limits) L.push(`- ${l}`);
  L.push('');
  L.push('## 10. Adversarial probe coverage');
  L.push('');
  L.push('| class | applicable | result |');
  L.push('| --- | --- | --- |');
  for (const p of ev.adversarialProbes) {
    L.push(`| \`${p.class}\` | ${p.applicable} | ${p.applicable ? p.result : p.reason} |`);
  }
  L.push('');
  return `${L.join('\n')}\n`;
}

function renderSummary(ev) {
  const out = [];
  out.push(`status: ${ev.status}`);
  out.push(`requests: ${ev.totals.requests} (non billable rows ${ev.inputIntegrity.nonBillableRows}, duplicates dropped ${ev.inputIntegrity.duplicatesDropped})`);
  out.push(`totals: input=${ev.totals.uncachedInput} write5m=${ev.totals.cacheWrite5m} write1h=${ev.totals.cacheWrite1h} writeUnknownTtl=${ev.totals.cacheWriteUnknownTtl} read=${ev.totals.cacheRead} output=${ev.totals.billedModelOutput}`);
  out.push(`meters: ${Object.keys(ev.meters).join(', ')}`);
  out.push(`coefficient records: ${ev.coefficientRecords.length}`);
  out.push(`output coefficient: ${ev.outputCoefficient.status}`);
  out.push(`fable write ticks: resolved=${ev.fableWriteTicks.resolved} hypotheses=${(ev.fableWriteTicks.hypotheses ?? []).map((h) => `${h.id}:${h.observedTicks}`).join(' ')}`);
  const unknownFields = Object.entries(ev.totals.unknownFieldRequests);
  out.push(
    unknownFields.length
      ? `unknown billable fields: ${unknownFields.map(([f, n]) => `${f} in ${n} request(s)`).join(', ')}`
      : 'unknown billable fields: none',
  );
  if (ev.inputIntegrity.invalidRows.length) {
    out.push(`structurally invalid rows: ${ev.inputIntegrity.invalidRows.map((r) => `line ${r.line} (${r.type})`).join(', ')}`);
  }
  out.push(`phases assigned: 0 of ${PHASES.length}`);
  out.push(`report audit: ${ev.reportAudit.items.filter((i) => i.verdict === 'contradicted').length} contradicted of ${ev.reportAudit.checked}`);
  return out.join('\n');
}

// -------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const res = { input: null, json: false, out: null, markdown: null, trials: null, error: null };
  const valueFlags = { '--out': 'out', '--markdown': 'markdown', '--trials': 'trials' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      res.json = true;
      continue;
    }
    if (Object.hasOwn(valueFlags, a)) {
      const value = argv[i + 1];
      // A missing value, or the next flag, is not a filename. Writing nowhere while
      // reporting success is worse than refusing the invocation.
      if (value === undefined || value.startsWith('-')) {
        res.error = 'missing_flag_value';
        res.flag = a;
        return res;
      }
      res[valueFlags[a]] = value;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      res.error = 'unknown_flag';
      res.flag = a;
      return res;
    }
    if (res.input === null) {
      res.input = a;
      continue;
    }
    res.error = 'unexpected_argument';
    return res;
  }
  if (res.input === null) res.error = 'missing_input';
  return res;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const args = parseArgs(argv);
  if (args.error) {
    io.stderr.write(`quota-analysis: ${args.error}${args.flag ? ` ${args.flag}` : ''}\n`);
    io.stderr.write('usage: node scripts/quota-analysis.mjs <raw.jsonl> [--json] [--out <file>] [--markdown <file>] [--trials <file>]\n');
    return EXIT_USAGE;
  }

  let rawText;
  try {
    rawText = fs.readFileSync(args.input, 'utf8');
  } catch (err) {
    io.stderr.write(`quota-analysis: cannot read input: ${err.code ?? 'error'}\n`);
    return EXIT_INPUT;
  }

  const trialsPath = (args.trials ?? path.join(path.dirname(path.resolve(args.input)), 'trials.jsonl')).replace(/\\/g, '/');
  let trialsText = null;
  try {
    trialsText = fs.readFileSync(trialsPath, 'utf8');
  } catch {
    trialsText = null;
  }

  const evidence = buildEvidence({
    rawPath: args.input,
    rawText,
    trialsPath: trialsText === null ? null : trialsPath,
    trialsText,
    generatedAt: new Date().toISOString(),
  });

  if (evidence.totals.requests === 0) {
    io.stderr.write(`quota-analysis: no usable /v1/messages record with usage (malformed lines: ${evidence.inputIntegrity.malformedLines.length})\n`);
    return EXIT_INPUT;
  }

  const leaked = findSensitive(evidence);
  if (leaked.length) {
    io.stderr.write(`quota-analysis: refusing to emit, sensitive field detected at ${leaked[0].path}\n`);
    return EXIT_INPUT;
  }

  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, json);
  if (args.markdown) fs.writeFileSync(args.markdown, renderMarkdown(evidence));

  if (args.json) io.stdout.write(json);
  else io.stdout.write(`${renderSummary(evidence)}\n`);

  if (evidence.status !== 'ok') {
    const integrity = evidence.inputIntegrity;
    io.stderr.write(
      `quota-analysis: input integrity warnings: malformed lines ${JSON.stringify(integrity.malformedLines)}, invalid rows ${JSON.stringify(integrity.invalidRows.map((r) => r.line))}, usage conflicts ${integrity.usageConflicts.length}, requests with usage warnings ${integrity.usageWarningRequests}\n`,
    );
    return EXIT_INTEGRITY;
  }
  return EXIT_OK;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
