"use strict";

const XLSX = require("xlsx");

/**
 * MODEL: run the strategy directly on each option contract's OWN candles
 * (own OHLCV, own REAL volume) -- not on the NIFTY index.
 *
 * Returns: { symbols: [ { symbol, strike, bars } ] }
 *
 * `bars` is ONE CONTINUOUS CHRONOLOGICAL SERIES spanning every day this
 * symbol appears in the file -- NOT sliced into per-day arrays.
 *
 * THIS CHANGED (was day-sliced before) -- confirmed against the Pine
 * source directly: `ta.ema`, `ta.atr` (= `ta.rma`), and `ta.sma` are NOT
 * session-scoped in Pine. Only `ta.vwap(vwapSrc, newSession, mult1)` is
 * explicitly reset on `newSession`. Slicing into independent one-day
 * arrays (as this loader used to) silently re-ran every indicator's
 * warm-up period every single morning -- wrong versus Pine, where that
 * warm-up only happens once, at the very start of the strike's history.
 * Session-scoped state (VWAP, the P1/P2 pivot/armed state machine, EOD
 * flat) is instead reset INSIDE strategy.js's own per-bar loop on every
 * date change -- see runStrategyForSeries.
 *
 * Each bar: { date, time, open, high, low, close, volume,
 *             strikeStepsFromAtm, distanceFromAtm, isAtm, daysToExpiry }
 *
 * (No more precomputed `nextOpen`/`hasNextFill` -- entry fills at the
 * signal candle's own close, per the confirmed Pine setting
 * `process_orders_on_close = true`; exits are intrabar stop/target or
 * close-based RedExit/EOD, all resolved from bars already in the array.)
 */
function loadOptionChainWorkbook(path, optionType = "CE") {
  const wb = XLSX.readFile(path);
  const opt = XLSX.utils.sheet_to_json(wb.Sheets["option_candles"], { raw: true });

  const bySymbol = new Map();
  for (const row of opt) {
    if (row.option_type !== optionType) continue;
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }

  const symbols = [];
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const bars = rows.map((r, i) => {
      const next = rows[i + 1] || null;
      return {
        date: r.date,
        time: r.time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        strikeStepsFromAtm: r.strike_steps_from_atm,
        distanceFromAtm: r.distance_from_atm,
        isAtm: r.is_atm === true,
        daysToExpiry: r.days_to_expiry,
        // Realistic-fill reporting layer only (separate from Pine's own
        // strategy-tester fill, which is same-bar-close -- see strategy.js).
        // This is this SAME symbol's own next printed candle's open, gaps
        // and all, used to estimate real-world slippage vs. the signal
        // price. Kept as "next printed bar" even across a day boundary,
        // same convention as before.
        nextOpen: next ? next.open : null,
        hasNextFill: next != null,
      };
    });

    const strike = rows[0].strike;
    symbols.push({ symbol, strike, bars });
  }

  return { symbols };
}

module.exports = { loadOptionChainWorkbook };