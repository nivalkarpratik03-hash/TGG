// KronosScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// Kronos (AI forecast) strategy panel. Same self-contained pattern as
// every other panel here — this component does NO forecasting logic of
// its own; `rows` is already shaped by kronosResultShape.js's
// buildKronosRows() from kronosDirection.js's scan() results.
//
// Results tab ONLY — deliberately no Upcoming, no History (see
// kronosResultShape.js's header for exactly why). This is the one
// panel in the Scanner without the 3-tab layout every other strategy
// has; a single forecast per symbol per scan, nothing multi-stage.
//
// USAGE:
//   <KronosScannerPanel
//     rows={kronosRows}                 // { results, counts } — upcoming/history always []
//     scannedCount={results.length}
//     resolution={tfLabel}
//     lastScan={lastScan}
//     durationMs={status?.lastScanDurationMs}
//     onRowClick={(symbol) => openChart(symbol, timeframe)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { formatDateTimeIST } from "../../utils/istUtils";
import { fmtTime } from "./mwScanHelpers";
import { tickerOf } from "../../utils/symbolMeta";
import "./ScannerPage.css";
import "./KronosScannerPanel.css";

function matchesSymbol(symbol, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return symbol.toLowerCase().includes(q) || tickerOf(symbol).toLowerCase().includes(q);
}

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="scanner-search-icon">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const DIRECTION_META = {
  up: { label: "▲ Up", cls: "kp-dir-up" },
  down: { label: "▼ Down", cls: "kp-dir-down" },
  neutral: { label: "— Neutral", cls: "kp-dir-neutral" },
};

export default function KronosScannerPanel({
  rows = { results: [], counts: { up: 0, down: 0, neutral: 0, highConfidence: 0 } },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  onRowClick = () => {},
}) {
  const [query, setQuery] = useState("");
  const [minConfidence, setMinConfidence] = useState(0);

  const counts = rows.counts || { up: 0, down: 0, neutral: 0, highConfidence: 0 };

  const filteredResults = useMemo(
    () =>
      (rows.results || []).filter(
        (r) => matchesSymbol(r.symbol, query) && (r.confidence || 0) >= minConfidence
      ),
    [rows.results, query, minConfidence]
  );

  // ── Download — Results only, one sheet, same rule as every other
  // panel's handleDownload: always exports full rows, not the
  // search/confidence-filtered view. ──────────────────────────────────
  function handleDownload() {
    if (!(rows.results || []).length) return;

    const resultsRows = rows.results.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Direction": r.direction,
      "Confidence %": r.confidence,
      "Close": r.currentClose,
      "Predicted Close": r.predictedClose,
      "Horizon (bars)": r.horizon,
      "Resolution": r.resolution,
      "Meets threshold": r.found ? "Yes" : "No",
      "Scanned At": r.scannedAt ? formatDateTimeIST(r.scannedAt) : "",
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultsRows), "Results");

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, `kronos_scanner_${resolution}_${stamp}.xlsx`);
  }

  return (
    <div className="kp-wrap">
      <div className="scanner-stats-row">
        <div className="stat-chip"><span className="stat-chip-label">Scanned</span><span className="stat-chip-val accent">{scannedCount}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">High Confidence (&ge;65%)</span><span className="stat-chip-val green">{counts.highConfidence}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Up</span><span className="stat-chip-val green">{counts.up}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Down</span><span className="stat-chip-val" style={{ color: "var(--red, #ef4444)" }}>{counts.down}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Resolution</span><span className="stat-chip-val accent">{resolution}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Last Scan</span><span className="stat-chip-val" style={{ fontSize: 11 }}>{lastScan ? fmtTime(lastScan) : "—"}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Duration</span><span className="stat-chip-val">{durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "—"}</span></div>
      </div>

      <div className="kp-note">
        Research/backtest mode — not a live signal yet (Kronos is zero-shot, unvalidated on these instruments). Results only for now; History tab planned separately once per-symbol speed is measured.
      </div>

      <div className="scanner-signals-tabs">
        <div className="kp-conf-filter">
          <span>Min confidence</span>
          <input
            type="range" min="0" max="100" value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
          <b>{minConfidence}%</b>
        </div>
        <div className="scanner-signals-tabs-right">
          <div className={`scanner-search ${query ? "has-val" : ""}`}>
            <SearchGlyph />
            <input
              type="text" placeholder="Search symbol…"
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="scanner-search-clear" onClick={() => setQuery("")} title="Clear search">
                &times;
              </button>
            )}
          </div>
          <button className="scanner-download-btn" onClick={handleDownload}>⬇ Download</button>
        </div>
      </div>

      {filteredResults.length === 0 ? (
        <div className="scanner-signals-empty">
          {query ? `No results match "${query}"` : "No forecasts yet — click Scan Now."}
        </div>
      ) : (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-title">Results</span>
            <span className="scanner-signals-col-sub">Forecast per symbol, sorted by confidence — highest first</span>
          </div>
          <div className="scanner-signals-table-wrap">
          <table className="kp-table">
            <thead>
              <tr>
                <th>Sr.No</th><th>Symbol</th><th>Direction</th><th>Confidence</th>
                <th>Close</th><th>Predicted Close</th><th>Horizon</th><th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((r, i) => {
                const dm = DIRECTION_META[r.direction] || DIRECTION_META.neutral;
                const predClass = r.predictedClose > r.currentClose ? "kp-pred-up"
                  : r.predictedClose < r.currentClose ? "kp-pred-down" : "";
                return (
                  <tr key={r.symbol} className="scanner-signals-row" onClick={() => onRowClick(r.symbol)}>
                    <td>{i + 1}</td>
                    <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
                    <td><span className={`kp-dir-pill ${dm.cls}`}>{dm.label}</span></td>
                    <td>
                      <div className="kp-conf-bar-wrap">
                        <div className="kp-conf-bar-track">
                          <div
                            className="kp-conf-bar-fill"
                            style={{ width: `${r.confidence}%`, background: dm.cls === "kp-dir-up" ? "var(--green, #22c55e)" : dm.cls === "kp-dir-down" ? "var(--red, #ef4444)" : "var(--text2, #7a8099)" }}
                          />
                        </div>
                        <span className="kp-conf-num">{r.confidence.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="kp-close">{r.currentClose != null ? r.currentClose.toFixed(2) : "—"}</td>
                    <td className={`kp-pred-close ${predClass}`}>{r.predictedClose != null ? r.predictedClose.toFixed(2) : "—"}</td>
                    <td><span className="kp-horizon-tag">+{r.horizon} · {r.resolution}</span></td>
                    <td className="scanner-signals-ts">{r.scannedAt ? fmtTime(r.scannedAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
