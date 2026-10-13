// frontend/src/features/charts/tv/overlay/overlayController.js
// ═══════════════════════════════════════════════════════════════════════════
// Keeps the strategy overlays in sync with the chart.
//   - symbol or interval changes  -> clear shapes, recompute, redraw
//   - a new bar starts            -> refetch the chart payload, recompute, redraw
//   - a layer is toggled          -> draw or clear only that layer
//   - safety net                  -> refresh every 60 seconds
// ═══════════════════════════════════════════════════════════════════════════
import { OVERLAY_LAYERS, computeLayer } from "./overlayAdapters";
import { createOverlayRenderer } from "./overlayRenderer";

const SAFETY_REFRESH_MS = 60 * 1000;

export function createOverlayController({ widget, datafeed, layers, options }) {
  const renderer = createOverlayRenderer(widget);
  let enabled = { ...(layers || {}) };
  let opts = { ...(options || {}) };
  let ctx = null;        // { symbol, resolution } currently on the chart
  let destroyed = false;
  let busy = false;
  let again = false;

  async function refresh(force) {
    if (destroyed || !ctx) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const { symbol, resolution } = ctx;
      const payload = await datafeed.getPayload(symbol, resolution, !!force);
      if (destroyed || !payload) return;
      if (!ctx || ctx.symbol !== symbol || ctx.resolution !== resolution) { again = true; return; }

      for (const def of OVERLAY_LAYERS) {
        if (def.kind === "study") {
          await renderer.setStudyLayer(def.id, !!enabled[def.id], def.studies);
        } else if (!enabled[def.id]) {
          renderer.clearLayer(def.id);
        } else {
          const shapes = computeLayer(def.id, payload, opts[def.id]);
          await renderer.setShapes(def.id, shapes, resolution);
        }
      }
    } catch (e) {
      console.warn("[overlay] refresh failed:", e && e.message ? e.message : e);
    } finally {
      busy = false;
      if (again && !destroyed) { again = false; refresh(true); }
    }
  }

  const offContext = datafeed.on("context", (c) => {
    ctx = c;
    renderer.clearAllShapes();
    refresh(true);
  });
  const offBar = datafeed.on("bar", (c) => {
    if (ctx && c.symbol === ctx.symbol && c.resolution === ctx.resolution) refresh(true);
  });
  const timer = setInterval(() => refresh(true), SAFETY_REFRESH_MS);

  return {
    setLayers(next) {
      enabled = { ...(next || {}) };
      refresh(false);
    },
    setOptions(next) {
      opts = { ...(next || {}) };
      refresh(false);
    },
    refresh: () => refresh(true),
    destroy() {
      destroyed = true;
      clearInterval(timer);
      offContext();
      offBar();
      renderer.destroy();
    },
  };
}