/**
 * backend/src/paperTrading/liveFeed.js
 * ─────────────────────────────────────────────────────────────────
 * Paper Trading's window onto the app's ONE live price feed.
 *
 * It does NOT open its own socket or build its own candles. It rides
 * exactly what the charts ride:
 *   • every tick from the Fyers WebSocket (tickEngine.js → state.tickListeners)
 *   • the CandleBuilder's forming 1m candle (state.candleBuilders)
 *   • the DB router as a last resort (database/src dataRouter)
 *
 * Two jobs:
 *   1. Deliver live ticks to the paper engine (setTickHandler) so open trades
 *      are checked against SL/Target on every tick — not on closed candles.
 *   2. Keep the Fyers subscription covering every symbol with an open paper
 *      trade (syncSymbols → state.setExtraTickSymbols + updateTickSubscription),
 *      even when no chart is showing that symbol.
 *
 * Scanner strategies are NOT price sources here — they only supply the entry
 * signal (autoEntryListener.js). All price movement comes from this feed.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const state = require("../core/state");
const db = require("../../../database/src");

const FRESH_TICK_MS = 30 * 1000;
const lastPrice = new Map(); // symbol → { ltp, at }
let tickEngine = null;
let tickHandler = null;
let wired = false;

function init({ tickEngine: te }) {
  tickEngine = te;
  if (wired) return;
  wired = true;
  state.addTickListener((tick) => {
    if (!tick || !Number.isFinite(tick.ltp)) return;
    lastPrice.set(tick.symbol, { ltp: tick.ltp, at: Date.now() });
    if (tickHandler) tickHandler(tick);
  });
}

function setTickHandler(fn) { tickHandler = fn; }

/** Synchronous best-effort price (no DB). Fresh tick → forming 1m candle → null. */
function peekPrice(symbol) {
  const t = lastPrice.get(symbol);
  if (t && Date.now() - t.at <= FRESH_TICK_MS) return t.ltp;
  const builder = state.candleBuilders.get(symbol);
  if (builder) {
    const c1 = builder.getCandlesForResolution(1);
    if (c1 && c1.length) return Number(c1[c1.length - 1].close);
  }
  return t ? t.ltp : null;
}

/** Best available current price: live tick / forming candle, else last stored 1m close. */
async function getLivePrice(symbol) {
  const p = peekPrice(symbol);
  if (p != null) return p;
  const latest = await db.getLatestCandle(symbol, 1);
  return latest ? Number(latest.close) : null;
}

/** Make sure the shared Fyers subscription includes every symbol with an open paper trade. */
async function syncSymbols(symbols) {
  state.setExtraTickSymbols(symbols);
  if (tickEngine) {
    try { await tickEngine.updateTickSubscription(); }
    catch (err) { console.error("[PaperTrading] tick resubscribe failed:", err.message); }
  }
}

module.exports = { init, setTickHandler, peekPrice, getLivePrice, syncSymbols };