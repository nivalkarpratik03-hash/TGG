// S1S2S3ScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// Default motherwave-driven strategy family (S1 → S2 → S3 confirmation)
// panel — Results / Upcoming tabs. Same self-contained pattern as
// T5ScannerPanel.js / AbsorptionScannerPanel.js: own stats row, own
// tabs, own symbol search box baked directly into the panel, replacing
// the old shared `.scanner-stats-bar` + inline SignalsTable rendering
// that used to live in ScannerPage.js.
//
// This component does NO pattern logic of its own — `rows` is already
// shaped by ScannerPage.js (resultsTable/upcomingTable, filtered by
// r.patternStage and sorted by scannedAt, exactly as before), and
// `counts` is the same { signals, partial, s1 } object ScannerPage.js
// already computed. This panel just renders them, plus its own local
// tab switch and symbol search.
//
// USAGE:
//   <S1S2S3ScannerPanel
//     rows={{ results: resultsTable, upcoming: upcomingTable }}
//     counts={counts}                 // { signals, partial, s1 }
//     scannedCount={results.length}
//     resolution={tfLabel}
//     lastScan={lastScan}
//     durationMs={status?.lastScanDurationMs}
//     timeframe={timeframe}
//     onRowClick={(symbol, mw) => openChart(symbol, timeframe, mw)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import { formatDateTimeIST } from "../../utils/istUtils";
import { fmtTime, isMWBull } from "./mwScanHelpers";
import { tickerOf } from "../../utils/symbolMeta";
import "./ScannerPage.css";
import "./S1S2S3ScannerPanel.css";

// Candle stage timestamps — r.s1/r.s2/r.s3 are raw candle objects (see
// scannerS1.S2.S3.js's findS1S2S3), each carrying its own `.time`.
function s1Time(r) { return r.s1?.time || null; }
function s2Time(r) { return r.s2?.time || null; }
function s3Time(r) { return r.s3?.time || null; }
function mwTime(r) { return r?.motherwave?.wave?.toTime || null; }

// Symbol search — matches against the raw symbol string and its clean
// ticker (e.g. "RELIANCE" matches "NSE:RELIANCE-EQ").
function matchesSymbol(symbol, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    symbol.toLowerCase().includes(q) ||
    tickerOf(symbol).toLowerCase().includes(q)
  );
}

function SignalsTable({ rows, showS3, emptyLabel, timeframe, onRowClick }) {
  if (rows.length === 0) {
    return <div className="scanner-signals-empty">{emptyLabel}</div>;
  }
  return (
    <div className="scanner-signals-table-wrap">
      <table className="scanner-signals-table">
        <thead>
          <tr>
            <th>Sr.No</th>
            <th>Symbol</th>
            <th>S1</th>
            <th>S2</th>
            {showS3 && <th>S3</th>}
            <th>MW</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const bull = isMWBull(r);
            return (
              <tr
                key={r.symbol}
                className="scanner-signals-row"
                onClick={() => onRowClick(r.symbol, r.motherwave)}
                title="Open chart with Fib drawn"
              >
                <td>{i + 1}</td>
                <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
                <td className={`scanner-signals-flag ${r.s1 ? "on" : ""}`}>
                  {r.s1 ? (
                    <div className="scanner-signals-stage">
                      <span className="scanner-signals-stage-check">✓</span>
                      <span className="scanner-signals-stage-ts">{formatDateTimeIST(s1Time(r))}</span>
                    </div>
                  ) : "—"}
                </td>
                <td className={`scanner-signals-flag ${r.s2 ? "on" : ""}`}>
                  {r.s2 ? (
                    <div className="scanner-signals-stage">
                      <span className="scanner-signals-stage-check">✓</span>
                      <span className="scanner-signals-stage-ts">{formatDateTimeIST(s2Time(r))}</span>
                    </div>
                  ) : "—"}
                </td>
                {showS3 && (
                  <td className={`scanner-signals-flag ${r.s3 ? "on" : ""}`}>
                    {r.s3 ? (
                      <div className="scanner-signals-stage">
                        <span className="scanner-signals-stage-check">✓</span>
                        <span className="scanner-signals-stage-ts">{formatDateTimeIST(s3Time(r))}</span>
                      </div>
                    ) : "—"}
                  </td>
                )}
                <td>
                  <span className={`scanner-signals-mw ${bull ? "bull" : "bear"}`}>
                    {bull ? "▲ Bull" : "▼ Bear"}
                  </span>
                </td>
                <td className="scanner-signals-ts">{formatDateTimeIST(mwTime(r) || r.scannedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function S1S2S3ScannerPanel({
  rows = { results: [], upcoming: [] },
  counts = { signals: 0, partial: 0, s1: 0 },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  timeframe,
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");
  const [query, setQuery] = useState("");

  const filteredResults = useMemo(
    () => (rows.results || []).filter((r) => matchesSymbol(r.symbol, query)),
    [rows.results, query]
  );
  const filteredUpcoming = useMemo(
    () => (rows.upcoming || []).filter((r) => matchesSymbol(r.symbol, query)),
    [rows.upcoming, query]
  );

  return (
    <div className="s3-wrap">
      <div className="scanner-stats-row">
        <div className="stat-chip"><span className="stat-chip-label">Scanned</span><span className="stat-chip-val accent">{scannedCount}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Full Signals</span><span className="stat-chip-val green">{counts.signals}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Watching (S2)</span><span className="stat-chip-val orange">{counts.partial}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">S1 Formed</span><span className="stat-chip-val">{counts.s1}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Resolution</span><span className="stat-chip-val accent">{resolution}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Last Scan</span><span className="stat-chip-val" style={{ fontSize: 11 }}>{lastScan ? fmtTime(lastScan) : "—"}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Duration</span><span className="stat-chip-val">{durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "—"}</span></div>
      </div>

      <div className="scanner-signals-tabs">
        <button
          className={`scanner-signals-tab ${tab === "results" ? "active" : ""}`}
          onClick={() => setTab("results")}
        >
          Results
        </button>
        <button
          className={`scanner-signals-tab ${tab === "upcoming" ? "active" : ""}`}
          onClick={() => setTab("upcoming")}
        >
          Upcoming
        </button>

        <div className="scanner-signals-tabs-right">
          <div className={`scanner-search ${query ? "has-val" : ""}`}>
            <SearchGlyph />
            <input
              type="text"
              placeholder="Search symbol…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="scanner-search-clear" onClick={() => setQuery("")} title="Clear search">
                &times;
              </button>
            )}
          </div>
        </div>
      </div>

      {tab === "results" ? (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-title">Results</span>
            <span className="scanner-signals-col-sub">S1 → S2 → S3 confirmed — all, scroll for more</span>
          </div>
          <SignalsTable
            rows={filteredResults}
            showS3={true}
            emptyLabel={query ? `No results match "${query}"` : "No completed signals yet"}
            timeframe={timeframe}
            onRowClick={onRowClick}
          />
        </div>
      ) : (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-title">Upcoming</span>
            <span className="scanner-signals-col-sub">S1 → S2 confirmed, S3 pending — all, scroll for more</span>
          </div>
          <SignalsTable
            rows={filteredUpcoming}
            showS3={false}
            emptyLabel={query ? `No upcoming rows match "${query}"` : "No forming signals yet"}
            timeframe={timeframe}
            onRowClick={onRowClick}
          />
        </div>
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="scanner-search-icon">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
