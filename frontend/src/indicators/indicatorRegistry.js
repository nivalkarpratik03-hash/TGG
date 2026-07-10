/**
 * indicatorRegistry.js
 * Single source of truth for ALL indicators.
 * To add a new indicator: add entry here + add default in buildDefaultIndicators().
 * IndicatorPanel renders everything automatically.
 */

export const INDICATOR_REGISTRY = [
  {
    id: "bubble",
    label: "Bubble",
    color: "#3d84ff",
  },
  {
    id: "waves",
    label: "Waves",
    color: "#f5a623",
  },
  {
    id: "consolidation",
    label: "Consolidation",
    color: "#a259ff",
    // This indicator exposes an extra numeric input (bubbleGap)
    extraInput: {
      key: "bubbleGap",
      label: "Gap",
      min: 1,
      max: 20,
      defaultValue: 4,
    },
  },
  {
    id: "srZones",
    label: "SR Zones",
    color: "#00c853",
  },

  // ── Phase 1 indicators — placeholders only, no logic wired yet ──
  {
    id: "sessionVwap",
    label: "VWAP",
    color: "#ff5c5c",
  },
  {
    id: "vwapBands",
    label: "VWAP σ-Bands",
    color: "#ff8a3d",
  },
  {
    id: "ema9HiLo",
    label: "EMA-9 Hi/Lo",
    color: "#ffd23d",
  },
  {
    id: "bollingerBands",
    label: "Bollinger Bands",
    color: "#4dd0e1",
  },
  {
    id: "bbSqueeze",
    label: "BB Squeeze %ile",
    color: "#2196f3",
  },
  {
    id: "adx",
    label: "ADX / DI",
    color: "#7c4dff",
  },
  {
    id: "atr",
    label: "ATR",
    color: "#e040fb",
  },
  {
    id: "relVolume",
    label: "Rel Volume",
    color: "#8bc34a",
  },
  {
    id: "bcvcFlag",
    label: "Big Candle Flag",
    color: "#ff4081",
  },
  {
    id: "priorDayLevels",
    label: "Prior Day Levels",
    color: "#9e9e9e",
  },
];

export function buildDefaultIndicators() {
  return {
    bubble: true,
    waves: false,
    consolidation: false,
    srZones: false,
    bubbleGap: 4,    // shared param for consolidation

    // Phase 1 — placeholders, default off, no logic behind them yet
    sessionVwap: false,
    vwapBands: false,
    ema9HiLo: false,
    bollingerBands: false,
    bbSqueeze: false,
    adx: false,
    atr: false,
    relVolume: false,
    bcvcFlag: false,
    priorDayLevels: false,
  };
}