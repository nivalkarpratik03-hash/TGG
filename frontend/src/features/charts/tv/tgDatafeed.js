// frontend/src/features/charts/tv/tgDatafeed.js
// ═══════════════════════════════════════════════════════════════════════════
// TradingView Advanced Charts datafeed for the TGG backend.
//
//   History : GET  /api/chart?symbol=X&resolution=N   (your existing route)
//   Search  : GET  /api/symbols/search?q=...          (your existing route)
//   Live    : Socket.IO  set_symbol / set_resolution, listen to tick_update
//             (your existing events, one dedicated socket for this chart)
//
// Extras used by the strategy overlay layer:
//   getPayload(symbol, resolution, force) -> full /api/chart payload
//                                            (candles, emaHighs, emaLows, signals)
//   on("context", cb)  fires when the chart starts showing a symbol/interval
//   on("bar", cb)      fires when a new bar starts (the previous bar closed)
//
// The chart only DRAWS what the backend sends. Nothing is computed here.
// ═══════════════════════════════════════════════════════════════════════════
import { io } from "socket.io-client";
import { BACKEND } from "../../../config";

// TradingView resolution string  ->  your app's resolution in minutes
const RES_MAP = {
  "1": 1, "3": 3, "5": 5, "15": 15, "60": 60,
  "1D": 1440, "D": 1440,
  "1W": 10080, "W": 10080,
  "1M": 43200, "M": 43200,
};
export const SUPPORTED_RESOLUTIONS = ["1", "3", "5", "15", "60", "1D", "1W", "1M"];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 20 * 1000;

// Your candle times can be seconds or milliseconds (useSocket.js handles both).
function toMs(t) {
  return t > 1e10 ? t : t * 1000;
}

// Intraday bars keep their own timestamp. Daily and higher bars must sit at
// 00:00 UTC of the IST trading date, which is what TradingView expects.
function normalizeTime(t, resMinutes) {
  const ms = toMs(t);
  if (resMinutes >= 1440) return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return ms;
}

/** Candle time (seconds or ms) -> unix seconds in the format the chart expects. */
export function toChartSeconds(t, resMinutes) {
  return Math.floor(normalizeTime(t, resMinutes) / 1000);
}

function toBar(c, resMinutes) {
  return {
    time: normalizeTime(c.time, resMinutes),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0,
  };
}

function exchangeOf(symbol) {
  const i = String(symbol).indexOf(":");
  return i > 0 ? symbol.slice(0, i) : "NSE";
}

function sessionFor(exchange) {
  return exchange === "MCX" ? "0900-2330:23456" : "0915-1530:23456";
}

export function createDatafeed() {
  const historyCache = new Map();  // "symbol|res" -> { at, bars, payload }
  const inflight = new Map();      // "symbol|res" -> Promise<entry>
  const lastBarTime = new Map();   // "symbol|res" -> last bar time (ms) from history
  const subs = new Map();          // listenerGuid -> { symbol, res, onTick, lastTime }
  const listeners = { context: new Set(), bar: new Set() };
  let currentContext = null;
  let socket = null;

  function emit(evt, payload) {
    for (const cb of Array.from(listeners[evt])) {
      try { cb(payload); } catch (e) { /* a listener must never break the feed */ }
    }
  }

  // ── history ──────────────────────────────────────────────────────────────
  async function loadEntry(symbol, resMinutes, force) {
    const key = `${symbol}|${resMinutes}`;
    const cached = historyCache.get(key);
    if (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const url = `${BACKEND}/api/chart?symbol=${encodeURIComponent(symbol)}&resolution=${resMinutes}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`/api/chart returned ${r.status}`);
      const d = await r.json();
      const bars = (d.candles || [])
        .map((c) => toBar(c, resMinutes))
        .filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite))
        .sort((a, b) => a.time - b.time)
        .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
      const entry = { at: Date.now(), bars, payload: d };
      historyCache.set(key, entry);
      if (bars.length) lastBarTime.set(key, bars[bars.length - 1].time);
      return entry;
    })();

    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  async function loadHistory(symbol, resMinutes) {
    return (await loadEntry(symbol, resMinutes, false)).bars;
  }

  // ── live socket ──────────────────────────────────────────────────────────
  function latestSub() {
    let last = null;
    for (const s of subs.values()) last = s;
    return last;
  }

  function pointSocketAtLatestSub() {
    const s = latestSub();
    if (!socket || !s || !socket.connected) return;
    socket.emit("set_symbol", s.symbol);
    socket.emit("set_resolution", s.res);
  }

  function handleTick(d) {
    if (!d || !d.formingCandle) return;
    const res = Number(d.resolution);
    for (const s of subs.values()) {
      if (s.symbol !== d.symbol || s.res !== res) continue;
      const bar = toBar(d.formingCandle, res);
      if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
      if (bar.time < s.lastTime) continue; // never send a bar older than the last one
      const isNewBar = s.lastTime > 0 && bar.time > s.lastTime;
      s.lastTime = bar.time;
      s.onTick(bar);
      if (isNewBar) emit("bar", { symbol: s.symbol, resolution: s.res, time: bar.time });
    }
  }

  function ensureSocket() {
    if (socket) return;
    socket = io(BACKEND);
    socket.on("connect", pointSocketAtLatestSub);
    socket.on("tick_update", handleTick);
  }

  // ── the TradingView JS API object ────────────────────────────────────────
  return {
    onReady(callback) {
      setTimeout(
        () =>
          callback({
            supported_resolutions: SUPPORTED_RESOLUTIONS,
            exchanges: [
              { value: "", name: "All", desc: "" },
              { value: "NSE", name: "NSE", desc: "NSE" },
              { value: "BSE", name: "BSE", desc: "BSE" },
              { value: "MCX", name: "MCX", desc: "MCX" },
            ],
            symbols_types: [{ name: "All", value: "" }],
          }),
        0
      );
    },

    async searchSymbols(userInput, exchange, symbolType, onResult) {
      try {
        const params = new URLSearchParams({ q: userInput });
        if (exchange) params.set("exchange", exchange);
        const r = await fetch(`${BACKEND}/api/symbols/search?${params.toString()}`);
        const list = r.ok ? await r.json() : [];
        onResult(
          (Array.isArray(list) ? list : []).map((s) => ({
            symbol: s.symbol,
            full_name: s.symbol,
            description: s.name || s.symbol,
            exchange: exchangeOf(s.symbol),
            ticker: s.symbol,
            type: String(s.symbol).endsWith("-INDEX") ? "index" : "stock",
          }))
        );
      } catch (e) {
        onResult([]);
      }
    },

    resolveSymbol(symbolName, onResolve, onError) {
      const symbol = String(symbolName);
      const exchange = exchangeOf(symbol);
      setTimeout(
        () =>
          onResolve({
            name: symbol,
            ticker: symbol,
            full_name: symbol,
            description: symbol.includes(":") ? symbol.slice(symbol.indexOf(":") + 1) : symbol,
            type: symbol.endsWith("-INDEX") ? "index" : "stock",
            session: sessionFor(exchange),
            timezone: "Asia/Kolkata",
            exchange,
            listed_exchange: exchange,
            format: "price",
            minmov: 1,
            pricescale: 100,
            has_intraday: true,
            has_daily: true,
            has_weekly_and_monthly: true,
            has_empty_bars: false,
            supported_resolutions: SUPPORTED_RESOLUTIONS,
            volume_precision: 0,
            data_status: "streaming",
          }),
        0
      );
    },

    async getBars(symbolInfo, resolution, periodParams, onResult, onError) {
      try {
        const resMinutes = RES_MAP[resolution];
        if (!resMinutes) return onResult([], { noData: true });

        const symbol = symbolInfo.ticker || symbolInfo.name;
        const fromMs = periodParams.from * 1000;
        const toMsLimit = periodParams.to * 1000;
        const all = await loadHistory(symbol, resMinutes);

        const inRange = all.filter((b) => b.time >= fromMs && b.time < toMsLimit);
        if (inRange.length) return onResult(inRange, { noData: false });

        // Nothing in this window. If older bars exist, tell TradingView where to look next.
        let prev = null;
        for (const b of all) if (b.time < fromMs) prev = b;
        if (prev) return onResult([], { noData: false, nextTime: Math.floor(prev.time / 1000) });
        return onResult([], { noData: true });
      } catch (e) {
        onError(e && e.message ? e.message : "getBars failed");
      }
    },

    subscribeBars(symbolInfo, resolution, onTick, listenerGuid) {
      const resMinutes = RES_MAP[resolution];
      if (!resMinutes) return;
      const symbol = symbolInfo.ticker || symbolInfo.name;
      subs.set(listenerGuid, {
        symbol,
        res: resMinutes,
        onTick,
        lastTime: lastBarTime.get(`${symbol}|${resMinutes}`) || 0,
      });
      ensureSocket();
      pointSocketAtLatestSub();
      currentContext = { symbol, resolution: resMinutes };
      emit("context", currentContext);
    },

    unsubscribeBars(listenerGuid) {
      subs.delete(listenerGuid);
      if (subs.size === 0) {
        if (socket) socket.disconnect();
        socket = null;
      } else {
        pointSocketAtLatestSub();
      }
    },

    // ── used by the strategy overlay layer ─────────────────────────────────
    /** Full /api/chart payload (candles in ms, emaHighs, emaLows, signals). */
    async getPayload(symbol, resMinutes, force) {
      return (await loadEntry(symbol, resMinutes, !!force)).payload;
    },

    /** Subscribe to "context" or "bar". Returns an unsubscribe function. */
    on(evt, cb) {
      if (!listeners[evt]) return () => {};
      listeners[evt].add(cb);
      if (evt === "context" && currentContext) {
        try { cb(currentContext); } catch (e) { /* ignore */ }
      }
      return () => listeners[evt].delete(cb);
    },

    // Called by the React component when the chart is removed.
    destroy() {
      subs.clear();
      listeners.context.clear();
      listeners.bar.clear();
      currentContext = null;
      if (socket) socket.disconnect();
      socket = null;
      historyCache.clear();
      inflight.clear();
      lastBarTime.clear();
    },
  };
}