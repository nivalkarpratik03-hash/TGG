/**
 * PinakaIndicator.js
 * ─────────────────────────────────────────────────────────────────────────
 * Chart overlay for PINAKA SPEC 3 — draws the yearly VWAP band + EMA9-high
 * /EMA9-low reference lines, and the A1 / A2 / B / B2 signal pills (plus
 * the grey A1✕/A2✕ reference-only marks), using the SAME detection engine
 * the scanner runs server-side.
 *
 * There is only ONE copy of the A1/A2/B/B2 state machine in this project:
 * frontend/src/strategies/pinakaEngine.js. This file imports it directly
 * (not a duplicate copy), and backend/src/strategies/pinaka.js requires
 * that exact same file too (see that file's header for how a backend
 * `require` reaches into frontend/src). Nothing in this file re-implements
 * any detection logic — this file only decides HOW to draw what the
 * engine returns.
 *
 * Architecture mirrors CeilingBreakIndicator.js / T5Indicator.js:
 *   - calcPinakaPure(candles, options)   → pure calc, no DOM, replays the
 *                                           full candle history through
 *                                           PinakaDetectors and returns
 *                                           { markers, engineSeries }.
 *   - createPinakaIndicator(chart, container, candleSeries)
 *   - updatePinakaIndicator(candles, chart)
 *   - removePinakaIndicator(fullTeardown, chart)
 * ─────────────────────────────────────────────────────────────────────────
 */

import { PinakaDetectors } from "../strategies/pinakaEngine";

const MAX_MARKERS = 500;
const MAX_POINTS = 3000; // engine line points (VWAP band + EMA9 pair)

const na = (v) => v === undefined || v === null || Number.isNaN(v);

// Signal type -> [label, category]. Every type the engine can emit must
// be mapped here or it's silently dropped when drawing.
const SIGNAL_META = {
  A1: ["A1", "a1"],
  A1x: ["A1\u2715", "ref"],
  A2: ["A2", "a2"],
  A2x: ["A2\u2715", "ref"],
  B: ["B", "b"],
  B2: ["B2", "b2"],
};

// One color per category — matches the Pine script's own label colors
// (green/blue/red/maroon/grey) and stays clear of the candle up/down
// colors CandleChart.js already uses.
const COLOR_BY_CATEGORY = {
  a1: "#00c853",   // green  — A1 long
  a2: "#2979ff",   // blue   — A2 long
  b: "#ff1744",    // red    — B short
  b2: "#8d1a1a",   // maroon — B2 short
  ref: "#9e9e9e",  // grey   — A1✕ / A2✕ reference-only, not a trade
};

function _colorFor(m) {
  return COLOR_BY_CATEGORY[m.category] || "#c7d2fe";
}

// ─── Pure calc (no DOM) ─────────────────────────────────────────────────────
/**
 * Replays the full candle history through a fresh PinakaDetectors
 * instance (brand-new per call, no carried state — same purity contract
 * every other strategy/indicator in this project follows) and turns the
 * signal stream + per-bar engine series into drawable markers/lines.
 *
 * Returns:
 *   markers:      [{ type, label, category, time, price, detail, reason }]
 *   engineSeries: [{ time, bandUp, bandDn, emaHigh, emaLow }] (one per bar)
 */
export function calcPinakaPure(candles, options) {
  if (!candles?.length) return { markers: [], engineSeries: [] };

  const engine = new PinakaDetectors(options || {});
  const { signals, series } = engine.run(candles);

  const markers = [];
  for (const sig of signals) {
    const meta = SIGNAL_META[sig.type];
    if (!meta) continue; // shouldn't happen — every emitted type is mapped above
    const [label, category] = meta;
    markers.push({
      type: sig.type,
      label,
      category,
      time: sig.time,
      price: sig.close,
      detail: sig.detail,
      reason: sig.reason || null,
    });
  }

  const engineSeries = series
    .map((s, i) => ({
      time: candles[i]?.time,
      bandUp: s.bandUp,
      bandDn: s.bandDn,
      emaHigh: s.emaHigh,
      emaLow: s.emaLow,
    }))
    .filter((s) => s.time != null);

  return {
    markers: markers.slice(-MAX_MARKERS),
    engineSeries: engineSeries.slice(-MAX_POINTS),
  };
}

// ─── Per-instance state ─────────────────────────────────────────────────────

const _instances = new Map();
const _idMap = new WeakMap();
let _idCounter = 0;

function _instId(inst) {
  if (!_idMap.has(inst.chart)) _idMap.set(inst.chart, ++_idCounter);
  return _idMap.get(inst.chart);
}

function _getInstance(chart) {
  return _instances.get(chart) ?? null;
}

function _createInstance(chart, container, candleSeries) {
  const inst = {
    chart,
    container,
    series: candleSeries ?? null,
    canvas: null,
    ctx: null,
    markers: [],
    engineSeries: [],
    rafId: null,
    rangeUnsub: null,
    crosshairUnsub: null,
    resizeObs: null,
    isPanning: false,
    panClearId: null,
    crosshairDebounceId: null,
    fingerprint: "",
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) {
  _instances.delete(inst.chart);
}

// ─── Canvas helpers (same DPR/resize pattern as CeilingBreakIndicator.js /
//     T5Indicator.js) ────────────────────────────────────────────────────────

function _rrect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function _priceScaleWidth(inst) {
  if (!inst.chart) return 0;
  try {
    const ps = inst.chart.priceScale("right");
    if (ps && typeof ps.width === "function") return ps.width();
  } catch (_) {
    /* noop */
  }
  return 0;
}

function _ensureCanvas(inst) {
  if (inst.canvas && inst.container.contains(inst.canvas)) return;
  const cls = "__pinaka_" + _instId(inst);
  const old = inst.container.querySelector("." + cls);
  if (old) {
    try {
      inst.container.removeChild(old);
    } catch (_) {
      /* noop */
    }
  }
  inst.canvas = document.createElement("canvas");
  inst.canvas.className = cls;
  inst.canvas.style.cssText =
    "position:absolute;top:0;left:0;pointer-events:none;z-index:6;";
  inst.container.appendChild(inst.canvas);
  inst.ctx = inst.canvas.getContext("2d");
  _syncSize(inst);
  inst.resizeObs = new ResizeObserver(() => {
    _syncSize(inst);
    _scheduleRedraw(inst);
  });
  inst.resizeObs.observe(inst.container);
}

function _syncSize(inst) {
  if (!inst.canvas || !inst.container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = inst.container.clientWidth;
  const h = inst.container.clientHeight;
  inst.canvas.width = w * dpr;
  inst.canvas.height = h * dpr;
  inst.canvas.style.width = `${w}px`;
  inst.canvas.style.height = `${h}px`;
  if (inst.ctx) inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _removeCanvas(inst) {
  if (inst.resizeObs) {
    inst.resizeObs.disconnect();
    inst.resizeObs = null;
  }
  if (inst.canvas) {
    try {
      inst.canvas.parentNode?.removeChild(inst.canvas);
    } catch (_) {
      /* noop */
    }
    inst.canvas = null;
    inst.ctx = null;
  }
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function _drawLine(inst, pts, key, toY, color, width) {
  inst.ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (na(p[key])) {
      started = false;
      continue;
    }
    const y = toY(p[key]);
    if (y == null) {
      started = false;
      continue;
    }
    if (!started) {
      inst.ctx.moveTo(p.x, y);
      started = true;
    } else {
      inst.ctx.lineTo(p.x, y);
    }
  }
  inst.ctx.strokeStyle = color;
  inst.ctx.lineWidth = width;
  inst.ctx.stroke();
}

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth;
  const ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);
  if (!inst.markers.length && !inst.engineSeries.length) return;

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ts = inst.chart.timeScale();

  function toX(timeMs) {
    try {
      const x = ts.timeToCoordinate(Math.floor(timeMs / 1000));
      return x ?? null;
    } catch (_) {
      return null;
    }
  }
  function toY(price) {
    try {
      return inst.series.priceToCoordinate(price) ?? null;
    } catch (_) {
      return null;
    }
  }

  inst.ctx.save();
  inst.ctx.beginPath();
  inst.ctx.rect(0, 0, plotW, ch);
  inst.ctx.clip();

  // 1. VWAP band fill + EMA9 high/low lines — the engine's own reference
  //    lines, same look as the Pine script's Module 6 plots.
  const pts = inst.engineSeries
    .map((s) => ({ x: toX(s.time), ...s }))
    .filter((p) => p.x != null);

  if (pts.length > 1) {
    inst.ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (na(p.bandUp)) {
        started = false;
        continue;
      }
      const y = toY(p.bandUp);
      if (y == null) {
        started = false;
        continue;
      }
      if (!started) {
        inst.ctx.moveTo(p.x, y);
        started = true;
      } else {
        inst.ctx.lineTo(p.x, y);
      }
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      if (na(p.bandDn)) continue;
      const y = toY(p.bandDn);
      if (y == null) continue;
      inst.ctx.lineTo(p.x, y);
    }
    inst.ctx.closePath();
    inst.ctx.fillStyle = "rgba(0,150,136,0.06)";
    inst.ctx.fill();

    _drawLine(inst, pts, "bandUp", toY, "#009688", 1.5);
    _drawLine(inst, pts, "bandDn", toY, "#009688", 1.5);
    _drawLine(inst, pts, "emaHigh", toY, "#ff9800", 1.5);
    _drawLine(inst, pts, "emaLow", toY, "#f44336", 1.5);
  }

  // 2. Signal pills — same visual language as CeilingBreakIndicator.js /
  //    T5Indicator.js so the chart reads consistently across strategies.
  for (const m of inst.markers) {
    const x = toX(m.time);
    const y = toY(m.price);
    if (x == null || y == null) continue;
    if (x < -30 || x > plotW + 30) continue;

    const isRef = m.category === "ref";
    const color = _colorFor(m);
    const above = m.type === "B" || m.type === "B2"; // shorts sit above the bar

    inst.ctx.save();
    inst.ctx.font = (isRef ? "700 10px" : "bold 12px") + " 'JetBrains Mono',monospace";
    inst.ctx.textAlign = "center";
    inst.ctx.textBaseline = "middle";
    const tw = inst.ctx.measureText(m.label).width;
    const pad = 6;
    const bw = tw + pad * 2;
    const bh = isRef ? 16 : 20;
    const rawBx = x - bw / 2;
    const bx = Math.min(Math.max(rawBx, 2), plotW - bw - 2);
    const by = above ? y - bh - 9 : y + 9;
    inst.ctx.globalAlpha = isRef ? 0.75 : 1;
    inst.ctx.fillStyle = "rgba(8,9,13,0.92)";
    _rrect(inst.ctx, bx, by, bw, bh, 4);
    inst.ctx.fill();
    inst.ctx.strokeStyle = color;
    inst.ctx.lineWidth = isRef ? 1 : 1.6;
    inst.ctx.stroke();
    inst.ctx.fillStyle = color;
    inst.ctx.fillText(m.label, bx + bw / 2, by + bh / 2 + 0.5);
    inst.ctx.restore();
  }

  inst.ctx.restore();
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

function _scheduleRedraw(inst) {
  if (inst.rafId != null) return;
  inst.rafId = requestAnimationFrame(() => {
    inst.rafId = null;
    _redraw(inst);
  });
}

function _makeRangeHandler(inst) {
  return function () {
    inst.isPanning = true;
    if (inst.panClearId != null) clearTimeout(inst.panClearId);
    inst.panClearId = setTimeout(() => {
      inst.isPanning = false;
      inst.panClearId = null;
    }, 150);
    _scheduleRedraw(inst);
  };
}

function _makeCrosshairHandler(inst) {
  return function () {
    if (inst.isPanning) return;
    if (inst.crosshairDebounceId != null) return;
    inst.crosshairDebounceId = setTimeout(() => {
      inst.crosshairDebounceId = null;
      _scheduleRedraw(inst);
    }, 60);
  };
}

function _clearOverlay(inst) {
  if (inst.rafId != null) {
    cancelAnimationFrame(inst.rafId);
    inst.rafId = null;
  }
  if (inst.ctx && inst.canvas) {
    inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createPinakaIndicator(chart, container, candleSeries) {
  const existing = _getInstance(chart);
  if (existing) {
    _clearOverlay(existing);
    _removeCanvas(existing);
    _destroyInstance(existing);
  }
  _createInstance(chart, container, candleSeries);
}

export function updatePinakaIndicator(candles, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !candles?.length) return;

  const { markers, engineSeries } = calcPinakaPure(candles);

  const fp = markers.map((m) => `${m.type}:${m.time}`).join("|") + "##" + engineSeries.length;
  if (fp === inst.fingerprint) {
    _scheduleRedraw(inst);
    return;
  }
  inst.fingerprint = fp;
  inst.markers = markers;
  inst.engineSeries = engineSeries;

  _clearOverlay(inst);
  if (!markers.length && !engineSeries.length) return;

  _ensureCanvas(inst);

  if (!inst.rangeUnsub && inst.chart) {
    const handler = _makeRangeHandler(inst);
    inst.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => {
      try {
        inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      } catch (_) {
        /* noop */
      }
    };
  }
  if (!inst.crosshairUnsub && inst.chart) {
    const handler = _makeCrosshairHandler(inst);
    inst.chart.subscribeCrosshairMove(handler);
    inst.crosshairUnsub = () => {
      try {
        inst.chart.unsubscribeCrosshairMove(handler);
      } catch (_) {
        /* noop */
      }
    };
  }

  _scheduleRedraw(inst);
}

export function removePinakaIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;

  _clearOverlay(inst);
  inst.markers = [];
  inst.engineSeries = [];
  inst.fingerprint = "";
  if (inst.crosshairDebounceId != null) {
    clearTimeout(inst.crosshairDebounceId);
    inst.crosshairDebounceId = null;
  }
  if (inst.panClearId != null) {
    clearTimeout(inst.panClearId);
    inst.panClearId = null;
  }
  inst.isPanning = false;

  if (fullTeardown) {
    if (inst.rangeUnsub) {
      inst.rangeUnsub();
      inst.rangeUnsub = null;
    }
    if (inst.crosshairUnsub) {
      inst.crosshairUnsub();
      inst.crosshairUnsub = null;
    }
    _removeCanvas(inst);
    _destroyInstance(inst);
  } else if (inst.ctx && inst.canvas) {
    inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  }
}