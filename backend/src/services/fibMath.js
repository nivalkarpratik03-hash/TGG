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
 * 2026-08-13 (Mother Wave / Driver Wave engine merge — motherwave.js
 * replaced with the full-history/succession-rule/Driver-Wave engine):
 * fibPrice() gained a tipPrice/originPrice fallback, and buildFibLevels()
 * is now computed from fibPrice() at each ratio instead of hand-duplicated
 * per-direction arithmetic. Both changes are purely additive for every
 * existing caller — any wave already exposing fromPrice/toPrice/toSide
 * gets byte-identical numbers to before. They only add support for the new
 * engine's raw wave records (services/motherwave.js's computeSegments() /
 * buildMwdwState()), which use originPrice/tipPrice instead of
 * fromPrice/toPrice. buildFibLevels also now includes the "1.234" ratio
 * (Driver Wave invalidation / S3 succession level — see motherwave.js's
 * MWDW_CFG.fibS3Ratio / fibDwInvalidationRatio), which the old
 * per-direction formulas didn't have.
 *
 * All backend call sites now import from here instead of keeping their own
 * copy. This is also the intended eventual backend-supplied source for the
 * frontend's `computeFibLevels` (FibDashboardPage.js) cross-repo pair —
 * see TGG-project-plan.md Section 5 / Item 16 — not wired up yet, backend-
 * internal consolidation only for now.
 *
 * FIX (restored 2026-08-18): this file had accidentally been overwritten
 * with services/indicatorMath.js's content (calcEMA/trueRanges/wilderATR/
 * pivotHigh/pivotLow), so fibPrice/calcTrapZone/buildFibLevels did not
 * exist here anymore. Every caller of those three (motherwave.js's
 * require("./fibMath"), scannerS1.S2.S3.js, and scannerRunner.js via
 * motherwave.js's re-export) got `undefined` instead of a function, so
 * scannerRunner.js's per-symbol `calcTrapZone(mwResult)` call threw
 * "calcTrapZone is not a function" on every single scan — caught silently
 * by scannerRunner.js's outer try/catch and logged to this._errors per
 * symbol, so the scanner produced zero results for every symbol/strategy
 * while the rest of the app (which doesn't touch fibMath.js) kept working
 * fine. indicatorMath.js itself was untouched/correct — restored the real
 * fib-math content here instead.
 */

"use strict";

/**
 * price at a given fib ratio for a wave segment.
 * Accepts either a wave object directly, or a `{ wave }`-wrapped result
 * object (e.g. the full return value of detectMotherWaveForAPI). Also
 * accepts the MW/DW engine's raw wave records (originPrice/tipPrice field
 * names) via the tipPrice/originPrice fallback below.
 *
 * @param {object} mw - wave object, or object with a `.wave` property
 * @param {number} ratio
 * @returns {number}
 */
function fibPrice(mw, ratio) {
  const w = mw.wave || mw;
  const to = w.toPrice ?? w.tipPrice ?? w.endPrice;
  const from = w.fromPrice ?? w.originPrice ?? w.startPrice;
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
  const to = w.toPrice ?? w.tipPrice;
  const from = w.fromPrice ?? w.originPrice;
  return {
    high: Math.max(tip, ret),
    low: Math.min(tip, ret),
    center: (tip + ret) / 2,
    range: Math.abs(to - from),
  };
}

/**
 * Build the full fib-levels object from a wave segment (segment shape:
 * { fromPrice, toPrice, toSide, ... } OR the MW/DW engine's raw wave shape:
 * { originPrice, tipPrice, toSide, ... } — both work via fibPrice()'s
 * fallback). Computed as fibPrice(seg, ratio) per level rather than
 * hand-duplicated per-direction arithmetic — numerically identical to the
 * old hardcoded formulas for every existing bull/bear wave shape, but also
 * correct for the new engine's raw wave records, and adds "1.234" (Driver
 * Wave invalidation / S3 succession level), which the old formulas omitted.
 *
 * @param {object} seg
 * @returns {object} ratio-string → price map
 */
function buildFibLevels(seg) {
  return {
    "-1.618": fibPrice(seg, -1.618),
    "-1.0": fibPrice(seg, -1.0),
    "-0.618": fibPrice(seg, -0.618),
    "-0.236": fibPrice(seg, -0.236),
    "0.0": fibPrice(seg, 0.0),
    "0.236": fibPrice(seg, 0.236),
    "0.382": fibPrice(seg, 0.382),
    "0.5": fibPrice(seg, 0.5),
    "0.618": fibPrice(seg, 0.618),
    "0.786": fibPrice(seg, 0.786),
    "1.0": fibPrice(seg, 1.0),
    "1.234": fibPrice(seg, 1.234),
  };
}

module.exports = {
  fibPrice,
  calcTrapZone,
  buildFibLevels,
};