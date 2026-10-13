// frontend/src/features/charts/tv/TradingViewPage.js
// Full-screen TradingView Advanced Charts page with strategy toggles.
//   /tv                                  -> NIFTY 50, 15 minute
//   /tv?symbol=NSE:NIFTYBANK-INDEX&interval=3
import React, { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import TradingViewChart from "./TradingViewChart";
import { OVERLAY_LAYERS } from "./overlay/overlayAdapters";

const STORAGE_KEY = "tv_overlay_layers_v1";

function loadLayers() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    const out = {};
    for (const d of OVERLAY_LAYERS) out[d.id] = !!saved[d.id];
    return out;
  } catch (e) {
    return {};
  }
}

function saveLayers(layers) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layers));
  } catch (e) {
    /* storage unavailable, toggles just won't persist */
  }
}

export default function TradingViewPage() {
  const [params] = useSearchParams();
  const symbol = params.get("symbol") || "NSE:NIFTY50-INDEX";
  const interval = params.get("interval") || "15";
  const [layers, setLayers] = useState(loadLayers);
  const layerOptions = useMemo(() => ({}), []);

  const toggle = useCallback((id) => {
    setLayers((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveLayers(next);
      return next;
    });
  }, []);

  const allOff = useCallback(() => {
    const next = {};
    for (const d of OVERLAY_LAYERS) next[d.id] = false;
    saveLayers(next);
    setLayers(next);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: "6px 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Link to="/">Home</Link>
        <span style={{ opacity: 0.5 }}>|</span>
        <Link to="/charts">Charts</Link>
        <span style={{ marginLeft: 8, marginRight: 8, opacity: 0.6 }}>Strategies:</span>
        {OVERLAY_LAYERS.map((d) => {
          const on = !!layers[d.id];
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => toggle(d.id)}
              title={d.kind === "study" ? "Chart indicator" : "Strategy overlay"}
              style={{
                cursor: "pointer",
                padding: "3px 10px",
                borderRadius: 12,
                fontSize: 12,
                border: `1px solid ${d.color}`,
                background: on ? d.color : "transparent",
                color: on ? "#fff" : d.color,
              }}
            >
              {d.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={allOff}
          style={{ cursor: "pointer", padding: "3px 10px", borderRadius: 12, fontSize: 12, border: "1px solid #888", background: "transparent", color: "#888" }}
        >
          All off
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TradingViewChart symbol={symbol} interval={interval} layers={layers} layerOptions={layerOptions} />
      </div>
    </div>
  );
}