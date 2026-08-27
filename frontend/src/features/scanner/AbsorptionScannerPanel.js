// AbsorptionScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// 9EMA Absorption / Flip Break strategy panel — Results / Doji Breakthroughs /
// Upcoming / History tabs. Same self-contained pattern as T5ScannerPanel.js:
// this component does NO pattern logic of its own, it only renders rows
// already shaped by absorptionResultShape.js's buildAbsorptionRows().
//
// Visual language ported from the user's own mockup
// (9EMA Absorption / Flip Break — Scanner.html) — same badge colors
// (amber = absorption break, green = flip up, red = flip down), same
// table layout — made data-driven and re-themed onto the app's real
// theme tokens (see AbsorptionScannerPanel.css), same as T5's CSS does.
//
// Doji Breakthroughs tab — every flip_break ("Breakthrough") signal that
// reaches this panel has ALREADY passed the backend's post-breakthrough
// Doji check (absorptionFlip.js only emits a flip_break event once a Doji
// candle shows up within 2 candles of the breakthrough candle — no event
// is emitted at all otherwise, so there's nothing to filter client-side).
// This tab exists purely so those confirmed breakthroughs are easy to find
// on their own instead of scanning them out of the mixed Results/History
// tables, and shows the confirming Doji candle's own timestamp alongside
// the breakthrough candle's.
//
// Symbol search — own state, own input, filters whichever tab is active
// (Results/Doji Breakthroughs/Upcoming/History independently). Download
// (below) exports the FULL unfiltered rows regardless of an active search
// — search only affects what's on screen.
//
// USAGE (drop into ScannerPage.js next to T5ScannerPanel):
//   import AbsorptionScannerPanel from "./AbsorptionScannerPanel";
//   import { buildAbsorptionRows } from "./absorptionResultShape";
//   ...
//   <AbsorptionScannerPanel
//     rows={buildAbsorptionRows(results)}   // { results, upcoming, history, dojiBreakthroughs }
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
import "./AbsorptionScannerPanel.css";

// Symbol search — matches against the raw symbol string and its clean
// ticker (e.g. "PAYTM" matches "NSE:PAYTM-EQ").
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
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="af-search-icon">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ── "What Broke" / "Watching" badge — mirrors the mockup's colored pills ──
function BreakBadge({ type, direction, side, stepNo }) {
  if (type === "absorption_break") {
    const up = direction === "up";
    const sideLabel = side === "resistance" ? "R" : "S";
    return (
      <span className={`af-broke ${up ? "abs-up" : "abs-dn"}`}>
        {up ? "\u25B2" : "\u25BC"} Absorption {sideLabel} Broken
        {stepNo != null && <span className="af-sidetag">{sideLabel}{stepNo}</span>}
      </span>
    );
  }
  // flip_break — every one of these already passed the backend's
  // post-breakthrough Doji check (see absorptionFlip.js), so the tag here
  // is just a visual confirmation, not a filter.
  const up = direction === "up";
  return (
    <span className={`af-broke ${up ? "flip-up" : "flip-dn"}`}>
      {up ? "\u25B2 Flip UP" : "\u25BC Flip DOWN"}
      <span className="af-sidetag">{side === "resistance" ? "Resistance" : "Support"}</span>
      <span className="af-sidetag af-dojitag" title="Doji candle confirmed within 2 candles of the breakthrough">Doji ✓</span>
    </span>
  );
}

function WatchBadge({ kind, side, regime }) {
  if (kind === "absorbing") {
    const isRes = side === "resistance";
    return (
      <span className={`af-broke ${isRes ? "abs-up" : "abs-dn"}`}>
        {"\u25CF"} Absorbing {isRes ? "R" : "S"}
      </span>
    );
  }
  // flip_watch — labeled by which direction WOULD fire, mirrors flip_break's
  // own convention: an "up" regime flips DOWN (through support), a "down"
  // regime flips UP (through resistance).
  const wouldFlipUp = regime === "down";
  return (
    <span className={`af-broke ${wouldFlipUp ? "flip-up" : "flip-dn"}`}>
      {wouldFlipUp ? "\u25B2 Watching Flip UP" : "\u25BC Watching Flip DOWN"}
    </span>
  );
}

function Dash() {
  return <span className="af-dash">&mdash;</span>;
}

// ── plain-text versions of BreakBadge / WatchBadge — same logic, used
// for the Excel export (cells need text, not JSX). ──────────────────────
function breakLabelText(r) {
  if (r.type === "absorption_break") {
    const up = r.direction === "up";
    const sideLabel = r.side === "resistance" ? "R" : "S";
    return `${up ? "Absorption UP" : "Absorption DOWN"} - ${sideLabel} Broken${r.stepNo != null ? ` (${sideLabel}${r.stepNo})` : ""}`;
  }
  const up = r.direction === "up";
  return `${up ? "Flip UP" : "Flip DOWN"} (${r.side === "resistance" ? "Resistance" : "Support"})`;
}

function dojiBreakthroughLabelText(r) {
  const up = r.direction === "up";
  return `${up ? "Flip UP" : "Flip DOWN"} (${r.side === "resistance" ? "Resistance" : "Support"}) - Doji confirmed`;
}

function watchLabelText(r) {
  if (r.kind === "absorbing") {
    const isRes = r.side === "resistance";
    return `Absorbing ${isRes ? "R" : "S"}`;
  }
  const wouldFlipUp = r.regime === "down";
  return wouldFlipUp ? "Watching Flip UP" : "Watching Flip DOWN";
}

function SymbolCell({ symbol }) {
  return (
    <span className="af-symbol">
      {tickerOf(symbol)}
      <span className="af-exch">{exchangeOf(symbol)}</span>
    </span>
  );
}

// ── event table (shared by Results / History) ──────────────────────────
function EventTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="af-empty">{emptyLabel}</div>;
  }
  return (
    <div className="af-table-wrap">
      <table className="af-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th>What Broke</th>
            <th className="num">Level</th>
            <th className="num">Weak</th>
            <th className="num">Poked</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.timeMs}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="af-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td>
                <BreakBadge type={r.type} direction={r.direction} side={r.side} stepNo={r.stepNo} />
              </td>
              <td className="af-level num">{fmt(r.level)}</td>
              <td className="af-poked num">{r.weak != null ? `\u00D7${r.weak}` : <Dash />}</td>
              <td className="af-poked num">{r.pokes != null ? `\u00D7${r.pokes}` : <Dash />}</td>
              <td className="af-time">{r.timeLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Doji Breakthrough table — flip_break events, Doji-confirmed by the
// backend, shown with their own confirming Doji candle's time. ─────────
function DojiBreakthroughTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="af-empty">{emptyLabel}</div>;
  }
  return (
    <div className="af-table-wrap">
      <table className="af-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th>Breakthrough</th>
            <th className="num">Level</th>
            <th>Breakthrough Time</th>
            <th>Doji Candle</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.timeMs}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="af-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td>
                <BreakBadge type={r.type} direction={r.direction} side={r.side} />
              </td>
              <td className="af-level num">{fmt(r.level)}</td>
              <td className="af-time">{r.timeLabel}</td>
              <td className="af-time">{r.dojiTimeLabel || <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Upcoming table — live absorbing bands / flip-watch, nearest first ──
function UpcomingTable({ rows, emptyLabel, onRowClick }) {
  if (rows.length === 0) {
    return <div className="af-empty">{emptyLabel}</div>;
  }
  return (
    <div className="af-table-wrap">
      <table className="af-table">
        <thead>
          <tr>
            <th>Sr</th>
            <th>Symbol</th>
            <th>Watching</th>
            <th className="num">Level</th>
            <th className="num">Close</th>
            <th className="num">Distance</th>
            <th className="num">Weak</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.kind}-${r.level}-${i}`} onClick={() => onRowClick(r.symbol)}>
              <td className="af-sr">{i + 1}</td>
              <td><SymbolCell symbol={r.symbol} /></td>
              <td><WatchBadge kind={r.kind} side={r.side} regime={r.regime} /></td>
              <td className="af-level num">{fmt(r.level)}</td>
              <td className="af-level num">{fmt(r.close)}</td>
              <td className="af-dist num">{fmt(r.distanceATR, 2)} ATR</td>
              <td className="af-poked num">{r.kind === "absorbing" && r.weak != null ? `\u00D7${r.weak}` : <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AbsorptionScannerPanel({
  rows = { results: [], upcoming: [], history: [], dojiBreakthroughs: [] },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");

  // Symbol search — own state, own input, filters whichever tab is
  // active (Results/Doji Breakthroughs/Upcoming/History independently).
  // Download (below) exports the FULL unfiltered rows regardless of an
  // active search — search only affects what's on screen.
  const [query, setQuery] = useState("");

  const results = useMemo(() => rows.results || [], [rows.results]);
  const upcoming = useMemo(() => rows.upcoming || [], [rows.upcoming]);
  const history = useMemo(() => rows.history || [], [rows.history]);
  const dojiBreakthroughs = useMemo(() => rows.dojiBreakthroughs || [], [rows.dojiBreakthroughs]);

  const filteredResults = useMemo(
    () => results.filter((r) => matchesSymbol(r.symbol, query)),
    [results, query]
  );
  const filteredUpcoming = useMemo(
    () => upcoming.filter((r) => matchesSymbol(r.symbol, query)),
    [upcoming, query]
  );
  const filteredHistory = useMemo(
    () => history.filter((r) => matchesSymbol(r.symbol, query)),
    [history, query]
  );
  const filteredDojiBreakthroughs = useMemo(
    () => dojiBreakthroughs.filter((r) => matchesSymbol(r.symbol, query)),
    [dojiBreakthroughs, query]
  );

  const stats = useMemo(() => {
    const absorptionBreaks = results.filter((r) => r.type === "absorption_break").length;
    const flipBreaks = results.filter((r) => r.type === "flip_break").length;
    return { absorptionBreaks, flipBreaks };
  }, [results]);

  const hasAnyRows = results.length > 0 || upcoming.length > 0 || history.length > 0 || dojiBreakthroughs.length > 0;

  // ── Download — Results / Doji Breakthroughs / Upcoming / History as
  // four sheets in one .xlsx, columns mirroring exactly what's on screen
  // in each tab. Always exports the FULL rows, not the search-filtered
  // view — search is an on-screen convenience, not a data scope. ────────
  function handleDownload() {
    if (!hasAnyRows) return;

    const eventRows = (rowsArr) =>
      rowsArr.map((r, i) => ({
        "Sr": i + 1,
        "Symbol": tickerOf(r.symbol),
        "Exchange": exchangeOf(r.symbol),
        "What Broke": breakLabelText(r),
        "Level": r.level ?? "",
        "Weak": r.weak != null ? r.weak : "",
        "Poked": r.pokes != null ? r.pokes : "",
        "Time": r.timeLabel || "",
      }));

    const dojiBreakthroughRows = dojiBreakthroughs.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Breakthrough": dojiBreakthroughLabelText(r),
      "Level": r.level ?? "",
      "Breakthrough Time": r.timeLabel || "",
      "Doji Candle Time": r.dojiTimeLabel || "",
    }));

    const upcomingRows = upcoming.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Watching": watchLabelText(r),
      "Level": r.level ?? "",
      "Close": r.close ?? "",
      "Distance (ATR)": r.distanceATR != null ? Number(r.distanceATR.toFixed(2)) : "",
      "Weak": r.kind === "absorbing" && r.weak != null ? r.weak : "",
    }));

    const resultsSheetRows = eventRows(results);
    const historySheetRows = eventRows(history);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(resultsSheetRows.length ? resultsSheetRows : [{ "Info": "Nothing broke today yet." }]),
      "Results"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(dojiBreakthroughRows.length ? dojiBreakthroughRows : [{ "Info": "No Doji-confirmed breakthroughs yet." }]),
      "Doji Breakthroughs"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(upcomingRows.length ? upcomingRows : [{ "Info": "Nothing currently absorbing or being watched for a flip." }]),
      "Upcoming"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(historySheetRows.length ? historySheetRows : [{ "Info": "No breaks from earlier days yet." }]),
      "History"
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, `absorption_scanner_${resolution}_${stamp}.xlsx`);
  }

  return (
    <div className="af-wrap">
      <div className="af-stats">
        <div className="af-stat">
          <div className="af-lbl">Scanned</div>
          <div className="af-val purple">{scannedCount}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Absorption Breaks (Today)</div>
          <div className="af-val amber">{stats.absorptionBreaks}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Flip Breaks (Today)</div>
          <div className="af-val blue">{stats.flipBreaks}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Doji Breakthroughs</div>
          <div className="af-val green">{dojiBreakthroughs.length}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Watching</div>
          <div className="af-val green">{upcoming.length}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Resolution</div>
          <div className="af-val purple">{resolution}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Last Scan</div>
          <div className="af-val" style={{ fontSize: 13 }}>{lastScan ? fmtTime(lastScan) : "—"}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Duration</div>
          <div className="af-val">{durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "—"}</div>
        </div>
      </div>

      <div className="af-tabs">
        <button className={`af-tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>
          Results <span className="af-count">({results.length})</span>
        </button>
        <button className={`af-tab ${tab === "doji" ? "active" : ""}`} onClick={() => setTab("doji")}>
          Doji Breakthroughs <span className="af-count">({dojiBreakthroughs.length})</span>
        </button>
        <button className={`af-tab ${tab === "upcoming" ? "active" : ""}`} onClick={() => setTab("upcoming")}>
          Upcoming <span className="af-count">({upcoming.length})</span>
        </button>
        <button className={`af-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
          History <span className="af-count">({history.length})</span>
        </button>

        <div className="af-tabs-right">
          <div className={`af-search ${query ? "has-val" : ""}`}>
            <SearchGlyph />
            <input
              type="text"
              placeholder="Search symbol…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="af-search-clear" onClick={() => setQuery("")} title="Clear search">
                &times;
              </button>
            )}
          </div>

          <button
            className="af-download-btn"
            onClick={handleDownload}
            disabled={!hasAnyRows}
            title="Download Results, Doji Breakthroughs, Upcoming & History as one Excel file"
          >
            ⬇ Download
          </button>
        </div>
      </div>

      {tab === "results" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Absorption extremes and flip levels closed through TODAY &middot; newest first</span>
          </div>
          <EventTable
            rows={filteredResults}
            emptyLabel={query ? `No results match "${query}"` : "Nothing broke today yet."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {tab === "doji" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Breakthroughs where a Doji candle showed up within 2 candles of the break &middot; every row here already satisfies that condition &middot; newest first</span>
          </div>
          <DojiBreakthroughTable
            rows={filteredDojiBreakthroughs}
            emptyLabel={query ? `No breakthroughs match "${query}"` : "No Doji-confirmed breakthroughs yet."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {tab === "upcoming" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Live absorbing bands and the current flip-watch level &middot; sorted closest-to-break first (ATR-normalized)</span>
          </div>
          <UpcomingTable
            rows={filteredUpcoming}
            emptyLabel={query ? `No upcoming rows match "${query}"` : "Nothing currently absorbing or being watched for a flip."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      {tab === "history" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Same events, from earlier days &middot; kept, not deleted, just out of today's feed</span>
          </div>
          <EventTable
            rows={filteredHistory}
            emptyLabel={query ? `No history rows match "${query}"` : "No breaks from earlier days yet."}
            onRowClick={onRowClick}
          />
        </div>
      )}

      <div className="af-legend">
        <b>Absorption R/S Broken</b> &mdash; the band's tested-extreme (absHi/absLo) got closed through.{" "}
        <b>Weak &times;N</b> is the weak-test count (&ge;3 by default) that flagged it ABSORBING &mdash; matches the
        chart's own amber "ABSORBING R &times;3" alert. <b>Poked &times;N</b> is a separate number &mdash; the band's
        own wick-through count, matching the chart's "POKED &times;N" band-state label.<br />
        <b>Flip UP</b> / <b>Flip DOWN</b> &mdash; the regime's own refSWH/refSWL step-line broke; no Weak/Poked count
        applies (a flip is a single close-through, not a tested band). Every Flip UP/DOWN signal shown anywhere in
        this panel already required a <b>Doji</b> candle within the 2 candles right after the breakthrough candle
        &mdash; if no Doji showed up, the breakthrough is never surfaced at all. The <b>Doji Breakthroughs</b> tab
        pulls just those confirmed signals out on their own, alongside the exact Doji candle's timestamp.<br />
        <b>Upcoming</b> shows what hasn't broken yet: bands still in the ABSORBING watch-state, and the current
        flip-watch level, sorted by how close price is to breaking each one (in ATRs, not raw price &mdash; keeps a
        &#8377;40-ATR stock and a &#8377;3-ATR stock fairly ranked against each other).
      </div>
    </div>
  );
}