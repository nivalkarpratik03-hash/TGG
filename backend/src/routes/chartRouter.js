/**
 * chartRouter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express router for all chart-related, auth, motherwave, and health routes.
 * Previously all inline in server.js (787 lines).
 *
 * Pattern: factory function receives shared server-state dependencies so the
 * router can reference io, caches, etc. without circular requires.
 *
 * NO DB CODE LIVES HERE. DB-first reads (and Fyers fallback) happen entirely
 * inside fetchAndProcess() in server.js — every route below just calls
 * fetchAndProcess() and doesn't know or care whether the data came from
 * Postgres or Fyers.
 *
 * Routes owned here:
 *   GET  /health
 *   GET  /api/auth/status
 *   GET  /api/auth/url
 *   POST /api/auth/token
 *   GET  /api/auth/callback   (added 2026-08-13 — auto-redirect flow)
 *   POST /api/admin/verify-pin (added 2026-08-13 — /admin page gate)
 *   GET  /api/chart
 *   POST /api/chart/refresh
 *   GET  /api/signals
 *   GET  /api/motherwave
 *
 * Usage in server.js:
 *   const createChartRouter = require("./chartRouter");
 *   app.use(createChartRouter(deps));
 */
const express = require("express");

/**
 * @param {object} deps - injected server-level dependencies
 * @param {import("socket.io").Server}  deps.io
 * @param {Map}    deps.socketSymbols         - socket.id → symbol
 * @param {string} deps.SYMBOL
 * @param {number} deps.RESOLUTION
 * @param {number} deps.TICK_WATCHDOG_MS
 * @param {Function} deps.getCache
 * @param {Function} deps.buildPayload
 * @param {Function} deps.fetchAndProcess     - single source of truth; handles DB-first + Fyers fallback internally
 * @param {Function} deps.isLiveMarket
 * @param {Function} deps.isTradingDay
 * @param {object}   deps.tickStream          - { isConnected() }
 * @param {Function} deps.ticksFlowing
 * @param {Function} deps.isAnyMarketLive
 * @param {Function} deps.getActiveTickSymbols
 * @param {Function} deps.updateTickSubscription
 * @param {Function} deps.maybeStartTickStream
 * @param {Function} deps.getAuthURL
 * @param {Function} deps.generateToken
 * @param {Function} deps.validateToken
 * @param {Function} deps.detectMotherWaveForAPI
 * @param {Function} deps.markBroadcastSymbol  - marks a symbol "recently requested" even without a socketId, so it's still picked up by the tick-stream subscription (fixes broadcast-mode refreshes never attaching live ticks)
 */
function createChartRouter(deps) {
  const {
    io, socketSymbols,
    SYMBOL, RESOLUTION,
    getCache, buildPayload, fetchAndProcess,
    isLiveMarket, isTradingDay,
    tickStream, ticksFlowing, isAnyMarketLive, getActiveTickSymbols,
    updateTickSubscription,
    getAuthURL, generateToken, validateToken, bustTokenCache,
    detectMotherWaveForAPI,
    markBroadcastSymbol,
    // Added 2026-08-13 — admin auto-redirect auth flow (see /api/auth/callback
    // and /api/admin/verify-pin below). FRONTEND_URL is where the browser
    // lands after Fyers redirects back into our backend.
    FRONTEND_URL,
    // UPDATED 2026-08-06 (items 2, 3, 4, 6): this now fires the FULL
    // Staleness→GapFill→Validator/Recovery chain via
    // gapFillScheduler.fireReauthCheckpoint() (passed in as
    // runReauthCheckpoint), not the old spot-only runCuratedSymbolCatchUp.
    // No trigger argument needed — fireReauthCheckpoint() always runs
    // under the "reauth" label internally.
    runReauthCheckpoint,
  } = deps;

  const router = express.Router();

  // ── Health ──────────────────────────────────────────────────────────────────
  router.get("/health", (req, res) => {
    const activeSyms = getActiveTickSymbols();
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      tickStreamActive: tickStream.isConnected(),
      ticksFlowing: ticksFlowing(),
      liveMarket: isAnyMarketLive(activeSyms),
      tradingDay: isTradingDay(),
      tickSymbols: activeSyms,
      watchdogWindowMs: deps.TICK_WATCHDOG_MS,
    });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  router.get("/api/auth/status", async (req, res) => {
    try {
      const valid = await validateToken();
      res.json({ authenticated: valid, authUrl: valid ? null : getAuthURL() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/api/auth/url", (req, res) => {
    try { res.json({ url: getAuthURL() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/auth/token", async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "auth_code required" });
    try {
      await generateToken(code);
      if (bustTokenCache) bustTokenCache();  // clear 60s cache so next validateToken is live
      await deps.maybeStartTickStream();

      // UPDATED 2026-08-06 (items 2, 3, 4, 6): now that a fresh token is
      // confirmed saved, re-run the FULL Staleness→GapFill→Validator/
      // Recovery chain (not just the old spot-only catch-up). Fire-and-
      // forget (not awaited) so this HTTP response doesn't block for
      // however long the full chain takes — each of the three steps has
      // its own in-flight guard, so this can never overlap with a
      // scheduled checkpoint or another re-auth already in progress.
      if (runReauthCheckpoint) {
        runReauthCheckpoint().catch((err) => {
          console.warn("[GapFill] Re-auth checkpoint chain failed:", err.message);
        });
      }

      res.json({ success: true, message: "Token saved successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Added 2026-08-13 — auto-redirect callback. Only fires once
  // PUBLIC_BACKEND_URL is set and registered as the Fyers app's Redirect
  // URL (see client.js getRedirectUri()). Fyers redirects the browser here
  // with ?auth_code=... after login instead of the generic Fyers page, so
  // the admin never has to copy-paste anything — just does the exchange
  // itself and bounces the browser straight back to the frontend admin page.
  router.get("/api/auth/callback", async (req, res) => {
    const feUrl = (FRONTEND_URL || "").replace(/\/$/, "");
    const authCode = req.query.auth_code || req.query.code;

    if (!feUrl) {
      // Misconfigured — nowhere sensible to redirect to, so fail loudly
      // instead of silently bouncing to a blank/broken URL.
      return res.status(500).send(
        "FRONTEND_URL is not set in backend/.env — cannot complete the redirect back to the app."
      );
    }
    if (!authCode) {
      return res.redirect(`${feUrl}/admin?auth=error&msg=${encodeURIComponent("No auth_code received from Fyers")}`);
    }

    try {
      await generateToken(authCode);
      if (bustTokenCache) bustTokenCache();
      await deps.maybeStartTickStream();
      if (runReauthCheckpoint) {
        runReauthCheckpoint().catch((err) => {
          console.warn("[GapFill] Re-auth checkpoint chain failed:", err.message);
        });
      }
      res.redirect(`${feUrl}/admin?auth=success`);
    } catch (err) {
      res.redirect(`${feUrl}/admin?auth=error&msg=${encodeURIComponent(err.message)}`);
    }
  });

  // Added 2026-08-13 — lightweight gate for the /admin page. Checks the PIN
  // server-side against .env so the real value never ships in the frontend
  // bundle (which is public). This is a casual deterrent, not real auth —
  // fine for a single-owner tool, but don't reuse this pattern if the app
  // ever has multiple real users who need separate accounts.
  router.post("/api/admin/verify-pin", (req, res) => {
    const { pin } = req.body || {};
    const expected = process.env.PIN;
    if (!expected) return res.status(500).json({ ok: false, error: "PIN not set in backend .env" });
    res.json({ ok: pin === expected });
  });

  // ── Chart ───────────────────────────────────────────────────────────────────
  /**
   * GET /api/chart?symbol=X&resolution=Y
   *
   * 1. In-process cache (TTL-based) — avoids hitting DB/Fyers on every request.
   * 2. Cache miss → fetchAndProcess(symbol, resolution). DB-first internally,
   *    Fyers fallback if DB has no data yet for this symbol. See server.js.
   * 3. Fetch failure → serve stale cache if we have one, else 500.
   */
  router.get("/api/chart", async (req, res) => {
    const symbol = req.query.symbol || SYMBOL;
    const resolution = parseInt(req.query.resolution || RESOLUTION);
    if (markBroadcastSymbol) markBroadcastSymbol(symbol);
    const cache = getCache(symbol, resolution);

    const live = isLiveMarket(symbol);
    const tradingDay = isTradingDay(symbol);
    const cacheTTL = live ? 60_000 : tradingDay ? 5 * 60_000 : 24 * 60 * 60_000;

    // ── In-process cache ──────────────────────────────────────────────────
    if (cache.result && cache.candles.length > 0 && Date.now() - cache.lastFetch < cacheTTL) {
      return res.json(buildPayload(cache.candles, cache.result, symbol, resolution));
    }

    try {
      const { candles, result } = await fetchAndProcess(symbol, resolution);
      if (live) setImmediate(() => updateTickSubscription().catch(console.error));
      res.json(buildPayload(candles, result, symbol, resolution));
    } catch (err) {
      if (cache.result && cache.candles.length > 0) {
        console.warn(`[/api/chart] Fetch failed (${err.message}), serving stale cache`);
        return res.json(buildPayload(cache.candles, cache.result, symbol, resolution));
      }
      console.error("[/api/chart] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/chart/refresh?symbol=X&resolution=Y
   *
   * Always calls fetchAndProcess(symbol, resolution) — DB-first internally,
   * Fyers fallback if DB has no data yet for this symbol. See server.js.
   *
   * DUAL-PANEL FIX: emits chart_update only to the requesting socket (via
   * socketId in body) so the other panel's chart is never overwritten.
   *
   * TICK-STREAM FIX: after every fetch, calls updateTickSubscription() so
   * the symbol gets added to the Fyers WebSocket if it's live and not
   * already subscribed — regardless of whether the candles came from DB
   * or Fyers.
   */
  router.post("/api/chart/refresh", async (req, res) => {
    const symbol = req.query.symbol || SYMBOL;
    const resolution = parseInt(req.query.resolution || RESOLUTION);
    const requestingSocketId = req.body?.socketId || null;

    console.log(`[REFRESH] symbol=${symbol} res=${resolution}m socket=${requestingSocketId || "broadcast"} liveMarket=${isLiveMarket(symbol)}`);

    if (requestingSocketId) socketSymbols.set(requestingSocketId, symbol);
    // Always mark the symbol as "wanted" for tick-stream purposes, even in
    // broadcast mode (no socketId) — see markBroadcastSymbol definition in
    // server.js for the full root-cause explanation.
    if (markBroadcastSymbol) markBroadcastSymbol(symbol);

    try {
      const { candles, result } = await fetchAndProcess(symbol, resolution);
      const payload = { ...buildPayload(candles, result, symbol, resolution, false), success: true };

      if (requestingSocketId) {
        io.to(requestingSocketId).emit("chart_update", { ...payload, isAutoRefresh: false });
      } else {
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

  // ── Signals ─────────────────────────────────────────────────────────────────
  router.get("/api/signals", async (req, res) => {
    const resolution = parseInt(req.query.resolution || RESOLUTION);
    const cache = getCache(SYMBOL, resolution);
    if (!cache.result) return res.status(404).json({ error: "No data yet. Call /api/chart first." });
    res.json({
      signals: cache.result.signals,
      currentState: cache.result.currentState,
      lastUpdate: new Date(cache.lastFetch).toISOString(),
    });
  });

  // ── Motherwave ──────────────────────────────────────────────────────────────
  /**
   * GET /api/motherwave?symbol=X&resolution=Y
   *
   * Returns Mother Wave result for the requested symbol + resolution.
   * Single source of truth — ReportsPage and FibDashboardPage call this.
   * Caching mirrors /api/chart TTL logic.
   */
  router.get("/api/motherwave", async (req, res) => {
    const symbol = req.query.symbol || SYMBOL;
    const resolution = parseInt(req.query.resolution || RESOLUTION);

    const live = isLiveMarket(symbol);
    const cacheTTL = live ? 60_000 : isTradingDay(symbol) ? 5 * 60_000 : 24 * 60 * 60_000;
    const cache = getCache(symbol, resolution);

    if (cache.motherwaveResult !== null && Date.now() - cache.motherwaveAt < cacheTTL) {
      return res.json(cache.motherwaveResult);
    }

    try {
      let candles = null;
      if (cache.candles && cache.candles.length > 0) {
        candles = cache.candles;
      } else {
        const { candles: fetched } = await fetchAndProcess(symbol, resolution);
        candles = fetched;
      }

      if (!candles || !candles.length) {
        cache.motherwaveResult = { motherwave: null };
        cache.motherwaveAt = Date.now();
        return res.json({ motherwave: null });
      }

      const result = detectMotherWaveForAPI(candles);
      const payload = result || { motherwave: null };
      cache.motherwaveResult = payload;
      cache.motherwaveAt = Date.now();
      res.json(payload);
    } catch (err) {
      console.error("[/api/motherwave] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // == GET /api/options/chain?symbol=NSE:NIFTY50-INDEX&timestamp=&strikeCount= ==
  // ROOT-CAUSE FIX: previously the frontend hand-built option symbols from a
  // guessed Fyers date-encoding (see optionsChain.js's optionSymbol()), which
  // Fyers frequently rejected as "Invalid symbol provided" -- a documented,
  // widely-reported problem with that encoding, not unique to this project.
  // This route returns the REAL per-strike symbol strings straight from
  // Fyers' own option chain response -- no guessing, no date math, always
  // valid because Fyers generated the string itself.
  // `timestamp` (optional, epoch seconds as string) selects a specific
  // expiry's strikes; omit it for the nearest expiry's strikes.
  router.get("/api/options/chain", async (req, res) => {
    const symbol = req.query.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol query param required" });
    const timestamp = req.query.timestamp || "";
    const strikeCount = parseInt(req.query.strikeCount || "20", 10);
    try {
      const valid = await validateToken();
      if (!valid) return res.status(401).json({ error: "Not authenticated" });
      const { fetchOptionChain } = require("../fyers/client");
      const { expiries, strikes } = await fetchOptionChain(symbol, { strikeCount, timestamp });
      if (strikes.length === 0) {
        return res.status(502).json({ error: `Fyers returned no option chain data for ${symbol}`, symbol, expiries, strikes: [] });
      }
      res.json({ symbol, expiries, strikes });
    } catch (err) {
      console.error("[/api/options/chain] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createChartRouter;