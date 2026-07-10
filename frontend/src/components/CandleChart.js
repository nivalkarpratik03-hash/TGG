// CandleChart.js
//   • viewport/zoom/scroll NEVER reset on background socket updates
//   • incremental candle update (update() not setData()) when only last candle changed
//   • intentionalReload flag drives resetView() — NOT auto-refresh
//   • WavesIndicator only redraws on actual change
//   • Bubble markers: ZERO setMarkers calls during price ticks — only on signal/todayMode/bubble changes
import React, { useEffect, useRef, useCallback, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import {
  createWavesIndicator,
  updateWavesIndicator,
  removeWavesIndicator,
} from "../indicators/WavesIndicator";
import {
  createConsolidationIndicator,
  updateConsolidationIndicator,
  removeConsolidationIndicator,
} from "../indicators/ConsolidationIndicator";
import {
  createSRZonesIndicator,
  updateSRZonesIndicator,
  removeSRZonesIndicator,
} from "../indicators/SRZonesIndicator";
import {
  buildBubbleMarkers,
  setMarkersIfChanged,
} from "../indicators/BubbleIndicator";
import { toISTDate } from "../utils/istUtils";
import DrawingOverlay from "./DrawingOverlay";
import { useTheme } from "../App";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Ruler overlay ────────────────────────────────────────────────────────────
class RulerOverlay {
  constructor(container, chartRef, candleSeriesRef) {
    this.container = container;
    this.chartRef = chartRef;
    this.candleSeriesRef = candleSeriesRef;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = [
      "position:absolute", "inset:0", "pointer-events:none",
      "z-index:20", "border-radius:inherit",
    ].join(";");
    container.style.position = "relative";
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d");
    this.active = false;
    this.startPt = null;
    this.endPt = null;
    this._lastMouse = null;

    this._rafId = null;
    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      resize: this._onResize.bind(this),
    };

    window.addEventListener("keydown", this._bound.keydown);
    window.addEventListener("keyup", this._bound.keyup);
    window.addEventListener("mousemove", this._bound.mousemove);
    window.addEventListener("resize", this._bound.resize);

    this._onResize();
  }

  _onResize() {
    const r = this.container.getBoundingClientRect();
    this.canvas.width = r.width;
    this.canvas.height = r.height;
    this._draw();
  }

  _onKeyDown(e) {
    // Activate ruler only when BOTH Ctrl AND Shift are held
    if (!e.ctrlKey || !e.shiftKey) return;
    if (this.active) return;
    e.preventDefault();
    this.active = true;
    this.container.style.cursor = "crosshair";
    this.startPt = this._lastMouse ? { ...this._lastMouse } : null;
    this.endPt = this.startPt ? { ...this.startPt } : null;
    this._scheduleDraw();
  }

  _onKeyUp(e) {
    // Deactivate as soon as Ctrl OR Shift is released
    if (e.key !== "Control" && e.key !== "Shift") return;
    if (!this.active) return;
    this.active = false;
    this.startPt = null;
    this.endPt = null;
    this.container.style.cursor = "";
    this._clear();
  }

  _rel(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onMouseMove(e) {
    const pt = this._rel(e);
    this._lastMouse = pt;
    if (!this.active) return;
    if (!this.startPt) { this.startPt = { ...pt }; }
    this.endPt = pt;
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._draw();
    });
  }

  _clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _xToTime(x) {
    try { return this.chartRef.current?.timeScale().coordinateToTime(x); } catch { return null; }
  }

  _yToPrice(y) {
    try { return this.candleSeriesRef.current?.coordinateToPrice(y); } catch { return null; }
  }

  _draw() {
    this._clear();
    if (!this.startPt || !this.endPt) return;

    const ctx = this.ctx;
    const { startPt, endPt } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;

    const t1 = this._xToTime(startPt.x);
    const t2 = this._xToTime(endPt.x);
    const p1 = this._yToPrice(startPt.y);
    const p2 = this._yToPrice(endPt.y);

    if (p1 == null || p2 == null) return;

    const x1 = startPt.x, y1 = startPt.y;
    const x2 = endPt.x, y2 = endPt.y;

    const isBull = p2 >= p1;
    const clrLine = isBull ? "rgba(0,217,126,0.85)" : "rgba(255,69,96,0.85)";
    const clrFill = isBull ? "rgba(0,217,126,0.08)" : "rgba(255,69,96,0.08)";
    const clrTxt = "#e4e8f5";
    const clrMute = "#7a8099";
    const clrBg = "rgba(14,16,26,0.92)";
    const clrBdr = isBull ? "rgba(0,217,126,0.55)" : "rgba(255,69,96,0.55)";

    ctx.fillStyle = clrFill;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

    const midY = (y1 + y2) / 2;
    ctx.save();
    ctx.strokeStyle = clrLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.min(x1, x2), midY);
    ctx.lineTo(Math.max(x1, x2), midY);
    ctx.stroke();
    ctx.setLineDash([]);

    [x1, x2].forEach((x) => {
      ctx.strokeStyle = clrLine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, Math.min(y1, y2));
      ctx.lineTo(x, Math.max(y1, y2));
      ctx.stroke();
    });

    [y1, y2].forEach((y) => {
      ctx.strokeStyle = clrLine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.min(x1, x2), y);
      ctx.lineTo(Math.max(x1, x2), y);
      ctx.stroke();
    });

    [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].forEach(([cx, cy]) => {
      ctx.fillStyle = clrLine;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = clrLine;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();

    const dPrice = p2 - p1;
    const dPct = p1 !== 0 ? (dPrice / Math.abs(p1)) * 100 : 0;
    const sign = dPrice >= 0 ? "+" : "";

    let barCount = 0;
    if (t1 != null && t2 != null) {
      const allCandles = window.__tggCandles || [];
      const idx1 = allCandles.findIndex((c) => Math.floor(c.time / 1000) >= Math.min(t1, t2));
      const idx2 = allCandles.findIndex((c) => Math.floor(c.time / 1000) >= Math.max(t1, t2));
      barCount = Math.abs((idx2 < 0 ? allCandles.length : idx2) - (idx1 < 0 ? 0 : idx1));
    }

    function fmtIST(unixSec) {
      if (!unixSec) return "—";
      const d = new Date((unixSec + 19800) * 1000);
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mon = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${dd} ${mon} ${hh}:${mm}`;
    }

    const numFmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const lines = [
      { label: "Δ Price", value: `${sign}${numFmt.format(dPrice)}`, color: clrLine },
      { label: "Δ %", value: `${sign}${Math.abs(dPct).toFixed(2)}%`, color: clrLine },
      { label: "Bars", value: String(barCount), color: clrMute },
      { label: "From", value: fmtIST(Math.min(t1 ?? 0, t2 ?? 0)), color: clrMute },
      { label: "To", value: fmtIST(Math.max(t1 ?? 0, t2 ?? 0)), color: clrMute },
    ];

    const padding = 10;
    const lineH = 18;
    const boxW = 178;
    const boxH = lines.length * lineH + padding * 2;

    let tipX = Math.max(x1, x2) + 12;
    let tipY = (y1 + y2) / 2 - boxH / 2;
    if (tipX + boxW > W - 8) tipX = Math.min(x1, x2) - boxW - 12;
    if (tipX < 8) tipX = 8;
    if (tipY < 8) tipY = 8;
    if (tipY + boxH > H - 8) tipY = H - boxH - 8;

    ctx.save();
    const r = 7;
    ctx.beginPath();
    ctx.moveTo(tipX + r, tipY);
    ctx.lineTo(tipX + boxW - r, tipY);
    ctx.quadraticCurveTo(tipX + boxW, tipY, tipX + boxW, tipY + r);
    ctx.lineTo(tipX + boxW, tipY + boxH - r);
    ctx.quadraticCurveTo(tipX + boxW, tipY + boxH, tipX + boxW - r, tipY + boxH);
    ctx.lineTo(tipX + r, tipY + boxH);
    ctx.quadraticCurveTo(tipX, tipY + boxH, tipX, tipY + boxH - r);
    ctx.lineTo(tipX, tipY + r);
    ctx.quadraticCurveTo(tipX, tipY, tipX + r, tipY);
    ctx.closePath();
    ctx.fillStyle = clrBg;
    ctx.fill();
    ctx.strokeStyle = clrBdr;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    lines.forEach((ln, i) => {
      const ly = tipY + padding + i * lineH + lineH / 2;
      ctx.font = "600 11px 'JetBrains Mono', monospace";
      ctx.fillStyle = clrMute;
      ctx.textBaseline = "middle";
      ctx.fillText(ln.label, tipX + padding, ly);

      ctx.font = "700 11px 'JetBrains Mono', monospace";
      ctx.fillStyle = ln.color;
      ctx.textAlign = "right";
      ctx.fillText(ln.value, tipX + boxW - padding, ly);
      ctx.textAlign = "left";
    });
    ctx.restore();

    [[p1, y1], [p2, y2]].forEach(([price, py]) => {
      const label = numFmt.format(price);
      const lw = ctx.measureText(label).width + 16;
      const lh = 18;
      const lx = W - lw - 2;
      const ly = py - lh / 2;
      ctx.save();
      ctx.fillStyle = isBull ? "rgba(0,217,126,0.9)" : "rgba(255,69,96,0.9)";
      ctx.beginPath();
      ctx.roundRect(lx, ly, lw, lh, 3);
      ctx.fill();
      ctx.font = "700 10px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(label, lx + lw / 2, py);
      ctx.restore();
    });
  }

  destroy() {
    window.removeEventListener("keydown", this._bound.keydown);
    window.removeEventListener("keyup", this._bound.keyup);
    window.removeEventListener("mousemove", this._bound.mousemove);
    window.removeEventListener("resize", this._bound.resize);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function CandleChart({
  candles,
  emaHighs,
  emaLows,
  signals,
  currentState,
  todayMode,
  onCrosshairMove,
  showBubble = true,
  showWaves = false,
  onWaveData,
  showConsolidation = false,
  bubbleGap = 4,
  onConsolidationData,
  showSRZones = false,
  srStrongTouches = 3,
  srLookbackBars = 300,
  onResetViewReady,
  reloadToken = 0,
  onIntentionalReloadAck,
  activeResolution,
  symbol,
  waveTarget = null,
  selectedTool = "cursor",
  setSelectedTool = () => { },
  drawingsHidden = false,
  drawingOverlayExtRef = null,
  srLines = [],              // [{price, color, label, lineStyle}] drawn as price lines
  onSRLinesDrawn = null,     // callback(bool) when sr lines are applied/removed
  drawColor = "white",
  // ── Drawing sync (link feature) ─────────────────────────────────────────
  linkColor = null,
  sharedDrawings = [],
  onPublishDrawings = null,
  setAbsorbShared = null,
  onClearSharedDrawings = null,
  // ── Panel activation (toolbar is shared; only active panel accepts drawing input) ──
  isActivePanel = true,
  onPanelActivate = null,
  panelKey = "",
  // ── Synced crosshair across panels ──────────────────────────────────────
  syncedCrosshairPrice = null,
  onSyncCrosshair = null,
  onSilentRefresh = null,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const { theme } = useTheme();
  const candleRef = useRef(null);
  const emaHiRef = useRef(null);
  const emaLoRef = useRef(null);
  const rulerRef = useRef(null);
  const drawingOverlayRef = useRef(null);
  const srPriceLinesRef = useRef([]);  // active SR price line handles
  // Always-current ref so the stale useEffect([],...) closure never calls
  // the wrong symbol's refresh when the user alt+right-clicks after switching symbols.
  const silentRefreshRef = useRef(onSilentRefresh);
  useEffect(() => { silentRefreshRef.current = onSilentRefresh; }, [onSilentRefresh]);

  // Forward overlay ref to parent so it can call clearAll
  useEffect(() => {
    if (drawingOverlayExtRef && typeof drawingOverlayExtRef === "object") {
      drawingOverlayExtRef.current = drawingOverlayRef.current;
    }
  });

  const isFirstLoadRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevLastCandleKeyRef = useRef(null);
  const userScrolledRef = useRef(false);
  const prevMarkerKeyRef = useRef(null);
  const lastProcessedTokenRef = useRef(0);
  const prevResolutionRef = useRef(null);
  const prevSymbolRef = useRef(null);
  const intentionalReloadRef = useRef(false);

  // ── All "live" values stored in refs — updated SYNCHRONOUSLY in render ──────
  // This avoids the stale-closure problem: effects always read the current value
  // without needing to be in the dependency array of every effect.
  // We update these with a layout effect (useEffect with no deps isn't enough —
  // we use the pattern of direct assignment before effects fire).
  const todayModeRef = useRef(todayMode);
  const candlesRef = useRef(candles);
  const emaHighsRef = useRef(emaHighs);
  const emaLowsRef = useRef(emaLows);
  const signalsRef = useRef(signals);
  const showBubbleRef = useRef(showBubble);
  const showWavesRef = useRef(showWaves);
  const onWaveDataRef = useRef(onWaveData);
  const showConsolidationRef = useRef(showConsolidation);
  const bubbleGapRef = useRef(bubbleGap);
  const onConsolidationDataRef = useRef(onConsolidationData);
  const showSRZonesRef = useRef(showSRZones);
  const srStrongTouchesRef = useRef(srStrongTouches);
  const srLookbackBarsRef = useRef(srLookbackBars);
  const onIntentionalReloadAckRef = useRef(onIntentionalReloadAck);
  const waveTargetRef = useRef(waveTarget);
  const selectedToolRef = useRef(selectedTool);

  // Update ALL refs synchronously every render — before any effects fire.
  // This is the key pattern: refs are always current when effects read them.
  todayModeRef.current = todayMode;
  candlesRef.current = candles;
  emaHighsRef.current = emaHighs;
  emaLowsRef.current = emaLows;
  signalsRef.current = signals;
  showBubbleRef.current = showBubble;
  showWavesRef.current = showWaves;
  onWaveDataRef.current = onWaveData;
  showConsolidationRef.current = showConsolidation;
  bubbleGapRef.current = bubbleGap;
  onConsolidationDataRef.current = onConsolidationData;
  showSRZonesRef.current = showSRZones;
  srStrongTouchesRef.current = srStrongTouches;
  srLookbackBarsRef.current = srLookbackBars;
  onIntentionalReloadAckRef.current = onIntentionalReloadAck;
  waveTargetRef.current = waveTarget;
  selectedToolRef.current = selectedTool;

  // Keep window.__tggCandles in sync (used by ruler overlay)
  window.__tggCandles = candles;

  // ── Single marker refresh helper — one place that calls setMarkers ─────────
  // All code that wants to update markers calls this. The keyRef dedup ensures
  // setMarkers only fires when content actually changed.
  const refreshMarkers = useCallback(() => {
    if (!candleRef.current || !candlesRef.current?.length) return;
    const markers = showBubbleRef.current
      ? buildBubbleMarkers(signalsRef.current, candlesRef.current, todayModeRef.current)
      : [];
    setMarkersIfChanged(candleRef.current, markers, prevMarkerKeyRef);
  }, []); // no deps — reads everything from refs

  // ── resetView ─────────────────────────────────────────────────────────────
  const resetView = useCallback(() => {
    if (!chartRef.current || !candlesRef.current?.length) return;
    const chart = chartRef.current;
    const ts = chart.timeScale();
    const candles = candlesRef.current;
    const total = candles.length;

    const barsToShow = (() => {
      if (todayModeRef.current) {
        const latestIST = toISTDate(candles.at(-1).time);
        const todayCount = candles.filter(c => toISTDate(c.time) === latestIST).length;
        return Math.max(todayCount, 20);
      }
      return Math.min(80, total);
    })();

    const lastIdx = total - 1;
    const leftBars = Math.round(barsToShow * 0.65);
    const rightBars = Math.round(barsToShow * 0.35);
    const fromIdx = Math.max(0, lastIdx - leftBars);
    const toLogical = lastIdx + rightBars;

    try {
      chart.priceScale('right').applyOptions({ autoScale: false });
      // setVisibleLogicalRange already positions latest candle with right-side space
      // (toLogical = lastIdx + rightBars). Do NOT call scrollToRealTime() after this
      // because it would override and push the latest candle to the very right edge.
      ts.setVisibleLogicalRange({ from: fromIdx, to: toLogical });
      setTimeout(() => {
        try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch { }
      }, 80);
    } catch {
      try { ts.fitContent(); } catch { }
    }
  }, []);

  // Sync intentionalReloadRef from reloadToken
  useEffect(() => {
    if (reloadToken > 0 && reloadToken !== lastProcessedTokenRef.current) {
      intentionalReloadRef.current = true;
    }
  }, [reloadToken]);

  useEffect(() => {
    if (onResetViewReady) onResetViewReady(resetView);
  }, [onResetViewReady, resetView]);

  // ── Build chart once ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: theme === "light" ? "#ffffff" : "#0a0b0f" },
        textColor: theme === "light" ? "#4a5068" : "#7a8099",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: theme === "light" ? "#dde0ea" : "#1e2230" },
        horzLines: { color: theme === "light" ? "#dde0ea" : "#1e2230" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3d84ff", width: 1, style: LineStyle.Dashed },
        horzLine: { color: "#3d84ff", width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: theme === "light" ? "#dde0ea" : "#1e2230",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: theme === "light" ? "#dde0ea" : "#1e2230",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (unixSec) => {
          const d = new Date((unixSec + 19800) * 1000);
          const hh = String(d.getUTCHours()).padStart(2, "0");
          const mm = String(d.getUTCMinutes()).padStart(2, "0");
          const day = String(d.getUTCDate()).padStart(2, "0");
          const mon = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
          if ((hh === "00" && mm === "00") || (hh === "09" && mm === "15")) {
            return `${day} ${mon}`;
          }
          return `${hh}:${mm}`;
        },
      },
      localization: {
        timeFormatter: (unixSec) => {
          const d = new Date((unixSec + 19800) * 1000);
          const day = String(d.getUTCDate()).padStart(2, "0");
          const mon = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
          const yr = String(d.getUTCFullYear()).slice(2);
          const hh = String(d.getUTCHours()).padStart(2, "0");
          const mm = String(d.getUTCMinutes()).padStart(2, "0");
          if (hh === "00" && mm === "00") return `${day} ${mon} '${yr}`;
          return `${day} ${mon} '${yr} ${hh}:${mm} IST`;
        },
      },
      handleScroll: true,
      handleScale: true,
      width: containerRef.current.clientWidth || containerRef.current.offsetWidth || 800,
      height: containerRef.current.clientHeight || containerRef.current.offsetHeight || 500,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#00d97e", downColor: "#ff4560",
      borderUpColor: "#00d97e", borderDownColor: "#ff4560",
      wickUpColor: "#00d97e", wickDownColor: "#ff4560",
    });

    const emaHiSeries = chart.addLineSeries({
      color: "rgba(0,217,126,0.6)", lineWidth: 1.5, lineStyle: LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false,
    });

    const emaLoSeries = chart.addLineSeries({
      color: "rgba(255,69,96,0.6)", lineWidth: 1.5, lineStyle: LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    emaHiRef.current = emaHiSeries;
    emaLoRef.current = emaLoSeries;

    rulerRef.current = new RulerOverlay(containerRef.current, chartRef, candleRef);

    createWavesIndicator(
      chart,
      containerRef.current,
      (pivots, segments) => { if (onWaveDataRef.current) onWaveDataRef.current(pivots, segments); },
      candleSeries
    );

    createConsolidationIndicator(
      chart,
      containerRef.current,
      candleSeries,
      (zones) => { if (onConsolidationDataRef.current) onConsolidationDataRef.current(zones); }
    );

    createSRZonesIndicator(
      chart,
      containerRef.current,
      candleSeries
    );

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      const total = candlesRef.current?.length ?? 0;
      userScrolledRef.current = range.to < total - 1 - 8;
    });

    chart.subscribeCrosshairMove((param) => {
      if (!onCrosshairMove) return;
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        onCrosshairMove(null); return;
      }
      const bar = param.seriesData.get(candleSeries);
      if (!bar) { onCrosshairMove(null); return; }
      onCrosshairMove({ ...bar, unixSec: param.time });
    });

    const el = containerRef.current;
    const onContextMenu = (e) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      resetView();
      // Alt+right-click → also silently fetch fresh data without resetting view
      if (e.altKey && silentRefreshRef.current) silentRefreshRef.current();
    };
    el.addEventListener("contextmenu", onContextMenu);

    const ro = new ResizeObserver(() => {
      if (!chartRef.current || !containerRef.current) return;
      try {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        rulerRef.current?._onResize();
      } catch { }
    });
    ro.observe(el);

    return () => {
      el.removeEventListener("contextmenu", onContextMenu);
      ro.disconnect();
      rulerRef.current?.destroy();
      rulerRef.current = null;
      removeWavesIndicator(true, chart);
      removeConsolidationIndicator(true, chart);
      removeSRZonesIndicator(true, chart);
      // Null refs before deferred remove so any queued RAF paint callbacks bail cleanly
      chartRef.current = null;
      candleRef.current = null;
      setTimeout(() => { try { chart.remove(); } catch { } }, 0);
    };
  }, []); // Mount-only: chart is created once and torn down on unmount.
  // All data updates flow through refs (candlesRef, emaHighsRef, etc.)
  // to avoid re-running this expensive setup on every prop change.

  // ── Update chart colors when theme changes ──────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      layout: {
        background: { color: theme === "light" ? "#ffffff" : "#0a0b0f" },
        textColor: theme === "light" ? "#4a5068" : "#7a8099",
      },
      grid: {
        vertLines: { color: theme === "light" ? "#dde0ea" : "#1e2230" },
        horzLines: { color: theme === "light" ? "#dde0ea" : "#1e2230" },
      },
      rightPriceScale: { borderColor: theme === "light" ? "#dde0ea" : "#1e2230" },
      timeScale: { borderColor: theme === "light" ? "#dde0ea" : "#1e2230" },
    });
  }, [theme]);
  // Depends ONLY on candles. EMA and signals are read from refs (always current).
  // This is the critical fix: emaHighs/emaLows/signals changing reference on
  // every tick no longer triggers this effect.
  useEffect(() => {
    if (!candleRef.current || !candles?.length) return;

    const ts = chartRef.current.timeScale();
    const isFirst = isFirstLoadRef.current;

    const last = candles.at(-1);
    const lastKey = `${last.time}:${last.open}:${last.high}:${last.low}:${last.close}`;
    const prevCount = prevCountRef.current;
    const prevLastKey = prevLastCandleKeyRef.current;

    const resolutionChanged =
      prevResolutionRef.current !== null &&
      activeResolution != null &&
      Number(activeResolution) !== prevResolutionRef.current;

    const symbolChanged =
      prevSymbolRef.current !== null &&
      symbol != null &&
      symbol !== prevSymbolRef.current;

    const isLastCandleUpdate =
      !isFirst &&
      !intentionalReloadRef.current &&
      !resolutionChanged &&
      !symbolChanged &&
      candles.length === prevCount &&
      lastKey !== prevLastKey;

    // Allow up to 5 candle appends as incremental (covers tick-gap recovery)
    const isNewCandleAppended =
      !isFirst &&
      !intentionalReloadRef.current &&
      !resolutionChanged &&
      !symbolChanged &&
      candles.length > prevCount &&
      candles.length <= prevCount + 5;

    if (isLastCandleUpdate || isNewCandleAppended) {
      // ── INCREMENTAL PATH — zero setData, zero setMarkers ──────────────────
      // Push each new candle individually. For EMA, read from ref (always fresh).
      const emaH = emaHighsRef.current;
      const emaL = emaLowsRef.current;

      const startIdx = isNewCandleAppended ? prevCount : candles.length - 1;

      // Guard: if the first new candle's time is older than what the chart holds,
      // the series would throw "Cannot update oldest data". Fall through to full reload.
      const firstNewT = Math.floor(candles[startIdx]?.time / 1000);
      const lastChartT = prevLastCandleKeyRef.current
        ? Math.floor(Number(prevLastCandleKeyRef.current.split(":")[0]) / 1000)
        : 0;
      if (firstNewT > 0 && lastChartT > 0 && firstNewT < lastChartT) {
        // Fall through to full setData below
      } else {
        try {
          for (let ni = startIdx; ni < candles.length; ni++) {
            const nc = candles[ni];
            const t = Math.floor(nc.time / 1000);
            if (!Number.isFinite(t) || t <= 0) continue;
            const bar = { time: t, open: nc.open, high: nc.high, low: nc.low, close: nc.close };
            candleRef.current.update(bar);
            if (emaH[ni] != null && !isNaN(emaH[ni])) emaHiRef.current.update({ time: bar.time, value: emaH[ni] });
            if (emaL[ni] != null && !isNaN(emaL[ni])) emaLoRef.current.update({ time: bar.time, value: emaL[ni] });
          }
          // Re-push last candle to handle same-minute tick updates
          const lcT = Math.floor(last.time / 1000);
          if (Number.isFinite(lcT) && lcT > 0) {
            const lc = { time: lcT, open: last.open, high: last.high, low: last.low, close: last.close };
            candleRef.current.update(lc);
            const li = candles.length - 1;
            if (emaH[li] != null && !isNaN(emaH[li])) emaHiRef.current.update({ time: lc.time, value: emaH[li] });
            if (emaL[li] != null && !isNaN(emaL[li])) emaLoRef.current.update({ time: lc.time, value: emaL[li] });
          }

          if (showWavesRef.current) updateWavesIndicator(candles, emaH, emaL, chartRef.current);
          if (showConsolidationRef.current) updateConsolidationIndicator(candles, emaH, emaL, chartRef.current, bubbleGapRef.current);
          if (showSRZonesRef.current) updateSRZonesIndicator(candles, emaH, emaL, chartRef.current, srStrongTouchesRef.current, srLookbackBarsRef.current);

          prevCountRef.current = candles.length;
          prevLastCandleKeyRef.current = lastKey;
          if (activeResolution != null) prevResolutionRef.current = Number(activeResolution);
          if (symbol != null) prevSymbolRef.current = symbol;

          // Auto-scroll only if pinned to right edge
          if (!userScrolledRef.current) {
            try {
              const range = ts.getVisibleLogicalRange();
              if (range && isNewCandleAppended) {
                ts.setVisibleLogicalRange({ from: range.from + 1, to: range.to + 1 });
              }
            } catch { }
          }
          return; // ← no marker work on price ticks
        } catch (e) {
          // Incremental update failed (e.g. timestamp ordering issue) — fall through to full reload
          console.warn("[CandleChart] Incremental update failed, falling back to setData:", e.message);
        }
      }
    }

    // ── FULL RELOAD PATH ──────────────────────────────────────────────────────
    const savedRange = isFirst ? null : (() => {
      try { return ts.getVisibleLogicalRange(); } catch { return null; }
    })();
    const isIntentional = intentionalReloadRef.current;

    const emaH = emaHighsRef.current;
    const emaL = emaLowsRef.current;

    // Helper: build a clean sorted, deduplicated series from candles + parallel array
    function makeTimedSeries(arr, valueArr) {
      const out = [];
      arr.forEach((c, i) => {
        const t = Math.floor(c.time / 1000);
        const v = valueArr[i];
        if (Number.isFinite(t) && t > 0 && v != null && !isNaN(v)) out.push({ time: t, value: v });
      });
      return out
        .sort((a, b) => a.time - b.time)
        .filter((d, i, a) => i === 0 || d.time !== a[i - 1].time);
    }

    const cleanCandles = candles
      .map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close }))
      .filter((c) => Number.isFinite(c.time) && c.time > 0)
      .sort((a, b) => a.time - b.time)
      .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

    try {
      candleRef.current.setData(cleanCandles);
      emaHiRef.current.setData(makeTimedSeries(candles, emaH));
      emaLoRef.current.setData(makeTimedSeries(candles, emaL));
    } catch (e) {
      console.error("[CandleChart] setData failed:", e.message);
      // Last-resort: try again with only the most recent 500 candles
      try {
        const tail = cleanCandles.slice(-500);
        candleRef.current.setData(tail);
        emaHiRef.current.setData(makeTimedSeries(candles.slice(-500), emaH.slice(-500)));
        emaLoRef.current.setData(makeTimedSeries(candles.slice(-500), emaL.slice(-500)));
      } catch (e2) {
        console.error("[CandleChart] setData fallback also failed:", e2.message);
      }
    }

    if (showWavesRef.current) updateWavesIndicator(candles, emaH, emaL, chartRef.current);
    else removeWavesIndicator(false, chartRef.current);

    if (showConsolidationRef.current) updateConsolidationIndicator(candles, emaH, emaL, chartRef.current, bubbleGapRef.current);
    else removeConsolidationIndicator(false, chartRef.current);

    if (showSRZonesRef.current) updateSRZonesIndicator(candles, emaH, emaL, chartRef.current, srStrongTouchesRef.current, srLookbackBarsRef.current);
    else removeSRZonesIndicator(false, chartRef.current);

    // After setData, markers need a full refresh (series was rebuilt)
    // Reset the key so setMarkersIfChanged always fires after setData
    prevMarkerKeyRef.current = null;
    refreshMarkers();

    prevCountRef.current = candles.length;
    prevLastCandleKeyRef.current = lastKey;
    if (activeResolution != null) prevResolutionRef.current = Number(activeResolution);
    if (symbol != null) prevSymbolRef.current = symbol;

    if (isFirst) {
      isFirstLoadRef.current = false;
      intentionalReloadRef.current = false;
      lastProcessedTokenRef.current = reloadToken;
      userScrolledRef.current = false;
      if (onIntentionalReloadAckRef.current) onIntentionalReloadAckRef.current();

      const wt = waveTargetRef.current;
      if (wt && wt.fromMs && wt.toMs && candles.length > 0) {
        const fromSec = Math.floor(wt.fromMs / 1000);
        const toSec = Math.floor(wt.toMs / 1000);
        const candleSecs = candles.map((c) => Math.floor(c.time / 1000));
        let fromIdx = candleSecs.findIndex((t) => t >= fromSec);
        let toIdx = candleSecs.findIndex((t) => t >= toSec);
        if (fromIdx < 0) fromIdx = 0;
        if (toIdx < 0) toIdx = candles.length - 1;
        const waveSpan = toIdx - fromIdx;
        const padding = Math.max(Math.round(waveSpan * 0.5), 3);
        const from = Math.max(0, fromIdx - padding);
        const to = Math.min(candles.length - 1, toIdx + padding);
        setTimeout(() => {
          try {
            const tsc = chartRef.current?.timeScale();
            if (!tsc) { resetView(); return; }
            tsc.setVisibleLogicalRange({ from, to });
            setTimeout(() => {
              try { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); } catch { }
            }, 80);
          } catch { resetView(); }
        }, 50);
      } else {
        resetView();
      }
    } else if (isIntentional || resolutionChanged || symbolChanged) {
      intentionalReloadRef.current = false;
      lastProcessedTokenRef.current = reloadToken;
      userScrolledRef.current = false;
      if (onIntentionalReloadAckRef.current) onIntentionalReloadAckRef.current();
      resetView();
    } else {
      if (savedRange) {
        setTimeout(() => {
          try { chartRef.current?.timeScale().setVisibleLogicalRange(savedRange); }
          catch { resetView(); }
        }, 0);
      } else {
        resetView();
      }
    }
  }, [candles]); // emaHighs/emaLows/signals are read from refs — they intentionally
  // do NOT trigger this effect. Only new candle data resets the view.

  // ── Cursor/Tool mode: toggle chart pan vs drawing mode ───────────────────
  // When selectedTool is "cursor" → normal pan/scroll (handleScroll: true)
  // When any drawing tool is active → disable scroll so clicks don't pan
  // Only applies to the active panel; inactive panels always stay in pan mode.
  useEffect(() => {
    if (!chartRef.current) return;

    // Trash: clear all drawings and snap back to cursor
    if (selectedTool === "trash") {
      drawingOverlayRef.current?.clearAll();
      setSelectedTool("cursor");
      return;
    }

    const isPanMode = selectedTool === "cursor";
    chartRef.current.applyOptions({
      handleScroll: isPanMode,
      handleScale: isPanMode,
      crosshair: {
        mode: CrosshairMode.Normal,
      },
    });
    // Update cursor style on the container
    if (containerRef.current) {
      containerRef.current.style.cursor = isPanMode ? "" : "crosshair";
    }
  }, [selectedTool, setSelectedTool, isActivePanel]);

  // ── SR Price Lines — draw horizontal S&R levels on chart ─────────────────
  // Draws each srLines entry as a createPriceLine on the candle series.
  // When srLines is empty, all previously drawn lines are removed.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;

    // Remove existing SR price lines
    srPriceLinesRef.current.forEach((pl) => {
      try { series.removePriceLine(pl); } catch (_) { }
    });
    srPriceLinesRef.current = [];

    if (!srLines?.length) {
      if (onSRLinesDrawn) onSRLinesDrawn(false);
      return;
    }

    // Draw new lines
    const handles = srLines.map(({ price, color, label, lineStyle: ls }) => {
      try {
        return series.createPriceLine({
          price,
          color: color || "#2962ff",
          lineWidth: 1,
          lineStyle: ls ?? LineStyle.Dashed,
          axisLabelVisible: true,
          title: label || "",
        });
      } catch (_) { return null; }
    }).filter(Boolean);

    srPriceLinesRef.current = handles;
    if (onSRLinesDrawn) onSRLinesDrawn(handles.length > 0);
    // candleRef/chartRef are stable refs — not needed in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srLines, onSRLinesDrawn]);

  // ── Markers: refresh when signals, todayMode, or showBubble changes ────────
  // These three are the ONLY things that should cause setMarkers to fire.
  // Price ticks do NOT touch this effect because candles is not in the dep array here.
  useEffect(() => {
    refreshMarkers();
    // candleRef/candlesRef are stable refs — deliberately excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, todayMode, showBubble, refreshMarkers]);

  // ── Waves toggle ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    if (showWaves) {
      if (candlesRef.current?.length)
        updateWavesIndicator(candlesRef.current, emaHighsRef.current, emaLowsRef.current, chartRef.current);
    } else {
      removeWavesIndicator(false, chartRef.current);
    }
    // Waves toggle can shift marker positions — refresh
    refreshMarkers();
    // candlesRef/emaHighsRef/emaLowsRef/chartRef are stable refs — not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWaves, refreshMarkers]);

  // ── Consolidation toggle + bubbleGap change ────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    if (showConsolidation) {
      if (candlesRef.current?.length)
        updateConsolidationIndicator(candlesRef.current, emaHighsRef.current, emaLowsRef.current, chartRef.current, bubbleGap);
    } else {
      removeConsolidationIndicator(false, chartRef.current);
    }
    // candlesRef/emaHighsRef/emaLowsRef/chartRef are stable refs — not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConsolidation, bubbleGap]);

  // ── SR Zones toggle ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    if (showSRZones) {
      if (candlesRef.current?.length)
        updateSRZonesIndicator(
          candlesRef.current, emaHighsRef.current, emaLowsRef.current,
          chartRef.current, srStrongTouches, srLookbackBars
        );
    } else {
      removeSRZonesIndicator(false, chartRef.current);
    }
    // candlesRef/emaHighsRef/emaLowsRef/chartRef are stable refs — not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSRZones, srStrongTouches, srLookbackBars]);

  // ── Candle countdown timer — pixel-tracked to last price ──────────────────
  // timerInfo: { price, secsLeft, isBull, yPx }
  // yPx is the canvas Y-coordinate of the last close price so the badge
  // sits exactly on the price line and moves tick-by-tick with the market.
  const [timerInfo, setTimerInfo] = useState(null);
  const timerYIntervalRef = useRef(null);

  useEffect(() => {
    let intervalId = null;
    let secsLeft = 0;

    function getPriceY(price) {
      // candleRef is the candlestick series — it has priceToCoordinate()
      try {
        const y = candleRef.current?.priceToCoordinate(price);
        return (y != null && isFinite(y)) ? y : null;
      } catch { return null; }
    }

    function computeSecsLeft(candleStartMs, resMins) {
      const resMs = resMins * 60 * 1000;
      const candleEndMs = candleStartMs + resMs;
      return Math.max(0, Math.round((candleEndMs - Date.now()) / 1000));
    }

    function update() {
      const candles = candlesRef.current;
      if (!candles || candles.length === 0) { setTimerInfo(null); return; }

      const lastCandle = candles.at(-1);
      const close = lastCandle.close;
      const open = lastCandle.open;
      const isBull = close >= open;
      const resMins = activeResolution ? Number(activeResolution) : 1;

      secsLeft = computeSecsLeft(lastCandle.time, resMins);
      const yPx = getPriceY(close);

      setTimerInfo({ price: close, secsLeft, isBull, yPx });
    }

    // Tick the countdown every second
    function tick() {
      const candles = candlesRef.current;
      if (!candles || candles.length === 0) return;
      const lastCandle = candles.at(-1);
      const close = lastCandle.close;
      const open = lastCandle.open;
      const isBull = close >= open;
      const resMins = activeResolution ? Number(activeResolution) : 1;
      secsLeft = computeSecsLeft(lastCandle.time, resMins);
      const yPx = getPriceY(close);
      setTimerInfo({ price: close, secsLeft, isBull, yPx });
    }

    // Recompute Y position every 250ms so the badge tracks vertical pans/zooms.
    // 250ms (4fps) is imperceptible for a price badge — 60fps RAF was triggering
    // React re-renders on every animation frame, causing all indicators to re-check.
    function yPosUpdate() {
      const candles = candlesRef.current;
      if (candles && candles.length > 0) {
        const close = candles.at(-1).close;
        const yPx = getPriceY(close);
        setTimerInfo((prev) => {
          if (!prev) return prev;
          if (prev.yPx === yPx) return prev; // no re-render if Y hasn't changed
          return { ...prev, yPx };
        });
      }
    }

    update();
    intervalId = setInterval(tick, 1000);
    timerYIntervalRef.current = setInterval(yPosUpdate, 250);

    return () => {
      clearInterval(intervalId);
      if (timerYIntervalRef.current) clearInterval(timerYIntervalRef.current);
    };
    // chartRef/candleRef/containerRef are stable refs — not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, activeResolution]);

  // Keep isActivePanel in a ref so the mousedown handler never triggers re-renders
  // when the panel is already active (avoids choppy chart during panning)
  const isActivePanelRef = useRef(isActivePanel);
  useEffect(() => { isActivePanelRef.current = isActivePanel; }, [isActivePanel]);
  const onPanelActivateRef = useRef(onPanelActivate);
  useEffect(() => { onPanelActivateRef.current = onPanelActivate; }, [onPanelActivate]);

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseDown={() => {
        // Only call onPanelActivate when this panel is NOT yet active.
        // Checking the ref (not state) avoids triggering a parent re-render
        // on every click/drag inside an already-active panel, which was
        // causing choppy chart panning when indicators were enabled.
        if (!isActivePanelRef.current && onPanelActivateRef.current) {
          onPanelActivateRef.current();
        }
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* ── Drawing overlay — SVG on top of chart canvas ── */}
      <DrawingOverlay
        ref={drawingOverlayRef}
        chartRef={chartRef}
        candleSeriesRef={candleRef}
        selectedTool={selectedTool}
        setSelectedTool={setSelectedTool}
        containerRef={containerRef}
        hidden={drawingsHidden}
        drawColor={drawColor}
        lastBarTime={candles?.length ? candles[candles.length - 1].time : null}
        secondLastBarTime={candles?.length >= 2 ? candles[candles.length - 2].time : null}
        linkColor={linkColor}
        sharedDrawings={sharedDrawings || []}
        onPublishDrawings={onPublishDrawings}
        setAbsorbShared={setAbsorbShared}
        onClearSharedDrawings={onClearSharedDrawings}
        onContextMenu={resetView}
        isActivePanel={isActivePanel}
        onPanelActivate={onPanelActivate}
        panelKey={panelKey}
        resolution={activeResolution}
        syncedCrosshairPrice={syncedCrosshairPrice}
        onSyncCrosshair={onSyncCrosshair}
      />

      {/* Hint labels */}
      <div style={{
        position: "absolute", bottom: 36, left: 12,
        color: "#4a5270", fontSize: 10, fontFamily: "var(--font-mono)",
        pointerEvents: "none", userSelect: "none",
        display: "flex", gap: 16,
      }}>
        <span>Right-click → reset view</span>
        <span style={{ color: "#3a4060" }}>Ctrl+Shift = ruler</span>
      </div>

      {/* ── Candle Timer — countdown only, sits below the native last-price axis label ── */}
      {timerInfo && timerInfo.yPx != null && (
        <div style={{
          position: "absolute",
          // ~11px below the price line so it clears the native axis label (~20px tall)
          top: timerInfo.yPx + 11,
          // Flush against the right edge — same width as the price scale axis
          right: 0,
          pointerEvents: "none",
          userSelect: "none",
          zIndex: 30,
        }}>
          <div style={{
            background: timerInfo.isBull ? "rgba(0,160,85,0.95)" : "rgba(200,40,55,0.95)",
            color: "#ffffff",
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
            fontSize: 11,
            padding: "2px 0",
            letterSpacing: "0.06em",
            lineHeight: 1.5,
            textAlign: "center",
            whiteSpace: "nowrap",
            // Match the width of the right price scale so it looks native
            width: 68,
          }}>
            {String(Math.floor(timerInfo.secsLeft / 60)).padStart(2, "0")}:{String(timerInfo.secsLeft % 60).padStart(2, "0")}
          </div>
        </div>
      )}
    </div>
  );
}