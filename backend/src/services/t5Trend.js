/**
 * backend/src/services/t5Trend.js
 * ─────────────────────────────────────────────────────────────────
 * TG T5 Node Port Plan — Chunk 2: Trend module.
 *
 * Pure port of Pine's baseline trend hysteresis block
 * (TG_T5_16_15.pine, lines ~193-216):
 *
 *   var string trendState     = "SIDEWAYS"
 *   var bool   trendConfirmed = false
 *   var float  structHigh = na
 *   var float  structLow  = na
 *   if barstate.isconfirmed
 *       if close > bandHigh and trendState != "UP"
 *           trendState := "UP" ; trendConfirmed := false ; structHigh := high
 *       else if close < bandLow and trendState != "DOWN"
 *           trendState := "DOWN" ; trendConfirmed := false ; structLow := low
 *       if trendState == "UP"
 *           if not trendConfirmed and isGreen and close > nz(structHigh, close)
 *               trendConfirmed := true
 *           structHigh := math.max(nz(structHigh, high), high)
 *       else if trendState == "DOWN"
 *           if not trendConfirmed and not isGreen and close < nz(structLow, close)
 *               trendConfirmed := true
 *           structLow := math.min(nz(structLow, low), low)
 *
 *   bandHigh = ta.ema(high, 9)   bandLow = ta.ema(low, 9)
 *   isGreen  = close > open
 *
 * DECISION (confirmed with sir, 2026-08-18): AUTO-ONLY. Pine also has a
 * manual "Force UP / Force DOWN / Force SIDEWAYS" override
 * (`trendMode` input) for when you're sitting on one chart and want to
 * overrule the auto trend. That's a per-chart tool — a 826-symbol
 * scanner has no single chart to sit on, so forcing one trend would
 * mean forcing it onto every symbol at once, which isn't a coherent
 * scanner concept. This port only implements the `trendMode == "Auto"`
 * path — i.e. `effTrend == trendState` and `effConf == trendConfirmed`
 * always, so `huntT5H`/`huntT5L`/`sidewaysNow` below ARE Pine's
 * `effTrend`-derived flags, just without a separate `effTrend` variable
 * since there's nothing to differ from.
 *
 * `if barstate.isconfirmed` — meaningless in this port: the scanner
 * only ever sees fully-closed candles (there's no "still forming" bar
 * in a historical replay), so every bar here behaves as though
 * isconfirmed was already true. Same equivalence the plan's Chunk 7
 * "what we deliberately don't port" section already relies on for
 * intrabar watchers.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { calcEMA } = require("./indicatorMath");

/**
 * @param {Array<{time:number, open:number, high:number, low:number, close:number}>} candles
 *   oldest first.
 * @returns {Array<{
 *   time: number,
 *   trendState: "UP"|"DOWN"|"SIDEWAYS",
 *   trendConfirmed: boolean,
 *   huntT5H: boolean,     // trendState=="UP"   and trendConfirmed
 *   huntT5L: boolean,     // trendState=="DOWN" and trendConfirmed
 *   sidewaysNow: boolean, // trendState=="SIDEWAYS"
 *   bandHigh: number|null,  // ta.ema(high, 9) — exposed so a symbol's
 *                           // trend can be eyeballed against the same
 *                           // band colour on a live TradingView chart
 *                           // before anything is built on top of it.
 *   bandLow: number|null,   // ta.ema(low, 9)
 * }>} one entry per input bar, same length/order as `candles`.
 */
function computeTrend(candles) {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const bandHighArr = calcEMA(highs, 9);
  const bandLowArr = calcEMA(lows, 9);

  const out = new Array(n);

  let trendState = "SIDEWAYS";
  let trendConfirmed = false;
  let structHigh = null; // Pine's `na`
  let structLow = null;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const bandHigh = bandHighArr[i];
    const bandLow = bandLowArr[i];
    const isGreen = c.close > c.open;

    // calcEMA seeds from the first valid price (same as Pine's ta.ema —
    // no multi-bar warm-up wait), so bandHigh/bandLow are only null if
    // this bar's own high/low was null/NaN. Guard anyway, matching
    // what Pine would do if the band were `na` (every comparison
    // against `na` is false, so the switch/confirm logic just no-ops
    // for that bar — trendState/trendConfirmed carry forward unchanged).
    if (bandHigh != null && bandLow != null) {
      if (c.close > bandHigh && trendState !== "UP") {
        trendState = "UP";
        trendConfirmed = false;
        structHigh = c.high;
      } else if (c.close < bandLow && trendState !== "DOWN") {
        trendState = "DOWN";
        trendConfirmed = false;
        structLow = c.low;
      }

      if (trendState === "UP") {
        if (!trendConfirmed && isGreen && c.close > (structHigh == null ? c.close : structHigh)) {
          trendConfirmed = true;
        }
        structHigh = Math.max(structHigh == null ? c.high : structHigh, c.high);
      } else if (trendState === "DOWN") {
        if (!trendConfirmed && !isGreen && c.close < (structLow == null ? c.close : structLow)) {
          trendConfirmed = true;
        }
        structLow = Math.min(structLow == null ? c.low : structLow, c.low);
      }
    }

    out[i] = {
      time: c.time,
      trendState,
      trendConfirmed,
      huntT5H: trendState === "UP" && trendConfirmed,
      huntT5L: trendState === "DOWN" && trendConfirmed,
      sidewaysNow: trendState === "SIDEWAYS",
      bandHigh,
      bandLow,
    };
  }

  return out;
}

module.exports = { computeTrend };
