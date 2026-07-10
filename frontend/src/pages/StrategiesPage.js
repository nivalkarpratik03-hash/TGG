// StrategiesPage.js
// Route: /strategies
//
// Data flow:
//   - GET /api/scanner/status       → strategies list + symbolCount
//   - GET /api/scanner/results/:id  → all results for chosen strategy
//   - Socket: scanner_complete → refetch
//
// r.motherwave is now the full { wave, fibLevels, invalidation } shape.
// All field access goes through r.motherwave.wave.*
//
// Per-stock assignment (Watch / S1 / S2 / S3 / Skip):
//   Stored in localStorage under key "tgg_watchlist".
//   Format: { [symbol]: "watch" | "s1" | "s2" | "s3" | "skip" | null }
//   Watchlist panel shows all stocks tagged "watch", "s1", "s2", or "s3".

import React, {
  useState, useEffect, useCallback, useRef, useMemo
} from "react";
import { useNavigate } from "react-router-dom";
import { createBackendSocket } from "../utils/backendSocket";
import { BACKEND } from "../config";
import { useTheme } from "../App";
import "../styles/StrategiesPage.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n, d = 2) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function tickerOf(sym) {
  const idx = (sym || "").indexOf(":");
  return idx >= 0 ? sym.slice(idx + 1) : sym;
}
function exchangeOf(sym) {
  const idx = (sym || "").indexOf(":");
  return idx >= 0 ? sym.slice(0, idx) : "";
}
function stageLabel(r) {
  if (r.error) return { cls: "error", text: "Error" };
  if (r.patternStage === "s3_complete") return { cls: "s3", text: "S3 ✓" };
  if (r.patternStage === "s2") return { cls: "s2", text: "S2 →" };
  if (r.patternStage === "s1") return { cls: "s1", text: "S1" };
  if (r.patternStage === "trapzone") return { cls: "mw", text: "TrapZone" };
  if (r.patternStage === "motherwave") return { cls: "mw", text: "Motherwave" };
  return { cls: "none", text: "—" };
}

// ─── MW field accessors ───────────────────────────────────────────────────────
// r.motherwave is { wave, fibLevels, invalidation }
function mwWave(r) { return r.motherwave?.wave || null; }
function isMWBull(r) { return mwWave(r)?.dir === "bull"; }
function waveSize(r) {
  const w = mwWave(r);
  if (!w) return 0;
  return Math.abs((w.fromPrice || 0) - (w.toPrice || 0));
}

// Fib price: to + ratio*(from-to)
function fibPrice(wave, ratio) {
  return wave.toPrice + ratio * (wave.fromPrice - wave.toPrice);
}

function getZoneTray(r) {
  const w = mwWave(r);
  if (!r.trapZone || !w) return "other";
  const last = r.lastCandle?.close;
  if (!last) return "other";
  const span = Math.abs(w.fromPrice - w.toPrice);
  const tol = span * 0.05;
  if (Math.abs(last - fibPrice(w, 0.618)) <= tol) return "hot618";
  if (Math.abs(last - fibPrice(w, 0.382)) <= tol) return "near382";
  const tip = fibPrice(w, 0);
  const ret = fibPrice(w, 0.236);
  const trapHigh = Math.max(tip, ret);
  const trapLow = Math.min(tip, ret);
  if (last >= trapLow && last <= trapHigh) return "trap";
  return "other";
}

// Build chart URL — mw is the full { wave, fibLevels, invalidation } object
function buildChartUrl(symbol, timeframe, mw) {
  if (!mw || !mw.wave) {
    return `/charts?${new URLSearchParams({ symbol, resolution: String(timeframe) })}`;
  }
  const w = mw.wave;
  const fromMs = w.fromTime;
  const toMs = w.toTime;
  const fibDrawing = encodeURIComponent(JSON.stringify({
    p1Price: w.toPrice, p1Time: Math.round(toMs / 1000),
    p2Price: w.fromPrice, p2Time: Math.round(fromMs / 1000),
  }));
  return `/charts?${new URLSearchParams({
    symbol, resolution: String(timeframe),
    waveFrom: String(fromMs), waveTo: String(toMs), fibDrawing,
  })}`;
}
function openChart(symbol, timeframe, mw) {
  window.open(buildChartUrl(symbol, timeframe, mw), "_blank");
}

// ─── Watchlist localStorage helpers ──────────────────────────────────────────
const WL_KEY = "tgg_watchlist";
function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || "{}"); }
  catch { return {}; }
}
function saveWatchlist(wl) {
  localStorage.setItem(WL_KEY, JSON.stringify(wl));
}

// ─── Assignment options ───────────────────────────────────────────────────────
const ASSIGN_OPTIONS = [
  { value: null, label: "—", title: "No assignment" },
  { value: "watch", label: "👁 Watch", title: "Add to watchlist, no specific pattern yet" },
  { value: "s1", label: "S1", title: "Watching for S1 trigger" },
  { value: "s2", label: "S2", title: "S1 formed, watching for S2" },
  { value: "s3", label: "S3", title: "S2 confirmed, waiting for S3 entry" },
  { value: "skip", label: "✕ Skip", title: "Skip this stock" },
];

// ─── TIMEFRAMES ───────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { value: 1, label: "1m" },
  { value: 3, label: "3m" },
  { value: 5, label: "5m" },
  { value: 15, label: "15m" },
  { value: 60, label: "1h" },
  { value: 1440, label: "1D" },
  { value: 10080, label: "1W" },
];

const STAGE_FILTERS = [
  { key: "all", label: "All" },
  { key: "signals", label: "Full Signal" },
  { key: "partial", label: "Watching" },
  { key: "s1", label: "S1" },
  { key: "mw", label: "Motherwave" },
];

// ─── AssignDropdown — per-stock action selector ───────────────────────────────
function AssignDropdown({ symbol, watchlist, onChange }) {
  const current = watchlist[symbol] || null;
  const opt = ASSIGN_OPTIONS.find(o => o.value === current) || ASSIGN_OPTIONS[0];

  function handleChange(e) {
    const val = e.target.value === "" ? null : e.target.value;
    onChange(symbol, val);
    e.stopPropagation();
  }

  return (
    <div
      className={`sp-assign-wrap ${current ? `sp-assign-${current}` : ""}`}
      onClick={e => e.stopPropagation()}
      title="Assign this stock to your watchlist"
    >
      <select
        className="sp-assign-select"
        value={current || ""}
        onChange={handleChange}
      >
        {ASSIGN_OPTIONS.map(o => (
          <option key={String(o.value)} value={o.value || ""} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── MWCard — one stock in the motherwave dashboard ───────────────────────────
function MWCard({ r, timeframe, watchlist, onAssign }) {
  const bull = isMWBull(r);
  const size = waveSize(r);
  const assignment = watchlist[r.symbol] || null;

  return (
    <div
      className={`sp-mw-card ${bull ? "sp-mw-bull" : "sp-mw-bear"} ${assignment ? `sp-mw-assigned-${assignment}` : ""}`}
      onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
      title="Open chart with Fib drawn"
    >
      <div className="sp-mw-card-top">
        <div className="sp-mw-card-sym">
          <span className="sp-mw-card-ticker">{tickerOf(r.symbol)}</span>
          <span className="sp-mw-card-exch">{exchangeOf(r.symbol)}</span>
        </div>
        <AssignDropdown symbol={r.symbol} watchlist={watchlist} onChange={onAssign} />
      </div>
      <div className="sp-mw-card-price">{fmt(r.lastCandle?.close)}</div>
      <div className="sp-mw-card-wave">
        <span className={`sp-wave-dir ${bull ? "bull" : "bear"}`}>
          {bull ? "▲ Bull" : "▼ Bear"}
        </span>
        <span className="sp-mw-card-size">Δ {fmt(size, 2)}</span>
      </div>
      {r.trapZone && (
        <div className="sp-mw-card-zone">
          Zone {fmt(r.trapZone.low)} – {fmt(r.trapZone.high)}
        </div>
      )}
    </div>
  );
}

// ─── ZoneTray ─────────────────────────────────────────────────────────────────
function ZoneTray({ label, subLabel, items, colorClass, timeframe, watchlist, onAssign }) {
  return (
    <div className={`sp-zone-tray ${colorClass}`}>
      <div className="sp-zone-tray-header">
        <div className="sp-zone-tray-title">{label}</div>
        <div className="sp-zone-tray-sub">{subLabel}</div>
        <div className="sp-zone-tray-count">{items.length}</div>
      </div>
      <div className="sp-zone-tray-body">
        {items.length === 0 ? (
          <div className="sp-zone-tray-empty">No stocks in this zone</div>
        ) : (
          items.map(r => (
            <div
              key={r.symbol}
              className={`sp-zone-tray-item ${watchlist[r.symbol] ? `sp-zt-assigned-${watchlist[r.symbol]}` : ""}`}
              onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
              title="Open chart with Fib drawn"
            >
              <div className="sp-zone-tray-item-left">
                <span className="sp-zone-tray-sym">{tickerOf(r.symbol)}</span>
                <span className="sp-zone-tray-price">{fmt(r.lastCandle?.close)}</span>
              </div>
              <div className="sp-zone-tray-item-right">
                {mwWave(r) && (
                  <span className={`sp-wave-dir ${isMWBull(r) ? "bull" : "bear"}`}>
                    {isMWBull(r) ? "▲" : "▼"}
                  </span>
                )}
                <AssignDropdown symbol={r.symbol} watchlist={watchlist} onChange={onAssign} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── WatchlistPanel — all stocks your team has tagged ─────────────────────────
function WatchlistPanel({ results, watchlist, onAssign, timeframe, onClearAll }) {
  const watchlistEntries = useMemo(() => {
    return results
      .filter(r => {
        const a = watchlist[r.symbol];
        return a && a !== "skip";
      })
      .sort((a, b) => {
        const ORDER = { watch: 0, s1: 1, s2: 2, s3: 3 };
        return (ORDER[watchlist[a.symbol]] ?? 9) - (ORDER[watchlist[b.symbol]] ?? 9);
      });
  }, [results, watchlist]);

  const assignedCount = Object.values(watchlist).filter(v => v && v !== "skip").length;

  if (assignedCount === 0) {
    return (
      <div className="sp-wl-empty">
        <div className="sp-wl-empty-icon">📋</div>
        <div className="sp-wl-empty-title">No stocks in watchlist yet</div>
        <div className="sp-wl-empty-sub">
          Go to Dashboard view, then use the dropdown on each stock card to assign Watch / S1 / S2 / S3.
        </div>
      </div>
    );
  }

  const byAssignment = { watch: [], s1: [], s2: [], s3: [] };
  for (const r of watchlistEntries) {
    const a = watchlist[r.symbol];
    if (byAssignment[a]) byAssignment[a].push(r);
  }

  return (
    <div className="sp-wl-section">
      <div className="sp-wl-header">
        <span className="sp-wl-title">Today's Watchlist</span>
        <span className="sp-wl-count">{assignedCount} stocks</span>
        <button className="sp-wl-clear-btn" onClick={onClearAll} title="Clear all assignments">
          Clear All
        </button>
      </div>

      {[
        { key: "watch", label: "👁 Watching", colorClass: "sp-wl-group-watch" },
        { key: "s1", label: "S1 — Waiting for trigger", colorClass: "sp-wl-group-s1" },
        { key: "s2", label: "S2 — Watching for confirmation", colorClass: "sp-wl-group-s2" },
        { key: "s3", label: "S3 — Entry imminent", colorClass: "sp-wl-group-s3" },
      ].map(group => {
        const items = byAssignment[group.key];
        if (!items.length) return null;
        return (
          <div key={group.key} className={`sp-wl-group ${group.colorClass}`}>
            <div className="sp-wl-group-label">{group.label} ({items.length})</div>
            <div className="sp-wl-group-cards">
              {items.map(r => {
                const bull = isMWBull(r);
                const { cls, text } = stageLabel(r);
                return (
                  <div
                    key={r.symbol}
                    className="sp-wl-card"
                    onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
                    title="Open chart"
                  >
                    <div className="sp-wl-card-top">
                      <div className="sp-wl-card-sym">
                        <span className="sp-wl-card-ticker">{tickerOf(r.symbol)}</span>
                        <span className="sp-wl-card-exch">{exchangeOf(r.symbol)}</span>
                      </div>
                      <AssignDropdown symbol={r.symbol} watchlist={watchlist} onChange={onAssign} />
                    </div>
                    <div className="sp-wl-card-row">
                      <span className="sp-wl-card-price">{fmt(r.lastCandle?.close)}</span>
                      {mwWave(r) && (
                        <span className={`sp-wave-dir ${bull ? "bull" : "bear"}`}>
                          {bull ? "▲" : "▼"}
                        </span>
                      )}
                      <span className={`sp-stage-pill ${cls}`}>{text}</span>
                    </div>
                    {r.trapZone && (
                      <div className="sp-wl-card-zone">
                        Zone {fmt(r.trapZone.low)} – {fmt(r.trapZone.high)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Strategies Page ──────────────────────────────────────────────────────────
function StrategyPicker({ strategies, lastScan, status }) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const socketRef = useRef(null);

  const [selectedId, setSelectedId] = useState(() => strategies[0]?.id || null);
  const [results, setResults] = useState([]);
  const [mwFilter, setMwFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [activeView, setActiveView] = useState("dashboard");
  const [loadingResults, setLoadingResults] = useState(false);
  const [localLastScan, setLocalLastScan] = useState(lastScan);
  const [timeframe, setTimeframe] = useState(() => {
    try { const v = localStorage.getItem("tgg_scanner_tf"); return v ? JSON.parse(v) : 15; }
    catch { return 15; }
  });

  // ── Watchlist state (localStorage-backed) ────────────────────────────────
  const [watchlist, setWatchlist] = useState(() => loadWatchlist());

  function handleAssign(symbol, value) {
    setWatchlist(prev => {
      const next = { ...prev };
      if (value === null) { delete next[symbol]; }
      else { next[symbol] = value; }
      saveWatchlist(next);
      return next;
    });
  }

  function handleClearAllWatchlist() {
    setWatchlist({});
    saveWatchlist({});
  }

  const selectedStrat = strategies.find(s => s.id === selectedId);

  useEffect(() => {
    if (!selectedId && strategies.length > 0) setSelectedId(strategies[0].id);
  }, [strategies, selectedId]);

  const fetchResults = useCallback(async (stratId) => {
    if (!stratId) return;
    setLoadingResults(true);
    try {
      const r = await fetch(`${BACKEND}/api/scanner/results/${stratId}?per_page=500`).then(r => r.json());
      setResults(r.results || []);
    } catch { }
    finally { setLoadingResults(false); }
  }, []);

  useEffect(() => { fetchResults(selectedId); }, [selectedId, fetchResults]);

  useEffect(() => {
    const sock = createBackendSocket();
    socketRef.current = sock;
    sock.on("scanner_complete", (d) => {
      setLocalLastScan(d.scannedAt);
      fetchResults(selectedId);
    });
    sock.on("scanner_signal", () => fetchResults(selectedId));
    return () => sock.disconnect();
  }, [selectedId, fetchResults]);

  function handleTfChange(val) {
    setTimeframe(val);
    localStorage.setItem("tgg_scanner_tf", JSON.stringify(val));
  }

  function handleStratChange(e) {
    const id = e.target.value;
    setSelectedId(id);
    setResults([]);
    setMwFilter("all");
    setStageFilter("all");
    setSearch("");
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const tfLabel = TIMEFRAMES.find(t => t.value === timeframe)?.label || `${timeframe}m`;

  const withMW = useMemo(() =>
    results.filter(r => mwWave(r)).sort((a, b) => waveSize(b) - waveSize(a)),
    [results]);
  const mwUptrend = useMemo(() => withMW.filter(r => isMWBull(r)), [withMW]);
  const mwDowntrend = useMemo(() => withMW.filter(r => !isMWBull(r)), [withMW]);

  const downWithZone = useMemo(() => mwDowntrend.filter(r => r.trapZone), [mwDowntrend]);
  const trapZoneItems = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "trap"), [downWithZone]);
  const near382Items = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "near382"), [downWithZone]);
  const near618Items = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "hot618"), [downWithZone]);

  const counts = useMemo(() => ({
    signals: results.filter(r => r.patternStage === "s3_complete").length,
    partial: results.filter(r => r.patternStage === "s2").length,
    s1: results.filter(r => r.patternStage === "s1").length,
  }), [results]);

  const watchlistCount = useMemo(() =>
    Object.values(watchlist).filter(v => v && v !== "skip").length,
    [watchlist]);

  const tableFiltered = useMemo(() => {
    return results.filter(r => {
      if (search && !r.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      switch (stageFilter) {
        case "signals": return r.patternStage === "s3_complete";
        case "partial": return r.patternStage === "s2";
        case "s1": return r.patternStage === "s1";
        case "mw": return r.patternStage === "motherwave" || r.patternStage === "trapzone";
        default: return true;
      }
    });
  }, [results, search, stageFilter]);

  const scanLastScan = localLastScan || lastScan;

  return (
    <div className="sp-picker-page">

      {/* ── HEADER ── */}
      <div className="sp-picker-header">
        <button className="sp-back-btn" onClick={() => navigate("/scanner")}>← Scanner</button>
        <span className="sp-picker-title">STRATEGIES</span>

        {/* Strategy dropdown */}
        {strategies.length > 0 && (
          <div className="sp-nav-dropdown-wrap">
            <span className="sp-nav-dropdown-icon">◈</span>
            <select
              className="sp-nav-select"
              value={selectedId || ""}
              onChange={handleStratChange}
            >
              {strategies.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <span className="sp-nav-dropdown-caret">▾</span>
          </div>
        )}

        {/* Timeframe */}
        <div className="sp-tf-group">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf.value}
              className={`sp-tf-btn ${timeframe === tf.value ? "active" : ""}`}
              onClick={() => handleTfChange(tf.value)}
            >{tf.label}</button>
          ))}
        </div>

        <div className="sp-dash-header-spacer" />

        {/* Search */}
        <div className="sp-search-wrap">
          <span className="sp-search-icon">⌕</span>
          <input
            className="sp-search-input"
            placeholder="Search symbol…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* View toggle — dashboard / table / watchlist */}
        <div className="sp-view-toggle">
          <button
            className={`sp-view-btn ${activeView === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveView("dashboard")}
            title="Motherwave Dashboard"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
              <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
              <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
              <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
            </svg>
          </button>
          <button
            className={`sp-view-btn ${activeView === "table" ? "active" : ""}`}
            onClick={() => setActiveView("table")}
            title="Table View"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <rect x="1" y="1" width="14" height="2.5" rx="0.75" fill="currentColor" opacity="0.9" />
              <rect x="1" y="5" width="14" height="2.5" rx="0.75" fill="currentColor" opacity="0.5" />
              <rect x="1" y="9" width="14" height="2.5" rx="0.75" fill="currentColor" opacity="0.5" />
              <rect x="1" y="13" width="14" height="2.5" rx="0.75" fill="currentColor" opacity="0.5" />
            </svg>
          </button>
          <button
            className={`sp-view-btn sp-view-watchlist-btn ${activeView === "watchlist" ? "active" : ""}`}
            onClick={() => setActiveView("watchlist")}
            title="Today's Watchlist"
          >
            📋
            {watchlistCount > 0 && (
              <span className="sp-wl-badge">{watchlistCount}</span>
            )}
          </button>
        </div>

        <button className="sp-theme-btn" onClick={toggleTheme}>
          {theme === "dark" ? "☀" : "🌙"}
        </button>

        <div className="sp-picker-header-right">
          <span className="sp-picker-meta">
            {status?.symbolCount || 0} symbols · {strategies.length} strategies
            {scanLastScan ? ` · Last scan ${fmtTime(scanLastScan)}` : ""}
          </span>
        </div>

        {loadingResults && <div className="sp-loading-dot" title="Fetching…" />}
      </div>

      {/* ── STATS BAR ── */}
      {selectedId && (
        <div className="sp-stats-bar">
          <div className="sp-stat"><span className="sp-stat-label">Scanned</span>    <span className="sp-stat-val accent">{results.length}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Uptrend</span>    <span className="sp-stat-val green">{mwUptrend.length}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Downtrend</span>  <span className="sp-stat-val red">{mwDowntrend.length}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Full Signal</span><span className="sp-stat-val green">{counts.signals}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Watching</span>   <span className="sp-stat-val orange">{counts.partial}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">S1 Formed</span> <span className="sp-stat-val">{counts.s1}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Watchlist</span>  <span className="sp-stat-val accent">{watchlistCount}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Resolution</span> <span className="sp-stat-val accent">{tfLabel}</span></div>
          <div className="sp-stat"><span className="sp-stat-label">Last Scan</span>  <span className="sp-stat-val" style={{ fontSize: 11 }}>{scanLastScan ? fmtTime(scanLastScan) : "—"}</span></div>
        </div>
      )}

      {/* ── STRATEGY DESC ── */}
      {selectedStrat?.description && (
        <div className="sp-strategy-desc">{selectedStrat.description}</div>
      )}

      {/* ── BODY ── */}
      {!selectedId ? (
        <div className="sp-picker-empty">
          <div className="sp-picker-empty-icon">〰</div>
          <div className="sp-picker-empty-title">No strategies loaded</div>
          <div className="sp-picker-empty-sub">Run a scan first from the Scanner page.</div>
          <button className="sp-picker-goto-scanner" onClick={() => navigate("/scanner")}>Go to Scanner →</button>
        </div>
      ) : (
        <div className="sp-dash-body" key={`${selectedId}-${activeView}`}>

          {/* DASHBOARD VIEW */}
          {activeView === "dashboard" && (
            <div className="sp-dash-section">
              <div className="sp-dash-section-header">
                <div className="sp-dash-section-left">
                  <span className="sp-dash-section-title">Motherwave Dashboard</span>
                  <span className="sp-dash-section-sub">
                    {selectedStrat?.name} · {tfLabel} · sorted by wave size ↓
                  </span>
                </div>
                <div className="sp-mw-dir-filter">
                  {[
                    { key: "all", label: `All (${withMW.length})` },
                    { key: "bull", label: `▲ Bull (${mwUptrend.length})` },
                    { key: "bear", label: `▼ Bear (${mwDowntrend.length})` },
                  ].map(f => (
                    <button
                      key={f.key}
                      className={`sp-mw-dir-btn ${mwFilter === f.key ? "active" : ""}`}
                      onClick={() => setMwFilter(f.key)}
                    >{f.label}</button>
                  ))}
                </div>
              </div>

              {withMW.length === 0 ? (
                <div className="sp-empty">
                  <div className="sp-empty-icon">〰</div>
                  <div className="sp-empty-title">No motherwave data yet</div>
                  <div className="sp-empty-sub">Run a scan from the Scanner page to populate.</div>
                </div>
              ) : (
                <>
                  <div className="sp-trend-columns">
                    <div className="sp-trend-col sp-uptrend-col">
                      <div className="sp-trend-col-header">
                        <span className="sp-trend-col-arrow">▲</span>
                        <span className="sp-trend-col-title">UPTREND</span>
                        <span className="sp-trend-col-count">{mwFilter === "bear" ? 0 : mwUptrend.length} stocks</span>
                      </div>
                      <div className="sp-trend-col-body">
                        {(mwFilter === "bear" ? [] : mwUptrend).length === 0
                          ? <div className="sp-trend-col-empty">No uptrend stocks</div>
                          : (mwFilter === "bear" ? [] : mwUptrend).map(r =>
                            <MWCard key={r.symbol} r={r} timeframe={timeframe} watchlist={watchlist} onAssign={handleAssign} />
                          )}
                      </div>
                    </div>
                    <div className="sp-trend-col sp-downtrend-col">
                      <div className="sp-trend-col-header">
                        <span className="sp-trend-col-arrow">▼</span>
                        <span className="sp-trend-col-title">DOWNTREND</span>
                        <span className="sp-trend-col-count">{mwFilter === "bull" ? 0 : mwDowntrend.length} stocks</span>
                      </div>
                      <div className="sp-trend-col-body">
                        {(mwFilter === "bull" ? [] : mwDowntrend).length === 0
                          ? <div className="sp-trend-col-empty">No downtrend stocks</div>
                          : (mwFilter === "bull" ? [] : mwDowntrend).map(r =>
                            <MWCard key={r.symbol} r={r} timeframe={timeframe} watchlist={watchlist} onAssign={handleAssign} />
                          )}
                      </div>
                    </div>
                  </div>

                  <div className="sp-zone-section">
                    <div className="sp-zone-section-title">
                      Zone Segregation
                      <span className="sp-zone-section-sub">Downtrend stocks by Fibonacci zone</span>
                    </div>
                    <div className="sp-zone-trays">
                      <ZoneTray label="TRAP ZONE" subLabel="fp(0) – fp(0.236) — at wave tip" items={trapZoneItems} colorClass="sp-tray-trap" timeframe={timeframe} watchlist={watchlist} onAssign={handleAssign} />
                      <ZoneTray label="NEAR 0.382" subLabel="Within 5% of 0.382 Fib level" items={near382Items} colorClass="sp-tray-382" timeframe={timeframe} watchlist={watchlist} onAssign={handleAssign} />
                      <ZoneTray label="NEAR 0.618 (HOT)" subLabel="Within 5% of 0.618 Fib level" items={near618Items} colorClass="sp-tray-618" timeframe={timeframe} watchlist={watchlist} onAssign={handleAssign} />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TABLE VIEW */}
          {activeView === "table" && (
            <div className="sp-dash-section">
              <div className="sp-table-controls">
                {STAGE_FILTERS.map(f => (
                  <button
                    key={f.key}
                    className={`sp-filter-btn ${stageFilter === f.key ? "active" : ""}`}
                    onClick={() => setStageFilter(f.key)}
                  >
                    {f.label}
                    {f.key === "signals" && counts.signals > 0 && <span className="sp-count-badge green">{counts.signals}</span>}
                    {f.key === "partial" && counts.partial > 0 && <span className="sp-count-badge orange">{counts.partial}</span>}
                    {f.key === "s1" && counts.s1 > 0 && <span className="sp-count-badge">{counts.s1}</span>}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="sp-last-scan-label">{scanLastScan ? `Last: ${fmtTime(scanLastScan)}` : "Not scanned yet"}</span>
                <span className="sp-res-badge">{tfLabel}</span>
              </div>

              {tableFiltered.length === 0 ? (
                <div className="sp-empty">
                  <div className="sp-empty-icon">🔍</div>
                  <div className="sp-empty-title">{results.length === 0 ? "No scan results yet" : "No matches"}</div>
                  <div className="sp-empty-sub">{results.length === 0 ? "Run a scan from the Scanner page." : "Try a different filter or search term."}</div>
                </div>
              ) : (
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead>
                      <tr>
                        <th>Symbol</th><th>Stage</th><th>Wave</th>
                        <th>Trap High</th><th>Trap Low</th>
                        <th>S1 Close</th><th>S2 Close</th><th>S3 Close</th>
                        <th>Last Price</th><th>Assign</th><th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableFiltered.map(r => {
                        const { cls, text } = stageLabel(r);
                        const bull = isMWBull(r);
                        return (
                          <tr key={r.symbol} className="sp-table-row"
                            onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
                            title="Open chart with Fib drawn">
                            <td>
                              <div className="sp-sym-cell">{tickerOf(r.symbol)}</div>
                              <div className="sp-sym-exch">{exchangeOf(r.symbol)}</div>
                            </td>
                            <td><span className={`sp-stage-pill ${cls}`}>{text}</span></td>
                            <td>
                              {mwWave(r)
                                ? <span className={`sp-wave-dir ${bull ? "bull" : "bear"}`}>
                                  {bull ? "▲ Bull" : "▼ Bear"}
                                </span>
                                : <span style={{ color: "var(--text3)" }}>—</span>}
                            </td>
                            <td className="sp-price-cell">{fmt(r.trapZone?.high)}</td>
                            <td className="sp-price-cell">{fmt(r.trapZone?.low)}</td>
                            <td className={`sp-price-cell ${r.s1 ? "red" : ""}`}>{fmt(r.s1?.close)}</td>
                            <td className={`sp-price-cell ${r.s2 ? "green" : ""}`}>{fmt(r.s2?.close)}</td>
                            <td className={`sp-price-cell ${r.s3 ? "red" : ""}`}>{fmt(r.s3?.close)}</td>
                            <td className="sp-price-cell">{fmt(r.lastCandle?.close)}</td>
                            <td onClick={e => e.stopPropagation()}>
                              <AssignDropdown symbol={r.symbol} watchlist={watchlist} onChange={handleAssign} />
                            </td>
                            <td style={{ color: "var(--text3)", fontSize: 10 }}>{fmtTime(r.scannedAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* WATCHLIST VIEW */}
          {activeView === "watchlist" && (
            <div className="sp-dash-section">
              <WatchlistPanel
                results={results}
                watchlist={watchlist}
                onAssign={handleAssign}
                timeframe={timeframe}
                onClearAll={handleClearAllWatchlist}
              />
            </div>
          )}

        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function StrategiesPage() {
  const [strategies, setStrategies] = useState([]);
  const [lastScan, setLastScan] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/scanner/status`)
      .then(r => r.json())
      .then(s => {
        setStatus(s);
        setLastScan(s.lastScanAt || null);
        setStrategies(s.strategies || []);
      })
      .catch(() => { });
  }, []);

  return (
    <StrategyPicker
      strategies={strategies}
      lastScan={lastScan}
      status={status}
    />
  );
}