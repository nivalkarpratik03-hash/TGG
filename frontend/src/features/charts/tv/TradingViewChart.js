// frontend/src/features/charts/tv/TradingViewChart.js
// Mounts TradingView Advanced Charts plus the strategy overlay layer.
// The library files are NOT part of the source tree: copy the library's
// "charting_library" folder to
//   frontend/public/charting_library/
// It is served as static files from /charting_library/.
import React, { useEffect, useRef, useState } from "react";
import { createDatafeed } from "./tgDatafeed";
import { createOverlayController } from "./overlay/overlayController";

const BASE = process.env.PUBLIC_URL || "";
const LIB_PATH = `${BASE}/charting_library/`;
const SCRIPT_SRC = `${LIB_PATH}charting_library.standalone.js`;

const MISSING_MSG =
  "TradingView library not found. Copy the 'charting_library' folder into " +
  "frontend/public/charting_library/ and restart the frontend.";

let scriptPromise = null;
function loadLibraryScript() {
  if (window.TradingView && window.TradingView.widget) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => {
      // The dev server answers a missing file with index.html, so onload can
      // fire even when the library is absent. Check the global explicitly.
      if (window.TradingView && window.TradingView.widget) resolve();
      else reject(new Error(MISSING_MSG));
    };
    el.onerror = () => reject(new Error(MISSING_MSG));
    document.head.appendChild(el);
  }).catch((e) => {
    scriptPromise = null; // allow a retry after the files are copied in
    throw e;
  });
  return scriptPromise;
}

/**
 * @param {string} symbol
 * @param {string} interval       TradingView interval string, e.g. "15", "3", "1D"
 * @param {object} layers         { [layerId]: boolean }  strategy overlays to show
 * @param {object} layerOptions   { [layerId]: {...} }    per-layer options (optional)
 */
export default function TradingViewChart({
  symbol = "NSE:NIFTY50-INDEX",
  interval = "15",
  layers = {},
  layerOptions = {},
}) {
  const containerRef = useRef(null);
  const controllerRef = useRef(null);
  const layersRef = useRef(layers);
  const optionsRef = useRef(layerOptions);
  const [error, setError] = useState(null);

  layersRef.current = layers;
  optionsRef.current = layerOptions;

  // Create the chart. Re-created only when the symbol or interval prop changes.
  useEffect(() => {
    let widget = null;
    let datafeed = null;
    let cancelled = false;
    setError(null);

    loadLibraryScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        datafeed = createDatafeed();
        const appTheme = document.documentElement.getAttribute("data-theme");
        widget = new window.TradingView.widget({
          container: containerRef.current,
          library_path: LIB_PATH,
          datafeed,
          symbol,
          interval,
          locale: "en",
          timezone: "Asia/Kolkata",
          theme: appTheme === "light" ? "light" : "dark",
          autosize: true,
        });
        widget.chartReady().then(() => {
          if (cancelled) return;
          controllerRef.current = createOverlayController({
            widget,
            datafeed,
            layers: layersRef.current,
            options: optionsRef.current,
          });
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || String(e));
      });

    return () => {
      cancelled = true;
      if (controllerRef.current) {
        controllerRef.current.destroy();
        controllerRef.current = null;
      }
      try {
        if (widget && typeof widget.remove === "function") widget.remove();
      } catch (e) {
        /* widget already gone */
      }
      if (datafeed) datafeed.destroy();
    };
  }, [symbol, interval]);

  // Toggle strategy layers without rebuilding the chart.
  useEffect(() => {
    if (controllerRef.current) controllerRef.current.setLayers(layers);
  }, [layers]);

  useEffect(() => {
    if (controllerRef.current) controllerRef.current.setOptions(layerOptions);
  }, [layerOptions]);

  if (error) {
    return (
      <div style={{ padding: 24, color: "#e06c75", fontFamily: "monospace", fontSize: 13 }}>
        {error}
      </div>
    );
  }
  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}