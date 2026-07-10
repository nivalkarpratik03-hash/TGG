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

module.exports = {
  calcEMA,
};
