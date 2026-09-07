"use strict";
/**
 * cache.js — Chunk 2 of the Analytics module (Analytics-project-plan.md
 * Section 3). Memory-only. No database, no migration, nothing written to
 * disk — this is deliberate, see the plan doc's "Storage decision" line.
 *
 * Same pattern as backend/src/services/scannerRunner.js's `_results` Map:
 * one module-level Map living in the running Node process's RAM, created
 * once, shared by every connected client automatically because there's one
 * always-on backend process (not serverless) — see the plan doc Section 3
 * for the full reasoning. This file is Analytics' OWN separate instance;
 * it does not read or write Scanner's Map, and Scanner never touches this
 * one either (Analytics-project-plan.md Section 8, rule 6).
 *
 * Self-invalidating by design: change a strategy's params -> the cache key
 * changes -> the old entry just never gets requested again. No "is this
 * stale" check needed anywhere else in the codebase.
 */

const MAX_AGE_MS = 6 * 60 * 60 * 1000;      // entries older than this get swept — open question, Section 7 Q2 of the plan, adjust once real usage is known
const MAX_ENTRIES = 200;                     // hard cap so a long-running server can never grow this unbounded
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;    // how often the background sweep runs

const _store = new Map(); // key -> { value, computedAt }

// Deterministic key regardless of object key insertion order — two callers
// building the "same" params/filters object in a different order must
// produce the SAME cache key, or every cache hit becomes an accidental
// miss. Sorts keys before stringifying.
function _stableStringify(obj) {
  if (obj == null) return "";
  const sortedKeys = Object.keys(obj).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

// key = strategyId + its params + the filter set used — same idea as
// scannerRunner.js's buildComboKey(resolution, assetClass, instrumentType),
// just a different set of inputs (Analytics-project-plan.md Section 3).
function buildCacheKey(strategyId, params, filters) {
  return `${strategyId || "unknown"}|${_stableStringify(params)}|${_stableStringify(filters)}`;
}

function get(key) {
  const entry = _store.get(key);
  return entry ? entry.value : null;
}

// `computedAtOverride` is test-only — real callers never pass it, it
// always defaults to the actual current time. Exists purely so
// sanity_cache.js can manufacture "old" entries without sleeping in
// real wall-clock time.
function set(key, value, computedAtOverride) {
  _store.set(key, { value, computedAt: computedAtOverride != null ? computedAtOverride : Date.now() });
  if (_store.size > MAX_ENTRIES) _evictOldestUntilWithinLimit(MAX_ENTRIES);
  return true;
}

function has(key) {
  return _store.has(key);
}

function deleteKey(key) {
  return _store.delete(key);
}

function size() {
  return _store.size;
}

function clearAll() {
  _store.clear();
}

function _evictOldestUntilWithinLimit(limit) {
  if (_store.size <= limit) return 0;
  const entries = Array.from(_store.entries()).sort((a, b) => a[1].computedAt - b[1].computedAt);
  let evicted = 0;
  while (_store.size > limit && entries.length) {
    const [k] = entries.shift();
    _store.delete(k);
    evicted++;
  }
  return evicted;
}

// Pure, testable sweep — removes entries older than maxAgeMs as of `nowMs`,
// then enforces the max-entry cap as a second pass. Exported separately
// from the interval below so tests can call it directly with a manufactured
// `nowMs` instead of waiting on real time.
function pruneOnce(nowMs = Date.now(), maxAgeMs = MAX_AGE_MS) {
  let evicted = 0;
  for (const [key, entry] of _store) {
    if (nowMs - entry.computedAt > maxAgeMs) {
      _store.delete(key);
      evicted++;
    }
  }
  evicted += _evictOldestUntilWithinLimit(MAX_ENTRIES);
  return evicted;
}

// Same low-key pattern as other scheduled jobs already in this backend —
// a plain setInterval sitting next to the Map it manages, not a cron
// table, not a DB job. unref() so it can never by itself keep the Node
// process alive (best-effort housekeeping shouldn't block a clean
// shutdown).
let _sweepHandle = null;
function startSweeping(intervalMs = SWEEP_INTERVAL_MS) {
  stopSweeping();
  _sweepHandle = setInterval(() => pruneOnce(), intervalMs);
  if (_sweepHandle.unref) _sweepHandle.unref();
  return _sweepHandle;
}
function stopSweeping() {
  if (_sweepHandle) {
    clearInterval(_sweepHandle);
    _sweepHandle = null;
  }
}

module.exports = {
  buildCacheKey,
  get,
  set,
  has,
  delete: deleteKey,
  size,
  clearAll,
  pruneOnce,
  startSweeping,
  stopSweeping,
  MAX_AGE_MS,
  MAX_ENTRIES,
  SWEEP_INTERVAL_MS,
};
