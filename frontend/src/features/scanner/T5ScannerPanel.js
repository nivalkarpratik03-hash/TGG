// T5ScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// TG T5 strategy panel — Results / Upcoming tabs, P1–P6 point timeline,
// live status pills, blinking flip-watch. Visual design ported 1:1 from
// the user's own mockup (t5-scanner-mockup-v2.html) — same colors,
// same layout, same blink keyframe — just made data-driven.
//
// USAGE (drop into ScannerPage.js next to the other per-strategy tabs):
//   import T5ScannerPanel from "./T5ScannerPanel";
//   ...
//   <T5ScannerPanel
//     rows={t5Rows}          // { results: [...], upcoming: [...] } — see t5ResultShape.js buildScannerRows()
//     scannedCount={n}
//     totalSymbols={826}
//     onRowClick={(symbol) => navigate(buildChartUrl(symbol, timeframe))}
//     onScanNow={() => runScan()}
//   />
//
// `rows` is expected to already be shaped by t5ResultShape.js's
// buildScannerRows(scanResultsArray) — this component does no pattern
// logic of its own, purely renders.
// ─────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from "react";
import "./T5ScannerPanel.css";

function SideBadge({ side }) {
  const isH = side === "T5H";
  return (
    <span className={`t5-side ${isH ? "h" : "l"}`}>
      {isH ? "T5H \u25bc" : "T5L \u25b2"}
    </span>
  );
}

function PointsRow({ side, points, done }) {
  const cls = side === "T5H" ? "h" : "l";
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const label = `P${i + 1}`;
        const isDone = i < done;
        const t = points[i];
        return isDone ? (
          <span key={i} className={`t5-pt on ${cls}`} title={`${label} \u00b7 ${t || "—"}`}>
            {label}
          </span>
        ) : (
          <span key={i} className="t5-pt off" title={`${label} \u00b7 not yet formed`}>
            {label}
          </span>
        );
      })}
    </>
  );
}

function StatusBadge({ status, statusNote }) {
  return (
    <>
      <span className={`t5-status ${status}`}>{status}</span>
      {statusNote ? <span className="t5-status-note"> &middot; {statusNote}</span> : null}
    </>
  );
}

function StagePill({ stageText, stage }) {
  return <span className="t5-stagepill">stage {stage} &middot; {stageText}</span>;
}

function FlipWatch({ flip, flipName }) {
  if (!flip) return <span className="t5-dash">&mdash;</span>;
  return (
    <span className="t5-flipwatch">
      <span className="t5-flipdot" />
      {flipName}
    </span>
  );
}

export default function T5ScannerPanel({
  rows = { results: [], upcoming: [] },
  scannedCount = 0,
  resolution = "15m",
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");

  const stats = useMemo(() => {
    const results = rows.results || [];
    const upcoming = rows.upcoming || [];
    const fired = results.length;
    const watching = results.filter((r) => r.status === "live").length;
    const forming = upcoming.length;
    return { fired, watching, forming };
  }, [rows]);

  const results = rows.results || [];
  const upcoming = rows.upcoming || [];

  return (
    <div className="t5-wrap">
      <div className="t5-stats">
        <div className="t5-stat">
          <div className="t5-lbl">Scanned</div>
          <div className="t5-val purple">{scannedCount}</div>
        </div>
        <div className="t5-stat">
          <div className="t5-lbl">Fired</div>
          <div className="t5-val green">{stats.fired}</div>
        </div>
        <div className="t5-stat">
          <div className="t5-lbl">Watching (live)</div>
          <div className="t5-val amber">{stats.watching}</div>
        </div>
        <div className="t5-stat">
          <div className="t5-lbl">Forming</div>
          <div className="t5-val red">{stats.forming}</div>
        </div>
        <div className="t5-stat">
          <div className="t5-lbl">Resolution</div>
          <div className="t5-val purple">{resolution}</div>
        </div>
      </div>

      <div className="t5-tabs">
        <button
          className={`t5-tab ${tab === "results" ? "active" : ""}`}
          onClick={() => setTab("results")}
        >
          Results <span className="t5-count">({results.length})</span>
        </button>
        <button
          className={`t5-tab ${tab === "upcoming" ? "active" : ""}`}
          onClick={() => setTab("upcoming")}
        >
          Upcoming <span className="t5-count">({upcoming.length})</span>
        </button>
      </div>

      {tab === "results" && (
        <div className="t5-panel active">
          <div className="t5-subrow">
            <span className="t5-sub">
              Main trigger fired (T5H4 / T5L4 or later) &mdash; latest 10 &middot; hover a point for its candle time
            </span>
          </div>
          <table className="t5-table">
            <colgroup>
              <col style={{ width: 30 }} /><col style={{ width: 120 }} /><col style={{ width: 60 }} />
              <col style={{ width: 200 }} /><col style={{ width: 150 }} /><col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr><th>Sr</th><th>Symbol</th><th>Side</th><th>P1&ndash;P6</th><th>Tag / status</th><th>Time</th></tr>
            </thead>
            <tbody>
              {results.slice(0, 10).map((r, i) => (
                <tr key={r.symbol + i} onClick={() => onRowClick(r.symbol)}>
                  <td>{i + 1}</td>
                  <td className="t5-sym">{r.symbol}</td>
                  <td><SideBadge side={r.side} /></td>
                  <td><PointsRow side={r.side} points={r.points} done={r.done} /></td>
                  <td className="t5-tagcell">
                    <div className="t5-tag">{r.tag}</div>
                    <StatusBadge status={r.status} statusNote={r.statusNote} />
                  </td>
                  <td className="t5-time">{r.time}</td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan={6} className="t5-empty">Nothing has fired P4 yet — check Upcoming.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "upcoming" && (
        <div className="t5-panel active">
          <div className="t5-subrow">
            <span className="t5-sub">Forming &mdash; stage 1 to 3, main trigger (P4) not fired yet</span>
          </div>
          <table className="t5-table">
            <colgroup>
              <col style={{ width: 30 }} /><col style={{ width: 120 }} /><col style={{ width: 60 }} />
              <col style={{ width: 190 }} /><col style={{ width: 150 }} /><col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr><th>Sr</th><th>Symbol</th><th>Side</th><th>Stage</th><th>Flip watch</th><th>Time</th></tr>
            </thead>
            <tbody>
              {upcoming.slice(0, 10).map((r, i) => (
                <tr key={r.symbol + i} className={r.flip ? "t5-flip-row" : ""} onClick={() => onRowClick(r.symbol)}>
                  <td>{i + 1}</td>
                  <td className="t5-sym">{r.symbol}</td>
                  <td><SideBadge side={r.side} /></td>
                  <td><StagePill stageText={r.stageText} stage={r.stage} /></td>
                  <td><FlipWatch flip={r.flip} flipName={r.flipName} /></td>
                  <td className="t5-time">{r.time}</td>
                </tr>
              ))}
              {upcoming.length === 0 && (
                <tr><td colSpan={6} className="t5-empty">Nothing forming right now.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="t5-legend">
        <b>How to read P1&ndash;P6:</b> it's a timeline, not a checklist &mdash; only the points that have actually
        happened light up, the rest stay dashed. The main SHORT/LONG trigger fires at point 4; points 5 and 6 are
        what happens after &mdash; either confirmation the move is real, or a flip that cancels it.<br />
        <b>Status</b> tells you where a fired row stands right now:{" "}
        <span className="t5-status live">live</span> still tracking P5/P6,{" "}
        <span className="t5-status confirmed">confirmed</span> ran the full P5&ndash;P6 sequence,{" "}
        <span className="t5-status cancelled">cancelled</span> a later flip retracted the original trigger.<br />
        <b>T5H</b> = double top, arms in an uptrend, fires SHORT. <b>T5L</b> = double bottom, arms in a downtrend,
        fires LONG.
      </div>
    </div>
  );
}