/**
 * backend/src/services/fibMath.js
 *
 * SINGLE SOURCE OF TRUTH for fib-price / trap-zone math.
 *
 * Previously fibPrice() and calcTrapZone() were independently copy-pasted
 * into services/motherwave.js and strategies/scannerS1.S2.S3.js. Both
 * copies were functionally equivalent for every real call site in this
 * repo — motherwave.js's version additionally unwraps a `{ wave }`-shaped
 * argument and falls back to `endPrice`/`startPrice` aliases, neither of
 * which scannerS1.S2.S3.js's copy handled, but neither path was ever hit
 * by scannerS1.S2.S3.js since it always calls with an already-unwrapped
 * wave object (see scannerRunner.js: `calcTrapZone(mwResult.wave)` there
 * vs `calcTrapZone(mwResult)` in scannerRunner.js's own direct call to
 * motherwave.js's version) — kept the more defensive version as canonical.
 *
 * buildFibLevels() also moved here from motherwave.js (same file, only one
 * real implementation existed) so Chunk 10 (test_motherwave.js) has a
 * single place to repoint to later, instead of two.
 *
 * All backend call sites now import from here instead of keeping their own
 * copy. This is also the intended eventual backend-supplied source for the
 * frontend's `computeFibLevels` (FibDashboardPage.js) cross-repo pair —
 * see TGG-project-plan.md Section 5 / Item 16 — not wired up yet, backend-
 * internal consolidation only for now.
 */

"use strict";

/**
 * price at a given fib ratio for a wave segment.
 * Accepts either a wave object directly, or a `{ wave }`-wrapped result
 * object (e.g. the full return value of detectMotherWaveForAPI).
 *
 * @param {object} mw - wave object, or object with a `.wave` property
 * @param {number} ratio
 * @returns {number}
 */
function fibPrice(mw, ratio) {
  const w = mw.wave || mw;
  const to = w.toPrice ?? w.endPrice;
  const from = w.fromPrice ?? w.startPrice;
  return to + ratio * (from - to);
}

/**
 * Trap zone (0 / 0.236 fib band) for a wave.
 * Same input shape as fibPrice.
 *
 * @param {object} mw
 * @returns {{high:number, low:number, center:number, range:number}}
 */
function calcTrapZone(mw) {
  const w = mw.wave || mw;
  const tip = fibPrice(w, 0);
  const ret = fibPrice(w, 0.236);
  return {
    high: Math.max(tip, ret),
    low: Math.min(tip, ret),
    center: (tip + ret) / 2,
    range: Math.abs(w.toPrice - w.fromPrice),
  };
}

/**
 * Build the full fib-levels object from a wave segment
 * (segment shape: { fromPrice, toPrice, toSide, ... }).
 *
 * @param {object} seg
 * @returns {object} ratio-string → price map
 */
function buildFibLevels(seg) {
  const isBull = seg.toSide === "high";
  const span = Math.abs(seg.toPrice - seg.fromPrice);
  const origin = seg.fromPrice;
  const end = seg.toPrice;

  return isBull
    ? {
      "-1.618": end + 1.618 * span,   // extension above tip
      "-1.0": end + 1.0 * span,   // extension above tip
      "-0.618": end + 0.618 * span,   // invalidation — extension above tip
      "-0.236": end + 0.236 * span,   // extension above tip (trap zone upper edge)
      "0.0": end,
      "0.236": end - 0.236 * span,   // trap zone lower edge
      "0.382": end - 0.382 * span,
      "0.5": end - 0.5 * span,
      "0.618": end - 0.618 * span,
      "0.786": end - 0.786 * span,
      "1.0": origin,               // invalidation — origin / base
    }
    : {
      "1.0": origin,               // invalidation — origin / base
      "0.786": origin - 0.214 * span,
      "0.618": origin - 0.382 * span,
      "0.5": origin - 0.5 * span,
      "0.382": origin - 0.618 * span,
      "0.236": origin - 0.764 * span,
      "0.0": end,
      "-0.236": end - 0.236 * span,   // extension below tip (trap zone upper edge)
      "-0.618": end - 0.618 * span,   // invalidation — extension below tip
      "-1.0": end - 1.0 * span,   // extension below tip
      "-1.618": end - 1.618 * span,   // extension below tip
    };
}

module.exports = {
  fibPrice,
  calcTrapZone,
  buildFibLevels,
};