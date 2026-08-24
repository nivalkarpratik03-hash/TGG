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
import { createBackendSocket } from "../../utils/backendSocket";
import { formatDateTimeIST } from "../../utils/istUtils";
import { BACKEND } from "../../config";
import { useTheme } from "../../App";
import { fmt } from "../../utils/format";
import { tickerOf, exchangeOf } from "../../utils/symbolMeta";
import { TIMEFRAMES } from "../../utils/formatResolution";
import {
  fmtTime, stageLabel, mwWave, isMWBull, waveSize, getZoneTray, buildChartUrl,
} from "./mwScanHelpers";
import { buildScannerRows } from "./t5ResultShape";
import T5ScannerPanel from "./T5ScannerPanel";
import { buildAbsorptionFlipRows } from "./absorptionFlipResultShape";
import AbsorptionFlipScannerPanel from "./AbsorptionFlipScannerPanel";
import "./ScannerPage.css";

// ─── Constants ────────────────────────────────────────────────────────────────
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
// r.s1 / r.s2 / r.s3 are the raw candle objects for each stage (set in
// scannerS1.S2.S3.js's findS1S2S3 via `{ ...c, index: i }`), so each already
// carries its own candle `.time` (epoch ms) — the moment that stage's
// candle closed. mwTime uses the wave's toTime — the bar where the
// motherwave tip landed (same reference point buildChartUrl already uses).
// (This block is Scanner-only — not part of the shared cluster below.)
function s1Time(r) { return r.s1?.time || null; }
function s2Time(r) { return r.s2?.time || null; }
function s3Time(r) { return r.s3?.time || null; }
function mwTime(r) { return mwWave(r)?.toTime || null; }

function openChart(symbol, timeframe, mw) {
  window.open(buildChartUrl(symbol, timeframe, mw), "_blank");
}

function openT5Chart(symbol, timeframe) {
  window.open(buildChartUrl(symbol, timeframe, null, { t5: true }), "_blank");
}

function openAbsorptionFlipChart(symbol, timeframe) {
  // No special query flag needed (unlike T5's `t5=1`) — the SR Pivot
  // bands/absorption overlay is EMA9PivotSRIndicator.js, a normal
  // dashboard-togglable indicator (id "ema9pivot" in indicatorRegistry.js),
  // not a scanner-specific chart mode.
  window.open(buildChartUrl(symbol, timeframe), "_blank");
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

// ─── TypeSignalsTable — for the "type" strategy family (E/R/F) ────────────────
// typeREF.js's scanForType() shapes results totally differently from
// s1s2s3: no r.s1/r.s2/r.s3 candle objects, no "s3_complete"/"s2" stages.
// Instead: r.type ("R"|"E"|"F"|null for the combined view), r.entry/r.exit
// prices, r.mw/r.mwTime/r.dw/r.dwTime (reference wave direction + time),
// and r.patternStage is "completed" | "active" | "none". This table reads
// that shape directly instead of forcing it through SignalsTable's s1/s2/s3
// columns, which don't exist here.
function TypeSignalsTable({ title, sub, rows, showExit, emptyLabel, timeframe }) {
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
                <th>Type</th>
                <th>Entry</th>
                {showExit && <th>Exit</th>}
                <th>DW</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dwBull = r.dw === "bullish" || r.dw === "up" || r.dw === true;
                const latest = r.events && r.events.length ? r.events[r.events.length - 1] : null;
                const entryTime = latest?.entryTime ?? null;
                const exitTime = latest?.exited ? latest?.exitTime : null;
                return (
                  <tr
                    key={r.symbol}
                    className="scanner-signals-row"
                    onClick={() => openChart(r.symbol, timeframe, r.motherwave)}
                    title="Open chart with Fib drawn"
                  >
                    <td>{i + 1}</td>
                    <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
                    <td>{r.type || "—"}</td>
                    <td className={`scanner-signals-flag ${r.entry != null ? "on" : ""}`}>
                      {r.entry != null ? (
                        <div className="scanner-signals-stage">
                          <span className="scanner-signals-stage-check">✓</span>
                          <span className="scanner-signals-stage-ts">{fmt(r.entry)}{entryTime ? ` · ${formatDateTimeIST(entryTime)}` : ""}</span>
                        </div>
                      ) : "—"}
                    </td>
                    {showExit && (
                      <td className={`scanner-signals-flag ${r.exit != null ? "on" : ""}`}>
                        {r.exit != null ? (
                          <div className="scanner-signals-stage">
                            <span className="scanner-signals-stage-check">✓</span>
                            <span className="scanner-signals-stage-ts">{fmt(r.exit)}{exitTime ? ` · ${formatDateTimeIST(exitTime)}` : ""}</span>
                          </div>
                        ) : "—"}
                      </td>
                    )}
                    <td>
                      {r.dw ? (
                        <span className={`scanner-signals-mw ${dwBull ? "bull" : "bear"}`}>
                          {dwBull ? "▲ Bull" : "▼ Bear"}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="scanner-signals-ts">{formatDateTimeIST(r.dwTime || r.scannedAt)}</td>
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
  // NEW — R/E/F sub-filter, only meaningful when the combined "Type E,R,F"
  // strategy is active. "all" = the combined view (type-ref: whichever of
  // E/R/F most recently triggered per symbol). "R"/"E"/"F" switch the data
  // source to that individual strategy's own full result set (type-r/
  // type-e/type-f — each has its own independent Active Event Rule state,
  // so this is NOT the same as filtering the combined view's rows by
  // r.type — a symbol can have an R event that isn't its most-recent
  // trigger, and the combined view would hide it).
  const [typeSubFilter, setTypeSubFilter] = useState("all");

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

  // FIX (2026-08-18) — this used to fetch by strategyId ONLY, with no
  // assetClass/instrumentType/resolution in the request at all. The
  // backend had nothing to scope by, so switching the Asset Class /
  // Instrument Type dropdown never changed what came back — you'd keep
  // seeing whatever category was scanned first (e.g. picking "Commodity"
  // still showed leftover EQ rows from an earlier scan). Now every fetch
  // is scoped to the exact combo currently selected in the UI, matching
  // the comboKey the backend wrote that scan's results under (see
  // scannerRunner.js / scannerRouter.js). Switching filters to a combo
  // that was already scanned shows that combo's cached results instantly;
  // switching to a combo never scanned shows the empty state until the
  // user hits Scan Now — no accidental carryover from a different combo.
  const fetchResults = useCallback(async (stratId, tf, ac, it) => {
    if (!stratId) return;
    try {
      // per_page matches scannerRouter.js's raised cap (5000) — see the
      // fix note there. Requesting fewer than the full accumulated
      // multi-category result set would reintroduce the same truncation
      // bug from the frontend side.
      const params = new URLSearchParams({
        per_page: "5000",
        resolution: String(tf),
        assetClass: ac,
        instrumentType: it,
      });
      const r = await fetch(`${BACKEND}/api/scanner/results/${stratId}?${params.toString()}`).then(r => r.json());
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

  // Active strategy's family — different strategy families use different
  // patternStage vocabularies (see TypeSignalsTable comment above), so
  // stats + tables below branch on this instead of assuming s1s2s3's
  // "s1"/"s2"/"s3_complete" everywhere. `group` comes from
  // scannerRunner.js's getStrategies().
  const activeStrategyMeta = useMemo(
    () => strategies.find(s => s.id === activeStrategy) || null,
    [strategies, activeStrategy]
  );
  const isTypeGroup = activeStrategyMeta?.group === "type";

  // TG T5 — own row shapes entirely (P1–P6 timeline, live/confirmed/
  // cancelled status), nothing like s1s2s3's or type's patternStage
  // vocabulary, so it gets its own branch + its own self-contained panel
  // (T5ScannerPanel) instead of going through SignalsTable/TypeSignalsTable.
  const isT5 = activeStrategy === "tg-t5";

  // 9EMA Absorption / Flip Break — own row shapes entirely (Absorption /
  // Breakthrough tabs, latest+previous signal with exact candle timestamp),
  // nothing like s1s2s3's/type's patternStage vocabulary or T5's P1-P6
  // timeline, so it gets its own branch + its own self-contained panel
  // (AbsorptionFlipScannerPanel), same pattern as isT5/T5ScannerPanel above.
  const isAbsorptionFlip = activeStrategy === "absorption-flip";

  // Dropdown-eligible strategies only — excludes variant:"single" entries
  // (type-e/type-r/type-f), which are tab-only, reachable via the R/E/F
  // buttons next to Results/Upcoming instead. Previously the dropdown
  // listed every registered strategy including these three, which is why
  // "Type E", "Type R", "Type F" showed up as separate confusing dropdown
  // entries alongside "Type E,R,F".
  const dropdownStrategies = useMemo(
    () => strategies.filter(s => s.variant !== "single"),
    [strategies]
  );

  // The strategyId actually fetched — the combined "type-ref" id unless
  // an R/E/F sub-filter is active, in which case we hit that individual
  // strategy's own result set directly (see typeSubFilter comment above).
  const effectiveStrategyId = isTypeGroup && typeSubFilter !== "all"
    ? `type-${typeSubFilter.toLowerCase()}`
    : activeStrategy;

  // FIX (2026-08-19) — switching strategies (e.g. "Type E,R,F" -> "TG T5")
  // left the OLD strategy's `results` in state until the new fetch
  // resolved. Different strategy families use different row shapes —
  // Type's events carry `.type`, TG T5's carry `.tag` — so for that one
  // async gap, `isT5` was already true while `results` still held Type's
  // rows, and t5ResultShape.js's buildScannerRows() ran on them looking
  // for `.tag`, which doesn't exist on a Type event -> crashed the whole
  // Scanner page ("Cannot read properties of undefined (reading
  // 'indexOf')"). Wiping `results` synchronously on strategy switch closes
  // that gap: the T5 panel now renders its own empty state for one tick
  // instead of another strategy's incompatible data.
  useEffect(() => {
    setResults([]);
  }, [effectiveStrategyId]);

  // FIX (2026-08-18) — previously only depended on [effectiveStrategyId,
  // lastScan], so changing Asset Class / Instrument Type / Timeframe
  // never triggered a refetch at all — the table just kept showing
  // whatever the last fetch (for a possibly different combo) had loaded.
  // Now timeframe/assetClass/instrumentType are in the dependency array,
  // so selecting a different combo immediately re-fetches — and shows
  // that combo's own cached results (or the empty state) instead of
  // stale rows from whatever was previously selected.
  useEffect(() => {
    if (effectiveStrategyId) fetchResults(effectiveStrategyId, timeframe, assetClass, instrumentType);
  }, [effectiveStrategyId, lastScan, timeframe, assetClass, instrumentType, fetchResults]);

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
    setTypeSubFilter("all"); // R/E/F sub-filter only applies within Type E,R,F
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

  // Active strategy's family + effectiveStrategyId are computed earlier
  // (right after the strategy/typeSubFilter state), since fetchResults
  // needs them before this point.

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

  // "Full Signals" is generic across families — r.found means the same
  // thing everywhere (s1s2s3: s3 confirmed; type: latest event exited).
  // "Watching"/"S1 Formed" need the family-specific in-progress stage.
  const counts = useMemo(() => {
    if (isTypeGroup) {
      return {
        signals: results.filter(r => r.found).length,
        partial: results.filter(r => r.patternStage === "active").length,
        s1: results.filter(r => r.patternStage !== "none").length, // any event ever triggered
      };
    }
    if (isAbsorptionFlip) {
      // patternStage here is absorptionFlip.js's LATEST event's type only
      // ("absorption_break" | "flip_break" | "none") — AbsorptionFlipScannerPanel
      // itself counts every symbol with each signal type (not just latest),
      // this top bar is just a quick at-a-glance summary.
      return {
        signals: results.filter(r => r.found).length,
        partial: results.filter(r => r.patternStage === "flip_break").length,
        s1: results.filter(r => r.patternStage === "absorption_break").length,
      };
    }
    return {
      signals: results.filter(r => r.patternStage === "s3_complete").length,
      partial: results.filter(r => r.patternStage === "s2").length,
      s1: results.filter(r => r.patternStage === "s1").length,
    };
  }, [results, isTypeGroup, isAbsorptionFlip]);

  // Results table — fully confirmed signals, ALL of them (no 10-row cap —
  // the table wrapper itself scrolls after ~10 visible rows via CSS
  // max-height, see .scanner-signals-table-wrap in ScannerPage.css).
  const resultsTable = useMemo(() => {
    const stage = isTypeGroup ? "completed" : "s3_complete";
    return results
      .filter(r => r.patternStage === stage)
      .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt));
  }, [results, isTypeGroup]);

  // Upcoming table — in-progress, not yet fully confirmed, ALL of them
  // (same scroll-not-truncate behaviour as resultsTable above).
  const upcomingTable = useMemo(() => {
    const stage = isTypeGroup ? "active" : "s2";
    return results
      .filter(r => r.patternStage === stage)
      .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt));
  }, [results, isTypeGroup]);

  // TG T5 — reshape raw scan() results (flat event log + engine state)
  // into the Results/Upcoming row shapes T5ScannerPanel needs. No-op
  // (empty arrays) whenever isT5 is false, so this is safe to always
  // compute — it just won't be rendered.
  const t5Rows = useMemo(
    () => (isT5 ? buildScannerRows(results) : { results: [], upcoming: [] }),
    [results, isT5]
  );

  // 9EMA Absorption / Flip Break — reshape raw scan() results (flat event
  // log, most-recent-first) into the Absorption/Breakthrough row shapes
  // AbsorptionFlipScannerPanel needs. No-op (empty arrays) whenever
  // isAbsorptionFlip is false, so this is safe to always compute.
  const absorptionFlipRows = useMemo(
    () => (isAbsorptionFlip ? buildAbsorptionFlipRows(results) : { absorption: [], breakthrough: [] }),
    [results, isAbsorptionFlip]
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
        <div className="stat-chip"><span className="stat-chip-label">{isTypeGroup ? "Active" : isAbsorptionFlip ? "Latest: Breakthrough" : "Watching (S2)"}</span><span className="stat-chip-val orange">{counts.partial}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">{isTypeGroup ? "Ever Triggered" : isAbsorptionFlip ? "Latest: Absorption" : "S1 Formed"}</span>  <span className="stat-chip-val">{counts.s1}</span></div>
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

        {/* Strategy — dropdown shows only variant:"combined"/undefined
            entries. variant:"single" (type-e/type-r/type-f) are excluded
            here — they're reachable only via the R/E/F buttons next to
            Results/Upcoming when "Type E,R,F" is active (see below). */}
        {dropdownStrategies.length > 0 && (
          <div className="scanner-strategy-group">
            <select
              className="scanner-strategy-select"
              value={activeStrategy || ""}
              onChange={(e) => handleStrategyChange(e.target.value)}
              title="Select strategy"
            >
              {dropdownStrategies.map(s => (
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
            {isT5 ? (
              // T5ScannerPanel is fully self-contained — its own Results/
              // Upcoming tabs, stats row, and Scan Now button — so it
              // replaces the tabs bar + SignalsTable/TypeSignalsTable
              // branch below entirely rather than plugging into either.
              <T5ScannerPanel
                rows={t5Rows}
                scannedCount={results.length}
                resolution={tfLabel}
                onRowClick={(symbol) => openT5Chart(symbol, timeframe)}
              />
            ) : isAbsorptionFlip ? (
              // AbsorptionFlipScannerPanel is fully self-contained — its
              // own Absorption/Breakthrough tabs, stats row — so like
              // T5ScannerPanel it replaces the tabs bar + SignalsTable/
              // TypeSignalsTable branch below entirely rather than
              // plugging into either.
              <AbsorptionFlipScannerPanel
                rows={absorptionFlipRows}
                scannedCount={results.length}
                resolution={tfLabel}
                onRowClick={(symbol) => openAbsorptionFlipChart(symbol, timeframe)}
              />
            ) : (
              <>
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

                  {/* R/E/F sub-filter — only meaningful within "Type E,R,F",
                      so only rendered when that strategy is active. Switches
                      effectiveStrategyId (see above) between the combined
                      type-ref view and each individual type's own full result
                      set. */}
                  {isTypeGroup && (
                    <div className="scanner-signals-typefilter">
                      {["all", "R", "E", "F"].map(t => (
                        <button
                          key={t}
                          className={`scanner-signals-typefilter-btn ${typeSubFilter === t ? "active" : ""}`}
                          onClick={() => setTypeSubFilter(t)}
                          title={t === "all" ? "Combined — whichever of E/R/F most recently triggered" : `Type ${t} only`}
                        >
                          {t === "all" ? "All" : t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {isTypeGroup ? (
                  signalsTab === "results" ? (
                    <TypeSignalsTable
                      title="Results"
                      sub="Entry → exit confirmed — all, scroll for more"
                      rows={resultsTable}
                      showExit={true}
                      emptyLabel="No completed signals yet"
                      timeframe={timeframe}
                    />
                  ) : (
                    <TypeSignalsTable
                      title="Upcoming"
                      sub="Entry fired, still active — all, scroll for more"
                      rows={upcomingTable}
                      showExit={false}
                      emptyLabel="No active signals yet"
                      timeframe={timeframe}
                    />
                  )
                ) : signalsTab === "results" ? (
                  <SignalsTable
                    title="Results"
                    sub="S1 → S2 → S3 confirmed — all, scroll for more"
                    rows={resultsTable}
                    showS3={true}
                    emptyLabel="No completed signals yet"
                    timeframe={timeframe}
                  />
                ) : (
                  <SignalsTable
                    title="Upcoming"
                    sub="S1 → S2 confirmed, S3 pending — all, scroll for more"
                    rows={upcomingTable}
                    showS3={false}
                    emptyLabel="No forming signals yet"
                    timeframe={timeframe}
                  />
                )}
              </>
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