/**
 * BacktestPage.js  –  Chartink-style Backtest History
 *
 * Logic: MW Zone · Red Candle · Close < EMA9L · within Fib 0.618 / 0.382 zone
 *
 * Views:
 *   STOCKS  – grid (stock × time-slot) with HOT/NEAR badge per cell
 *   BARS    – bar chart (time-slot → count), coloured per stock
 *
 * Date ranges: Last 7 / 15 / 30 / 60 / 90 days + Custom
 * On cell click → opens /charts in new tab with fibDrawing params
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import { useNavigate } from "react-router-dom";
import { createBackendSocket } from "../utils/backendSocket";
import { BACKEND } from "../config";
import { useTheme } from "../App";
import "../styles/BacktestPage.css";
import * as XLSX from "xlsx";

// ── Timeframes ────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { value: 1, label: "1m" },
  { value: 3, label: "3m" },
  { value: 5, label: "5m" },
  { value: 15, label: "15m" },
  { value: 60, label: "1h" },
  { value: 1440, label: "1D" },
  { value: 10080, label: "1W" },
];

// ── Date range presets ────────────────────────────────────────────────────────
const DATE_PRESETS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 15 days", days: 15 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 60 days", days: 60 },
  { label: "Last 90 days", days: 90 },
];

// ── Palette for bar chart ─────────────────────────────────────────────────────
const STOCK_COLORS = [
  "#4CAF50", "#2196F3", "#FF9800", "#E91E63", "#9C27B0",
  "#00BCD4", "#F44336", "#FFEB3B", "#8BC34A", "#FF5722",
  "#3F51B5", "#009688", "#FFC107", "#607D8B", "#795548",
  "#FF4081", "#00E5FF", "#76FF03", "#FF6D00", "#AA00FF",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function toIST(tsMs) {
  if (!tsMs) return "—";
  const d = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mon} ${hh}:${mm}`;
}

function slotKey(tsMs) {
  if (!tsMs) return "";
  const d = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mon}\n${hh}:${mm}`;
}

function tickerOf(sym) {
  const idx = (sym || "").indexOf(":");
  return idx >= 0 ? sym.slice(idx + 1) : sym;
}

function openChart(hit, resolution) {
  const fibDrawing = encodeURIComponent(JSON.stringify({
    p1Price: hit.mwToPrice,
    p1Time: Math.round(hit.mwTimestamp / 1000),
    p2Price: hit.mwFromPrice,
    p2Time: Math.round(hit.mwFromTime / 1000),
  }));
  const params = new URLSearchParams({
    symbol: hit.symbol,
    resolution: String(resolution),
    waveFrom: String(hit.mwFromTime),
    waveTo: String(hit.mwTimestamp),
    fibDrawing,
  });
  window.open(`/charts?${params.toString()}`, "_blank");
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function BacktestPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const socketRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const gridScrollRef = useRef(null);

  const [resolution, setResolution] = useState(15);
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(null);
  const [hits, setHits] = useState([]);
  const [phase, setPhase] = useState("idle");

  // date-range
  const [selectedPreset, setSelectedPreset] = useState(15); // days
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  // view
  const [view, setView] = useState("stocks"); // "stocks" | "bars"
  const [stockSearch, setStockSearch] = useState("");

  // MW filter: null = all, 0 = current MW, -1 / -2 / ... = previous
  const [mwFilter, setMwFilter] = useState(null);
  // Full chain index from backend — all scanned MWs, even those with 0 hits
  const [chainIndex, setChainIndex] = useState([]);

  // ── computed lookbackDays — CLIENT-SIDE VIEW FILTER only ─────────────────
  // Not sent to backend. Backend always scans full 90d history.
  // This just controls which hits are shown in the grid.
  const viewCutoffMs = useMemo(() => {
    if (showCustom && customFrom && customTo) {
      const from = new Date(customFrom).getTime();
      const to = new Date(customTo);
      to.setHours(23, 59, 59, 999);
      return { from, to: to.getTime() };
    }
    const cutoff = Date.now() - selectedPreset * 86400 * 1000;
    return { from: cutoff, to: Date.now() };
  }, [showCustom, customFrom, customTo, selectedPreset]);

  // ── Fetch initial status / results ───────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const s = await fetch(`${BACKEND}/api/backtest/status`).then(r => r.json());
      setStatus(s);
      if (s.running) setPhase("running");
    } catch { }
  }, []);

  const fetchResults = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/backtest/results`).then(r => r.json());
      if (r.results?.length) { setHits(r.results); setPhase("done"); }
      if (r.chainIndex?.length) setChainIndex(r.chainIndex);
    } catch { }
  }, []);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchStatus();
    fetchResults();

    const sock = createBackendSocket();
    socketRef.current = sock;

    sock.on("backtest_start", (d) => { setPhase("running"); setHits([]); setProgress({ total: d.total, done: 0, hits: 0 }); });
    sock.on("backtest_progress", (d) => { setProgress({ total: d.total, done: d.done, hits: d.hits }); });
    sock.on("backtest_hit", (h) => { setHits(prev => [...prev, h]); });
    sock.on("backtest_complete", () => {
      setPhase("done"); setProgress(null); fetchStatus(); fetchResults();
    });

    return () => { sock.disconnect(); };
  }, [fetchStatus, fetchResults]);

  // ── Run / Stop ────────────────────────────────────────────────────────────
  async function handleRun() {
    if (phase === "running") {
      await fetch(`${BACKEND}/api/backtest/stop`, { method: "POST" });
      setPhase("idle"); setProgress(null);
      return;
    }
    setHits([]); setPhase("running"); setProgress(null); setMwFilter(null); setChainIndex([]);
    try {
      await fetch(`${BACKEND}/api/backtest/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),  // no lookbackDays — backend always scans 90d
      });
    } catch (e) {
      console.error("[Backtest] trigger failed:", e);
      setPhase("idle");
    }
  }

  // ── Available MW numbers — sourced from backend chainIndex (full scan list) ─
  // chainIndex has every MW that was scanned, even those with 0 hits.
  // Fall back to deriving from hits if chainIndex not yet loaded.
  const availableMWs = useMemo(() => {
    if (chainIndex.length > 0) {
      // Backend provided the authoritative list — already sorted 0, -1, -2 ...
      return chainIndex; // shape: { mwNo, hitCount, stockCount }
    }
    // Fallback: derive from hits (before chainIndex arrives, e.g. mid-run)
    const map = new Map();
    for (const h of hits) {
      if (!map.has(h.mwNo)) {
        map.set(h.mwNo, { mwNo: h.mwNo, hitCount: 0, stockCount: 0, _stocks: new Set() });
      }
      const e = map.get(h.mwNo);
      e.hitCount++;
      e._stocks.add(h.symbol);
      e.stockCount = e._stocks.size;
    }
    return [...map.values()]
      .sort((a, b) => b.mwNo - a.mwNo)
      .map(({ mwNo, hitCount, stockCount }) => ({ mwNo, hitCount, stockCount }));
  }, [chainIndex, hits]);

  // ── Hits filtered by MW + client-side date window ────────────────────────
  const filteredHits = useMemo(() => {
    let result = mwFilter === null ? hits : hits.filter(h => h.mwNo === mwFilter);
    // Apply client-side date window (instant, no re-scan needed)
    result = result.filter(h => h.candleTime >= viewCutoffMs.from && h.candleTime <= viewCutoffMs.to);
    return result;
  }, [hits, mwFilter, viewCutoffMs]);


  // eslint-disable-next-line no-unused-vars
  const { slots, stockRows, slotCountMap } = useMemo(() => {
    // filter by search
    const filtered = filteredHits.filter(h =>
      !stockSearch.trim() ||
      tickerOf(h.symbol).toLowerCase().includes(stockSearch.trim().toLowerCase())
    );

    // Unique time slots sorted newest → oldest
    const slotSet = new Set(filtered.map(h => h.candleTime));
    const slots = [...slotSet].sort((a, b) => b - a);

    // Per-stock: { ticker, symbol, count, cells: { slotKey → [hits] } }
    const stockMap = new Map();
    for (const h of filtered) {
      const t = tickerOf(h.symbol);
      if (!stockMap.has(t)) stockMap.set(t, { ticker: t, symbol: h.symbol, count: 0, cells: new Map() });
      const entry = stockMap.get(t);
      entry.count++;
      if (!entry.cells.has(h.candleTime)) entry.cells.set(h.candleTime, []);
      entry.cells.get(h.candleTime).push(h);
    }

    // Sort stocks by most recent hit time (newest first), then alphabetically for ties
    const stockRows = [...stockMap.values()].sort((a, b) => {
      const aLatest = Math.max(...[...a.cells.keys()]);
      const bLatest = Math.max(...[...b.cells.keys()]);
      if (bLatest !== aLatest) return bLatest - aLatest;
      return a.ticker.localeCompare(b.ticker);
    });

    // Slot → count (for bar chart)
    const slotCountMap = new Map();
    const slotStockMap = new Map();
    for (const h of filtered) {
      const k = h.candleTime;
      slotCountMap.set(k, (slotCountMap.get(k) || 0) + 1);
      if (!slotStockMap.has(k)) slotStockMap.set(k, new Map());
      const t = tickerOf(h.symbol);
      slotStockMap.get(k).set(t, (slotStockMap.get(k).get(t) || 0) + 1);
    }

    return { slots, stockRows, slotCountMap, slotStockMap };
  }, [filteredHits, stockSearch]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const hotCount = filteredHits.filter(h => h.zone === "HOT").length;
  const nearCount = filteredHits.filter(h => h.zone === "NEAR").length;
  const symCount = new Set(filteredHits.map(h => h.symbol)).size;
  const isRunning = phase === "running";
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const tfLabel = TIMEFRAMES.find(t => t.value === resolution)?.label || String(resolution);

  // ── Download ──────────────────────────────────────────────────────────────
  function handleDownload() {
    if (!filteredHits.length) return;
    const rows = filteredHits.map(h => ({
      "Symbol": tickerOf(h.symbol),
      "Candle Time": toIST(h.candleTime),
      "Zone": h.zone,
      "MW Dir": h.mwDir === "bull" ? "Bull" : "Bear",
      "Open": h.open, "High": h.high, "Low": h.low, "Close": h.close,
      "EMA9L": h.ema9L, "Fib Lvl": h.zone === "HOT" ? h.fib618 : h.fib382,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Backtest");
    XLSX.writeFile(wb, `backtest_${tfLabel}_${selectedPreset}d.xlsx`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="bt-page">

      {/* ── Topbar ── */}
      <div className="bt-topbar">
        <button className="bt-back-btn" onClick={() => navigate("/")} title="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>

        <div className="bt-logo">
          <img src="/tg-levels-logo.png" alt="TG Levels" className="bt-logo-img" />
        </div>

        <div className="bt-title-wrap">
          <span className="bt-title">Backtest</span>
          <span className="bt-subtitle">MW Zone · Red Candle · EMA9L</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Timeframe */}
        <div className="bt-tf-group">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf.value}
              className={`bt-tf-btn ${resolution === tf.value ? "active" : ""}`}
              onClick={() => !isRunning && setResolution(tf.value)}
              disabled={isRunning}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Run / Stop */}
        <button
          className={`bt-run-btn ${isRunning ? "bt-run-btn--stop" : "bt-run-btn--run"}`}
          onClick={handleRun}
        >
          {isRunning
            ? <><span className="bt-spinner" />Stop</>
            : <><span className="bt-run-icon">▶</span>Run {tfLabel}</>
          }
        </button>

        <button className="bt-theme-btn" onClick={toggleTheme} title="Toggle theme">
          {theme === "dark" ? "☀" : "🌙"}
        </button>
      </div>

      {/* ── Progress bar ── */}
      <div className="bt-progress-wrap">
        <div className="bt-progress-bar"
          style={{ width: isRunning ? `${pct}%` : phase === "done" ? "100%" : "0%" }} />
      </div>

      {/* ── BACKTEST HISTORY HEADER (below topbar, always visible after run) ── */}
      {(hits.length > 0 || isRunning) && (
        <div className="bth-header">
          {/* date preset row */}
          <div className="bth-preset-row">
            <span className="bth-label">BACKTEST HISTORY</span>
            <div className="bth-presets">
              {DATE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className={`bth-preset-btn ${!showCustom && selectedPreset === p.days ? "active" : ""}`}
                  onClick={() => { setSelectedPreset(p.days); setShowCustom(false); }}
                >
                  {p.label}
                </button>
              ))}
              <button
                className={`bth-preset-btn ${showCustom ? "active" : ""}`}
                onClick={() => setShowCustom(v => !v)}
              >
                Custom
              </button>
            </div>

            <div style={{ flex: 1 }} />

            {/* MW filter */}
            {availableMWs.length > 1 && (
              <div className="bth-mw-filter-wrap">
                <select
                  className="bth-mw-filter-select"
                  value={mwFilter === null ? "" : String(mwFilter)}
                  onChange={e => setMwFilter(e.target.value === "" ? null : parseInt(e.target.value))}
                >
                  <option value="">All MWs ({filteredHits.length} hits)</option>
                  {availableMWs.map(mw => {
                    const label = mw.mwNo === 0
                      ? `MW 0 · Current`
                      : mw.mwNo === -1
                        ? `MW -1 · Previous`
                        : `MW ${mw.mwNo}`;
                    const hitInfo = mw.hitCount > 0
                      ? `${mw.hitCount} hits · ${mw.stockCount} stocks`
                      : `0 hits · ${mw.stockCount} stocks`;
                    return (
                      <option key={mw.mwNo} value={String(mw.mwNo)}>
                        {label} ({hitInfo})
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* stock search */}
            <div className="bth-stock-search-wrap">
              <svg className="bth-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={stockSearch}
                onChange={e => setStockSearch(e.target.value)}
                placeholder="Search stock…"
                className="bth-stock-search"
              />
              {stockSearch && (
                <button className="bth-search-clear" onClick={() => setStockSearch("")}>✕</button>
              )}
            </div>

            {/* Bars / Stocks toggle */}
            <div className="bth-view-toggle">
              <button className={`bth-vt-btn ${view === "bars" ? "active" : ""}`}
                onClick={() => setView("bars")}>Bars</button>
              <button className={`bth-vt-btn ${view === "stocks" ? "active" : ""}`}
                onClick={() => setView("stocks")}>Stocks</button>
            </div>

            {/* Download */}
            <button className="bth-download-btn" onClick={handleDownload} disabled={!filteredHits.length}>
              ⬇ Download
            </button>
          </div>

          {/* Custom date row */}
          {showCustom && (
            <div className="bth-custom-row">
              <label className="bth-custom-label">From</label>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="bth-date-input" max={customTo || undefined} />
              <label className="bth-custom-label">To</label>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="bth-date-input" min={customFrom || undefined} />
              <span className="bth-custom-note">Max 90 days</span>
            </div>
          )}

          {/* Matched stats bar */}
          <div className="bth-stats-bar">
            <span className="bth-dot" />
            <span className="bth-stat-item">
              <span className="bth-stat-val">{symCount}</span>
              <span className="bth-stat-lbl"> stocks</span>
            </span>
            <span className="bth-stat-sep">·</span>
            <span className="bth-stat-item">
              <span className="bth-stat-val">{filteredHits.length}</span>
              <span className="bth-stat-lbl"> bars</span>
            </span>
            <span className="bth-stat-sep">·</span>
            <span className="bth-stat-item bth-hot">
              <span className="bth-stat-val">{hotCount}</span>
              <span className="bth-stat-lbl"> HOT</span>
            </span>
            <span className="bth-stat-sep">·</span>
            <span className="bth-stat-item bth-near">
              <span className="bth-stat-val">{nearCount}</span>
              <span className="bth-stat-lbl"> NEAR</span>
            </span>
            {status?.lastDurationMs && (
              <>
                <span className="bth-stat-sep">·</span>
                <span className="bth-stat-item">
                  <span className="bth-stat-val">{(status.lastDurationMs / 1000).toFixed(1)}s</span>
                </span>
              </>
            )}
            <span className="bth-stat-sep">·</span>
            <span className="bth-dot" />
            <span className="bth-stat-item bth-hot">
              <span className="bth-stat-val">0.618</span>
              <span className="bth-stat-lbl">HOT</span>
            </span>
            <span className="bth-stat-sep">·</span>
            <span className="bth-dot" />
            <span className="bth-stat-item bth-hot">
              <span className="bth-stat-val">0.382</span>
              <span className="bth-stat-lbl">NEAR</span>
            </span>
          </div>
        </div>
      )}

      {/* ── Body ── */}
      <div className="bt-body">

        {/* Idle */}
        {phase === "idle" && hits.length === 0 && (
          <div className="bt-idle">
            <div className="bt-idle-icon">⚡</div>
            <div className="bt-idle-title">Ready to scan</div>
            <div className="bt-idle-desc">
              Scans all symbols for red candles closing below EMA9 Low<br />
              inside the Mother Wave 0.618 (HOT) or 0.382 (NEAR) zone,<br />
              only on candles <strong>after</strong> the MW tip.
            </div>
            {/* preset buttons in idle too */}
            <div className="bt-idle-presets">
              {DATE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className={`bth-preset-btn ${!showCustom && selectedPreset === p.days ? "active" : ""}`}
                  onClick={() => { setSelectedPreset(p.days); setShowCustom(false); }}
                >
                  {p.label}
                </button>
              ))}
              <button
                className={`bth-preset-btn ${showCustom ? "active" : ""}`}
                onClick={() => setShowCustom(v => !v)}
              >
                Custom
              </button>
            </div>
            {showCustom && (
              <div className="bth-custom-row">
                <label className="bth-custom-label">From</label>
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="bth-date-input" />
                <label className="bth-custom-label">To</label>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="bth-date-input" />
                <span className="bth-custom-note">Max 90 days</span>
              </div>
            )}
            <button className="bt-idle-btn" onClick={handleRun}>
              ▶ Run Backtest ({tfLabel}) · 90d full scan
            </button>
          </div>
        )}

        {/* Scanning + no hits yet */}
        {isRunning && hits.length === 0 && (
          <div className="bt-scanning">
            <div className="bt-scan-spinner" />
            <div className="bt-scan-text">
              Scanning {progress?.done ?? 0} / {progress?.total ?? "…"} symbols…
            </div>
          </div>
        )}

        {/* Results */}
        {hits.length > 0 && (
          view === "stocks"
            ? <SplitStocksGrid filteredHits={filteredHits} stockRows={stockRows} slots={slots} resolution={resolution} stockSearch={stockSearch} />
            : <BarsChart hits={filteredHits} stockRows={stockRows} slots={slots} resolution={resolution} />
        )}
      </div>
    </div>
  );
}

// ── SPLIT STOCKS GRID (HOT 0.618 | NEAR 0.382) ────────────────────────────────
function SplitStocksGrid({ filteredHits, stockRows, slots, resolution, stockSearch }) {
  // Build separate hit collections per zone
  const hotHits = filteredHits.filter(h => h.zone === "HOT");
  const nearHits = filteredHits.filter(h => h.zone === "NEAR");

  // Build zone-specific stockRows & slots
  function buildZoneData(zoneHits) {
    const filtered = zoneHits.filter(h =>
      !stockSearch?.trim() ||
      tickerOf(h.symbol).toLowerCase().includes(stockSearch.trim().toLowerCase())
    );
    const slotSet = new Set(filtered.map(h => h.candleTime));
    const zoneSlots = [...slotSet].sort((a, b) => b - a);

    const stockMap = new Map();
    for (const h of filtered) {
      const t = tickerOf(h.symbol);
      if (!stockMap.has(t)) stockMap.set(t, { ticker: t, symbol: h.symbol, count: 0, cells: new Map() });
      const entry = stockMap.get(t);
      entry.count++;
      if (!entry.cells.has(h.candleTime)) entry.cells.set(h.candleTime, []);
      entry.cells.get(h.candleTime).push(h);
    }
    const zoneRows = [...stockMap.values()].sort((a, b) => {
      const aLatest = Math.max(...[...a.cells.keys()]);
      const bLatest = Math.max(...[...b.cells.keys()]);
      if (bLatest !== aLatest) return bLatest - aLatest;
      return a.ticker.localeCompare(b.ticker);
    });
    return { zoneSlots, zoneRows };
  }

  const { zoneSlots: hotSlots, zoneRows: hotRows } = buildZoneData(hotHits);
  const { zoneSlots: nearSlots, zoneRows: nearRows } = buildZoneData(nearHits);

  if (!hotRows.length && !nearRows.length) {
    return <div className="bt-no-data">No matching hits.</div>;
  }

  return (
    <div className="bth-split-outer">
      {/* ── 0.618 HOT Panel ── */}
      <div className="bth-zone-panel bth-zone-hot">
        <div className="bth-zone-header bth-zone-header--hot">
          <span className="bth-zone-fib">0.618</span>
          <span className="bth-zone-label">HOT Zone</span>
          <span className="bth-zone-count">{hotRows.length} stocks · {hotHits.length} hits</span>
        </div>
        {hotRows.length === 0
          ? <div className="bt-no-data bt-no-data--small">No HOT hits in this range</div>
          : (
            <div className="bth-grid-wrap">
              <table className="bth-grid-table">
                <thead>
                  <tr>
                    <th className="bth-col-stock">STOCK</th>
                    {hotSlots.map(s => {
                      const parts = slotKey(s).split("\n");
                      return (
                        <th key={s} className="bth-col-slot">
                          <div className="bth-slot-date">{parts[0]}</div>
                          <div className="bth-slot-time">{parts[1]}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {hotRows.map(row => (
                    <tr key={row.ticker} className="bth-grid-row">
                      <td className="bth-stock-cell">
                        <span className="bth-stock-name">{row.ticker}</span>
                        <span className="bth-stock-count bth-stock-count--hot">{row.count}</span>
                      </td>
                      {hotSlots.map(s => {
                        const cellHits = row.cells.get(s);
                        if (!cellHits?.length) return <td key={s} className="bth-empty-cell" />;
                        return (
                          <td key={s} className="bth-hit-cell-wrap">
                            <button
                              className="bth-hit-badge bth-badge-hot"
                              onClick={() => openChart(cellHits[0], resolution)}
                              title={`${row.ticker} @ ${toIST(s)} — click to open chart`}
                            >
                              HOT
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* ── Divider ── */}
      <div className="bth-split-divider" />

      {/* ── 0.382 NEAR Panel ── */}
      <div className="bth-zone-panel bth-zone-near">
        <div className="bth-zone-header bth-zone-header--near">
          <span className="bth-zone-fib">0.382</span>
          <span className="bth-zone-label">NEAR Zone</span>
          <span className="bth-zone-count">{nearRows.length} stocks · {nearHits.length} hits</span>
        </div>
        {nearRows.length === 0
          ? <div className="bt-no-data bt-no-data--small">No NEAR hits in this range</div>
          : (
            <div className="bth-grid-wrap">
              <table className="bth-grid-table">
                <thead>
                  <tr>
                    <th className="bth-col-stock">STOCK</th>
                    {nearSlots.map(s => {
                      const parts = slotKey(s).split("\n");
                      return (
                        <th key={s} className="bth-col-slot">
                          <div className="bth-slot-date">{parts[0]}</div>
                          <div className="bth-slot-time">{parts[1]}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {nearRows.map(row => (
                    <tr key={row.ticker} className="bth-grid-row">
                      <td className="bth-stock-cell">
                        <span className="bth-stock-name">{row.ticker}</span>
                        <span className="bth-stock-count bth-stock-count--near">{row.count}</span>
                      </td>
                      {nearSlots.map(s => {
                        const cellHits = row.cells.get(s);
                        if (!cellHits?.length) return <td key={s} className="bth-empty-cell" />;
                        return (
                          <td key={s} className="bth-hit-cell-wrap">
                            <button
                              className="bth-hit-badge bth-badge-near"
                              onClick={() => openChart(cellHits[0], resolution)}
                              title={`${row.ticker} @ ${toIST(s)} — click to open chart`}
                            >
                              NEAR
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── BARS CHART ────────────────────────────────────────────────────────────────
function BarsChart({ hits, stockRows, slots, resolution }) {
  if (!slots.length) return <div className="bt-no-data">No matching hits.</div>;

  // Map stock ticker → colour index
  const colorMap = new Map();
  stockRows.forEach((r, i) => colorMap.set(r.ticker, STOCK_COLORS[i % STOCK_COLORS.length]));

  // Per-slot stacked data
  const maxCount = Math.max(...slots.map(s => hits.filter(h => h.candleTime === s).length), 1);
  const chartHeight = 280;

  return (
    <div className="bth-bars-outer">
      <div className="bth-bars-hint">Click on bars to view stock details filtered at the given time</div>
      <div className="bth-bars-chart-wrap">
        {/* Y axis */}
        <div className="bth-bars-yaxis">
          {[maxCount, Math.round(maxCount / 2), 0].map(v => (
            <div key={v} className="bth-bars-ylabel">{v}</div>
          ))}
        </div>

        {/* Chart area */}
        <div className="bth-bars-area">
          {/* Grid lines */}
          <div className="bth-bars-grid">
            {[0, 1, 2].map(i => <div key={i} className="bth-bars-gridline" />)}
          </div>

          {/* Bars */}
          <div className="bth-bars-inner">
            {slots.map(s => {
              const slotHits = hits.filter(h => h.candleTime === s);
              const total = slotHits.length;
              const barH = Math.round((total / maxCount) * chartHeight);

              // Group by stock for stacking
              const byStock = new Map();
              for (const h of slotHits) {
                const t = tickerOf(h.symbol);
                if (!byStock.has(t)) byStock.set(t, []);
                byStock.get(t).push(h);
              }

              const parts = slotKey(s).split("\n");

              return (
                <div key={s} className="bth-bar-col">
                  <div
                    className="bth-bar-stack"
                    style={{ height: `${barH}px` }}
                    title={`${parts[0]} ${parts[1]} — ${total} hits`}
                  >
                    {[...byStock.entries()].map(([ticker, hs]) => {
                      const segH = Math.max(2, Math.round((hs.length / total) * barH));
                      return (
                        <div
                          key={ticker}
                          className="bth-bar-seg"
                          style={{ height: `${segH}px`, background: colorMap.get(ticker) || "#888" }}
                          onClick={() => openChart(hs[0], resolution)}
                          title={`${ticker}: ${hs.length} hit(s)`}
                        />
                      );
                    })}
                  </div>
                  <div className="bth-bar-label">
                    <span className="bth-bar-date">{parts[0]}</span>
                    <span className="bth-bar-time">{parts[1]}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="bth-legend">
        {stockRows.slice(0, 30).map(r => (
          <div key={r.ticker} className="bth-legend-item">
            <span className="bth-legend-dot" style={{ background: colorMap.get(r.ticker) }} />
            <span className="bth-legend-name">{r.ticker}</span>
            <span className="bth-legend-count">{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}