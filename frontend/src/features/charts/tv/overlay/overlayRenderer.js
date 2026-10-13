// frontend/src/features/charts/tv/overlay/overlayRenderer.js
// ═══════════════════════════════════════════════════════════════════════════
// Draws normalized shapes (see overlayAdapters.js) on a TradingView Advanced
// Charts widget. It only draws. It never computes anything.
//
// Layers are independent: each layer id owns its own list of drawings and can
// be redrawn or cleared without touching the others, or the user's own
// manually drawn tools.
// ═══════════════════════════════════════════════════════════════════════════
import { toChartSeconds } from "../tgDatafeed";

const LINE_STYLE = { solid: 0, dotted: 1, dashed: 2 };
const CHUNK = 40; // drawings created in parallel per batch

const BASE_OPTS = { lock: true, disableSelection: true, disableSave: true, disableUndo: true };

export function createOverlayRenderer(widget) {
  const shapeIds = new Map();  // layerId -> entity ids
  const studyIds = new Map();  // layerId -> entity ids
  const draws = new Map();     // layerId -> generation counter (drops stale redraws)

  const chart = () => widget.activeChart();

  function safeRemove(id) {
    try {
      chart().removeEntity(id);
    } catch (e) {
      /* entity already gone (e.g. symbol changed) */
    }
  }

  async function drawOne(c, s, resMin) {
    const ts = (ms) => toChartSeconds(ms, resMin);
    switch (s.t) {
      case "box":
        return c.createMultipointShape(
          [{ time: ts(s.from), price: s.top }, { time: ts(s.to), price: s.bottom }],
          {
            shape: "rectangle", ...BASE_OPTS,
            overrides: { color: s.color, backgroundColor: s.fill, linewidth: s.width || 1, fillBackground: true },
          }
        );
      case "hline":
        if (s.to == null) {
          return c.createShape({ time: ts(s.from), price: s.price }, {
            shape: "horizontal_ray", ...BASE_OPTS, text: s.label || "",
            overrides: { linecolor: s.color, linewidth: s.width || 1, linestyle: LINE_STYLE[s.style] ?? 0, showLabel: !!s.label, textcolor: s.color },
          });
        }
        return c.createMultipointShape(
          [{ time: ts(s.from), price: s.price }, { time: ts(s.to), price: s.price }],
          {
            shape: "trend_line", ...BASE_OPTS,
            overrides: { linecolor: s.color, linewidth: s.width || 1, linestyle: LINE_STYLE[s.style] ?? 0, extendLeft: false, extendRight: false },
          }
        );
      case "seg":
        return c.createMultipointShape(
          [{ time: ts(s.from), price: s.p1 }, { time: ts(s.to), price: s.p2 }],
          {
            shape: "trend_line", ...BASE_OPTS,
            overrides: { linecolor: s.color, linewidth: s.width || 1, linestyle: LINE_STYLE[s.style] ?? 0, extendLeft: false, extendRight: false },
          }
        );
      case "poly":
        return c.createMultipointShape(
          s.points.map((p) => ({ time: ts(p.time), price: p.price })),
          { shape: "polyline", ...BASE_OPTS, overrides: { linecolor: s.color, linewidth: s.width || 1, fillBackground: false } }
        );
      case "mark":
        if (s.dir === "up" || s.dir === "down") {
          return c.createShape({ time: ts(s.time), price: s.price }, {
            shape: s.dir === "up" ? "arrow_up" : "arrow_down", ...BASE_OPTS, text: s.text || "",
            overrides: { arrowColor: s.color, color: s.color, textColor: s.color, fontsize: 11, bold: true },
          });
        }
        return c.createShape({ time: ts(s.time), price: s.price }, {
          shape: "text", ...BASE_OPTS, text: s.text || "",
          overrides: { color: s.color, fontsize: 11, bold: true },
        });
      default:
        return null;
    }
  }

  /** Replace everything in a layer with a new list of shapes. */
  async function setShapes(layerId, shapes, resMin) {
    const gen = (draws.get(layerId) || 0) + 1;
    draws.set(layerId, gen);
    const c = chart();
    const fresh = [];
    for (let i = 0; i < shapes.length; i += CHUNK) {
      if (draws.get(layerId) !== gen) break; // a newer redraw started
      const batch = await Promise.all(
        shapes.slice(i, i + CHUNK).map((s) => drawOne(c, s, resMin).catch(() => null))
      );
      for (const id of batch) if (id) fresh.push(id);
    }
    if (draws.get(layerId) !== gen) {
      fresh.forEach(safeRemove); // stale draw: discard
      return;
    }
    const old = shapeIds.get(layerId) || [];
    shapeIds.set(layerId, fresh);
    old.forEach(safeRemove); // swap after the new set is on screen, so there is no flicker
  }

  function clearLayer(layerId) {
    draws.set(layerId, (draws.get(layerId) || 0) + 1);
    (shapeIds.get(layerId) || []).forEach(safeRemove);
    shapeIds.delete(layerId);
  }

  /** Clear all shape layers (studies stay). Used when the symbol or interval changes. */
  function clearAllShapes() {
    for (const id of Array.from(shapeIds.keys())) clearLayer(id);
  }

  /** Add or remove built-in studies for a layer. Idempotent. */
  async function setStudyLayer(layerId, enabled, defs) {
    const have = studyIds.get(layerId);
    if (enabled && !have) {
      const ids = [];
      for (const d of defs) {
        try {
          const id = await chart().createStudy(d.name, false, false, d.inputs, d.overrides);
          if (id) ids.push(id);
        } catch (e) {
          console.warn("[overlay] createStudy failed:", d.name, e && e.message ? e.message : e);
        }
      }
      studyIds.set(layerId, ids);
    } else if (!enabled && have) {
      have.forEach(safeRemove);
      studyIds.delete(layerId);
    }
  }

  function destroy() {
    clearAllShapes();
  }

  return { setShapes, clearLayer, clearAllShapes, setStudyLayer, destroy };
}