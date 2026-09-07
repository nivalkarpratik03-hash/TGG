"use strict";
/**
 * groupBy.js — Chunk 3 of the Analytics module (Analytics-project-plan.md
 * Section 5). ONE generic grouping function, reused for every "analysis by
 * X" section in the dashboard (time-of-day, day-of-week, symbol, condition
 * value, whatever) — the caller supplies the bucketing rule via `keyFn`,
 * this file doesn't know or hardcode what any strategy's fields are named.
 */

const { summarize } = require("./aggregator.js");

// `keyFn(trade) -> string` decides which bucket a trade falls into. Returns
// a plain object: { [bucketKey]: <summarize() output for that bucket's
// trades> }. Buckets a caller never populated simply don't appear in the
// output — this file never invents empty buckets.
function groupBy(trades, keyFn) {
  const list = Array.isArray(trades) ? trades : [];
  const buckets = new Map();
  for (const t of list) {
    const key = String(keyFn(t));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const result = {};
  for (const [key, subset] of buckets) {
    result[key] = summarize(subset);
  }
  return result;
}

// Generic numeric range bucketing — same idea as backtest/src/report.js's
// bucketOf() (which buckets by distance-from-ATM in option strikes), just
// generalized to any numeric field and any set of edges, so this ONE
// function covers holding-time buckets, volume buckets, etc. instead of
// writing a bucketOf-shaped function per field.
// `edges` = ascending array of upper bounds, e.g. [15, 30, 60] with
// `labels` = ["0-15m", "15-30m", "30-60m", "60m+"] (one more label than
// edges — the last label catches everything above the last edge).
function bucketNumeric(value, edges, labels) {
  if (value == null || Number.isNaN(value)) return labels[labels.length - 1] ?? "unknown";
  for (let i = 0; i < edges.length; i++) {
    if (value <= edges[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

module.exports = { groupBy, bucketNumeric };
