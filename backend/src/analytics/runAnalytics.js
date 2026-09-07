"use strict";
/**
 * runAnalytics.js — Chunk 4 of the Analytics module (Analytics-project-plan.md
 * Section 5). Orchestrates the full pipeline: strategy signal -> trigger
 * adapter -> tradeSimulator -> aggregator -> cache.
 *
 * `strategy` is dependency-injected (an object with .id and .scan(symbol,
 * candles), same shape every strategyRegistry.js entry already has) rather
 * than looked up by string inside this file. Two reasons: (1) the real
 * caller (analyticsRouter.js) already has the strategy object from
 * strategyRegistry.js, no need to look it up twice; (2) it makes this file
 * testable with a stub strategy for pure orchestration-logic tests, AND
 * separately testable with the real absorptionFlip module for a genuine
 * integration smoke test — both without needing live Fyers data or a
 * running Postgres (see sanity_runAnalytics.js for both kinds of test).
 *
 * Candle data is INJECTED via `candlesBySymbol` (caller-supplied), not
 * fetched here — same reasoning, keeps this file testable standalone.
 * The real fetch (fetchCandles/deriveTimeframe) happens one layer up, in
 * analyticsRouter.js.
 */

const { getAdapter, isWired } = require("./triggerAdapters.js");
const { simulateTrade } = require("./tradeSimulator.js");
const { summarize } = require("./aggregator.js");
const cache = require("./cache.js");

// A trade in one of these states never actually happened as an analyzable
// trade (no entry price, or an invalid setup) — kept OUT of the trades
// array entirely, unlike "big_candle"/"open" which ARE real trades with
// an unresolved or ambiguous outcome and DO belong in the array (aggregator
// counts those honestly, see aggregator.js).
const NON_TRADE_STATES = new Set(["invalid_input", "invalid_zero_risk", "awaiting_entry_candle"]);

const IST_HOUR_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false });
const IST_DOW_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" });
const DOW_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Small, self-contained, new utility code — deliberately not presented as
// reuse of anything existing, because nothing in the repo already exposes
// an IST hour/day-of-week helper for a raw ms timestamp (checked
// candleBuilder.js's istDateKey/floorToMinute first; neither does this).
function istHourOf(ms) {
  return Number(IST_HOUR_FMT.format(new Date(ms)));
}
function istDowOf(ms) {
  const label = IST_DOW_FMT.format(new Date(ms));
  return label in DOW_INDEX ? DOW_INDEX[label] : null;
}

// candlesBySymbol: { [symbol]: closedCandlesArray } — closed-candle-only is
// the caller's responsibility, same guarantee absorptionFlip.js's own
// isLastCandleForming() already provides for LIVE scanning; for historical
// analytics every candle supplied should already be closed by definition.
function runAnalytics({ strategy, candlesBySymbol, params = {}, filters = {} }) {
  if (!strategy || !strategy.id || typeof strategy.scan !== "function") {
    return { error: "invalid_strategy" };
  }
  if (!isWired(strategy.id)) {
    return { error: "strategy_not_wired", strategyId: strategy.id };
  }

  const cacheKey = cache.buildCacheKey(strategy.id, params, filters);
  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const adapter = getAdapter(strategy.id);
  const trades = [];
  const skipped = { scanError: 0, adapterRejected: 0, nonTrade: 0 };

  for (const [symbol, candles] of Object.entries(candlesBySymbol || {})) {
    if (!candles || candles.length < 3) continue;

    let scanResult;
    try {
      scanResult = strategy.scan(symbol, candles);
    } catch (e) {
      skipped.scanError++;
      continue;
    }
    const events = (scanResult && Array.isArray(scanResult.events)) ? scanResult.events : [];

    for (const event of events) {
      const extracted = adapter(event);
      if (!extracted) {
        skipped.adapterRejected++;
        continue;
      }
      const sim = simulateTrade({
        candles,
        triggerIndex: extracted.triggerIndex,
        direction: extracted.direction,
      });
      if (NON_TRADE_STATES.has(sim.state)) {
        skipped.nonTrade++;
        continue;
      }
      trades.push({
        ...sim,
        symbol,
        direction: extracted.direction,
        entryHour: sim.entryTime != null ? istHourOf(sim.entryTime) : null,
        dow: sim.entryTime != null ? istDowOf(sim.entryTime) : null,
        conditions: extracted.conditions || {},
      });
    }
  }

  const summary = summarize(trades);
  const result = { strategyId: strategy.id, trades, summary, skipped, computedAt: Date.now() };
  cache.set(cacheKey, result);
  return { ...result, fromCache: false };
}

module.exports = { runAnalytics };
