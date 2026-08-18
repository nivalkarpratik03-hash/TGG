/**
 * backend/src/services/indicatorMath.js
 *
 * SINGLE SOURCE OF TRUTH for shared indicator math.
 *
 * Previously calcEMA() was independently copy-pasted into 4 backend files
 * (motherwave.js, backtestRunner.js, strategies/scannerS1.S2.S3.js,
 * services/signalEngine.js). Three of the four copies were the safe,
 * NaN/null-skipping version; signalEngine.js's copy had no such guard, so a
 * single bad candle (null/NaN close) would poison every EMA value after it
 * for the rest of that day's chart — silently killing NH/NL/BC signals and
 * corrupting the emaHighs/emaLows arrays sent to the frontend (which feed
 * WavesIndicator.js, SRZonesIndicator.js, ConsolidationIndicator.js).
 *
 * All backend call sites now import calcEMA from here instead of keeping
 * their own copy. Add any future shared indicator math (VWAP, ATR, Bollinger,
 * etc. — Phase 1) here too, so there's exactly one place to update.
 */

"use strict";

/**
 * Exponential Moving Average — skips null/NaN input values instead of
 * letting them poison every subsequent value.
 *
 * @param {Array<number|null|undefined>} prices - oldest first
 * @param {number} period
 * @returns {Array<number|null>} ema values, same length as input;
 *   entries before the first valid price are null.
 */
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let ema = null;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p == null || isNaN(p)) continue;
    ema = ema === null ? p : p * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * Direct port of w_mw_dw_logic_py/indicators/atr.py — true_ranges() + wilder_atr().
 * Was genuinely missing from this file before; required by the new Mother
 * Wave "qualifying cut" rule (body must be >= 0.6x ATR14-exclusive) and by
 * Driver Wave's strong-body test.
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @returns {number[]} true range per bar, same length as input
 */
function trueRanges(highs, lows, closes) {
  const n = highs.length;
  if (!n) return [];
  const out = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    out.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return out;
}

/**
 * Wilder's ATR — seeded with a simple average of the first `length` true
 * ranges, then smoothed. Returns null for every bar before the seed.
 *
 * @param {number[]} trueRangeValues
 * @param {number} length
 * @returns {Array<number|null>}
 */
function wilderATR(trueRangeValues, length) {
  if (length <= 0) throw new Error("ATR length must be positive");
  const n = trueRangeValues.length;
  const out = new Array(n).fill(null);
  if (n < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += trueRangeValues[i];
  seed /= length;
  out[length - 1] = seed;
  let prev = seed;
  for (let i = length; i < n; i++) {
    prev = ((length - 1) * prev + trueRangeValues[i]) / length;
    out[i] = prev;
  }
  return out;
}

module.exports = {
  calcEMA,
  trueRanges,
  wilderATR,
};