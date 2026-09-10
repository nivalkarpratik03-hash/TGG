// ScannerPage.js
// Layout (top→bottom):
//   1. Header — back / title / theme / status
//   2. Control bar — asset class, strategy, instrument type, timeframe, scan now
//   3. TWO SECTIONS:
//      A) RESULTS/UPCOMING — exactly ONE of 6 fully self-contained panels
//         renders here depending on the active strategy family, each with
//         its OWN stats row, tabs, and symbol search box baked in:
//         S1S2S3ScannerPanel | TypeScannerPanel | T5ScannerPanel |
//         AbsorptionScannerPanel | CeilingBreakScannerPanel |
//         PinakaScannerPanel. There is no shared stats bar or shared tabs
//         bar anymore — ScannerPage.js's only job here is picking which
//         one to render.
//      B) MOTHERWAVE DASHBOARD — latest wave per symbol, sorted by wave size
//         (uptrend | downtrend columns, then Zone Segregation trays) —
//         unrelated to the strategy panels above, always shown.
//   Clicking any stock card/row opens chart in new tab with fib retracement drawn
//
// r.motherwave is now the full { wave, fibLevels, invalidation } shape from
// detectMotherWaveForAPI. All field access goes through r.motherwave.wave.*

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { createBackendSocket } from "../../utils/backendSocket";
import { BACKEND } from "../../config";
import { useTheme } from "../../App";
import { fmt } from "../../utils/format";
import { tickerOf, exchangeOf } from "../../utils/symbolMeta";
import { TIMEFRAMES } from "../../utils/formatResolution";
import {
  mwWave, isMWBull, waveSize, getZoneTray, buildChartUrl,
} from "./mwScanHelpers";
import { buildScannerRows } from "./t5ResultShape";
import T5ScannerPanel from "./T5ScannerPanel";
import AbsorptionScannerPanel from "./AbsorptionScannerPanel";
import { buildAbsorptionRows } from "./absorptionResultShape";
import CeilingBreakScannerPanel from "./CeilingBreakScannerPanel";
import { buildCeilingBreakRows } from "./ceilingBreakResultShape";
import PinakaScannerPanel from "./PinakaScannerPanel";
import { buildPinakaRows } from "./pinakaResultShape";
import S1S2S3ScannerPanel from "./S1S2S3ScannerPanel";
import TypeScannerPanel from "./TypeScannerPanel";
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
function openChart(symbol, timeframe, mw) {
  window.open(buildChartUrl(symbol, timeframe, mw), "_blank");
}

function openT5Chart(symbol, timeframe) {
  window.open(buildChartUrl(symbol, timeframe, null, { t5: true }), "_blank");
}

function openAbsorptionChart(symbol, timeframe) {
  // No mw object (this strategy isn't motherwave-driven) and no special
  // chart flag needed — buildChartUrl already handles mw=null cleanly
  // (see mwScanHelpers.js), same as openT5Chart's pattern minus the
  // t5-specific opts flag.
  window.open(buildChartUrl(symbol, timeframe, null), "_blank");
}

function openCeilingBreakChart(symbol, timeframe) {
  // Same non-motherwave pattern as openAbsorptionChart — no mw object,
  // no special chart flag (that's Chunk 8/9's job once the indicator
  // draw layer exists). Kept separate rather than reusing
  // openAbsorptionChart directly so a future ceiling-specific chart flag
  // (mirroring T5's `{ t5: true }`) has an obvious home later.
  window.open(buildChartUrl(symbol, timeframe, null), "_blank");
}

function openPinakaChart(symbol, timeframe) {
  // Same non-motherwave pattern as openCeilingBreakChart/openAbsorptionChart
  // — no mw object, no auto-toggle opts flag. T5 has a `{ t5: true }` flag
  // that pre-enables its overlay on open (see urlT5 threaded through
  // ChartsPage.js), but that's a deeper, multi-site wire-up specific to
  // T5's own route history; Pinaka follows CeilingBreak's simpler
  // precedent instead — the chart opens plain, and the Pinaka toggle in
  // the Indicators panel turns the overlay on.
  window.open(buildChartUrl(symbol, timeframe, null), "_blank");
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
  // NEW — per-combo, per-strategy last-scanned timestamp, read from
  // /api/scanner/results/:strategyId's new `scannedAt` field (see
  // scannerRouter.js). Replaces the global `lastScan` (status.lastScanAt)
  // as what's actually shown in each panel's "Last scan" display — `lastScan`
  // itself is still tracked (see fetchStatus/socket handlers below) purely
  // as a refetch trigger: "some scan somewhere just completed, go refetch",
  // not as a value ever rendered directly anymore. Without this split, the
  // Scanner UI would show the timestamp of whatever was scanned MOST
  // RECENTLY ANYWHERE, even if that was a completely different
  // strategy+timeframe+assetClass+instrumentType combo than the one
  // currently on screen.
  const [comboScannedAt, setComboScannedAt] = useState(null);
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
      // NEW — per-combo, per-strategy scan time straight from this exact
      // request's response (see scannerRouter.js's new `scannedAt` field),
      // not the global status.lastScanAt. See comboScannedAt's own
      // declaration comment above for why this split matters.
      setComboScannedAt(r.scannedAt || null);
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
  // patternStage vocabularies (see TypeScannerPanel.js's header comment),
  // so stats + tables below branch on this instead of assuming s1s2s3's
  // "s1"/"s2"/"s3_complete" everywhere. `group` comes from
  // scannerRunner.js's getStrategies(). This drives which of the 4
  // self-contained panels (S1S2S3ScannerPanel / TypeScannerPanel /
  // T5ScannerPanel / AbsorptionScannerPanel) renders below.
  const activeStrategyMeta = useMemo(
    () => strategies.find(s => s.id === activeStrategy) || null,
    [strategies, activeStrategy]
  );
  const isTypeGroup = activeStrategyMeta?.group === "type";

  // TG T5 — own row shapes entirely (P1–P6 timeline, live/confirmed/
  // cancelled status), nothing like s1s2s3's or type's patternStage
  // vocabulary, so it gets its own branch to its own self-contained
  // panel (T5ScannerPanel).
  const isT5 = activeStrategy === "tg-t5";

  // 9EMA Absorption / Flip Break — same self-contained-panel treatment as
  // T5 above: its own event/state shape (events[]/results[]/state), not
  // s1s2s3's or type's patternStage vocabulary, so it gets its own branch
  // to its own panel (AbsorptionScannerPanel). Matched by id directly,
  // same as isT5 — absorptionFlip.js exports id: "absorption-flip" (see
  // strategyRegistry.js), no group field needed for this check.
  const isAbsorption = activeStrategy === "absorption-flip";

  // Ceiling Break & Retest — same self-contained-panel treatment as T5/
  // Absorption above: its own state/events shape (see
  // ceilingBreakResultShape.js's header), not s1s2s3's or type's
  // patternStage vocabulary, so it gets its own branch to its own panel
  // (CeilingBreakScannerPanel). Matched by id directly, same as isT5/
  // isAbsorption — ceilingBreakRetest.js exports id: "ceiling-break-retest"
  // (see strategyRegistry.js), no group field needed for this check.
  const isCeilingBreak = activeStrategy === "ceiling-break-retest";

  // Pinaka (A1/A2/B/B2) — same self-contained-panel treatment as T5/
  // Absorption/CeilingBreak above: its own flat signal-list shape (see
  // pinakaResultShape.js's header), not s1s2s3's or type's patternStage
  // vocabulary, so it gets its own branch to its own panel
  // (PinakaScannerPanel). Matched by id directly — pinaka.js exports
  // id: "pinaka" (see strategyRegistry.js), no group field needed.
  const isPinaka = activeStrategy === "pinaka";

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
    // NEW — same reasoning as the setResults([]) fix above: without this,
    // switching strategies could briefly show the PREVIOUS strategy's
    // comboScannedAt next to the new (empty) results for one tick.
    setComboScannedAt(null);
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
        // NEW — strategyId scopes this scan to just the dropdown's
        // selected strategy family (see scannerRunner.js's
        // resolveStrategiesToRun). Sends `activeStrategy` (the actual
        // dropdown selection, e.g. "type-ref"), NOT `effectiveStrategyId`
        // — if an R/E/F tab is active, effectiveStrategyId would be e.g.
        // "type-e" alone, which would scan ONLY Type E and leave type-r/
        // type-f/type-ref stale. The dropdown's strategy is always the
        // right scope for what "Scan Now" should run.
        body: JSON.stringify({ resolution: timeframe, assetClass, instrumentType, strategyId: activeStrategy }),
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
    return {
      signals: results.filter(r => r.patternStage === "s3_complete").length,
      partial: results.filter(r => r.patternStage === "s2").length,
      s1: results.filter(r => r.patternStage === "s1").length,
    };
  }, [results, isTypeGroup]);

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

  // Absorption/Flip — reshape raw scan() results (event log + engine
  // state) into Results/Upcoming/History for AbsorptionScannerPanel.
  // No-op (empty arrays) whenever isAbsorption is false, same guard
  // pattern as t5Rows above.
  const absorptionRows = useMemo(
    () => (isAbsorption ? buildAbsorptionRows(results) : { results: [], upcoming: [], history: [] }),
    [results, isAbsorption]
  );

  // Ceiling Break & Retest — reshape raw scan() results (events[]/state)
  // into Results/Upcoming/History for CeilingBreakScannerPanel. No-op
  // (empty arrays) whenever isCeilingBreak is false, same guard pattern
  // as absorptionRows above.
  const ceilingBreakRows = useMemo(
    () => (isCeilingBreak ? buildCeilingBreakRows(results) : { results: [], upcoming: [], history: [] }),
    [results, isCeilingBreak]
  );

  // Pinaka — reshape raw scan() results (signals[]/tag/side) into a flat
  // Results list for PinakaScannerPanel. No-op (empty) whenever isPinaka
  // is false, same guard pattern as ceilingBreakRows above.
  const pinakaRows = useMemo(
    () => (isPinaka ? buildPinakaRows(results) : { results: [], counts: { a1: 0, a2: 0, b: 0, b2: 0 } }),
    [results, isPinaka]
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
            // NEW — symbolCount was the full boot-time universe across every
            // asset class + all generated futures contracts (e.g. 826),
            // nothing to do with what's currently selected. lastScopedSymbolCount
            // is the last completed scan's actual scoped size (e.g. 202 for
            // Equity/Spot) — matches the "Scanned" stat chip. Falls back to
            // symbolCount only if no scan has completed yet this session.
            // strategies.length also used to count all 7 registry entries,
            // including type-e/type-r/type-f — 3 hidden variants that exist
            // only to power the R/E/F sub-filter buttons, not real dropdown
            // choices. dropdownStrategies (below) already excludes those,
            // giving the true count of 4 selectable strategy families.
            : `${status?.lastScopedSymbolCount ?? status?.symbolCount ?? 0} symbols · ${dropdownStrategies.length} strategies`}
        </div>
      </div>

      {/* Progress bar */}
      <div className="scanner-progress-bar-wrap">
        <div className="scanner-progress-bar" style={{ width: isRunning ? `${pct}%` : "0%" }} />
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
          {/* No shared stats bar / tabs bar left here at all — every
              strategy family renders its own fully self-contained panel
              (own stats row, own tabs, own search box). ScannerPage.js's
              only job here is picking which ONE of the 4 to render. */}
          <div className="scanner-section scanner-signals-section">
            {isT5 ? (
              <T5ScannerPanel
                rows={t5Rows}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                onRowClick={(symbol) => openT5Chart(symbol, timeframe)}
              />
            ) : isAbsorption ? (
              <AbsorptionScannerPanel
                rows={absorptionRows}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                onRowClick={(symbol) => openAbsorptionChart(symbol, timeframe)}
              />
            ) : isCeilingBreak ? (
              <CeilingBreakScannerPanel
                rows={ceilingBreakRows}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                onRowClick={(symbol) => openCeilingBreakChart(symbol, timeframe)}
              />
            ) : isPinaka ? (
              <PinakaScannerPanel
                rows={pinakaRows}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                onRowClick={(symbol) => openPinakaChart(symbol, timeframe)}
              />
            ) : isTypeGroup ? (
              <TypeScannerPanel
                rows={{ results: resultsTable, upcoming: upcomingTable }}
                counts={counts}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                timeframe={timeframe}
                typeSubFilter={typeSubFilter}
                onTypeSubFilterChange={setTypeSubFilter}
                onRowClick={(symbol, mw) => openChart(symbol, timeframe, mw)}
              />
            ) : (
              <S1S2S3ScannerPanel
                rows={{ results: resultsTable, upcoming: upcomingTable }}
                counts={counts}
                scannedCount={results.length}
                resolution={tfLabel}
                lastScan={comboScannedAt}
                durationMs={status?.lastScanDurationMs}
                timeframe={timeframe}
                onRowClick={(symbol, mw) => openChart(symbol, timeframe, mw)}
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