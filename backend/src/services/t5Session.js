/**
 * backend/src/services/t5Session.js
 * ─────────────────────────────────────────────────────────────────
 * TG T5 Node Port Plan — Chunk 1: "Day-boundary / symbol-scale util".
 *
 * Ports two small pieces of Pine's session block (TG_T5_16_15.pine,
 * lines ~139–151):
 *
 *   newDay = na(lastDayStamp) or dayStamp != lastDayStamp   (line 143)
 *   var float symScale = 1.0
 *   if newDay and autoScale
 *       symScale := math.max(close / 24000.0, 0.000001)     (lines 148-150)
 *
 * Reuses candleBuilder.js's istDateKey() for the IST calendar-date math
 * instead of re-implementing it — it's the same 3-line calculation, no
 * reason for a second copy to maintain. That pulls in candleBuilder's
 * own requires (tickStream.js -> fyers-api-v3 + client.js), but those
 * are already full dependencies of this backend (see package.json), so
 * this adds coupling, not new weight — nothing here calls into the
 * live Fyers/DB path, only the pure date-string helper.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { istDateKey } = require("./candleBuilder");

/**
 * Returns the index of every "first candle of a session" bar — Pine's
 * `newDay` — for a chronological (oldest-first), gap-tolerant candle
 * array. Index 0 is always included: Pine's own `newDay` is also true
 * on the very first bar of a script's whole history, since
 * `lastDayStamp` starts as `na`.
 *
 * @param {Array<{time:number}>} candles - oldest first
 * @returns {number[]} ascending bar indices, one per new IST session
 */
function getSessionBoundaries(candles) {
  const boundaries = [];
  let lastKey = null;
  for (let i = 0; i < candles.length; i++) {
    const key = istDateKey(candles[i].time);
    if (lastKey === null || key !== lastKey) {
      boundaries.push(i);
      lastKey = key;
    }
  }
  return boundaries;
}

/**
 * Per-bar symbol-scale factor, matching Pine's `var float symScale`
 * carry-forward behaviour exactly:
 *   - autoScale = false → stays 1.0 for the entire history (Pine never
 *     reassigns it in this case — it keeps the `var` initial value).
 *   - autoScale = true  → recomputed ONLY on each session-boundary bar,
 *     from THAT bar's own close (the first candle of the day), then
 *     carried forward unchanged to every other bar until the next
 *     boundary — same as a Pine `var` that's only reassigned inside
 *     `if newDay`.
 *
 * @param {Array<{close:number}>} candles - oldest first, same array
 *   getSessionBoundaries() was run on.
 * @param {number[]} boundaries - output of getSessionBoundaries(candles)
 * @param {boolean} [autoScale=true]
 * @returns {number[]} one scale value per bar, same length as candles
 */
function computeSymScale(candles, boundaries, autoScale = true) {
  const n = candles.length;
  const out = new Array(n).fill(1.0);
  if (!autoScale) return out;

  const boundarySet = new Set(boundaries);
  let scale = 1.0;
  for (let i = 0; i < n; i++) {
    if (boundarySet.has(i)) {
      const c = candles[i].close;
      scale = Math.max((c == null || isNaN(c) ? 0 : c) / 24000, 0.000001);
    }
    out[i] = scale;
  }
  return out;
}

module.exports = {
  getSessionBoundaries,
  computeSymScale,
};