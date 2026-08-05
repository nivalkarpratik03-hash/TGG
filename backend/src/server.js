require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { getAuthURL, generateToken, validateToken: _validateToken } = require("./fyers/client");
const { isLiveMarket, isTradingDay, isAnyMarketLive } = require("./fyers/tickStream");
const symbolsRouter = require("./routes/symbolsRouter");
const scannerRouter = require("./routes/scannerRouter");
const backtestRouter = require("./routes/backtestRouter");
const { detectMotherWaveForAPI } = require("./services/motherwave");
const createChartRouter = require("./routes/chartRouter");
const corsMiddleware = require("./middleware/cors");
const rateLimiter = require("./middleware/rateLimiter");

// ─── Chunk 12 (2026-08-05) split — see TGG-project-plan.md Section 4k ────────
// server.js used to be 1,367 lines holding all of this inline. It's now a
// slim orchestrator: state.js owns shared config/state, tickEngine.js /
// dataFetch.js / catchUp.js / websocket.js / scheduler.js each own one
// slice of behavior, and this file just constructs them in dependency order
// and wires them into Express/Socket.IO exactly as the original inline code
// did — same boot sequence, same call order, same everything.
const state = require("./core/state");
const createTickEngine = require("./core/tickEngine");
const createDataFetch = require("./core/dataFetch");
const createCatchUp = require("./core/catchUp");
const createWebSocket = require("./core/websocket");
const { wireDbJobs, wireScannerAndBacktest } = require("./core/scheduler");

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

// ─── Construct the split-out modules, in dependency order ───────────────────
// tickEngine → dataFetch → catchUp is one-directional (each only requires
// the one before it), so this order matches exactly how they depend on
// each other — no circular requires anywhere in this graph.
const tickEngine = createTickEngine({ io });
const dataFetch = createDataFetch({ io, tickEngine });
const catchUp = createCatchUp({ dataFetch });
createWebSocket({ io, tickEngine, dataFetch }); // wires io.on("connection", ...) — nothing to store, matches original inline block

// ─── Routes ───────────────────────────────────────────────────────────────────
// Chart, auth, health, signals, motherwave → chartRouter (extracted, pre-existing)
app.use(createChartRouter({
  io, socketSymbols: state.socketSymbols, socketResolutions: state.socketResolutions,
  SYMBOL: state.SYMBOL, RESOLUTION: state.RESOLUTION, TICK_WATCHDOG_MS: state.TICK_WATCHDOG_MS,
  getCache: state.getCache, buildPayload: state.buildPayload,
  fetchAndProcess: dataFetch.fetchAndProcess, fetchAndBroadcast: dataFetch.fetchAndBroadcast,
  isLiveMarket, isTradingDay, isAnyMarketLive,
  tickStream: tickEngine.tickStream, ticksFlowing: tickEngine.ticksFlowing,
  getActiveTickSymbols: tickEngine.getActiveTickSymbols, updateTickSubscription: tickEngine.updateTickSubscription,
  maybeStartTickStream: tickEngine.maybeStartTickStream,
  getAuthURL, generateToken, validateToken: state.validateToken, bustTokenCache: state.bustTokenCache,
  detectMotherWaveForAPI,
  markBroadcastSymbol: state.markBroadcastSymbol,
  // FIX 5 (re-auth hook): expose the same curated-symbol gap-fill/staleness
  // sweep that runs at boot so the /api/auth/token route can re-trigger it
  // the moment a token goes from invalid to valid again — see catchUp.js.
  runCuratedSymbolCatchUp: catchUp.runCuratedSymbolCatchUp,
}));

app.use("/api/symbols", symbolsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/backtest", backtestRouter);

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
  dataFetch.startAutoRefresh();
  tickEngine.startTickWatchdog();

  // ── DB: connect, health-check, wire every DB-dependent periodic job ──────
  // (prune sweep, recoveryEngine emitter, periodicSync, GapFill scheduler,
  // curated catch-up→GapFill boot chain — see scheduler.js for all of it)
  await wireDbJobs({ io, runCuratedSymbolCatchUp: catchUp.runCuratedSymbolCatchUp });

  await dataFetch.initialRestFetch();

  wireScannerAndBacktest({ io });

  if (isAnyMarketLive(tickEngine.getActiveTickSymbols())) { console.log("[INIT] Market is live — starting tick stream for real-time candles."); await tickEngine.maybeStartTickStream(); }
  else if (isTradingDay()) { console.log("[INIT] Weekday outside market hours — REST data ready. Tick stream inactive."); }
  else { console.log("[INIT] Weekend/holiday — REST data loaded from last session. No tick stream."); }
});

module.exports = { app, server };
