require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { runSignalEngine } = require("./signalEngine");
const { getAuthURL, generateToken, fetchCandles, validateToken, loadToken } = require("./fyers");
const { CandleBuilder, deriveTimeframe } = require("./candleBuilder");
const { TickStream, isMarketOpen, isLiveMarket, isTradingDay } = require("./tickStream");
const symbolsRouter = require("./symbolsRouter");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(express.json()); // parse JSON body — needed for req.body.socketId in /refresh
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const ip = req.ip || "";
      return (
        ip === "127.0.0.1" ||
        ip === "::1" ||
        ip.startsWith("::ffff:127.") ||
        ip.startsWith("::ffff:192.168.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("10.") ||
        ip.startsWith("172.")
      );
    },
  })
);

// ─── Config ───────────────────────────────────────────────────────────────────
const SYMBOL = process.env.SYMBOL || "NSE:NIFTY50-INDEX";
const RESOLUTION = parseInt(process.env.CANDLE_RESOLUTION || "3");
const CANDLES_TO_FETCH = parseInt(process.env.CANDLES_TO_FETCH || "10000");
const REFRESH_MS = parseInt(process.env.SCHEDULE_INTERVAL_MS || "5000");
const TICK_WATCHDOG_MS = parseInt(process.env.TICK_WATCHDOG_MS || "10000");
const WATCHDOG_GRACE_MS = parseInt(process.env.WATCHDOG_GRACE_MS || "30000");

// ─── State ────────────────────────────────────────────────────────────────────
const symbolCacheMap = new Map();  // "SYMBOL:resolution" → { candles, result, lastFetch }
let autoRefreshTimer = null;
const socketResolutions = new Map(); // socket.id → resolution
const socketSymbols = new Map();     // socket.id → symbol (dual-panel per-socket filtering)
let lastTickAt = 0;
let lastConnectAt = 0;

// ─── Cache helpers ────────────────────────────────────────────────────────────
function cacheKey(symbol, resolution) { return `${symbol}:${resolution}`; }

function getCache(symbol, resolution) {
  const k = cacheKey(symbol, resolution);
  if (!symbolCacheMap.has(k)) symbolCacheMap.set(k, { candles: [], result: null, lastFetch: 0 });
  return symbolCacheMap.get(k);
}

function setCache(symbol, resolution, candles, result) {
  symbolCacheMap.set(cacheKey(symbol, resolution), { candles, result, lastFetch: Date.now() });
}

// ─── Candle Builder ───────────────────────────────────────────────────────────
const candleBuilders = new Map();

function getOrCreateBuilder(symbol) {
  if (!candleBuilders.has(symbol)) {
    const builder = new CandleBuilder({
      onTick: (formingCandles) => { emitCandleUpdate(symbol, formingCandles); },
      onFinalize: (finalizedCandle, formingCandles) => {
        console.log(`[Builder:${symbol}] Candle finalized @ ${new Date(finalizedCandle.time).toISOString()} close=${finalizedCandle.close}`);
        emitCandleUpdate(symbol, formingCandles);
        emitFinalCandle(symbol, finalizedCandle);

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

tickStream.on("tick", (tick) => { lastTickAt = Date.now(); getOrCreateBuilder(tick.symbol).processTick(tick); });
tickStream.on("connected", () => { console.log("[TickStream] Fyers WebSocket connected ✓"); lastTickAt = 0; lastConnectAt = Date.now(); io.emit("market_status", { tickStreamActive: true }); });
tickStream.on("disconnected", () => { console.log("[TickStream] Fyers WebSocket disconnected"); io.emit("market_status", { tickStreamActive: false }); });
tickStream.on("error", (err) => { console.error("[TickStream] Error:", err?.message || err); });

/**
 * getActiveTickSymbols — returns every symbol currently watched by any connected
 * socket, plus the default SYMBOL. This is the list Fyers WebSocket subscribes to.
 */
function getActiveTickSymbols() {
  const set = new Set([SYMBOL]);
  for (const sym of socketSymbols.values()) { if (sym) set.add(sym); }
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
  if (!isTradingDay() || !isLiveMarket()) return;
  const valid = await validateToken().catch(() => false);
  if (!valid) return;
  const symbols = getActiveTickSymbols();
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
  if (!isLiveMarket()) { console.log("[TickStream] Outside 09:15–15:30 IST — tick stream not needed."); return; }
  if (tickStream.isConnected()) { tickStream.setSymbols(getActiveTickSymbols()); return; }
  const valid = await validateToken().catch(() => false);
  if (!valid) { console.log("[TickStream] Not authenticated — skipping tick stream."); return; }
  tickStream.start(getActiveTickSymbols());
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
async function fetchAndProcess(symbol = SYMBOL, resolution = RESOLUTION) {
  const raw1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH);

  if (candleBuilders.has(symbol)) {
    const existing = candleBuilders.get(symbol).getOneMinHistory();
    if (existing.length > 0 && raw1m.length > 0) {
      const ratio = existing[0].close > 0 ? Math.abs(raw1m[0].close - existing[0].close) / existing[0].close : 1;
      if (ratio > 0.5) { console.log(`[Server] Price scale mismatch for ${symbol} — resetting builder`); candleBuilders.delete(symbol); }
    }
  }

  const builder = getOrCreateBuilder(symbol);
  builder.seedHistory(raw1m);

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
      if ((socketSymbols.get(sid) || SYMBOL) === symbol) sock.emit("chart_update", payload);
    }
  }
  console.log(`[BROADCAST] ${symbol} res=${resolution}m → ${candles.length} candles`);
  return { candles, result };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), tickStreamActive: tickStream.isConnected(), liveMarket: isLiveMarket(), tradingDay: isTradingDay(), tickSymbols: getActiveTickSymbols() });
});

app.get("/api/auth/status", async (req, res) => {
  try { const valid = await validateToken(); res.json({ authenticated: valid, authUrl: valid ? null : getAuthURL() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/auth/url", (req, res) => {
  try { res.json({ url: getAuthURL() }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/auth/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "auth_code required" });
  try { await generateToken(code); await maybeStartTickStream(); res.json({ success: true, message: "Token saved successfully" }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/chart", async (req, res) => {
  const symbol = req.query.symbol || SYMBOL;
  const resolution = parseInt(req.query.resolution || RESOLUTION);
  const cache = getCache(symbol, resolution);
  const cacheTTL = isLiveMarket() ? 60_000 : isTradingDay() ? 5 * 60_000 : 24 * 60 * 60_000;
  if (cache.result && cache.candles.length > 0 && Date.now() - cache.lastFetch < cacheTTL) {
    return res.json(buildPayload(cache.candles, cache.result, symbol, resolution));
  }
  try {
    const { candles, result } = await fetchAndProcess(symbol, resolution);
    res.json(buildPayload(candles, result, symbol, resolution));
  } catch (err) {
    if (cache.result && cache.candles.length > 0) { console.warn(`[/api/chart] Fetch failed (${err.message}), serving stale cache`); return res.json(buildPayload(cache.candles, cache.result, symbol, resolution)); }
    console.error("[/api/chart] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chart/refresh?symbol=X&resolution=Y
 *
 * DUAL-PANEL FIX: emits chart_update only to the requesting socket (via socketId
 * in body) so the other panel's chart is never overwritten.
 *
 * TICK-STREAM FIX: after a successful fetch for any symbol, calls
 * updateTickSubscription() which adds that symbol to the Fyers WebSocket
 * subscription. This is the key fix for "only NIFTY gets tick-by-tick" —
 * previously the subscription was hardcoded to [SYMBOL] at startup and never
 * expanded when users searched for other stocks.
 */
app.post("/api/chart/refresh", async (req, res) => {
  const symbol = req.query.symbol || SYMBOL;
  const resolution = parseInt(req.query.resolution || RESOLUTION);
  const requestingSocketId = req.body?.socketId || null;

  console.log(`[REFRESH] symbol=${symbol} res=${resolution}m socket=${requestingSocketId || "broadcast"} liveMarket=${isLiveMarket()}`);

  // Pre-register the requesting socket's symbol so tick filtering is accurate
  // even before the socket emits set_symbol (which may arrive slightly later).
  if (requestingSocketId) socketSymbols.set(requestingSocketId, symbol);

  try {
    const { candles, result } = await fetchAndProcess(symbol, resolution);
    const payload = { ...buildPayload(candles, result, symbol, resolution, false), success: true };

    if (requestingSocketId) {
      // Only the requesting panel — other panel stays untouched
      io.to(requestingSocketId).emit("chart_update", { ...payload, isAutoRefresh: false });
    } else {
      // Legacy path — broadcast to room, symbol-filtered
      const room = `res:${resolution}`;
      const roomSockets = io.sockets.adapter.rooms.get(room);
      if (roomSockets?.size) {
        for (const sid of roomSockets) {
          const sock = io.sockets.sockets.get(sid);
          if (!sock) continue;
          if ((socketSymbols.get(sid) || SYMBOL) === symbol) sock.emit("chart_update", { ...payload, isAutoRefresh: true });
        }
      } else {
        io.to(room).emit("chart_update", { ...payload, isAutoRefresh: true });
      }
    }

    res.json(payload);

    // KEY TICK-STREAM FIX: sync Fyers WebSocket to include this symbol.
    // setImmediate so the HTTP response is sent first, then we do async work.
    setImmediate(() => updateTickSubscription().catch(console.error));
  } catch (err) {
    const cache = getCache(symbol, resolution);
    if (cache.result && cache.candles.length > 0) {
      console.warn(`[REFRESH] Fetch failed (${err.message}), serving stale cache`);
      return res.json({ ...buildPayload(cache.candles, cache.result, symbol, resolution, false), success: true });
    }
    console.error("[REFRESH] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/signals", async (req, res) => {
  const resolution = parseInt(req.query.resolution || RESOLUTION);
  const cache = getCache(SYMBOL, resolution);
  if (!cache.result) return res.status(404).json({ error: "No data yet. Call /api/chart first." });
  res.json({ signals: cache.result.signals, currentState: cache.result.currentState, lastUpdate: new Date(cache.lastFetch).toISOString() });
});

app.use("/api/symbols", symbolsRouter);

// ─── Tick Watchdog ────────────────────────────────────────────────────────────
function startTickWatchdog() {
  setInterval(() => {
    if (!isTradingDay() || !isLiveMarket() || !tickStream.isConnected()) return;
    const now = Date.now();
    if (lastConnectAt > 0 && now - lastConnectAt < WATCHDOG_GRACE_MS) return;
    if (lastTickAt === 0) return;
    const silenceMs = now - lastTickAt;
    if (silenceMs > TICK_WATCHDOG_MS) {
      console.warn(`[Watchdog] No tick for ${(silenceMs / 1000).toFixed(1)}s — reconnecting WebSocket`);
      lastTickAt = 0; lastConnectAt = 0;
      tickStream.stop();
      // Restart with the FULL current symbol list (not just [SYMBOL])
      setTimeout(() => maybeStartTickStream(), 1000);
    }
  }, TICK_WATCHDOG_MS);
  console.log(`[Watchdog] Started (timeout: ${TICK_WATCHDOG_MS / 1000}s, grace: ${WATCHDOG_GRACE_MS / 1000}s)`);
}

// ─── Auto-refresh fallback ────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    if (!isTradingDay() || !isLiveMarket() || tickStream.isConnected()) return;
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

    for (const { symbol, resolution } of pairs.values()) {
      console.log(`[AUTO] Refreshing ${symbol} res=${resolution}m...`);
      fetchAndBroadcast(symbol, resolution, true).catch((e) => console.error(`[AUTO] Error ${symbol} res=${resolution}:`, e.message));
    }
  }, REFRESH_MS);
  console.log(`[AUTO] Refresh every ${REFRESH_MS / 1000}s (live market + tick stream down only)`);
}

// ─── Initial REST fetch ───────────────────────────────────────────────────────
async function initialRestFetch() {
  const valid = await validateToken().catch(() => false);
  if (!valid) { console.log("[INIT] Not authenticated — skipping initial REST fetch. Chart will be empty."); return; }
  const dayLabel = isTradingDay() ? (isLiveMarket() ? "live market" : "weekday (market closed)") : "weekend/holiday";
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
  let currentSymbol = SYMBOL;
  socketResolutions.set(socket.id, currentResolution);
  socketSymbols.set(socket.id, currentSymbol);
  socket.join(`res:${currentResolution}`);

  const initialCache = getCache(SYMBOL, currentResolution);
  if (initialCache.result && initialCache.candles.length > 0) {
    socket.emit("chart_update", buildPayload(initialCache.candles, initialCache.result, SYMBOL, currentResolution, true));
  }
  socket.emit("market_status", { tickStreamActive: tickStream.isConnected(), liveMarket: isLiveMarket(), tradingDay: isTradingDay() });

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
    if (isLiveMarket() && sym !== prev) {
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
    console.log(`[WS] Client disconnected: ${socket.id}`);
    // Possibly trim unused symbols from tick subscription
    if (isLiveMarket()) updateTickSubscription().catch(console.error);
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
const PORT = parseInt(process.env.PORT || "9011");
server.listen(PORT, async () => {
  console.log(`\n✅ TGG Backend running on http://localhost:${PORT}`);
  console.log(`   Health  : http://localhost:${PORT}/health`);
  console.log(`   Chart   : http://localhost:${PORT}/api/chart`);
  console.log(`   Auth    : http://localhost:${PORT}/api/auth/status`);
  console.log(`   Symbols : http://localhost:${PORT}/api/symbols\n`);
  startAutoRefresh();
  startTickWatchdog();
  await initialRestFetch();
  if (isLiveMarket()) { console.log("[INIT] Market is live — starting tick stream for real-time candles."); await maybeStartTickStream(); }
  else if (isTradingDay()) { console.log("[INIT] Weekday outside market hours — REST data ready. Tick stream inactive."); }
  else { console.log("[INIT] Weekend/holiday — REST data loaded from last session. No tick stream."); }
});

module.exports = { app, server };