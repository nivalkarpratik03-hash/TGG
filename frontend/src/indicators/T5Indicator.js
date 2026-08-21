/**
 * T5Indicator.js
 *
 * Chart overlay for the "TG T5 (Double Top / Bottom)" strategy — draws the
 * same points (P1-P6), fire/flip/confirm tags, caution/NC checkpoints,
 * gate/expire/cancel/done bookkeeping marks, the morning-frame break note,
 * and structure bands that the Pine Script "TG T5 — Script A v16.30 BETA"
 * indicator draws, using the exact same detection engine the scanner runs
 * server-side (see indicators/tgT5Engine.js — an unmodified copy of
 * backend/src/strategies/tgT5.js's TgT5Engine).
 *
 * Architecture mirrors WavesIndicator.js / SRZonesIndicator.js exactly:
 *   - calcT5Pure(candles)              → pure calc, no DOM, replays the full
 *                                          candle history through TgT5Engine
 *                                          and returns { markers, bands }.
 *   - createT5Indicator(chart, container, candleSeries)
 *   - updateT5Indicator(candles, chart)
 *   - removeT5Indicator(fullTeardown, chart)
 *   - Canvas overlay redrawn on pan/zoom/resize via a single rAF, same
 *     pan-suppression / fingerprint-skip pattern as the other indicators —
 *     so it updates live when the symbol/timeframe/candles change, without
 *     touching the underlying T5 trading logic at all.
 *
 * TAG COVERAGE — every tag the engine can emit() is mapped below (audited
 * directly against every `emit(...)` call site in tgT5Engine.js — 38 unique
 * tags across both T5H and T5L). Nothing is silently dropped: even the
 * "bookkeeping" tags (done/expired/cancelled/gate/NC/MH-ML) get a small,
 * muted pill so the full Pine-script picture is on the chart.
 *
 * COLOR SYSTEM — colors are assigned per TAG CATEGORY (point / fire /
 * confirm / flip / caution / nc / gate / expired / cancelled / done /
 * frame), not per short/long side, and deliberately avoid the candle
 * up/down colors (#00d97e / #ff4560 in CandleChart.js) so tags never blend
 * into a candle body or wick. Side (short/long) still controls whether a
 * pill sits above or below its price, since that's a spatial cue, not a
 * color one.
 *
 * NOTE: this file does not change how T5H/T5L points, flips, or gates are
 * computed — all of that lives in tgT5Engine.js (byte-identical to the
 * backend). This file only decides HOW to draw what the engine emits.
 */

import { TgT5Engine } from "./tgT5Engine";

const MAX_MARKERS = 800;
const MAX_BANDS = 200;

// ─── Tag → { label, category } map ─────────────────────────────────────────
// Every string here is copy-pasted verbatim from tgT5Engine.js's emit(...)
// call sites (both the main addBar() pass and the intrabar early-warning
// helper, which reuses the same 4 flip tags provisionally). Label text is
// a short on-chart abbreviation; category drives the pill color.
const TAG_META = {
  // Point formation (P1/P2/P3/P5) — both sides
  T5H1: ["H1", "point"], T5H2: ["H2", "point"], T5H3: ["H3", "point"], T5H5: ["H5", "point"],
  T5L1: ["L1", "point"], T5L2: ["L2", "point"], T5L3: ["L3", "point"], T5L5: ["L5", "point"],

  // P4 fire (provisional trigger)
  "S T5H4": ["S4", "fire"], "L T5L4": ["L4", "fire"],

  // P6 confirm (the actionable signal)
  "S T5H6": ["S6", "confirm"], "L T5L6": ["L6", "confirm"],

  // Flips (all actionable reversal/disarm signals)
  "S T5H5 FLIP": ["S5\u26a9", "flip"],
  "S T5H2 FLIP": ["S2\u26a9", "flip"],
  "L T5H FLIP (trap)": ["L\u26a9TRAP", "flip"],
  "S T5H3 FLIP": ["S3\u26a9", "flip"],
  "L T5L5 FLIP": ["L5\u26a9", "flip"],
  "L T5L2 FLIP": ["L2\u26a9", "flip"],
  "S T5L FLIP (trap)": ["S\u26a9TRAP", "flip"],
  "L T5L3 FLIP": ["L3\u26a9", "flip"],

  // Caution checkpoints
  "S/L CAUT T5H3 FLIP": ["CAUT", "caution"],
  "S/L CAUT T5L3 FLIP": ["CAUT", "caution"],

  // NC (no-confirm / dummy) checkpoints
  T5H3NC: ["NC", "nc"], T5H6NC: ["NC", "nc"], T5H5NC: ["NC", "nc"],
  T5L3NC: ["NC", "nc"], T5L6NC: ["NC", "nc"], T5L5NC: ["NC", "nc"],

  // Gate re-arm / suppression
  "T5H gate 2 \u2192 re-armed": ["G2", "gate"],
  "T5L gate 2 \u2192 re-armed": ["G2", "gate"],
  "L T5L4 \u2715 gate 3": ["G3\u2715", "gate"],

  // Expired (pending window ran out)
  "T5H \u2715 expired": ["EXP", "expired"],
  "T5L \u2715 expired": ["EXP", "expired"],

  // Cancelled (P4 retracted by an intrabar trap flip)
  "\u2715 S T5H4 CANCELLED": ["CNCL", "cancelled"],
  "\u2715 L T5L4 CANCELLED": ["CNCL", "cancelled"],

  // Done (structure resolved/disarmed bookkeeping)
  "T5H \u2713 done": ["DONE", "done"],
  "T5L \u2713 done": ["DONE", "done"],

  // Morning-frame break (MH/ML) — observation only
  "MH / ML broken": ["MH/ML", "frame"],
};

// Categories drawn bigger/bolder — the structurally important marks.
const PROMINENT_CATEGORIES = new Set(["point", "fire", "confirm", "flip"]);

const na = (v) => v === undefined || v === null || Number.isNaN(v);

// ─── Pure calc (no DOM) ────────────────────────────────────────────────────

/**
 * Replays the full candle history through a fresh TgT5Engine (same
 * "pure function of candles" contract the scanner's scan() uses — nothing
 * cached/carried between calls) and turns the event stream + per-bar state
 * into drawable markers + structure bands.
 *
 * markers: [{ tag, label, category, side, time, price, actionable }]
 *   category: 'point'|'fire'|'confirm'|'flip'|'caution'|'nc'|'gate'|
 *             'expired'|'cancelled'|'done'|'frame'
 *   side: 'short' | 'long' | null
 *
 * bands: [{ side: 'T5H'|'T5L', top, bottom, fromBar, toBar }]
 *   One band per armed point-2 structure (from the bar it armed to the bar
 *   it was re-anchored/resolved/is still live), mirroring the Pine script's
 *   "structure bands (p2/p3/p4)" display option.
 */
export function calcT5Pure(candles) {
  if (!candles?.length) return { markers: [], bands: [] };

  const engine = new TgT5Engine({});
  const markers = [];
  const bands = [];
  const openBox = { T5H: null, T5L: null };
  const prevP2Bar = { T5H: null, T5L: null };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let events, state;
    try {
      ({ events, state } = engine.addBar(c));
    } catch (_) {
      continue; // malformed candle — skip, never let a bad bar kill the overlay
    }

    for (const side of ["T5H", "T5L"]) {
      const slice = side === "T5H" ? state.t5h : state.t5l;
      // The engine's p2Bar/p2Hi/p2Lo fields are NOT reset to na when a
      // structure resolves back to stage 0 — they simply hold their last
      // value forever (see tgT5Engine.js getState()/addBar()). So "is there
      // a live point-2 band" must be read from `stage` (only meaningful
      // while armed, stages 2-6), never inferred from p2Bar alone — treating
      // a frozen p2Bar as "still open" would silently reopen a stale box on
      // every following bar the moment its cached identity is cleared.
      const active = slice.stage >= 2 && slice.stage <= 6;
      const p2Bar = active ? slice.p2Bar : null;

      if (active && p2Bar != null && p2Bar !== prevP2Bar[side]) {
        // New arm or re-anchor (gate-2 trail) — close any previous box, open a new one.
        if (openBox[side]) { bands.push(openBox[side]); }
        openBox[side] = { side, top: slice.p2Hi, bottom: slice.p2Lo, fromBar: p2Bar, toBar: i };
        prevP2Bar[side] = p2Bar;
      } else if (active && openBox[side]) {
        openBox[side].toBar = i;
        // A same-box ratchet (point-2 trailing without a full re-anchor) can
        // still move p2Hi/p2Lo — keep the box synced to the latest level.
        openBox[side].top = slice.p2Hi;
        openBox[side].bottom = slice.p2Lo;
      }
      if (!active && openBox[side]) {
        bands.push(openBox[side]);
        openBox[side] = null;
        prevP2Bar[side] = null;
      }
    }

    for (const ev of events) {
      const meta = TAG_META[ev.tag];
      if (!meta) continue; // shouldn't happen — every emit() tag is mapped above
      const [label, category] = meta;

      let price = ev.price;
      if (na(price)) {
        // No explicit price on this tag (most flips/NC/caution/gate/expired/
        // cancelled/done/frame) — anchor it to the extreme of its own bar,
        // on the side that makes sense for a short/long tag, or the close
        // for neutral context tags.
        const bar = candles[ev.barIndex] ?? c;
        price = ev.side === "short" ? bar.high : ev.side === "long" ? bar.low : bar.close;
      }

      markers.push({
        tag: ev.tag,
        label,
        category,
        side: ev.side,
        time: ev.time,
        price,
        actionable: !!ev.actionable,
      });
    }
  }
  if (openBox.T5H) bands.push(openBox.T5H);
  if (openBox.T5L) bands.push(openBox.T5L);

  return {
    markers: markers.slice(-MAX_MARKERS),
    bands: bands.slice(-MAX_BANDS),
  };
}

// ─── Per-instance state ────────────────────────────────────────────────────

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
    markers: [], bands: [],
    rafId: null, rangeUnsub: null, crosshairUnsub: null, resizeObs: null,
    isPanning: false, panClearId: null, crosshairDebounceId: null,
    fingerprint: "",
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) { _instances.delete(inst.chart); }

// ─── Canvas helpers ────────────────────────────────────────────────────────

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
  const cls = "__t5c __t5c_" + _instId(inst);
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

// ─── Styling ────────────────────────────────────────────────────────────────

// One color per TAG CATEGORY (not per side) — chosen to stay well clear of
// the candle up/down colors (#00d97e green / #ff4560 red-pink, set in
// CandleChart.js) so a tag pill never reads as "part of" a candle. Each
// category also gets its own distinct hue from the others so the different
// kinds of T5 tags are easy to tell apart at a glance, exactly like the
// Pine script's per-tag-type coloring.
const COLOR_BY_CATEGORY = {
  point: "#ffb300",     // amber/gold — P1/P2/P3/P5 forming
  fire: "#ff6d00",      // deep orange — P4 provisional trigger
  confirm: "#2979ff",   // electric blue — P6 confirmed signal (most important)
  flip: "#7c4dff",      // violet — reversal / disarm flips
  caution: "#ffd600",   // yellow — caution checkpoint
  nc: "#90a4ae",        // blue-gray — no-confirm / dummy checkpoint
  gate: "#00bcd4",      // cyan/teal — gate re-arm / suppression
  expired: "#8d6e63",   // muted brown — pending window expired
  cancelled: "#ec407a", // magenta/pink — P4 retracted
  done: "#26c6da",      // light cyan — structure resolved bookkeeping
  frame: "#b3e5fc",     // pale ice-blue — morning-frame (MH/ML) break
};

function _colorFor(m) {
  return COLOR_BY_CATEGORY[m.category] || "#c7d2fe";
}

function _bandColors(side) {
  return side === "T5H"
    ? { fill: "rgba(255,69,96,0.07)", border: "rgba(255,69,96,0.55)" }
    : { fill: "rgba(0,217,126,0.07)", border: "rgba(0,217,126,0.55)" };
}

// ─── Drawing ────────────────────────────────────────────────────────────────

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);
  if (!inst.markers.length && !inst.bands.length) return;

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

  // Structure bands first, so point/flip pills draw on top of them.
  for (const b of inst.bands) {
    const x0Raw = toX(b.fromTime);
    const x1Raw = toX(b.toTime);
    if (x0Raw == null && x1Raw == null) continue;
    const x0 = Math.max(0, x0Raw ?? 0);
    const x1 = Math.min(plotW, x1Raw ?? plotW);
    if (x1 <= x0) continue;
    const yTop = toY(b.top), yBottom = toY(b.bottom);
    if (yTop == null || yBottom == null) continue;
    const { fill, border } = _bandColors(b.side);
    const rectY = Math.min(yTop, yBottom);
    const rectH = Math.max(Math.abs(yBottom - yTop), 1);
    inst.ctx.fillStyle = fill;
    inst.ctx.fillRect(x0, rectY, x1 - x0, rectH);
    inst.ctx.strokeStyle = border;
    inst.ctx.lineWidth = 1;
    inst.ctx.strokeRect(x0, rectY, x1 - x0, rectH);
  }

  // Point/fire/confirm/flip/caution/nc/gate/expired/cancelled/done/frame pills.
  for (const m of inst.markers) {
    const x = toX(m.time);
    const y = toY(m.price);
    if (x == null || y == null) continue;
    if (x < -30 || x > plotW + 30) continue;

    const isAbove = m.side === "short";
    const prominent = PROMINENT_CATEGORIES.has(m.category) || m.actionable;
    const color = _colorFor(m);

    inst.ctx.save();
    // Bigger, clearly-readable text — prominent (structural) tags read as
    // the primary signal, context tags stay a step smaller but are still
    // legible (previous version used 9-11px, which was too small to read
    // at normal zoom levels).
    inst.ctx.font = (prominent ? "bold 14px" : "700 12px") + " 'JetBrains Mono',monospace";
    inst.ctx.textAlign = "center";
    inst.ctx.textBaseline = "middle";
    const tw = inst.ctx.measureText(m.label).width;
    const pad = 6, bw = tw + pad * 2, bh = prominent ? 22 : 18;
    const rawBx = x - bw / 2;
    const bx = Math.min(Math.max(rawBx, 2), plotW - bw - 2);
    const by = isAbove ? y - bh - 9 : y + 9;
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

// ─── Scheduling ─────────────────────────────────────────────────────────────

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

// ─── Public API ─────────────────────────────────────────────────────────────

export function createT5Indicator(chart, container, candleSeries) {
  const existing = _getInstance(chart);
  if (existing) {
    _clearOverlay(existing);
    _removeCanvas(existing);
    _destroyInstance(existing);
  }
  _createInstance(chart, container, candleSeries);
}

export function updateT5Indicator(candles, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !candles?.length) return;

  const { markers, bands } = calcT5Pure(candles);
  // Bands are stored with bar indices from the calc pass — resolve them to
  // this candle array's times here (kept separate from calcT5Pure so the
  // pure calc stays a plain function of candles, no chart/time coupling).
  const resolvedBands = bands
    .map((b) => ({
      ...b,
      fromTime: candles[b.fromBar]?.time,
      toTime: candles[b.toBar]?.time,
    }))
    .filter((b) => b.fromTime != null && b.toTime != null);

  const fp = markers.map((m) => `${m.tag}:${m.time}`).join("|") + "##" +
    resolvedBands.map((b) => `${b.side}:${b.fromBar}:${b.toBar}:${b.top?.toFixed?.(2)}`).join("|");

  if (fp === inst.fingerprint) {
    _scheduleRedraw(inst);
    return;
  }
  inst.fingerprint = fp;
  inst.markers = markers;
  inst.bands = resolvedBands;

  _clearOverlay(inst);
  if (!markers.length && !resolvedBands.length) return;

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

export function removeT5Indicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;

  _clearOverlay(inst);
  inst.markers = []; inst.bands = []; inst.fingerprint = "";
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