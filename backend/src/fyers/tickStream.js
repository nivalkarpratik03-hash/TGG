/**
 * tickStream.js
 * ─────────────────────────────────────────────────────────────────
 * Manages the Fyers WebSocket data socket connection.
 *
 * THREE market state helpers (exported):
 *
 *   isLiveMarket(symbol)  — Symbol-aware live market check.
 *                           NSE/BSE: Mon–Fri 09:15–15:30 IST
 *                           MCX:     Mon–Fri 09:00–23:30, Sat 09:00–14:00
 *
 *   isTradingDay(symbol)  — True if today is a trading day for this symbol.
 *                           NSE/BSE: Mon–Fri
 *                           MCX:     Mon–Sat
 *                           No symbol → true if any market is open (Mon–Sat).
 *
 *   isMarketOpen()  — Alias for isLiveMarket(). Kept for back-compat.
 *
 * RULE:
 *   Tick stream (WebSocket) → only when isLiveMarket() is true
 *   REST fetch / cache      → always works, any time, any day
 *
 * IMPORTANT — the MARKET_HOURS constants and isLiveMarket()/isMCXSymbol() logic
 * below intentionally have a second copy in frontend/src/hooks/useSocket.js
 * (isLiveMarketFrontend(), used only to gate that file's REST poll fallback
 * timer). Browser code can't require() this Node module, and the two apps
 * deploy separately (frontend → Vercel, backend → Cloudflare), so a shared
 * npm package would be the "real" fix — until then, if you change the hours
 * here, update useSocket.js too. Same pattern as backend/src/data/holidays.js
 * vs frontend/src/utils/holidayCalendar.js.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const EventEmitter = require("events");
const { fyersDataSocket } = require("fyers-api-v3");
const { loadToken } = require("./client");

// Market hours IST
const NSE_OPEN_MIN = 9 * 60 + 15;   // 555  — NSE/BSE open
const NSE_CLOSE_MIN = 15 * 60 + 30;  // 930  — NSE/BSE close
const MCX_OPEN_MIN = 9 * 60 + 0;    // 540  — MCX open (Mon–Fri)
const MCX_CLOSE_MIN = 23 * 60 + 30;  // 1410 — MCX weekday close
const MCX_SAT_CLOSE = 14 * 60 + 0;   // 840  — MCX Saturday close
// Backward-compat aliases (server.js uses MARKET_OPEN_MIN indirectly via isLiveMarket)
const MARKET_OPEN_MIN = NSE_OPEN_MIN;
const MARKET_CLOSE_MIN = NSE_CLOSE_MIN;

/** Returns true if the symbol belongs to MCX (commodity exchange). */
function isMCXSymbol(symbol) {
  if (!symbol) return false;
  return String(symbol).toUpperCase().startsWith("MCX:");
}

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT = 10;

const FYERS_LOG_PATH = "";
const FYERS_LOGGING = false;

// ── IST helpers ───────────────────────────────────────────────────────────────
function nowIST() {
  const d = new Date();
  const istMs = d.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const dow = ist.getUTCDay();     // 0=Sun … 6=Sat
  const mins = h * 60 + m;
  return { h, m, mins, dow };
}

/**
 * isLiveMarket — Mon–Fri AND within market hours IST.
 *   • NSE/BSE symbols  : 09:15 – 15:30
 *   • MCX symbols      : 09:00 – 23:30
 * Pass `symbol` to get the correct hours for that exchange.
 */
function isLiveMarket(symbol) {
  const { mins, dow } = nowIST();
  if (dow === 0) return false;  // Sunday — nothing trades
  if (isMCXSymbol(symbol)) {
    // MCX: Mon–Fri 09:00–23:30, Saturday 09:00–14:00
    if (dow === 6) return mins >= MCX_OPEN_MIN && mins < MCX_SAT_CLOSE;
    return mins >= MCX_OPEN_MIN && mins < MCX_CLOSE_MIN;
  }
  // NSE/BSE/NFO/CDS: Mon–Fri 09:15–15:30 only
  if (dow === 6) return false;
  return mins >= NSE_OPEN_MIN && mins < NSE_CLOSE_MIN;
}

/**
 * isAnyMarketLive — true if ANY watched market is currently live.
 * Used to decide whether the tick stream should stay running.
 */
function isAnyMarketLive(symbols) {
  if (!symbols || symbols.length === 0) return isLiveMarket();
  return symbols.some((s) => isLiveMarket(s));
}

/**
 * isTradingDay — Mon–Fri regardless of time.
 * REST fetches and cache TTL decisions use this.
 * Does NOT mean the market is currently live.
 */
/**
 * isTradingDay — true if any exchange is open today.
 *   NSE/BSE/NFO: Mon–Fri
 *   MCX: Mon–Sat
 * Pass `symbol` to get the correct answer for that exchange.
 * Without symbol, returns true if NSE OR MCX is open (conservative — Mon–Sat).
 */
function isTradingDay(symbol) {
  const { dow } = nowIST();
  if (dow === 0) return false;  // Sunday — nothing
  if (dow === 6) {
    // Saturday: only MCX trades
    return symbol ? isMCXSymbol(symbol) : true;  // no symbol = any market
  }
  return true;  // Mon–Fri: always a trading day
}

/**
 * isMarketOpen — back-compat alias for isLiveMarket().
 */
const isMarketOpen = isLiveMarket;

// ── TickStream ────────────────────────────────────────────────────────────────
class TickStream extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._symbols = [];
    this._running = false;
    this._reconnects = 0;
    this._reconnTimer = null;
    this._userStopped = false;
    this._lastTickTime = 0;
    // REENTRANCY GUARD — fixes the "double tick-stream connect" boot race.
    // server.js has two independent callers that can both reach start() before
    // either has finished connecting: maybeStartTickStream() (server boot) and
    // updateTickSubscription() (fires the instant a client emits set_symbol).
    // Both check isConnected() first, but updateTickSubscription() does an
    // `await validateToken()` BEFORE calling start() — that await is a yield
    // point, so both callers can see isConnected() === false and both go on
    // to call start(), with the second call overwriting this._socket while
    // the first connection attempt is still in flight (orphaning it — its
    // event handlers stay attached and later fire a stray "Socket error").
    // _connecting closes that window: it's true for the entire time between
    // "we decided to open a socket" and "that socket connected, errored, or
    // closed", so a second start() call landing anywhere in that window is a
    // safe no-op that just refreshes the symbol list instead of opening a
    // second socket.
    this._connecting = false;
  }

  /** Start streaming ticks for the given symbols. */
  start(symbols) {
    if (!symbols || symbols.length === 0) {
      console.warn("[TickStream] No symbols provided — not starting.");
      return;
    }
    this._symbols = symbols;
    this._userStopped = false;

    // Already connected, or a connection attempt is already in flight —
    // don't open a second socket. Just make sure the live/incoming socket
    // ends up with the latest symbol list.
    if (this.isConnected()) {
      this.setSymbols(symbols);
      return;
    }
    if (this._connecting) {
      // _onConnect() reads this._symbols (already updated above) when the
      // in-flight connection completes, so nothing further to do here.
      return;
    }

    this._running = true;
    this._reconnects = 0;
    this._connect();
  }

  /** Stop the stream and clean up. */
  stop() {
    this._userStopped = true;
    this._running = false;
    this._connecting = false;
    if (this._reconnTimer) {
      clearTimeout(this._reconnTimer);
      this._reconnTimer = null;
    }
    this._disconnect();
  }

  /** Change the subscribed symbol set without fully restarting. */
  setSymbols(symbols) {
    this._symbols = symbols;
    if (this._socket && this._running) {
      try {
        this._socket.subscribe(this._symbols);
        console.log(`[TickStream] Re-subscribed to: ${symbols.join(", ")}`);
      } catch (err) {
        console.error("[TickStream] Re-subscribe failed:", err.message);
      }
    }
  }

  isConnected() {
    return this._running && this._socket != null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _connect() {
    this._connecting = true;

    const token = loadToken();
    if (!token) {
      console.warn("[TickStream] No access token — cannot start WebSocket.");
      this._connecting = false;
      return;
    }
    const appId = process.env.APP_ID;
    if (!appId) {
      console.warn("[TickStream] APP_ID missing — cannot start WebSocket.");
      this._connecting = false;
      return;
    }

    try {
      const fullToken = `${appId}:${token}`;
      this._socket = fyersDataSocket.getInstance(fullToken, FYERS_LOG_PATH, FYERS_LOGGING);

      // LiteMode: fires a tick on EVERY price change (<1s latency).
      // FullMode: batches OHLC/depth → causes ~30s candle delay.
      if (this._socket.LiteMode !== undefined) {
        this._socket.mode(this._socket.LiteMode);
        console.log("[TickStream] Mode set to LiteMode (fastest tick delivery)");
      } else {
        console.warn("[TickStream] LiteMode not available — using default mode");
      }

      // autoreconnect() MUST be called before connect()
      if (typeof this._socket.autoReconnect === "function") {
        this._socket.autoReconnect(MAX_RECONNECT);
      } else {
        this._socket.autoreconnect(MAX_RECONNECT);
      }

      this._socket.on("connect", () => this._onConnect());
      this._socket.on("message", (msg) => this._onMessage(msg));
      this._socket.on("error", (err) => this._onError(err));
      this._socket.on("close", () => this._onClose());

      // connect() takes NO arguments — token is in getInstance()
      this._socket.connect();
      console.log("[TickStream] Connecting to Fyers data socket (LiteMode)…");
    } catch (err) {
      console.error("[TickStream] Connect error:", err.message);
      this._connecting = false;
      this._scheduleReconnect();
    }
  }

  _disconnect() {
    if (this._socket) {
      try { this._socket.close(); } catch { /* ignore */ }
      this._socket = null;
    }
  }

  _onConnect() {
    this._connecting = false;
    this._reconnects = 0;
    console.log(`[TickStream] Connected ✓ Subscribing to: ${this._symbols.join(", ")}`);
    try {
      // subscribe() takes a flat string array only.
      // Do NOT pass a second `true` arg (market depth) — forces FullMode.
      this._socket.subscribe(this._symbols);
    } catch (err) {
      console.error("[TickStream] Subscribe failed:", err.message);
    }
    this.emit("connected");
  }

  _onMessage(msg) {
    try {
      if (!msg) return;
      const ticks = Array.isArray(msg) ? msg : [msg];

      for (const tick of ticks) {
        if (!tick || tick.ltp == null) continue;

        const symbol = tick.symbol || this._symbols[0];
        if (!symbol) continue;

        // LiteMode fields: symbol, ltp, tt, ch, chp
        const timestamp = tick.tt || tick.timestamp || Math.floor(Date.now() / 1000);

        // Warn on tick gaps during live hours
        const now = Date.now();
        if (this._lastTickTime && isLiveMarket(symbol)) {
          const gapMs = now - this._lastTickTime;
          if (gapMs > 5000) {
            console.warn(`[TickStream] Tick gap: ${(gapMs / 1000).toFixed(1)}s for ${symbol}`);
          }
        }
        this._lastTickTime = now;

        this.emit("tick", {
          symbol,
          ltp: Number(tick.ltp),
          timestamp: Number(timestamp),     // epoch seconds
          // undefined in LiteMode — CandleBuilder handles gracefully
          open: tick.open_price ?? tick.open,
          high: tick.high_price ?? tick.high,
          low: tick.low_price ?? tick.low,
          prev_close: tick.prev_close_price,
          vol: tick.vol_traded_today,
        });
      }
    } catch (err) {
      console.error("[TickStream] Message parse error:", err.message);
    }
  }

  _onError(err) {
    this._connecting = false;
    console.error("[TickStream] Socket error:", err?.message || err);
    this.emit("error", err);
  }

  _onClose() {
    this._connecting = false;
    console.log("[TickStream] Socket closed.");
    this.emit("disconnected");
    if (!this._userStopped && this._running) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._userStopped) return;
    if (this._reconnects >= MAX_RECONNECT) {
      console.warn("[TickStream] Max reconnects reached — giving up.");
      this._running = false;
      return;
    }
    this._reconnects++;
    // Exponential backoff: 3s, 6s, 9s, 12s, 15s (capped)
    const delay = RECONNECT_DELAY_MS * Math.min(this._reconnects, 5);
    console.log(`[TickStream] Reconnecting in ${delay / 1000}s (attempt ${this._reconnects})…`);
    this._reconnTimer = setTimeout(() => {
      this._disconnect();
      this._connect();
    }, delay);
  }
}

module.exports = { TickStream, isMarketOpen, isLiveMarket, isAnyMarketLive, isMCXSymbol, isTradingDay };