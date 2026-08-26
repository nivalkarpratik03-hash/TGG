// TypeScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// "Type E,R,F" strategy family panel — Results / Upcoming tabs, plus
// the R/E/F sub-filter. Same self-contained pattern as
// S1S2S3ScannerPanel.js / T5ScannerPanel.js / AbsorptionScannerPanel.js:
// own stats row, own tabs, own symbol search box.
//
// typeREF.js's scanForType() shapes results totally differently from
// s1s2s3: no r.s1/r.s2/r.s3 candle objects. Instead: r.type
// ("R"|"E"|"F"|null for the combined view), r.entry/r.exit prices,
// r.mw/r.mwTime/r.dw/r.dwTime, r.patternStage is "completed" | "active"
// | "none". This table reads that shape directly.
//
// The R/E/F sub-filter is the ONE piece of state this panel does NOT
// own itself: switching it changes which backend strategy id
// (type-ref vs type-e/-r/-f) ScannerPage.js fetches, so that state —
// and the fetch it triggers — has to stay up in ScannerPage.js. This
// panel just renders the buttons and calls back up via
// onTypeSubFilterChange, exactly the same UI/behavior as before, just
// relocated.
//
// USAGE:
//   <TypeScannerPanel
//     rows={{ results: resultsTable, upcoming: upcomingTable }}
//     counts={counts}                 // { signals, partial, s1 }
//     scannedCount={results.length}
//     resolution={tfLabel}
//     lastScan={lastScan}
//     durationMs={status?.lastScanDurationMs}
//     timeframe={timeframe}
//     typeSubFilter={typeSubFilter}
//     onTypeSubFilterChange={setTypeSubFilter}
//     onRowClick={(symbol, mw) => openChart(symbol, timeframe, mw)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import { formatDateTimeIST } from "../../utils/istUtils";
import { fmtTime } from "./mwScanHelpers";
import { fmt } from "../../utils/format";
import { tickerOf } from "../../utils/symbolMeta";
import "./ScannerPage.css";
import "./TypeScannerPanel.css";

function matchesSymbol(symbol, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    symbol.toLowerCase().includes(q) ||
    tickerOf(symbol).toLowerCase().includes(q)
  );
}

function TypeSignalsTable({ rows, showExit, emptyLabel, onRowClick }) {
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
            <th>Type</th>
            <th>Entry</th>
            {showExit && <th>Exit</th>}
            <th>DW</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const dwBull = r.dw === "bullish" || r.dw === "up" || r.dw === true;
            const latest = r.events && r.events.length ? r.events[r.events.length - 1] : null;
            const entryTime = latest?.entryTime ?? null;
            const exitTime = latest?.exited ? latest?.exitTime : null;
            return (
              <tr
                key={r.symbol}
                className="scanner-signals-row"
                onClick={() => onRowClick(r.symbol, r.motherwave)}
                title="Open chart with Fib drawn"
              >
                <td>{i + 1}</td>
                <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
                <td>{r.type || "—"}</td>
                <td className={`scanner-signals-flag ${r.entry != null ? "on" : ""}`}>
                  {r.entry != null ? (
                    <div className="scanner-signals-stage">
                      <span className="scanner-signals-stage-check">✓</span>
                      <span className="scanner-signals-stage-ts">{fmt(r.entry)}{entryTime ? ` · ${formatDateTimeIST(entryTime)}` : ""}</span>
                    </div>
                  ) : "—"}
                </td>
                {showExit && (
                  <td className={`scanner-signals-flag ${r.exit != null ? "on" : ""}`}>
                    {r.exit != null ? (
                      <div className="scanner-signals-stage">
                        <span className="scanner-signals-stage-check">✓</span>
                        <span className="scanner-signals-stage-ts">{fmt(r.exit)}{exitTime ? ` · ${formatDateTimeIST(exitTime)}` : ""}</span>
                      </div>
                    ) : "—"}
                  </td>
                )}
                <td>
                  {r.dw ? (
                    <span className={`scanner-signals-mw ${dwBull ? "bull" : "bear"}`}>
                      {dwBull ? "▲ Bull" : "▼ Bear"}
                    </span>
                  ) : "—"}
                </td>
                <td className="scanner-signals-ts">{formatDateTimeIST(r.dwTime || r.scannedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TypeScannerPanel({
  rows = { results: [], upcoming: [] },
  counts = { signals: 0, partial: 0, s1: 0 },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  timeframe,
  typeSubFilter = "all",
  onTypeSubFilterChange = () => { },
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
    <div className="tp-wrap">
      <div className="scanner-stats-row">
        <div className="stat-chip"><span className="stat-chip-label">Scanned</span><span className="stat-chip-val accent">{scannedCount}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Full Signals</span><span className="stat-chip-val green">{counts.signals}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Active</span><span className="stat-chip-val orange">{counts.partial}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Ever Triggered</span><span className="stat-chip-val">{counts.s1}</span></div>
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

        <div className="scanner-signals-typefilter">
          {["all", "R", "E", "F"].map((t) => (
            <button
              key={t}
              className={`scanner-signals-typefilter-btn ${typeSubFilter === t ? "active" : ""}`}
              onClick={() => onTypeSubFilterChange(t)}
              title={t === "all" ? "Combined — whichever of E/R/F most recently triggered" : `Type ${t} only`}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>

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
            <span className="scanner-signals-col-sub">Entry → exit confirmed — all, scroll for more</span>
          </div>
          <TypeSignalsTable
            rows={filteredResults}
            showExit={true}
            emptyLabel={query ? `No results match "${query}"` : "No completed signals yet"}
            onRowClick={onRowClick}
          />
        </div>
      ) : (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-title">Upcoming</span>
            <span className="scanner-signals-col-sub">Entry fired, still active — all, scroll for more</span>
          </div>
          <TypeSignalsTable
            rows={filteredUpcoming}
            showExit={false}
            emptyLabel={query ? `No upcoming rows match "${query}"` : "No active signals yet"}
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
