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
];

export function buildDefaultIndicators() {
  return {
    bubble: false,
    waves: false,
    consolidation: false,
    srZones: false,
    bubbleGap: 4,    // shared param for consolidation
  };
}