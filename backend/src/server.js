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
const symbolCheck = require("./core/symbolCheck");

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

// UPDATED 2026-08-06: chartRouter.js's /api/auth/token route needs to call
// gapFillScheduler.fireReauthCheckpoint() on a successful re-auth, but that
// scheduler doesn't exist yet at the point createChartRouter() is called
// below (it's built inside wireDbJobs(), which only runs once DB health-
// checks pass, inside the listen() callback further down). This small
// indirection lets the router close over a getter instead of the real
// function directly — getFireReauthCheckpoint() is reassigned once
// wireDbJobs() resolves; until then it's a safe no-op so an early re-auth
// attempt (before DB is ready) doesn't throw.
let _fireReauthCheckpoint = async () => {
  console.log("[GapFill] Re-auth checkpoint requested before scheduler was ready — skipped (DB/scheduler not yet wired)");
};
function getFireReauthCheckpoint() { return _fireReauthCheckpoint; }

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
  // UPDATED 2026-08-06 (items 2, 3, 4, 6): re-auth now re-fires the FULL
  // Staleness→GapFill→Validator/Recovery chain via
  // gapFillScheduler.fireReauthCheckpoint(), not the old spot-only
  // runCuratedSymbolCatchUp. wireDbJobs() below constructs the scheduler
  // and hands it back — see the getFireReauthCheckpoint() wiring at the
  // bottom of this file, since wireDbJobs() only resolves after this
  // router is already constructed (async health-check happens inside the
  // listen() callback, after routes are set up).
  runReauthCheckpoint: (...args) => getFireReauthCheckpoint()(...args),
  // Added 2026-08-13 — where /api/auth/callback sends the browser back to
  // after Fyers login (the frontend's /admin page). Must be set in .env
  // once the frontend has a stable deployed URL (e.g. https://tgg-liard.vercel.app).
  FRONTEND_URL: process.env.FRONTEND_URL,
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
// ─── Boot sequence — LOCKED order, 2026-08-07 (see TGG-project-plan.md) ────
// 1. Boot banner + URLs
// 2. Symbol-check (spot+futures validated against Fyers, failures excluded
//    from every future fetch)
// 3. startAutoRefresh() — arms fallback timer
// 4. startTickWatchdog() — arms watchdog
// 5. initialRestFetch() — pre-warms backend default (NIFTY50) candles
// 6. Tick stream start (if market live)
// 7. wireScannerAndBacktest()
// 8. wireDbJobs() — DB health check → Staleness → GapFill → Validator/Recovery
//    (last, deliberately — it's the slowest stage)
// No fixed delay between stages — each `await` simply waits for the
// previous stage's real work to finish before the next one starts.
server.listen(PORT, async () => {
  // ── 1. Boot banner ────────────────────────────────────────────────────────
  console.log(`\n✅ TGG Backend running on http://localhost:${PORT}`);
  console.log(`   Health     : http://localhost:${PORT}/health`);
  console.log(`   Chart      : http://localhost:${PORT}/api/chart`);
  console.log(`   Motherwave : http://localhost:${PORT}/api/motherwave`);
  console.log(`   Auth       : http://localhost:${PORT}/api/auth/status`);
  console.log(`   Symbols    : http://localhost:${PORT}/api/symbols`);
  console.log(`   Scanner    : http://localhost:${PORT}/api/scanner/signals\n`);

  // ── 2. Symbol-check — wait for a valid Fyers token first (fixes the ──────
  // permanent-exclusion bug: SymbolCheck must not run against an expired
  // token, see symbolCheck.js's waitForValidToken() for the full story).
  await symbolCheck.waitForValidToken();
  await symbolCheck.runSymbolCheck();

  // ── 3/4. Arm fallback timer + watchdog (instant, no real waiting) ────────
  dataFetch.startAutoRefresh();
  tickEngine.startTickWatchdog();

  // ── 5. Pre-warm backend default symbol ────────────────────────────────────
  await dataFetch.initialRestFetch();

  // ── 6. Tick stream (if market live) ───────────────────────────────────────
  if (isAnyMarketLive(tickEngine.getActiveTickSymbols())) { console.log("[INIT] Market is live — starting tick stream for real-time candles."); await tickEngine.maybeStartTickStream(); }
  else if (isTradingDay()) { console.log("[INIT] Weekday outside market hours — REST data ready. Tick stream inactive."); }
  else { console.log("[INIT] Weekend/holiday — REST data loaded from last session. No tick stream."); }

  // ── 7. Scanner + Backtest ─────────────────────────────────────────────────
  wireScannerAndBacktest({ io });

  // ── 8. DB: connect, health-check, wire every DB-dependent periodic job ────
  // (prune sweep, recoveryEngine emitter, periodicSync, GapFill scheduler,
  // Staleness→GapFill→Validator/Recovery boot chain — see scheduler.js).
  // Deliberately last — the slowest stage, per user's explicit call.
  const dbJobs = await wireDbJobs({
    io,
    sweepCuratedStaleness: catchUp.sweepCuratedStaleness,
    runValidatorRecovery: catchUp.runValidatorRecovery,
  });
  if (dbJobs && dbJobs.gapFillScheduler) {
    _fireReauthCheckpoint = dbJobs.gapFillScheduler.fireReauthCheckpoint;
  }
});

module.exports = { app, server };