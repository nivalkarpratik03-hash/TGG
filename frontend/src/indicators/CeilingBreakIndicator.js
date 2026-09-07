/**
 * CeilingBreakIndicator.js
 *
 * Chart overlay for the "Ceiling Break & Retest" strategy — draws the
 * detected resistance ceiling, the breakout/retest zone band, and the
 * CEILING_BROKEN / RETEST / FAILED_RETEST / NO_RETEST / HIGHER_LOW event
 * markers, using the exact same detection engine the scanner runs
 * server-side (see indicators/ceilingBreakRetestEngine.js — a byte-for-byte
 * copy of backend/src/strategies/ceilingBreakRetest.js's
 * CeilingBreakRetestScanner, see that file's header for the one documented
 * deviation).
 *
 * Architecture: leans on T5Indicator.js's shape (calc-pure function that
 * drives a fresh copy of the shared engine + markers/bands, single canvas,
 * rAF-scheduled redraw) rather than EMA9PivotSRIndicator.js's heavier
 * table/tooltip machinery, since this indicator only needs to draw a line,
 * a zone band, and event pills — no on-chart data table. The low-level
 * canvas plumbing (DPR-aware resize sync, right-price-scale-aware
 * clipping, ResizeObserver-driven redraw) is the same pattern both of
 * those files already use.
 *
 *   - calcCeilingBreakPure(candles)                 → pure calc, no DOM,
 *                                                       replays the full
 *                                                       candle history
 *                                                       through
 *                                                       CeilingBreakRetestScanner
 *                                                       and returns
 *                                                       { markers, ceilingLines, zoneBands }.
 *   - createCeilingBreakIndicator(chart, container, candleSeries)
 *   - updateCeilingBreakIndicator(candles, chart)
 *   - removeCeilingBreakIndicator(fullTeardown, chart)
 *
 * NOTE: this file does not change how ceilings, breakouts, retests, or the
 * HIGHER_LOW entry signal are detected — all of that lives in
 * ceilingBreakRetestEngine.js (byte-identical to the backend). This file
 * only decides HOW to draw what the engine emits, including two purely
 * cosmetic groupings the engine's per-bar snapshot doesn't hand back
 * pre-packaged (documented at each site below):
 *   1. The pre-breakout "candidate ceiling" line — the engine exposes
 *      ceilingLevel/hasCeiling per bar but not where that specific cluster
 *      started, so consecutive idle bars sharing (approximately) the same
 *      ceilingLevel are grouped into one drawable segment here.
 *   2. The post-breakout active-ceiling line + retest zone band — the
 *      engine DOES give an explicit per-bar ceilLineX1/ceilLineX2/zoneHi/
 *      zoneLo, so these are grouped by contiguous run instead of
 *      recomputed, same "read the engine's own boundaries" approach
 *      T5Indicator.js's openBox tracking uses for p2Bar structure bands.
 */

import { CeilingBreakRetestScanner, DEFAULT_CONFIG } from "./ceilingBreakRetestEngine";

const MAX_MARKERS = 500;
const MAX_LINES = 300;
const MAX_BANDS = 300;

const na = (v) => v === undefined || v === null || Number.isNaN(v);

// ─── Event type → { label, category } map ──────────────────────────────────
// Every string here is copy-pasted verbatim from the emit(...) call sites
// in ceilingBreakRetestEngine.js's run() loop.
const EVENT_META = {
  CEILING_BROKEN: ["BREAK", "break"],
  RETEST: ["RETEST", "retest"],
  FAILED_RETEST: ["FAILED", "failed"],
  NO_RETEST: ["NO-RETEST", "noretest"],
  HIGHER_LOW: ["HL \u2713", "entry"],
};

// One color per event category, chosen to stay clear of the candle
// up/down colors (#00d97e / #ff4560, set in CandleChart.js), same
// per-category (not per-side) approach T5Indicator.js uses.
const COLOR_BY_CATEGORY = {
  break: "#ff9800",     // amber/orange — ceiling broken, watch begins
  retest: "#29b6f6",    // sky blue — pulled back into the zone, watching for higher low
  failed: "#ef5350",    // red — retest failed / ceiling gave way
  noretest: "#90a4ae",  // blue-gray — frictionless move, no retest ever came
  entry: "#00e676",     // bright green — HIGHER_LOW, the actionable entry signal
};

function _colorFor(m) {
  return COLOR_BY_CATEGORY[m.category] || "#c7d2fe";
}

// ─── Pure calc (no DOM) ─────────────────────────────────────────────────────
/**
 * Replays the full candle history through a fresh CeilingBreakRetestScanner
 * (same "brand-new instance per call, no carried state" purity the backend
 * scan() wrapper documents) and turns the event stream + per-bar snapshot
 * series into drawable markers/lines/bands.
 *
 * markers: [{ type, label, category, time, price, ceiling, reason, isEntrySignal }]
 * ceilingLines: [{ kind: 'candidate'|'active', level, fromTime, toTime }]
 *   'candidate' — a detected-but-not-yet-broken resistance cluster
 *   'active'    — the specific level a breakout locked in (watching/retested)
 * zoneBands: [{ hi, lo, fromTime, toTime }]
 *   The retest/fail zone drawn only while state !== 'idle' (mirrors the
 *   Pine script's shaded zone between zoneHi/zoneLo).
 */
export function calcCeilingBreakPure(candles) {
  if (!candles?.length) return { markers: [], ceilingLines: [], zoneBands: [] };

  const engine = new CeilingBreakRetestScanner(DEFAULT_CONFIG);
  const { events, series } = engine.run(candles);

  // ── markers ────────────────────────────────────────────────────────────
  const markers = [];
  for (const ev of events) {
    const meta = EVENT_META[ev.type];
    if (!meta) continue; // shouldn't happen — every emit() type is mapped above
    const [label, category] = meta;
    markers.push({
      type: ev.type,
      label,
      category,
      time: ev.time,
      price: ev.price,
      ceiling: ev.ceiling,
      reason: ev.reason,
      isEntrySignal: ev.type === "HIGHER_LOW",
    });
  }

  // ── candidate ceiling line (idle bars, hasCeiling true) ──────────────────
  // Grouped here, not in the engine — see file header note (1). Bars are
  // joined into the same segment while hasCeiling stays true AND the level
  // hasn't moved more than a hair (clustering can nudge ceilingLevel by a
  // fraction of a point as new pivots enter/age out of the lookback window;
  // treating that as "the same ceiling" avoids a flickery segment-per-bar
  // line for what a trader would read as one flat resistance level).
  const ceilingLines = [];
  let candOpen = null; // { level, fromIdx }
  const sameLevel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), 1e-9) < 0.001;

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (!s) continue;
    const candidateNow = s.state === "idle" && s.hasCeiling && !na(s.ceilingLevel);
    if (candidateNow) {
      if (candOpen && sameLevel(candOpen.level, s.ceilingLevel)) {
        candOpen.toIdx = i;
      } else {
        if (candOpen) ceilingLines.push({ kind: "candidate", level: candOpen.level, fromIdx: candOpen.fromIdx, toIdx: candOpen.toIdx });
        candOpen = { level: s.ceilingLevel, fromIdx: i, toIdx: i };
      }
    } else if (candOpen) {
      ceilingLines.push({ kind: "candidate", level: candOpen.level, fromIdx: candOpen.fromIdx, toIdx: candOpen.toIdx });
      candOpen = null;
    }
  }
  if (candOpen) ceilingLines.push({ kind: "candidate", level: candOpen.level, fromIdx: candOpen.fromIdx, toIdx: candOpen.toIdx });

  // ── active ceiling line + zone band (watching/retested episodes) ─────────
  // Uses the engine's OWN ceilLineX1/ceilLineX2/zoneHi/zoneLo per bar
  // directly (see file header note (2)) — grouped by contiguous run of the
  // same activeCeiling value rather than recomputed, since activeCeiling
  // is held constant by the engine for the whole watching/retested episode
  // once a breakout locks it in.
  const zoneBands = [];
  let activeOpen = null; // { level, fromIdx, toIdx, zoneHi, zoneLo }

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (!s) continue;
    const activeNow = s.state !== "idle" && !na(s.activeCeiling);
    if (activeNow) {
      if (activeOpen && sameLevel(activeOpen.level, s.activeCeiling)) {
        activeOpen.toIdx = i;
        activeOpen.zoneHi = s.zoneHi;
        activeOpen.zoneLo = s.zoneLo;
      } else {
        if (activeOpen) {
          ceilingLines.push({ kind: "active", level: activeOpen.level, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
          zoneBands.push({ hi: activeOpen.zoneHi, lo: activeOpen.zoneLo, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
        }
        activeOpen = { level: s.activeCeiling, fromIdx: !na(s.ceilLineX1) ? s.ceilLineX1 : i, toIdx: i, zoneHi: s.zoneHi, zoneLo: s.zoneLo };
      }
    } else if (activeOpen) {
      ceilingLines.push({ kind: "active", level: activeOpen.level, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
      zoneBands.push({ hi: activeOpen.zoneHi, lo: activeOpen.zoneLo, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
      activeOpen = null;
    }
  }
  if (activeOpen) {
    ceilingLines.push({ kind: "active", level: activeOpen.level, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
    zoneBands.push({ hi: activeOpen.zoneHi, lo: activeOpen.zoneLo, fromIdx: activeOpen.fromIdx, toIdx: activeOpen.toIdx });
  }

  // Resolve bar indices to times now, while `candles` is still in scope —
  // keeps calcCeilingBreakPure a plain function of candles, same separation
  // T5Indicator.js's calcT5Pure/updateT5Indicator split uses.
  const resolvedLines = ceilingLines
    .map((l) => ({ ...l, fromTime: candles[l.fromIdx]?.time, toTime: candles[l.toIdx]?.time }))
    .filter((l) => l.fromTime != null && l.toTime != null);
  const resolvedBands = zoneBands
    .map((b) => ({ ...b, fromTime: candles[b.fromIdx]?.time, toTime: candles[b.toIdx]?.time }))
    .filter((b) => b.fromTime != null && b.toTime != null && !na(b.hi) && !na(b.lo));

  return {
    markers: markers.slice(-MAX_MARKERS),
    ceilingLines: resolvedLines.slice(-MAX_LINES),
    zoneBands: resolvedBands.slice(-MAX_BANDS),
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

function _getInstance(chart) { return _instances.get(chart) ?? null; }

function _createInstance(chart, container, candleSeries) {
  const inst = {
    chart, container, series: candleSeries ?? null,
    canvas: null, ctx: null,
    markers: [], ceilingLines: [], zoneBands: [],
    rafId: null, rangeUnsub: null, crosshairUnsub: null, resizeObs: null,
    isPanning: false, panClearId: null, crosshairDebounceId: null,
    fingerprint: "",
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) { _instances.delete(inst.chart); }

// ─── Canvas helpers (same DPR/resize pattern as EMA9PivotSRIndicator.js /
//     T5Indicator.js) ────────────────────────────────────────────────────────

function _rrect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function _priceScaleWidth(inst) {
  if (!inst.chart) return 0;
  try {
    const ps = inst.chart.priceScale("right");
    if (ps && typeof ps.width === "function") return ps.width();
  } catch (_) { }
  return 0;
}

function _ensureCanvas(inst) {
  if (inst.canvas && inst.container.contains(inst.canvas)) return;
  const cls = "__cbrc __cbrc_" + _instId(inst);
  const old = inst.container.querySelector("." + cls.split(" ")[1]);
  if (old) try { inst.container.removeChild(old); } catch (_) { }
  inst.canvas = document.createElement("canvas");
  inst.canvas.className = cls;
  inst.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:6;";
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

// ─── Drawing ─────────────────────────────────────────────────────────────────

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);
  if (!inst.markers.length && !inst.ceilingLines.length && !inst.zoneBands.length) return;

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ts = inst.chart.timeScale();

  function toX(timeMs) {
    try {
      const x = ts.timeToCoordinate(Math.floor(timeMs / 1000));
      return x ?? null;
    } catch (_) { return null; }
  }
  function toY(price) {
    try { return inst.series.priceToCoordinate(price) ?? null; } catch (_) { return null; }
  }

  inst.ctx.save();
  inst.ctx.beginPath();
  inst.ctx.rect(0, 0, plotW, ch);
  inst.ctx.clip();

  // 1. Shaded zone band first, so the ceiling line + markers draw on top.
  for (const b of inst.zoneBands) {
    const x0Raw = toX(b.fromTime), x1Raw = toX(b.toTime);
    if (x0Raw == null && x1Raw == null) continue;
    const x0 = Math.max(0, x0Raw ?? 0);
    const x1 = Math.min(plotW, x1Raw ?? plotW);
    if (x1 <= x0) continue;
    const yHi = toY(b.hi), yLo = toY(b.lo);
    if (yHi == null || yLo == null) continue;
    const rectY = Math.min(yHi, yLo);
    const rectH = Math.max(Math.abs(yLo - yHi), 1);
    inst.ctx.fillStyle = "rgba(41,182,246,0.08)"; // sky-blue tint, matches 'retest' category color
    inst.ctx.fillRect(x0, rectY, x1 - x0, rectH);
    inst.ctx.strokeStyle = "rgba(41,182,246,0.35)";
    inst.ctx.lineWidth = 1;
    inst.ctx.setLineDash([3, 3]);
    inst.ctx.strokeRect(x0, rectY, x1 - x0, rectH);
    inst.ctx.setLineDash([]);
  }

  // 2. Ceiling lines — dashed/faint for a not-yet-broken candidate cluster,
  //    solid amber for the specific level a breakout locked in.
  for (const l of inst.ceilingLines) {
    const x0Raw = toX(l.fromTime), x1Raw = toX(l.toTime);
    if (x0Raw == null && x1Raw == null) continue;
    const x0 = Math.max(0, x0Raw ?? 0);
    const x1 = Math.min(plotW, x1Raw ?? plotW);
    if (x1 <= x0) continue;
    const y = toY(l.level);
    if (y == null) continue;

    inst.ctx.beginPath();
    if (l.kind === "candidate") {
      inst.ctx.strokeStyle = "rgba(255,255,255,0.35)";
      inst.ctx.lineWidth = 1.25;
      inst.ctx.setLineDash([5, 4]);
    } else {
      inst.ctx.strokeStyle = COLOR_BY_CATEGORY.break;
      inst.ctx.lineWidth = 1.75;
      inst.ctx.setLineDash([]);
    }
    inst.ctx.moveTo(x0, y);
    inst.ctx.lineTo(x1, y);
    inst.ctx.stroke();
    inst.ctx.setLineDash([]);
  }

  // 3. Event markers — pills, same visual language as T5Indicator.js's tag
  //    pills so the chart reads consistently across strategies.
  for (const m of inst.markers) {
    const x = toX(m.time);
    const y = toY(m.price);
    if (x == null || y == null) continue;
    if (x < -30 || x > plotW + 30) continue;

    const prominent = m.isEntrySignal;
    const color = _colorFor(m);

    inst.ctx.save();
    inst.ctx.font = (prominent ? "bold 13px" : "700 11px") + " 'JetBrains Mono',monospace";
    inst.ctx.textAlign = "center";
    inst.ctx.textBaseline = "middle";
    const tw = inst.ctx.measureText(m.label).width;
    const pad = 6, bw = tw + pad * 2, bh = prominent ? 22 : 18;
    const rawBx = x - bw / 2;
    const bx = Math.min(Math.max(rawBx, 2), plotW - bw - 2);
    // Break/entry markers read as "above the bar", retest/failed/no-retest
    // markers sit below — spatial cue only, matches the category, not a
    // short/long side (this strategy is resistance-only, no long/short split).
    const above = m.category === "break" || m.category === "entry";
    const by = above ? y - bh - 9 : y + 9;
    inst.ctx.globalAlpha = prominent ? 1 : 0.92;
    inst.ctx.fillStyle = "rgba(8,9,13,0.92)";
    _rrect(inst.ctx, bx, by, bw, bh, 4); inst.ctx.fill();
    inst.ctx.strokeStyle = color;
    inst.ctx.lineWidth = prominent ? 1.8 : 1.3;
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

function _makeCrosshairHandler(inst) {
  return function () {
    if (inst.isPanning) return;
    if (inst.crosshairDebounceId != null) return;
    inst.crosshairDebounceId = setTimeout(() => { inst.crosshairDebounceId = null; _scheduleRedraw(inst); }, 60);
  };
}

function _clearOverlay(inst) {
  if (inst.rafId != null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
  if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createCeilingBreakIndicator(chart, container, candleSeries) {
  const existing = _getInstance(chart);
  if (existing) {
    _clearOverlay(existing);
    _removeCanvas(existing);
    _destroyInstance(existing);
  }
  _createInstance(chart, container, candleSeries);
}

export function updateCeilingBreakIndicator(candles, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !candles?.length) return;

  const { markers, ceilingLines, zoneBands } = calcCeilingBreakPure(candles);

  const fp = markers.map((m) => `${m.type}:${m.time}`).join("|") + "##" +
    ceilingLines.map((l) => `${l.kind}:${l.fromTime}:${l.toTime}:${l.level?.toFixed?.(2)}`).join("|") + "##" +
    zoneBands.map((b) => `${b.fromTime}:${b.toTime}:${b.hi?.toFixed?.(2)}:${b.lo?.toFixed?.(2)}`).join("|");

  if (fp === inst.fingerprint) {
    _scheduleRedraw(inst);
    return;
  }
  inst.fingerprint = fp;
  inst.markers = markers;
  inst.ceilingLines = ceilingLines;
  inst.zoneBands = zoneBands;

  _clearOverlay(inst);
  if (!markers.length && !ceilingLines.length && !zoneBands.length) return;

  _ensureCanvas(inst);

  if (!inst.rangeUnsub && inst.chart) {
    const handler = _makeRangeHandler(inst);
    inst.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => {
      try { inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch (_) { }
    };
  }
  if (!inst.crosshairUnsub && inst.chart) {
    const handler = _makeCrosshairHandler(inst);
    inst.chart.subscribeCrosshairMove(handler);
    inst.crosshairUnsub = () => {
      try { inst.chart.unsubscribeCrosshairMove(handler); } catch (_) { }
    };
  }

  _scheduleRedraw(inst);
}

export function removeCeilingBreakIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;

  _clearOverlay(inst);
  inst.markers = []; inst.ceilingLines = []; inst.zoneBands = []; inst.fingerprint = "";
  if (inst.crosshairDebounceId != null) { clearTimeout(inst.crosshairDebounceId); inst.crosshairDebounceId = null; }
  if (inst.panClearId != null) { clearTimeout(inst.panClearId); inst.panClearId = null; }
  inst.isPanning = false;

  if (fullTeardown) {
    if (inst.rangeUnsub) { inst.rangeUnsub(); inst.rangeUnsub = null; }
    if (inst.crosshairUnsub) { inst.crosshairUnsub(); inst.crosshairUnsub = null; }
    _removeCanvas(inst);
    _destroyInstance(inst);
  } else {
    if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  }
}
