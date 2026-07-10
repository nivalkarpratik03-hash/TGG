require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { runSignalEngine } = require("./services/signalEngine");
const { getAuthURL, generateToken, fetchCandles, validateToken: _validateToken, loadToken } = require("./fyers/client");

// ── Throttled validateToken — caches result for 60s to prevent log spam ──────
// Raw validateToken() is called repeatedly by updateTickSubscription, startAutoRefresh,
// and maybeStartTickStream every few seconds. When token is expired every call logs
// "validateToken failed" — this wrapper silences the churn.
let _tokenCache = { valid: null, at: 0 };
async function validateToken() {
  if (Date.now() - _tokenCache.at < 60_000) return _tokenCache.valid;
  const valid = await _validateToken().catch(() => false);
  _tokenCache = { valid, at: Date.now() };
  return valid;
}
// Bust the cache immediately after a new token is saved so the next call is live
function bustTokenCache() { _tokenCache = { valid: null, at: 0 }; }
const { CandleBuilder, deriveTimeframe } = require("./services/candleBuilder");
const { TickStream, isMarketOpen, isLiveMarket, isAnyMarketLive, isMCXSymbol, isTradingDay } = require("./fyers/tickStream");
const symbolsRouter = require("./routes/symbolsRouter");
const scannerRouter = require("./routes/scannerRouter");
const { scanner } = require("./services/scannerRunner");
const backtestRouter = require("./routes/backtestRouter");
const { backtestRunner } = require("./services/backtestRunner");
const { detectMotherWaveForAPI } = require("./services/motherwave");
const createChartRouter = require("./routes/chartRouter");
const corsMiddleware = require("./middleware/cors");
const rateLimiter = require("./middleware/rateLimiter");

// ─── Database ─────────────────────────────────────────────────────────────────
// DB is optional — if DATABASE_URL / PGHOST is not set, TGG runs without DB
// and behaves exactly as before (Fyers-only mode).
let db = null;
let dbEnabled = false;
let recoveryEngine = null;
try {
  db = require("../../database/src/index");
  recoveryEngine = require("../../database/src/recoveryEngine");
  dbEnabled = true;
  console.log("[DB] Database module loaded — PostgreSQL integration active");
} catch (err) {
  console.warn("[DB] Database module not found — running without DB (Fyers-only mode):", err.message);
}

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.use(express.json()); // parse JSON body — needed for req.body.socketId in /refresh
app.use(rateLimiter);

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
let lastTickAt = 0;
let lastConnectAt = 0;
const lastTickBySymbol = new Map(); // symbol → Date.now() of last tick received

// ── ticksFlowing: true if any subscribed symbol got a tick within watchdog window ─
// Window matches TICK_WATCHDOG_MS so both agree on what "stale" means.
// e.g. TICK_WATCHDOG_MS=60000 → green dot stays on for 60s after last tick,
// then watchdog reconnects AND ticksFlowing flips false at the same time.
const TICK_FLOWING_WINDOW_MS = TICK_WATCHDOG_MS;
function ticksFlowing() {
  const syms = getActiveTickSymbols();
  const cutoff = Date.now() - TICK_FLOWING_WINDOW_MS;
  return syms.some((s) => (lastTickBySymbol.get(s) || 0) > cutoff);
}

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

// ─── Candle Builder ───────────────────────────────────────────────────────────
const candleBuilders = new Map();

function getOrCreateBuilder(symbol) {
  if (!candleBuilders.has(symbol)) {
    const builder = new CandleBuilder({
      symbol,
      onTick: (formingCandles) => { emitCandleUpdate(symbol, formingCandles); },
      onFinalize: (finalizedCandle, formingCandles) => {
        console.log(`[Builder:${symbol}] Candle finalized @ ${new Date(finalizedCandle.time).toISOString()} close=${finalizedCandle.close}`);
        emitCandleUpdate(symbol, formingCandles);
        emitFinalCandle(symbol, finalizedCandle);

        // ── DB: save finalized 1m candle to PostgreSQL ──────────────────────
        if (dbEnabled) {
          db.upsertCandles(symbol, 1, [finalizedCandle]).catch((err) => {
            console.error(`[DB] Failed to save candle for ${symbol}:`, err.message);
          });
        }

        setImmediate(() => {
          const b = candleBuilders.get(symbol);
          if (!b) return;
          for (const res of [1, 3, 5, 15]) {
            const candles = b.getCandlesForResolution(res);
            if (candles.length === 0) continue;
            try { const result = runSignalEngine(candles); setCache(symbol, res, candles, result); }
            catch (err) { console.error(`[Builder:${symbol}] Signal engine error res=${res}:`, err.message); }
          }
          for (const res of [60, 1440, 10080]) {
            const cache = getCache(symbol, res);
            if (!cache.candles.length) continue;
            const forming1m = b.getCandlesForResolution(1);
            if (!forming1m.length) continue;
            const tick = forming1m[forming1m.length - 1];
            const cached = cache.candles;
            const last = cached[cached.length - 1];
            const updatedLast = { ...last, high: Math.max(last.high, tick.high), low: Math.min(last.low, tick.low), close: tick.close };
            const patched = [...cached.slice(0, -1), updatedLast];
            try { const result = runSignalEngine(patched); setCache(symbol, res, patched, result); }
            catch (err) { console.error(`[Builder:${symbol}] Patch error res=${res}:`, err.message); }
          }
        });

        // Deferred chart_update: symbol-scoped so dual panels don't overwrite each other
        setTimeout(() => {
          const b = candleBuilders.get(symbol);
          if (!b) return;
          for (const res of [1, 3, 5, 15, 60, 1440, 10080]) {
            const room = `res:${res}`;
            const roomSockets = io.sockets.adapter.rooms.get(room);
            if (!roomSockets?.size) continue;
            const cache = getCache(symbol, res);
            if (!cache.result || !cache.candles.length) continue;
            const payload = buildPayload(cache.candles, cache.result, symbol, res, true);
            for (const sid of roomSockets) {
              const sock = io.sockets.sockets.get(sid);
              if (!sock) continue;
              if ((socketSymbols.get(sid) || SYMBOL || symbol) === symbol) sock.emit("chart_update", payload);
            }
          }
        }, 250);
      },
    });
    candleBuilders.set(symbol, builder);
  }
  return candleBuilders.get(symbol);
}

// DUAL-PANEL FIX: emit tick/candle only to sockets watching this symbol
function emitCandleUpdate(symbol, formingCandles) {
  for (const [res, candle] of Object.entries(formingCandles)) {
    const numRes = Number(res);
    const room = `res:${numRes}`;
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (!roomSockets?.size || !candle) continue;
    const payload = { symbol, resolution: numRes, formingCandle: candle, timestamp: Date.now() };
    for (const sid of roomSockets) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      if ((socketSymbols.get(sid) || SYMBOL || symbol) === symbol) {
        sock.emit("tick_update", payload);
        sock.emit("candle_update", payload);
      }
    }
  }
}

function emitFinalCandle(symbol, finalizedCandle) {
  for (const res of [1, 3, 5, 15, 60, 1440, 10080]) {
    const room = `res:${res}`;
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (!roomSockets?.size) continue;
    for (const sid of roomSockets) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      if ((socketSymbols.get(sid) || SYMBOL || symbol) === symbol) {
        sock.emit("new_candle", { symbol, resolution: res, candle: finalizedCandle, timestamp: Date.now() });
      }
    }
  }
}

// ─── Tick Stream ──────────────────────────────────────────────────────────────
const tickStream = new TickStream();

tickStream.on("tick", (tick) => {
  const now = Date.now();
  const wasFlowing = ticksFlowing();
  lastTickAt = now;
  lastTickBySymbol.set(tick.symbol, now);
  getOrCreateBuilder(tick.symbol).processTick(tick);
  // If ticks just started flowing (e.g. after a gap/holiday silence),
  // immediately tell all clients — don't wait for the 30s broadcast.
  if (!wasFlowing) io.emit("market_status", { ticksFlowing: true });

  // ── Auto-ATM side-channel: forward this tick's LTP to any socket that has
  // registered this exact symbol as its underlying via set_underlying.
  // Pure passthrough — no candle building, no cache writes.
  for (const [sid, underlyingSym] of socketUnderlyings) {
    if (underlyingSym !== tick.symbol) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    sock.emit("underlying_tick", { symbol: tick.symbol, ltp: tick.ltp, timestamp: now });
  }
});
tickStream.on("connected", () => { console.log("[TickStream] Fyers WebSocket connected ✓"); lastTickAt = 0; lastConnectAt = Date.now(); io.emit("market_status", { tickStreamActive: true, ticksFlowing: false }); });
tickStream.on("disconnected", () => { console.log("[TickStream] Fyers WebSocket disconnected"); io.emit("market_status", { tickStreamActive: false, ticksFlowing: false }); });
tickStream.on("error", (err) => { console.error("[TickStream] Error:", err?.message || err); });

/**
 * deriveUnderlyingSymbol — given an OPTION contract symbol, return its
 * underlying index/equity symbol so the tick stream can be subscribed to it.
 * Mirrors frontend/src/utils/optionsChain.js getOptionRoot() — kept in sync
 * (browser code can't require() this module, so that copy stays separate,
 * same pattern as holidays.js/holidayCalendar.js).
 *   "NSE:NIFTY2570724000PE"   → "NSE:NIFTY50-INDEX"
 *   "NSE:RELIANCE26JUL3200CE" → "NSE:RELIANCE-EQ"
 *   "MCX:CRUDEOIL26JUL5000CE" → null  (commodity options — not supported)
 *
 * P3 #13 — this used to have its own regex (OPTION_SUFFIX_RE) duplicating
 * database/src/symbolParser.js's parsing logic. Now delegates to that
 * module's parseDerivativeSymbol() as the primary path. OPTION_SUFFIX_RE is
 * kept ONLY as a fallback for the (rare, Fyers-only-mode) case where the
 * database/ package isn't present at all — matching the "DB is optional"
 * pattern already used for db/recoveryEngine above.
 */
const OPTION_SUFFIX_RE = /^(.*?)(\d{2}(?:[A-Z]{3}|[1-9OND]\d{2}))(\d+(?:\.\d+)?)(CE|PE)$/;
const INDEX_ROOT_TO_SYMBOL = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:CNXFINANCE-INDEX",
  NIFTYIT: "NSE:CNXIT-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  SENSEX: "BSE:SENSEX-INDEX",
};
let parseDerivativeSymbol = null;
try {
  ({ parseDerivativeSymbol } = require("../../database/src/symbolParser"));
} catch (err) {
  console.warn("[SymbolParser] Module not found — deriveUnderlyingSymbol falls back to inline regex:", err.message);
}
function deriveUnderlyingSymbolFallback(sym, exch, ticker) {
  const m = OPTION_SUFFIX_RE.exec(ticker);
  if (!m) return null;
  const root = m[1];
  if (INDEX_ROOT_TO_SYMBOL[root]) return INDEX_ROOT_TO_SYMBOL[root];
  return `NSE:${root}-EQ`;
}
function deriveUnderlyingSymbol(sym) {
  if (!sym) return null;
  const colonIdx = sym.indexOf(":");
  if (colonIdx < 0) return null;
  const exch = sym.slice(0, colonIdx);
  const ticker = sym.slice(colonIdx + 1);
  if (exch === "MCX") return null; // commodity options — not supported by Auto-ATM
  if (!parseDerivativeSymbol) return deriveUnderlyingSymbolFallback(sym, exch, ticker);
  const parsed = parseDerivativeSymbol(sym);
  if (!parsed || parsed.instrument_type !== "option") return null;
  const root = parsed.underlying;
  if (INDEX_ROOT_TO_SYMBOL[root]) return INDEX_ROOT_TO_SYMBOL[root];
  return `NSE:${root}-EQ`;
}

/**
 * isOptionSymbol — true if `sym` is a dated NSE/MCX option contract.
 * P3 #13 — also now delegates to parseDerivativeSymbol() instead of its
 * own OPTION_SUFFIX_RE.test() call, with the same inline-regex fallback.
 */
function isOptionSymbol(sym) {
  if (!parseDerivativeSymbol) {
    const colonIdx = sym.indexOf(":");
    const ticker = colonIdx >= 0 ? sym.slice(colonIdx + 1) : sym;
    return OPTION_SUFFIX_RE.test(ticker);
  }
  const parsed = parseDerivativeSymbol(sym);
  return !!parsed && parsed.instrument_type === "option";
}

/**
 * getActiveTickSymbols — returns every symbol currently watched by any connected
 * socket, plus the default SYMBOL, plus any Auto-ATM underlying symbols any
 * socket has registered via set_underlying. This is the list Fyers WebSocket
 * subscribes to.
 */
function getActiveTickSymbols() {
  const set = new Set();
  if (SYMBOL) set.add(SYMBOL);
  for (const sym of socketSymbols.values()) { if (sym) set.add(sym); }
  for (const sym of socketUnderlyings.values()) { if (sym) set.add(sym); }
  for (const sym of getLiveBroadcastSymbols()) { set.add(sym); }
  return [...set];
}

/**
 * updateTickSubscription — sync the Fyers WebSocket subscription to the current
 * set of symbols watched by all connected panels.
 *
 * ROOT-CAUSE FIX for "only NIFTY gets tick-by-tick":
 * Previously maybeStartTickStream() always called tickStream.start([SYMBOL])
 * regardless of what panels were searching. Now every symbol change emits
 * set_symbol on the socket, which triggers this function to either:
 *   - add the new symbol via tickStream.setSymbols() if already connected, or
 *   - restart tickStream.start() with the full list if not yet running.
 */
async function updateTickSubscription() {
  if (!isTradingDay()) return;
  const valid = await validateToken().catch(() => false);
  if (!valid) return;
  const symbols = getActiveTickSymbols();
  if (!isAnyMarketLive(symbols)) return;
  if (tickStream.isConnected()) {
    tickStream.setSymbols(symbols);
    console.log(`[TickStream] Subscription updated → [${symbols.join(", ")}]`);
  } else {
    tickStream.start(symbols);
    console.log(`[TickStream] Started with symbols → [${symbols.join(", ")}]`);
  }
}

/**
 * maybeStartTickStream — startup entry point. Uses getActiveTickSymbols() so
 * any symbols already in socketSymbols (from fast-connecting clients) are included.
 */
async function maybeStartTickStream() {
  if (!isTradingDay()) { console.log("[TickStream] Weekend — tick stream not needed."); return; }
  const symbols = getActiveTickSymbols();
  if (!isAnyMarketLive(symbols)) { console.log("[TickStream] No active market right now — tick stream not needed."); return; }
  if (tickStream.isConnected()) { tickStream.setSymbols(symbols); return; }
  const valid = await validateToken().catch(() => false);
  if (!valid) { console.log("[TickStream] Not authenticated — skipping tick stream."); return; }
  tickStream.start(symbols);
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

// ─── Core fetch & process ─────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for "get me candles for symbol+resolution".
// Every caller — GET /api/chart, POST /api/chart/refresh, /api/motherwave,
// and initialRestFetch() — goes through this one function. No DB code lives
// anywhere else in the codebase.
//
// Order of operations:
//   1. DB-first  — if DB is enabled and has 1m rows for `symbol`, derive the
//      requested resolution from Postgres. No Fyers call needed. This is the
//      common case once a symbol has been backfilled at least once.
//   2. Fyers fallback — only when DB is disabled, DB has zero rows for this
//      symbol (fresh symbol, never backfilled), or the DB read throws. Fetches
//      from Fyers REST and write-throughs 1m candles to DB so the *next* call
//      for this symbol takes the DB-first path.
//
// Daily/Weekly (1440/10080) always derive from the FULL 1m history stored in
// DB (not the CHART_DB_WINDOW_DAYS slice) — they need long lookback to form
// correct calendar-day/week boundaries. Everything else (1/3/5/15/60) uses
// the last CHART_DB_WINDOW_DAYS days only, which is what keeps the chart
// smooth.
// ─── Lightweight per-symbol staleness check (boot / reactive) ────────────────
//
// PROBLEM THIS SOLVES: previously, once a symbol had ANY 1m rows in DB,
// loadFromDB() trusted them unconditionally — it never asked "is this
// actually CURRENT, or did the server just sit down for a while and DB's
// last candle is hours old?" If the backend was restarted mid-session
// (e.g. down 09:45→12:00 while the market stayed live), every
// already-seeded symbol silently kept a hole from 09:45 to 12:00 forever —
// nothing ever went back to fill it in, because the deep 90-day validator
// explicitly skips "today" (it's supposed to — today is still in progress)
// and the live tick stream only produces NEW candles from the moment it
// reconnects onward.
//
// FIX: every time loadFromDB() is about to serve DB data for a symbol, check
// DB's latest 1m candle against the clock. If it's stale beyond a small
// tolerance, fetch just the missing delta range from Fyers (cheap — a
// couple of days lookback at most, not a full year), upsert it, and merge
// it into the data being returned/seeded so the chart and the candle
// builder both start from a fully caught-up base instead of carrying a
// silent hole forward indefinitely.
//
// Throttled per symbol (STALENESS_CHECK_COOLDOWN_MS) so this can't turn
// into a Fyers-hammering loop under the 5s auto-refresh poll — at most one
// delta-fetch attempt per symbol per cooldown window, regardless of how
// many chart requests come in during that window.
//
// GATING (2026-07-07, confirmed): no day-type check at all here anymore —
// not weekend, not holiday, not "is today a trading day." The Fyers REST
// call is cheap and harmless any day (it just returns nothing new on a
// closed day), and gating on day-type risked silently missing a new
// contract's first candles landing right after a holiday. The ONLY gate
// left is "is the Fyers token valid?"
const STALENESS_TOLERANCE_MS = 3 * 60 * 1000;       // DB allowed to lag "now" by up to 3 minutes before it's considered stale
const STALENESS_CHECK_COOLDOWN_MS = 60 * 1000;       // don't re-check/re-fetch the same symbol more than once per minute
const lastStalenessCheckAt = new Map();              // symbol → ms timestamp of last check/attempt

/**
 * If `oneMinCandles` (already loaded from DB, ascending by time) looks stale
 * relative to "now", fetch just the missing delta from Fyers, upsert it, and
 * return a merged, de-duplicated, sorted array. Otherwise returns the
 * original array unchanged.
 *
 * The only gate is token validity — runs any day (weekend/holiday/trading
 * day), since the API call is cheap and harmless when there's nothing new.
 *
 * Never throws — any failure here just means we fall back to serving the
 * (possibly stale) DB data exactly as before this fix existed, so this can
 * never make things worse than the pre-fix behavior.
 */
async function ensureFreshOneMinData(symbol, oneMinCandles) {
  try {
    if (!oneMinCandles || oneMinCandles.length === 0) return oneMinCandles;

    const lastCandle = oneMinCandles[oneMinCandles.length - 1];
    const nowMs = Date.now();
    const lagMs = nowMs - lastCandle.time;
    if (lagMs <= STALENESS_TOLERANCE_MS) return oneMinCandles; // already current — nothing to do

    const lastCheck = lastStalenessCheckAt.get(symbol) || 0;
    if (nowMs - lastCheck < STALENESS_CHECK_COOLDOWN_MS) return oneMinCandles; // throttled — already tried recently
    lastStalenessCheckAt.set(symbol, nowMs);

    // Only gate: do we have a working Fyers login right now? No day-type
    // check (weekend/holiday/trading day) — those no longer matter here.
    const tokenOk = await validateToken().catch(() => false);
    if (!tokenOk) return oneMinCandles;

    console.log(`[Staleness] ${symbol}: DB latest is ${(lagMs / 60000).toFixed(1)}min behind — fetching delta from Fyers`);

    // Small bounded lookback (2 days) is always enough to cover the gap —
    // even a multi-hour outage never spans more than the current + previous
    // trading day. This keeps the delta-fetch cheap and fast, unlike a full
    // historical refetch.
    const fresh1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH, 2);
    if (!fresh1m || fresh1m.length === 0) return oneMinCandles;

    // Only keep candles strictly newer than what we already have — avoids
    // re-validating/re-sorting the whole existing range unnecessarily.
    const newOnes = fresh1m.filter((c) => c.time > lastCandle.time);
    if (newOnes.length === 0) return oneMinCandles;

    if (dbEnabled && db) {
      try {
        const inserted = await db.upsertCandles(symbol, 1, newOnes);
        console.log(`[Staleness] ${symbol}: backfilled ${inserted} missing 1m candle(s)`);
        // FRONTEND-SYNC FIX: if a chart for this symbol was already open in a
        // browser tab BEFORE this backfill ran, the page's first render would
        // have shipped with the (then-stale) DB data — and since the live tick
        // stream only appends NEW candles going forward, that earlier render
        // would carry a visual gap forward indefinitely with nothing telling
        // it to re-fetch. Broadcasting this event lets any open chart for this
        // symbol silently re-pull fresh history the moment the backfill lands,
        // instead of requiring a manual page reload to see corrected data.
        io.emit("history_updated", { symbol, reason: "staleness_backfill", count: inserted });
      } catch (err) {
        console.warn(`[Staleness] ${symbol}: upsert of delta candles failed (${err.message}) — still using them in-memory for this response`);
      }
    }

    const merged = [...oneMinCandles, ...newOnes]
      .sort((a, b) => a.time - b.time)
      .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
    return merged;
  } catch (err) {
    console.warn(`[Staleness] ${symbol}: check failed (${err.message}) — serving DB data as-is`);
    return oneMinCandles;
  }
}

// ─── Curated-symbol gap scan + staleness sweep (fixes 4 & 5) ──────────────────
// Validates every curated (no-expiry) symbol against the broker, repairs any
// gap, then proactively runs the same staleness/delta-fetch check
// ensureFreshOneMinData() does — but for EVERY curated symbol, not just
// whichever one a client happens to have open.
//
// Callable from two places:
//   1. Once at boot, right after initialRestFetch (trigger="startup").
//   2. From the /api/auth/token route, right after a token is successfully
//      (re)generated (trigger="reauth") — this is the actual re-auth hook
//      that used to be missing. Previously the boot-time log said "Will
//      repair after re-auth" but nothing was ever wired up to make that
//      true; submitting a new token only busted the validateToken cache and
//      restarted the tick stream, it never re-ran recovery or staleness.
//
// An in-flight guard prevents the two triggers from ever running the sweep
// concurrently (e.g. someone re-auths a few seconds after boot, while the
// startup sweep is still in progress).
let _catchUpInFlight = false;

async function runCuratedSymbolCatchUp(trigger = "startup") {
  if (!recoveryEngine || !dbEnabled || !db) return;

  if (_catchUpInFlight) {
    console.log(`[Recovery] Catch-up already running — skipping duplicate ${trigger} trigger`);
    return;
  }
  _catchUpInFlight = true;

  try {
    const fs = require("fs");
    const path = require("path");
    const NO_EXPIRY_SYMBOLS_JSON = path.resolve(__dirname, "./data/noExpirySymbols.json");
    let curatedSymbols = [];
    try {
      const all = JSON.parse(fs.readFileSync(NO_EXPIRY_SYMBOLS_JSON, "utf8"));
      curatedSymbols = all.map((s) => s.symbol).filter(Boolean);
    } catch (e) {
      console.warn("[Recovery] Could not load noExpirySymbols.json for catch-up scan:", e.message);
      return;
    }

    if (trigger === "startup") {
      // Wait for initialRestFetch to finish (it runs right before the boot call)
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Skip if token is invalid — repairs need Fyers, pointless without auth.
    // On the "reauth" trigger this should basically always pass, since the
    // caller only invokes this after a token was just successfully saved —
    // but re-check anyway rather than assume, in case it expired again
    // between save and this call.
    const tokenOk = await validateToken().catch(() => false);
    if (!tokenOk) {
      console.log(`[Recovery] Catch-up (${trigger}) skipped — token invalid. Will repair after re-auth.`);
      return;
    }

    console.log(`[Recovery] Catch-up (${trigger}): checking ${curatedSymbols.length} curated symbols...`);
    let repaired = 0;
    let clean = 0;
    let skippedKnown = 0;
    const CONCURRENCY = 3;
    const BATCH_DELAY_MS = 1000;

    for (let i = 0; i < curatedSymbols.length; i += CONCURRENCY) {
      const batch = curatedSymbols.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const { valid, issues } = await db.validateHistorical(symbol, 1);
          if (!valid && issues.length > 0) {
            // Find the earliest gap and repair that day
            const gapIssue = issues.find((iss) => iss.type === "GAP" || iss.type === "CORRUPT_OHLC");
            if (gapIssue) {
              const tradingDay = new Date(gapIssue.time || Date.now());
              // Skip today — an in-progress trading day always looks incomplete
              const todayStr = new Date().toISOString().slice(0, 10);
              if (tradingDay.toISOString().slice(0, 10) >= todayStr) {
                console.log(`[Recovery] ${symbol}: skipping today's in-progress candles (not a real gap)`);
                clean++;
                return;
              }

              // CIRCUIT BREAKER — fixes the infinite repeat-repair loop
              // (e.g. NSE:NIFTY50-INDEX getting "repaired" for the same
              // day on every single restart, forever). If this exact
              // symbol+day already had a successful repair logged
              // recently and the validator is STILL flagging it, the
              // broker's own data for that day is almost certainly
              // just genuinely short (thin closing volume, etc.) — not
              // something another refetch will fix. Skip it, log once,
              // and let it become eligible again after the cooldown
              // window in case the broker backfills better data later.
              const alreadyRepaired = await db.wasDayAlreadyRepaired(symbol, tradingDay, 3).catch(() => false);
              if (alreadyRepaired) {
                console.log(`[Recovery] ${symbol}: ${tradingDay.toISOString().slice(0, 10)} already repaired recently and still flagged — likely a genuine short broker day, skipping re-repair`);
                skippedKnown++;
                return;
              }

              console.log(`[Recovery] ${symbol}: ${issues.length} issue(s) — repairing gap at ${tradingDay.toISOString().slice(0, 10)}`);
              await recoveryEngine.repairDay({
                symbol,
                tradingDay,
                fetchCandles: (sym, res) => fetchCandles(sym, res),
                trigger,
              });
              repaired++;
            }
          } else {
            clean++;
            // Silent for clean symbols — only log summary at end
          }
        } catch (e) {
          console.warn(`[Recovery] ${symbol} scan error:`, e.message);
        }
      }));
      if (i + CONCURRENCY < curatedSymbols.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    console.log(`[Recovery] Catch-up (${trigger}) gap scan complete — ${clean} clean, ${repaired} repaired, ${skippedKnown} skipped (known short day) out of ${curatedSymbols.length} symbols`);

    // ── Proactive staleness sweep ──────────────────────────────────────
    // PROBLEM: ensureFreshOneMinData() only fires REACTIVELY — the moment
    // a client actually requests that exact symbol's chart. Nothing swept
    // the curated symbol list proactively, so a symbol nobody happened to
    // open yet could sit with a silent gap until someone finally loaded
    // its chart.
    // FIX 4: reuse the exact same ensureFreshOneMinData() logic (same
    // throttle map, same 3-min tolerance, same cheap 2-day delta fetch)
    // but drive it here for every curated symbol.
    //
    // GATING (2026-07-07, confirmed): removed the `if (!isTradingDay(symbol))
    // return;` early-out that used to sit here. Fetching history from Fyers
    // works the same whether today happens to be a trading day for this
    // symbol or not, so this sweep is no longer skipped on weekends/
    // holidays. The only gate left is the token-valid check that already
    // lives inside ensureFreshOneMinData() itself.
    console.log(`[Staleness] Catch-up (${trigger}) sweep: checking ${curatedSymbols.length} curated symbols for staleness...`);
    let staleFound = 0;
    // Concurrency=3 / 1200ms between batches to stay comfortably under
    // Fyers' rate limit across the whole sweep (a faster 5/500ms setting
    // was seen failing near the tail end of a 205-symbol list in
    // production with "request limit reached" errors).
    const SWEEP_CONCURRENCY = 3;
    for (let i = 0; i < curatedSymbols.length; i += SWEEP_CONCURRENCY) {
      const batch = curatedSymbols.slice(i, i + SWEEP_CONCURRENCY);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const latest = await db.getLatestCandle(symbol, 1);
          if (!latest) return; // symbol has no 1m data yet — nothing to check staleness against
          const before = latest.time;
          await ensureFreshOneMinData(symbol, [latest]);
          // ensureFreshOneMinData logs its own [Staleness] line when it
          // actually backfills something; we just tally here for the summary.
          const after = await db.getLatestCandle(symbol, 1).catch(() => null);
          if (after && after.time > before) staleFound++;
        } catch (e) {
          console.warn(`[Staleness] Catch-up sweep error for ${symbol}:`, e.message);
        }
      }));
      if (i + SWEEP_CONCURRENCY < curatedSymbols.length) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    console.log(`[Staleness] Catch-up (${trigger}) sweep complete — ${staleFound} symbol(s) backfilled`);
  } finally {
    _catchUpInFlight = false;
  }
}

async function loadFromDB(symbol, resolution) {
  if (!dbEnabled || !db) return null;
  try {
    let oneMinCandles;
    if (resolution === 1440 || resolution === 10080) {
      oneMinCandles = await db.loadCandles(symbol, 1, { limit: 100000 });
    } else {
      const windowMs = CHART_DB_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      oneMinCandles = await db.loadCandles(symbol, 1, {
        from: new Date(Date.now() - windowMs),
        to: new Date(),
        limit: 50000,
      });
    }

    if (!oneMinCandles || oneMinCandles.length === 0) return null;

    oneMinCandles = await ensureFreshOneMinData(symbol, oneMinCandles);

    const candles = resolution === 1 ? oneMinCandles : deriveTimeframe(oneMinCandles, resolution);
    if (!candles || candles.length === 0) return null;

    return { candles, oneMinCandles };
  } catch (err) {
    console.warn(`[DB-first] DB read failed for ${symbol} res=${resolution} (${err.message}) — falling back to Fyers`);
    return null;
  }
}

async function fetchAndProcess(symbol = SYMBOL || "NSE:NIFTY50-INDEX", resolution = RESOLUTION) {
  // ── 1. DB-first ──────────────────────────────────────────────────────────
  // CHANGED: previously this skipped the DB entirely for option contracts
  // (CE/PE) because "the DB will always be empty for them" — true when this
  // was written, no longer true now that options are routed into
  // nse_options_candles/mcx_options_candles (see database/src/dataRouter.js)
  // and backfilled from history. loadFromDB() already returns null when the
  // DB genuinely has nothing for a symbol (brand-new contract not yet
  // written), so it falls through to the Fyers path below exactly as
  // before for those — this just stops UNCONDITIONALLY bypassing the DB
  // for every option on every request.
  const dbHit = await loadFromDB(symbol, resolution);
  if (dbHit) {
    const { candles, oneMinCandles } = dbHit;
    console.log(`[DB-first] ${symbol} res=${resolution}m → ${candles.length} candles from DB`);

    // Seed the candle builder so the live tick stream has 1m continuity for
    // this symbol — same seedHistory() call the Fyers path always made.
    // Safe to call repeatedly: seedHistory() fully replaces _oneMinHistory.
    getOrCreateBuilder(symbol).seedHistory(oneMinCandles);

    const result = runSignalEngine(candles);
    setCache(symbol, resolution, candles, result);
    if (resolution !== 1) {
      try { setCache(symbol, 1, oneMinCandles, runSignalEngine(oneMinCandles)); } catch { }
    }
    return { candles, result };
  }

  // ── 2. Fyers fallback (DB disabled, empty, or read failed) ───────────────
  console.log(`[Fyers-fallback] ${symbol} res=${resolution}m — no DB data, fetching from Fyers`);
  // Option contracts (CE/PE) only exist for days/weeks — using the default
  // 30-day lookback causes Fyers to return empty chunks for dates before the
  // contract was listed. Use a 5-day lookback instead so every chunk is valid.
  const isOptionContract = isOptionSymbol(symbol);
  const raw1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH, isOptionContract ? 5 : null);

  if (candleBuilders.has(symbol)) {
    const existing = candleBuilders.get(symbol).getOneMinHistory();
    if (existing.length > 0 && raw1m.length > 0) {
      const ratio = existing[0].close > 0 ? Math.abs(raw1m[0].close - existing[0].close) / existing[0].close : 1;
      if (ratio > 0.5) { console.log(`[Server] Price scale mismatch for ${symbol} — resetting builder`); candleBuilders.delete(symbol); }
    }
  }

  const builder = getOrCreateBuilder(symbol);
  builder.seedHistory(raw1m);

  // ── DB: bulk-save REST 1m candles on every fetch ────────────────────────
  // This backfills the DB with historical 1m candles from Fyers REST so the
  // *next* fetchAndProcess() call for this symbol takes the DB-first path.
  // upsertCandles is idempotent (ON CONFLICT DO UPDATE) so re-fetching is safe.
  // ── DB: smart upsert ─ only write candles newer than what's already stored ──
  if (dbEnabled && raw1m.length > 0) {
    db.getLatestCandle(symbol, 1).then((latest) => {
      const newCandles = latest
        ? raw1m.filter((c) => c.time > latest.time)
        : raw1m;

      if (newCandles.length === 0) {
        console.log(`[DB] ${symbol} — no new candles to upsert (already up to date)`);
        return;
      }

      return db.upsertCandles(symbol, 1, newCandles).then((n) => {
        const since = latest ? new Date(latest.time).toISOString() : 'first time';
        console.log(`[DB] Upserted ${n} new 1m candles for ${symbol} (${since})`);
      });
    }).catch((err) => {
      // getLatestCandle failed — skip upsert entirely, do NOT dump all candles.
      // recoveryEngine will detect any gap on its next cycle and re-fetch
      // only the affected day via deleteDayCandles + upsert. repairLog will
      // record it. No blind fallback upsert here.
      console.warn(`[DB] getLatestCandle failed for ${symbol} (${err.message}) — skipping upsert, recoveryEngine will handle gap`);
    });
  }

  let candles;
  if (resolution === 1) { candles = raw1m; }
  else { candles = await fetchCandles(symbol, resolution, CANDLES_TO_FETCH); }

  const result = runSignalEngine(candles);
  setCache(symbol, resolution, candles, result);
  if (resolution !== 1) { try { setCache(symbol, 1, raw1m, runSignalEngine(raw1m)); } catch { } }
  return { candles, result };
}

// Broadcast to room but only to sockets watching this symbol
async function fetchAndBroadcast(symbol, resolution, isAutoRefresh = true) {
  const { candles, result } = await fetchAndProcess(symbol, resolution);
  const payload = buildPayload(candles, result, symbol, resolution, isAutoRefresh);
  const room = `res:${resolution}`;
  const roomSockets = io.sockets.adapter.rooms.get(room);
  if (roomSockets?.size) {
    for (const sid of roomSockets) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      if ((socketSymbols.get(sid) || SYMBOL || symbol) === symbol) sock.emit("chart_update", payload);
    }
  }
  console.log(`[BROADCAST] ${symbol} res=${resolution}m → ${candles.length} candles`);
  return { candles, result };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// Chart, auth, health, signals, motherwave → chartRouter (extracted)
app.use(createChartRouter({
  io, socketSymbols, socketResolutions,
  SYMBOL, RESOLUTION, TICK_WATCHDOG_MS,
  getCache, buildPayload, fetchAndProcess, fetchAndBroadcast,
  isLiveMarket, isTradingDay, isAnyMarketLive,
  tickStream, ticksFlowing, getActiveTickSymbols, updateTickSubscription, maybeStartTickStream,
  getAuthURL, generateToken, validateToken, bustTokenCache,
  detectMotherWaveForAPI,
  markBroadcastSymbol,
  // FIX 5 (re-auth hook): expose the same curated-symbol gap-fill/staleness
  // sweep that runs at boot so the /api/auth/token route can re-trigger it
  // the moment a token goes from invalid to valid again — see
  // runCuratedSymbolCatchUp() below (hoisted function declaration).
  runCuratedSymbolCatchUp,
}));

app.use("/api/symbols", symbolsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/backtest", backtestRouter);

// ─── Tick Watchdog ────────────────────────────────────────────────────────────
function startTickWatchdog() {
  setInterval(() => {
    if (!isTradingDay() || !isAnyMarketLive(getActiveTickSymbols()) || !tickStream.isConnected()) return;
    const now = Date.now();
    if (lastConnectAt > 0 && now - lastConnectAt < WATCHDOG_GRACE_MS) return;
    if (lastTickAt === 0) return;
    const silenceMs = now - lastTickAt;
    if (silenceMs > TICK_WATCHDOG_MS) {
      console.warn(`[Watchdog] No tick for ${(silenceMs / 1000).toFixed(1)}s — reconnecting WebSocket`);
      lastTickAt = 0; lastConnectAt = 0;
      // Immediately tell all clients ticks stopped — don't wait for broadcast timer
      io.emit("market_status", { ticksFlowing: false, tickStreamActive: false });
      tickStream.stop();
      // Restart with the FULL current symbol list (not just [SYMBOL])
      setTimeout(() => maybeStartTickStream(), 1000);
    }
  }, TICK_WATCHDOG_MS);
  console.log(`[Watchdog] Started (timeout: ${TICK_WATCHDOG_MS / 1000}s, grace: ${WATCHDOG_GRACE_MS / 1000}s)`);

  // ── Market-close detector ───────────────────────────────────────────────────
  // Checks every 60s whether the market has closed for ALL active symbols.
  // When isAnyMarketLive transitions true → false, stops the tick stream
  // immediately so Fyers doesn't keep sending post-close ticks that would
  // keep ticksFlowing=true after the exchange is closed.
  let wasAnyLive = isAnyMarketLive(getActiveTickSymbols());
  setInterval(() => {
    const nowLive = isAnyMarketLive(getActiveTickSymbols());
    if (wasAnyLive && !nowLive) {
      // Market just closed — stop stream, clear tick timestamps, notify clients
      console.log("[Watchdog] Market closed — stopping tick stream and clearing tick state.");
      lastTickAt = 0;
      lastConnectAt = 0;
      // Clear all per-symbol tick timestamps so ticksFlowing() returns false
      lastTickBySymbol.clear();
      tickStream.stop();
      io.emit("market_status", { ticksFlowing: false, tickStreamActive: false });
    }
    wasAnyLive = nowLive;
  }, 60_000); // check every 60s — market close is a once-per-day event

  // Periodic status broadcast — interval is half the watchdog so clients
  // learn ticksFlowing changes promptly without hammering the socket.
  const STATUS_BROADCAST_MS = Math.max(10_000, Math.floor(TICK_WATCHDOG_MS / 2));
  setInterval(() => {
    io.emit("market_status", { ticksFlowing: ticksFlowing(), tickStreamActive: tickStream.isConnected() });
  }, STATUS_BROADCAST_MS);
  console.log(`[Watchdog] Status broadcast every ${STATUS_BROADCAST_MS / 1000}s`);
}

// ─── Auto-refresh fallback ────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    if (!isTradingDay() || !isAnyMarketLive(getActiveTickSymbols()) || tickStream.isConnected()) return;
    const valid = await validateToken();
    if (!valid) return;

    // Collect ALL unique (symbol, resolution) pairs across all connected sockets
    // — not just the default SYMBOL. Every panel gets refreshed.
    const pairs = new Map();
    for (const [sid, sym] of socketSymbols) {
      const res = socketResolutions.get(sid) || RESOLUTION;
      const key = `${sym}:${res}`;
      if (!pairs.has(key)) pairs.set(key, { symbol: sym, resolution: res });
    }
    // Always include default (only if a default SYMBOL is configured)
    if (SYMBOL) {
      const dk = `${SYMBOL}:${RESOLUTION}`;
      if (!pairs.has(dk)) pairs.set(dk, { symbol: SYMBOL, resolution: RESOLUTION });
    }

    // Stagger refreshes 600ms apart — prevents Fyers rate storm (Issue #2 fix)
    const pairList = Array.from(pairs.values());
    for (let i = 0; i < pairList.length; i++) {
      const { symbol, resolution } = pairList[i];
      if (i > 0) await new Promise(r => setTimeout(r, 600));
      console.log(`[AUTO] Refreshing ${symbol} res=${resolution}m... (${i + 1}/${pairList.length})`);
      fetchAndBroadcast(symbol, resolution, true).catch((e) => console.error(`[AUTO] Error ${symbol} res=${resolution}:`, e.message));
    }
  }, REFRESH_MS);
  console.log(`[AUTO] Refresh every ${REFRESH_MS / 1000}s (live market + tick stream down only)`);
}

// ─── Initial REST fetch ───────────────────────────────────────────────────────
// Pre-warms the in-process cache for every resolution on startup.
// NO token check here — fetchAndProcess() handles DB-first internally.
// If DB has data → loads instantly without any Fyers call.
// If DB is empty AND token is invalid → Fyers fallback fails gracefully per-res.
// Either way the site is never fully blocked by an expired token.
async function initialRestFetch() {
  if (!SYMBOL) {
    console.log("[INIT] No default SYMBOL set — skipping pre-warm. Charts load on first client request.");
    return;
  }
  const dayLabel = isTradingDay() ? (isAnyMarketLive(getActiveTickSymbols()) ? "live market" : "weekday (market closed)") : "weekend/holiday";
  console.log(`[INIT] Pre-warming all resolutions for ${SYMBOL} (${dayLabel})...`);

  const ALL_RESOLUTIONS = [1, 3, 5, 15, 60, 1440, 10080];

  for (const res of ALL_RESOLUTIONS) {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try { await fetchAndProcess(SYMBOL, res); console.log(`[INIT] res=${res} ✓`); break; }
      catch (err) {
        console.error(`[INIT] res=${res} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  try {
    const cache = getCache(SYMBOL, RESOLUTION);
    if (cache.result && cache.candles.length > 0) io.emit("chart_update", buildPayload(cache.candles, cache.result, SYMBOL, RESOLUTION, false));
  } catch { }
  console.log("[INIT] All resolutions loaded ✓  Chart is ready.");
}

// ─── Socket.IO connections ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  let currentResolution = RESOLUTION;
  let currentSymbol = SYMBOL;  // null if not set — client sends set_symbol on connect
  socketResolutions.set(socket.id, currentResolution);
  if (currentSymbol) socketSymbols.set(socket.id, currentSymbol);
  socket.join(`res:${currentResolution}`);

  // RACE-CONDITION FIX: previously this pushed the *default* SYMBOL's cached
  // chart_update to every socket immediately on raw connect, before the
  // client had a chance to say which symbol it actually wants. If that push
  // landed before the client's own activeSymbolRef was set (a real timing
  // race, not hypothetical — confirmed via code trace), the frontend's
  // matchesActive() guard would accept it (nothing to compare against yet),
  // stomping the chart with the wrong symbol's data and price/date — and
  // could then keep rejecting the *correct* update afterward since the ref
  // was now stuck on the wrong symbol. Fix: don't push anything until the
  // client tells us (via set_symbol) which symbol it's actually watching —
  // see the cache push inside the set_symbol handler below instead.
  socket.emit("market_status", { tickStreamActive: tickStream.isConnected(), liveMarket: isAnyMarketLive(getActiveTickSymbols()), tradingDay: isTradingDay(), ticksFlowing: ticksFlowing() });

  // TICK-STREAM + DUAL-PANEL FIX:
  // Track each socket's active symbol. On change, call updateTickSubscription()
  // so the Fyers WebSocket subscription expands to include the new symbol.
  // This is what makes HAVELLS/RELIANCE/any stock get live ticks, not just NIFTY.
  socket.on("set_symbol", (sym) => {
    if (!sym) return;
    const prev = currentSymbol;
    currentSymbol = sym;
    socketSymbols.set(socket.id, sym);
    console.log(`[WS] ${socket.id} → symbol=${sym}`);
    // Fast-path: if we already have fresh cached data for THIS symbol (the
    // one the client just confirmed), push it immediately instead of making
    // the client wait for its own REST refresh() call to land. Safe because
    // it's keyed to the symbol the client just told us it wants — no race.
    const initialCache = getCache(currentSymbol, currentResolution);
    if (initialCache.result && initialCache.candles.length > 0) {
      socket.emit("chart_update", buildPayload(initialCache.candles, initialCache.result, currentSymbol, currentResolution, true));
    }
    if (isLiveMarket(sym) && sym !== prev) {
      updateTickSubscription().catch(console.error);
    }
  });

  socket.on("set_resolution", (res) => {
    const newRes = parseInt(res);
    if (isNaN(newRes) || newRes === currentResolution) return;
    socket.leave(`res:${currentResolution}`);
    currentResolution = newRes;
    socketResolutions.set(socket.id, newRes);
    socket.join(`res:${newRes}`);
    console.log(`[WS] ${socket.id} → res=${newRes}`);
    const newCache = getCache(currentSymbol, newRes);
    if (newCache.result && newCache.candles.length > 0 && Date.now() - newCache.lastFetch < 120_000) {
      socket.emit("chart_update", buildPayload(newCache.candles, newCache.result, currentSymbol, newRes, true));
    }
  });

  // AUTO-ATM: register/clear this socket's underlying LTP side-channel.
  // Frontend calls this with the OPTION symbol currently on the panel when
  // the user has switched "Auto ATM" on; the server derives the underlying
  // itself (single source of truth for the option→underlying mapping) and
  // subscribes the tick stream to it. Calling with null/undefined stops the
  // feed (toggle off, symbol changed away from an option, panel unmounted).
  socket.on("set_underlying", (optionSym) => {
    const underlyingSym = deriveUnderlyingSymbol(optionSym);
    if (!underlyingSym) {
      if (socketUnderlyings.delete(socket.id)) {
        updateTickSubscription().catch(console.error);
      }
      return;
    }
    if (socketUnderlyings.get(socket.id) === underlyingSym) return;
    socketUnderlyings.set(socket.id, underlyingSym);
    console.log(`[WS] ${socket.id} → underlying=${underlyingSym} (Auto-ATM, from ${optionSym})`);
    if (isLiveMarket(underlyingSym)) {
      updateTickSubscription().catch(console.error);
    }
  });

  socket.on("request_refresh", () => {
    // No token check — fetchAndProcess() is DB-first, works without Fyers token.
    // If DB has data → instant. If DB empty + token dead → error emitted below.
    // FIX: error now carries the symbol/resolution it actually failed for, so
    // the frontend can filter it through the same matchesActive() check every
    // other socket event already uses — without this, a failed background
    // fetch for an unrelated symbol/resolution (e.g. an Auto-ATM underlying
    // res=1 seed) was bleeding through and overwriting whatever chart was
    // actually on screen, even though that chart's own data was fine.
    const failedSymbol = currentSymbol;
    const failedResolution = currentResolution;
    fetchAndProcess(currentSymbol, currentResolution)
      .then(({ candles, result }) => socket.emit("chart_update", buildPayload(candles, result, currentSymbol, currentResolution, false)))
      .catch((e) => socket.emit("error", { message: e.message, symbol: failedSymbol, resolution: failedResolution }));
  });

  socket.on("disconnect", () => {
    socketResolutions.delete(socket.id);
    socketSymbols.delete(socket.id);
    socketUnderlyings.delete(socket.id);
    console.log(`[WS] Client disconnected: ${socket.id}`);
    // Possibly trim unused symbols from tick subscription
    if (isAnyMarketLive(getActiveTickSymbols())) updateTickSubscription().catch(console.error);
  });
});

// ─── Serve React Frontend ─────────────────────────────────────────────────────
const FRONTEND_BUILD = path.join(__dirname, "../../frontend/build");
app.use(express.static(FRONTEND_BUILD));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
  res.sendFile(path.join(FRONTEND_BUILD, "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "5280");
server.listen(PORT, async () => {
  console.log(`\n✅ TGG Backend running on http://localhost:${PORT}`);
  console.log(`   Health     : http://localhost:${PORT}/health`);
  console.log(`   Chart      : http://localhost:${PORT}/api/chart`);
  console.log(`   Motherwave : http://localhost:${PORT}/api/motherwave`);
  console.log(`   Auth       : http://localhost:${PORT}/api/auth/status`);
  console.log(`   Symbols    : http://localhost:${PORT}/api/symbols`);
  console.log(`   Scanner    : http://localhost:${PORT}/api/scanner/signals\n`);
  startAutoRefresh();
  startTickWatchdog();

  // ── DB: connect, health-check ────────────────────────────────────────────
  if (dbEnabled) {
    try {
      const ok = await db.healthCheck();
      if (ok) {
        console.log("[DB] ✅  PostgreSQL connection healthy");

        // ── PRUNING DISABLED (2026-07-03) ──────────────────────────────────
        // Both pruneOldCandles() and pruneExpiredContracts() hard-DELETE rows
        // from `candles` with no archive anywhere else — every expired
        // option/future contract they touch is gone permanently, which
        // breaks backtesting (confirmed: they had already deleted 3 SENSEX
        // option contracts / 3420 candles by the time this was caught).
        // Turned off site-wide until the separate backtest archive
        // (derivatives_eod / underlying_eod, permanent, typed columns) is
        // built and populated — only then is it safe to prune this live
        // cache again, since the archive would hold the permanent copy.
        // See database/src/candleStore.js for the (still intact, just
        // unused) implementations of both functions.
        //
        // const pruned = await db.pruneOldCandles(null, 1, 365);
        // if (pruned > 0) console.log(`[DB] Pruned ${pruned} old candles (>365 days)`);
        //
        // const expiredResult = await db.pruneExpiredContracts();
        // if (expiredResult.symbolsPruned > 0) {
        //   console.log(`[DB] Pruned ${expiredResult.symbolsPruned} expired contract(s), ${expiredResult.candlesDeleted} candles: ${expiredResult.symbols.slice(0, 10).join(", ")}${expiredResult.symbols.length > 10 ? ", ..." : ""}`);
        // }
        // setInterval(async () => {
        //   try {
        //     const r = await db.pruneExpiredContracts();
        //     if (r.symbolsPruned > 0) {
        //       console.log(`[DB] Periodic sweep: pruned ${r.symbolsPruned} expired contract(s), ${r.candlesDeleted} candles`);
        //     }
        //   } catch (e) {
        //     console.warn("[DB] Periodic expired-contract prune failed:", e.message);
        //   }
        // }, 6 * 60 * 60 * 1000); // every 6 hours


        // ── Wire up recovery engine WebSocket emitter ──────────────────────
        if (recoveryEngine) {
          recoveryEngine.injectStatusEmitter((event, data) => io.emit(event, data));
          console.log("[Recovery] Status emitter connected to WebSocket");
        }

        // ── Periodic broker-drift sync (was dead code — never called) ──────
        // recoveryEngine.periodicSync() was fully implemented (compares DB's
        // latest 1m candle vs the broker's, upserts any gap, or falls back
        // to a full day repair) but nothing anywhere ever called it — grepped
        // the entire backend/src and found zero callers. Wiring it here,
        // scoped to only the symbols someone actually has open right now
        // (getLiveBroadcastSymbols(), same TTL-expiring set used for tick
        // subscriptions) so this can't turn into a 205-symbol Fyers-hammering
        // loop — it only ever checks charts a real client is looking at.
        //
        // NOTE: NOT touched by the "no day-type gating" change — this loop's
        // own isTradingDay()/isLiveMarket() gates were not part of the
        // confirmed scope (ensureFreshOneMinData + runCuratedSymbolCatchUp
        // staleness sweep only). Say the word if you want the same
        // token-only rule applied to periodicSync too.
        if (recoveryEngine) {
          setInterval(async () => {
            try {
              if (!isTradingDay()) return;
              const activeSymbols = getLiveBroadcastSymbols();
              if (activeSymbols.length === 0) return;
              for (const symbol of activeSymbols) {
                if (!isLiveMarket(symbol)) continue;
                await recoveryEngine.periodicSync({
                  symbol,
                  fetchCandles: (sym, res) => fetchCandles(sym, res),
                });
              }
            } catch (e) {
              console.warn("[PeriodicSync] Sweep error:", e.message);
            }
          }, 5 * 60 * 1000); // every 5 minutes
          console.log("[PeriodicSync] Wired — checking actively-viewed symbols every 5 minutes during market hours");
        }

        // ── Curated-symbol gap scan + staleness sweep ──────────────────────
        // See runCuratedSymbolCatchUp() (hoisted function declaration,
        // defined further down this file) for the full implementation.
        // Fires once now at boot; the /api/auth/token route also calls it
        // again after a successful re-auth (fix 5 — see chartRouter.js).
        setImmediate(() => runCuratedSymbolCatchUp("startup"));

      } else {
        console.warn("[DB] ⚠️  PostgreSQL health check failed — DB writes disabled");
        dbEnabled = false;
      }
    } catch (err) {
      console.warn("[DB] ⚠️  PostgreSQL startup error — DB writes disabled:", err.message);
      dbEnabled = false;
    }
  }

  await initialRestFetch();

  // ─── Scanner + Backtest symbol loading ──────────────────────────────────────
  setImmediate(() => {
    const path = require("path");
    const fs = require("fs");
    const FRONTEND_SRC = path.resolve(__dirname, "../../frontend/src");

    function loadScanSymbols() {
      const symbols = new Set();

      // symbols.json
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(FRONTEND_SRC, "symbols.json"), "utf8"));
        arr.forEach((s) => s.symbol && symbols.add(s.symbol.trim()));
      } catch { }

      // mcx.json
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(FRONTEND_SRC, "mcx.json"), "utf8"));
        arr.forEach((s) => s.symbol && symbols.add(s.symbol.trim()));
      } catch { }

      // stocks.xlsx and NIFTY.xlsx via xlsx
      for (const xlFile of ["stocks.xlsx", "NIFTY.xlsx"]) {
        try {
          const XLSX = require("xlsx");
          const wb = XLSX.readFile(path.join(FRONTEND_SRC, xlFile));
          const ws = wb.Sheets[wb.SheetNames[0]];
          XLSX.utils.sheet_to_json(ws).forEach((r) => r.symbol && symbols.add(String(r.symbol).trim()));
        } catch { }
      }

      return [...symbols];
    }

    const allSymbols = loadScanSymbols();
    console.log(`[Scanner] Loaded ${allSymbols.length} symbols for scanning`);
    scanner.setSymbols(allSymbols);
    backtestRunner.setSymbols(allSymbols);

    // Forward scanner events to all connected clients via Socket.IO
    scanner.on("scan_start", (data) => io.emit("scanner_start", data));
    scanner.on("scan_progress", (data) => io.emit("scanner_progress", data));
    scanner.on("scan_complete", (data) => io.emit("scanner_complete", data));
    scanner.on("signal_found", (data) => io.emit("scanner_signal", data));
    scanner.on("signal_partial", (data) => io.emit("scanner_partial", data));

    // Forward backtest events
    backtestRunner.on("backtest_start", (data) => io.emit("backtest_start", data));
    backtestRunner.on("backtest_progress", (data) => io.emit("backtest_progress", data));
    backtestRunner.on("backtest_complete", (data) => io.emit("backtest_complete", data));
    backtestRunner.on("backtest_hit", (data) => io.emit("backtest_hit", data));

    // No auto-start — scan is triggered manually from the UI or POST /api/scanner/trigger
  });

  if (isAnyMarketLive(getActiveTickSymbols())) { console.log("[INIT] Market is live — starting tick stream for real-time candles."); await maybeStartTickStream(); }
  else if (isTradingDay()) { console.log("[INIT] Weekday outside market hours — REST data ready. Tick stream inactive."); }
  else { console.log("[INIT] Weekend/holiday — REST data loaded from last session. No tick stream."); }
});

module.exports = { app, server };