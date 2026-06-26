require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { runSignalEngine } = require("./services/signalEngine");
const { getAuthURL, generateToken, fetchCandles, validateToken, loadToken } = require("./fyers/client");
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
try {
  db = require("../../database/src/index");
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
const SYMBOL = process.env.SYMBOL || "NSE:NIFTY50-INDEX";
const RESOLUTION = parseInt(process.env.CANDLE_RESOLUTION || "3");
// CANDLES_TO_FETCH: passed to fetchCandles() as the `count` parameter but
// fetchCandles() currently ignores it — Fyers data is fetched by date-range
// windows (calcLookbackDays) not by count. This env var is kept for future use
// if a count-based slice is added. The actual depth is controlled by
// calcLookbackDays() in fyers/client.js (30d for 3m, 60d for 15m, 150d for 1h).
const CANDLES_TO_FETCH = parseInt(process.env.CANDLES_TO_FETCH || "10000");
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
              if ((socketSymbols.get(sid) || SYMBOL) === symbol) sock.emit("chart_update", payload);
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
      if ((socketSymbols.get(sid) || SYMBOL) === symbol) {
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
      if ((socketSymbols.get(sid) || SYMBOL) === symbol) {
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
  // registered this exact symbol as its underlying via set_underlying. This
  // is a pure passthrough — no candle building, no cache writes — it only
  // exists to drive the frontend's strike auto-switch decision.
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
 * underlying index/equity symbol so the tick stream can be subscribed to it
 * too. Mirrors frontend/src/utils/optionsChain.js getOptionRoot() — MUST be
 * kept in sync with that file's NSE_INDEX_ROOTS table.
 *
 *   "BSE:SENSEX2570077000CE"     → "BSE:SENSEX-INDEX"
 *   "NSE:NIFTY2570724000PE"      → "NSE:NIFTY50-INDEX"
 *   "NSE:RELIANCE26JUL3200CE"    → "NSE:RELIANCE-EQ"
 *   "MCX:CRUDEOIL26JUL5000CE"    → null (commodity options not supported here
 *                                   — futures contract is the underlying, not
 *                                   an index/equity LTP; Auto-ATM is index/equity-only)
 *
 * Returns null if `sym` is not an option symbol or has no known underlying.
 */
// Matches BOTH Fyers expiry encodings — see frontend/src/utils/optionsChain.js
// OPTION_SYMBOL_RE for the full rationale (kept in sync with that regex):
//   Monthly: YY + 3-letter month                  e.g. "26JUL"
//   Weekly:  YY + 1-char month (1-9/O/N/D) + DD    e.g. "26702" (02 Jul 2026)
const OPTION_SUFFIX_RE = /^(.*?)(\d{2}(?:[A-Z]{3}|[1-9OND]\d{2}))(\d+(?:\.\d+)?)(CE|PE)$/;
const INDEX_ROOT_TO_SYMBOL = {
  NIFTY:      "NSE:NIFTY50-INDEX",
  BANKNIFTY:  "NSE:NIFTYBANK-INDEX",
  FINNIFTY:   "NSE:CNXFINANCE-INDEX",
  NIFTYIT:    "NSE:CNXIT-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  SENSEX:     "BSE:SENSEX-INDEX",
};
function deriveUnderlyingSymbol(sym) {
  if (!sym) return null;
  const colonIdx = sym.indexOf(":");
  if (colonIdx < 0) return null;
  const exch = sym.slice(0, colonIdx);
  const ticker = sym.slice(colonIdx + 1);
  if (exch === "MCX") return null; // commodity options — not supported by Auto-ATM

  const m = OPTION_SUFFIX_RE.exec(ticker);
  if (!m) return null; // not an option symbol
  const root = m[1];

  if (INDEX_ROOT_TO_SYMBOL[root]) return INDEX_ROOT_TO_SYMBOL[root];
  // Equity option → underlying is the cash-market equity
  return `NSE:${root}-EQ`;
}

/**
 * getActiveTickSymbols — returns every symbol currently watched by any connected
 * socket, plus the default SYMBOL, plus any Auto-ATM underlying symbols any
 * socket has registered via set_underlying. This is the list Fyers WebSocket
 * subscribes to.
 */
function getActiveTickSymbols() {
  const set = new Set([SYMBOL]);
  for (const sym of socketSymbols.values()) { if (sym) set.add(sym); }
  for (const sym of socketUnderlyings.values()) { if (sym) set.add(sym); }
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
    lastUpdate: new Date().toISOString(), balance: parseFloat(process.env.CURRENT_BALANCE || 0), isAutoRefresh,
  };
}

// ─── Core fetch & process ─────────────────────────────────────────────────────
// ─── Cache TTL constants ─────────────────────────────────────────────────────
// During live market: always re-derive from builder (ticks keep it live).
// After close / holiday / weekend: cache is final — never re-fetch.
// A fresh cache = populated within the last CACHE_STALE_MS.
const CACHE_STALE_MS = 5 * 60 * 1000; // 5 minutes (only matters during live market)

function isCacheFresh(symbol, resolution) {
  const c = getCache(symbol, resolution);
  return c.candles.length > 0 && c.result != null && (Date.now() - c.lastFetch) < CACHE_STALE_MS;
}

async function fetchAndProcess(symbol = SYMBOL, resolution = RESOLUTION) {
  // ── Fast path: serve from in-memory cache ───────────────────────────────────
  // When market is closed (after hours, weekend, holiday) the data is final.
  // Never re-read DB or call Fyers — just return what's already in memory.
  // During live market we skip this only if the cache is genuinely stale.
  if (!isLiveMarket(symbol) && isCacheFresh(symbol, resolution)) {
    const c = getCache(symbol, resolution);
    return { candles: c.candles, result: c.result };
  }

  // ── Load 1m base data ────────────────────────────────────────────────────────
  // If the builder for this symbol already has 1m history (seeded earlier this
  // boot), skip the DB read — the builder is the in-memory source of truth.
  // Only read DB when the builder is cold (first time this symbol is seen).
  let raw1m = [];
  const builderAlreadySeeded = candleBuilders.has(symbol) &&
    candleBuilders.get(symbol).getOneMinHistory().length > 0;

  if (builderAlreadySeeded) {
    raw1m = candleBuilders.get(symbol).getOneMinHistory();
  } else {
    // Builder is cold — load from DB first, fall back to Fyers REST if empty.
    if (dbEnabled) {
      try {
        const from = new Date(Date.now() - 30 * 86400 * 1000);
        const dbCandles = await db.loadCandles(symbol, 1, { from, limit: 100000 });
        if (dbCandles.length > 0) {
          raw1m = dbCandles;
          console.log(`[DB] Loaded ${raw1m.length} 1m candles for ${symbol} from DB`);
        }
      } catch (err) {
        console.warn(`[DB] loadCandles failed for ${symbol} — falling back to Fyers REST:`, err.message);
      }
    }

    if (raw1m.length === 0) {
      console.log(`[Server] DB empty for ${symbol} — fetching 1m from Fyers REST (initial seed)`);
      raw1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH);
      if (dbEnabled && raw1m.length > 0) {
        db.upsertCandles(symbol, 1, raw1m).then((n) => {
          console.log(`[DB] Initial seed: upserted ${n} 1m candles for ${symbol}`);
        }).catch((err) => {
          console.error(`[DB] Initial seed upsert failed for ${symbol}:`, err.message);
        });
      }
    }

    // Seed the builder once — all future calls for this symbol reuse it.
    const builder = getOrCreateBuilder(symbol);
    builder.seedHistory(raw1m);
  }

  // ── Derive requested resolution from in-memory 1m ───────────────────────────
  // 1m, 3m, 5m, 15m, 60m — all derived from builder (never a separate Fyers call).
  // Daily (1440) and weekly (10080) are too long to derive from 30d of 1m data,
  // so they still call Fyers REST — but only if cache is stale/missing.
  let candles;
  const builder = getOrCreateBuilder(symbol);

  if (resolution === 1) {
    candles = raw1m.length > 0 ? raw1m : builder.getOneMinHistory();
  } else if (resolution === 1440 || resolution === 10080) {
    const cached = getCache(symbol, resolution);
    if (cached.candles.length > 0) {
      // Daily/weekly: already cached — return without another Fyers call
      return { candles: cached.candles, result: cached.result };
    }
    candles = await fetchCandles(symbol, resolution, CANDLES_TO_FETCH);
  } else {
    candles = builder.getCandlesForResolution(resolution);
  }

  const result = runSignalEngine(candles);
  setCache(symbol, resolution, candles, result);
  // Keep res=1 cache populated so isCacheFresh(sym, 1) works
  if (resolution !== 1 && raw1m.length > 0) {
    try { setCache(symbol, 1, raw1m, runSignalEngine(raw1m)); } catch { }
  }
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
      if ((socketSymbols.get(sid) || SYMBOL) === symbol) sock.emit("chart_update", payload);
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
  getAuthURL, generateToken, validateToken,
  detectMotherWaveForAPI,
  db, dbEnabled, fetchCandles,
}));

app.use("/api/symbols", symbolsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/backtest", backtestRouter);

// ─── Tick Watchdog ────────────────────────────────────────────────────────────
function startTickWatchdog() {
  setInterval(() => {
    // Skip entirely if market is closed — no ticks expected, no need to reconnect
    if (!isTradingDay() || !isAnyMarketLive(getActiveTickSymbols())) return;
    if (!tickStream.isConnected()) return;
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
    // Always include default
    const dk = `${SYMBOL}:${RESOLUTION}`;
    if (!pairs.has(dk)) pairs.set(dk, { symbol: SYMBOL, resolution: RESOLUTION });

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
async function initialRestFetch() {
  const valid = await validateToken().catch(() => false);
  if (!valid) { console.log("[INIT] Not authenticated — skipping initial fetch. Chart will be empty."); return; }

  const dayLabel = isTradingDay()
    ? (isAnyMarketLive(getActiveTickSymbols()) ? "live market" : "weekday (market closed)")
    : "weekend/holiday";
  console.log(`[INIT] Booting for ${SYMBOL} (${dayLabel})...`);

  // ── Step 1: Load 1m ONCE from DB (or Fyers if DB empty) ─────────────────
  // All intraday TFs (1/3/5/15/60m) are derived from this single load.
  // Daily and weekly still need separate Fyers REST calls (can't derive from 30d of 1m).
  let raw1m = [];

  if (dbEnabled) {
    try {
      const from = new Date(Date.now() - 30 * 86400 * 1000);
      const dbCandles = await db.loadCandles(SYMBOL, 1, { from, limit: 100000 });
      if (dbCandles.length > 0) {
        raw1m = dbCandles;
        console.log(`[DB] Loaded ${raw1m.length} 1m candles for ${SYMBOL} from DB`);
      }
    } catch (err) {
      console.warn(`[DB] loadCandles failed — falling back to Fyers REST:`, err.message);
    }
  }

  if (raw1m.length === 0) {
    console.log(`[INIT] DB empty — fetching 1m from Fyers REST (initial seed)`);
    try {
      raw1m = await fetchCandles(SYMBOL, 1, CANDLES_TO_FETCH);
      if (dbEnabled && raw1m.length > 0) {
        db.upsertCandles(SYMBOL, 1, raw1m).then((n) => {
          console.log(`[DB] Initial seed: upserted ${n} 1m candles for ${SYMBOL}`);
        }).catch((err) => console.error(`[DB] Initial seed failed:`, err.message));
      }
    } catch (err) {
      console.error(`[INIT] Fyers 1m fetch failed: ${err.message}`);
    }
  }

  if (raw1m.length === 0) {
    console.error("[INIT] No 1m candle data available — chart will be empty.");
    return;
  }

  // ── Step 2: Seed builder ONCE ─────────────────────────────────────────────
  const builder = getOrCreateBuilder(SYMBOL);
  builder.seedHistory(raw1m);
  console.log(`[INIT] Builder seeded with ${raw1m.length} 1m candles ✓`);

  // ── Step 3: Derive all intraday TFs in one pass (no more Fyers calls) ─────
  for (const res of [1, 3, 5, 15, 60]) {
    try {
      const candles = res === 1 ? raw1m : builder.getCandlesForResolution(res);
      const result = runSignalEngine(candles);
      setCache(SYMBOL, res, candles, result);
      console.log(`[INIT] res=${res} ✓ (${candles.length} candles, derived from 1m)`);
    } catch (err) {
      console.error(`[INIT] res=${res} derive failed: ${err.message}`);
    }
  }

  // ── Step 4: Daily and weekly — Fyers REST (separate lookback needed) ──────
  for (const res of [1440, 10080]) {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const candles = await fetchCandles(SYMBOL, res, CANDLES_TO_FETCH);
        const result = runSignalEngine(candles);
        setCache(SYMBOL, res, candles, result);
        console.log(`[INIT] res=${res} ✓ (${candles.length} candles, Fyers REST)`);
        break;
      } catch (err) {
        console.error(`[INIT] res=${res} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  // ── Step 5: Push initial chart_update to any already-connected sockets ────
  try {
    const cache = getCache(SYMBOL, RESOLUTION);
    if (cache.result && cache.candles.length > 0) {
      io.emit("chart_update", buildPayload(cache.candles, cache.result, SYMBOL, RESOLUTION, false));
    }
  } catch { }

  console.log("[INIT] All resolutions loaded ✓  Chart is ready.");
}

// ─── Socket.IO connections ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  let currentResolution = RESOLUTION;
  let currentSymbol = SYMBOL;
  socketResolutions.set(socket.id, currentResolution);
  socketSymbols.set(socket.id, currentSymbol);
  socket.join(`res:${currentResolution}`);

  const initialCache = getCache(SYMBOL, currentResolution);
  if (initialCache.result && initialCache.candles.length > 0) {
    socket.emit("chart_update", buildPayload(initialCache.candles, initialCache.result, SYMBOL, currentResolution, true));
  }
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
  // Does NOT affect socketSymbols/the main chart subscription — purely an
  // additional tick-stream symbol.
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

  socket.on("request_refresh", async () => {
    const valid = await validateToken();
    if (!valid) { socket.emit("error", { message: "Not authenticated. Please set up Fyers token." }); return; }
    fetchAndProcess(currentSymbol, currentResolution)
      .then(({ candles, result }) => socket.emit("chart_update", buildPayload(candles, result, currentSymbol, currentResolution, false)))
      .catch((e) => socket.emit("error", { message: e.message }));
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
const PORT = parseInt(process.env.PORT || "9004");
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

  // ── DB: connect, health-check, prune old candles ────────────────────────
  if (dbEnabled) {
    try {
      const ok = await db.healthCheck();
      if (ok) {
        console.log("[DB] ✅  PostgreSQL connection healthy");

        // Inject Socket.IO emitter so repair_status events reach the frontend
        db.injectStatusEmitter((event, data) => io.emit(event, data));
        console.log("[DB] Status emitter injected → repair_status events active");

        // Prune candles older than 90 days on startup
        const pruned = await db.pruneOldCandles(null, 1, 90);
        if (pruned > 0) console.log(`[DB] Pruned ${pruned} old candles (>90 days)`);
      } else {
        console.warn("[DB] ⚠️  PostgreSQL health check failed — DB writes disabled");
        dbEnabled = false;
      }
    } catch (err) {
      console.warn("[DB] ⚠️  PostgreSQL startup error — DB writes disabled:", err.message);
      dbEnabled = false;
    }
  }

  // ── DB: periodic sync loop (every 2 min during live market) ─────────────
  // Compares latest DB 1m candle vs latest broker candle and fills any gaps.
  // This is the only place Fyers REST is called during live market for sync —
  // fetchAndProcess itself reads from DB and does NOT call Fyers on repeat.
  if (dbEnabled) {
    const PERIODIC_SYNC_MS = 2 * 60 * 1000; // 2 minutes
    setInterval(async () => {
      if (!isTradingDay() || !isAnyMarketLive(getActiveTickSymbols())) return;
      const symbols = [...new Set([SYMBOL, ...socketSymbols.values()])].filter(Boolean);
      for (const sym of symbols) {
        try {
          await db.periodicSync({ symbol: sym, fetchCandles });
        } catch (err) {
          console.error(`[PeriodicSync] Error for ${sym}:`, err.message);
        }
      }
    }, PERIODIC_SYNC_MS);
    console.log("[DB] Periodic sync started (every 2 min, live market only)");
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