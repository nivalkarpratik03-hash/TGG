// CeilingBreakScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// Ceiling Break & Retest strategy panel — Results / Upcoming / History
// tabs. Same self-contained pattern as AbsorptionScannerPanel.js: this
// component does NO pattern logic and NO retest logic of its own, it
// only renders rows already shaped by ceilingBreakResultShape.js's
// buildCeilingBreakRows(). Same 3-tab skeleton, own columns, same
// Excel export pattern (search-unfiltered, 3 sheets, one .xlsx).
//
// Results tab is HETEROGENEOUS by design (mirrors the row shape
// ceilingBreakResultShape.js produces, which itself mirrors the
// absorptionResultShape.js's buildUpcomingRows() "mixed kind in one
// array" precedent): every row has a `kind` of either
//   "active"      — the symbol's sequence is watching/retested RIGHT
//                    NOW (state.state), one row per symbol.
//   "fired_today" — the symbol is idle again but something resolved
//                    (HIGHER_LOW / NO_RETEST / FAILED_RETEST) today,
//                    one row PER such event.
// The table below reads both shapes through small accessor helpers
// (rowLevel/rowZoneLabel/rowReason/rowSignal/rowTimeLabel) rather than
// two separate tables, so a symbol's status is never split across two
// tabs on the same render.
//
// USAGE (drop into ScannerPage.js next to AbsorptionScannerPanel):
//   import CeilingBreakScannerPanel from "./CeilingBreakScannerPanel";
//   import { buildCeilingBreakRows } from "./ceilingBreakResultShape";
//   ...
//   <CeilingBreakScannerPanel
//     rows={buildCeilingBreakRows(results)}   // { upcoming, results, history }
//     scannedCount={results.length}
//     resolution={tfLabel}
//     lastScan={lastScan}
//     durationMs={status?.lastScanDurationMs}
//     onRowClick={(symbol) => openChart(symbol, timeframe, null)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { tickerOf, exchangeOf } from "../../utils/symbolMeta";
import { fmt } from "../../utils/format";
import { fmtTime } from "./mwScanHelpers";
import "./CeilingBreakScannerPanel.css";

// Symbol search — same matching rule as AbsorptionScannerPanel.js:
// matches the raw symbol string and its clean ticker.
function matchesSymbol(symbol, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (symbol || "").toLowerCase().includes(q) ||
    tickerOf(symbol).toLowerCase().includes(q)
  );
}

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="cbr-search-icon">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Dash() {
  return <span className="cbr-dash">&mdash;</span>;
}

// ── event-type badge — one color per engine event type (see
// ceilingBreakRetest.js's `emit()` calls: CEILING_BROKEN, RETEST,
// FAILED_RETEST, NO_RETEST, HIGHER_LOW) ─────────────────────────────
const EVENT_BADGE = {
  CEILING_BROKEN: { cls: "cbr-broken", glyph: "\u25B2", label: "Ceiling Broken" },
  RETEST: { cls: "cbr-retest", glyph: "\u25CF", label: "Retest" },
  FAILED_RETEST: { cls: "cbr-failed", glyph: "\u25BC", label: "Failed Retest" },
  NO_RETEST: { cls: "cbr-noretest", glyph: "\u25B2", label: "No Retest" },
  HIGHER_LOW: { cls: "cbr-higherlow", glyph: "\u2605", label: "Higher Low" },
};

function EventBadge({ type, isEntrySignal }) {
  const meta = EVENT_BADGE[type] || { cls: "cbr-noretest", glyph: "", label: type || "—" };
  return (
    <span className={`cbr-badge ${meta.cls}`}>
      {meta.glyph} {meta.label}
      {isEntrySignal && <span className="cbr-entrytag" title="HIGHER_LOW — the strategy's entry signal">Entry</span>}
    </span>
  );
}

function eventLabelText(type, isEntrySignal) {
  const meta = EVENT_BADGE[type] || { label: type || "" };
  return `${meta.label}${isEntrySignal ? " (Entry)" : ""}`;
}

// ── live-state badge — for "active" Results rows (state.state, NOT
// an event type) ────────────────────────────────────────────────────
function StateBadge({ state }) {
  if (state === "watching") {
    return <span className="cbr-badge cbr-watching">{"\u25CF"} Watching</span>;
  }
  if (state === "retested") {
    return <span className="cbr-badge cbr-retested">{"\u25C6"} Retested</span>;
  }
  return <Dash />;
}

function stateLabelText(state) {
  if (state === "watching") return "Watching";
  if (state === "retested") return "Retested";
  return "";
}

function SymbolCell({ symbol }) {
  return (
    <span className="cbr-symbol">
      {tickerOf(symbol)}
      <span className="cbr-exch">{exchangeOf(symbol)}</span>
    </span>
  );
}

// ── Results row accessors — read either row `kind` uniformly ───────
function rowSignal(r) {
  if (r.kind === "active") return <StateBadge state={r.state} />;
  return <EventBadge type={r.type} isEntrySignal={r.isEntrySignal} />;
}
function rowSignalText(r) {
  if (r.kind === "active") return stateLabelText(r.state);
  return eventLabelText(r.type, r.isEntrySignal);
}
function rowLevel(r) {
  return r.kind === "active" ? r.ceilingLevel : r.level;
}
function rowZoneLabel(r) {
  if (r.kind !== "active" || r.zoneLo == null || r.zoneHi == null) return null;
  return `${fmt(r.zoneLo)} \u2013 ${fmt(r.zoneHi)}`;
}
function rowReason(r) {
  if (r.kind === "active") return r.latestEvent ? r.latestEvent.reason : null;
  return r.reason;
}
function rowTimeLabel(r) {
  if (r.kind === "active") return r.latestEvent ? r.latestEvent.timeLabel : null;
  return r.timeLabel;
}

// ── Results table — mixed "active" / "fired_today" rows ────────────
function ResultsTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="cbr-empty">{emptyLabel}</div>;
  }
  return (
    <div className="cbr-table-wrap">
      <table className="cbr-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th>Signal</th>
            <th className="num">Level</th>
            <th>Zone</th>
            <th>Reason</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.kind}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="cbr-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td>{rowSignal(r)}</td>
              <td className="cbr-level num">{fmt(rowLevel(r))}</td>
              <td className="cbr-zone">{rowZoneLabel(r) || <Dash />}</td>
              <td className="cbr-reason">{rowReason(r) || <Dash />}</td>
              <td className="cbr-time">{rowTimeLabel(r) || <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Upcoming table — idle + hasCeiling, nearest-to-ceiling first ───
function UpcomingTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="cbr-empty">{emptyLabel}</div>;
  }
  return (
    <div className="cbr-table-wrap">
      <table className="cbr-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th className="num">Ceiling Level</th>
            <th className="num">Close</th>
            <th className="num">Distance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.ceilingLevel}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="cbr-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td className="cbr-level num">{fmt(r.ceilingLevel)}</td>
              <td className="cbr-level num">{fmt(r.close)}</td>
              <td className="cbr-dist num">{fmt(r.distancePct * 100, 2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History table — earlier-day events, any type ────────────────────
function HistoryTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="cbr-empty">{emptyLabel}</div>;
  }
  return (
    <div className="cbr-table-wrap">
      <table className="cbr-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th>Event</th>
            <th className="num">Level</th>
            <th className="num">Price</th>
            <th>Reason</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.timeMs}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="cbr-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td><EventBadge type={r.type} isEntrySignal={r.isEntrySignal} /></td>
              <td className="cbr-level num">{fmt(r.level)}</td>
              <td className="cbr-level num">{fmt(r.price)}</td>
              <td className="cbr-reason">{r.reason || <Dash />}</td>
              <td className="cbr-time">{r.timeLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CeilingBreakScannerPanel({
  rows = { upcoming: [], results: [], history: [] },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");
  const [query, setQuery] = useState("");

  const upcoming = useMemo(() => rows.upcoming || [], [rows.upcoming]);
  const results = useMemo(() => rows.results || [], [rows.results]);
  const history = useMemo(() => rows.history || [], [rows.history]);

  const filteredUpcoming = useMemo(
    () => upcoming.filter((r) => matchesSymbol(r.symbol, query)),
    [upcoming, query]
  );
  const filteredResults = useMemo(
    () => results.filter((r) => matchesSymbol(r.symbol, query)),
    [results, query]
  );
  const filteredHistory = useMemo(
    () => history.filter((r) => matchesSymbol(r.symbol, query)),
    [history, query]
  );

  const stats = useMemo(() => {
    const active = results.filter((r) => r.kind === "active").length;
    const entriesToday = results.filter((r) => r.kind === "fired_today" && r.isEntrySignal).length;
    return { active, entriesToday };
  }, [results]);

  const hasAnyRows = upcoming.length > 0 || results.length > 0 || history.length > 0;

  // ── Download — Results / Upcoming / History as three sheets in one
  // .xlsx, columns mirroring what's on screen in each tab. Always
  // exports the FULL rows, not the search-filtered view — same rule
  // as AbsorptionScannerPanel.js's handleDownload. ────────────────────
  function handleDownload() {
    if (!hasAnyRows) return;

    const resultsRows = results.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Signal": rowSignalText(r),
      "Level": rowLevel(r) ?? "",
      "Zone": rowZoneLabel(r) || "",
      "Reason": rowReason(r) || "",
      "Time": rowTimeLabel(r) || "",
    }));

    const upcomingRows = upcoming.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Ceiling Level": r.ceilingLevel ?? "",
      "Close": r.close ?? "",
      "Distance (%)": r.distancePct != null ? Number((r.distancePct * 100).toFixed(2)) : "",
    }));

    const historyRows = history.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Event": eventLabelText(r.type, r.isEntrySignal),
      "Level": r.level ?? "",
      "Price": r.price ?? "",
      "Reason": r.reason || "",
      "Time": r.timeLabel || "",
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(resultsRows.length ? resultsRows : [{ "Info": "No active or today-resolved sequences yet." }]),
      "Results"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(upcomingRows.length ? upcomingRows : [{ "Info": "No idle ceilings currently identified." }]),
      "Upcoming"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(historyRows.length ? historyRows : [{ "Info": "No events from earlier days yet." }]),
      "History"
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, `ceiling_break_scanner_${resolution}_${stamp}.xlsx`);
  }

  return (
    <div className="cbr-wrap">
      <div className="cbr-stats">
        <div className="cbr-stat">
          <div className="cbr-lbl">Scanned</div>
          <div className="cbr-val purple">{scannedCount}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Active (Watching/Retested)</div>
          <div className="cbr-val amber">{stats.active}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Entries Today</div>
          <div className="cbr-val green">{stats.entriesToday}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Results</div>
          <div className="cbr-val green">{results.length}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Upcoming</div>
          <div className="cbr-val blue">{upcoming.length}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Resolution</div>
          <div className="cbr-val purple">{resolution}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Last Scan</div>
          <div className="cbr-val" style={{ fontSize: 13 }}>{lastScan ? fmtTime(lastScan) : "—"}</div>
        </div>
        <div className="cbr-stat">
          <div className="cbr-lbl">Duration</div>
          <div className="cbr-val">{durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "—"}</div>
        </div>
      </div>

      <div className="cbr-tabs">
        <button className={`cbr-tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>
          Results <span className="cbr-count">({results.length})</span>
        </button>
        <button className={`cbr-tab ${tab === "upcoming" ? "active" : ""}`} onClick={() => setTab("upcoming")}>
          Upcoming <span className="cbr-count">({upcoming.length})</span>
        </button>
        <button className={`cbr-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
          History <span className="cbr-count">({history.length})</span>
        </button>

        <div className="cbr-tabs-right">
          <div className={`cbr-search ${query ? "has-val" : ""}`}>
            <SearchGlyph />
            <input
              type="text"
              placeholder="Search symbol…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="cbr-search-clear" onClick={() => setQuery("")} title="Clear search">
                &times;
              </button>
            )}
          </div>

          <button
            className="cbr-download-btn"
            onClick={handleDownload}
            disabled={!hasAnyRows}
            title="Download Results, Upcoming & History as one Excel file"
          >
            ⬇ Download
          </button>
        </div>
      </div>

      {tab === "results" && (
        <div className="cbr-panel active">
          <div className="cbr-subrow">
            <span className="cbr-sub">Symbols with a live watching/retested sequence right now, plus symbols that resolved (Higher Low / No Retest / Failed Retest) earlier today &middot; active sequences first</span>
          </div>
          <ResultsTable
            rows={filteredResults}
            emptyLabel={query ? `No results match "${query}"` : "No active or today-resolved sequences yet."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {tab === "upcoming" && (
        <div className="cbr-panel active">
          <div className="cbr-subrow">
            <span className="cbr-sub">Ceilings identified (2+ clustered pivot highs) with no breakout sequence in progress &middot; sorted closest-to-ceiling first (% distance)</span>
          </div>
          <UpcomingTable
            rows={filteredUpcoming}
            emptyLabel={query ? `No upcoming rows match "${query}"` : "No idle ceilings currently identified."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {tab === "history" && (
        <div className="cbr-panel active">
          <div className="cbr-subrow">
            <span className="cbr-sub">Same events, from earlier days &middot; kept, not deleted, just out of today's feed</span>
          </div>
          <HistoryTable
            rows={filteredHistory}
            emptyLabel={query ? `No history rows match "${query}"` : "No events from earlier days yet."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      <div className="cbr-legend">
        <b>Ceiling</b> &mdash; a resistance level formed by clustering 2+ confirmed pivot highs within tolerance.{" "}
        <b>Ceiling Broken</b> marks the breakout close above it.<br />
        <b>Retest</b> &mdash; price pulled back into the ceiling zone after breaking out (a genuine retest, being
        watched for a Higher Low entry). <b>Failed Retest</b> &mdash; the ceiling gave way (a swing low broke down
        through it). <b>No Retest</b> &mdash; price extended and held above the ceiling without ever pulling back
        (a frictionless move, nothing to enter on).<br />
        <b>Higher Low</b> &mdash; after a retest, price reclaimed the ceiling and printed a higher low. This is the
        strategy's <b>entry signal</b>, tagged with the green <b>Entry</b> pill wherever it appears.<br />
        <b>Results</b> shows two kinds of rows: symbols with a sequence <b>currently</b> Watching or Retested (live,
        actionable now), and symbols that resolved earlier <b>today</b> (idle again, but worth reviewing what just
        happened). <b>Upcoming</b> shows ceilings that exist but haven't broken out yet, sorted by how close price
        currently is to each one.
      </div>
    </div>
  );
}
