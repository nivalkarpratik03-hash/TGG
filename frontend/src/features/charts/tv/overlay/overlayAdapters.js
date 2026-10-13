// frontend/src/features/charts/tv/overlay/overlayAdapters.js
// ═══════════════════════════════════════════════════════════════════════════
// Strategy adapters for TradingView Advanced Charts.
//
// Each adapter takes the /api/chart payload and returns a flat list of
// NORMALIZED SHAPES. It reuses the existing pure calc functions from
// frontend/src/indicators/*, so strategy logic is NOT duplicated or changed.
// Only the drawing target changes (Advanced Charts drawing API instead of
// the Lightweight Charts canvas overlays).
//
// All times are the candle times exactly as the backend sends them (ms).
// The renderer converts them to the chart's time format.
//
// Normalized shapes:
//   { t: "box",  from, to, top, bottom, color, fill, width }
//   { t: "hline", from, to|null, price, color, width, style, label }   to=null -> ray to the right
//   { t: "seg",  from, p1, to, p2, color, width, style }
//   { t: "poly", points: [{ time, price }], color, width }
//   { t: "mark", time, price, dir: "up"|"down"|"none", text, color }
// ═══════════════════════════════════════════════════════════════════════════
import { calcConsolidationZonesPure } from "../../../../indicators/ConsolidationIndicator";
import { calcCeilingBreakPure } from "../../../../indicators/CeilingBreakIndicator";
import { calcT5Pure } from "../../../../indicators/T5Indicator";
import { calcPinakaPure } from "../../../../indicators/PinakaIndicator";
import { calcEMA9PivotSRPure } from "../../../../indicators/EMA9PivotSRIndicator";
import { calcSRZonesPure } from "../../../../indicators/SRZonesIndicator";
import { updateWavesIndicatorPure } from "../../../../indicators/WavesIndicator";
import { INDICATOR_REGISTRY } from "../../../../indicators/indicatorRegistry";

// ─── helpers ────────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const lastN = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);

function hexToRgba(hex, alpha) {
  const h = String(hex || "#888888").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(136,136,136,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const timeAt = (candles, i) => {
  const k = Math.max(0, Math.min(candles.length - 1, Number.isFinite(i) ? i : 0));
  return candles[k].time;
};

const C = {
  up: "#26a69a",
  down: "#ef5350",
  neutral: "#9098a8",
  amber: "#ffa726",
  blue: "#29b6f6",
  purple: "#a259ff",
};

// ─── bubble (NH / NL / BC signals from the backend) ─────────────────────────
function bubble(p) {
  const out = [];
  for (const s of lastN(p.signals, 200)) {
    if (!isNum(s.price) || !isNum(s.time)) continue;
    if (s.type === "NH") out.push({ t: "mark", time: s.time, price: s.price, dir: "down", text: "NH", color: "#3d84ff" });
    else if (s.type === "NL") out.push({ t: "mark", time: s.time, price: s.price, dir: "up", text: "NL", color: "#3d84ff" });
    else if (s.type === "BC_HIGH") out.push({ t: "mark", time: s.time, price: s.price, dir: "down", text: "BC", color: C.neutral });
    else if (s.type === "BC_LOW") out.push({ t: "mark", time: s.time, price: s.price, dir: "up", text: "BC", color: C.neutral });
  }
  return out;
}

// ─── waves (pivot-to-pivot legs) ────────────────────────────────────────────
function waves(p) {
  const { segments } = updateWavesIndicatorPure(p.candles, p.emaHighs, p.emaLows);
  const out = [];
  for (const s of lastN(segments, 120)) {
    if (![s.fromTime, s.toTime, s.fromPrice, s.toPrice].every(isNum)) continue;
    out.push({ t: "seg", from: s.fromTime, p1: s.fromPrice, to: s.toTime, p2: s.toPrice, color: "#f5a623", width: 2, style: "solid" });
  }
  return out;
}

// ─── consolidation zones ────────────────────────────────────────────────────
function consolidation(p, opts) {
  const gap = isNum(opts?.bubbleGap) ? opts.bubbleGap : 4;
  const { zones } = calcConsolidationZonesPure(p.candles, p.emaHighs, p.emaLows, gap);
  const lastT = p.candles[p.candles.length - 1].time;
  const out = [];
  for (const z of lastN(zones, 50)) {
    if (![z.startTime, z.top, z.bottom].every(isNum)) continue;
    const col = z.status === "up" ? C.up : z.status === "down" ? C.down : C.purple;
    out.push({
      t: "box", from: z.startTime, to: isNum(z.endTime) ? z.endTime : lastT,
      top: Math.max(z.top, z.bottom), bottom: Math.min(z.top, z.bottom),
      color: col, fill: hexToRgba(col, z.status === "active" ? 0.16 : 0.10), width: 1,
    });
  }
  return out;
}

// ─── SR zones (EMA-touch support / resistance) ──────────────────────────────
function srZones(p, opts) {
  const strong = isNum(opts?.strongTouches) ? opts.strongTouches : 3;
  const look = isNum(opts?.lookbackBars) ? opts.lookbackBars : 300;
  const { resistanceZones, supportZones } = calcSRZonesPure(p.candles, p.emaHighs, p.emaLows, strong, look);
  const lastT = p.candles[p.candles.length - 1].time;
  const out = [];
  const push = (z, col) => {
    if (z.broken || ![z.startTime, z.top, z.bottom].every(isNum)) return;
    out.push({
      t: "box", from: z.startTime, to: lastT,
      top: Math.max(z.top, z.bottom), bottom: Math.min(z.top, z.bottom),
      color: col, fill: hexToRgba(col, z.strong ? 0.22 : 0.10), width: z.strong ? 2 : 1,
    });
  };
  lastN(resistanceZones, 60).forEach((z) => push(z, C.down));
  lastN(supportZones, 60).forEach((z) => push(z, C.up));
  return out;
}

// ─── T5 (double top / double bottom state machine) ──────────────────────────
const T5_COLOR = {
  point: "#9c7bff", fire: "#ffab40", confirm: "#00e676", flip: "#ff5fa2", caution: "#ffd54f",
  nc: "#90a4ae", gate: "#4dd0e1", expired: "#78909c", cancelled: "#78909c", done: "#78909c", frame: "#b0bec5",
};
const T5_PROMINENT = new Set(["point", "fire", "confirm", "flip"]);

function t5(p) {
  const { markers, bands } = calcT5Pure(p.candles);
  const out = [];
  for (const b of lastN(bands, 80)) {
    if (![b.top, b.bottom].every(isNum)) continue;
    const col = b.side === "T5H" ? C.down : C.up;
    out.push({
      t: "box", from: timeAt(p.candles, b.fromBar), to: timeAt(p.candles, b.toBar),
      top: Math.max(b.top, b.bottom), bottom: Math.min(b.top, b.bottom),
      color: col, fill: hexToRgba(col, 0.10), width: 1,
    });
  }
  for (const m of lastN(markers, 250)) {
    if (!isNum(m.time) || !isNum(m.price)) continue;
    const col = T5_COLOR[m.category] || C.neutral;
    const dir = T5_PROMINENT.has(m.category) ? (m.side === "short" ? "down" : "up") : "none";
    out.push({ t: "mark", time: m.time, price: m.price, dir, text: m.label, color: col });
  }
  return out;
}

// ─── 9EMA pivot S/R bands (absorption / regime flip) ────────────────────────
function ema9pivot(p) {
  const r = calcEMA9PivotSRPure(p.candles, p.emaHighs, p.emaLows);
  const n = p.candles.length;
  const out = [];
  for (const b of lastN(r.bands, 60)) {
    if (![b.top, b.bot].every(isNum)) continue;
    const col = b.broken ? "#787b86" : b.isRes ? C.down : C.up;
    const poked = (b.pokes || 0) > 0;
    out.push({
      t: "box", from: timeAt(p.candles, b.born),
      to: b.frozen ? timeAt(p.candles, Math.min(b.rightBar, n - 1)) : p.candles[n - 1].time,
      top: Math.max(b.top, b.bot), bottom: Math.min(b.top, b.bot),
      color: col, fill: hexToRgba(col, b.broken ? 0.06 : poked ? 0.22 : 0.12), width: poked && !b.broken ? 2 : 1,
    });
  }
  // Entries: marker plus stop and target lines running 20 bars forward
  for (const e of lastN(r.entries, 20)) {
    if (![e.time, e.entry, e.stop, e.target].every(isNum)) continue;
    const short = e.type === "short";
    const idx = p.candles.findIndex((c) => c.time === e.time);
    const endT = idx >= 0 ? timeAt(p.candles, idx + 20) : e.time;
    out.push({ t: "mark", time: e.time, price: e.entry, dir: short ? "down" : "up", text: short ? "SHORT" : "LONG", color: short ? C.down : C.up });
    out.push({ t: "seg", from: e.time, p1: e.stop, to: endT, p2: e.stop, color: C.down, width: 1, style: "dashed" });
    out.push({ t: "seg", from: e.time, p1: e.target, to: endT, p2: e.target, color: C.up, width: 1, style: "dashed" });
  }
  if (r.flip && isNum(r.flip.level)) {
    out.push({
      t: "hline", from: timeAt(p.candles, n - 30), to: null, price: r.flip.level,
      color: r.flip.regime === 1 ? C.up : C.down, width: 2, style: "dotted", label: "FLIP",
    });
  }
  return out;
}

// ─── Ceiling Break & Retest ─────────────────────────────────────────────────
const CEIL_COLOR = { break: "#ff9800", retest: "#29b6f6", failed: "#ef5350", noretest: "#90a4ae", entry: "#00e676" };

function ceilingBreak(p) {
  const { markers, ceilingLines, zoneBands } = calcCeilingBreakPure(p.candles);
  const out = [];
  for (const b of lastN(zoneBands, 80)) {
    if (![b.hi, b.lo, b.fromTime].every(isNum)) continue;
    out.push({
      t: "box", from: b.fromTime, to: isNum(b.toTime) ? b.toTime : p.candles[p.candles.length - 1].time,
      top: Math.max(b.hi, b.lo), bottom: Math.min(b.hi, b.lo),
      color: CEIL_COLOR.retest, fill: hexToRgba(CEIL_COLOR.retest, 0.12), width: 1,
    });
  }
  for (const l of lastN(ceilingLines, 80)) {
    if (![l.level, l.fromTime].every(isNum)) continue;
    out.push({
      t: "hline", from: l.fromTime, to: isNum(l.toTime) ? l.toTime : p.candles[p.candles.length - 1].time, price: l.level,
      color: l.kind === "active" ? CEIL_COLOR.break : C.neutral, width: l.kind === "active" ? 2 : 1,
      style: l.kind === "active" ? "solid" : "dashed", label: "",
    });
  }
  for (const m of lastN(markers, 250)) {
    if (!isNum(m.time) || !isNum(m.price)) continue;
    const dir = m.category === "entry" || m.category === "break" ? "up" : m.category === "failed" ? "down" : "none";
    out.push({ t: "mark", time: m.time, price: m.price, dir, text: m.label, color: CEIL_COLOR[m.category] || C.neutral });
  }
  return out;
}

// ─── Pinaka (A1 / A2 / B / B2 detectors + VWAP band) ────────────────────────
const PINAKA_COLOR = { a1: "#00c853", a2: "#2979ff", b: "#ff1744", b2: "#c62828", ref: "#9e9e9e" };

function splitRuns(series, key, maxPoints) {
  const runs = [];
  let cur = [];
  for (const s of lastN(series, maxPoints)) {
    if (isNum(s[key]) && isNum(s.time)) cur.push({ time: s.time, price: s[key] });
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length > 1);
}

function pinaka(p) {
  const { markers, engineSeries } = calcPinakaPure(p.candles);
  const out = [];
  for (const key of ["bandUp", "bandDn"]) {
    for (const run of splitRuns(engineSeries, key, 1500)) {
      out.push({ t: "poly", points: run, color: "#7e57c2", width: 1 });
    }
  }
  for (const m of lastN(markers, 250)) {
    if (!isNum(m.time) || !isNum(m.price)) continue;
    const dir = m.category === "a1" || m.category === "a2" ? "up" : m.category === "b" || m.category === "b2" ? "down" : "none";
    out.push({ t: "mark", time: m.time, price: m.price, dir, text: m.label, color: PINAKA_COLOR[m.category] || "#c7d2fe" });
  }
  return out;
}

// ─── registry ───────────────────────────────────────────────────────────────
const COMPUTE = { bubble, waves, consolidation, srZones, t5, ema9pivot, ceilingBreak, pinaka };

// Built-in 9 EMA of highs and lows. These are real chart indicators, not drawings.
const STUDY_LAYERS = [
  {
    id: "ema9hl",
    label: "9 EMA High / Low",
    color: "#2962ff",
    kind: "study",
    studies: [
      { name: "Moving Average Exponential", inputs: { length: 9, source: "high" }, overrides: { "plot.color": "#2962ff", "plot.linewidth": 1 } },
      { name: "Moving Average Exponential", inputs: { length: 9, source: "low" }, overrides: { "plot.color": "#ff6d00", "plot.linewidth": 1 } },
    ],
  },
];

export const OVERLAY_LAYERS = [
  ...STUDY_LAYERS,
  ...INDICATOR_REGISTRY.filter((d) => COMPUTE[d.id]).map((d) => ({ ...d, kind: "shapes" })),
];

/**
 * @param {string} id        layer id from OVERLAY_LAYERS
 * @param {object} payload   /api/chart response { candles, emaHighs, emaLows, signals, ... }
 * @param {object} options   per-layer options, e.g. { bubbleGap: 4 }
 * @returns {Array} normalized shapes (empty on missing data or on error)
 */
export function computeLayer(id, payload, options) {
  const fn = COMPUTE[id];
  if (!fn || !payload || !Array.isArray(payload.candles) || payload.candles.length < 5) return [];
  try {
    return fn(payload, options || {}) || [];
  } catch (e) {
    console.warn(`[overlay] ${id} failed:`, e && e.message ? e.message : e);
    return [];
  }
}