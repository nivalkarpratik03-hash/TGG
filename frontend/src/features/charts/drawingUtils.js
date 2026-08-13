/**
 * drawingUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared constants, geometry, and utilities for the drawing overlay system.
 * Extracted from DrawingOverlay.js which was 1521 lines.
 *
 * Consumers: DrawingOverlay.js, DrawingShapes.js, buildDrawing.js
 */
import { getTimeframeColor } from "../../utils/timeframeColors";
// numFmt re-exported here (not just imported) so DrawingShapes.js's existing
// `import { numFmt } from "./drawingUtils"` keeps working unmodified.
export { numFmt } from "../../utils/format";

// ─── Visual constants ─────────────────────────────────────────────────────────
export const DRAW_COLOR = "#2962ff";
export const HOVER_COLOR = "#5b8fff";
export const FIB_COLOR = "#f0c040";
export const HANDLE_R = 5;
export const HIT_SLOP = 10;
export const LS_KEY_BASE = "tgg_drawings_v2";

// ─── Fibonacci levels ─────────────────────────────────────────────────────────
export const FIB_LEVELS = [
  { ratio: -1.618, label: "-1.618", color: "#26a69a", dash: "6 3", width: 1.2 },
  { ratio: -1.000, label: "-1", color: "#ef5350", dash: "4 3", width: 1.4 },
  { ratio: -0.618, label: "-0.618", color: "#26a69a", dash: "5 3", width: 1.2 },
  { ratio: -0.236, label: "-0.236", color: "#fb8c00", dash: "4 2", width: 1.0 },
  { ratio: 0.000, label: "0", color: "#b2b5be", dash: "0", width: 1.6 },
  { ratio: 0.236, label: "0.236", color: "#fb8c00", dash: "4 2", width: 1.0 },
  { ratio: 0.382, label: "0.382", color: "#26c6da", dash: "5 3", width: 1.0 },
  { ratio: 0.500, label: "0.500", color: "#66bb6a", dash: "5 3", width: 1.2 },
  { ratio: 0.618, label: "0.618", color: "#ffca28", dash: "5 3", width: 1.4 },
  { ratio: 0.786, label: "0.786", color: "#26c6da", dash: "5 3", width: 1.0 },
  { ratio: 1.000, label: "1", color: "#b2b5be", dash: "0", width: 1.6 },
  { ratio: 1.618, label: "1.618", color: "#26a69a", dash: "6 3", width: 1.2 },
];

export const FIB_ZONE_FILLS = [
  { from: -1.618, to: -1.000, color: "#26a69a", opacity: 0.10 },
  { from: -1.000, to: -0.236, color: "#ef9a9a", opacity: 0.10 },
  { from: -0.236, to: 0.000, color: "#ff9800", opacity: 0.28 },
  { from: 0.000, to: 0.236, color: "#ff9800", opacity: 0.28 },
  { from: 0.236, to: 0.382, color: "#ffab91", opacity: 0.10 },
  { from: 0.382, to: 0.500, color: "#b2dfdb", opacity: 0.10 },
  { from: 0.500, to: 0.618, color: "#c8e6c9", opacity: 0.10 },
  { from: 0.618, to: 0.786, color: "#fff9c4", opacity: 0.10 },
  { from: 0.786, to: 1.000, color: "#b2dfdb", opacity: 0.10 },
  { from: 1.000, to: 1.618, color: "#cfd8dc", opacity: 0.08 },
];

// ─── Geometry helper ──────────────────────────────────────────────────────────
export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ─── UID generator ────────────────────────────────────────────────────────────
let _uid = Date.now();
export function uid() { return ++_uid; }

// ─── Persistence helpers ──────────────────────────────────────────────────────
export function loadDrawings(panelKey) {
  try {
    const key = panelKey ? `${LS_KEY_BASE}_${panelKey}` : LS_KEY_BASE;
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveDrawings(drawings, panelKey) {
  try {
    const key = panelKey ? `${LS_KEY_BASE}_${panelKey}` : LS_KEY_BASE;
    localStorage.setItem(key, JSON.stringify(drawings));
  } catch { }
}

// ─── Build drawing from drag ──────────────────────────────────────────────────
export function buildDrawing({ tool, start, current }, linked = false, resolution = null) {
  if (!start || !current) return null;
  if (tool === "trendline") {
    if (Math.hypot(current.x - start.x, current.y - start.y) < 4) return null;
    return {
      id: uid(), type: "trendline", linked,
      p1: { price: start.price, time: start.time, px: start.x, barOffset: start.barOffset ?? null },
      p2: { price: current.price, time: current.time, px: current.x, barOffset: current.barOffset ?? null },
    };
  }
  if (tool === "horizontal") {
    if (start.price == null) return null;
    return { id: uid(), type: "horizontal", price: start.price, linked };
  }
  if (tool === "fibRetracement") {
    if (Math.hypot(current.x - start.x, current.y - start.y) < 4) return null;
    if (start.price == null || current.price == null) return null;
    const tfColor = resolution != null ? getTimeframeColor(resolution, null) : null;
    return {
      id: uid(), type: "fibRetracement", linked,
      p1: { price: current.price, time: current.time, px: current.x, barOffset: current.barOffset ?? null },
      p2: { price: start.price, time: start.time, px: start.x, barOffset: start.barOffset ?? null },
      tfColor,
    };
  }
  return null;
}