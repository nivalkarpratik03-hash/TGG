// ─── state.js ───────────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k for the full split rationale.
//
// This module owns every piece of state that used to live as top-level
// `const`/`let` bindings directly inside server.js: config read from env,
// the shared Maps (symbolCacheMap, candleBuilders, socketSymbols, etc.), the
// DB/recoveryEngine handles, and the small pure helpers (cache key/get/set,
// buildPayload) that nearly every other module needs.
//
// IMPORTANT — mutation rule for anyone requiring this module:
// Maps and functions below are safe to destructure (`const { getCache } =
// require("./state")`) because the Map/function itself is never reassigned,
// only mutated internally (.set/.get/.delete) or called.
//
// `dbEnabled`, `lastTickAt`, `lastConnectAt`, and `autoRefreshTimer` ARE
// reassigned elsewhere (dbEnabled by scheduler.js after a failed DB health
// check; lastTickAt/lastConnectAt by tickEngine.js on every tick/connect/
// watchdog event; autoRefreshTimer by dataFetch.js's startAutoRefresh). A
// destructured `const { dbEnabled } = require("./state")` would silently
// snapshot the value at require-time and never see later updates — exactly
// the kind of bug this split must not introduce. Always access these four
// as `state.dbEnabled`, `state.lastTickAt`, etc., never destructure them.
require("dotenv").config();

// ─── Database ─────────────────────────────────────────────────────────────────
// DB is optional — if DATABASE_URL / PGHOST is not set, TGG runs without DB
// and behaves exactly as before (Fyers-only mode).
let db = null;
let dbEnabled = false;
let recoveryEngine = null;
try {
  db = require("../../../database/src/index");
  recoveryEngine = require("../../../database/src/recoveryEngine");
  dbEnabled = true;
  console.log("[DB] Database module loaded — PostgreSQL integration active");
} catch (err) {
  console.warn("[DB] Database module not found — running without DB (Fyers-only mode):", err.message);
}

// ── Throttled validateToken — caches result for 60s to prevent log spam ──────
// Raw validateToken() is called repeatedly by updateTickSubscription, startAutoRefresh,
// and maybeStartTickStream every few seconds. When token is expired every call logs
// "validateToken failed" — this wrapper silences the churn.
const { validateToken: _validateToken } = require("../fyers/client");
let _tokenCache = { valid: null, at: 0 };
async function validateToken() {
  if (Date.now() - _tokenCache.at < 60_000) return _tokenCache.valid;
  const valid = await _validateToken().catch(() => false);
  _tokenCache = { valid, at: Date.now() };
  return valid;
}
// Bust the cache immediately after a new token is saved so the next call is live
function bustTokenCache() { _tokenCache = { valid: null, at: 0 }; }

// ─── Config ───────────────────────────────────────────────────────────────────
// SYMBOL: optional — if set in .env, that symbol is pre-warmed at boot.
// If not set, the chart loads whatever the first connected client requests.
const SYMBOL = process.env.SYMBOL || null;
const RESOLUTION = parseInt(process.env.CANDLE_RESOLUTION || "3");
// CANDLES_TO_FETCH: passed to fetchCandles() as the `count` parameter but
// fetchCandles() currently ignores it — Fyers data is fetched by date-range
// windows (calcLookbackDays) not by count. This env var is kept for future use
// if a count-based slice is added. The actual depth is controlled by
// calcLookbackDays() in fyers/client.js (30d for 3m, 60d for 15m, 150d for 1h).
const CANDLES_TO_FETCH = parseInt(process.env.CANDLES_TO_FETCH || "10000");
// CHART_DB_WINDOW_DAYS: how many days of 1m history fetchAndProcess() pulls
// from Postgres for intraday resolutions (1/3/5/15/60). DB itself still
// stores a full year — this only controls what the chart loads/displays.
// Kept at 90 days (full chart history) — the indicator-toggle unsmoothness
// is a frontend rendering concern, to be fixed there, not by shrinking data.
// Daily/Weekly (1440/10080) always derive from full DB history regardless
// of this value, since they need long lookback for correct bar boundaries.
const CHART_DB_WINDOW_DAYS = parseInt(process.env.CHART_DB_WINDOW_DAYS || "90");
const REFRESH_MS = parseInt(process.env.SCHEDULE_INTERVAL_MS || "5000");
const TICK_WATCHDOG_MS = parseInt(process.env.TICK_WATCHDOG_MS || "10000");
const WATCHDOG_GRACE_MS = parseInt(process.env.WATCHDOG_GRACE_MS || "30000");

// ─── State ────────────────────────────────────────────────────────────────────
const symbolCacheMap = new Map();  // "SYMBOL:resolution" → { candles, result, lastFetch }
let autoRefreshTimer = null;
const socketResolutions = new Map(); // socket.id → resolution
const socketSymbols = new Map();     // socket.id → symbol (dual-panel per-socket filtering)
const socketUnderlyings = new Map(); // socket.id → underlying index/equity symbol, only set
// while that panel is showing an OPTION symbol and has
// "Auto ATM" switched on. Used purely as a side-channel
// LTP feed for the auto strike-switch feature — it never
// touches candleBuilders/symbolCacheMap.

// broadcastSymbols: symbol → lastRequestedAt (ms).
//
// ROOT-CAUSE FIX for "chart loads candles but WebSocket never attaches /
// frontend stays Offline / symbol gets re-seeded from DB every few seconds
// with no client connected":
//
// /api/chart and POST /api/chart/refresh can both be called WITHOUT a
// socketId (e.g. before the frontend's socket.io connection is ready, or
// any other broadcast-style refresh). Previously, getActiveTickSymbols()
// only ever looked at socketSymbols + socketUnderlyings — both of which are
// ONLY populated when a socketId is present. So a symbol requested in
// "broadcast" mode was fully invisible to updateTickSubscription(), which
// computed an empty symbol list forever ("[TickStream] No symbols provided
// — not starting." / "Started with symbols → []"), even while that exact
// symbol kept getting fetched/derived from the DB on every refresh cycle.
//
// This map closes that gap: ANY chart request, with or without a socketId,
// marks its symbol "recently wanted" here. getActiveTickSymbols() includes
// these too. Entries expire (see BROADCAST_SYMBOL_TTL_MS below) so a symbol
// nobody has actually requested in a while naturally falls out of the tick
// subscription instead of staying subscribed forever.
const broadcastSymbols = new Map();
const BROADCAST_SYMBOL_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Mark a symbol as recently requested via a broadcast-mode (no socketId) chart call. */
function markBroadcastSymbol(symbol) {
  if (!symbol) return;
  broadcastSymbols.set(symbol, Date.now());
}

/** Returns currently-live broadcast symbols, pruning any that have expired. */
function getLiveBroadcastSymbols() {
  const cutoff = Date.now() - BROADCAST_SYMBOL_TTL_MS;
  const live = [];
  for (const [sym, ts] of broadcastSymbols) {
    if (ts < cutoff) { broadcastSymbols.delete(sym); continue; }
    live.push(sym);
  }
  return live;
}

// lastTickAt / lastConnectAt — see the mutation-rule note at the top of this
// file. Reassigned by tickEngine.js; always access as state.lastTickAt /
// state.lastConnectAt from other modules, never destructure.
const lastTickBySymbol = new Map(); // symbol → Date.now() of last tick received

// ─── Candle Builder registry ──────────────────────────────────────────────────
// The CandleBuilder instances themselves live in tickEngine.js (that's where
// they're created/seeded), but the Map has to live here since dataFetch.js
// (fetchAndProcess) also reads/deletes from it directly (price-scale-mismatch
// reset check) without needing to pull in the rest of tickEngine.js's tick
// handling.
const candleBuilders = new Map();

// ─── Cache helpers ────────────────────────────────────────────────────────────
function cacheKey(symbol, resolution) { return `${symbol}:${resolution}`; }

function getCache(symbol, resolution) {
  const k = cacheKey(symbol, resolution);
  if (!symbolCacheMap.has(k)) symbolCacheMap.set(k, { candles: [], result: null, lastFetch: 0, motherwaveResult: null, motherwaveAt: 0 });
  return symbolCacheMap.get(k);
}

function setCache(symbol, resolution, candles, result) {
  const existing = symbolCacheMap.get(cacheKey(symbol, resolution)) || {};
  symbolCacheMap.set(cacheKey(symbol, resolution), {
    ...existing,
    candles,
    result,
    lastFetch: Date.now(),
    // Invalidate MW cache — candles changed, so MW may have changed
    motherwaveResult: null,
    motherwaveAt: 0,
  });
}

// ─── Payload builder ──────────────────────────────────────────────────────────
function buildPayload(candles, result, symbol, resolution, isAutoRefresh = false) {
  const clean = (candles || [])
    .filter((c) => Number.isFinite(c.time) && c.time > 0 && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
  return {
    symbol, resolution: Number(resolution), candles: clean,
    emaHighs: result.emaHighs, emaLows: result.emaLows, signals: result.signals,
    currentState: result.currentState, bestPrice: result.bestPrice, bestBar: result.bestBar,
    lastUpdate: new Date().toISOString(), isAutoRefresh,
  };
}

module.exports = {
  // db/dbEnabled/recoveryEngine — see mutation-rule note (dbEnabled is reassigned)
  db, dbEnabled, recoveryEngine,
  validateToken, bustTokenCache,
  SYMBOL, RESOLUTION, CANDLES_TO_FETCH, CHART_DB_WINDOW_DAYS, REFRESH_MS, TICK_WATCHDOG_MS, WATCHDOG_GRACE_MS,
  symbolCacheMap, candleBuilders,
  autoRefreshTimer,
  socketResolutions, socketSymbols, socketUnderlyings,
  broadcastSymbols, BROADCAST_SYMBOL_TTL_MS, markBroadcastSymbol, getLiveBroadcastSymbols,
  lastTickAt: 0, lastConnectAt: 0, lastTickBySymbol,
  cacheKey, getCache, setCache,
  buildPayload,
};
