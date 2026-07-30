"use strict";

/**
 * Single set of numbers, matching Pine's own reported fills (this
 * strategy runs with process_orders_on_close = true, so the entry
 * candle's own close and the stop/target/redexit/EOD level ARE Pine's
 * real reported fill prices, not an approximation). No separate
 * "realistic next-bar-open fill" layer right now -- dropped intentionally
 * to keep one number to check against Pine strike-by-strike, to be
 * reintroduced later once signal-matching is fully verified.
 *
 * P&L here is reported in R-multiples (risk units), not rupees, since
 * there's no second "real fill" price to compute a rupee P&L from
 * anymore -- R-multiple is exactly what Pine's own trade-by-trade
 * correctness reduces to for this comparison.
 */
function summarize(trades) {
  const total = trades.length;

  const byReason = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;

  const bigCandleCount = trades.filter((t) => t.bigCandleTag).length;

  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = total - wins;
  const avgRMultiple = total ? trades.reduce((s, t) => s + t.rMultiple, 0) / total : null;

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.rMultiple;
    peak = Math.max(peak, cum);
    maxDD = Math.min(maxDD, cum - peak);
  }

  const bucketOf = (steps) => {
    const a = Math.abs(steps ?? 0);
    if (a === 0) return "ATM (0)";
    if (a <= 2) return "Near (1-2 steps)";
    if (a <= 5) return "Mid (3-5 steps)";
    return "Far (6+ steps)";
  };
  const buckets = {};
  for (const t of trades) {
    const b = bucketOf(t.strikeStepsFromAtmAtEntry);
    if (!buckets[b]) buckets[b] = { trades: 0, wins: 0, sumR: 0 };
    buckets[b].trades += 1;
    if (t.rMultiple > 0) buckets[b].wins += 1;
    buckets[b].sumR += t.rMultiple;
  }

  const bestTrade = total ? trades.reduce((b, t) => (t.rMultiple > b.rMultiple ? t : b)) : null;
  const worstTrade = total ? trades.reduce((w, t) => (t.rMultiple < w.rMultiple ? t : w)) : null;

  return {
    totalSignals: total,
    exitReasonBreakdown: byReason,
    bigCandleTaggedCount: bigCandleCount,
    winRatePct: total ? (wins / total) * 100 : null,
    avgRMultiple,
    wins,
    losses,
    cumulativeR: cum,
    maxDrawdownR: maxDD,
    moneynessBreakdown: buckets,
    bestTrade,
    worstTrade,
  };
}

function fmtPct(v) { return v == null ? "n/a" : `${v.toFixed(1)}%`; }

function printReport(summary) {
  const lines = [];
  lines.push(`Total signals across ALL strikes : ${summary.totalSignals}`);
  lines.push("");
  lines.push("Exit reason breakdown:");
  for (const [reason, count] of Object.entries(summary.exitReasonBreakdown)) {
    lines.push(`  ${reason.padEnd(18)} : ${count}`);
  }
  lines.push(`  (BIG_CANDLE tie-break tagged: ${summary.bigCandleTaggedCount})`);
  lines.push("");
  lines.push("SIGNAL RESULTS (matches Pine's own reported fills -- process_orders_on_close=true):");
  lines.push(`  Win rate       : ${fmtPct(summary.winRatePct)}  (${summary.wins}W / ${summary.losses}L)`);
  lines.push(`  Avg R          : ${summary.avgRMultiple?.toFixed(3)}`);
  lines.push(`  Cumulative R   : ${summary.cumulativeR?.toFixed(2)}`);
  lines.push(`  Max drawdown R : ${summary.maxDrawdownR?.toFixed(2)}`);
  lines.push("");
  lines.push("Moneyness breakdown (grouped by |strike steps from ATM| at entry):");
  for (const [bucket, s] of Object.entries(summary.moneynessBreakdown)) {
    const wr = s.trades ? (s.wins / s.trades) * 100 : null;
    lines.push(`  ${bucket.padEnd(20)} : ${s.trades} trades, win rate ${fmtPct(wr)}, Sum R ${s.sumR.toFixed(2)}`);
  }
  lines.push("");
  lines.push(formatHighlightTrade("BEST TRADE", summary.bestTrade));
  lines.push(formatHighlightTrade("WORST TRADE", summary.worstTrade));
  return lines.join("\n");
}

function formatHighlightTrade(label, t) {
  if (!t) return `${label}: none`;
  return (
    `${label}:\n` +
    `  Symbol: ${t.symbol}  (strike ${t.strike}, ${t.strikeStepsFromAtmAtEntry} steps from ATM at entry${t.isAtmAtEntry ? ", WAS ATM" : ""})\n` +
    `  Entry : ${t.entryDate} ${t.entryTime}  ->  Exit: ${t.exitDate} ${t.exitTime}  (${t.exitReason}${t.bigCandleTag ? " [BIG_CANDLE]" : ""})\n` +
    `  Entry/Exit px (signal, matches Pine) : ${t.signalEntryPx} -> ${t.signalExitPx}  (P1=${t.p1}, P2=${t.p2}, R=${t.rMultiple?.toFixed(2)})`
  );
}

/**
 * NEW: full trade log -- every trade (not just best/worst), carrying
 * P1/P2/entry-px/exit-px, so each row can be checked directly against
 * the real Pine chart on TradingView. Returns plain row objects (not a
 * formatted string) so the PDF builder can lay them out as a real table
 * rather than reflowed text.
 */
function buildFullTradeLog(trades) {
  return trades.map((t, i) => ({
    index: i + 1,
    symbol: t.symbol,
    strike: t.strike,
    steps: t.strikeStepsFromAtmAtEntry,
    isAtm: t.isAtmAtEntry,
    entryDate: t.entryDate,
    entryTime: t.entryTime,
    exitDate: t.exitDate,
    exitTime: t.exitTime,
    exitReason: t.exitReason,
    bigCandleTag: t.bigCandleTag,
    p1: t.p1,
    p2: t.p2,
    entryPx: t.signalEntryPx,
    exitPx: t.signalExitPx,
    rMultiple: t.rMultiple,
  }));
}

module.exports = { summarize, printReport, buildFullTradeLog };