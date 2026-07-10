// useSocket.js
// ─────────────────────────────────────────────────────────────────
// RULES:
//   • Always GET /api/chart on mount — backend handles cache TTL
//   • POST /api/chart/refresh — only when user explicitly clicks Refresh
//     or changes symbol/timeframe
//   • Tick stream (WebSocket) is server-managed — frontend just listens
//   • Works on weekends, after hours, any symbol from Excel/JSON
//   • REST poll fallback ONLY runs during live market hours
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import { io } from "socket.io-client";
import axios from "axios";
import { BACKEND } from "../config";

// ── IST live-market check (frontend guard for REST poll fallback only) ─────────
// NOTE: This is used ONLY to gate the REST poll fallback timer — not for routing
// GET vs POST. The backend handles all routing decisions via isLiveMarket(symbol).
//
// IMPORTANT — keep this logic identical (in spirit) to backend/src/fyers/tickStream.js's
// isLiveMarket()/isMCXSymbol(). They intentionally live as two separate copies
// (browser ES module frontend vs Node CommonJS backend, deployed separately —
// frontend to Vercel, backend to Cloudflare — so this file can't require() the
// backend module directly) — if you update one, update the other. Same pattern
// already used for frontend/src/utils/holidayCalendar.js vs backend/src/data/holidays.js.
//
// Verified line-by-line equivalent to tickStream.js as of this comment,
// including the MCX Saturday early-close case.
const NSE_OPEN_MIN = 9 * 60 + 15;   // 555  — NSE/BSE open
const NSE_CLOSE_MIN = 15 * 60 + 30;  // 930  — NSE/BSE close
const MCX_OPEN_MIN = 9 * 60 + 0;    // 540  — MCX open (Mon–Fri)
const MCX_CLOSE_MIN = 23 * 60 + 30;  // 1410 — MCX weekday close
const MCX_SAT_CLOSE = 14 * 60 + 0;   // 840  — MCX Saturday close

function isMCXSymbol(symbol) {
  return symbol && String(symbol).toUpperCase().startsWith("MCX:");
}

function isLiveMarketFrontend(symbol) {
  const now = new Date();
  const istOffset = 5 * 60 + 30;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMin = (utcMin + istOffset) % (24 * 60);
  const istDate = new Date(now.getTime() + istOffset * 60000);
  const dow = istDate.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0) return false; // Sunday — nothing trades
  if (isMCXSymbol(symbol)) {
    // MCX: Mon–Fri 09:00–23:30, Saturday 09:00–14:00
    if (dow === 6) return istMin >= MCX_OPEN_MIN && istMin < MCX_SAT_CLOSE;
    return istMin >= MCX_OPEN_MIN && istMin < MCX_CLOSE_MIN;
  }
  // NSE/BSE: Mon–Fri 09:15–15:30 only
  if (dow === 6) return false;
  return istMin >= NSE_OPEN_MIN && istMin < NSE_CLOSE_MIN;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function useSocket() {
  const [chartData, setChartData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tickStreamActive, setTickStreamActive] = useState(false);
  const [ticksFlowing, setTicksFlowing] = useState(null); // null = not yet known, true/false = server confirmed
  const [underlyingTick, setUnderlyingTick] = useState(null); // Auto-ATM: last LTP from underlying

  const socketRef = useRef(null);
  const activeResolutionRef = useRef(null);
  const activeSymbolRef = useRef(null);
  const latestRequestIdRef = useRef(0);
  const lastSocketUpdateRef = useRef(0);
  const hasDataRef = useRef(false);
  // NEW BUG FIX (reported: chart shows only 2-3 candles after a backend
  // restart, until a manual page reload). Root cause: hasDataRef stays
  // `true` across a backend restart (this tab never remounted), so the
  // "connect" handler's `!hasDataRef.current` guard below skipped
  // fetchChart() on reconnect — and the backend's own in-memory cache is
  // wiped by a restart, so its set_symbol fast-path had nothing to push
  // either. Net effect: the tab was stuck rendering only whatever live
  // ticks arrived after reconnecting, with no way to recover short of a
  // hard reload. needsResyncRef forces a real fetchChart() on the very
  // next "connect" after ANY "disconnect" — including a reconnect to a
  // freshly-restarted backend — regardless of hasDataRef's state.
  const needsResyncRef = useRef(false);
  const pollTimerRef = useRef(null);
  const underlyingOptionSymbolRef = useRef(null); // last symbol passed to setUnderlying

  // ── matchesActive — drop stale socket events ──────────────────────────────
  const matchesActive = useCallback((d) => {
    const inRes = d?.resolution != null ? Number(d.resolution) : null;
    const activeRes = activeResolutionRef.current;
    if (activeRes !== null && inRes !== null && inRes !== activeRes) return false;
    if (d?.symbol && activeSymbolRef.current && d.symbol !== activeSymbolRef.current) return false;
    return true;
  }, []);

  // ── fetchChart — GET /api/chart (works 24/7, any symbol, any day) ─────────
  const fetchChart = useCallback(async (symbol, resolution, { retries = 5, signal } = {}) => {
    const sym = symbol ?? activeSymbolRef.current;
    const res = resolution ?? activeResolutionRef.current;
    const reqId = ++latestRequestIdRef.current;

    const params = {};
    if (sym) params.symbol = sym;
    if (res) params.resolution = res;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) return;
      try {
        const r = await axios.get(`${BACKEND}/api/chart`, { params, timeout: 20_000 });
        if (reqId !== latestRequestIdRef.current) return;

        if (!r.data?.candles?.length) {
          if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
          // All retries exhausted — no data in DB and Fyers unreachable.
          // Set a clear error instead of leaving an infinite empty state.
          setLoading(false);
          setError("no_data");
          return;
        }

        if (r.data.resolution != null) activeResolutionRef.current = Number(r.data.resolution);
        if (r.data.symbol) activeSymbolRef.current = r.data.symbol;

        setChartData(r.data);
        hasDataRef.current = true;
        lastSocketUpdateRef.current = Date.now();
        setLoading(false);
        setError(null);
        return;
      } catch {
        if (reqId !== latestRequestIdRef.current) return;
        if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
        setLoading(false);
        setError("no_data");
      }
    }
    // Mount-only: socket and poll setup runs once. All state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── REST poll fallback (live market hours only) ───────────────────────────
  const POLL_INTERVAL_MS = 70_000;

  function startPollFallback() {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      if (!isLiveMarketFrontend(activeSymbolRef.current)) return;
      const res = activeResolutionRef.current;
      const sym = activeSymbolRef.current;
      if (!res || !sym) return;
      if (Date.now() - lastSocketUpdateRef.current < POLL_INTERVAL_MS) return;
      // During REST fallback (socket dead) — fetch chart AND sync market status
      // so the StatusBar dot stays accurate without a socket event.
      await fetchChart(sym, res, { retries: 1 });
      try {
        const hRes = await fetch(`${BACKEND}/health`);
        if (hRes.ok) {
          const h = await hRes.json();
          if (h?.ticksFlowing != null) setTicksFlowing(!!h.ticksFlowing);
          if (h?.tickStreamActive != null) setTickStreamActive(!!h.tickStreamActive);
        }
      } catch (_) { /* health check failed — status stays as-is */ }
    }, POLL_INTERVAL_MS);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(BACKEND, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      // DUAL-PANEL FIX: tell server this socket's symbol immediately on connect
      // so the server's socketSymbols map is populated before any refresh fires.
      if (activeSymbolRef.current) socket.emit("set_symbol", activeSymbolRef.current);
      if (activeResolutionRef.current) socket.emit("set_resolution", activeResolutionRef.current);
      // Re-register Auto-ATM underlying after reconnect
      if (underlyingOptionSymbolRef.current) socket.emit("set_underlying", underlyingOptionSymbolRef.current);
      // Only fall back to a GET fetch if there's genuinely no data and nothing is in-flight.
      // ChartsPage calls refresh() (POST) on mount which already covers the initial load.
      // The latestRequestIdRef check inside fetchChart prevents stale responses from landing.
      //
      // needsResyncRef.current is also checked here — see its declaration above.
      // Without it, a tab that survives a backend restart (no page reload) would
      // never re-fetch full history: hasDataRef stays true from before the
      // restart, so this guard alone would skip fetchChart forever, leaving the
      // chart stuck showing only whatever live ticks trickle in post-reconnect.
      if (needsResyncRef.current || (!hasDataRef.current && latestRequestIdRef.current === 0)) {
        needsResyncRef.current = false;
        fetchChart(activeSymbolRef.current, activeResolutionRef.current, { retries: 3 });
      }
    });

    socket.on("disconnect", () => {
      setConnected(false);
      // Reset to null so StatusBar shows "Connecting…" not "Market Closed"
      // when the socket reconnects. Server will re-send market_status on connect.
      setTicksFlowing(null);
      setTickStreamActive(false);
      setUnderlyingTick(null);
      // Any reconnect after this point must re-fetch full history — see
      // needsResyncRef's declaration above for why hasDataRef alone isn't enough.
      needsResyncRef.current = true;
    });

    socket.on("chart_update", (d) => {
      if (!matchesActive(d)) return;
      // Sync active refs from socket data — critical for page-reload tick-by-tick:
      // on a fresh page load, activeResolutionRef is null until fetchChart completes,
      // but chart_update arrives via socket first. Without syncing here, the first
      // tick_update passes matchesActive (null passes everything) but handleCandleUpdate
      // works fine. However if a chart_update arrives AFTER a tick, the candle count
      // jump is >1 and falls into full setData — which is actually fine. The real
      // issue was activeResolutionRef staying null causing matchesActive to always
      // pass, then a symbol-change tick hitting the wrong series. Fix: always sync.
      if (d.resolution != null) activeResolutionRef.current = Number(d.resolution);
      if (d.symbol) activeSymbolRef.current = d.symbol;
      lastSocketUpdateRef.current = Date.now();
      setChartData(d);
      hasDataRef.current = true;
      setLoading(false);
      setError(null);
    });

    function handleCandleUpdate(d) {
      if (!matchesActive(d) || !d?.formingCandle) return;
      lastSocketUpdateRef.current = Date.now();
      setChartData((prev) => {
        if (!prev?.candles?.length) return prev;
        const { formingCandle: fc, timestamp } = d;
        const candles = prev.candles;
        const last = candles[candles.length - 1];

        // Normalize to ms — candle times may be seconds (LW format) or ms
        const toMs = (t) => (t > 1e10 ? t : t * 1000);
        const fcMs = toMs(fc.time);
        const lastMs = toMs(last.time);
        const fcMin = Math.floor(fcMs / 60000);
        const lastMin = Math.floor(lastMs / 60000);

        let updated;
        if (fcMin === lastMin) {
          // Tick update for the current (last) candle — update in place
          updated = [...candles.slice(0, -1), { ...last, ...fc, time: last.time }];
        } else if (fcMin > lastMin) {
          // New minute started — append the forming candle
          // Preserve time in same unit as existing candles
          const newCandle = { ...fc, time: last.time > 1e10 ? fcMs : Math.floor(fcMs / 1000) };
          updated = [...candles, newCandle];
        } else {
          return prev; // stale tick, ignore
        }
        return { ...prev, candles: updated, lastUpdate: new Date(timestamp || Date.now()).toISOString() };
      });
    }
    socket.on("tick_update", handleCandleUpdate);
    socket.on("candle_update", handleCandleUpdate);

    socket.on("new_candle", (d) => {
      if (!matchesActive(d) || !d?.candle) return;
      lastSocketUpdateRef.current = Date.now();
      setChartData((prev) => {
        if (!prev?.candles?.length) return prev;
        const { candle: nc, timestamp } = d;
        const candles = prev.candles;
        const last = candles[candles.length - 1];

        // Normalize to ms — times may be seconds or ms
        const toMs = (t) => (t > 1e10 ? t : t * 1000);
        const ncMs = toMs(nc.time);
        const lastMs = toMs(last.time);
        const ncMin = Math.floor(ncMs / 60000);
        const lastMin = Math.floor(lastMs / 60000);

        let updated;
        if (ncMin === lastMin) {
          updated = [...candles.slice(0, -1), { ...last, ...nc, time: last.time }];
        } else if (ncMin > lastMin) {
          const newCandle = { ...nc, time: last.time > 1e10 ? ncMs : Math.floor(ncMs / 1000) };
          updated = [...candles, newCandle];
        } else {
          return prev;
        }
        return { ...prev, candles: updated, lastUpdate: new Date(timestamp || Date.now()).toISOString() };
      });
    });

    // Only arrives while setUnderlying() has registered a symbol server-side.
    socket.on("underlying_tick", (d) => {
      setUnderlyingTick(d);
    });

    socket.on("market_status", (d) => {
      if (d?.tickStreamActive != null) setTickStreamActive(!!d.tickStreamActive);
      if (d?.ticksFlowing != null) setTicksFlowing(!!d.ticksFlowing);
    });

    // FRONTEND-SYNC FIX: the server broadcasts this whenever a staleness
    // backfill, repair, or periodic sync writes NEW history for a symbol —
    // e.g. you opened a chart for a symbol that hadn't been touched in days,
    // the server caught it up in the background, and your already-rendered
    // chart would otherwise carry that pre-catch-up gap forward forever
    // (the live tick stream only appends new candles going forward, it never
    // retroactively patches an old render). Only react if it's for the
    // symbol currently on screen, and re-pull via the same "request_refresh"
    // path the Refresh button already uses — no new state plumbing needed.
    socket.on("history_updated", (d) => {
      if (!d?.symbol || d.symbol !== activeSymbolRef.current) return;
      socket.emit("request_refresh");
    });

    // FIX: the server now attaches { symbol, resolution } to error events that
    // are tied to a specific fetch (e.g. a failed request_refresh) — filter it
    // through the same matchesActive() check as chart_update/tick_update/etc
    // so an error for a DIFFERENT symbol or resolution (e.g. a background
    // res=1 fetch unrelated to what's actually on screen) never overwrites
    // the error bar on a panel that's rendering perfectly fine. Errors with
    // no symbol/resolution at all (genuine connection-level failures) still
    // always apply, since there's nothing to filter them against.
    socket.on("error", (e) => {
      if (e && (e.symbol != null || e.resolution != null) && !matchesActive(e)) return;
      setError(e?.message || String(e));
      setLoading(false);
    });

    startPollFallback();

    return () => {
      socket.disconnect();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
    // Mount-only: socket and poll setup runs once. All state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── refresh — user clicks Refresh, changes symbol, or changes timeframe ───
  const refresh = useCallback(async (symbol, resolution) => {
    setError(null);
    setLoading(true);
    const reqId = ++latestRequestIdRef.current;

    if (symbol != null) {
      activeSymbolRef.current = symbol;
      // DUAL-PANEL FIX: tell server which symbol this socket is watching so
      // candle-finalize auto-broadcasts only reach the correct panel.
      if (socketRef.current?.connected) socketRef.current.emit("set_symbol", symbol);
    }
    if (resolution != null) {
      const numRes = Number(resolution);
      activeResolutionRef.current = numRes;
      if (socketRef.current?.connected) socketRef.current.emit("set_resolution", numRes);
    }

    const params = {};
    if (symbol != null) params.symbol = symbol;
    if (resolution != null) params.resolution = resolution;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // DUAL-PANEL FIX: send this socket's id so server emits chart_update
        // only to THIS socket — not the whole resolution room — preventing the
        // other panel's chart from being overwritten.
        const socketId = socketRef.current?.id || null;
        const res = await axios.post(`${BACKEND}/api/chart/refresh`, { socketId }, {
          params,
          timeout: 25_000,
        });

        if (reqId !== latestRequestIdRef.current) return;

        if (!res.data?.candles?.length) {
          if (attempt < MAX_ATTEMPTS - 1) { await sleep(2000); continue; }
          setLoading(false);
          return;
        }

        if (resolution == null && res.data?.resolution != null)
          activeResolutionRef.current = Number(res.data.resolution);
        if (res.data?.symbol)
          activeSymbolRef.current = res.data.symbol;

        setChartData(res.data);
        hasDataRef.current = true;
        lastSocketUpdateRef.current = Date.now();
        setLoading(false);
        setError(null);
        return;
      } catch (e) {
        if (reqId !== latestRequestIdRef.current) return;
        if (attempt < MAX_ATTEMPTS - 1) { await sleep(2000); continue; }
        setError(e.response?.data?.error || e.message);
        setLoading(false);
      }
    }
    // Mount-only: socket and poll setup runs once. All state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── setUnderlying — Auto-ATM side-channel control ──────────────────────────
  // Call with option symbol string to start receiving underlying_tick events.
  // Call with null to stop (toggle off, symbol changed, panel unmounted).
  const setUnderlying = useCallback((optionSymbolOrNull) => {
    if (underlyingOptionSymbolRef.current === (optionSymbolOrNull || null)) return;
    underlyingOptionSymbolRef.current = optionSymbolOrNull || null;
    if (!optionSymbolOrNull) setUnderlyingTick(null);
    if (socketRef.current?.connected) socketRef.current.emit("set_underlying", optionSymbolOrNull || null);
  }, []);

  return { chartData, connected, loading, error, refresh, tickStreamActive, ticksFlowing, underlyingTick, setUnderlying };
}