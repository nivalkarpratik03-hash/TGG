// ─── websocket.js ───────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k.
//
// Socket.IO connection handling — set_symbol / set_resolution /
// set_underlying / request_refresh / disconnect. Wires per-socket state
// into the shared socketResolutions/socketSymbols/socketUnderlyings Maps in
// state.js and calls into tickEngine (subscription updates, underlying
// derivation) and dataFetch (fetchAndProcess for request_refresh).
//
// Factory function createWebSocket({ io, tickEngine, dataFetch }) — called
// once at server.js boot; internally calls io.on("connection", ...) exactly
// like the original inline block did.
const { isLiveMarket, isAnyMarketLive, isTradingDay } = require("../fyers/tickStream");
const state = require("./state");

function createWebSocket({ io, tickEngine, dataFetch }) {
  const { SYMBOL, RESOLUTION, socketResolutions, socketSymbols, socketUnderlyings } = state;

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
    socket.emit("market_status", { tickStreamActive: tickEngine.tickStream.isConnected(), liveMarket: isAnyMarketLive(tickEngine.getActiveTickSymbols()), tradingDay: isTradingDay(), ticksFlowing: tickEngine.ticksFlowing() });

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
      const initialCache = state.getCache(currentSymbol, currentResolution);
      if (initialCache.result && initialCache.candles.length > 0) {
        socket.emit("chart_update", state.buildPayload(initialCache.candles, initialCache.result, currentSymbol, currentResolution, true));
      }
      if (isLiveMarket(sym) && sym !== prev) {
        tickEngine.updateTickSubscription().catch(console.error);
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
      const newCache = state.getCache(currentSymbol, newRes);
      if (newCache.result && newCache.candles.length > 0 && Date.now() - newCache.lastFetch < 120_000) {
        socket.emit("chart_update", state.buildPayload(newCache.candles, newCache.result, currentSymbol, newRes, true));
      }
    });

    // AUTO-ATM: register/clear this socket's underlying LTP side-channel.
    // Frontend calls this with the OPTION symbol currently on the panel when
    // the user has switched "Auto ATM" on; the server derives the underlying
    // itself (single source of truth for the option→underlying mapping) and
    // subscribes the tick stream to it. Calling with null/undefined stops the
    // feed (toggle off, symbol changed away from an option, panel unmounted).
    socket.on("set_underlying", (optionSym) => {
      const underlyingSym = tickEngine.deriveUnderlyingSymbol(optionSym);
      if (!underlyingSym) {
        if (socketUnderlyings.delete(socket.id)) {
          tickEngine.updateTickSubscription().catch(console.error);
        }
        return;
      }
      if (socketUnderlyings.get(socket.id) === underlyingSym) return;
      socketUnderlyings.set(socket.id, underlyingSym);
      console.log(`[WS] ${socket.id} → underlying=${underlyingSym} (Auto-ATM, from ${optionSym})`);
      if (isLiveMarket(underlyingSym)) {
        tickEngine.updateTickSubscription().catch(console.error);
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
      dataFetch.fetchAndProcess(currentSymbol, currentResolution)
        .then(({ candles, result }) => socket.emit("chart_update", state.buildPayload(candles, result, currentSymbol, currentResolution, false)))
        .catch((e) => socket.emit("error", { message: e.message, symbol: failedSymbol, resolution: failedResolution }));
    });

    socket.on("disconnect", () => {
      socketResolutions.delete(socket.id);
      socketSymbols.delete(socket.id);
      socketUnderlyings.delete(socket.id);
      console.log(`[WS] Client disconnected: ${socket.id}`);
      // Possibly trim unused symbols from tick subscription
      if (isAnyMarketLive(tickEngine.getActiveTickSymbols())) tickEngine.updateTickSubscription().catch(console.error);
    });
  });
}

module.exports = createWebSocket;
