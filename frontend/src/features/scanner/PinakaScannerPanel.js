// PinakaScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// Pinaka (A1/A2/B/B2) strategy panel. Same self-contained pattern as
// S1S2S3ScannerPanel.js / CeilingBreakScannerPanel.js: this component
// does NO pattern logic of its own — `rows` is already shaped by
// pinakaResultShape.js's buildPinakaRows() from the raw scan() results
// backend/src/strategies/pinaka.js returns, which themselves come from
// the ONE shared engine, frontend/src/strategies/pinakaEngine.js (the
// same file the chart overlay, PinakaIndicator.js, imports directly —
// see that file's header).
//
// Three main tabs — Results / Upcoming / History — same split as
// CeilingBreakScannerPanel.js, plus an All/A1/A2/B/B2 sub-filter that
// applies inside whichever main tab is open (Pinaka-specific; Ceiling
// Break has no signal-type filter since it only has one event family).
//
// USAGE:
//   <PinakaScannerPanel
//     rows={pinakaRows}               // { results, upcoming, history, counts }
//     scannedCount={results.length}
//     resolution={tfLabel}
//     lastScan={lastScan}
//     durationMs={status?.lastScanDurationMs}
//     onRowClick={(symbol) => openPinakaChart(symbol, timeframe)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { formatDateTimeIST } from "../../utils/istUtils";
import { fmtTime } from "./mwScanHelpers";
import { tickerOf, exchangeOf } from "../../utils/symbolMeta";
import "./ScannerPage.css";

const TYPE_META = {
  A1: { label: "A1", color: "#00c853", title: "Long — continuation" },
  A2: { label: "A2", color: "#2979ff", title: "Long — reversal" },
  B: { label: "B", color: "#ff1744", title: "Short — extended top" },
  B2: { label: "B2", color: "#8d1a1a", title: "Short — failed poke" },
};

function matchesSymbol(symbol, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    symbol.toLowerCase().includes(q) ||
    tickerOf(symbol).toLowerCase().includes(q)
  );
}

function TypeBadge({ tag }) {
  const meta = TYPE_META[tag] || { label: tag, color: "#9e9e9e", title: "" };
  return (
    <span
      title={meta.title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontWeight: 700,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        color: meta.color,
        border: `1px solid ${meta.color}`,
        background: "rgba(8,9,13,0.5)",
      }}
    >
      {meta.label}
    </span>
  );
}

function SideTag({ side }) {
  return (
    <span className={`scanner-signals-mw ${side === "long" ? "bull" : "bear"}`}>
      {side === "long" ? "▲ Long" : "▼ Short"}
    </span>
  );
}

// ── Results table — latest A1/A2/B/B2 per symbol (unchanged) ────────
function ResultsTable({ rows, emptyLabel, onRowClick }) {
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
            <th>Signal</th>
            <th>Side</th>
            <th>Close</th>
            <th># Signals</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.symbol}
              className="scanner-signals-row"
              onClick={() => onRowClick(r.symbol)}
              title="Open chart with Pinaka overlay"
            >
              <td>{i + 1}</td>
              <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
              <td><TypeBadge tag={r.tag} /></td>
              <td><SideTag side={r.side} /></td>
              <td>{r.close != null ? r.close.toFixed(2) : "—"}</td>
              <td>{r.signalCount}</td>
              <td className="scanner-signals-ts">{formatDateTimeIST(r.time || r.scannedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Upcoming table — setups building, not fired yet ──────────────────
function UpcomingTable({ rows, emptyLabel, onRowClick }) {
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
            <th>Signal</th>
            <th>Stage</th>
            <th>Waiting For</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.symbol}-${r.tag}-${i}`}
              className="scanner-signals-row"
              onClick={() => onRowClick(r.symbol)}
              title="Open chart with Pinaka overlay"
            >
              <td>{i + 1}</td>
              <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
              <td><TypeBadge tag={r.tag} /></td>
              <td>{r.stage}</td>
              <td className="scanner-signals-ts">{r.waiting}</td>
              <td className="scanner-signals-ts">{formatDateTimeIST(r.since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History table — every past A1/A2/B/B2 trigger, its own row ──────
function HistoryTable({ rows, emptyLabel, onRowClick }) {
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
            <th>Signal</th>
            <th>Side</th>
            <th>Close</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.symbol}-${r.tag}-${r.time}-${i}`}
              className="scanner-signals-row"
              onClick={() => onRowClick(r.symbol)}
              title="Open chart with Pinaka overlay"
            >
              <td>{i + 1}</td>
              <td className="scanner-signals-sym">{tickerOf(r.symbol)}</td>
              <td><TypeBadge tag={r.tag} /></td>
              <td><SideTag side={r.side} /></td>
              <td>{r.close != null ? r.close.toFixed(2) : "—"}</td>
              <td className="scanner-signals-ts">{formatDateTimeIST(r.time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PinakaScannerPanel({
  rows = { results: [], upcoming: [], history: [], counts: { a1: 0, a2: 0, b: 0, b2: 0 } },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  onRowClick = () => { },
}) {
  const [mainTab, setMainTab] = useState("results"); // results | upcoming | history
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all"); // all | A1 | A2 | B | B2

  const results = useMemo(() => rows.results || [], [rows.results]);
  const upcoming = useMemo(() => rows.upcoming || [], [rows.upcoming]);
  const history = useMemo(() => rows.history || [], [rows.history]);

  const passesFilter = (r) =>
    matchesSymbol(r.symbol, query) && (typeFilter === "all" || r.tag === typeFilter);

  const filteredResults = useMemo(() => results.filter(passesFilter), [results, query, typeFilter]);
  const filteredUpcoming = useMemo(() => upcoming.filter(passesFilter), [upcoming, query, typeFilter]);
  const filteredHistory = useMemo(() => history.filter(passesFilter), [history, query, typeFilter]);

  const counts = rows.counts || { a1: 0, a2: 0, b: 0, b2: 0 };
  const hasAnyRows = results.length > 0 || upcoming.length > 0 || history.length > 0;

  // ── Download — Results / Upcoming / History as three sheets in one
  // .xlsx, columns mirroring what's on screen in each tab. Always
  // exports the FULL rows, not the search/type-filtered view — same
  // rule as CeilingBreakScannerPanel.js's handleDownload. ────────────
  function handleDownload() {
    if (!hasAnyRows) return;

    const resultsRows = results.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Signal": r.tag || "",
      "Side": r.side === "long" ? "Long" : "Short",
      "Close": r.close != null ? r.close.toFixed(2) : "",
      "# Signals": r.signalCount ?? "",
      "Timestamp": formatDateTimeIST(r.time || r.scannedAt),
    }));

    const upcomingRows = upcoming.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Signal": r.tag || "",
      "Stage": r.stage || "",
      "Waiting For": r.waiting || "",
      "Since": formatDateTimeIST(r.since),
    }));

    const historyRows = history.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Signal": r.tag || "",
      "Side": r.side === "long" ? "Long" : "Short",
      "Close": r.close != null ? r.close.toFixed(2) : "",
      "Timestamp": formatDateTimeIST(r.time),
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(resultsRows.length ? resultsRows : [{ "Info": "No signals yet." }]),
      "Results"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(upcomingRows.length ? upcomingRows : [{ "Info": "No setups currently building." }]),
      "Upcoming"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(historyRows.length ? historyRows : [{ "Info": "No past signals yet." }]),
      "History"
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, `pinaka_scanner_${resolution}_${stamp}.xlsx`);
  }

  return (
    <div className="s3-wrap">
      <div className="scanner-stats-row">
        <div className="stat-chip"><span className="stat-chip-label">Scanned</span><span className="stat-chip-val accent">{scannedCount}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">A1</span><span className="stat-chip-val green">{counts.a1}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">A2</span><span className="stat-chip-val accent">{counts.a2}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">B</span><span className="stat-chip-val" style={{ color: "#ff1744" }}>{counts.b}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">B2</span><span className="stat-chip-val" style={{ color: "#8d1a1a" }}>{counts.b2}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Resolution</span><span className="stat-chip-val accent">{resolution}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Last Scan</span><span className="stat-chip-val" style={{ fontSize: 11 }}>{lastScan ? fmtTime(lastScan) : "—"}</span></div>
        <div className="stat-chip"><span className="stat-chip-label">Duration</span><span className="stat-chip-val">{durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "—"}</span></div>
      </div>

      {/* Main tabs — Results / Upcoming / History */}
      <div className="scanner-maintabs">
        <button className={`scanner-maintab ${mainTab === "results" ? "active" : ""}`} onClick={() => setMainTab("results")}>
          Results <span className="scanner-maintab-count">({results.length})</span>
        </button>
        <button className={`scanner-maintab ${mainTab === "upcoming" ? "active" : ""}`} onClick={() => setMainTab("upcoming")}>
          Upcoming <span className="scanner-maintab-count">({upcoming.length})</span>
        </button>
        <button className={`scanner-maintab ${mainTab === "history" ? "active" : ""}`} onClick={() => setMainTab("history")}>
          History <span className="scanner-maintab-count">({history.length})</span>
        </button>
      </div>

      {/* All/A1/A2/B/B2 filter + search + download — applies inside whichever main tab is open */}
      <div className="scanner-signals-tabs">
        {["all", "A1", "A2", "B", "B2"].map((t) => (
          <button
            key={t}
            className={`scanner-signals-tab ${typeFilter === t ? "active" : ""}`}
            onClick={() => setTypeFilter(t)}
          >
            {t === "all" ? "All" : t}
          </button>
        ))}

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

          <button
            className="scanner-download-btn"
            onClick={handleDownload}
            disabled={!hasAnyRows}
            title="Download Results, Upcoming & History as one Excel file"
          >
            ⬇ Download
          </button>
        </div>
      </div>

      {mainTab === "results" && (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-sub">
              Most recent A1/A2/B/B2 trade signal per symbol — one row per symbol, newest first
            </span>
          </div>
          <ResultsTable
            rows={filteredResults}
            emptyLabel={query || typeFilter !== "all" ? "No rows match your filters" : "No signals yet"}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {mainTab === "upcoming" && (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-sub">
              Setups currently building — condition sequence started but the entry candle hasn't fired yet
            </span>
          </div>
          <UpcomingTable
            rows={filteredUpcoming}
            emptyLabel={query || typeFilter !== "all" ? "No rows match your filters" : "No setups currently building"}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {mainTab === "history" && (
        <div className="scanner-signals-col">
          <div className="scanner-signals-col-header">
            <span className="scanner-signals-col-sub">
              Every past A1/A2/B/B2 trigger, one row per signal — newest first
            </span>
          </div>
          <HistoryTable
            rows={filteredHistory}
            emptyLabel={query || typeFilter !== "all" ? "No rows match your filters" : "No past signals yet"}
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