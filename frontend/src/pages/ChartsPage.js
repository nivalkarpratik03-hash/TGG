// ChartsPage.js
// ─── Each panel is 100% independent (TradingView-style):
// ─────  Own navbar, own symbol, own resolution, own drawings, own indicators
// ─────  Nothing bleeds between panels
// ─── Layout: LAYOUT button only (no DUAL button)
// ─────  Single / 2 Side-by-Side / 2 Stacked / 3 Panels / 4 Panels
// ─── Draggable dividers in ALL multi-panel layouts
// ─────  col-resize handle between columns, row-resize handle between rows
// ─── ONE global TradingToolbar (fixed left) — shared across all panels.
// ─────  activePanel tracks which panel was last clicked/interacted with.
// ─────  Only the active panel accepts new drawing input.
// ─────  When link is ON, drawing broadcasts to all panels with same symbol.
// ─── Synced crosshair: when mouse moves on any panel, all panels with the
// ─────  SAME SYMBOL show the crosshair price as a dashed horizontal line.
// ─────────────────────────────────────────────────────────────────────────────
import React, {
  useState, useCallback, useEffect, useRef, useMemo, memo,
} from "react";
import { useLocation } from "react-router-dom"; // eslint-disable-line no-unused-vars
import StatusBar from "../components/StatusBar";
import SymbolSearch from "../components/SymbolSearch";
import OptionsChainModal from "../components/OptionsChainModal";
import CandleChart from "../components/CandleChart";
import SignalTable from "../components/SignalTable";
import StatsPanel from "../components/StatsPanel";
import WaveSignalTable from "../components/WaveSignalTable";
import WaveStatsPanel from "../components/WaveStatsPanel";
import ConsolidationZoneTable from "../components/ConsolidationZoneTable";
import ConsolidationStatsPanel from "../components/ConsolidationStatsPanel";
import EmaFloatPanel from "../components/EmaFloatPanel";
import TradingToolbar from "../components/TradingToolbar";
import AtmWorkspace from "../components/AtmWorkspace";
import { DrawingProvider, usePanelLink, setAllLinked } from "../components/DrawingContext";
import { useSocket } from "../hooks/useSocket";
import { buildDefaultIndicators } from "../indicators/indicatorRegistry";
import { toISTDate } from "../utils/istUtils";
import { loadPref, savePref } from "../utils/prefs";
import { formatResolution } from "../utils/formatResolution";
import {
  isOptionSymbol, parseOptionSymbol, getOptionRoot,
  getStrikeStep, nearestStrikeWithHysteresis,
  NSE_INDEX_TICKERS,
} from "../utils/optionsChain";
import { LAYOUTS } from "../components/layout/LayoutPicker";
import ErrorBoundary from "../components/ErrorBoundary";
import { ChartPanelPropTypes } from "./ChartPanelPropTypes";
import { BACKEND } from "../config";
import "../styles/ChartsPage.css";

// Symbol types that support an options chain: NSE/BSE equities & indices,
// and MCX dated commodity futures. Shared by the "Options" overlay button
// and the Ctrl+Q/Ctrl+D ATM shortcuts so both always agree on eligibility.
const OPTIONS_ELIGIBLE_RE = /^(NSE:[A-Z0-9&]+-(EQ|INDEX)|BSE:[A-Z0-9&]+-INDEX|MCX:[A-Z0-9]+\d{2}[A-Z]{3}FUT)$/i;


// ─── SidebarSection — defined OUTSIDE so it never remounts ────────────────────
const SidebarSection = memo(function SidebarSection({ id, title, color, tab, onTabChange, children }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px 4px",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text3)", textTransform: "uppercase" }}>
          {title}
        </span>
      </div>
      <div className="tabs">
        <button className={`tab-btn ${tab === "signals" ? "active" : ""}`} onClick={() => onTabChange(id, "signals")}>
          {children.signalLabel}
        </button>
        <button className={`tab-btn ${tab === "stats" ? "active" : ""}`} onClick={() => onTabChange(id, "stats")}>
          Stats
        </button>
      </div>
      <div className="tab-content">
        {tab === "signals" ? children.signals : children.stats}
      </div>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ChartPanel — one fully independent chart panel (TradingView style).
// ═══════════════════════════════════════════════════════════════════════════════
const ChartPanel = memo(function ChartPanel({
  pfx,
  showSidebar,
  panelIdx,
  panelCount,
  layoutId,
  onLayoutChange,
  urlSymbol,
  urlResolution,
  urlWaveTarget,
  urlFibDrawing,
  urlSrLines,
  // Global toolbar state (from ChartsPage)
  selectedTool,
  setSelectedTool,
  drawColor,
  isActivePanel,
  onPanelActivate,
  panelActionsRef,
  setActivePanelHidden,
  panelLinkRef,
  setToolbarLinked,
  // ── Synced crosshair ──────────────────────────────────────────────────────
  // price+symbol broadcast by whichever panel the mouse is on
  syncedCrosshairPrice,   // number | null
  syncedCrosshairSymbol,  // string | null  — symbol that produced the price
  onSyncCrosshair,        // (price: number|null, symbol: string) => void
}) {
  // ── EACH PANEL has its own socket/data — fully independent ─────────────────
  const { chartData, connected, loading, error, refresh, tickStreamActive, ticksFlowing, underlyingTick, setUnderlying } = useSocket();

  // ── Symbol / resolution / mode — all namespaced by pfx ────────────────────
  const [symbol, setSymbol] = useState(() => urlSymbol || loadPref(pfx + "symbol", "NSE:NIFTY50-INDEX"));
  const [resolution, setResolution] = useState(() => urlResolution || loadPref(pfx + "resolution", 3));
  const [todayMode, setTodayMode] = useState(() => {
    if (urlSymbol || urlResolution) return false;
    return loadPref(pfx + "todayMode", true);
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => loadPref(pfx + "sidebarOpen", true));
  const [activeTabs, setActiveTabs] = useState(() =>
    loadPref(pfx + "activeTabs", { bubble: "signals", waves: "signals", consolidation: "zones" })
  );

  // ── Drawing link — symbol-based sync, only active when panelCount > 1 ────
  const { linked, setLinked, sharedDrawings, setSharedDrawings, publishDrawings, setAbsorbShared } = usePanelLink(
    `panel_${panelIdx ?? 0}`,
    symbol
  );

  // Persist panel preferences whenever they change.
  // pfx is stable for the panel's lifetime (it's a prop constant), so omitting
  // it from deps is safe — savePref is also stable (module-level function).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "symbol", symbol); }, [symbol]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "resolution", resolution); }, [resolution]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "todayMode", todayMode); }, [todayMode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "sidebarOpen", sidebarOpen); }, [sidebarOpen]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "activeTabs", activeTabs); }, [activeTabs]);

  // ── Drawings hidden — per panel ────────────────────────────────────────────
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const handleToggleHide = useCallback(() => setDrawingsHidden((v) => !v), []);
  const drawingOverlayExtRef = useRef(null);
  const handleTrashAll = useCallback(() => drawingOverlayExtRef.current?.clearAll(), []);

  // Register this panel's actions with the global toolbar when it becomes active
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = {
      ...panelActionsRef.current,
      toggleHide: handleToggleHide,
      trashAll: handleTrashAll,
      drawingsHidden,
    };
    if (setActivePanelHidden) setActivePanelHidden(drawingsHidden);
    // Register this panel's link state with the global toolbar
    if (panelLinkRef) {
      panelLinkRef.current = { linked, setLinked };
    }
    if (setToolbarLinked) setToolbarLinked(linked);
    // panelActionsRef / panelLinkRef are stable React refs — mutating .current
    // does not need to trigger re-runs. Including them in deps would cause
    // unnecessary re-registrations on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActivePanel, drawingsHidden, linked, handleToggleHide, handleTrashAll, setActivePanelHidden, setToolbarLinked, setLinked]);

  // ── SR Lines ───────────────────────────────────────────────────────────────
  const [srLinesToDraw, setSrLinesToDraw] = useState(() => urlSrLines || []);
  const [srLinesDrawn, setSrLinesDrawn] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const handleDrawSRLines = useCallback(() => {
    if (srLinesDrawn) {
      setSrLinesToDraw([]);
    } else if (urlSrLines?.length) {
      setSrLinesToDraw(urlSrLines);
    }
    // handleDrawSRLines reads srLinesDrawn and urlSrLines via closure — adding
    // the callback itself would cause an infinite loop via setSrLinesToDraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srLinesDrawn, urlSrLines]);

  // ── Indicators — namespaced per panel ─────────────────────────────────────
  const [indicators, setIndicators] = useState(() => {
    const defaults = loadPref(pfx + "indicators", buildDefaultIndicators());
    if (urlWaveTarget) return { ...defaults, waves: true };
    return defaults;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "indicators", indicators); }, [indicators]);

  const handleIndicatorChange = useCallback((id, enabled) => {
    setIndicators((prev) => ({ ...prev, [id]: enabled }));
  }, []);

  const bubbleOn = indicators.bubble !== false;
  const wavesOn = !!indicators.waves;
  const consolidationOn = !!indicators.consolidation;
  const srZonesOn = !!indicators.srZones;
  const bubbleGap = typeof indicators.bubbleGap === "number" ? indicators.bubbleGap : 4;
  const anySidebarIndicator = bubbleOn || wavesOn || consolidationOn;

  const prevAnyRef = useRef(bubbleOn || wavesOn || consolidationOn);
  useEffect(() => {
    const anyNow = bubbleOn || wavesOn || consolidationOn;
    const anyBefore = prevAnyRef.current;
    if (!anyBefore && anyNow) setSidebarOpen(true);
    if (anyBefore && !anyNow) setSidebarOpen(false);
    prevAnyRef.current = anyNow;
  }, [bubbleOn, wavesOn, consolidationOn]);

  // ── Wave data ──────────────────────────────────────────────────────────────
  const [wavePivots, setWavePivots] = useState([]);
  const [waveSegments, setWaveSegments] = useState([]);
  const handleWaveData = useCallback((pivots, segments) => {
    setWavePivots(pivots);
    setWaveSegments(segments);
  }, []);

  // ── Consolidation zone data ────────────────────────────────────────────────
  const [consolidationZones, setConsolidationZones] = useState([]);
  const handleConsolidationData = useCallback((zones) => {
    setConsolidationZones(zones);
  }, []);

  const chartResetRef = useRef(null);
  const handleResetViewReady = useCallback((fn) => { chartResetRef.current = fn; }, []);

  const [reloadToken, setReloadToken] = useState(0);
  const handleIntentionalReloadAck = useCallback(() => setReloadToken(0), []);
  const triggerIntentionalReload = useCallback(() => setReloadToken((t) => t + 1), []);

  // ── Refresh / symbol / resolution handlers ─────────────────────────────────
  const handleRefresh = useCallback((sym, res) => {
    triggerIntentionalReload();
    refresh(sym ?? symbol, res ?? resolution);
    // triggerIntentionalReload is stable (useCallback with []), so this is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, symbol, resolution, triggerIntentionalReload]);

  const handleSymbolChange = useCallback((sym) => setSymbol(sym), []);
  const handleResolutionChange = useCallback((res) => {
    setResolution(res);
    triggerIntentionalReload();
  }, [triggerIntentionalReload]);

  // ── Initial fetch ──────────────────────────────────────────────────────────
  const didInitialFetch = useRef(false);
  useEffect(() => {
    if (!didInitialFetch.current) {
      didInitialFetch.current = true;
      triggerIntentionalReload();
      refresh(symbol, resolution);
    }
    // Intentional mount-only effect — runs exactly once to trigger the initial
    // data fetch. refresh/symbol/resolution are read at call time via closure;
    // adding them would re-fetch on every symbol/resolution change (handled
    // separately by handleRefresh / handleResolutionChange).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fibInjectedRef = useRef(false);
  const candles = chartData?.candles || [];
  useEffect(() => {
    if (!urlFibDrawing || fibInjectedRef.current) return;
    if (!candles.length) return;
    if (!drawingOverlayExtRef.current?.addFibDrawing) return;
    fibInjectedRef.current = true;
    setTimeout(() => {
      drawingOverlayExtRef.current?.addFibDrawing({
        p1Price: urlFibDrawing.p1Price,
        p1Time: urlFibDrawing.p1Time ?? (urlWaveTarget?.toMs ? Math.round(urlWaveTarget.toMs / 1000) : null),
        p2Price: urlFibDrawing.p2Price,
        p2Time: urlFibDrawing.p2Time ?? (urlWaveTarget?.fromMs ? Math.round(urlWaveTarget.fromMs / 1000) : null),
        resolution: urlFibDrawing.resolution ?? resolution,
      });
    }, 800);
    // fibInjectedRef guards against double-injection. urlFibDrawing and
    // candles.length are the correct triggers — other url* values are stable
    // object refs that don't change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.length, urlFibDrawing]);

  // ── Symbol search modal ────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialQuery, setSearchInitialQuery] = useState("");

  // Type-to-search: opens this panel's SymbolSearch pre-seeded with the
  // character that was typed. Registered on panelActionsRef like
  // getAtmBaseSymbol, so the page-level keydown listener can call it on
  // whichever panel is active without that listener needing to know about
  // panel internals.
  //
  // APPENDS rather than replaces: the modal's own <input> only gains focus
  // ~60ms after opening (see SymbolSearch's effect), so if someone types
  // faster than that, the global page-level listener — not the input — is
  // still the one catching keystrokes for a moment. Appending here means
  // those extra fast keystrokes build up the query correctly instead of
  // each one stomping the last. Once the input is focused, normal typing
  // takes over via onChange as usual. searchOpenRef mirrors searchOpen
  // synchronously (refs don't batch/replay the way setState updaters can),
  // so this is safe to call repeatedly in quick succession.
  const searchOpenRef = useRef(false);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  const openSearchWithQuery = useCallback((firstChar) => {
    setSearchInitialQuery((prev) => (searchOpenRef.current ? prev + firstChar : firstChar));
    searchOpenRef.current = true;
    setSearchOpen(true);
  }, []);
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = { ...panelActionsRef.current, openSearchWithQuery };
  }, [isActivePanel, openSearchWithQuery, panelActionsRef]);

  // ── Options chain modal ────────────────────────────────────────────────────
  const [optionsChainOpen, setOptionsChainOpen] = useState(false);
  const [optionsChainUnderlying, setOptionsChainUnderlying] = useState(null);

  // ── Auto-ATM: keep an open option chart pinned to the at-the-money strike ──
  // Off by default — user opts in per panel via the toggle near the symbol
  // overlay. Persisted like other panel prefs so it survives a reload.
  const [autoAtmOn, setAutoAtmOn] = useState(() => loadPref(pfx + "autoAtm", false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { savePref(pfx + "autoAtm", autoAtmOn); }, [autoAtmOn]);

  // Parsed view of the current symbol, if it's an option contract.
  const parsedOption = useMemo(
    () => (isOptionSymbol(symbol) ? parseOptionSymbol(symbol) : null),
    [symbol]
  );

  // Register/clear the underlying LTP side-channel whenever the symbol or the
  // toggle changes. setUnderlying() itself no-ops if nothing actually changed,
  // so this is safe to run on every relevant render.
  useEffect(() => {
    setUnderlying(autoAtmOn && parsedOption ? symbol : null);
  }, [autoAtmOn, parsedOption, symbol, setUnderlying]);

  // Debounce bookkeeping — a breach of the hysteresis dead zone must hold for
  // AUTO_ATM_DEBOUNCE_MS before it actually triggers a switch. This is what
  // protects against a single spike tick causing a switch that then reverts.
  const AUTO_ATM_DEBOUNCE_MS = 3000;
  const pendingStrikeRef = useRef(null);   // strike the dead zone has been breached toward
  const pendingSinceRef = useRef(0);       // Date.now() when that breach was first observed

  // ── Real strike→symbol map for Auto-ATM strike switching ──────────────────
  // ROOT-CAUSE NOTE: switching strikes used to hand-build the new symbol via
  // optionSymbol() with a guessed Fyers date-encoding (the same broken
  // approach as the options chain modal and the Ctrl+Q/D shortcut — see
  // those for the full explanation). Fetching on every tick would be too
  // expensive/slow for a hysteresis watcher that runs on every price
  // update, so instead this fetches ONCE per option contract (same
  // underlying + same expiry) and caches the strike→symbol map; the
  // per-tick effect below just does a cheap Map lookup against it.
  const [autoAtmStrikeMap, setAutoAtmStrikeMap] = useState(new Map());
  useEffect(() => {
    if (!autoAtmOn || !parsedOption) {
      setAutoAtmStrikeMap(new Map());
      return;
    }
    const underlyingSymbolForLookup = NSE_INDEX_TICKERS[parsedOption.root]
      ? `${parsedOption.exch}:${NSE_INDEX_TICKERS[parsedOption.root]}`
      : `${parsedOption.exch}:${parsedOption.root}-EQ`;
    let cancelled = false;
    const params = new URLSearchParams({ symbol: underlyingSymbolForLookup, strikeCount: "20" });
    // NOTE: parseOptionSymbol() only gives us back the expiry CODE embedded
    // in the symbol string (e.g. "26JUL"), not a raw Fyers epoch timestamp —
    // and there's no reliable way to turn that code back into a timestamp
    // without reintroducing the same date-guessing problem this fix removes.
    // Omitting `timestamp` here returns the NEAREST expiry's strikes, which
    // matches the contract being viewed in the overwhelming majority of
    // cases (Auto-ATM is used on near-dated weekly/monthly options). If the
    // user has manually navigated to a far expiry, the lookup may miss and
    // the switch is simply skipped (see the !newSymbol guard below) rather
    // than risk sending a wrong-expiry symbol.
    fetch(`${BACKEND}/api/options/chain?${params.toString()}`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => {
        if (cancelled) return;
        const map = new Map();
        for (const s of data.strikes || []) map.set(`${s.strike_price}:${s.option_type}`, s.symbol);
        setAutoAtmStrikeMap(map);
      })
      .catch(() => { if (!cancelled) setAutoAtmStrikeMap(new Map()); });
    return () => { cancelled = true; };
    // Re-fetch when the option contract itself changes (new underlying/expiry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAtmOn, parsedOption?.exch, parsedOption?.root, parsedOption?.expiryCode]);

  useEffect(() => {
    if (!autoAtmOn || !parsedOption || !underlyingTick?.ltp) {
      pendingStrikeRef.current = null;
      return;
    }
    // getOptionRoot() expects an UNDERLYING symbol ("BSE:SENSEX-INDEX"), not
    // an option contract ("BSE:SENSEX25JUL77000CE") — rebuild the underlying
    // symbol from the parsed option so step/index lookup resolves correctly.
    const underlyingSymbolForLookup = NSE_INDEX_TICKERS[parsedOption.root]
      ? `${parsedOption.exch}:${NSE_INDEX_TICKERS[parsedOption.root]}`
      : `${parsedOption.exch}:${parsedOption.root}-EQ`;
    const underlyingInfo = getOptionRoot(underlyingSymbolForLookup);

    const spot = underlyingTick.ltp;
    const step = getStrikeStep(spot, underlyingInfo);
    const suggested = nearestStrikeWithHysteresis(spot, parsedOption.strike, step, 0.2);

    if (suggested === parsedOption.strike) {
      pendingStrikeRef.current = null; // back inside the dead zone — cancel any pending switch
      return;
    }

    const now = Date.now();
    if (pendingStrikeRef.current !== suggested) {
      // New breach direction/target — start (or restart) the debounce timer.
      pendingStrikeRef.current = suggested;
      pendingSinceRef.current = now;
      return;
    }
    if (now - pendingSinceRef.current < AUTO_ATM_DEBOUNCE_MS) return; // still settling

    // Debounce satisfied — switch the chart to the new strike, same expiry/kind.
    // Look up the REAL symbol from the cached live chain map (see effect
    // above) instead of hand-building one — if it's not in the map yet
    // (cache still loading, or Fyers doesn't list that strike), skip this
    // switch silently rather than send a symbol that would error out.
    const newSymbol = autoAtmStrikeMap.get(`${suggested}:${parsedOption.kind}`);
    if (!newSymbol) {
      pendingStrikeRef.current = null;
      return;
    }
    pendingStrikeRef.current = null;
    handleSymbolChange(newSymbol);
    handleRefresh(newSymbol, resolution);
    // handleSymbolChange/handleRefresh are stable useCallback refs; resolution
    // is read at call time. Re-running this effect on every underlyingTick is
    // intentional — that's the whole point of the watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAtmOn, parsedOption, underlyingTick, autoAtmStrikeMap]);

  // ── Ctrl+Q / Ctrl+D shortcuts: resolve the ATM base symbol for the ────────
  // shared 3-pane ATM Workspace (rendered once at ChartsPage level).
  // Reuses the exact eligibility check the "Options" overlay button already
  // uses, so the shortcut and the button always agree on which symbols
  // support an options chain (equities, NSE/BSE indices, MCX dated futures).
  //
  // ROOT-CAUSE FIX: this used to be `openOptionsAtm(kind)`, which mutated
  // THIS panel's own symbol in place, picking the nearest strike by
  // comparing candles[last].close against the fetched chain — i.e. whatever
  // price happened to be on screen. That's correct when the panel is showing
  // the underlying, but wrong once it's already showing an option: pressing
  // Ctrl+Q then Ctrl+D compared the fetched PE strikes against the CE
  // contract's own premium (e.g. ~₹410) instead of the underlying's spot
  // (e.g. ~78,000), landing on a essentially random low strike. Now this
  // panel only resolves WHICH underlying the shortcut applies to — the
  // workspace itself fetches the underlying's real spot and both strike
  // ladders fresh, so it never trusts an option's own price as a spot proxy.
  const [shortcutWarning, setShortcutWarning] = useState(null);
  useEffect(() => {
    if (!shortcutWarning) return;
    const t = setTimeout(() => setShortcutWarning(null), 3500);
    return () => clearTimeout(t);
  }, [shortcutWarning]);

  const getAtmBaseSymbol = useCallback(() => {
    // If a CE/PE symbol is ALREADY loaded, treat its own underlying as the
    // basis (so the shortcut works while already viewing an option chart,
    // not just from the underlying's chart).
    const optionHere = isOptionSymbol(symbol) ? parseOptionSymbol(symbol) : null;
    const baseSymbol = optionHere
      ? (NSE_INDEX_TICKERS[optionHere.root]
          ? `${optionHere.exch}:${NSE_INDEX_TICKERS[optionHere.root]}`
          : `${optionHere.exch}:${optionHere.root}-EQ`)
      : symbol;

    if (!baseSymbol || !OPTIONS_ELIGIBLE_RE.test(baseSymbol)) {
      setShortcutWarning(`Options aren't available for ${symbol || "this symbol"}.`);
      return null;
    }
    return { baseSymbol, resolution };
  }, [symbol, resolution]);

  // Registered separately from the main panelActionsRef effect above (which
  // runs earlier in this component, before getAtmBaseSymbol exists yet) —
  // spreads onto whatever's already in the ref so neither effect clobbers
  // the other's keys, regardless of mount/update order.
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = { ...panelActionsRef.current, getAtmBaseSymbol };
  }, [isActivePanel, getAtmBaseSymbol, panelActionsRef]);

  // ── Crosshair ──────────────────────────────────────────────────────────────
  const [crosshairBar, setCrosshairBar] = useState(null);
  const handleCrosshairMove = useCallback((bar) => setCrosshairBar(bar), []);

  // ── Synced crosshair: this panel shows synced line only if same symbol ─────
  // Only pass the synced price down if the broadcasting panel has the same symbol.
  const matchesSyncedSymbol = syncedCrosshairSymbol === symbol;
  const thisPanelSyncedPrice = matchesSyncedSymbol ? syncedCrosshairPrice : null;

  // onSyncCrosshair wrapper: include this panel's symbol so ChartsPage can filter
  const handleSyncCrosshair = useCallback((price) => {
    if (onSyncCrosshair) onSyncCrosshair(price, symbol);
  }, [onSyncCrosshair, symbol]);

  // ── Derived chart data ─────────────────────────────────────────────────────
  const emaHighs = chartData?.emaHighs || [];
  const emaLows = chartData?.emaLows || [];
  const signalsRaw = chartData?.signals || [];
  // Custom dep: fingerprint the signals array by content so this memo only
  // recomputes when signal type/time actually changes, not on every render
  // where the array reference changes but contents are the same.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const signals = useMemo(() => signalsRaw, [signalsRaw.map((s) => `${s.type}:${s.time}`).join("|")]);
  const currentState = chartData?.currentState ?? 0;
  const bestPrice = chartData?.bestPrice;
  const chartDataResolution = chartData?.resolution ?? resolution;
  const showLoadingScreen = loading && candles.length === 0;

  const todayIST = useMemo(() => new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), []);

  const displayedSignals = useMemo(() => {
    if (!todayMode) return signals;
    return signals.filter((s) => toISTDate(s.time) === todayIST);
  }, [signals, todayMode, todayIST]);

  const displayedWavePivots = useMemo(() => {
    if (!todayMode) return wavePivots;
    return wavePivots.filter((p) => toISTDate(p.time) === todayIST);
  }, [wavePivots, todayMode, todayIST]);

  const handleSidebarToggle = useCallback(() => {
    if (!anySidebarIndicator) return;
    setSidebarOpen((p) => !p);
  }, [anySidebarIndicator]);

  const setTab = useCallback((indicator, tab) => {
    setActiveTabs((prev) => ({ ...prev, [indicator]: tab }));
  }, []);

  const handleTodayToggle = useCallback(() => setTodayMode((p) => !p), []);

  const isPrimary = (panelIdx ?? 0) === 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="cp-panel">

      {/* StatusBar — each panel has its OWN statusbar, fully independent */}
      <div className="cp-statusbar">
        <StatusBar
          connected={connected}
          loading={loading}
          chartData={chartData}
          onRefresh={handleRefresh}
          symbol={symbol}
          resolution={resolution}
          onSymbolChange={handleSymbolChange}
          onResolutionChange={handleResolutionChange}
          onOpenSearch={() => setSearchOpen(true)}
          todayMode={todayMode}
          onTodayToggle={handleTodayToggle}
          crosshairBar={crosshairBar}
          onSidebarToggle={handleSidebarToggle}
          tickStreamActive={tickStreamActive}
          ticksFlowing={ticksFlowing}
          layoutId={isPrimary ? layoutId : undefined}
          onLayoutChange={isPrimary ? onLayoutChange : undefined}
          indicators={indicators}
          onIndicatorChange={handleIndicatorChange}
        />
      </div>

      {/* SymbolSearch modal */}
      <SymbolSearch
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        initialQuery={searchInitialQuery}
        onSelect={(sym) => {
          handleSymbolChange(sym);
          handleRefresh(sym, resolution);
        }}
        onOpenOptionsChain={(sym) => {
          // Load this underlying's chart too — gives the options chain a
          // real last-close price to center strikes on (reusing the normal
          // chart fetch; no extra Fyers call is made for this).
          handleSymbolChange(sym.symbol);
          handleRefresh(sym.symbol, resolution);
          setOptionsChainUnderlying(sym); // { symbol, name }
          setOptionsChainOpen(true);
        }}
      />

      {/* Options chain modal */}
      <OptionsChainModal
        isOpen={optionsChainOpen}
        onClose={() => setOptionsChainOpen(false)}
        underlying={optionsChainUnderlying}
        spot={
          optionsChainUnderlying?.symbol === symbol && candles.length
            ? candles[candles.length - 1].close
            : null
        }
        loading={loading && optionsChainUnderlying?.symbol === symbol}
        onSelect={(sym) => {
          handleSymbolChange(sym);
          handleRefresh(sym, resolution);
        }}
      />

      {/* Body: chart + optional sidebar */}
      <div className="cp-body">
        <div className="chart-area">
          {error && <div className="error-bar">⚠ {error}</div>}
          {shortcutWarning && !error && <div className="error-bar shortcut-warning-bar">⚠ {shortcutWarning}</div>}

          {/* Symbol overlay + quick Options button */}
          <div className="chart-overlay-row">
            <button
              className="chart-symbol-overlay"
              onClick={() => setSearchOpen(true)}
              title="Click to change symbol"
            >
              <span className="chart-symbol-overlay-ticker">
                {symbol ? symbol.split(":").pop() : "—"}
              </span>
              <span className="chart-symbol-overlay-res">
                {formatResolution(resolution)}
              </span>
            </button>

            {/* Only for plain equity/index symbols — the underlying types an
                options chain can actually be built from */}
            {symbol && OPTIONS_ELIGIBLE_RE.test(symbol) && (
              <button
                className="chart-symbol-overlay chart-options-btn"
                onClick={() => {
                  setOptionsChainUnderlying({
                    symbol,
                    name: symbol.split(":").pop().replace(/-(EQ|INDEX)$/i, ""),
                  });
                  setOptionsChainOpen(true);
                }}
                title="View options chain for this symbol"
              >
                Options
              </button>
            )}

            {/* Auto-ATM toggle — only shown while an option contract (CE/PE) is
                loaded. Off by default; switching on registers the underlying
                LTP side-channel and keeps this chart pinned near the at-the-
                money strike as spot moves, with a hysteresis dead zone so
                normal chop near a strike boundary doesn't keep re-switching. */}
            {parsedOption && (
              <button
                className={`chart-symbol-overlay chart-auto-atm-btn${autoAtmOn ? " chart-auto-atm-btn-on" : ""}`}
                onClick={() => setAutoAtmOn((v) => !v)}
                title={
                  autoAtmOn
                    ? "Auto ATM is ON — this chart will switch strikes as spot moves"
                    : "Auto ATM is OFF — click to keep this chart pinned to the ATM strike as spot moves"
                }
              >
                {autoAtmOn ? "Auto ATM ✓" : "Auto ATM"}
              </button>
            )}
          </div>

          {candles.length > 0 && (
            <EmaFloatPanel
              emaHighs={emaHighs}
              emaLows={emaLows}
              candles={candles}
              crosshairBar={crosshairBar}
            />
          )}

          {showLoadingScreen ? (
            <div className="loading-screen">
              <div className="loading-spinner" />
              <div>Loading chart data…</div>
            </div>
          ) : candles.length === 0 ? (
            <div className="loading-screen">
              <div className="no-data-msg">
                <div className="no-data-icon">📊</div>
                <div className="no-data-title">No Data Yet</div>
                <div className="no-data-sub">
                  Run <code>npm run generate</code> in the backend terminal,<br />
                  then click Refresh above.
                </div>
              </div>
            </div>
          ) : (
            <CandleChart
              candles={candles}
              emaHighs={emaHighs}
              emaLows={emaLows}
              signals={signals}
              currentState={currentState}
              todayMode={todayMode}
              onCrosshairMove={handleCrosshairMove}
              showBubble={bubbleOn}
              showWaves={wavesOn}
              onWaveData={handleWaveData}
              showConsolidation={consolidationOn}
              bubbleGap={bubbleGap}
              onConsolidationData={handleConsolidationData}
              showSRZones={srZonesOn}
              onResetViewReady={handleResetViewReady}
              reloadToken={reloadToken}
              onIntentionalReloadAck={handleIntentionalReloadAck}
              activeResolution={chartDataResolution}
              symbol={symbol}
              waveTarget={urlWaveTarget}
              panelKey={pfx || "p1"}
              selectedTool={selectedTool}
              setSelectedTool={setSelectedTool}
              drawingsHidden={drawingsHidden}
              drawingOverlayExtRef={drawingOverlayExtRef}
              srLines={srLinesToDraw}
              onSRLinesDrawn={setSrLinesDrawn}
              drawColor={drawColor}
              linkColor={linked ? "linked" : null}
              sharedDrawings={sharedDrawings}
              onPublishDrawings={publishDrawings}
              setAbsorbShared={setAbsorbShared}
              onClearSharedDrawings={() => setSharedDrawings([])}
              isActivePanel={isActivePanel}
              onPanelActivate={onPanelActivate}
              syncedCrosshairPrice={thisPanelSyncedPrice}
              onSyncCrosshair={handleSyncCrosshair}
              onSilentRefresh={() => refresh(symbol, resolution)}
            />
          )}
        </div>

        {/* Sidebar */}
        {showSidebar && anySidebarIndicator && (
          <div className={`sidebar ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
            <div className="sidebar-sections">

              {bubbleOn && (
                <div className="sidebar-section-wrap">
                  <SidebarSection
                    id="bubble"
                    title="Bubble"
                    color="var(--accent, #3d84ff)"
                    tab={activeTabs.bubble}
                    onTabChange={setTab}
                  >
                    {{
                      signalLabel: `Signals (${displayedSignals.length})`,
                      signals: <SignalTable signals={signals} candles={candles} todayMode={todayMode} />,
                      stats: <StatsPanel signals={signals} candles={candles} currentState={currentState} bestPrice={bestPrice} todayMode={todayMode} />,
                    }}
                  </SidebarSection>
                </div>
              )}

              {wavesOn && (
                <div className="sidebar-section-wrap">
                  <SidebarSection
                    id="waves"
                    title="Waves"
                    color="#f5a623"
                    tab={activeTabs.waves}
                    onTabChange={setTab}
                  >
                    {{
                      signalLabel: `Pivots (${displayedWavePivots.length})`,
                      signals: <WaveSignalTable wavePivots={wavePivots} todayMode={todayMode} />,
                      stats: <WaveStatsPanel wavePivots={wavePivots} waveSegments={waveSegments} todayMode={todayMode} />,
                    }}
                  </SidebarSection>
                </div>
              )}

              {consolidationOn && (
                <div className="sidebar-section-wrap">
                  <SidebarSection
                    id="consolidation"
                    title="Consolidation"
                    color="#a259ff"
                    tab={activeTabs.consolidation ?? "zones"}
                    onTabChange={setTab}
                  >
                    {{
                      signalLabel: `Zones (${consolidationZones.length})`,
                      signals: <ConsolidationZoneTable zones={consolidationZones} todayMode={todayMode} />,
                      stats: <ConsolidationStatsPanel zones={consolidationZones} todayMode={todayMode} />,
                    }}
                  </SidebarSection>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// Attach PropTypes — dev-only runtime validation (stripped in production build).
// Wrong prop type → console.error in the browser's DevTools console.
ChartPanel.propTypes = ChartPanelPropTypes;

// ═══════════════════════════════════════════════════════════════════════════════
// useDraggableSplit — draggable divider returning [pct, ref, onMouseDown]
// ═══════════════════════════════════════════════════════════════════════════════
function useDraggableSplit(dir, storageKey, min = 15, max = 85) {
  const [pct, setPct] = useState(() => loadPref(storageKey, 50));
  const isDragging = useRef(false);
  const containerRef = useRef(null);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = dir === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [dir]);

  useEffect(() => {
    function onMouseMove(e) {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let raw;
      if (dir === "col") {
        raw = ((e.clientX - rect.left) / rect.width) * 100;
      } else {
        raw = ((e.clientY - rect.top) / rect.height) * 100;
      }
      const clamped = Math.min(max, Math.max(min, raw));
      setPct(clamped);
      savePref(storageKey, clamped);
      window.dispatchEvent(new Event("resize"));
    }
    function onMouseUp() {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.dispatchEvent(new Event("resize"));
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dir, storageKey, min, max]);

  return [pct, containerRef, onMouseDown];
}

// ─── Divider handle component ─────────────────────────────────────────────────
function Divider({ dir, onMouseDown }) {
  const isCol = dir === "col";
  return (
    <div
      className={isCol ? "panel-divider-col" : "panel-divider-row"}
      onMouseDown={onMouseDown}
      title="Drag to resize"
    >
      <div className={isCol ? "divider-grip-col" : "divider-grip-row"}>
        <span /><span /><span />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layout renderers
// ═══════════════════════════════════════════════════════════════════════════════

function LayoutSingle({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  return (
    <div className="layout-single">
      <ErrorBoundary minimal label="Panel 1">
        <ChartPanel
          key="p0" pfx="" panelIdx={0} panelCount={1} showSidebar={true}
          layoutId={layoutId} onLayoutChange={onLayoutChange}
          urlSymbol={urlParams.symbol} urlResolution={urlParams.resolution}
          urlWaveTarget={urlParams.waveTarget} urlFibDrawing={urlParams.fibDrawing}
          urlSrLines={urlParams.srLines}
          isActivePanel={toolbarProps.activePanel === 0}
          onPanelActivate={() => toolbarProps.setActivePanel(0)}
          {...toolbarProps.shared}
        />
      </ErrorBoundary>
    </div>
  );
}

function Layout2H({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  const [colPct, containerRef, onDivMouseDown] = useDraggableSplit("col", "split2h_col");
  return (
    <div className="layout-2h" ref={containerRef}>
      <div className="layout-cell" style={{ width: `${colPct}%` }}>
        <ErrorBoundary minimal label="Panel 1">
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={2} showSidebar={true}
            layoutId={layoutId} onLayoutChange={onLayoutChange}
            urlSymbol={urlParams.symbol} urlResolution={urlParams.resolution}
            urlWaveTarget={urlParams.waveTarget} urlFibDrawing={urlParams.fibDrawing}
            urlSrLines={urlParams.srLines}
            isActivePanel={toolbarProps.activePanel === 0}
            onPanelActivate={() => toolbarProps.setActivePanel(0)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
      <Divider dir="col" onMouseDown={onDivMouseDown} />
      <div className="layout-cell" style={{ flex: 1 }}>
        <ErrorBoundary minimal label="Panel 2">
          <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={2} showSidebar={false}
            layoutId={undefined} onLayoutChange={undefined}
            urlSymbol={null} urlResolution={null}
            urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
            isActivePanel={toolbarProps.activePanel === 1}
            onPanelActivate={() => toolbarProps.setActivePanel(1)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function Layout2V({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  const [rowPct, containerRef, onDivMouseDown] = useDraggableSplit("row", "split2v_row");
  return (
    <div className="layout-2v" ref={containerRef}>
      <div className="layout-cell" style={{ height: `${rowPct}%` }}>
        <ErrorBoundary minimal label="Panel 1">
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={2} showSidebar={true}
            layoutId={layoutId} onLayoutChange={onLayoutChange}
            urlSymbol={urlParams.symbol} urlResolution={urlParams.resolution}
            urlWaveTarget={urlParams.waveTarget} urlFibDrawing={urlParams.fibDrawing}
            urlSrLines={urlParams.srLines}
            isActivePanel={toolbarProps.activePanel === 0}
            onPanelActivate={() => toolbarProps.setActivePanel(0)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
      <Divider dir="row" onMouseDown={onDivMouseDown} />
      <div className="layout-cell" style={{ flex: 1 }}>
        <ErrorBoundary minimal label="Panel 2">
          <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={2} showSidebar={false}
            layoutId={undefined} onLayoutChange={undefined}
            urlSymbol={null} urlResolution={null}
            urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
            isActivePanel={toolbarProps.activePanel === 1}
            onPanelActivate={() => toolbarProps.setActivePanel(1)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function Layout3({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  const [colPct, containerRef, onColMouseDown] = useDraggableSplit("col", "split3_col");
  const [rowPct, rightRef, onRowMouseDown] = useDraggableSplit("row", "split3_row");
  return (
    <div className="layout-3" ref={containerRef}>
      <div className="layout-cell" style={{ width: `${colPct}%` }}>
        <ErrorBoundary minimal label="Panel 1">
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={3} showSidebar={true}
            layoutId={layoutId} onLayoutChange={onLayoutChange}
            urlSymbol={urlParams.symbol} urlResolution={urlParams.resolution}
            urlWaveTarget={urlParams.waveTarget} urlFibDrawing={urlParams.fibDrawing}
            urlSrLines={urlParams.srLines}
            isActivePanel={toolbarProps.activePanel === 0}
            onPanelActivate={() => toolbarProps.setActivePanel(0)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
      <Divider dir="col" onMouseDown={onColMouseDown} />
      <div className="layout-col" style={{ flex: 1 }} ref={rightRef}>
        <div className="layout-cell" style={{ height: `${rowPct}%` }}>
          <ErrorBoundary minimal label="Panel 2">
            <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={3} showSidebar={false}
              layoutId={undefined} onLayoutChange={undefined}
              urlSymbol={null} urlResolution={null}
              urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
              isActivePanel={toolbarProps.activePanel === 1}
              onPanelActivate={() => toolbarProps.setActivePanel(1)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
        <Divider dir="row" onMouseDown={onRowMouseDown} />
        <div className="layout-cell" style={{ flex: 1 }}>
          <ErrorBoundary minimal label="Panel 3">
            <ChartPanel key="p2" pfx="p3_" panelIdx={2} panelCount={3} showSidebar={false}
              layoutId={undefined} onLayoutChange={undefined}
              urlSymbol={null} urlResolution={null}
              urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
              isActivePanel={toolbarProps.activePanel === 2}
              onPanelActivate={() => toolbarProps.setActivePanel(2)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

function Layout4({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  const [colPct, containerRef, onColMouseDown] = useDraggableSplit("col", "split4_col");
  const [rowPctL, leftRef, onRowLMouseDown] = useDraggableSplit("row", "split4_rowL");
  const [rowPctR, rightRef, onRowRMouseDown] = useDraggableSplit("row", "split4_rowR");
  return (
    <div className="layout-4" ref={containerRef}>
      <div className="layout-col" style={{ width: `${colPct}%` }} ref={leftRef}>
        <div className="layout-cell" style={{ height: `${rowPctL}%` }}>
          <ErrorBoundary minimal label="Panel 1">
            <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={4} showSidebar={false}
              layoutId={layoutId} onLayoutChange={onLayoutChange}
              urlSymbol={urlParams.symbol} urlResolution={urlParams.resolution}
              urlWaveTarget={urlParams.waveTarget} urlFibDrawing={urlParams.fibDrawing}
              urlSrLines={urlParams.srLines}
              isActivePanel={toolbarProps.activePanel === 0}
              onPanelActivate={() => toolbarProps.setActivePanel(0)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
        <Divider dir="row" onMouseDown={onRowLMouseDown} />
        <div className="layout-cell" style={{ flex: 1 }}>
          <ErrorBoundary minimal label="Panel 3">
            <ChartPanel key="p2" pfx="p3_" panelIdx={2} panelCount={4} showSidebar={false}
              layoutId={undefined} onLayoutChange={undefined}
              urlSymbol={null} urlResolution={null}
              urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
              isActivePanel={toolbarProps.activePanel === 2}
              onPanelActivate={() => toolbarProps.setActivePanel(2)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
      </div>
      <Divider dir="col" onMouseDown={onColMouseDown} />
      <div className="layout-col" style={{ flex: 1 }} ref={rightRef}>
        <div className="layout-cell" style={{ height: `${rowPctR}%` }}>
          <ErrorBoundary minimal label="Panel 2">
            <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={4} showSidebar={false}
              layoutId={undefined} onLayoutChange={undefined}
              urlSymbol={null} urlResolution={null}
              urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
              isActivePanel={toolbarProps.activePanel === 1}
              onPanelActivate={() => toolbarProps.setActivePanel(1)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
        <Divider dir="row" onMouseDown={onRowRMouseDown} />
        <div className="layout-cell" style={{ flex: 1 }}>
          <ErrorBoundary minimal label="Panel 4">
            <ChartPanel key="p3" pfx="p4_" panelIdx={3} panelCount={4} showSidebar={false}
              layoutId={undefined} onLayoutChange={undefined}
              urlSymbol={null} urlResolution={null}
              urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
              isActivePanel={toolbarProps.activePanel === 3}
              onPanelActivate={() => toolbarProps.setActivePanel(3)}
              {...toolbarProps.shared}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ChartsPage — top-level: manages layoutId, URL params, AND global toolbar state.
// ═══════════════════════════════════════════════════════════════════════════════
export default function ChartsPage() {
  const location = useLocation();

  // ── Layout state ───────────────────────────────────────────────────────────
  const [layoutId, setLayoutId] = useState(() => loadPref("layoutId", "1"));
  const handleLayoutChange = useCallback((id) => {
    setLayoutId(id);
    savePref("layoutId", id);
    setActivePanel(0);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
    // Intentional stable callback — savePref/setLayoutId/setActivePanel are all
    // stable. setTimeout dispatches are fire-and-forget side effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [selectedTool, setSelectedTool] = useState("cursor");
  const [drawColor, setDrawColor] = useState("white");
  const [activePanel, setActivePanel] = useState(0);

  const panelActionsRef = useRef({
    toggleHide: null, trashAll: null, drawingsHidden: false,
    getAtmBaseSymbol: null,    // () => {baseSymbol, resolution}|null — Ctrl+Q / Ctrl+D
    openSearchWithQuery: null, // (firstChar: string) => void — type-to-search
  });
  const [activePanelHidden, setActivePanelHidden] = useState(false);

  // ── ATM Workspace: 3-pane CE | Underlying | PE view opened by Ctrl+Q/D ────
  // { baseSymbol, resolution, focus: "ce"|"pe" } while open, else null. Fully
  // replaces the normal panel layout while open (see renderLayout() below).
  const [atmWorkspace, setAtmWorkspace] = useState(null);

  const panelLinkRef = useRef({ linked: false, setLinked: null });
  const [toolbarLinked, setToolbarLinked] = useState(false);

  // ── Synced crosshair state — shared across all panels ─────────────────────
  // syncedCrosshairPrice: the price under the cursor on whichever panel is active
  // syncedCrosshairSymbol: the symbol of the panel broadcasting the price
  // Only panels with the SAME symbol will render the synced horizontal line.
  const [syncedCrosshairPrice, setSyncedCrosshairPrice] = useState(null);
  const [syncedCrosshairSymbol, setSyncedCrosshairSymbol] = useState(null);

  const handleSyncCrosshair = useCallback((price, symbol) => {
    setSyncedCrosshairPrice(price);
    setSyncedCrosshairSymbol(price != null ? symbol : null);
  }, []);

  // Esc key globally → cursor (and closes the ATM Workspace if one is open)
  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      setSelectedTool("cursor");
      setAtmWorkspace(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+Q / Ctrl+D globally → open (or refocus) the 3-pane ATM Workspace
  // (CE | Underlying | PE) anchored on the active panel's underlying symbol.
  // Ctrl+Q focuses the CE column, Ctrl+D focuses the PE column — both open
  // the SAME workspace instance rather than mutating the active panel's own
  // chart. That in-place mutation is what let the two shortcuts step on each
  // other before (see getAtmBaseSymbol in ChartPanel for the full story):
  // pressing Ctrl+Q then Ctrl+D compared the fetched PE strikes against
  // whatever price the panel happened to be showing, which was the CE
  // option's own premium, not the underlying's spot. Acts on whichever panel
  // was last clicked (panelActionsRef is re-registered by that panel's own
  // effect whenever it becomes active or its dependencies change).
  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "q" && key !== "d") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      e.preventDefault();
      const info = panelActionsRef.current?.getAtmBaseSymbol?.();
      if (!info) return; // active panel already surfaced its own warning
      const focus = key === "q" ? "ce" : "pe";
      setAtmWorkspace((prev) =>
        (prev && prev.baseSymbol === info.baseSymbol)
          ? { ...prev, focus } // same underlying already open — just refocus
          : { baseSymbol: info.baseSymbol, resolution: info.resolution, focus }
      );
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // panelActionsRef is a stable ref — reading .current at call time is
    // intentional, not a missing dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Type-to-search (TradingView-style): start typing anywhere on the page —
  // no need to click the search icon first — and the active panel's symbol
  // search opens already showing what was typed. Only triggers on a single
  // plain printable character with no modifier held, so it can never collide
  // with Ctrl+Q/D above, Alt+letter toolbar shortcuts, or Ctrl+Z/Delete/Arrow
  // drawing shortcuts — all of those require a modifier or a non-printable
  // key, neither of which this listener responds to.
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      // e.key is exactly one printable character for plain letter/digit keys
      // (e.g. "a", "5"); anything else ("Enter", "Shift", "ArrowUp", " "
      // for space, etc.) has length !== 1 or is whitespace — ignore those so
      // this never fires on navigation, selection, or accidental space-bar.
      if (e.key.length !== 1 || e.key === " ") return;
      if (!panelActionsRef.current?.openSearchWithQuery) return;
      e.preventDefault();
      panelActionsRef.current.openSearchWithQuery(e.key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panelCount = LAYOUTS.find((l) => l.id === layoutId)?.panels ?? 1;
  useEffect(() => {
    setActivePanel((p) => (p >= panelCount ? 0 : p));
  }, [panelCount]);

  // ── Toolbar props bundle — syncedCrosshair props included in shared ────────
  const toolbarProps = useMemo(() => ({
    activePanel,
    setActivePanel,
    shared: {
      selectedTool, setSelectedTool, drawColor,
      panelActionsRef, setActivePanelHidden,
      panelLinkRef, setToolbarLinked,
      syncedCrosshairPrice,
      syncedCrosshairSymbol,
      onSyncCrosshair: handleSyncCrosshair,
    },
    // setSelectedTool / panelActionsRef / panelLinkRef / setActivePanelHidden /
    // setToolbarLinked are stable refs/setters — omitting them is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activePanel, selectedTool, drawColor, syncedCrosshairPrice, syncedCrosshairSymbol, handleSyncCrosshair]);

  // ── URL params — panel 0 only ──────────────────────────────────────────────
  const urlParams = useMemo(() => {
    const p = new URLSearchParams(location.search);
    const waveFrom = p.get("waveFrom");
    const waveTo = p.get("waveTo");
    const waveTarget = (waveFrom && waveTo)
      ? { fromMs: Number(waveFrom), toMs: Number(waveTo) }
      : null;
    const symbol = p.get("symbol") || null;
    const resolution = p.get("resolution") ? Number(p.get("resolution")) : null;
    let fibDrawing = null;
    try {
      const raw = p.get("fibDrawing");
      if (raw) fibDrawing = JSON.parse(decodeURIComponent(raw));
    } catch { }
    let srLines = [];
    try {
      const raw = p.get("srLines");
      if (raw) srLines = JSON.parse(decodeURIComponent(raw));
    } catch { }
    return { waveTarget, symbol, resolution, fibDrawing, srLines };
    // Mount-only: URL params are parsed once at load. The location object doesn't
    // change during the component lifetime (panels don't navigate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function renderLayout() {
    const props = { urlParams, layoutId, onLayoutChange: handleLayoutChange, toolbarProps };
    switch (layoutId) {
      case "2h": return <Layout2H {...props} />;
      case "2v": return <Layout2V {...props} />;
      case "3": return <Layout3  {...props} />;
      case "4": return <Layout4  {...props} />;
      default: return <LayoutSingle {...props} />;
    }
  }

  return (
    <DrawingProvider>
      <div className="charts-page app-layout">
        {/* ONE global TradingToolbar — fixed on left, shared across all panels */}
        <TradingToolbar
          selectedTool={selectedTool}
          setSelectedTool={setSelectedTool}
          drawColor={drawColor}
          setDrawColor={setDrawColor}
          panelCount={panelCount}
          drawingsHidden={activePanelHidden}
          onToggleHide={() => panelActionsRef.current.toggleHide?.()}
          onTrashAll={() => panelActionsRef.current.trashAll?.()}
          linked={toolbarLinked}
          onLinkToggle={(val) => {
            setAllLinked(val);
          }}
        />
        {atmWorkspace ? (
          <AtmWorkspace
            key={atmWorkspace.baseSymbol}
            baseSymbol={atmWorkspace.baseSymbol}
            resolution={atmWorkspace.resolution}
            focus={atmWorkspace.focus}
            onClose={() => setAtmWorkspace(null)}
          />
        ) : renderLayout()}
      </div>
    </DrawingProvider>
  );
}