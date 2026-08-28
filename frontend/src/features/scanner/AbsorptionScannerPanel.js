// AbsorptionScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// 9EMA Absorption / Flip Break strategy panel — Results / Upcoming /
// History tabs. Same self-contained pattern as T5ScannerPanel.js: this
// component does NO pattern logic and NO retest logic of its own, it
// only renders rows already shaped by absorptionResultShape.js's
// buildAbsorptionRows().
//
// Visual language ported from the user's own mockup
// (9EMA Absorption / Flip Break — Scanner.html) — same badge colors
// (amber = absorption break, green = flip up, red = flip down), same
// table layout — made data-driven and re-themed onto the app's real
// theme tokens (see AbsorptionScannerPanel.css), same as T5's CSS does.
//
// UPDATED (retest-entry spec, Chunk 2):
//   - The old "Results (today)" tab is REMOVED. A break that happened
//     today can never be Doji-confirmed yet (confirmation looks 2
//     candles forward), so that tab was structurally near-always empty.
//   - The old "Doji Breakthroughs" tab is RENAMED to "Results" — it is
//     now the only tab showing actionable, confirmed signals, of EITHER
//     type (absorption_break or flip_break), across every symbol, any
//     day. Every row here already passed the backend's post-breakthrough
//     Doji check (absorptionFlip.js only emits an event once a Doji
//     candle shows up within 2 candles of the triggering candle — no
//     event is emitted at all otherwise), and now ALSO carries its
//     retest-entry outcome (Entry/Stop/Target/Outcome/R — see Chunk 1's
//     computeRetestOutcome() in absorptionFlip.js, passed through
//     unchanged by absorptionResultShape.js).
//   - Final tab bar: Results | Upcoming | History.
//   - New DOJI (TODAY) summary card, RESULTS replaces the old DOJI
//     BREAKTHROUGHS card label. ABSORPTION BREAKS (TODAY) / FLIP BREAKS
//     (TODAY) are unchanged, still fed by the (no-longer-rendered)
//     today-only raw event count.
//
// Symbol search — own state, own input, filters whichever tab is active
// (Results/Upcoming/History independently). Download (below) exports the
// FULL unfiltered rows regardless of an active search — search only
// affects what's on screen.
//
// USAGE (drop into ScannerPage.js next to T5ScannerPanel):
//   import AbsorptionScannerPanel from "./AbsorptionScannerPanel";
//   import { buildAbsorptionRows } from "./absorptionResultShape";
//   ...
//   <AbsorptionScannerPanel
//     rows={buildAbsorptionRows(results)}   // { results, upcoming, history, dojiBreakthroughs, dojiTodayCount }
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
// Both event types (absorption_break and flip_break) now pass through the
// same backend Doji gate (see absorptionFlip.js's dojiWithinLookahead(),
// called from both the flip branches and the absorption-break branch), so
// every row reaching this component already has dojiConfirmed truthy. The
// tag below is shown from the row's own `dojiConfirmed` field rather than
// hardcoded per-type, so it stays correct even if that ever changes.
function BreakBadge({ type, direction, side, stepNo, dojiConfirmed }) {
  const dojiTag = dojiConfirmed ? (
    <span className="af-sidetag af-dojitag" title="Doji candle confirmed within 2 candles of the breakthrough">Doji ✓</span>
  ) : null;

  if (type === "absorption_break") {
    const up = direction === "up";
    const sideLabel = side === "resistance" ? "R" : "S";
    return (
      <span className={`af-broke ${up ? "abs-up" : "abs-dn"}`}>
        {up ? "\u25B2" : "\u25BC"} Absorption {sideLabel} Broken
        {stepNo != null && <span className="af-sidetag">{sideLabel}{stepNo}</span>}
        {dojiTag}
      </span>
    );
  }
  // flip_break
  const up = direction === "up";
  return (
    <span className={`af-broke ${up ? "flip-up" : "flip-dn"}`}>
      {up ? "\u25B2 Flip UP" : "\u25BC Flip DOWN"}
      <span className="af-sidetag">{side === "resistance" ? "Resistance" : "Support"}</span>
      {dojiTag}
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

// ── retest-entry outcome badge — mirrors event.retest.state exactly as
// computed by absorptionFlip.js's computeRetestOutcome() (Chunk 1); this
// component only maps that state string to a label/color, it does not
// decide or re-derive the outcome itself. ───────────────────────────────
function OutcomeBadge({ state }) {
  switch (state) {
    case "entered_win":
      return <span className="af-outcome af-outcome-win">Win</span>;
    case "entered_loss":
      return <span className="af-outcome af-outcome-loss">Loss</span>;
    case "entered_open":
      return <span className="af-outcome af-outcome-open">Open</span>;
    case "invalidated":
      return <span className="af-outcome af-outcome-invalidated">Invalidated</span>;
    case "watching":
      return <span className="af-outcome af-outcome-watching">Watching</span>;
    case "invalid_zero_risk":
      return <span className="af-outcome af-outcome-invalidated" title="Retest dip/rise touched the entry level exactly — no valid stop distance">Zero-Risk</span>;
    default:
      return <Dash />;
  }
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
  if (r.type === "absorption_break") {
    const sideLabel = r.side === "resistance" ? "R" : "S";
    return `${up ? "Absorption UP" : "Absorption DOWN"} - ${sideLabel} Broken${r.stepNo != null ? ` (${sideLabel}${r.stepNo})` : ""} - Doji confirmed`;
  }
  return `${up ? "Flip UP" : "Flip DOWN"} (${r.side === "resistance" ? "Resistance" : "Support"}) - Doji confirmed`;
}

// Plain-text version of OutcomeBadge, same state → label mapping, for the
// Excel export (cells need text, not JSX).
function outcomeLabelText(state) {
  switch (state) {
    case "entered_win": return "Win";
    case "entered_loss": return "Loss";
    case "entered_open": return "Open";
    case "invalidated": return "Invalidated";
    case "watching": return "Watching";
    case "invalid_zero_risk": return "Zero-Risk";
    default: return "";
  }
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
                <BreakBadge type={r.type} direction={r.direction} side={r.side} stepNo={r.stepNo} dojiConfirmed={r.dojiConfirmed} />
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

// ── Results table (renamed from "Doji Breakthrough table") — both
// absorption_break and flip_break events, Doji-confirmed by the backend,
// shown with their own confirming Doji candle's time PLUS the
// retest-entry outcome Chunk 1 attached (Entry/Stop/Target/Outcome/R).
// None of those five columns are computed here — they're a direct
// display of the row's own entryPrice/stopPrice/targetPrice/retestState/
// rMultiple fields, which absorptionResultShape.js already copied
// straight from event.retest. ────────────────────────────────────────────
function ResultsTable({ rows, emptyLabel, onRowClick }) {
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
            <th className="num">Entry</th>
            <th className="num">Stop</th>
            <th className="num">Target</th>
            <th>Outcome</th>
            <th className="num">R</th>
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
                <BreakBadge type={r.type} direction={r.direction} side={r.side} stepNo={r.stepNo} dojiConfirmed={r.dojiConfirmed} />
              </td>
              <td className="af-level num">{fmt(r.level)}</td>
              <td className="af-level num">{fmt(r.entryPrice)}</td>
              <td className="af-level num">{fmt(r.stopPrice)}</td>
              <td className="af-level num">{fmt(r.targetPrice)}</td>
              <td><OutcomeBadge state={r.retestState} /></td>
              <td className="af-level num">
                {r.rMultiple != null ? `${r.rMultiple > 0 ? "+" : ""}${r.rMultiple}R` : <Dash />}
              </td>
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
  rows = { results: [], upcoming: [], history: [], dojiBreakthroughs: [], dojiTodayCount: 0 },
  scannedCount = 0,
  resolution = "15m",
  lastScan = null,
  durationMs = null,
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");

  // Symbol search — own state, own input, filters whichever tab is
  // active (Results/Upcoming/History independently). Download (below)
  // exports the FULL unfiltered rows regardless of an active search —
  // search only affects what's on screen.
  const [query, setQuery] = useState("");

  // `results` (today-only raw events) is kept ONLY to feed the
  // ABSORPTION BREAKS (TODAY) / FLIP BREAKS (TODAY) summary cards below —
  // it is no longer rendered as its own tab (see file header comment).
  const results = useMemo(() => rows.results || [], [rows.results]);
  const upcoming = useMemo(() => rows.upcoming || [], [rows.upcoming]);
  const history = useMemo(() => rows.history || [], [rows.history]);
  // dojiBreakthroughs is now the "Results" tab's data source (renamed
  // from "Doji Breakthroughs"), already carrying its retest-entry outcome
  // per row (see absorptionResultShape.js's buildResultsRows()).
  const dojiBreakthroughs = useMemo(() => rows.dojiBreakthroughs || [], [rows.dojiBreakthroughs]);
  const dojiTodayCount = rows.dojiTodayCount || 0;

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

  const hasAnyRows = upcoming.length > 0 || history.length > 0 || dojiBreakthroughs.length > 0;

  // ── Download — Results / Upcoming / History as three sheets in one
  // .xlsx, columns mirroring exactly what's on screen in each tab. Always
  // exports the FULL rows, not the search-filtered view — search is an
  // on-screen convenience, not a data scope. ─────────────────────────────
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

    // Results sheet (renamed from "Doji Breakthroughs") — now includes the
    // retest-entry columns (Entry/Stop/Target/Outcome/R) alongside the
    // existing Weak/Poked columns, mirroring the ResultsTable on screen so
    // nothing is silently dropped from export.
    const resultsRows = dojiBreakthroughs.map((r, i) => ({
      "Sr": i + 1,
      "Symbol": tickerOf(r.symbol),
      "Exchange": exchangeOf(r.symbol),
      "Breakthrough": dojiBreakthroughLabelText(r),
      "Level": r.level ?? "",
      "Entry": r.entryPrice ?? "",
      "Stop": r.stopPrice ?? "",
      "Target": r.targetPrice ?? "",
      "Outcome": outcomeLabelText(r.retestState),
      "R": r.rMultiple != null ? r.rMultiple : "",
      "Weak": r.weak != null ? r.weak : "",
      "Poked": r.pokes != null ? r.pokes : "",
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

    const historySheetRows = eventRows(history);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(resultsRows.length ? resultsRows : [{ "Info": "No Doji-confirmed results yet." }]),
      "Results"
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
          <div className="af-lbl">Doji (Today)</div>
          <div className="af-val green">{dojiTodayCount}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Results</div>
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
          Results <span className="af-count">({dojiBreakthroughs.length})</span>
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
            title="Download Results, Upcoming & History as one Excel file"
          >
            ⬇ Download
          </button>
        </div>
      </div>

      {tab === "results" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Breakthroughs where a Doji candle showed up within 2 candles of the break, plus the retest-entry outcome (Entry/Stop/Target/Outcome/R) &middot; every row here already satisfies the Doji condition &middot; newest first</span>
          </div>
          <ResultsTable
            rows={filteredDojiBreakthroughs}
            emptyLabel={query ? `No results match "${query}"` : "No Doji-confirmed results yet."}
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
        <b>Flip UP</b> / <b>Flip DOWN</b> &mdash; the regime's own refSWH/refSWL step-line broke (a single
        close-through, not a tested band, so no Weak/Poked count applies).<br />
        Every signal shown anywhere in this panel &mdash; <b>both</b> Absorption R/S Broken <b>and</b> Flip UP/DOWN
        &mdash; already required a <b>Doji</b> candle within the 2 candles right after the triggering candle;
        if no Doji showed up, the event is never surfaced at all. The <b>Results</b> tab pulls just those confirmed
        signals (of either type) out on their own, alongside the exact Doji candle's timestamp.<br />
        <b>Retest-entry</b> (Entry/Stop/Target/Outcome/R columns on Results): once a signal's Doji is confirmed, the
        Doji's own high (bull) or low (bear) becomes the level to watch. Price may pull back any depth first &mdash;
        an <b>Entry</b> only triggers once price re-crosses back through that exact Doji level. <b>Stop</b> is the
        worst point of that pullback; <b>Target</b> is a flat 1:1 R from Entry/Stop. If price closes back into the
        original absorption/flip zone before ever re-crossing the Doji level, the setup is <b>Invalidated</b> &mdash;
        no entry is taken. <b>Outcome</b> shows where each setup currently stands (Win / Loss / Open / Invalidated /
        Watching); <b>R</b> is only meaningful once a trade has actually resolved (+1R win, -1R loss).<br />
        <b>Upcoming</b> shows what hasn't broken yet: bands still in the ABSORBING watch-state, and the current
        flip-watch level, sorted by how close price is to breaking each one (in ATRs, not raw price &mdash; keeps a
        &#8377;40-ATR stock and a &#8377;3-ATR stock fairly ranked against each other).
      </div>
    </div>
  );
}