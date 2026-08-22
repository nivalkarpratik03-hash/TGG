/**
 * timeframeAggregator.js
 * ─────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for deriving "higher than 1 Day" timeframes
 * (Weekly, Monthly, …) from an array of DAILY (resolution=1440)
 * candles.
 *
 * Added as part of the 1D-storage change (2026-08-21): previously the
 * ONLY way to get Weekly candles was fyers/client.js's local
 * aggregateDailyToWeekly(), called every time straight after a fresh
 * Fyers daily fetch — Weekly was never derived from anything already
 * sitting in memory/DB. Now that complete 1D history is fetched once
 * and persisted to the `candles` table (see dataFetch.js / candleStore.js),
 * Weekly/Monthly/etc. are derived from THAT stored 1D data instead of
 * re-deriving from 1-minute candles or re-fetching from Fyers every time.
 *
 * This module is intentionally the ONLY place that knows how to bucket
 * daily bars into a higher timeframe — both fyers/client.js (fresh
 * Fyers-sourced daily → weekly, used the first time a symbol is ever
 * backfilled) and dataFetch.js (DB-sourced daily → weekly/monthly, the
 * normal path afterwards) call the exact same function here, so the two
 * paths can never silently drift apart the way two hand-copied
 * implementations eventually would.
 *
 * Resolution IDs follow this project's existing convention (see
 * candleBuilder.js's TF_MINUTES / frontend's formatResolution.js) —
 * numeric identifiers that are NOT literally "minutes in the bucket"
 * (a calendar week/month doesn't have a fixed number of trading
 * minutes), just a stable, unique key:
 *   1440  = 1 Day       (stored as-is, passthrough — not aggregated here)
 *   10080 = 1 Week  (7 × 24 × 60, Monday–Sunday IST calendar week)
 *   43200 = 1 Month (30 × 24 × 60, calendar month IST)
 *
 * Extending to a new higher timeframe (e.g. Quarterly) later only means
 * adding one more case to aggregateDailyCandles() below — every caller
 * (Fyers-fresh path, DB-stored path) picks it up automatically.
 */
"use strict";

const DAILY_RESOLUTION = 1440;
const WEEKLY_RESOLUTION = 10080;
const MONTHLY_RESOLUTION = 43200;

// Any resolution at or above this is "higher than 1 Day" — derived from
// stored daily candles rather than from 1-minute candles. Exported so
// dataFetch.js (and anything else that needs the same cutoff) doesn't
// hand-roll its own `resolution >= 1440` check in more than one place.
const HIGHER_THAN_DAILY_RESOLUTIONS = [DAILY_RESOLUTION, WEEKLY_RESOLUTION, MONTHLY_RESOLUTION];
function isDailyOrHigher(resolution) {
  return Number(resolution) >= DAILY_RESOLUTION;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MARKET_OPEN_IST_MIN = 9 * 60 + 15; // 09:15 IST, matches candleBuilder.js / fyers/client.js

/**
 * Monday 09:15 IST anchor (ms epoch) for the ISO week containing `tsMs`.
 * Mirrors fyers/client.js's weekAnchor() (same math, ms instead of seconds)
 * and candleBuilder.js's _buildWeeklyBars() bucketing — kept here now as
 * the one canonical version for daily→weekly aggregation specifically.
 */
function weekAnchorMs(tsMs) {
  const istMs = tsMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMon = (dow + 6) % 7;
  const monUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMon);
  return monUtcMidnight + MARKET_OPEN_IST_MIN * 60 * 1000 - IST_OFFSET_MS;
}

/**
 * 1st-of-calendar-month 09:15 IST anchor (ms epoch) for the month
 * containing `tsMs`. Uses the actual IST calendar date, not a fixed
 * 30-day bucket — months have 28-31 days, and anchoring to the real
 * 1st keeps bar boundaries meaningful (matches what a broker's own
 * Monthly chart would show) instead of drifting.
 */
function monthAnchorMs(tsMs) {
  const istMs = tsMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  const monthUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return monthUtcMidnight + MARKET_OPEN_IST_MIN * 60 * 1000 - IST_OFFSET_MS;
}

function aggregateOHLC(bucketMap) {
  const bars = [];
  const sortedKeys = [...bucketMap.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const candles = bucketMap.get(key);
    if (!candles || candles.length === 0) continue;
    // candles within a bucket arrive in whatever order the caller passed
    // the full daily array in — sort defensively so open/close pick the
    // true first/last day even if the input wasn't perfectly ordered.
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    bars.push({
      time: key,
      open: sorted[0].open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return bars;
}

/**
 * Derive `resolution` candles from an array of DAILY (1440) candles.
 *
 * @param {Array<{time,open,high,low,close,volume}>} dailyCandles  oldest-first, ms epoch times
 * @param {number} resolution  1440 (passthrough) | 10080 (weekly) | 43200 (monthly)
 * @returns {Array<{time,open,high,low,close,volume}>}
 */
function aggregateDailyCandles(dailyCandles, resolution) {
  if (!dailyCandles || dailyCandles.length === 0) return [];
  const res = Number(resolution);

  if (res === DAILY_RESOLUTION) return dailyCandles;

  if (res === WEEKLY_RESOLUTION) {
    const buckets = new Map();
    for (const d of dailyCandles) {
      const key = weekAnchorMs(d.time);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }
    return aggregateOHLC(buckets);
  }

  if (res === MONTHLY_RESOLUTION) {
    const buckets = new Map();
    for (const d of dailyCandles) {
      const key = monthAnchorMs(d.time);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }
    return aggregateOHLC(buckets);
  }

  // Unknown "higher than daily" resolution — nothing sensible to derive.
  console.warn(`[timeframeAggregator] Unsupported daily-derived resolution=${resolution} — returning empty array`);
  return [];
}

module.exports = {
  DAILY_RESOLUTION, WEEKLY_RESOLUTION, MONTHLY_RESOLUTION,
  HIGHER_THAN_DAILY_RESOLUTIONS, isDailyOrHigher,
  aggregateDailyCandles,
  weekAnchorMs, monthAnchorMs,
};