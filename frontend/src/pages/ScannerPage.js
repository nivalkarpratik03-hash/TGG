// ScannerPage.js
// Layout (top→bottom):
//   1. Header — timeframe selector, search, view toggle, scan button
//   2. Stats bar
//   3. TWO PANELS (tabs):
//      A) MOTHERWAVE DASHBOARD — latest wave per symbol, sorted by wave size
//         (uptrend | downtrend columns, then Zone Segregation trays)
//      B) STRATEGIES PANEL — per-strategy tab, TABLE VIEW ONLY
//         (stage filters, table rows — clicking opens chart in new tab with fib drawn)
//   Clicking any stock card/row opens chart in new tab with fib retracement drawn
//
// r.motherwave is now the full { wave, fibLevels, invalidation } shape from
// detectMotherWaveForAPI. All field access goes through r.motherwave.wave.*

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { createBackendSocket } from "../utils/backendSocket";
import { formatDateTimeIST } from "../utils/istUtils";
import { BACKEND } from "../config";
import { useTheme } from "../App";
import "../styles/ScannerPage.css";

// ─── Constants ────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { value: 1, label: "1m" },
  { value: 3, label: "3m" },
  { value: 5, label: "5m" },
  { value: 15, label: "15m" },
  { value: 60, label: "1h" },
  { value: 1440, label: "1D" },
  { value: 10080, label: "1W" },
];

// NEW 2026-08-02 — Scanner UI symbol/category scope (matches
// scannerRouter.js's ASSET_CLASS_TO_TYPE and symbolsRouter.js's `type`
// field on every symbol: "index" | "commodity" | "equity"; "all" sends no
// assetClass at all, unchanged full-scan behavior).
const ASSET_CLASSES = [
  { value: "all", label: "All" },
  { value: "index", label: "Index" },
  { value: "commodity", label: "Commodity" },
  { value: "equity", label: "Equity" },
];

// NEW 2026-08-03 — Instrument Type dropdown, gated by Asset Class. Matches
// backend/src/services/instrumentTypeResolver.js's
// VALID_INSTRUMENT_TYPES_FOR_ASSET_CLASS exactly — Commodity has no Spot
// option (no fixed spot symbol exists for an MCX root).
const ASSET_TO_INSTRUMENT_TYPES = {
  equity: [
    { value: "spot", label: "Spot" },
    { value: "fut", label: "Fut" },
    { value: "opt", label: "Opt" },
    { value: "all", label: "All" },
  ],
  index: [
    { value: "spot", label: "Spot" },
    { value: "fut", label: "Fut" },
    { value: "opt", label: "Opt" },
    { value: "all", label: "All" },
  ],
  commodity: [
    { value: "fut", label: "Fut" },
    { value: "opt", label: "Opt" },
    { value: "all", label: "All" },
  ],
  all: [
    { value: "spot", label: "Spot" },
    { value: "fut", label: "Fut" },
    { value: "opt", label: "Opt" },
    { value: "all", label: "All" },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n, d = 2) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
// r.motherwave is now { wave, fibLevels, invalidation }
// Use these helpers everywhere to avoid scattered null checks.
function mwWave(r) { return r.motherwave?.wave || null; }
function isMWBull(r) { return mwWave(r)?.dir === "bull"; }
// r.s1 / r.s2 / r.s3 are the raw candle objects for each stage (set in
// scannerS1.S2.S3.js's findS1S2S3 via `{ ...c, index: i }`), so each already
// carries its own candle `.time` (epoch ms) — the moment that stage's
// candle closed. mwTime uses the wave's toTime — the bar where the
// motherwave tip landed (same reference point buildChartUrl already uses).
function s1Time(r) { return r.s1?.time || null; }
function s2Time(r) { return r.s2?.time || null; }
function s3Time(r) { return r.s3?.time || null; }
function mwTime(r) { return mwWave(r)?.toTime || null; }
function waveSize(r) {
  const w = mwWave(r);
  if (!w) return 0;
  return Math.abs((w.fromPrice || 0) - (w.toPrice || 0));
}

// ─── Fib price ────────────────────────────────────────────────────────────────
// price = toPrice + ratio*(fromPrice-toPrice)
// ratio=0 → tip, ratio=1 → origin
function fibPrice(wave, ratio) {
  const to = wave.toPrice;
  const from = wave.fromPrice;
  return to + ratio * (from - to);
}

// ─── Zone tray classification ─────────────────────────────────────────────────
//
// Priority (first match wins):
//   1. NEAR 0.618 (HOT) — last price inside ±0.5% of span around fp(0.618)
//   2. NEAR 0.382       — last price inside ±0.5% of span around fp(0.382)
//   3. TRAP ZONE        — last price between fp(-0.236) and fp(0.236)
//                         (the band straddling the wave tip on both sides)
//   4. other            — not shown in any tray
//
// fp(ratio) = toPrice + ratio * (fromPrice - toPrice)
//   ratio=0    → wave tip (toPrice)
//   ratio=0.236 → first retracement into wave
//   ratio=-0.236 → extension beyond tip (opposite direction)
//
function getZoneTray(r) {
  const w = mwWave(r);
  if (!w) return "other";
  const last = r.lastCandle?.close;
  if (!last) return "other";

  const span = Math.abs(w.fromPrice - w.toPrice);
  const tol = span * 0.005; // ±0.5% of wave span

  // 1. NEAR 0.618 — tight ±0.5% band
  const f618 = fibPrice(w, 0.618);
  if (last >= f618 - tol && last <= f618 + tol) return "hot618";

  // 2. NEAR 0.382 — tight ±0.5% band
  const f382 = fibPrice(w, 0.382);
  if (last >= f382 - tol && last <= f382 + tol) return "near382";

  // 3. TRAP ZONE — between fp(-0.236) and fp(0.236)
  //    fp(-0.236) is the extension beyond the tip (above tip for bear, below for bull)
  //    fp(0.236) is the first retracement back into the wave
  const trapEdge1 = fibPrice(w, -0.236); // extension side
  const trapEdge2 = fibPrice(w, 0.236);  // retracement side
  const trapHigh = Math.max(trapEdge1, trapEdge2);
  const trapLow = Math.min(trapEdge1, trapEdge2);
  if (last >= trapLow && last <= trapHigh) return "trap";

  return "other";
}

// ─── Build chart URL ──────────────────────────────────────────────────────────
// mw here is the full { wave, fibLevels, invalidation } object
function buildChartUrl(symbol, timeframe, mw) {
  if (!mw || !mw.wave) {
    const params = new URLSearchParams({ symbol, resolution: String(timeframe) });
    return `/charts?${params.toString()}`;
  }
  const w = mw.wave;
  const fromMs = w.fromTime;
  const toMs = w.toTime;

  const fibDrawing = encodeURIComponent(JSON.stringify({
    p1Price: w.toPrice,                     // wave TIP → ratio 0
    p1Time: Math.round(toMs / 1000),
    p2Price: w.fromPrice,                   // wave ORIGIN → ratio 1
    p2Time: Math.round(fromMs / 1000),
  }));

  const params = new URLSearchParams({
    symbol,
    resolution: String(timeframe),
    waveFrom: String(fromMs),
    waveTo: String(toMs),
    fibDrawing,
  });
  return `/charts?${params.toString()}`;
}

function openChart(symbol, timeframe, mw) {
  window.open(buildChartUrl(symbol, timeframe, mw), "_blank");
}

// ─── MWCard — one stock in the motherwave dashboard ───────────────────────────
function MWCard({ r, timeframe }) {
  const bull = isMWBull(r);
  const size = waveSize(r);

  return (
    <div
      className={`mw-card ${bull ? "mw-bull" : "mw-bear"}`}
      onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
      title="Open chart with Fib drawn"
    >
      <div className="mw-card-top">
        <div className="mw-card-sym">
          <span className="mw-card-ticker">{tickerOf(r.symbol)}</span>
          <span className="mw-card-exch">{exchangeOf(r.symbol)}</span>
        </div>
      </div>
      <div className="mw-card-price">{fmt(r.lastCandle?.close)}</div>
      <div className="mw-card-wave">
        <span className={`wave-dir ${bull ? "bull" : "bear"}`}>
          {bull ? "▲ Bull" : "▼ Bear"}
        </span>
        <span className="mw-card-size">Δ {fmt(size, 2)}</span>
      </div>
      {r.trapZone && (
        <div className="mw-card-zone">
          Zone {fmt(r.trapZone.low)} – {fmt(r.trapZone.high)}
        </div>
      )}
    </div>
  );
}

// ─── ZoneTray ─────────────────────────────────────────────────────────────────
function ZoneTray({ label, subLabel, items, colorClass, timeframe }) {
  return (
    <div className={`zone-tray ${colorClass}`}>
      <div className="zone-tray-header">
        <div className="zone-tray-title">{label}</div>
        <div className="zone-tray-sub">{subLabel}</div>
        <div className="zone-tray-count">{items.length}</div>
      </div>
      <div className="zone-tray-body">
        {items.length === 0 ? (
          <div className="zone-tray-empty">No stocks in this zone</div>
        ) : (
          items.map(r => (
            <div
              key={r.symbol}
              className="zone-tray-item"
              onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
              title="Open chart with Fib drawn"
            >
              <div className="zone-tray-item-left">
                <span className="zone-tray-sym">{tickerOf(r.symbol)}</span>
                <span className="zone-tray-price">{fmt(r.lastCandle?.close)}</span>
              </div>
              <div className="zone-tray-item-right">
                {mwWave(r) && (
                  <span className={`wave-dir ${isMWBull(r) ? "bull" : "bear"}`}>
                    {isMWBull(r) ? "▲" : "▼"}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── SignalsTable — shared by Results (S3 shown) and Upcoming (S3 omitted) ────
function SignalsTable({ title, sub, rows, showS3, emptyLabel, timeframe }) {
  return (
    <div className="scanner-signals-col">
      <div className="scanner-signals-col-header">
        <span className="scanner-signals-col-title">{title}</span>
        <span className="scanner-signals-col-sub">{sub}</span>
      </div>
      {rows.length === 0 ? (
        <div className="scanner-signals-empty">{emptyLabel}</div>
      ) : (
        <div className="scanner-signals-table-wrap">
          <table className="scanner-signals-table">
            <thead>
              <tr>
                <th>Sr.No</th>
                <th>Symbol</th>
                <th>S1</th>
                <th>S2</th>
                {showS3 && <th>S3</th>}
                <th>MW</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const bull = isMWBull(r);
                return (
                  <tr
                    key={r.symbol}
                    className="scanner-signals-row"
                    onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
                    title="Open chart with Fib drawn"
                  >
                    <td>{i + 1}</td>
                    <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
                    <td className={`scanner-signals-flag ${r.s1 ? "on" : ""}`}>
                      {r.s1 ? (
                        <div className="scanner-signals-stage">
                          <span className="scanner-signals-stage-check">✓</span>
                          <span className="scanner-signals-stage-ts">{formatDateTimeIST(s1Time(r))}</span>
                        </div>
                      ) : "—"}
                    </td>
                    <td className={`scanner-signals-flag ${r.s2 ? "on" : ""}`}>
                      {r.s2 ? (
                        <div className="scanner-signals-stage">
                          <span className="scanner-signals-stage-check">✓</span>
                          <span className="scanner-signals-stage-ts">{formatDateTimeIST(s2Time(r))}</span>
                        </div>
                      ) : "—"}
                    </td>
                    {showS3 && (
                      <td className={`scanner-signals-flag ${r.s3 ? "on" : ""}`}>
                        {r.s3 ? (
                          <div className="scanner-signals-stage">
                            <span className="scanner-signals-stage-check">✓</span>
                            <span className="scanner-signals-stage-ts">{formatDateTimeIST(s3Time(r))}</span>
                          </div>
                        ) : "—"}
                      </td>
                    )}
                    <td>
                      <span className={`scanner-signals-mw ${bull ? "bull" : "bear"}`}>
                        {bull ? "▲ Bull" : "▼ Bear"}
                      </span>
                    </td>
                    <td className="scanner-signals-ts">{formatDateTimeIST(mwTime(r) || r.scannedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ScannerPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const socketRef = useRef(null);

  // ── State ─────────────────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState([]);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const [timeframe, setTimeframe] = useState(() => {
    try { const v = localStorage.getItem("tgg_scanner_tf"); return v ? JSON.parse(v) : 15; }
    catch { return 15; }
  });
  // NEW 2026-08-02 — Symbol/category scope for the scan. "all" (default)
  // is the existing full-813-symbol behavior, unchanged. The other 3
  // values scope the scan to just that category via /api/scanner/trigger's
  // new assetClass param — see scannerRouter.js.
  const [assetClass, setAssetClass] = useState(() => {
    try { const v = localStorage.getItem("tgg_scanner_assetclass"); return v || "all"; }
    catch { return "all"; }
  });
  // NEW 2026-08-03 — Instrument Type scope (Spot/Fut/Opt/All), gated by
  // assetClass — see ASSET_TO_INSTRUMENT_TYPES above. Sent alongside
  // assetClass to /api/scanner/trigger's new instrumentType field.
  const [instrumentType, setInstrumentType] = useState(() => {
    try { const v = localStorage.getItem("tgg_scanner_instrumenttype"); return v || "all"; }
    catch { return "all"; }
  });
  // NEW — Results/Upcoming tab switch. Previously both tables rendered
  // side-by-side at half width each, which crowded the S1/S2/S3/MW/
  // Timestamp columns (especially once per-stage date+time was added).
  // Now only one renders at a time, at full section width.
  const [signalsTab, setSignalsTab] = useState(() => {
    try { const v = localStorage.getItem("tgg_scanner_signalstab"); return v || "results"; }
    catch { return "results"; }
  });
  function handleSignalsTabChange(val) {
    setSignalsTab(val);
    localStorage.setItem("tgg_scanner_signalstab", val);
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const s = await fetch(`${BACKEND}/api/scanner/status`).then(r => r.json());
      setStatus(s);
      setLastScan(s.lastScanAt);
      if (s.strategies?.length) {
        setStrategies(s.strategies);
        setActiveStrategy(prev => prev || s.strategies[0]?.id);
      }
    } catch { }
  }, []);

  const fetchResults = useCallback(async (stratId) => {
    if (!stratId) return;
    try {
      // per_page matches scannerRouter.js's raised cap (5000) — see the
      // fix note there. Requesting fewer than the full accumulated
      // multi-category result set would reintroduce the same truncation
      // bug from the frontend side.
      const r = await fetch(`${BACKEND}/api/scanner/results/${stratId}?per_page=5000`).then(r => r.json());
      setResults(r.results || []);
    } catch { }
  }, []);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchStatus();
    const sock = createBackendSocket();
    socketRef.current = sock;
    sock.on("scanner_start", (d) => {
      setProgress({ total: d.total, done: 0 });
      if (d.strategies?.length) {
        setStrategies(d.strategies);
        setActiveStrategy(prev => prev || d.strategies[0]?.id);
      }
    });
    sock.on("scanner_progress", (d) => setProgress({ total: d.total, done: d.done }));
    sock.on("scanner_complete", (d) => {
      setProgress(null);
      setLastScan(d.scannedAt);
      fetchStatus();
    });
    sock.on("scanner_signal", () => fetchStatus());
    return () => sock.disconnect();
  }, [fetchStatus]);

  useEffect(() => {
    if (activeStrategy) fetchResults(activeStrategy);
  }, [activeStrategy, lastScan, fetchResults]);

  // ── Timeframe ─────────────────────────────────────────────────────────────
  function handleTfChange(val) {
    setTimeframe(val);
    localStorage.setItem("tgg_scanner_tf", JSON.stringify(val));
  }

  // ── Asset class (symbol category) ────────────────────────────────────────
  function handleAssetClassChange(val) {
    setAssetClass(val);
    localStorage.setItem("tgg_scanner_assetclass", val);
  }

  // ── Instrument type ───────────────────────────────────────────────────────
  function handleInstrumentTypeChange(val) {
    setInstrumentType(val);
    localStorage.setItem("tgg_scanner_instrumenttype", val);
  }

  // Guard — if assetClass changes to one that doesn't offer the currently
  // selected instrumentType (e.g. switching to Commodity while Spot is
  // selected — Commodity has no Spot), reset to "all" rather than silently
  // sending an invalid combo to /trigger.
  useEffect(() => {
    const allowed = ASSET_TO_INSTRUMENT_TYPES[assetClass] || ASSET_TO_INSTRUMENT_TYPES.all;
    if (!allowed.some(o => o.value === instrumentType)) {
      handleInstrumentTypeChange("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetClass]);

  // ── Strategy selection ────────────────────────────────────────────────────
  function handleStrategyChange(val) {
    setActiveStrategy(val);
  }

  // ── Trigger / Stop ────────────────────────────────────────────────────────
  async function handleTrigger() {
    if (loading || isRunning) return;
    setLoading(true);
    try {
      await fetch(`${BACKEND}/api/scanner/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: timeframe, assetClass, instrumentType }),
      });
      setProgress({ total: status?.symbolCount || 0, done: 0 });
    } catch { }
    finally { setLoading(false); }
  }
  async function handleStop() {
    try {
      await fetch(`${BACKEND}/api/scanner/stop`, { method: "POST" });
      setProgress(null);
      fetchStatus();
    } catch { }
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const isRunning = status?.running || !!progress;
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const tfLabel = TIMEFRAMES.find(t => t.value === timeframe)?.label || `${timeframe}m`;
  const instrumentTypeOptions = ASSET_TO_INSTRUMENT_TYPES[assetClass] || ASSET_TO_INSTRUMENT_TYPES.all;

  // All results with a motherwave wave object
  const withMW = useMemo(() =>
    results.filter(r => mwWave(r)).sort((a, b) => waveSize(b) - waveSize(a)),
    [results]
  );
  const mwUptrend = useMemo(() => withMW.filter(r => isMWBull(r)), [withMW]);
  const mwDowntrend = useMemo(() => withMW.filter(r => !isMWBull(r)), [withMW]);
  const noValidMW = useMemo(() => results.filter(r => !mwWave(r)), [results]);

  // Zone trays — downtrend stocks
  const downWithZone = useMemo(() => mwDowntrend.filter(r => r.trapZone), [mwDowntrend]);
  const trapZoneItems = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "trap"), [downWithZone]);
  const near382Items = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "near382"), [downWithZone]);
  const near618Items = useMemo(() => downWithZone.filter(r => getZoneTray(r) === "hot618"), [downWithZone]);

  const counts = useMemo(() => ({
    signals: results.filter(r => r.patternStage === "s3_complete").length,
    partial: results.filter(r => r.patternStage === "s2").length,
    s1: results.filter(r => r.patternStage === "s1").length,
  }), [results]);

  // Results table — fully confirmed (S1→S2→S3) signals, latest 10
  const resultsTable = useMemo(() =>
    results
      .filter(r => r.patternStage === "s3_complete")
      .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt))
      .slice(0, 10),
    [results]
  );

  // Upcoming table — S1→S2 confirmed, S3 not yet triggered, latest 10
  const upcomingTable = useMemo(() =>
    results
      .filter(r => r.patternStage === "s2")
      .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt))
      .slice(0, 10),
    [results]
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="scanner-page">

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      {/* NEW 2026-08-03 — stripped down to Back / title / theme / status only.
          Strategy, Asset Class, Instrument Type, Timeframe, and Scan Now/Stop
          all relocated to the new .scanner-control-bar below the stats bar. */}
      <div className="scanner-header">
        <button className="scanner-header-back" onClick={() => navigate("/")}>← Back</button>
        <span className="scanner-header-title">Pattern Scanner</span>

        <div className="scanner-header-spacer" />

        {/* Theme */}
        <button className="scanner-theme-btn" onClick={toggleTheme} title="Toggle theme">
          {theme === "dark" ? "☀" : "🌙"}
        </button>

        {/* Status badge */}
        <div className="scanner-header-status">
          <div className={`scanner-status-dot ${isRunning ? "running" : "idle"}`} />
          {isRunning
            ? `${progress?.done || 0} / ${progress?.total || status?.symbolCount || "?"}`
            : `${status?.symbolCount || 0} symbols · ${strategies.length} strategies`}
        </div>
      </div>

      {/* Progress bar */}
      <div className="scanner-progress-bar-wrap">
        <div className="scanner-progress-bar" style={{ width: isRunning ? `${pct}%` : "0%" }} />
      </div>

      {/* ══ STATS BAR ═══════════════════════════════════════════════════════ */}
      <div className="scanner-stats-bar">
        <div className="stat-chip"><span className="stat-chip-label">Scanned</span>    <span className="stat-chip-val accent">{results.length}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Full Signals</span><span className="stat-chip-val green">{counts.signals}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Watching (S2)</span><span className="stat-chip-val orange">{counts.partial}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">S1 Formed</span>  <span className="stat-chip-val">{counts.s1}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Uptrend</span>    <span className="stat-chip-val green">{mwUptrend.length}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Downtrend</span>  <span className="stat-chip-val red">{mwDowntrend.length}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">No Valid MW</span><span className="stat-chip-val" style={{ color: "#888" }}>{noValidMW.length}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Resolution</span> <span className="stat-chip-val accent">{tfLabel}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Last Scan</span>  <span className="stat-chip-val" style={{ fontSize: 11 }}>{lastScan ? fmtTime(lastScan) : "—"}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Duration</span>   <span className="stat-chip-val">{status?.lastScanDurationMs ? `${(status.lastScanDurationMs / 1000).toFixed(0)}s` : "—"}</span></div>
      </div>

      {/* ══ CONTROL BAR ═══════════════════════════════════════════════════════ */}
      {/* NEW 2026-08-03 — All ▾ (asset class) → Strategy ▾ → Instrument Type ▾
          (new, gated by asset class) → Timeframe ▾ (7 buttons → 1 dropdown)
          → Scan Now. */}
      <div className="scanner-control-bar">
        {/* Asset class */}
        <div className="scanner-assetclass-group">
          <select
            className="scanner-assetclass-select"
            value={assetClass}
            onChange={(e) => handleAssetClassChange(e.target.value)}
            disabled={isRunning}
            title="Scope the scan to one symbol category"
          >
            {ASSET_CLASSES.map(ac => (
              <option key={ac.value} value={ac.value}>{ac.label}</option>
            ))}
          </select>
        </div>

        {/* Strategy */}
        {strategies.length > 0 && (
          <div className="scanner-strategy-group">
            <select
              className="scanner-strategy-select"
              value={activeStrategy || ""}
              onChange={(e) => handleStrategyChange(e.target.value)}
              title="Select strategy"
            >
              {strategies.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Instrument type — NEW, gated by asset class */}
        <div className="scanner-instrumenttype-group">
          <select
            className="scanner-instrumenttype-select"
            value={instrumentType}
            onChange={(e) => handleInstrumentTypeChange(e.target.value)}
            disabled={isRunning}
            title="Scope the scan to one instrument type"
          >
            {instrumentTypeOptions.map(it => (
              <option key={it.value} value={it.value}>{it.label}</option>
            ))}
          </select>
        </div>

        {/* Timeframe — converted from 7 buttons to one dropdown */}
        <div className="scanner-tf-group">
          <select
            className="scanner-tf-select"
            value={timeframe}
            onChange={(e) => handleTfChange(Number(e.target.value))}
            disabled={isRunning}
            title="Timeframe"
          >
            {TIMEFRAMES.map(tf => (
              <option key={tf.value} value={tf.value}>{tf.label}</option>
            ))}
          </select>
        </div>

        <div className="scanner-control-bar-spacer" />

        {isRunning && (
          <button className="scanner-stop-btn" onClick={handleStop}>⏹ Stop</button>
        )}
        <button
          className="scanner-trigger-btn"
          onClick={handleTrigger}
          disabled={isRunning || loading}
        >
          {isRunning ? `Scanning… ${pct}%` : "▶ Scan Now"}
        </button>
      </div>

      {/* ══ BODY ════════════════════════════════════════════════════════════ */}
      <div className="scanner-pages-wrap">
        <div className="scanner-body">

          {/* ── RESULTS / UPCOMING ──────────────────────────────────────────── */}
          <div className="scanner-section scanner-signals-section">
            <div className="scanner-signals-tabs">
              <button
                className={`scanner-signals-tab ${signalsTab === "results" ? "active" : ""}`}
                onClick={() => handleSignalsTabChange("results")}
              >
                Results
              </button>
              <button
                className={`scanner-signals-tab ${signalsTab === "upcoming" ? "active" : ""}`}
                onClick={() => handleSignalsTabChange("upcoming")}
              >
                Upcoming
              </button>
            </div>

            {signalsTab === "results" ? (
              <SignalsTable
                title="Results"
                sub="S1 → S2 → S3 confirmed — latest 10"
                rows={resultsTable}
                showS3={true}
                emptyLabel="No completed signals yet"
                timeframe={timeframe}
              />
            ) : (
              <SignalsTable
                title="Upcoming"
                sub="S1 → S2 confirmed, S3 pending — latest 10"
                rows={upcomingTable}
                showS3={false}
                emptyLabel="No forming signals yet"
                timeframe={timeframe}
              />
            )}
          </div>

          {/* ── PANEL A: MOTHERWAVE DASHBOARD ───────────────────────────────── */}
          <div className="scanner-section mw-section">

            <div className="mw-section-header">
              <div className="mw-section-header-left">
                <span className="mw-section-title">Motherwave Dashboard</span>
                <span className="mw-section-sub">Latest motherwave per symbol on {tfLabel} — sorted by wave size ↓</span>
              </div>
            </div>

            {withMW.length === 0 ? (
              <div className="scanner-empty">
                <div className="scanner-empty-icon">〰</div>
                <div className="scanner-empty-title">No motherwave data yet</div>
                <div className="scanner-empty-sub">Click ▶ Scan Now to populate.</div>
              </div>
            ) : (
              <>
                {/* Trend columns */}
                <div className="mw-trend-columns">
                  {/* Uptrend */}
                  <div className="trend-column uptrend-col">
                    <div className="trend-col-header">
                      <span className="trend-col-arrow">▲</span>
                      <span className="trend-col-title">UPTREND</span>
                      <span className="trend-col-count">{mwUptrend.length} stocks</span>
                    </div>
                    <div className="trend-col-body">
                      {mwUptrend.length === 0 ? (
                        <div className="trend-col-empty">No uptrend stocks</div>
                      ) : (
                        mwUptrend.map(r =>
                          <MWCard key={r.symbol} r={r} timeframe={timeframe} />
                        )
                      )}
                    </div>
                  </div>

                  {/* Downtrend */}
                  <div className="trend-column downtrend-col">
                    <div className="trend-col-header">
                      <span className="trend-col-arrow">▼</span>
                      <span className="trend-col-title">DOWNTREND</span>
                      <span className="trend-col-count">{mwDowntrend.length} stocks</span>
                    </div>
                    <div className="trend-col-body">
                      {mwDowntrend.length === 0 ? (
                        <div className="trend-col-empty">No downtrend stocks</div>
                      ) : (
                        mwDowntrend.map(r =>
                          <MWCard key={r.symbol} r={r} timeframe={timeframe} />
                        )
                      )}
                    </div>
                  </div>
                </div>

                {/* Zone segregation — downtrend only */}
                <div className="zone-section">
                  <div className="zone-section-title">
                    Zone Segregation
                    <span className="zone-section-sub">Downtrend stocks sorted by Fibonacci zone</span>
                  </div>
                  <div className="zone-trays">
                    <ZoneTray
                      label="TRAP ZONE"
                      subLabel="Between fp(0) and fp(0.236) — at wave tip"
                      items={trapZoneItems}
                      colorClass="tray-trap"
                      timeframe={timeframe}
                    />
                    <ZoneTray
                      label="NEAR 0.382"
                      subLabel="Within 5% of the 0.382 Fib level"
                      items={near382Items}
                      colorClass="tray-382"
                      timeframe={timeframe}
                    />
                    <ZoneTray
                      label="NEAR 0.618 (HOT)"
                      subLabel="Within 5% of the 0.618 Fib level"
                      items={near618Items}
                      colorClass="tray-618"
                      timeframe={timeframe}
                    />
                  </div>
                </div>
              </>
            )}
          </div>

        </div>{/* end scanner-body */}
      </div>{/* scanner-pages-wrap */}
    </div>
  );
}