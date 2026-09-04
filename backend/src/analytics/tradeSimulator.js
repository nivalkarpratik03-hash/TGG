"use strict";
/**
 * tradeSimulator.js — Chunk 1 of the Analytics module (Analytics-project-plan.md
 * Section 4/5). Turns ONE strategy signal into ONE fully-resolved simulated
 * trade: entry, stop, target, exit, MFE/MAE, R-multiple.
 *
 * Locked rule (decided 2026-09-02, applies to EVERY strategy, no per-strategy
 * override — the only thing that differs per strategy is which candle counts
 * as the trigger, which the CALLER decides, not this file):
 *   - Entry  = the OPEN of the candle right after the trigger candle closes.
 *   - Stop   = the trigger candle's own high (short) / low (long).
 *   - Target = mirrored distance from entry — 1:1 risk:reward, always.
 *
 * This file does not know or care which strategy produced the trigger, or
 * what "trigger" means for that strategy (Doji for TG-T5, a different last
 * condition for another). It only needs: the candle array, and which index
 * in that array is the trigger candle, and which direction (up/down).
 *
 * Same-bar stop/target ambiguity handling below reuses the PATTERN already
 * proven in strategies/absorptionFlip.js's computeRetestOutcome() (check
 * stop before target, tag a same-bar double-hit as its own "big_candle"
 * outcome rather than guess which came first) — not copy-pasted, because
 * that function's entry rule (retest re-cross) is different from this one's
 * (next-bar open). Only the walk-forward resolution pattern is reused.
 */

// Simulates one trade from one trigger candle. `candles` must be CLOSED
// candles only (the caller's signal source already guarantees this — see
// absorptionFlip.js's isLastCandleForming() for how live strategies do it).
// `direction` is "up" (long) or "down" (short).
function simulateTrade({ candles, triggerIndex, direction }) {
  const base = {
    state: null,
    entryBarIndex: null, entryTime: null, entryPrice: null,
    stopPrice: null, targetPrice: null,
    exitBarIndex: null, exitTime: null, exitReason: null,
    pnl: null, rMultiple: null,
    mfe: null, mae: null,
    holdBars: null,
  };

  const n = candles ? candles.length : 0;

  if (!candles || n === 0 || triggerIndex == null || triggerIndex < 0 || triggerIndex >= n) {
    return { ...base, state: "invalid_input" };
  }
  if (direction !== "up" && direction !== "down") {
    return { ...base, state: "invalid_input" };
  }

  const entryBarIndex = triggerIndex + 1;
  if (entryBarIndex >= n) {
    // Trigger candle is the last candle we have — no next-bar open exists
    // yet to enter on. Not an error, just nothing to simulate YET.
    return { ...base, state: "awaiting_entry_candle" };
  }

  const bull = direction === "up";
  const triggerCandle = candles[triggerIndex];
  const entryCandle = candles[entryBarIndex];

  const entryPrice = entryCandle.open;
  const stopPrice = bull ? triggerCandle.low : triggerCandle.high;
  const risk = bull ? entryPrice - stopPrice : stopPrice - entryPrice;

  if (!(risk > 0)) {
    // Degenerate: the next candle gapped straight through (or exactly onto)
    // the trigger candle's own stop level — no valid risk distance to size
    // a 1:1 target off of. Same guard concept as absorptionFlip's own
    // zero-risk check. Flag it, don't emit a garbage target.
    return {
      ...base, state: "invalid_zero_risk",
      entryBarIndex, entryTime: entryCandle.time, entryPrice, stopPrice,
    };
  }

  const targetPrice = bull ? entryPrice + risk : entryPrice - risk;

  // ── Walk forward from the entry bar itself (inclusive — the entry bar's
  // own high/low can already touch stop or target, so the same-bar tie
  // case is real and must be checked, not skipped). ──────────────────────
  let mfe = 0, mae = 0; // both non-negative: best favorable / worst adverse, in price terms
  let state = "open", exitBarIndex = null, exitTime = null, exitReason = null;

  for (let k = entryBarIndex; k < n; k++) {
    const c = candles[k];

    const favorableExtreme = bull ? c.high : c.low;
    const adverseExtreme = bull ? c.low : c.high;
    const favMove = bull ? (favorableExtreme - entryPrice) : (entryPrice - favorableExtreme);
    const advMove = bull ? (entryPrice - adverseExtreme) : (adverseExtreme - entryPrice);
    if (favMove > mfe) mfe = favMove;
    if (advMove > mae) mae = advMove;

    const hitStop = bull ? c.low <= stopPrice : c.high >= stopPrice;
    const hitTarget = bull ? c.high >= targetPrice : c.low <= targetPrice;

    if (k === entryBarIndex && hitStop && hitTarget) {
      // Same ambiguity absorptionFlip already flags: one candle's range
      // contains BOTH stop and target — which came first isn't knowable
      // from OHLC alone. Tag it, don't guess, exclude from win/loss tally.
      state = "big_candle"; exitBarIndex = k; exitTime = c.time; exitReason = "ambiguous_same_bar";
      break;
    }
    if (hitStop) {
      state = "loss"; exitBarIndex = k; exitTime = c.time; exitReason = "stop";
      break;
    }
    if (hitTarget) {
      state = "win"; exitBarIndex = k; exitTime = c.time; exitReason = "target";
      break;
    }
  }

  if (state === "open") {
    // Never hit stop or target within the candles supplied. Not an error —
    // just means the trade is still running as of the last candle we have,
    // or the strategy's own "last condition" fired too close to present
    // time to have resolved yet. holdBars/MFE/MAE up to the last available
    // candle are still useful, so return them rather than nulling out.
    exitBarIndex = n - 1;
    exitTime = candles[n - 1].time;
    exitReason = "no_exit_in_data";
  }

  const exitPrice = state === "win" ? targetPrice
    : state === "loss" ? stopPrice
    : state === "big_candle" ? null // genuinely unknown, see comment above
    : candles[exitBarIndex].close; // "open"/no_exit_in_data — mark-to-last-close

  const pnl = exitPrice == null ? null : (bull ? exitPrice - entryPrice : entryPrice - exitPrice);
  const rMultiple = pnl == null ? null : Number((pnl / risk).toFixed(4));

  return {
    state,
    entryBarIndex, entryTime: entryCandle.time, entryPrice,
    stopPrice, targetPrice,
    exitBarIndex, exitTime, exitReason,
    exitPrice,
    pnl: pnl == null ? null : Number(pnl.toFixed(4)),
    rMultiple,
    mfe: Number(mfe.toFixed(4)),
    mae: Number(mae.toFixed(4)),
    holdBars: exitBarIndex - entryBarIndex,
  };
}

module.exports = { simulateTrade };
