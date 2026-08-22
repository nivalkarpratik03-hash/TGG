// ─── tickEngine.js ──────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k.
//
// Owns: CandleBuilder wiring, the live Fyers tick stream and its event
// handlers, option→underlying symbol derivation, active-symbol tracking,
// tick subscription management, and the tick watchdog (health-check +
// market-close detector + status broadcast).
//
// Exported as a factory function createTickEngine({ io }) rather than a bare
// module.exports object because getOrCreateBuilder()'s deferred chart_update
// emit and several handlers need `io`, which is created in server.js after
// http.createServer() — passing it in here avoids any circular require
// between this file and server.js.
const { runSignalEngine } = require("../services/signalEngine");
const { CandleBuilder } = require("../services/candleBuilder");
const { TickStream, isLiveMarket, isAnyMarketLive, isTradingDay } = require("../fyers/tickStream");
const { loadIndexSpotSymbols } = require("../derivatives/curatedUnderlyingsLoader");
const state = require("./state");

function createTickEngine({ io }) {
  const { candleBuilders, socketSymbols, socketUnderlyings, SYMBOL } = state;

  // ─── Candle Builder ───────────────────────────────────────────────────────────
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
          if (state.dbEnabled) {
            state.db.upsertCandles(symbol, 1, [finalizedCandle]).catch((err) => {
              console.error(`[DB] Failed to save candle for ${symbol}:`, err.message);
            });
          }

          setImmediate(() => {
            const b = candleBuilders.get(symbol);
            if (!b) return;
            for (const res of [1, 3, 5, 15]) {
              const candles = b.getCandlesForResolution(res);
              if (candles.length === 0) continue;
              try { const result = runSignalEngine(candles); state.setCache(symbol, res, candles, result); }
              catch (err) { console.error(`[Builder:${symbol}] Signal engine error res=${res}:`, err.message); }
            }
            for (const res of [60, 1440, 10080, 43200]) {
              const cache = state.getCache(symbol, res);
              if (!cache.candles.length) continue;
              const forming1m = b.getCandlesForResolution(1);
              if (!forming1m.length) continue;
              const tick = forming1m[forming1m.length - 1];
              const cached = cache.candles;
              const last = cached[cached.length - 1];
              const updatedLast = { ...last, high: Math.max(last.high, tick.high), low: Math.min(last.low, tick.low), close: tick.close };
              const patched = [...cached.slice(0, -1), updatedLast];
              try { const result = runSignalEngine(patched); state.setCache(symbol, res, patched, result); }
              catch (err) { console.error(`[Builder:${symbol}] Patch error res=${res}:`, err.message); }
            }
          });

          // Deferred chart_update: symbol-scoped so dual panels don't overwrite each other
          setTimeout(() => {
            const b = candleBuilders.get(symbol);
            if (!b) return;
            for (const res of [1, 3, 5, 15, 60, 1440, 10080, 43200]) {
              const room = `res:${res}`;
              const roomSockets = io.sockets.adapter.rooms.get(room);
              if (!roomSockets?.size) continue;
              const cache = state.getCache(symbol, res);
              if (!cache.result || !cache.candles.length) continue;
              const payload = state.buildPayload(cache.candles, cache.result, symbol, res, true);
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
    for (const res of [1, 3, 5, 15, 60, 1440, 10080, 43200]) {
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
    state.lastTickAt = now;
    state.lastTickBySymbol.set(tick.symbol, now);
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
  tickStream.on("connected", () => { console.log("[TickStream] Fyers WebSocket connected ✓"); state.lastTickAt = 0; state.lastConnectAt = Date.now(); io.emit("market_status", { tickStreamActive: true, ticksFlowing: false }); });
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
  // Built dynamically from symbols/index.json (the same root-master file
  // curatedUnderlyingsLoader.js and symbolsRouter.js read) — no separate
  // hardcoded copy, so this can't go stale again the way it did when
  // FINNIFTY's real symbol changed on 2026-08-06 and this file's own copy
  // silently kept pointing at the old NSE:CNXFINANCE-INDEX. Always reflects
  // whatever the 6 curated indices currently are.
  //
  // The old hardcoded map also carried a NIFTYIT: "NSE:CNXIT-INDEX" entry —
  // dropped here since NIFTYIT is not one of the 6 curated indices in
  // symbols/index.json and never was; it was an orphan left over from
  // before the curated-index system existed.
  const INDEX_ROOT_TO_SYMBOL = Object.fromEntries(
    loadIndexSpotSymbols().map((e) => [e.name, e.symbol])
  );
  let parseDerivativeSymbol = null;
  try {
    ({ parseDerivativeSymbol } = require("../../../database/src/parsing/symbolParser"));
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
    for (const sym of state.getLiveBroadcastSymbols()) { set.add(sym); }
    return [...set];
  }

  // ── ticksFlowing: true if any subscribed symbol got a tick within watchdog window ─
  // Window matches TICK_WATCHDOG_MS so both agree on what "stale" means.
  // e.g. TICK_WATCHDOG_MS=60000 → green dot stays on for 60s after last tick,
  // then watchdog reconnects AND ticksFlowing flips false at the same time.
  const TICK_FLOWING_WINDOW_MS = state.TICK_WATCHDOG_MS;
  function ticksFlowing() {
    const syms = getActiveTickSymbols();
    const cutoff = Date.now() - TICK_FLOWING_WINDOW_MS;
    return syms.some((s) => (state.lastTickBySymbol.get(s) || 0) > cutoff);
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
    const valid = await state.validateToken().catch(() => false);
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
    const valid = await state.validateToken().catch(() => false);
    if (!valid) { console.log("[TickStream] Not authenticated — skipping tick stream."); return; }
    tickStream.start(symbols);
  }

  // ─── Tick Watchdog ────────────────────────────────────────────────────────────
  // Checks every TICK_WATCHDOG_MS whether ticks have gone silent; if so,
  // declares the Fyers WebSocket dead, reconnects, and (via the market-close
  // detector below) tells the difference between "connection dropped" and
  // "market just closed for the day."
  function startTickWatchdog() {
    setInterval(() => {
      if (!isTradingDay() || !isAnyMarketLive(getActiveTickSymbols()) || !tickStream.isConnected()) return;
      const now = Date.now();
      if (state.lastConnectAt > 0 && now - state.lastConnectAt < state.WATCHDOG_GRACE_MS) return;
      if (state.lastTickAt === 0) return;
      const silenceMs = now - state.lastTickAt;
      if (silenceMs > state.TICK_WATCHDOG_MS) {
        console.warn(`[Watchdog] No tick for ${(silenceMs / 1000).toFixed(1)}s — reconnecting WebSocket`);
        state.lastTickAt = 0; state.lastConnectAt = 0;
        // Immediately tell all clients ticks stopped — don't wait for broadcast timer
        io.emit("market_status", { ticksFlowing: false, tickStreamActive: false });
        tickStream.stop();
        // Restart with the FULL current symbol list (not just [SYMBOL])
        setTimeout(() => maybeStartTickStream(), 1000);
      }
    }, state.TICK_WATCHDOG_MS);
    console.log(`[Watchdog] Started (timeout: ${state.TICK_WATCHDOG_MS / 1000}s, grace: ${state.WATCHDOG_GRACE_MS / 1000}s)`);

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
        state.lastTickAt = 0;
        state.lastConnectAt = 0;
        // Clear all per-symbol tick timestamps so ticksFlowing() returns false
        state.lastTickBySymbol.clear();
        tickStream.stop();
        io.emit("market_status", { ticksFlowing: false, tickStreamActive: false });
      }
      wasAnyLive = nowLive;
    }, 60_000); // check every 60s — market close is a once-per-day event

    // Periodic status broadcast — interval is half the watchdog so clients
    // learn ticksFlowing changes promptly without hammering the socket.
    const STATUS_BROADCAST_MS = Math.max(10_000, Math.floor(state.TICK_WATCHDOG_MS / 2));
    setInterval(() => {
      io.emit("market_status", { ticksFlowing: ticksFlowing(), tickStreamActive: tickStream.isConnected() });
    }, STATUS_BROADCAST_MS);
    console.log(`[Watchdog] Status broadcast every ${STATUS_BROADCAST_MS / 1000}s`);
  }

  return {
    tickStream,
    getOrCreateBuilder, emitCandleUpdate, emitFinalCandle,
    deriveUnderlyingSymbol, isOptionSymbol,
    getActiveTickSymbols, ticksFlowing,
    updateTickSubscription, maybeStartTickStream,
    startTickWatchdog,
  };
}

module.exports = createTickEngine;