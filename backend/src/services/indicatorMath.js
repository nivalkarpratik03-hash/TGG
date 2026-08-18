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

/**
 * pivotHigh / pivotLow — port of Pine's ta.pivothigh(source, leftbars,
 * rightbars) / ta.pivotlow(source, leftbars, rightbars), for the TG T5
 * engine (Node Port Plan, Chunk 1).
 *
 * PARITY NOTE (flagging, not guessing — verify against a real
 * TradingView chart in Chunk 8): Pine's own pivot implementation isn't
 * published source, so this ports the standard, widely-used definition —
 * the centre bar must be STRICTLY greater (pivotHigh) / STRICTLY less
 * (pivotLow) than every bar in the left+right window, both sides. Real
 * OHLC data essentially never produces an exact tie at a pivot, so this
 * should match bar-for-bar, but it's still an assumption, not a
 * confirmed fact, until it's diffed against a live chart.
 *
 * OFFSET SEMANTICS (this is the part that's load-bearing and IS a
 * documented Pine fact, not an assumption): a pivot centred at bar
 * index `p` only becomes KNOWABLE once `rightbars` further bars exist —
 * you can't know bar p was a local high until you've seen the bars
 * after it. So the result is indexed like Pine's own series: entry
 * `p + rightbars` holds the pivot (an object with the pivot's own price
 * + the bar index `p` it actually happened on), every other entry is
 * null. This mirrors exactly how ta.pivothigh/ta.pivotlow only return a
 * non-na value on the bar where the pivot is confirmed, never earlier —
 * which is exactly the "zero staleness / exact candle" contract the
 * whole T5 port has to satisfy.
 *
 * @param {number[]} values - e.g. candle highs (for pivotHigh) or lows
 *   (for pivotLow), oldest first, one per bar.
 * @param {number} left  - bars required strictly beyond the centre bar
 *   on the left (Pine's leftbars).
 * @param {number} right - bars required strictly beyond the centre bar
 *   on the right (Pine's rightbars) — also the confirmation lag.
 * @returns {Array<{price:number, pivotIndex:number}|null>} same length
 *   as `values`; non-null only at index `pivotIndex + right`.
 */
function pivotHigh(values, left, right) {
  if (left < 0 || right < 0) throw new Error("pivotHigh: left/right must be >= 0");
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let centre = left; centre <= n - 1 - right; centre++) {
    const v = values[centre];
    if (v == null || isNaN(v)) continue;
    let isPivot = true;
    for (let j = centre - left; isPivot && j < centre; j++) {
      const o = values[j];
      if (o == null || isNaN(o) || o >= v) isPivot = false;
    }
    for (let j = centre + 1; isPivot && j <= centre + right; j++) {
      const o = values[j];
      if (o == null || isNaN(o) || o >= v) isPivot = false;
    }
    if (isPivot) out[centre + right] = { price: v, pivotIndex: centre };
  }
  return out;
}

/**
 * Mirror of pivotHigh — centre bar must be strictly LESS than every bar
 * in the left+right window. See pivotHigh's doc comment for the offset
 * semantics and the parity caveat; both apply here unchanged.
 *
 * @param {number[]} values - e.g. candle lows, oldest first.
 * @param {number} left
 * @param {number} right
 * @returns {Array<{price:number, pivotIndex:number}|null>}
 */
function pivotLow(values, left, right) {
  if (left < 0 || right < 0) throw new Error("pivotLow: left/right must be >= 0");
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let centre = left; centre <= n - 1 - right; centre++) {
    const v = values[centre];
    if (v == null || isNaN(v)) continue;
    let isPivot = true;
    for (let j = centre - left; isPivot && j < centre; j++) {
      const o = values[j];
      if (o == null || isNaN(o) || o <= v) isPivot = false;
    }
    for (let j = centre + 1; isPivot && j <= centre + right; j++) {
      const o = values[j];
      if (o == null || isNaN(o) || o <= v) isPivot = false;
    }
    if (isPivot) out[centre + right] = { price: v, pivotIndex: centre };
  }
  return out;
}

module.exports = {
  calcEMA,
  trueRanges,
  wilderATR,
  pivotHigh,
  pivotLow,
};