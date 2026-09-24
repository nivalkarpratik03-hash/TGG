// HistoryLookbackFilter.js
// ─────────────────────────────────────────────────────────────────
// The ONE shared "Lookback" dropdown + "Scan this range" button used in
// every strategy panel's History sub-header (PinakaScannerPanel,
// T5ScannerPanel, AbsorptionScannerPanel, CeilingBreakScannerPanel,
// TypeScannerPanel). Built once here instead of five independent copies —
// see scanner-lookback-filter-demo.html for the original reference layout
// this matches (NEW tag, dropdown, scoped "Scan this range" button that
// only shows once a non-default range is picked).
//
// This component owns NO network logic and NO strategy-specific knowledge.
// It only renders the control and calls back up: `value`/`onChange` for the
// dropdown, `onScan` when "Scan this range" is clicked. ScannerPage.js owns
// the actual POST /api/scanner/trigger call (see its triggerScan()) — one
// shared trigger function reused by the main "Scan Now" button AND every
// panel's "Scan this range" button, not a second independent copy of that
// fetch call per panel.
//
// Placement: only inside a History tab's sub-header — Results/Upcoming are
// always "current state," lookback has no meaning there. See each panel's
// own usage for exactly where this is dropped in.
//
// S1S2S3ScannerPanel does NOT use this — that strategy only ever tracks one
// current S1→S2→S3 sequence per symbol (no historical event log to filter
// by lookback window), so it has no History tab at all. See ScannerPage.js.
//
// USAGE:
//   <HistoryLookbackFilter
//     value={lookbackDays}
//     onChange={setLookbackDays}
//     onScan={(days) => onScanRange(days)}
//     disabled={isRunning}
//   />
// ─────────────────────────────────────────────────────────────────

import React from "react";
import "./ScannerPage.css";

// Preset windows offered in the dropdown — kept in lockstep with the
// backend's ALLOWED_LOOKBACK_DAYS (scannerRouter.js), which validates
// against these same 4 numbers. No "Custom range…" option — the reference
// demo showed one as a placeholder, but a custom date-range picker is a
// separate, unspecified piece of UI/date-validation logic; these 4 presets
// are the ones actually decided on.
export const DEFAULT_LOOKBACK_DAYS = 90;
export const LOOKBACK_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: DEFAULT_LOOKBACK_DAYS, label: "90 days (default)" },
  { value: 180, label: "180 days" },
  { value: 365, label: "365 days" },
];

export default function HistoryLookbackFilter({
  value = DEFAULT_LOOKBACK_DAYS,
  onChange = () => {},
  onScan = () => {},
  disabled = false,
}) {
  const isDefault = value === DEFAULT_LOOKBACK_DAYS;

  return (
    <div className="scanner-lookback-wrap">
      <span className="scanner-lookback-tag">NEW</span>
      <span className="scanner-lookback-label">Lookback:</span>
      <select
        className="scanner-lookback-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {LOOKBACK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {!isDefault && (
        <button
          type="button"
          className="scanner-lookback-scan-btn"
          disabled={disabled}
          onClick={() => onScan(value)}
          title={`Re-scan just this strategy over the last ${value} days — Results/Upcoming/History all refresh together, other strategies untouched`}
        >
          ▶ Scan this range
        </button>
      )}
    </div>
  );
}
