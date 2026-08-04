/**
 * SRZonesIndicator.js
 *
 * JS port of the Pine Script "EMA 9 Wave Support Resistance Zones".
 *
 * Pure calc:  calcSRZonesPure(candles, emaHighs, emaLows, strongTouches, lookbackBars)
 *   → { resistanceZones, supportZones }
 *   Each zone: { startBarIndex, top, bottom, broken, strong, side, startTime }
 *
 * Canvas overlay: same per-chart instance / rAF pattern as WavesIndicator.
 *   - Resistance zones  → green fill  (purple if ≥ strongTouches historical touches)
 *   - Support zones     → red fill    (purple if ≥ strongTouches historical touches)
 *   - Broken zones (close beyond zone) are removed from the live array (like Pine does)
 *
 * Public API (mirrors WavesIndicator / ConsolidationIndicator):
 *   createSRZonesIndicator(chart, container, candleSeries)
 *   updateSRZonesIndicator(candles, emaHighs, emaLows, chart, strongTouches, lookbackBars)
 *   removeSRZonesIndicator(fullTeardown, chart)
 */

const MAX_ZONES = 100;

// ─── EMA helper ──────────────────────────────────────────────────────────────

function _calcEMA(prices, period) {
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

// ─── Pure calculation (no DOM) ───────────────────────────────────────────────

/**
 * Ports the Pine Script state machine exactly:
 *
 *  state 0  → idle, waiting for first EMA touch
 *  state 1  → tracking HIGH side (resistance candidate)
 *  state -1 → tracking LOW  side (support candidate)
 *
 * When a resistance zone is confirmed (high side → low touch):
 *   top    = bestPrice (highest high that touched EMA high)
 *   bottom = body top of that candle  (math.max(open, close))
 *
 * When a support zone is confirmed (low side → high touch):
 *   top    = body bottom  (math.min(open, close))
 *   bottom = bestPrice (lowest low that touched EMA low)
 *
 * Historical touch count:
 *   Resistance: count bars in lookback where high ∈ [zoneBottom, zoneTop]
 *   Support:    count bars in lookback where low  ∈ [zoneBottom, zoneTop]
 *
 * Broken zones:
 *   Resistance: close > zoneTop   → remove
 *   Support:    close < zoneBottom → remove
 */
export function calcSRZonesPure(
  candles,
  emaHighs,
  emaLows,
  strongTouches = 3,
  lookbackBars = 300
) {
  if (!candles?.length) return { resistanceZones: [], supportZones: [] };

  // CHUNK 6 investigation (2026-08-04): this fallback is NOT dead code —
  // see the identical note in indicators/WavesIndicator.js for the full
  // trace. Short version: on the live socket-driven chart, candles update
  // on every tick but emaHighs/emaLows only update on a full refresh, so
  // this local _calcEMA runs routinely during a live session, not rarely.
  const eH = emaHighs?.length === candles.length
    ? emaHighs : _calcEMA(candles.map((c) => c.high), 9);
  const eL = emaLows?.length === candles.length
    ? emaLows : _calcEMA(candles.map((c) => c.low), 9);

  let state = 0;
  let bestPrice = null, bestBar = null, bestOpen = null, bestClose = null;

  // Live (unbroken) zones  — we accumulate and also delete broken ones as we go
  const resistanceZones = [];
  const supportZones = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const emaH = eH[i], emaL = eL[i];
    if (emaH == null || emaL == null) continue;

    const touchHigh = c.high >= emaH;
    const touchLow = c.low <= emaL;

    // ── State 0: idle ────────────────────────────────────────────────────────
    if (state === 0) {
      if (touchHigh) {
        state = 1; bestPrice = c.high; bestBar = i;
        bestOpen = c.open; bestClose = c.close;
      } else if (touchLow) {
        state = -1; bestPrice = c.low; bestBar = i;
        bestOpen = c.open; bestClose = c.close;
      }
      continue;
    }

    // ── State 1: tracking resistance ─────────────────────────────────────────
    if (state === 1) {
      if (touchHigh) {
        if (c.high >= bestPrice) {
          bestPrice = c.high; bestBar = i;
          bestOpen = c.open; bestClose = c.close;
        }
      } else if (touchLow) {
        // Confirm resistance zone
        const zoneTop = bestPrice;
        const zoneBottom = Math.max(bestOpen, bestClose); // body top

        resistanceZones.push({
          side: "resistance",
          startBarIndex: bestBar,
          startTime: candles[bestBar].time,
          top: zoneTop,
          bottom: zoneBottom,
          broken: false,
          strong: false,   // filled in after touch count
        });

        // Trim to MAX
        if (resistanceZones.length > MAX_ZONES) resistanceZones.shift();

        // Switch to tracking support
        state = -1;
        bestPrice = c.low; bestBar = i;
        bestOpen = c.open; bestClose = c.close;
      }
      // Check if this bar breaks any existing resistance zone
      for (let j = resistanceZones.length - 1; j >= 0; j--) {
        if (c.close > resistanceZones[j].top) {
          resistanceZones[j].broken = true;
          resistanceZones.splice(j, 1);
        }
      }
      continue;
    }

    // ── State -1: tracking support ───────────────────────────────────────────
    if (state === -1) {
      if (touchLow) {
        if (c.low <= bestPrice) {
          bestPrice = c.low; bestBar = i;
          bestOpen = c.open; bestClose = c.close;
        }
      } else if (touchHigh) {
        // Confirm support zone
        const zoneTop = Math.min(bestOpen, bestClose); // body bottom
        const zoneBottom = bestPrice;

        supportZones.push({
          side: "support",
          startBarIndex: bestBar,
          startTime: candles[bestBar].time,
          top: zoneTop,
          bottom: zoneBottom,
          broken: false,
          strong: false,
        });

        if (supportZones.length > MAX_ZONES) supportZones.shift();

        // Switch to tracking resistance
        state = 1;
        bestPrice = c.high; bestBar = i;
        bestOpen = c.open; bestClose = c.close;
      }
      // Check if this bar breaks any existing support zone
      for (let j = supportZones.length - 1; j >= 0; j--) {
        if (c.close < supportZones[j].bottom) {
          supportZones[j].broken = true;
          supportZones.splice(j, 1);
        }
      }
      continue;
    }
  }

  // ── Historical touch count ─────────────────────────────────────────────────
  // Mirrors Pine: for x = 1 to lookbackBars, check bar[x] (i.e. recent history)
  // We work on the full candles array: use the last `lookbackBars` bars.
  const lb = Math.min(lookbackBars, candles.length);
  const lookbackSlice = candles.slice(candles.length - lb);

  function countTouches(zone) {
    let count = 0;
    for (const c of lookbackSlice) {
      if (zone.side === "resistance") {
        if (c.high >= zone.bottom && c.high <= zone.top) count++;
      } else {
        if (c.low <= zone.top && c.low >= zone.bottom) count++;
      }
    }
    return count;
  }

  for (const z of resistanceZones) z.strong = countTouches(z) >= strongTouches;
  for (const z of supportZones) z.strong = countTouches(z) >= strongTouches;

  return { resistanceZones, supportZones };
}

// ─── Per-instance state ───────────────────────────────────────────────────────

const _instances = new Map();
const _idMap = new WeakMap();
let _idCounter = 0;

function _instId(inst) {
  if (!_idMap.has(inst.chart)) _idMap.set(inst.chart, ++_idCounter);
  return _idMap.get(inst.chart);
}

function _getInstance(chart) { return _instances.get(chart) ?? null; }

function _createInstance(chart, container, candleSeries) {
  const inst = {
    chart, container, series: candleSeries ?? null,
    canvas: null, ctx: null,
    resistanceZones: [], supportZones: [],
    rafId: null, rangeUnsub: null, resizeObs: null,
    isPanning: false, panClearId: null,
    zoneFingerprint: "",
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) { _instances.delete(inst.chart); }

// ─── Canvas management ───────────────────────────────────────────────────────

function _priceScaleWidth(inst) {
  try {
    const ps = inst.chart.priceScale("right");
    if (ps && typeof ps.width === "function") return ps.width();
  } catch (_) { }
  return 0;
}

function _syncSize(inst) {
  if (!inst.canvas || !inst.container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = inst.container.clientWidth, h = inst.container.clientHeight;
  inst.canvas.width = w * dpr; inst.canvas.height = h * dpr;
  inst.canvas.style.width = `${w}px`; inst.canvas.style.height = `${h}px`;
  if (inst.ctx) inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _ensureCanvas(inst) {
  if (inst.canvas && inst.container.contains(inst.canvas)) return;
  const cls = "__src __src_" + _instId(inst);
  const old = inst.container.querySelector(".__src_" + _instId(inst));
  if (old) try { inst.container.removeChild(old); } catch (_) { }
  inst.canvas = document.createElement("canvas");
  inst.canvas.className = cls;
  inst.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:4;";
  inst.container.appendChild(inst.canvas);
  inst.ctx = inst.canvas.getContext("2d");
  _syncSize(inst);
  inst.resizeObs = new ResizeObserver(() => { _syncSize(inst); _scheduleRedraw(inst); });
  inst.resizeObs.observe(inst.container);
}

function _removeCanvas(inst) {
  if (inst.resizeObs) { inst.resizeObs.disconnect(); inst.resizeObs = null; }
  if (inst.canvas) {
    try { inst.canvas.parentNode?.removeChild(inst.canvas); } catch (_) { }
    inst.canvas = null; inst.ctx = null;
  }
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);

  const hasZones = inst.resistanceZones.length + inst.supportZones.length > 0;
  if (!hasZones) return;

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ts = inst.chart.timeScale();

  /**
   * Convert a Unix-ms timestamp → x pixel.
   * lightweight-charts timeToCoordinate expects Unix seconds (integer).
   */
  function toX(timeMs) {
    try {
      const x = ts.timeToCoordinate(Math.floor(timeMs / 1000));
      return x ?? null;
    } catch (_) { return null; }
  }

  function toY(price) {
    try {
      const y = inst.series.priceToCoordinate(price);
      return y ?? null;
    } catch (_) { return null; }
  }

  inst.ctx.save();
  inst.ctx.beginPath();
  inst.ctx.rect(0, 0, plotW, ch);
  inst.ctx.clip();

  const allZones = [...inst.resistanceZones, ...inst.supportZones];

  for (const zone of allZones) {
    const isRes = zone.side === "resistance";

    // x: from zone start to right edge of chart
    const x0Raw = toX(zone.startTime);
    const x1 = plotW;                   // extend to right edge (mirrors Pine +500)
    const x0 = x0Raw != null ? Math.max(0, x0Raw) : 0;

    // y: top / bottom of the zone
    const yTop = toY(zone.top);
    const yBottom = toY(zone.bottom);

    if (yTop == null || yBottom == null) continue;

    const rectX = x0;
    const rectY = Math.min(yTop, yBottom);
    const rectW = x1 - x0;
    const rectH = Math.abs(yBottom - yTop);

    if (rectW <= 0 || rectH <= 0) continue;

    // Colors — match Pine exactly
    let fillColor, borderColor;
    if (zone.strong) {
      // Purple for strong historical zones
      fillColor = "rgba(162, 89, 255, 0.25)";   // color.new(color.purple, 70) ≈ 30% alpha
      borderColor = "rgba(162, 89, 255, 0.85)";
    } else if (isRes) {
      // Green for resistance
      fillColor = "rgba(0, 200, 83, 0.12)";      // color.new(color.green, 85) ≈ 15% alpha
      borderColor = "rgba(0, 200, 83, 0.75)";
    } else {
      // Red for support
      fillColor = "rgba(255, 69, 96, 0.12)";     // color.new(color.red, 85) ≈ 15% alpha
      borderColor = "rgba(255, 69, 96, 0.75)";
    }

    // Fill
    inst.ctx.fillStyle = fillColor;
    inst.ctx.fillRect(rectX, rectY, rectW, rectH);

    // Border — only top/bottom lines (left side), no right border (extends to infinity)
    inst.ctx.strokeStyle = borderColor;
    inst.ctx.lineWidth = 1;
    inst.ctx.beginPath();
    // Top edge
    inst.ctx.moveTo(rectX, rectY);
    inst.ctx.lineTo(x1, rectY);
    // Bottom edge
    inst.ctx.moveTo(rectX, rectY + rectH);
    inst.ctx.lineTo(x1, rectY + rectH);
    // Left edge (zone start bar)
    if (x0Raw != null && x0Raw >= 0) {
      inst.ctx.moveTo(rectX, rectY);
      inst.ctx.lineTo(rectX, rectY + rectH);
    }
    inst.ctx.stroke();
  }

  inst.ctx.restore();
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

function _scheduleRedraw(inst) {
  if (inst.rafId != null) return;
  inst.rafId = requestAnimationFrame(() => { inst.rafId = null; _redraw(inst); });
}

function _makeRangeHandler(inst) {
  return function () {
    inst.isPanning = true;
    if (inst.panClearId != null) clearTimeout(inst.panClearId);
    inst.panClearId = setTimeout(() => { inst.isPanning = false; inst.panClearId = null; }, 150);
    _scheduleRedraw(inst);
  };
}

// ─── Clear ───────────────────────────────────────────────────────────────────

function _clearOverlay(inst) {
  if (inst.rafId != null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
  if (inst.ctx && inst.canvas)
    inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createSRZonesIndicator(chart, container, candleSeries) {
  const existing = _getInstance(chart);
  if (existing) {
    _clearOverlay(existing);
    _removeCanvas(existing);
    _destroyInstance(existing);
  }
  _createInstance(chart, container, candleSeries);
}

export function updateSRZonesIndicator(
  candles, emaHighs, emaLows, chart,
  strongTouches = 3, lookbackBars = 300
) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !candles?.length) return;

  // Update series ref if it wasn't set at create time
  if (!inst.series && inst.chart) {
    // Try to get it from the wave lines if present — otherwise we set it externally
  }

  const { resistanceZones, supportZones } = calcSRZonesPure(
    candles, emaHighs, emaLows, strongTouches, lookbackBars
  );

  // Fingerprint to avoid unnecessary redraws on tick-only updates
  const fp = [
    ...resistanceZones.map((z) => `r:${z.startBarIndex}:${z.top.toFixed(2)}:${z.strong}`),
    ...supportZones.map((z) => `s:${z.startBarIndex}:${z.bottom.toFixed(2)}:${z.strong}`),
  ].join("|");

  if (fp === inst.zoneFingerprint) {
    _scheduleRedraw(inst);
    return;
  }

  inst.zoneFingerprint = fp;
  inst.resistanceZones = resistanceZones;
  inst.supportZones = supportZones;

  _clearOverlay(inst);

  if (!resistanceZones.length && !supportZones.length) return;

  _ensureCanvas(inst);

  if (!inst.rangeUnsub && inst.chart) {
    const handler = _makeRangeHandler(inst);
    inst.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => {
      try { inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch (_) { }
    };
  }

  _scheduleRedraw(inst);
}

/**
 * Set (or replace) the candle series reference so priceToCoordinate works.
 * Call this right after createSRZonesIndicator if you don't have the series yet.
 */
export function setSRZonesSeries(chart, candleSeries) {
  const inst = _getInstance(chart);
  if (inst) inst.series = candleSeries;
}

export function removeSRZonesIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;

  _clearOverlay(inst);
  inst.resistanceZones = [];
  inst.supportZones = [];
  inst.zoneFingerprint = "";
  if (inst.panClearId != null) { clearTimeout(inst.panClearId); inst.panClearId = null; }
  inst.isPanning = false;

  if (fullTeardown) {
    if (inst.rangeUnsub) { inst.rangeUnsub(); inst.rangeUnsub = null; }
    _removeCanvas(inst);
    _destroyInstance(inst);
  } else {
    if (inst.ctx && inst.canvas)
      inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  }
}