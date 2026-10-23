/**
 * BubbleIndicator.js
 *
 * Handles the "Bubble" signal markers that appear on the candlestick chart.
 * These markers indicate NH (New High), NL (New Low), BC_HIGH, and BC_LOW signals
 * as arrow markers on the chart series.
 *  * as arrow markers on the chart series.
 *
 * Connected components:
 *  - CandleChart.js  → calls buildBubbleMarkers() + setMarkersIfChanged()
 *  - SignalTable.js  → reads the same signals array for the sidebar table
 *  - StatsPanel.js   → reads the same signals array for counts/stats
 *  - indicatorRegistry.js → "bubble" entry drives the toggle in IndicatorPanel
 *
 * Design notes:
 *  - Deduplicated setMarkers via setMarkersIfChanged() — compares a cheap
 *    fingerprint so the expensive lw-charts API fires ONLY when content changes.
 *  - ZERO setMarkers calls on price ticks — only fires on signal / todayMode /
 *    showBubble changes (enforced by the useEffect deps in CandleChart).
 *  - todayMode filters markers to the same IST calendar date as the latest candle.
 */

import { toISTDate } from "../utils/istUtils";

// ─── Core marker builder ───────────────────────────────────────────────────────

/**
 * Build the lw-charts marker array from a signals array.
 *
 * @param {Array}   signals     - Raw signal objects { type, time, barIndex, price }
 * @param {Array}   candles     - Candle objects { time (ms), ... }
 * @param {boolean} todayModeOn - When true, restrict to the latest candle's IST date
 * @returns {Array} Sorted marker array ready for series.setMarkers()
 */
export function buildBubbleMarkers(signals, candles, todayModeOn) {
  let src = signals || [];
  if (todayModeOn && candles.length > 0) {
    const latestIST = toISTDate(candles.at(-1).time);
    src = src.filter((s) => toISTDate(s.time) === latestIST);
  }

  const seen = new Set();
  const markers = [];

  src.forEach((sig) => {
    const t = Math.floor(sig.time / 1000);
    const key = `${sig.type}-${t}`;
    if (seen.has(key)) return;
    seen.add(key);

    switch (sig.type) {
      case "NH":
        markers.push({ time: t, position: "aboveBar", color: "#00d97e", shape: "arrowDown", text: "NH", size: 1 });
        break;
      case "NL":
        markers.push({ time: t, position: "belowBar", color: "#ff4560", shape: "arrowUp", text: "NL", size: 1 });
        break;
      case "BC_HIGH":
        markers.push({ time: t, position: "aboveBar", color: "#ffc135", shape: "arrowDown", text: "BC", size: 1 });
        break;
      case "BC_LOW":
        markers.push({ time: t, position: "belowBar", color: "#ffc135", shape: "arrowUp", text: "BC", size: 1 });
        break;
      default:
        break;
    }
  });

  markers.sort((a, b) => a.time - b.time);
  return markers;
}

// ─── Deduplicated setMarkers ───────────────────────────────────────────────────

/**
 * Call series.setMarkers() only when the marker set has actually changed.
 * Uses a cheap fingerprint string stored in a React ref to avoid redundant calls.
 *
 * @param {object} series   - lw-charts candlestick series
 * @param {Array}  markers  - marker array from buildBubbleMarkers()
 * @param {object} keyRef   - React ref { current: string|null }
 */
export function setMarkersIfChanged(series, markers, keyRef) {
  const key = markers.map((m) => `${m.time}:${m.text}`).join("|");
  if (key === keyRef.current) return;
  keyRef.current = key;
  series.setMarkers(markers);
}