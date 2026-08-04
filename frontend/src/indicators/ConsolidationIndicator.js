/**
 * ConsolidationIndicator.js
 *
 * Port of the Pine Script "EMA 9 Consolidation Zone Breakout v4" to JS.
 *
 * Pure calc:  calcConsolidationZonesPure(candles, emaHighs, emaLows, bubbleGap)
 *   → { zones: [...] }
 *   Each zone: { startBarIndex, endBarIndex, top, bottom, broken, breakDir,
 *                hhBar, llBar, hhPrice, llPrice, startTime, endTime, status }
 *
 * Canvas overlay: mirrors WavesIndicator pattern — per-chart instance, rAF-based.
 */

// ─── Pure zone calculation ────────────────────────────────────────────────────

export function calcConsolidationZonesPure(candles, emaHighs, emaLows, bubbleGap = 4) {
  if (!candles?.length) return { zones: [] };

  // Build EMA arrays if not supplied
  function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    const out = new Array(prices.length).fill(null);
    let ema = null;
    for (let i = 0; i < prices.length; i++) {
      const p = prices[i];
      if (p == null || isNaN(p)) continue;
      ema = ema === null ? p : p * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  // CHUNK 6 investigation (2026-08-04): this fallback is NOT dead code —
  // see the identical note in indicators/WavesIndicator.js for the full
  // trace. Short version: on the live socket-driven chart, candles update
  // on every tick but emaHighs/emaLows only update on a full refresh, so
  // this local calcEMA runs routinely during a live session, not rarely.
  const eH = emaHighs?.length === candles.length
    ? emaHighs : calcEMA(candles.map((c) => c.high), 9);
  const eL = emaLows?.length === candles.length
    ? emaLows : calcEMA(candles.map((c) => c.low), 9);

  // ── State machine ──────────────────────────────────────────────────────────
  let seeking = 0;
  let bestPrice = null, bestBar = null;
  let lastType = "", lastBar = null, lastPrice = null;

  // Active zone tracking
  let inZone = false;
  let zoneTop = null, zoneBot = null, zoneStart = null;
  let zoneHHBar = null, zoneLLBar = null;
  let zoneHHPrice = null, zoneLLPrice = null;

  const zones = [];

  function createZone(barA, barB) {
    const hA = candles[barA].high, lA = candles[barA].low;
    const hB = candles[barB].high, lB = candles[barB].low;
    const zoneTopBase = Math.max(hA, hB);
    const zoneBotBase = Math.min(lA, lB);
    const zoneSize = zoneTopBase - zoneBotBase;
    const extend = zoneSize * 0.05;
    return { top: zoneTopBase + extend, bot: zoneBotBase - extend };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const emaH = eH[i], emaL = eL[i];
    if (emaH == null || emaL == null) continue;

    const touchHigh = c.high >= emaH;
    const touchLow = c.low <= emaL;

    // ── Extend active zone right ────────────────────────────────────────────
    if (inZone) {
      // Check breakout on confirmed close (every bar is "confirmed" in history)
      const brokeUp = c.close > zoneTop;
      const brokeDn = c.close < zoneBot;
      if (brokeUp || brokeDn) {
        zones.push({
          startBarIndex: zoneStart,
          endBarIndex: i - 1,       // box stops BEFORE breakout candle
          top: zoneTop,
          bottom: zoneBot,
          broken: true,
          breakDir: brokeUp ? "up" : "down",
          hhBar: zoneHHBar,
          llBar: zoneLLBar,
          hhPrice: zoneHHPrice,
          llPrice: zoneLLPrice,
          startTime: candles[zoneStart].time,
          endTime: candles[Math.max(0, i - 1)].time,
          status: brokeUp ? "up" : "down",
        });
        inZone = false; zoneTop = null; zoneBot = null; zoneStart = null;
        lastType = ""; lastBar = null; lastPrice = null;
      }
    }

    // ── State machine ───────────────────────────────────────────────────────
    if (seeking === 0) {
      if (touchHigh && !touchLow) { seeking = 1; bestPrice = c.high; bestBar = i; }
      else if (touchLow && !touchHigh) { seeking = -1; bestPrice = c.low; bestBar = i; }
    }

    else if (seeking === 1) {
      if (touchHigh && !touchLow) {
        if (c.high >= bestPrice) { bestPrice = c.high; bestBar = i; }
      } else if (touchLow) {
        // Confirm HH
        const hhBar = bestBar, hhPrice = bestPrice;

        if (!inZone && lastType === "LL" && Math.abs(hhBar - lastBar) <= bubbleGap) {
          const { top, bot } = createZone(hhBar, lastBar);
          zoneTop = top; zoneBot = bot;
          zoneStart = Math.min(hhBar, lastBar);
          zoneHHBar = hhBar; zoneLLBar = lastBar;
          zoneHHPrice = hhPrice; zoneLLPrice = lastPrice;
          inZone = true;
        }

        lastType = "HH"; lastBar = hhBar; lastPrice = hhPrice;
        seeking = -1; bestPrice = c.low; bestBar = i;
      }
    }

    else if (seeking === -1) {
      if (touchLow && !touchHigh) {
        if (c.low <= bestPrice) { bestPrice = c.low; bestBar = i; }
      } else if (touchHigh) {
        // Confirm LL
        const llBar = bestBar, llPrice = bestPrice;

        if (!inZone && lastType === "HH" && Math.abs(llBar - lastBar) <= bubbleGap) {
          const { top, bot } = createZone(llBar, lastBar);
          zoneTop = top; zoneBot = bot;
          zoneStart = Math.min(llBar, lastBar);
          zoneHHBar = lastBar; zoneLLBar = llBar;
          zoneHHPrice = lastPrice; zoneLLPrice = llPrice;
          inZone = true;
        }

        lastType = "LL"; lastBar = llBar; lastPrice = llPrice;
        seeking = 1; bestPrice = c.high; bestBar = i;
      }
    }
  }

  // If still in an active zone at end of data, push it as "active"
  if (inZone && zoneStart != null) {
    zones.push({
      startBarIndex: zoneStart,
      endBarIndex: candles.length - 1,
      top: zoneTop,
      bottom: zoneBot,
      broken: false,
      breakDir: null,
      hhBar: zoneHHBar,
      llBar: zoneLLBar,
      hhPrice: zoneHHPrice,
      llPrice: zoneLLPrice,
      startTime: candles[zoneStart].time,
      endTime: candles[candles.length - 1].time,
      status: "active",
    });
  }

  // Keep last 50 zones
  return { zones: zones.slice(-50) };
}

// ─── Per-instance state map ───────────────────────────────────────────────────

const _instances = new Map();
const _idMap = new WeakMap();
let _idCtr = 0;
function _instId(inst) {
  if (!_idMap.has(inst.chart)) _idMap.set(inst.chart, ++_idCtr);
  return _idMap.get(inst.chart);
}

function _getInstance(chart) { return _instances.get(chart) ?? null; }

function _createInstance(chart, container, candleSeries) {
  const inst = {
    chart, container, series: candleSeries ?? null,
    canvas: null, ctx: null,
    zones: [],
    rafId: null,
    rangeUnsub: null, resizeObs: null,
    isPanning: false, panClearId: null,
    fingerprint: "",
    bubbleGap: 4,
    onZoneData: null,
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) { _instances.delete(inst.chart); }

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function _ensureCanvas(inst) {
  if (inst.canvas && inst.container.contains(inst.canvas)) return;
  const cls = "__cz_" + _instId(inst);
  const old = inst.container.querySelector("." + cls);
  if (old) try { inst.container.removeChild(old); } catch (_) { }
  inst.canvas = document.createElement("canvas");
  inst.canvas.className = "__cz " + cls;
  inst.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:4;";
  inst.container.appendChild(inst.canvas);
  inst.ctx = inst.canvas.getContext("2d");
  _syncSize(inst);
  inst.resizeObs = new ResizeObserver(() => { _syncSize(inst); _scheduleRedraw(inst); });
  inst.resizeObs.observe(inst.container);
}

function _syncSize(inst) {
  if (!inst.canvas || !inst.container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = inst.container.clientWidth, h = inst.container.clientHeight;
  inst.canvas.width = w * dpr; inst.canvas.height = h * dpr;
  inst.canvas.style.width = `${w}px`; inst.canvas.style.height = `${h}px`;
  if (inst.ctx) inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _removeCanvas(inst) {
  if (inst.resizeObs) { inst.resizeObs.disconnect(); inst.resizeObs = null; }
  if (inst.canvas) {
    try { inst.canvas.parentNode?.removeChild(inst.canvas); } catch (_) { }
    inst.canvas = null; inst.ctx = null;
  }
}

function _priceScaleWidth(inst) {
  try { const ps = inst.chart.priceScale("right"); if (ps?.width) return ps.width(); } catch (_) { }
  return 0;
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);
  if (!inst.zones.length) return;

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ts = inst.chart.timeScale();

  function toX(timeMs) {
    try { const x = ts.timeToCoordinate(Math.floor(timeMs / 1000)); return x; } catch (_) { return null; }
  }
  function toY(price) {
    try { return inst.series.priceToCoordinate(price); } catch (_) { return null; }
  }

  inst.ctx.save();
  inst.ctx.beginPath();
  inst.ctx.rect(0, 0, plotW, ch);
  inst.ctx.clip();

  inst.zones.forEach((z) => {
    const x1 = toX(z.startTime);
    const x2 = toX(z.endTime);
    const y1 = toY(z.top);
    const y2 = toY(z.bottom);
    if (x1 == null || x2 == null || y1 == null || y2 == null) return;

    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bot = Math.max(y1, y2);
    const w = right - left;
    const h = bot - top;
    if (w < 1 || h < 1) return;

    // Colors by status
    let fillColor, borderColor;
    if (z.status === "active") {
      fillColor = "rgba(61,132,255,0.10)";
      borderColor = "rgba(61,132,255,0.6)";
    } else if (z.status === "up") {
      fillColor = "rgba(0,217,126,0.10)";
      borderColor = "rgba(0,217,126,0.6)";
    } else {
      fillColor = "rgba(255,69,96,0.10)";
      borderColor = "rgba(255,69,96,0.6)";
    }

    // Fill
    inst.ctx.fillStyle = fillColor;
    inst.ctx.fillRect(left, top, w, h);

    // Dashed border
    inst.ctx.strokeStyle = borderColor;
    inst.ctx.lineWidth = 1.5;
    inst.ctx.setLineDash([4, 3]);
    inst.ctx.strokeRect(left, top, w, h);
    inst.ctx.setLineDash([]);
  });

  inst.ctx.restore();
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function _scheduleRedraw(inst) {
  if (inst.rafId != null) return;
  inst.rafId = requestAnimationFrame(() => { inst.rafId = null; _redraw(inst); });
}

function _clearOverlay(inst) {
  if (inst.rafId != null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
  if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createConsolidationIndicator(chart, container, candleSeries, onZoneData) {
  const existing = _getInstance(chart);
  if (existing) { _clearOverlay(existing); _removeCanvas(existing); _destroyInstance(existing); }
  const inst = _createInstance(chart, container, candleSeries);
  inst.onZoneData = onZoneData ?? null;
}

export function updateConsolidationIndicator(candles, emaHighs, emaLows, chart, bubbleGap = 4) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !inst.chart || !candles?.length) return;

  inst.bubbleGap = bubbleGap;
  const { zones } = calcConsolidationZonesPure(candles, emaHighs, emaLows, bubbleGap);
  const fp = zones.map((z) => `${z.startBarIndex}:${z.top.toFixed(2)}:${z.status}`).join("|");

  if (fp === inst.fingerprint) { _scheduleRedraw(inst); return; }
  inst.fingerprint = fp;
  inst.zones = zones;

  _clearOverlay(inst);
  _ensureCanvas(inst);

  if (!inst.rangeUnsub && inst.chart) {
    const handler = () => {
      inst.isPanning = true;
      if (inst.panClearId) clearTimeout(inst.panClearId);
      inst.panClearId = setTimeout(() => { inst.isPanning = false; inst.panClearId = null; }, 150);
      _scheduleRedraw(inst);
    };
    inst.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => {
      try { inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch (_) { }
    };
  }

  _scheduleRedraw(inst);
  if (inst.onZoneData) inst.onZoneData(zones);
}

export function removeConsolidationIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;
  _clearOverlay(inst);
  inst.zones = []; inst.fingerprint = "";
  if (inst.panClearId) { clearTimeout(inst.panClearId); inst.panClearId = null; }
  inst.isPanning = false;
  if (fullTeardown) {
    if (inst.rangeUnsub) { inst.rangeUnsub(); inst.rangeUnsub = null; }
    _removeCanvas(inst);
    _destroyInstance(inst);
  }
  if (inst.onZoneData) inst.onZoneData([]);
}