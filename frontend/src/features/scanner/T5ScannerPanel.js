// T5ScannerPanel.js
// ─────────────────────────────────────────────────────────────────
// TG T5 strategy panel — Results / Upcoming / History tabs, P1–P6 point
// timeline, live status pills, blinking flip-watch. Visual design ported
// 1:1 from the user's own mockup (t5-scanner-mockup-v2.html) — same
// colors, same layout, same blink keyframe — just made data-driven.
//
// USAGE (drop into ScannerPage.js next to the other per-strategy tabs):
//   import T5ScannerPanel from "./T5ScannerPanel";
//   ...
//   <T5ScannerPanel
//     rows={t5Rows}          // { results, upcoming, history } — see t5ResultShape.js buildScannerRows()
//     scannedCount={n}
//     totalSymbols={826}
//     onRowClick={(symbol) => navigate(buildChartUrl(symbol, timeframe))}
//     onScanNow={() => runScan()}
//   />
//
// `rows` is expected to already be shaped by t5ResultShape.js's
// buildScannerRows(scanResultsArray) — this component does no pattern
// logic of its own, purely renders.
//
// RESULTS/UPCOMING/HISTORY REDESIGN (Aug 2026):
//   - Upcoming is now strictly stage 1-2 (candidate / armed). Stage 3
//     (P3 formed) moved OUT of Upcoming and into Results as a "forming"
//     row — it's closer to tradeable than a stage-1/2 candidate, so it
//     belongs in the live feed, not buried in the pre-trigger tab.
//   - Results only ever shows what's CURRENT: forming (P3), live (P4,
//     watching P5/P6), or a confirmed/cancelled/flipped close from
//     TODAY. Once a closed cycle ages past today it's moved to History
//     by t5ResultShape.js — never deleted, just out of the live feed.
//   - History is a 3rd tab on THIS panel (not a separate page/route), so
//     it only exists while the T5 strategy filter is open, same as
//     Results/Upcoming already do.
//   - Flipped is now its own column/badge, not text buried inside the
//     status note — reads row.flipped / row.flippedTag directly.
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

// Dedicated Flipped column badge — reads row.flipped/row.flippedTag
// directly instead of the flip reason being buried inside statusNote
// text (see file header, Aug 2026 redesign).
function FlippedBadge({ flipped, flippedTag }) {
  if (!flipped) return <span className="t5-dash">&mdash;</span>;
  return (
    <span className="t5-flippedbadge" title={flippedTag || "flipped"}>
      &#8635; {flippedTag}
    </span>
  );
}

export default function T5ScannerPanel({
  rows = { results: [], upcoming: [], history: [] },
  scannedCount = 0,
  resolution = "15m",
  onRowClick = () => { },
}) {
  const [tab, setTab] = useState("results");

  const stats = useMemo(() => {
    const results = rows.results || [];
    const upcoming = rows.upcoming || [];
    // "Fired" = a trigger actually went off (P4/live, or a closed
    // confirmed/cancelled/flipped row). "Forming" rows (stage 3, no tag
    // yet) haven't fired anything, so they no longer count as Fired —
    // they instead fold into Forming below, alongside stage 1-2.
    const fired = results.filter((r) => r.status !== "forming").length;
    const watching = results.filter((r) => r.status === "live").length;
    const forming = upcoming.length + results.filter((r) => r.status === "forming").length;
    return { fired, watching, forming };
  }, [rows]);

  const results = rows.results || [];
  const upcoming = rows.upcoming || [];
  const history = rows.history || [];

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
        <button
          className={`t5-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          History <span className="t5-count">({history.length})</span>
        </button>
      </div>

      {tab === "results" && (
        <div className="t5-panel active">
          <div className="t5-subrow">
            <span className="t5-sub">
              What's live right now &mdash; P3 forming, P4 fired, or closed today &middot; hover a point for its candle time
            </span>
          </div>
          <div className="t5-table-wrap">
            <table className="t5-table">
              <colgroup>
                <col style={{ width: 30 }} /><col style={{ width: 110 }} /><col style={{ width: 60 }} />
                <col style={{ width: 180 }} /><col style={{ width: 140 }} /><col style={{ width: 110 }} /><col style={{ width: 90 }} />
              </colgroup>
              <thead>
                <tr><th>Sr</th><th>Symbol</th><th>Side</th><th>P1&ndash;P6</th><th>Tag / status</th><th>Flipped</th><th>Time</th></tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={r.symbol + i} onClick={() => onRowClick(r.symbol)}>
                    <td>{i + 1}</td>
                    <td className="t5-sym">{r.symbol}</td>
                    <td><SideBadge side={r.side} /></td>
                    <td><PointsRow side={r.side} points={r.points} done={r.done} /></td>
                    <td className="t5-tagcell">
                      {r.tag ? <div className="t5-tag">{r.tag}</div> : null}
                      <StatusBadge status={r.status} statusNote={r.statusNote} />
                    </td>
                    <td><FlippedBadge flipped={r.flipped} flippedTag={r.flippedTag} /></td>
                    <td className="t5-time">{r.time}</td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan={7} className="t5-empty">Nothing live right now &mdash; check Upcoming.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "upcoming" && (
        <div className="t5-panel active">
          <div className="t5-subrow">
            <span className="t5-sub">Forming &mdash; stage 1 to 2, P3 not formed yet</span>
          </div>
          <div className="t5-table-wrap">
            <table className="t5-table">
              <colgroup>
                <col style={{ width: 30 }} /><col style={{ width: 120 }} /><col style={{ width: 60 }} />
                <col style={{ width: 190 }} /><col style={{ width: 150 }} /><col style={{ width: 96 }} />
              </colgroup>
              <thead>
                <tr><th>Sr</th><th>Symbol</th><th>Side</th><th>Stage</th><th>Flip watch</th><th>Time</th></tr>
              </thead>
              <tbody>
                {upcoming.map((r, i) => (
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
        </div>
      )}

      {tab === "history" && (
        <div className="t5-panel active">
          <div className="t5-subrow">
            <span className="t5-sub">
              Confirmed / cancelled / flipped closes from earlier days &mdash; kept, not deleted, just out of the live feed
            </span>
          </div>
          <div className="t5-table-wrap">
            <table className="t5-table t5-table-history">
              <colgroup>
                <col style={{ width: 30 }} /><col style={{ width: 110 }} /><col style={{ width: 60 }} />
                <col style={{ width: 180 }} /><col style={{ width: 140 }} /><col style={{ width: 110 }} /><col style={{ width: 90 }} />
              </colgroup>
              <thead>
                <tr><th>Sr</th><th>Symbol</th><th>Side</th><th>P1&ndash;P6</th><th>Tag / status</th><th>Flipped</th><th>Time</th></tr>
              </thead>
              <tbody>
                {history.map((r, i) => (
                  <tr key={r.symbol + i} onClick={() => onRowClick(r.symbol)}>
                    <td>{i + 1}</td>
                    <td className="t5-sym">{r.symbol}</td>
                    <td><SideBadge side={r.side} /></td>
                    <td><PointsRow side={r.side} points={r.points} done={r.done} /></td>
                    <td className="t5-tagcell">
                      {r.tag ? <div className="t5-tag">{r.tag}</div> : null}
                      <StatusBadge status={r.status} statusNote={r.statusNote} />
                    </td>
                    <td><FlippedBadge flipped={r.flipped} flippedTag={r.flippedTag} /></td>
                    <td className="t5-time">{r.time}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={7} className="t5-empty">No closed cycles from earlier days yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="t5-legend">
        <b>How to read P1&ndash;P6:</b> it's a timeline, not a checklist &mdash; only the points that have actually
        happened light up, the rest stay dashed. The main SHORT/LONG trigger fires at point 4; points 5 and 6 are
        what happens after &mdash; either confirmation the move is real, or a flip that cancels it.<br />
        <b>Status</b> tells you where a row stands right now:{" "}
        <span className="t5-status forming">forming</span> P3 formed, nothing fired yet,{" "}
        <span className="t5-status live">live</span> P4 fired, still tracking P5/P6,{" "}
        <span className="t5-status confirmed">confirmed</span> ran the full P5&ndash;P6 sequence,{" "}
        <span className="t5-status cancelled">cancelled</span> a later flip retracted the original trigger.<br />
        <b>Flipped</b> is its own column now &mdash; a badge shows up only when a flip disarmed the structure, with
        the exact flip tag that fired.<br />
        <b>Tabs:</b> Results = what's live right now (P3 onward). Upcoming = stage 1&ndash;2 only, before P3 forms.
        History = confirmed/cancelled/flipped closes from earlier days &mdash; kept here, out of the live feed.<br />
        <b>T5H</b> = double top, arms in an uptrend, fires SHORT. <b>T5L</b> = double bottom, arms in a downtrend,
        fires LONG.
      </div>
    </div>
  );
}