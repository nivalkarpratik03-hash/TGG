"use strict";
/**
 * aggregator.js — Chunk 3 of the Analytics module (Analytics-project-plan.md
 * Section 5). Pure math, no I/O, no DB, no cache access — takes an array of
 * simulated trades (tradeSimulator.js output, one object per trade) and
 * returns the summary numbers the dashboard's KPI row needs.
 *
 * Pattern generalized from backtest/src/report.js's summarize() (win rate,
 * avg R-multiple, drawdown, a "tag and set aside" count for the ambiguous
 * case) — not copy-pasted, since that version is option-strike-specific
 * (buckets by distance-from-ATM) and reports in a slightly different shape.
 * Same REASONING reused: only resolved (win/loss) trades count toward
 * win-rate/expectancy/profit-factor math; anything else (big_candle, open,
 * invalid_*) gets its own honest count instead of being silently dropped
 * or silently counted as a loss.
 */

const RESOLVED_STATES = new Set(["win", "loss"]);

function _avg(nums) {
  if (!nums.length) return null;
  return nums.reduce((s, x) => s + x, 0) / nums.length;
}

// `trades` = array of tradeSimulator.js outputs (each needs at minimum:
// state, rMultiple, mfe, mae, entryTime). Order doesn't need to be
// chronological — this function sorts by entryTime itself before walking
// the drawdown curve, since callers may hand it trades in any order.
function summarize(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const total = list.length;

  const resolved = list.filter((t) => RESOLVED_STATES.has(t.state));
  const wins = resolved.filter((t) => t.state === "win");
  const losses = resolved.filter((t) => t.state === "loss");
  const bigCandleCount = list.filter((t) => t.state === "big_candle").length;
  const openCount = list.filter((t) => t.state === "open").length;
  const invalidCount = total - resolved.length - bigCandleCount - openCount;

  const winRatePct = resolved.length ? (wins.length / resolved.length) * 100 : null;

  const rMultiples = resolved.map((t) => t.rMultiple || 0);
  const avgRMultiple = _avg(rMultiples); // == expectancy, in R terms
  const winRs = wins.map((t) => t.rMultiple || 0);
  const lossRs = losses.map((t) => t.rMultiple || 0);
  const avgWinR = _avg(winRs);
  const avgLossR = _avg(lossRs); // negative, by convention (rMultiple<0 on a loss)

  const grossWinR = winRs.reduce((s, x) => s + x, 0);
  const grossLossR = Math.abs(lossRs.reduce((s, x) => s + x, 0));
  const profitFactor = grossLossR ? grossWinR / grossLossR : null;

  // Drawdown walk — sort a COPY by entryTime so the caller's own array
  // order is never mutated out from under it.
  const chron = [...resolved].sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
  let cum = 0, peak = 0, maxDrawdownR = 0;
  for (const t of chron) {
    cum += t.rMultiple || 0;
    peak = Math.max(peak, cum);
    maxDrawdownR = Math.min(maxDrawdownR, cum - peak);
  }

  const avgMfe = _avg(resolved.map((t) => t.mfe || 0));
  const avgMae = _avg(resolved.map((t) => t.mae || 0));

  return {
    total,
    resolvedCount: resolved.length,
    bigCandleCount,
    openCount,
    invalidCount,
    wins: wins.length,
    losses: losses.length,
    winRatePct,
    avgRMultiple,
    expectancy: avgRMultiple,
    profitFactor,
    avgWinR,
    avgLossR,
    maxDrawdownR,
    avgMfe,
    avgMae,
  };
}

module.exports = { summarize, RESOLVED_STATES };
