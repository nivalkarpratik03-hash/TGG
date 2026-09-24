/**
 * backend/src/paperTrading/reportGenerator.js
 * ─────────────────────────────────────────────────────────────────
 * End-of-day tradesheets. Both reports read the SAME paper_trades
 * table, filtered by `source` — there is no separate report pipeline
 * per strategy/feature, just a different grouping of the same rows.
 *
 *   buildAutoReport(tradingDay)   — grouped by strategy: trades, wins,
 *                                    losses, win rate, net P&L per
 *                                    strategy + an overall total row.
 *   buildManualReport(tradingDay) — flat chronological trade log with
 *                                    overall totals.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { query } = require("../../../database/src/pool");

function summarize(trades) {
  const closed = trades.filter((t) => t.status === "CLOSED");
  const wins = closed.filter((t) => Number(t.pnl) > 0);
  const losses = closed.filter((t) => Number(t.pnl) <= 0);
  const netPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    netPnl: Number(netPnl.toFixed(2)),
  };
}

async function buildAutoReport(tradingDay) {
  const trades = await query(
    `SELECT * FROM paper_trades WHERE source='auto' AND trading_day=$1 ORDER BY strategy_id, entry_time`,
    [tradingDay]
  );

  const byStrategy = new Map();
  for (const t of trades) {
    const key = t.strategy_id || "unknown";
    if (!byStrategy.has(key)) byStrategy.set(key, { strategyId: key, strategyName: t.strategy_name, trades: [] });
    byStrategy.get(key).trades.push(t);
  }

  const strategies = [...byStrategy.values()].map((s) => ({
    strategyId: s.strategyId,
    strategyName: s.strategyName,
    ...summarize(s.trades),
    trades: s.trades,
  }));

  return {
    tradingDay,
    source: "auto",
    overall: summarize(trades),
    strategies,
  };
}

async function buildManualReport(tradingDay) {
  const trades = await query(
    `SELECT * FROM paper_trades WHERE source='manual' AND trading_day=$1 ORDER BY entry_time`,
    [tradingDay]
  );

  return {
    tradingDay,
    source: "manual",
    overall: summarize(trades),
    trades,
  };
}

module.exports = { buildAutoReport, buildManualReport, summarize };