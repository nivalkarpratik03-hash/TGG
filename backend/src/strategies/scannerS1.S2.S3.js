/**
 * strategies/scannerS1.S2.S3.js
 * ─────────────────────────────────────────────────────────────────
 * Strategy: Motherwave → TrapZone (0.236) → S1 / S2 / S3
 *
 * MOTHERWAVE:
 *   Received from scannerRunner via context.motherwave.
 *   Shape: { wave, fibLevels, invalidation }
 *   wave.endIndex  → bar index where MW tip lands (S1 search starts here + 1)
 *   wave.toSide    → "high" (bull) | "low" (bear)
 *   wave.fromPrice → wave origin
 *   wave.toPrice   → wave tip
 *
 * TRAP ZONE:
 *   Received from context.trapZone (pre-computed by scannerRunner via calcTrapZone).
 *   Fallback: computed locally from context.motherwave.wave if context.trapZone missing.
 *
 * S1 — Trigger candle (after motherwave end):
 *   Red candle, close < EMA9-lows, body overlaps trap zone.
 *
 * S2 — Confirmation:
 *   Green candle, engulfs S1 body, close > S1.open.
 *
 * S3 — Entry signal:
 *   Red candle after S2, close < S1.close → found = true
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

// ─── EMA helper — single source of truth: backend/src/services/indicatorMath.js
const { calcEMA } = require("../services/indicatorMath");

// ─── Fib price helper (matches FibDashboardPage computeFibLevels) ─────────────
// price(ratio) = toPrice + ratio × (fromPrice − toPrice)
function fibPrice(w, ratio) {
  return w.toPrice + ratio * (w.fromPrice - w.toPrice);
}

// ─── Trap zone from wave object ───────────────────────────────────────────────
function calcTrapZone(w) {
  const tip = fibPrice(w, 0);
  const ret = fibPrice(w, 0.236);
  return {
    high: Math.max(tip, ret),
    low: Math.min(tip, ret),
    center: (tip + ret) / 2,
    range: Math.abs(w.toPrice - w.fromPrice),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isRed(c) { return c.close < c.open; }
function isGreen(c) { return c.close >= c.open; }
function isCandleOverlapsTrap(c, trap) {
  const bodyHigh = Math.max(c.open, c.close);
  const bodyLow = Math.min(c.open, c.close);
  return bodyHigh >= trap.low && bodyLow <= trap.high;
}

// ─── S1 / S2 / S3 ────────────────────────────────────────────────────────────
function findS1S2S3(candles, emaLows, trapZone, motherwaveEndIndex) {
  const startIdx = motherwaveEndIndex + 1;
  if (startIdx >= candles.length) return { s1: null, s2: null, s3: null };

  let s1 = null, s2 = null, s3 = null;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const emaLow = emaLows[i];

    if (!s1) {
      if (isRed(c) && c.close < emaLow && isCandleOverlapsTrap(c, trapZone)) {
        s1 = { ...c, index: i, emaLow };
      }
      continue;
    }

    if (!s2) {
      if (isGreen(c) && c.open <= s1.close && c.close > s1.open) {
        s2 = { ...c, index: i };
      } else if (isRed(c) && c.close < s1.close) {
        s1 = null; s2 = null; // invalidate, restart
      }
      continue;
    }

    if (!s3) {
      if (isRed(c) && c.close < s1.close) {
        s3 = { ...c, index: i };
        break;
      }
      if (isGreen(c) && c.close > s2.high) {
        s1 = null; s2 = null; s3 = null; // setup broken
      }
    }
  }

  return { s1, s2, s3 };
}

// ─── Strategy interface ───────────────────────────────────────────────────────
// context is provided by scannerRunner:
//   context.motherwave  = { wave, fibLevels, invalidation }
//   context.trapZone    = pre-computed trap zone (or derived here as fallback)
//   context.zone        = "trap" | "near382" | "hot618" | "other"
//   context.lastCandle  = last candle
//
// context.motherwave.wave.endIndex is the bar index where the MW tip landed.
// S1 search starts from endIndex + 1.
//
function scan(symbol, candles, context = {}) {
  const result = {
    symbol,
    found: false,
    patternStage: "none",
    motherwave: null,   // will be the full { wave, fibLevels, invalidation } object
    trapZone: null,
    s1: null, s2: null, s3: null,
    lastCandle: context.lastCandle || (candles.length > 0 ? candles[candles.length - 1] : null),
    candleCount: candles.length,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!candles || candles.length < 20) { result.error = "insufficient_data"; return result; }

    // context.motherwave is { wave, fibLevels, invalidation } — the full API shape
    const mwResult = context.motherwave || null;
    if (!mwResult || !mwResult.wave) return result;

    result.motherwave = mwResult;
    result.patternStage = "motherwave";

    // trapZone from context (pre-computed) or fallback to local calc from wave
    const trapZone = context.trapZone || calcTrapZone(mwResult.wave);
    result.trapZone = trapZone;
    result.patternStage = "trapzone";

    // EMA lows for S1 detection
    const emaLows = calcEMA(candles.map(c => c.low), 9);

    // mwResult.wave.endIndex = bar index of MW tip — S1 starts after it
    const endIndex = mwResult.wave.endIndex;
    if (endIndex == null || endIndex < 0) { result.error = "missing_endIndex"; return result; }

    const { s1, s2, s3 } = findS1S2S3(candles, emaLows, trapZone, endIndex);
    result.s1 = s1; result.s2 = s2; result.s3 = s3;

    if (s1) result.patternStage = "s1";
    if (s2) result.patternStage = "s2";
    if (s3) { result.patternStage = "s3_complete"; result.found = true; }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  id: "s1s2s3",
  name: "Motherwave S1/S2/S3",
  description: "Identifies motherwave, plots 0.236 trap zone, then finds S1→S2→S3 candle pattern",
  scan,
};