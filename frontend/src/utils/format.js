// frontend/src/utils/format.js
//
// SINGLE SOURCE OF TRUTH for the currency/number formatter previously
// copy-pasted independently into 7 places: components/drawingUtils.js,
// components/StatusBar.js, components/EmaFloatPanel.js, components/CandleChart.js,
// pages/FibDashboardPage.js, pages/ReportsPage.js, pages/ScannerPage.js,
// pages/StrategiesPage.js.
//
// Two shapes existed before this consolidation:
//   - fmt(n)       — fixed 2 decimals, only guarded against n == null
//                     (StatusBar.js, FibDashboardPage.js, ReportsPage.js,
//                     EmaFloatPanel.js's local variant)
//   - fmt(n, d=2)  — configurable decimals, guarded against n == null AND
//                     !isFinite(n) (ScannerPage.js, StrategiesPage.js)
//
// fmt() below matches the STRICTER (d=2, isFinite-checked) behavior for all
// callers. NOTE — this is a real behavior difference for the first group:
// if any of those call sites ever pass NaN/Infinity (not just null/undefined),
// the old code would have called numFmt.format(NaN) → literal string "NaN"
// on screen, whereas this shared version now returns "—" instead. This is a
// strictly safer output (no page should ever display the string "NaN"), but
// flagging it since it IS a behavior change, not a guaranteed no-op swap —
// verify against each swapped file's actual data before assuming no visible
// difference.

export const numFmt = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmt(n, d = 2) {
  if (n == null || !isFinite(n)) return "—";
  if (d === 2) return numFmt.format(Number(n));
  return Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}
