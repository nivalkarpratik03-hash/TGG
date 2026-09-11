'use strict';

/**
 * strategies/pinaka.js
 * ─────────────────────────────────────────────────────────────────────────
 * PINAKA SPEC 3 — Detectors A1 · A2 · B · B2 (direct Pine port)
 *
 * SAME EXTERNAL SHAPE AS tgT5.js / absorptionFlip.js / ceilingBreakRetest.js:
 * this file is a thin `{ id, name, description, scan }` wrapper that
 * strategyRegistry.js / scannerRunner.js call generically — but UNLIKE
 * those three, the state machine itself is NOT inlined here.
 *
 * It lives in exactly ONE place in the whole project:
 *   frontend/src/strategies/pinakaEngine.js
 * and this file requires that same file directly below. Node's `require`
 * has no restriction on reaching outside backend/src, so this works fine
 * even though the file physically sits under frontend/ — it has to live
 * there because CRA's webpack config (ModuleScopePlugin) refuses to
 * bundle anything the frontend imports from OUTSIDE frontend/src, so
 * that's the one location both sides can reach.
 *
 * The chart overlay (frontend/src/indicators/PinakaIndicator.js) imports
 * that exact same file too. There is exactly one copy of the A1/A2/B/B2
 * detection logic in this project — this wrapper, the chart indicator,
 * and any future watchlist feature all call into it instead of
 * re-implementing it. See pinakaEngine.js's own header for the full
 * rationale.
 *
 * `candles` must be an array of objects sorted oldest -> newest:
 *   { time, open, high, low, close, volume }
 * (same shape every other strategy in this folder already expects — see
 * backend/src/services/candleFetch.js).
 * ─────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const { PinakaDetectors } = require(
  path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'strategies', 'pinakaEngine.js')
);

const TRADE_TYPES = new Set(['A1', 'A2', 'B', 'B2']);

// ── Upcoming — setups currently building, not fired yet ─────────────────
// Reads engine.run()'s `series` (per-bar internal state, already computed,
// previously discarded here) and looks ONLY at the last bar to decide what's
// still in progress. Fields read are the exact ones pinakaEngine.js pushes
// per bar — see that file's `series.push({...})` — nothing here is guessed:
//   a1: { structSeen, pulled }  — pulled=true means price already closed
//                                  below emaLow after A1 structure formed,
//                                  waiting for the reclaim candle.
//   a2Stage                     — 0=idle, 1=reclaimed emaLow (waiting for
//                                  the re-touch/"higher low"), 2=re-touched
//                                  (waiting for the breakout close).
//   bFlew                       — a flying candle has been seen, waiting
//                                  for the red trigger candle.
//   b2Armed                     — the poke above the band happened and is
//                                  still inside the turn window, waiting
//                                  for the red engulf/close-below-band.
// `since` walks backward through `series` to the first bar where the same
// condition has been continuously true, so it's the real start of that
// run, not just "now".
function computeUpcoming(series) {
  const upcoming = [];
  if (!series || !series.length) return upcoming;
  const last = series[series.length - 1];

  function since(test) {
    let t = last.time;
    for (let i = series.length - 1; i >= 0; i--) {
      if (test(series[i])) t = series[i].time; else break;
    }
    return t;
  }

  if (last.a1 && last.a1.pulled) {
    upcoming.push({
      tag: 'A1',
      side: 'long',
      stage: 'Pulled below emaLow',
      waiting: 'Full-bodied green candle closing back above emaLow',
      since: since((s) => s.a1 && s.a1.pulled),
    });
  }

  if (last.a2Stage === 1 || last.a2Stage === 2) {
    upcoming.push({
      tag: 'A2',
      side: 'long',
      stage: last.a2Stage === 1 ? 'Stage 1 — reclaimed emaLow' : 'Stage 2 — re-touched emaLow (higher low)',
      waiting: last.a2Stage === 1
        ? 'Price to re-touch emaLow (the higher low)'
        : 'Full-bodied green candle closing above emaHigh',
      since: since((s) => s.a2Stage >= 1),
    });
  }

  if (last.bFlew) {
    upcoming.push({
      tag: 'B',
      side: 'short',
      stage: 'Flying above emaHigh',
      waiting: 'Red candle to engulf the green, or close below emaLow',
      since: since((s) => s.bFlew),
    });
  }

  if (last.b2Armed) {
    upcoming.push({
      tag: 'B2',
      side: 'short',
      stage: 'Armed after poke',
      waiting: 'Red candle to engulf the green run and close back below the band',
      since: since((s) => s.b2Armed),
    });
  }

  return upcoming;
}

// scannerRunner.js / strategyRegistry.js require every strategy to export
// { id, name, description, scan(symbol, candles, context) } returning a
// ScanResult with at minimum { symbol, found, patternStage, error, scannedAt }
// (same contract tgT5.js, ceilingBreakRetest.js, absorptionFlip.js follow).
//
// Purity: a brand-new PinakaDetectors is constructed per scan() call and
// fed the full candle history from scratch every time — same as every
// other strategy in this folder. No state is carried between scans.
function scan(symbol, candles, context = {}) {
  const result = {
    symbol,
    found: false,
    patternStage: 'none',
    side: null,          // "long" | "short" of the most recent TRADE signal
    tag: null,            // e.g. "A1", "B2"
    signals: [],          // every signal — TRADE (A1/A2/B/B2) AND
    // reference-only ✕ marks (A1x/A2x), for context
    upcoming: [],          // setups currently building, not fired yet —
    // see computeUpcoming() above
    lastCandle: candles && candles.length ? candles[candles.length - 1] : null,
    candleCount: candles ? candles.length : 0,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!candles || candles.length < 30) {
      result.error = 'insufficient_data';
      return result;
    }

    const engine = new PinakaDetectors({
      sigma: context.sigma,
      emaLen: context.emaLen,
      warmupBars: context.warmupBars,
      tickSize: context.tickSize,
      pivotLeft: context.pivotLeft,
      pivotRight: context.pivotRight,
      bodyPct: context.bodyPct,
      a1Strict: context.a1Strict,
      a1UseDepth: context.a1UseDepth,
      a1MaxRatio: context.a1MaxRatio,
      a1UseSlope: context.a1UseSlope,
      a1SlopeLen: context.a1SlopeLen,
      bGapMin: context.bGapMin,
      flyWin: context.flyWin,
      b2Win: context.b2Win,
      b2MinGreen: context.b2MinGreen,
      b2CloseAbove: context.b2CloseAbove,
    });

    const { signals, series } = engine.run(candles);
    result.signals = signals;
    result.upcoming = computeUpcoming(series);

    // found / patternStage / side / tag mirror the most recent TRADE
    // signal only — A1x/A2x are reference-only (per the Pine script's own
    // classification) and are kept in `signals` for context but never
    // drive these top-level fields, same rule tgT5.js applies to its own
    // non-actionable tags.
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i];
      if (TRADE_TYPES.has(s.type)) {
        result.found = true;
        result.side = s.side;
        result.tag = s.type;
        result.patternStage = s.type;
        break;
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  id: 'pinaka',
  name: 'Pinaka (A1 / A2 / B / B2)',
  description:
    'Direct Pine port of Pinaka Spec 3 — yearly-anchored VWAP+sigma bands with ' +
    'EMA9-high/low pivots: A1/A2 long continuation & reversal setups, B/B2 short ' +
    'extended-top & failed-poke setups.',
  scan,
  // Re-exported for direct/standalone use and for tests that want the
  // class without going through scan()'s ScanResult shaping.
  PinakaDetectors,
};