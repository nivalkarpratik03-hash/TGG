// EmaFloatPanel.js
// Uses forwardRef + useImperativeHandle so the parent (ChartPanel) can call
// update(bar) imperatively — no React state in ChartPanel fires on crosshair move.
import React, { useState, useMemo, useRef, useImperativeHandle, forwardRef } from "react";
import "../styles/EmaFloatPanel.css";

const EmaFloatPanel = forwardRef(function EmaFloatPanel({ emaHighs, emaLows, candles }, ref) {
  const [crosshairBar, setCrosshairBar] = useState(null);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  // Expose an imperative update() so ChartPanel can push crosshair moves
  // without triggering a ChartPanel re-render.
  useImperativeHandle(ref, () => ({
    update(bar) { setCrosshairBar(bar); },
  }), []);

  const crosshairIndex = useMemo(() => {
    if (!crosshairBar || !candles?.length) return -1;
    const targetMs = crosshairBar.unixSec * 1000;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time === targetMs) return i;
    }
    return -1;
  }, [crosshairBar, candles]);

  const ema9High = useMemo(() => {
    if (crosshairIndex >= 0 && emaHighs?.[crosshairIndex] != null && !isNaN(emaHighs[crosshairIndex])) {
      return emaHighs[crosshairIndex];
    }
    if (!emaHighs?.length) return null;
    for (let i = emaHighs.length - 1; i >= 0; i--) {
      const v = emaHighs[i];
      if (v != null && !isNaN(v)) return v;
    }
    return null;
  }, [emaHighs, crosshairIndex]);

  const ema9Low = useMemo(() => {
    if (crosshairIndex >= 0 && emaLows?.[crosshairIndex] != null && !isNaN(emaLows[crosshairIndex])) {
      return emaLows[crosshairIndex];
    }
    if (!emaLows?.length) return null;
    for (let i = emaLows.length - 1; i >= 0; i--) {
      const v = emaLows[i];
      if (v != null && !isNaN(v)) return v;
    }
    return null;
  }, [emaLows, crosshairIndex]);

  if (ema9High == null && ema9Low == null) return null;

  function fmt(v) {
    if (v == null) return "—";
    return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return (
    <div className="ema-float-panel">
      <div className="ema-float-row">
        <span className="ema-float-key ema-float-key--high">EMA9H</span>
        <span className="ema-float-val ema-float-val--high">{fmt(ema9High)}</span>
      </div>
      <div className="ema-float-row">
        <span className="ema-float-key ema-float-key--low">EMA9L</span>
        <span className="ema-float-val ema-float-val--low">{fmt(ema9Low)}</span>
      </div>
    </div>
  );
});

export default EmaFloatPanel;