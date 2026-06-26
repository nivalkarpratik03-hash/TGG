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
    if (dow === 6) return istMin >= (9 * 60) && istMin < (14 * 60);
    return istMin >= (9 * 60) && istMin < (23 * 60 + 30);
  }
  // NSE/BSE: Mon–Fri 09:15–15:30 only
  if (dow === 6) return false;
  return istMin >= (9 * 60 + 15) && istMin < (15 * 60 + 30);
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
  // Auto-ATM side-channel: LTP of the underlying index/equity, only populated
  // while setUnderlying(optionSymbol) has been called with a non-null value.
  // { symbol, ltp, timestamp } | null — independent of chartData/candles.
  const [underlyingTick, setUnderlyingTick] = useState(null);

  const socketRef = useRef(null);
  const activeResolutionRef = useRef(null);
  const activeSymbolRef = useRef(null);
  const underlyingOptionSymbolRef = useRef(null); // last symbol passed to setUnderlying
  const latestRequestIdRef = useRef(0);
  const lastSocketUpdateRef = useRef(0);
  const hasDataRef = useRef(false);
  const pollTimerRef = useRef(null);

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
          setLoading(false);
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
      // Auto-ATM: re-register the underlying side-channel after a reconnect —
      // the server's socketUnderlyings map is keyed by socket.id, which is
      // fresh after every reconnect, so this would otherwise silently drop.
      if (underlyingOptionSymbolRef.current) socket.emit("set_underlying", underlyingOptionSymbolRef.current);
      // Only fall back to a GET fetch if there's genuinely no data and nothing is in-flight.
      // ChartsPage calls refresh() (POST) on mount which already covers the initial load.
      // The latestRequestIdRef check inside fetchChart prevents stale responses from landing.
      if (!hasDataRef.current && latestRequestIdRef.current === 0) {
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
    });

    // Auto-ATM side-channel — pure LTP passthrough, independent of chartData.
    // Only arrives while setUnderlying() has registered a symbol server-side.
    socket.on("underlying_tick", (d) => {
      if (!d?.symbol) return;
      setUnderlyingTick(d);
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

    socket.on("market_status", (d) => {
      if (d?.tickStreamActive != null) setTickStreamActive(!!d.tickStreamActive);
      if (d?.ticksFlowing != null) setTicksFlowing(!!d.ticksFlowing);
    });

    socket.on("error", (e) => {
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
  // Pass the OPTION symbol currently on the chart to start/refresh the
  // underlying LTP feed (server derives the underlying itself), or null/
  // undefined to stop it (toggle off, switched to a non-option symbol, etc).
  // Cheap to call on every render — it no-ops if the symbol hasn't changed.
  const setUnderlying = useCallback((optionSymbolOrNull) => {
    if (underlyingOptionSymbolRef.current === (optionSymbolOrNull || null)) return;
    underlyingOptionSymbolRef.current = optionSymbolOrNull || null;
    if (!optionSymbolOrNull) setUnderlyingTick(null);
    if (socketRef.current?.connected) socketRef.current.emit("set_underlying", optionSymbolOrNull || null);
  }, []);

  return {
    chartData, connected, loading, error, refresh, tickStreamActive, ticksFlowing,
    underlyingTick, setUnderlying,
  };
}