"use strict";

/**
 * NOTE: exit-walking used to live here as a separate `walkForwardExit`
 * pass, called once per entry after strategy.js had already scanned the
 * WHOLE day for every longCond bar independently. That meant a second
 * entry could be recorded before the first trade's exit was known --
 * something real Pine can never do (`strategy.position_size == 0` blocks
 * it). That logic has been moved INTO strategy.js's single forward loop
 * (runStrategyForDay), so entries and exits are resolved bar-by-bar
 * together and a new entry is only ever considered once the previous
 * trade has actually closed -- exactly like Pine. This file now only
 * maps a resolved {entry, exitInfo} pair to real fill prices.
 */

/**
 * Maps entry/exit to REAL fills using the agreed convention: next bar's
 * open, in THIS SAME symbol's own sequence (no separate option-lookup
 * step needed -- the strategy already ran directly on this contract).
 */
function computeTradeResult(entry, exitInfo, bars, symbol, strike) {
  const entryBar = bars[entry.entryIndex];
  const exitBar = bars[exitInfo.exitIndex];

  const base = {
    symbol,
    strike,
    entryDate: entry.entryDate,
    entryTime: entry.entryTime,
    exitDate: exitBar.date,
    exitTime: exitBar.time,
    strikeStepsFromAtmAtEntry: entryBar.strikeStepsFromAtm,
    isAtmAtEntry: entryBar.isAtm,
    p1: entry.p1,
    p2: entry.p2,
    signalEntryPx: entry.entryPx, // close of confirmation candle -- the "ideal" price
    signalExitPx: exitInfo.exitPx, // stop/target/redexit/EOD level -- also "ideal"
    exitReason: exitInfo.exitReason,
    bigCandleTag: exitInfo.bigCandleTag,
    rMultiple: (exitInfo.exitPx - entry.entryPx) / entry.risk,
  };

  if (!entryBar.hasNextFill || entryBar.nextOpen == null) {
    return { ...base, fillable: false, reason: "NO_ENTRY_FILL" };
  }
  if (!exitBar.hasNextFill || exitBar.nextOpen == null) {
    return { ...base, fillable: false, reason: "NO_EXIT_FILL" };
  }

  const realEntryPx = entryBar.nextOpen;
  const realExitPx = exitBar.nextOpen;
  const realPnl = realExitPx - realEntryPx;

  return {
    ...base,
    fillable: true,
    realEntryPx,
    realExitPx,
    realPnl,
    realReturnPct: (realPnl / realEntryPx) * 100,
  };
}

module.exports = { computeTradeResult };