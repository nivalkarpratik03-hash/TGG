// AbsorptionScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// 9EMA Absorption / Flip Break strategy panel — Results / Upcoming /
// History tabs. Same self-contained pattern as T5ScannerPanel.js: this
// component does NO pattern logic of its own, it only renders rows
// already shaped by absorptionResultShape.js's buildAbsorptionRows().
//
// Visual language ported from the user's own mockup
// (9EMA Absorption / Flip Break — Scanner.html) — same badge colors
// (amber = absorption break, green = flip up, red = flip down), same
// table layout — made data-driven and re-themed onto the app's real
// theme tokens (see AbsorptionScannerPanel.css), same as T5's CSS does.
//
// USAGE (drop into ScannerPage.js next to T5ScannerPanel):
//   import AbsorptionScannerPanel from "./AbsorptionScannerPanel";
//   import { buildAbsorptionRows } from "./absorptionResultShape";
//   ...
//   <AbsorptionScannerPanel
//     rows={buildAbsorptionRows(results)}   // { results, upcoming, history }
//     scannedCount={results.length}
//     resolution={tfLabel}
//     onRowClick={(symbol) => openChart(symbol, timeframe, null)}
//   />
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import { tickerOf, exchangeOf } from "../../utils/symbolMeta";
import { fmt } from "../../utils/format";
import "./AbsorptionScannerPanel.css";

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
  // flip_break
  const up = direction === "up";
  return (
    <span className={`af-broke ${up ? "flip-up" : "flip-dn"}`}>
      {up ? "\u25B2 Flip UP" : "\u25BC Flip DOWN"}
      <span className="af-sidetag">{side === "resistance" ? "Resistance" : "Support"}</span>
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
  rows = { results: [], upcoming: [], history: [] },
  scannedCount = 0,
  resolution = "15m",
  onRowClick = () => {},
}) {
  const [tab, setTab] = useState("results");

  const results = rows.results || [];
  const upcoming = rows.upcoming || [];
  const history = rows.history || [];

  const stats = useMemo(() => {
    const absorptionBreaks = results.filter((r) => r.type === "absorption_break").length;
    const flipBreaks = results.filter((r) => r.type === "flip_break").length;
    return { absorptionBreaks, flipBreaks };
  }, [results]);

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
          <div className="af-lbl">Watching</div>
          <div className="af-val green">{upcoming.length}</div>
        </div>
        <div className="af-stat">
          <div className="af-lbl">Resolution</div>
          <div className="af-val purple">{resolution}</div>
        </div>
      </div>

      <div className="af-tabs">
        <button className={`af-tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>
          Results <span className="af-count">({results.length})</span>
        </button>
        <button className={`af-tab ${tab === "upcoming" ? "active" : ""}`} onClick={() => setTab("upcoming")}>
          Upcoming <span className="af-count">({upcoming.length})</span>
        </button>
        <button className={`af-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
          History <span className="af-count">({history.length})</span>
        </button>
      </div>

      {tab === "results" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Absorption extremes and flip levels closed through TODAY &middot; newest first</span>
          </div>
          <EventTable rows={results} emptyLabel="Nothing broke today yet." onRowClick={onRowClick} />
        </div>
      )}

      {tab === "upcoming" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Live absorbing bands and the current flip-watch level &middot; sorted closest-to-break first (ATR-normalized)</span>
          </div>
          <UpcomingTable rows={upcoming} emptyLabel="Nothing currently absorbing or being watched for a flip." onRowClick={onRowClick} />
        </div>
      )}

      {tab === "history" && (
        <div className="af-panel active">
          <div className="af-subrow">
            <span className="af-sub">Same events, from earlier days &middot; kept, not deleted, just out of today's feed</span>
          </div>
          <EventTable rows={history} emptyLabel="No breaks from earlier days yet." onRowClick={onRowClick} />
        </div>
      )}

      <div className="af-legend">
        <b>Absorption R/S Broken</b> &mdash; the band's tested-extreme (absHi/absLo) got closed through.{" "}
        <b>Weak &times;N</b> is the weak-test count (&ge;3 by default) that flagged it ABSORBING &mdash; matches the
        chart's own amber "ABSORBING R &times;3" alert. <b>Poked &times;N</b> is a separate number &mdash; the band's
        own wick-through count, matching the chart's "POKED &times;N" band-state label.<br />
        <b>Flip UP</b> / <b>Flip DOWN</b> &mdash; the regime's own refSWH/refSWL step-line broke; no Weak/Poked count
        applies (a flip is a single close-through, not a tested band).<br />
        <b>Upcoming</b> shows what hasn't broken yet: bands still in the ABSORBING watch-state, and the current
        flip-watch level, sorted by how close price is to breaking each one (in ATRs, not raw price &mdash; keeps a
        &#8377;40-ATR stock and a &#8377;3-ATR stock fairly ranked against each other).
      </div>
    </div>
  );
}
