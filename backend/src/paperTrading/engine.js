/**
 * backend/src/paperTrading/engine.js
 * ─────────────────────────────────────────────────────────────────
 * THE global paper trading engine. Every entry path in the app — a
 * strategy's auto-signal (autoEntryListener.js), the Manual Entry form,
 * a future "quick paper trade" button on Charts/Watchlist/Scanner — goes
 * through openTrade() below. There is exactly one trades table
 * (paper_trades) and exactly one SL/Target resolution path
 * (monitorOpenTrades()). Nothing here is strategy-specific; strategyId/
 * strategyName are just labels stored on the row.
 *
 * LIVE TRACKING: open trades are checked on EVERY tick from the shared Fyers
 * stream (liveFeed.js → onTick below) — the same feed the charts use. The first
 * tick to cross SL or Target decides the exit, so order is exact. The 1m-candle
 * scan (monitorOpenTrades) remains as reconciliation for anything missed while
 * the backend was down or a symbol was unsubscribed. Scanner strategies only
 * supply the ENTRY signal; they are never a price source.
 *
 * Price data (candle fallback): reads through database/src/store/dataRouter.js (via the
 * shared `db` object), the SAME router every other part of the app
 * already reads candles through — it auto-detects spot vs NSE/BSE/MCX
 * option/future from the symbol string, so this engine works identically
 * for equities, indices, and derivatives without any segment-specific
 * code here.
 *
 * SL/Target resolution:
 *   Walks 1-minute candles from just after entry_time forward. On each
 *   candle, checks whether SL or Target fell within [low, high].
 *   TIE-BREAK: if a single 1m candle's range crosses BOTH levels, this
 *   engine cannot know which was touched first from OHLC alone (no tick
 *   data is stored) — it conservatively resolves SL-first. This is a
 *   documented approximation, not a bug; flagged again in
 *   resolveExitInCandle() below.
 *
 * EOD square-off:
 *   If a trade is still open once its symbol's market session has ended
 *   for the day (isLiveMarket() false) and no more 1m candles are
 *   available, it's squared off at the last available candle's close
 *   with exit_reason='EOD_SQUAREOFF'.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const db = require("../../../database/src");
const { isLiveMarket } = require("../fyers/tickStream");
const liveFeed = require("./liveFeed");

// In-memory index of OPEN trades by symbol so the per-tick check never touches
// the DB. Rebuilt from the DB at boot and on every monitor pass.
const openBySymbol = new Map(); // symbol → Map<tradeId, trade>
const closing = new Set();      // trade ids mid-close (prevents double-close on rapid ticks)

function cacheAdd(trade) {
  if (!openBySymbol.has(trade.symbol)) openBySymbol.set(trade.symbol, new Map());
  openBySymbol.get(trade.symbol).set(Number(trade.id), trade);
}
function cacheRemove(trade) {
  const m = openBySymbol.get(trade.symbol);
  if (!m) return;
  m.delete(Number(trade.id));
  if (!m.size) openBySymbol.delete(trade.symbol);
}
function cacheReplaceAll(trades) {
  openBySymbol.clear();
  for (const t of trades) cacheAdd(t);
}
function syncLiveSymbols() { return liveFeed.syncSymbols([...openBySymbol.keys()]); }

// ── IST trading-day helper — same convention used across the project (candle
// storage, reports) — a trade opened at 14:50 IST and one opened at 09:20 IST
// the same calendar day both belong to that one trading_day.
function istTradingDay(dateLike) {
  const d = new Date(dateLike);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Open a new paper trade. Shared by BOTH Auto Entry and Manual Entry.
 *
 * @param {object} opts
 *   source        'auto' | 'manual'
 *   strategyId    string|null   — required for source='auto'
 *   strategyName  string|null
 *   symbol        full Fyers symbol string, e.g. "NSE:RELIANCE-EQ"
 *   side          'LONG' | 'SHORT'
 *   qty           number
 *   slPoints      number  (optional — used if slPrice not given)
 *   targetPoints  number  (optional — used if targetPrice not given)
 *   slPrice       number  (optional — explicit SL price, overrides slPoints)
 *   targetPrice   number  (optional — explicit Target price, overrides targetPoints)
 *   entryPrice    number  (optional — overrides live-candle lookup; used by tests/backfill)
 */
async function openTrade(opts) {
  const { source, strategyId = null, strategyName = null, symbol, side, qty = 1 } = opts;

  if (!symbol) throw new Error("openTrade: symbol is required");
  if (side !== "LONG" && side !== "SHORT") throw new Error("openTrade: side must be LONG or SHORT");

  const entryPrice = opts.entryPrice != null ? Number(opts.entryPrice) : await liveFeed.getLivePrice(symbol);
  if (entryPrice == null) throw new Error(`openTrade: no live price or candle data available for ${symbol} — cannot determine entry price`);

  const slPrice = opts.slPrice != null
    ? Number(opts.slPrice)
    : side === "LONG" ? entryPrice - Number(opts.slPoints) : entryPrice + Number(opts.slPoints);

  const targetPrice = opts.targetPrice != null
    ? Number(opts.targetPrice)
    : side === "LONG" ? entryPrice + Number(opts.targetPoints) : entryPrice - Number(opts.targetPoints);

  const entryTime = new Date();

  const { query } = require("../../../database/src/pool");
  const inserted = await query(
    `INSERT INTO paper_trades
       (source, strategy_id, strategy_name, symbol, side, qty, entry_time, entry_price, sl_price, target_price, status, trading_day)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11)
     RETURNING *`,
    [source, strategyId, strategyName, symbol, side, qty, entryTime.toISOString(), entryPrice, slPrice, targetPrice, istTradingDay(entryTime)]
  );

  const trade = inserted[0];
  cacheAdd(trade);
  syncLiveSymbols();
  console.log(`[PaperTrading] OPEN #${trade.id} ${source}${strategyId ? `/${strategyId}` : ""} ${symbol} ${side} @ ${entryPrice} (SL ${slPrice} / TGT ${targetPrice})`);
  return trade;
}

/**
 * LIVE path — called for EVERY tick from the shared Fyers stream (via
 * liveFeed). Checks only trades on that symbol, from the in-memory index.
 * First tick to cross a level decides the exit, so SL-vs-Target order is exact
 * (no candle-range guess). Exit is booked at the level price, same as the
 * candle path, so both paths produce comparable P&L.
 */
function onTick(tick) {
  const m = openBySymbol.get(tick.symbol);
  if (!m) return;
  const ltp = tick.ltp;
  for (const trade of m.values()) {
    if (closing.has(Number(trade.id))) continue;
    const sl = Number(trade.sl_price), tgt = Number(trade.target_price);
    const long = trade.side === "LONG";
    let reason = null, price = null;
    if (long ? ltp <= sl : ltp >= sl) { reason = "SL"; price = sl; }
    else if (long ? ltp >= tgt : ltp <= tgt) { reason = "TARGET"; price = tgt; }
    if (!reason) continue;
    closing.add(Number(trade.id));
    closeTrade(trade.id, { exitPrice: price, exitReason: reason, exitTime: new Date() })
      .catch((err) => console.error(`[PaperTrading] live close failed #${trade.id}:`, err.message))
      .finally(() => closing.delete(Number(trade.id)));
  }
}

/** Wire the engine to the shared live feed and load existing open trades. Call once at boot. */
async function initLive({ tickEngine }) {
  liveFeed.init({ tickEngine });
  liveFeed.setTickHandler(onTick);
  const { query } = require("../../../database/src/pool");
  cacheReplaceAll(await query(`SELECT * FROM paper_trades WHERE status='OPEN'`, []));
  await syncLiveSymbols();
}

/**
 * Decide SL vs Target for ONE candle whose range crosses both levels.
 * Documented approximation (see file header): no tick data stored, so we
 * cannot know true intrabar order. Resolves SL-first (conservative).
 */
function resolveExitInCandle(slPrice) {
  return { hit: true, reason: "SL", price: slPrice };
}

/** Given one candle and a trade's side/sl/target, return which (if any) was hit. */
function checkCandle(candle, side, slPrice, targetPrice) {
  const { high, low } = candle;
  const slHit = side === "LONG" ? low <= slPrice : high >= slPrice;
  const targetHit = side === "LONG" ? high >= targetPrice : low <= targetPrice;

  if (slHit && targetHit) return resolveExitInCandle(slPrice);
  if (slHit) return { hit: true, reason: "SL", price: slPrice };
  if (targetHit) return { hit: true, reason: "TARGET", price: targetPrice };
  return { hit: false };
}

/**
 * Scan every OPEN trade, walk 1m candles since entry, close any that hit
 * SL/Target/EOD. Called on a short interval (see scheduler.js) — the ONE
 * place SL/Target logic runs, for every trade regardless of source.
 */
async function monitorOpenTrades() {
  const { query } = require("../../../database/src/pool");
  const open = await query(`SELECT * FROM paper_trades WHERE status='OPEN'`, []);
  cacheReplaceAll(open.filter((t) => !closing.has(Number(t.id))));
  if (!open.length) { await syncLiveSymbols(); return { checked: 0, closed: 0 }; }

  let closed = 0;
  for (const trade of open) {
    try {
      const wasClosed = await evaluateTrade(trade);
      if (wasClosed) closed++;
    } catch (err) {
      console.error(`[PaperTrading] monitor error on trade #${trade.id} (${trade.symbol}):`, err.message);
    }
  }
  return { checked: open.length, closed };
}

async function evaluateTrade(trade) {
  const candles = await db.loadCandles(trade.symbol, 1, { from: trade.entry_time, limit: 100000 });
  const slPrice = Number(trade.sl_price);
  const targetPrice = Number(trade.target_price);

  for (const candle of candles) {
    const result = checkCandle(candle, trade.side, slPrice, targetPrice);
    if (result.hit) {
      await closeTrade(trade.id, { exitPrice: result.price, exitReason: result.reason, exitTime: new Date(candle.time) });
      return true;
    }
  }

  // No SL/Target hit yet — square off at EOD if the session has ended and
  // there's at least one candle to exit on.
  if (!isLiveMarket(trade.symbol) && candles.length) {
    const last = candles[candles.length - 1];
    await closeTrade(trade.id, { exitPrice: last.close, exitReason: "EOD_SQUAREOFF", exitTime: new Date(last.time) });
    return true;
  }

  return false;
}

/** Close a trade — used by SL/Target/EOD auto-resolution AND manual "close position" from the dashboard. */
async function closeTrade(tradeId, { exitPrice, exitReason, exitTime = new Date() }) {
  const { query } = require("../../../database/src/pool");
  const rows = await query(`SELECT * FROM paper_trades WHERE id=$1`, [tradeId]);
  if (!rows.length) throw new Error(`closeTrade: trade #${tradeId} not found`);
  const trade = rows[0];
  if (trade.status === "CLOSED") return trade; // idempotent

  const dir = trade.side === "LONG" ? 1 : -1;
  const pnl = dir * (Number(exitPrice) - Number(trade.entry_price)) * Number(trade.qty);

  const updated = await query(
    `UPDATE paper_trades
        SET exit_price=$2, exit_reason=$3, exit_time=$4, status='CLOSED', pnl=$5, updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [tradeId, exitPrice, exitReason, new Date(exitTime).toISOString(), pnl]
  );

  cacheRemove(trade);
  syncLiveSymbols();
  console.log(`[PaperTrading] CLOSE #${tradeId} ${trade.symbol} ${exitReason} @ ${exitPrice} → PnL ${pnl.toFixed(2)}`);
  return updated[0];
}

async function listTrades({ source, strategyId, tradingDay, status } = {}) {
  const { query } = require("../../../database/src/pool");
  const clauses = [];
  const params = [];
  let p = 1;
  if (source) { clauses.push(`source=$${p++}`); params.push(source); }
  if (strategyId) { clauses.push(`strategy_id=$${p++}`); params.push(strategyId); }
  if (tradingDay) { clauses.push(`trading_day=$${p++}`); params.push(tradingDay); }
  if (status) { clauses.push(`status=$${p++}`); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return query(`SELECT * FROM paper_trades ${where} ORDER BY entry_time DESC`, params);
}

module.exports = { initLive, onTick, openTrade, closeTrade, monitorOpenTrades, listTrades, istTradingDay, checkCandle };