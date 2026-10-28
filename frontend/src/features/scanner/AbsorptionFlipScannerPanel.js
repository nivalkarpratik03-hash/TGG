// AbsorptionFlipScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// "9EMA Absorption / Flip Break" strategy panel — two tabs:
//   - Absorption   — symbols where an absorbing band's extreme got closed
//                    through ("absorption_break" events from absorptionFlip.js)
//   - Breakthrough — symbols where the regime's flip level (refSWL/refSWH)
//                    broke on close ("flip_break" events)
//
// For BOTH tabs, every row shows the LATEST signal, the PREVIOUS signal,
// and the EXACT signal timestamp — matching the candle where the signal
// was generated (absorptionFlip.js emits `time: candles[i].time`, the
// real candle timestamp, not scan time).
//
// Fully self-contained, same pattern as T5ScannerPanel.js — this
// component does no pattern logic of its own, it only renders rows
// already shaped by absorptionFlipResultShape.js's buildAbsorptionFlipRows().
//
// The underlying SR Pivot band engine driving these events is IDENTICAL
// to the one the chart's EMA9PivotSRIndicator.js runs (same regime state
// machine, same ceiling/floor gate, same ABSORPTION watch-state) — see
// that file's header note — so a signal + timestamp shown here is exactly
// what you'd see if you opened that symbol's chart at this resolution.
//
// USAGE (dropped into ScannerPage.js next to T5ScannerPanel):
//   <AbsorptionFlipScannerPanel
//     rows={absorptionFlipRows}   // { absorption, breakthrough } — see absorptionFlipResultShape.js
//     scannedCount={n}
//     resolution={tfLabel}
//     onRowClick={(symbol) => navigate(buildChartUrl(symbol, timeframe))}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import { formatDateTimeIST } from "../../utils/istUtils";
import "./AbsorptionFlipScannerPanel.css";

function fmtLevel(v) {
  return v == null || isNaN(v) ? "—" : Number(v).toFixed(2);
}

function DirectionBadge({ direction, side }) {
  const up = direction === "up";
  return (
    <span className={`afp-dir-badge ${up ? "up" : "down"}`}>
      {up ? "▲" : "▼"} {side === "resistance" ? "Resistance" : "Support"}
    </span>
  );
}

function SignalCell({ event, emphasis }) {
  if (!event) return <span className="afp-signal-cell afp-signal-empty">—</span>;
  return (
    <div className={`afp-signal-cell ${emphasis ? "afp-signal-latest" : "afp-signal-prev"}`}>
      <DirectionBadge direction={event.direction} side={event.side} />
      <div className="afp-signal-level">Level {fmtLevel(event.level)}</div>
      <div className="afp-signal-time">{formatDateTimeIST(event.time)}</div>
    </div>
  );
}

function AbsorptionFlipTable({ rows, kind, onRowClick, emptyLabel }) {
  if (!rows.length) {
    return <div className="afp-empty">{emptyLabel}</div>;
  }
  return (
    <div className="afp-table-wrap">
      <table className="afp-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Latest Signal</th>
            <th>Previous Signal</th>
            <th># Signals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} onClick={() => onRowClick?.(r.symbol)}>
              <td className="afp-symbol-cell">{r.symbol}</td>
              <td><SignalCell event={r.latest} emphasis /></td>
              <td><SignalCell event={r.previous} /></td>
              <td className="afp-count-cell">{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AbsorptionFlipScannerPanel({
  rows,
  scannedCount = 0,
  resolution,
  onRowClick,
}) {
  const [tab, setTab] = useState("absorption");

  const absorptionRows = rows?.absorption || [];
  const breakthroughRows = rows?.breakthrough || [];

  const stats = useMemo(
    () => ({
      absorption: absorptionRows.length,
      breakthrough: breakthroughRows.length,
      scanned: scannedCount,
    }),
    [absorptionRows.length, breakthroughRows.length, scannedCount]
  );

  return (
    <div className="afp-wrap">
      <div className="afp-topbar">
        <span className="afp-title">9EMA Absorption / Flip Break</span>
        {resolution && <span className="afp-meta">{resolution} · {stats.scanned} symbols scanned</span>}
      </div>

      <div className="afp-stats">
        <div className="afp-stat">
          <div className="afp-lbl">Absorption Signals</div>
          <div className="afp-val afp-val-purple">{stats.absorption}</div>
        </div>
        <div className="afp-stat">
          <div className="afp-lbl">Breakthrough Signals</div>
          <div className="afp-val afp-val-amber">{stats.breakthrough}</div>
        </div>
      </div>

      <div className="afp-tabs">
        <button
          className={`afp-tab ${tab === "absorption" ? "active" : ""}`}
          onClick={() => setTab("absorption")}
        >
          Absorption <span className="afp-tab-count">{absorptionRows.length}</span>
        </button>
        <button
          className={`afp-tab ${tab === "breakthrough" ? "active" : ""}`}
          onClick={() => setTab("breakthrough")}
        >
          Breakthrough <span className="afp-tab-count">{breakthroughRows.length}</span>
        </button>
      </div>

      {tab === "absorption" ? (
        <AbsorptionFlipTable
          rows={absorptionRows}
          kind="absorption"
          onRowClick={onRowClick}
          emptyLabel="No absorption signals yet — an absorbing band's extreme hasn't been closed through on any scanned symbol."
        />
      ) : (
        <AbsorptionFlipTable
          rows={breakthroughRows}
          kind="breakthrough"
          onRowClick={onRowClick}
          emptyLabel="No breakthrough signals yet — no symbol's regime flip level has broken on close."
        />
      )}
    </div>
  );
}