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
import EmaFloatPanel from "../components/EmaFloatPanel";
import TradingToolbar from "../components/TradingToolbar";
import AtmWorkspace from "../components/AtmWorkspace";
import { DrawingProvider, usePanelLink, setAllLinked } from "../components/DrawingContext";
import { useSocket } from "../hooks/useSocket";
import { buildDefaultIndicators } from "../indicators/indicatorRegistry";
import { loadPref, savePref } from "../utils/prefs";
import { formatResolution, TIMEFRAMES } from "../utils/formatResolution";
import { parseOptionSymbol, isOptionSymbol, getOptionRoot, getStrikeStep, nearestStrikeWithHysteresis, NSE_INDEX_TICKERS } from "../utils/optionsChain";
import { BACKEND } from "../config";
import { LAYOUTS } from "../components/layout/LayoutPicker";
import ErrorBoundary from "../components/ErrorBoundary";
import { ChartPanelPropTypes } from "./ChartPanelPropTypes";
import "../styles/ChartsPage.css";

// Symbols for which options can be opened via Ctrl+Q and the Options
// button — equities, NSE/BSE indices, MCX dated futures. Both the button
// eligibility check and the Ctrl+Q shortcut use this so they always agree.
const OPTIONS_ELIGIBLE_RE = /^(NSE:[A-Z0-9&]+-(EQ|INDEX)|BSE:[A-Z0-9&]+-INDEX|MCX:[A-Z0-9]+\d{2}[A-Z]{3}FUT)$/i;

// ═══════════════════════════════════════════════════════════════════════════════
// ChartPanel — one fully independent chart panel (TradingView style).
// ═══════════════════════════════════════════════════════════════════════════════
const ChartPanel = memo(function ChartPanel({
  pfx,
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
  // ref + listener registry instead of state — no re-render on crosshair move
  // panelCount is already destructured above; synced crosshair is disabled when panelCount === 1
  syncedCrosshairRef,       // { price: number|null, symbol: string|null }
  syncedCrosshairListeners, // Set of (syncState) => void callbacks
  onSyncCrosshair,          // (price: number|null, symbol: string) => void
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
  // optionSymbol() with a guessed Fyers date-encoding — the same broken
  // approach as the old options-split shortcut (Fyers frequently rejects
  // those hand-built strings as "Invalid symbol provided"). Fetching on
  // every tick would be too expensive for a hysteresis watcher that runs on
  // every price update, so instead this fetches ONCE per option contract
  // (same underlying + same expiry) and caches the strike→symbol map; the
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
    // NOTE: parseOptionSymbol() only gives back the expiry CODE embedded in
    // the symbol string (e.g. "26JUL"), not a raw Fyers epoch timestamp, and
    // there's no reliable way to turn that code back into a timestamp
    // without reintroducing the same date-guessing problem this fix removes.
    // Omitting `timestamp` here returns the NEAREST expiry's strikes, which
    // matches the contract being viewed in the overwhelming majority of
    // cases. If the user has manually navigated to a far expiry, the lookup
    // may miss and the switch is simply skipped (see the !newSymbol guard
    // below) rather than risk sending a wrong-expiry symbol.
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
    const newSym = autoAtmStrikeMap.get(`${suggested}:${parsedOption.kind}`);
    if (!newSym) {
      pendingStrikeRef.current = null;
      return;
    }
    pendingStrikeRef.current = null;
    if (newSym !== symbol) {
      setSymbol(newSym);
      refresh(newSym, resolution);
    }
    // setSymbol/refresh are stable; resolution read at call time.
    // Re-running on every underlyingTick is intentional — that's the watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAtmOn, parsedOption, underlyingTick, autoAtmStrikeMap]);

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

  // Wave/consolidation callbacks — CandleChart calls these to output processed data.
  // Sidebar is gone so we don't need to store the results; no-op callbacks satisfy
  // CandleChart's prop contract without any extra React state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleWaveData = useCallback(() => { }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleConsolidationData = useCallback(() => { }, []);

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

  // ── Ctrl+Q: open the ATM Workspace for the active panel ───────────────────
  // All deps (candles, handleSymbolChange, handleRefresh, resolution, symbol)
  // are defined above — must stay after candles to avoid temporal dead zone.
  const [shortcutWarning, setShortcutWarning] = useState(null);
  useEffect(() => {
    if (!shortcutWarning) return;
    const t = setTimeout(() => setShortcutWarning(null), 3500);
    return () => clearTimeout(t);
  }, [shortcutWarning]);

  // ── Type-a-number → switch timeframe (Fyers-style) ─────────────────────────
  // Only ever applies a SUPPORTED resolution (from TIMEFRAMES — the same list
  // driving the timeframe pill buttons). Typing any number that isn't one of
  // 1/3/5/15/60/1440/10080 does nothing and shows a brief warning — the
  // chart stays exactly on its current timeframe, never a half-applied or
  // invalid resolution.
  const applyTypedTimeframe = useCallback((digits) => {
    const n = parseInt(digits, 10);
    const supported = TIMEFRAMES.some((tf) => tf.value === n);
    if (!Number.isFinite(n) || !supported) {
      setShortcutWarning(`"${digits}" isn't a supported timeframe (1, 3, 5, 15, 60, 1440, 10080).`);
      return;
    }
    handleResolutionChange(n);
    handleRefresh(symbol, n);
  }, [handleResolutionChange, handleRefresh, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register applyTypedTimeframe on panelActionsRef alongside the other
  // active-panel actions (getAtmBaseSymbol, openSearchWithQuery).
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = { ...panelActionsRef.current, applyTypedTimeframe };
  }, [isActivePanel, applyTypedTimeframe, panelActionsRef]);

  // ── Ctrl+Q: resolve the ATM base symbol for the shared 3-pane workspace ───
  // ATM Workspace (rendered once at ChartsPage level).
  // Reuses the exact eligibility check the "Options" overlay button already
  // uses, so the shortcut and the button always agree on which symbols
  // support an options chain (equities, NSE/BSE indices, MCX dated futures).
  //
  // ROOT-CAUSE FIX: this used to be `openOptionsAtm(kind)` / `openOptionsSplit()`,
  // which mutated THIS panel's own symbol (or split into two panels) in place,
  // picking the nearest strike by comparing candles[last].close against the
  // fetched chain — i.e. whatever price happened to be on screen. That's
  // correct when the panel is showing the underlying, but wrong once it's
  // already showing an option: pressing Ctrl+Q then Ctrl+D compared the
  // fetched PE strikes against the CE contract's own premium (e.g. ~₹410)
  // instead of the underlying's spot (e.g. ~78,000), landing on an
  // essentially random low strike. Now this panel only resolves WHICH
  // underlying the shortcut applies to — the workspace itself fetches the
  // underlying's real spot and both strike ladders fresh, so it never trusts
  // an option's own price as a spot proxy.
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

  // Registered separately from the main panelActionsRef effect above so
  // neither effect clobbers the other's keys, regardless of mount/update order.
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = { ...panelActionsRef.current, getAtmBaseSymbol };
  }, [isActivePanel, getAtmBaseSymbol, panelActionsRef]);

  // ── Symbol search modal ────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [initialSearchQuery, setInitialSearchQuery] = useState("");
  // Mirror of searchOpen in a ref — used by openSearchWithQuery to safely
  // append characters that arrive before the input gains focus (~60ms delay).
  const searchOpenRef = useRef(false);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);

  const openSearchWithQuery = useCallback((firstChar) => {
    setInitialSearchQuery((prev) => {
      // If search is already open (ref, not state, so we catch the 60ms gap)
      // append to whatever's already there so fast typing doesn't stomp chars.
      if (searchOpenRef.current) return prev + firstChar;
      return firstChar;
    });
    searchOpenRef.current = true; // set immediately so rapid keypresses append
    setSearchOpen(true);
  }, []);

  // Register openSearchWithQuery on panelActionsRef — separate effect so it
  // doesn't clobber toggleHide/trashAll registered above, and avoids the
  // "used before initialization" error (this callback is defined after that
  // earlier effect, so it can't be in its dep array).
  useEffect(() => {
    if (!isActivePanel || !panelActionsRef) return;
    panelActionsRef.current = { ...panelActionsRef.current, openSearchWithQuery };
  }, [isActivePanel, openSearchWithQuery, panelActionsRef]);

  // ── Options chain modal ────────────────────────────────────────────────────
  const [optionsChainOpen, setOptionsChainOpen] = useState(false);
  const [optionsChainUnderlying, setOptionsChainUnderlying] = useState(null);

  // ── Crosshair — kept as ref to avoid re-rendering ChartPanel on every mouse move ──
  // StatusBar gets a crosshairBarRef it reads directly; EmaFloatPanel uses an imperative
  // update callback. Neither triggers a ChartPanel re-render on crosshair moves.
  const crosshairBarRef = useRef(null);
  const emaFloatPanelRef = useRef(null);
  const statusBarCrosshairRef = useRef(null); // imperative update fn set by StatusBar
  const handleCrosshairMove = useCallback((bar) => {
    crosshairBarRef.current = bar;
    if (emaFloatPanelRef.current?.update) emaFloatPanelRef.current.update(bar);
    if (statusBarCrosshairRef.current) statusBarCrosshairRef.current(bar);
  }, []);

  // ── Synced crosshair — subscribe to ref updates, disabled in single panel ──
  // In single-panel mode (panelCount === 1) we never show the sync line —
  // it was producing a ghost dashed line on top of the native LW crosshair.
  const [thisPanelSyncedPrice, setThisPanelSyncedPrice] = useState(null);
  useEffect(() => {
    if (!syncedCrosshairListeners || panelCount <= 1) {
      setThisPanelSyncedPrice(null);
      return;
    }
    function onSync({ price, symbol: syncSym }) {
      setThisPanelSyncedPrice(syncSym === symbol ? (price ?? null) : null);
    }
    syncedCrosshairListeners.current.add(onSync);
    return () => { syncedCrosshairListeners.current.delete(onSync); };
  }, [syncedCrosshairListeners, panelCount, symbol]);

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
  const chartDataResolution = chartData?.resolution ?? resolution;
  const showLoadingScreen = loading && candles.length === 0;

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
          crosshairBar={crosshairBarRef.current}
          onCrosshairBarUpdate={(fn) => { statusBarCrosshairRef.current = fn; }}
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
        onClose={() => { setSearchOpen(false); setInitialSearchQuery(""); }}
        initialQuery={initialSearchQuery}
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

            {/* Auto-ATM toggle — only shown when viewing an option contract */}
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
              ref={emaFloatPanelRef}
              emaHighs={emaHighs}
              emaLows={emaLows}
              candles={candles}
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
                <div className="no-data-title">No Data Available</div>
                <div className="no-data-sub">
                  {error === "no_data" ? (
                    <>
                      This symbol has no historical data in the database<br />
                      and Fyers is not connected (token expired).<br /><br />
                      <strong>To load data:</strong> generate a fresh token,<br />
                      then click <strong>Refresh</strong> above.
                    </>
                  ) : (
                    <>
                      Run <code>npm run generate</code> in the backend terminal,<br />
                      then click Refresh above.
                    </>
                  )}
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

// ─── useDraggableSplit3 — two independent col dividers sharing one container,
// for a 3-panel side-by-side layout. pctA is the left boundary (%), pctB is
// the middle boundary (%); panel 3 fills the remainder. Each divider is
// clamped against the other so panels can't cross or collapse past `min`.
function useDraggableSplit3(storageKeyA, storageKeyB, min = 15) {
  const [pctA, setPctA] = useState(() => loadPref(storageKeyA, 33.33));
  const [pctB, setPctB] = useState(() => loadPref(storageKeyB, 66.66));
  // Refs mirror the latest state so the mousemove listener (subscribed once)
  // always clamps against current values without needing to re-subscribe on
  // every drag tick.
  const pctARef = useRef(pctA);
  const pctBRef = useRef(pctB);
  useEffect(() => { pctARef.current = pctA; }, [pctA]);
  useEffect(() => { pctBRef.current = pctB; }, [pctB]);

  const draggingRef = useRef(null); // "A" | "B" | null
  const containerRef = useRef(null);

  const onMouseDownA = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = "A";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  const onMouseDownB = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = "B";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    function onMouseMove(e) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const raw = ((e.clientX - rect.left) / rect.width) * 100;
      if (draggingRef.current === "A") {
        const clamped = Math.min(pctBRef.current - min, Math.max(min, raw));
        pctARef.current = clamped;
        setPctA(clamped);
        savePref(storageKeyA, clamped);
      } else {
        const clamped = Math.min(100 - min, Math.max(pctARef.current + min, raw));
        pctBRef.current = clamped;
        setPctB(clamped);
        savePref(storageKeyB, clamped);
      }
      window.dispatchEvent(new Event("resize"));
    }
    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = null;
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
    // storageKeyA/storageKeyB/min are constant literals from the caller;
    // pctA/pctB are read via refs at call time — intentional single subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { pctA, pctB, containerRef, onMouseDownA, onMouseDownB };
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
          key="p0" pfx="" panelIdx={0} panelCount={1}
          layoutId={layoutId} onLayoutChange={onLayoutChange}
          urlSymbol={urlParams.symbol}
          urlResolution={urlParams.resolution}
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
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={2}
            layoutId={layoutId} onLayoutChange={onLayoutChange}
            urlSymbol={urlParams.symbol}
            urlResolution={urlParams.resolution}
            urlWaveTarget={urlParams.waveTarget}
            urlFibDrawing={urlParams.fibDrawing}
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
          <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={2}
            layoutId={undefined} onLayoutChange={undefined}
            urlSymbol={null}
            urlResolution={null}
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
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={2}
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
          <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={2}
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
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={3}
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
            <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={3}
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
            <ChartPanel key="p2" pfx="p3_" panelIdx={2} panelCount={3}
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

function Layout3H({ urlParams, layoutId, onLayoutChange, toolbarProps }) {
  const { pctA, pctB, containerRef, onMouseDownA, onMouseDownB } = useDraggableSplit3("split3h_colA", "split3h_colB");
  return (
    <div className="layout-3h" ref={containerRef}>
      <div className="layout-cell" style={{ width: `${pctA}%` }}>
        <ErrorBoundary minimal label="Panel 1">
          <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={3}
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
      <Divider dir="col" onMouseDown={onMouseDownA} />
      <div className="layout-cell" style={{ width: `${pctB - pctA}%` }}>
        <ErrorBoundary minimal label="Panel 2">
          <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={3}
            layoutId={undefined} onLayoutChange={undefined}
            urlSymbol={null} urlResolution={null}
            urlWaveTarget={null} urlFibDrawing={null} urlSrLines={[]}
            isActivePanel={toolbarProps.activePanel === 1}
            onPanelActivate={() => toolbarProps.setActivePanel(1)}
            {...toolbarProps.shared}
          />
        </ErrorBoundary>
      </div>
      <Divider dir="col" onMouseDown={onMouseDownB} />
      <div className="layout-cell" style={{ flex: 1 }}>
        <ErrorBoundary minimal label="Panel 3">
          <ChartPanel key="p2" pfx="p3_" panelIdx={2} panelCount={3}
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
            <ChartPanel key="p0" pfx="" panelIdx={0} panelCount={4}
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
            <ChartPanel key="p2" pfx="p3_" panelIdx={2} panelCount={4}
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
            <ChartPanel key="p1" pfx="p2_" panelIdx={1} panelCount={4}
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
            <ChartPanel key="p3" pfx="p4_" panelIdx={3} panelCount={4}
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
    getAtmBaseSymbol: null,    // () => {baseSymbol, resolution}|null — Ctrl+Q
    openSearchWithQuery: null, // (firstChar: string) => void — type-to-search
    applyTypedTimeframe: null, // (digits: string) => void — type-a-number timeframe switch
  });
  const [activePanelHidden, setActivePanelHidden] = useState(false);

  // ── ATM Workspace: 3-pane CE | Underlying | PE view opened by Ctrl+Q ──────
  // { baseSymbol, resolution, focus: "ce"|"pe" } while open, else null. Fully
  // replaces the normal panel layout while open (see the render below).
  const [atmWorkspace, setAtmWorkspace] = useState(null);

  const panelLinkRef = useRef({ linked: false, setLinked: null });
  const [toolbarLinked, setToolbarLinked] = useState(false);

  // ── Synced crosshair — ref-based to avoid rebuilding toolbarProps on every mouse move ──
  // In single-panel mode (panelCount === 1) the sync crosshair is disabled entirely —
  // it was producing a ghost line on top of the native LW-charts crosshair.
  // In multi-panel mode it works exactly as before: panels with the same symbol
  // show the dashed horizontal price line from the active panel.
  const syncedCrosshairRef = useRef({ price: null, symbol: null });
  // Notify panels when synced crosshair changes — panels subscribe via a Set of callbacks.
  const syncedCrosshairListeners = useRef(new Set());

  const handleSyncCrosshair = useCallback((price, sym) => {
    syncedCrosshairRef.current = { price: price ?? null, symbol: price != null ? sym : null };
    syncedCrosshairListeners.current.forEach((fn) => fn(syncedCrosshairRef.current));
  }, []);

  // Esc key globally → reset tool to cursor, and close the ATM Workspace if
  // one is open (the digit-buffer-cancel Escape handling below is separate
  // and independent — it only fires while a timeframe digit is buffered).
  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      setSelectedTool("cursor");
      setAtmWorkspace(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+Q globally → open (or refocus) the 3-pane ATM Workspace
  // (CE | Underlying | PE) anchored on the active panel's underlying symbol.
  // Always focuses the CE column on open — the workspace shows CE/PE
  // together either way, so a second shortcut for "same workspace, focus PE
  // instead" was redundant (Ctrl+D used to do exactly that and nothing
  // else; removed on request, one shortcut is enough since both opened the
  // identical 3-pane view). Click a column directly to focus it instead.
  // Acts on whichever panel was last clicked (panelActionsRef is
  // re-registered by that panel's own effect whenever it becomes active or
  // its dependencies change).
  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "q") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      e.preventDefault();
      const info = panelActionsRef.current?.getAtmBaseSymbol?.();
      if (!info) return; // active panel already surfaced its own warning
      setAtmWorkspace((prev) =>
        (prev && prev.baseSymbol === info.baseSymbol)
          ? prev // same underlying already open — leave focus as-is
          : { baseSymbol: info.baseSymbol, resolution: info.resolution, focus: "ce" }
      );
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // panelActionsRef is a stable ref — reading .current at call time is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Type-a-number → switch timeframe (Fyers-style). Digits accumulate into a
  // short-lived buffer (so "15" can be typed, not just single-digit "1"/"5");
  // Enter applies it immediately, or it auto-applies after a short pause.
  // Esc cancels the buffer without changing anything. This intentionally
  // intercepts digits BEFORE the letter-based type-to-search handler below,
  // so numbers never accidentally open the symbol search instead.
  const tfDigitBufferRef = useRef("");
  const tfDigitTimerRef = useRef(null);
  useEffect(() => {
    function clearBuffer() {
      tfDigitBufferRef.current = "";
      if (tfDigitTimerRef.current) { clearTimeout(tfDigitTimerRef.current); tfDigitTimerRef.current = null; }
    }
    function applyBuffer() {
      const digits = tfDigitBufferRef.current;
      clearBuffer();
      if (digits) panelActionsRef.current?.applyTypedTimeframe?.(digits);
    }
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

      if (tfDigitBufferRef.current) {
        if (e.key === "Enter") { e.preventDefault(); applyBuffer(); return; }
        if (e.key === "Escape") { e.preventDefault(); clearBuffer(); return; }
      }

      if (e.key.length === 1 && e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        tfDigitBufferRef.current += e.key;
        if (tfDigitTimerRef.current) clearTimeout(tfDigitTimerRef.current);
        // Auto-apply shortly after the last digit, so a single digit (e.g. "1")
        // still works without requiring Enter — matches Fyers' feel.
        tfDigitTimerRef.current = setTimeout(applyBuffer, 700);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearBuffer(); };
  }, []);

  // Type-to-search: start typing anywhere → active panel's symbol search opens
  // pre-filled with the typed character. Only single plain LETTER chars with no
  // modifier — digits are claimed by the timeframe-typing handler above, so
  // they never collide with Ctrl+Q, Alt+letter, Ctrl+Z, arrows, or numbers.
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      // e.key is exactly one printable character for plain letter keys
      // (e.g. "a"); anything else ("Enter", "Shift", "ArrowUp", " "
      // for space, digits, etc.) has length !== 1 or isn't a letter — ignore.
      if (e.key.length !== 1 || e.key === " ") return;
      if (e.key >= "0" && e.key <= "9") return; // claimed by timeframe-typing handler
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

  // ── Toolbar props bundle ───────────────────────────────────────────────────
  // syncedCrosshair is ref-based — NOT in deps. toolbarProps only rebuilds on
  // activePanel / selectedTool / drawColor / panelCount changes.
  const toolbarProps = useMemo(() => ({
    activePanel,
    setActivePanel,
    shared: {
      selectedTool, setSelectedTool, drawColor,
      panelActionsRef, setActivePanelHidden,
      panelLinkRef, setToolbarLinked,
      // Panels receive the ref + listener registration instead of state values.
      // This means a crosshair move on one panel does NOT rebuild toolbarProps
      // and does NOT re-render sibling panels.
      syncedCrosshairRef,
      syncedCrosshairListeners,
      onSyncCrosshair: handleSyncCrosshair,
      panelCount,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activePanel, selectedTool, drawColor, panelCount, handleSyncCrosshair]);

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
      case "3h": return <Layout3H {...props} />;
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