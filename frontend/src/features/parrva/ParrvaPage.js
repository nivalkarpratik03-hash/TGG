// ParrvaPage.js  (2026-11-05 — live PaRRVA report)
// ─────────────────────────────────────────────────────────────────────────────
// Today tab : every PaRRVA call of the chosen day with live status (waiting / open / target /
//             SL / exited), live price and points, plus totals. Click a call for its 1-minute
//             chart (entry band, target, SL, entry/exit markers), bid/ask + 5-level depth,
//             50-level totals and the PaRRVA version history.
// History tab: daily and monthly totals for any date range.
//
// Everything comes from our backend (/api/parrva/*). The backend alone calls the PaRRVA API
// (once a minute in market hours), so this page can refresh as often as it likes.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createChart, LineStyle } from "lightweight-charts";
import { BACKEND } from "../../config";
import { useTheme } from "../../App";
import "./ParrvaPage.css";

const LIVE_MS = 5000;      // today's list refresh (our backend only)
const DETAIL_MS = 10000;   // open call detail refresh
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const monthStartIST = () => `${todayIST().slice(0, 8)}01`;

const STATE = {
  NO_DATA: ["No data", "grey"],
  WAITING: ["Waiting for entry", "grey"],
  OPEN: ["Open", "blue"],
  TARGET: ["Target hit", "green"],
  SL: ["SL hit", "red"],
  TRAIL_SL: ["Trailed SL hit", "green"],
  EXITED: ["Exited", "yellow"],
  CLOSED: ["Closed at EOD", "yellow"],
  NOT_TRIGGERED: ["Not triggered", "grey"],
  UNKNOWN: ["No record", "grey"],
};

const f2 = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "—" : Number(x).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const signed = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "—" : `${Number(x) > 0 ? "+" : ""}${f2(x)}`);
const pnlClass = (x) => (!Number.isFinite(Number(x)) || Number(x) === 0 ? "" : Number(x) > 0 ? "pv-green" : "pv-red");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "—");
const dayMonth = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }) : "—");
const ago = (ms) => (ms === null || ms === undefined ? "—" : ms < 2000 ? "just now" : ms < 120000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60000)}m ago`);

async function getJson(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

export default function ParrvaPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("today");
  const [day, setDay] = useState(todayIST());
  const [live, setLive] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const isToday = day === todayIST();

  const loadLive = useCallback(async () => {
    try {
      const d = await getJson(`${BACKEND}/api/parrva/live?date=${day}`);
      setLive(d);
      setError(d.feed && d.feed.lastError && !d.calls.length ? `PaRRVA API: ${d.feed.lastError}` : "");
    } catch (e) {
      setError(`Could not load: ${e.message}`);
    }
  }, [day]);

  useEffect(() => {
    setLive(null);
    loadLive();
    if (!isToday) return undefined;
    const id = setInterval(loadLive, LIVE_MS);
    return () => clearInterval(id);
  }, [loadLive, isToday]);

  const refreshNow = async () => {
    try { await getJson(`${BACKEND}/api/parrva/refresh`); } catch { /* shown by next load */ }
    loadLive();
  };

  const rec = live && live.recorder;
  const recAge = rec && rec.lastTickAt ? Date.now() - new Date(rec.lastTickAt).getTime() : null;
  const recOn = rec && rec.recording && recAge !== null && recAge < 30000;

  return (
    <div className="pv-page">
      <header className="pv-header">
        <button className="pv-back" onClick={() => navigate("/")}>← Home</button>
        <div className="pv-title">
          <h1>PaRRVA</h1>
          <div className="pv-tabs">
            <button className={tab === "today" ? "on" : ""} onClick={() => setTab("today")}>Live / Day</button>
            <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Daily / Monthly</button>
          </div>
        </div>
        <div className="pv-header-right">
          <span className={`pv-rec ${recOn ? "on" : ""}`} title={rec ? `${rec.mode} · ${rec.schedule}` : ""}>
            <span className="pv-dot" />{recOn ? "Recording" : rec && rec.running ? "Recorder starting" : "Not recording"}
          </span>
          <button className="pv-btn" onClick={refreshNow}>Refresh</button>
        </div>
      </header>

      {error && <div className="pv-error">{error}</div>}

      {tab === "today" ? (
        <>
          <section className="pv-filters">
            <label>Date<input type="date" value={day} max={todayIST()} onChange={(e) => { setDay(e.target.value || todayIST()); setOpenId(null); }} /></label>
            <button className={`pv-btn ${isToday ? "pv-btn-on" : ""}`} onClick={() => setDay(todayIST())}>Today</button>
            {live && Object.entries(live.index || {}).map(([sym, x]) => (
              <span key={sym} className="pv-index">{sym.replace(/^NSE:|^BSE:|-INDEX$/g, "")} <strong>{f2(x.ltp)}</strong> <span className={pnlClass(x.chp)}>{signed(x.chp)}%</span></span>
            ))}
            <div className="pv-meta">
              {live && live.feed && <>PaRRVA checked {time(live.feed.lastOkAt)} (every {live.feed.pollSec}s){live.feed.lastError ? ` · last error: ${live.feed.lastError}` : ""}</>}
            </div>
          </section>

          {live && <Summary s={live.summary} />}

          <section className="pv-list">
            {!live && !error && <div className="pv-empty">Loading…</div>}
            {live && live.calls.length === 0 && <div className="pv-empty">No PaRRVA calls on {dayMonth(day)}.</div>}
            {live && live.calls.map((c) => (
              <CallRow key={c.id} c={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} live={isToday} />
            ))}
          </section>
        </>
      ) : (
        <History />
      )}

      <section className="pv-raw">
        <button className="pv-raw-toggle" onClick={() => setShowRaw((x) => !x)}>{showRaw ? "▾" : "▸"} Raw PaRRVA response</button>
        {showRaw && <RawJson />}
      </section>
    </div>
  );
}

function Summary({ s }) {
  if (!s) return null;
  const tiles = [
    ["Calls", s.calls, "", s.excluded ? `+${s.excluded} before recording` : null], ["Target", s.target, "pv-green"], ["Trailed SL", s.trailSl || 0, "pv-green"], ["SL", s.sl, "pv-red"], ["Exited", s.exited + s.closed],
    ["Open", s.open, "pv-blue"], ["Waiting", s.waiting + s.notTriggered],
    ["Booked pts", signed(s.points), pnlClass(s.points)], ["Open pts", signed(s.openPoints), pnlClass(s.openPoints)],
    ["Win rate", s.winRate === null ? "—" : `${s.winRate}%`],
  ];
  return (
    <section className="pv-summary">
      {tiles.map(([k, v, cls, sub]) => (
        <div key={k} className="pv-tile">
          <span className="pv-k">{k}</span><span className={`pv-tile-v ${cls || ""}`}>{v}</span>
          {sub && <span className="pv-time">{sub}</span>}
        </div>
      ))}
    </section>
  );
}

function CallRow({ c, open, onToggle, live }) {
  const st = c.status || {};
  const pts = Number.isFinite(st.points) ? st.points : st.livePoints;
  const [label, baseColor] = STATE[st.state] || [st.state || "—", "grey"];
  const color = st.state === "TRAIL_SL" && Number.isFinite(pts) && pts < 0 ? "red" : baseColor;
  const ltp = c.market && Number.isFinite(c.market.ltp) ? c.market.ltp : st.ltp;
  return (
    <div className={`pv-row ${open ? "pv-row-open" : ""} ${c.excluded ? "pv-row-excluded" : ""}`}>
      <button className="pv-row-main" onClick={onToggle}>
        <div className="pv-col pv-col-id">
          <div className="pv-id">
            {c.name}<span className="pv-ver">v{c.version}</span>
            {c.product && <span className="pv-pack">{c.product}</span>}
            {c.exchange && <span className="pv-seg">{c.exchange}</span>}
          </div>
          <div className="pv-sym">
            <span className={`pv-side ${c.side === "SELL" ? "pv-sell" : "pv-buy"}`}>{c.side}</span>
            <strong>{c.label || c.instrument}</strong>
            <span className="pv-exch">· exp {dayMonth(c.expiry)}{c.intraday ? " · Intraday" : ""}</span>
          </div>
        </div>
        <div className="pv-col"><span className="pv-k">Entry</span><span className="pv-v">{f2(c.entryLo)} – {f2(c.entryHi)}</span></div>
        <div className="pv-col"><span className="pv-k">Target</span><span className="pv-v pv-green">{f2(c.target)}</span></div>
        <div className="pv-col"><span className="pv-k">Stop loss</span><span className="pv-v pv-red">{f2(c.sl)}</span></div>
        <div className="pv-col"><span className="pv-k">{live ? "LTP" : "Exit"}</span><span className="pv-v">{live ? f2(ltp) : f2(st.exitPrice ?? c.exit)}</span></div>
        <div className="pv-col"><span className="pv-k">Points</span><span className={`pv-v ${pnlClass(pts)}`}>{signed(pts)}{st.state === "OPEN" ? " *" : ""}</span></div>
        <div className="pv-col pv-col-right">
          <span className={`pv-status pv-st-${color}`}>{label}</span>
          {c.excluded && <span className="pv-badge-soft" title={`Published before the recorder started (${time(c.recordingStartedAt)}). Shown, but not in the totals.`}>Before recording</span>}
          {!c.excluded && c.versionsIncomplete && <span className="pv-badge-soft" title="Some versions were changed before the dashboard saw them, so early levels may be missing.">Versions partly missing</span>}
          <span className="pv-time">{time(c.createdAt)}{c.updatedAt && c.updatedAt !== c.createdAt ? ` · upd ${time(c.updatedAt)}` : ""}</span>
          {c.symbolError && <span className="pv-time pv-red" title={c.symbolError}>no market data</span>}
        </div>
      </button>
      {open && <CallDetail id={c.id} live={live} />}
    </div>
  );
}

function CallDetail({ id, live }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try { setD(await getJson(`${BACKEND}/api/parrva/call/${id}`)); setErr(""); } catch (e) { setErr(e.message); }
  }, [id]);
  useEffect(() => {
    load();
    if (!live) return undefined;
    const t = setInterval(load, DETAIL_MS);
    return () => clearInterval(t);
  }, [load, live]);

  if (err && !d) return <div className="pv-detail"><div className="pv-error">{err}</div></div>;
  if (!d) return <div className="pv-detail"><div className="pv-empty">Loading…</div></div>;
  const c = d.call, st = c.status || {}, m = c.market;
  return (
    <div className="pv-detail">
      <div className="pv-detail-chart">
        <div className="pv-detail-title">
          {c.symbol || c.label} · 1 minute
          {c.symbolError && <span className="pv-red"> · {c.symbolError}</span>}
        </div>
        {d.candles.length ? <TradeChart candles={d.candles} call={c} /> : <div className="pv-empty">No candles yet for this contract.</div>}
        <div className="pv-facts">
          <span>Entry {st.entryAt ? `${time(st.entryAt)} @ ${f2(st.entryPrice)}${st.fill === "open" ? " (minute open)" : st.fill === "band" ? " (band edge)" : st.fill === "tick" ? " (live tick)" : ""}` : "—"}</span>
          <span>Exit {st.exitAt ? `${time(st.exitAt)} @ ${f2(st.exitPrice)}` : "—"}</span>
          <span>Best {signed(st.mfe)}</span><span>Worst {signed(st.mae)}</span>
          {st.sameMinute && <span className="pv-yellow">Target and SL in the same minute (counted as SL)</span>}
          {st.trailed && <span className="pv-green">Stop loss was trailed to {f2(st.exitPrice)} (at or above the fill)</span>}
          {st.levelsUsed && <span>Levels at exit / now: T {f2(st.levelsUsed.target)} · SL {f2(st.levelsUsed.sl)}</span>}
          {c.excluded && <span className="pv-yellow">Before recording started: not counted in totals</span>}
          {st.note && <span>{st.note}</span>}
        </div>
      </div>
      <div className="pv-detail-side">
        <h3>Market {m ? <span className="pv-time">({ago(m.ageMs)})</span> : null}</h3>
        {m ? (
          <>
            <div className="pv-kv">
              <span>LTP</span><strong>{f2(m.ltp)}</strong>
              <span>Bid / Ask</span><strong>{f2(m.bid)} / {f2(m.ask)}</strong>
              <span>Spread</span><strong>{Number.isFinite(m.ask - m.bid) ? f2(m.ask - m.bid) : "—"}</strong>
              <span>Volume</span><strong>{f2(m.vol)}</strong>
              <span>OI</span><strong>{f2(m.oi)}</strong>
            </div>
            {m.depth5 && <Depth title="5-level depth" bids={m.depth5.bids} asks={m.depth5.asks} />}
            {m.depth50 ? (
              <div className="pv-kv pv-d50">
                <span>50-level</span><strong>{m.depth50.levelsBid} bid / {m.depth50.levelsAsk} ask levels</strong>
                <span>Total buy / sell</span><strong>{f2(m.depth50.tbq)} / {f2(m.depth50.tsq)}</strong>
                <span>Book qty</span><strong>{f2(m.depth50.bidQty)} / {f2(m.depth50.askQty)}</strong>
              </div>
            ) : <div className="pv-time">50-level depth: only for the 5 newest open calls while recording.</div>}
          </>
        ) : <div className="pv-time">{live ? "No live data — the recorder is not running or this contract is not subscribed." : "Live market data is only kept for today."}</div>}
        <h3>Versions (PaRRVA)</h3>
        <table className="pv-table">
          <thead><tr><th>v</th><th>Entry</th><th>Target</th><th>SL</th><th>Exit</th><th>At</th></tr></thead>
          <tbody>
            {(d.versions.length ? d.versions : [{ version: c.version, entryLo: c.entryLo, entryHi: c.entryHi, target: c.target, sl: c.sl, exit: c.exit, at: c.updatedAt }]).map((v) => (
              <tr key={`${v.version}-${v.at}`}><td>v{v.version}</td><td>{f2(v.entryLo)}–{f2(v.entryHi)}</td><td>{f2(v.target)}</td><td>{f2(v.sl)}</td><td>{f2(v.exit)}</td><td>{time(v.at)}</td></tr>
            ))}
          </tbody>
        </table>
        {d.versions.length <= 1 && c.version > 1 && <div className="pv-time">Earlier versions were changed before the dashboard first saw this call.</div>}
      </div>
    </div>
  );
}

function Depth({ title, bids, asks }) {
  const rows = Math.max((bids || []).length, (asks || []).length);
  return (
    <table className="pv-table pv-depth">
      <thead><tr><th colSpan={2}>{title}: Bid</th><th colSpan={2}>Ask</th></tr></thead>
      <tbody>
        {Array.from({ length: rows }).map((_, i) => (
          <tr key={i}>
            <td>{f2(bids[i] && bids[i][1])}</td><td className="pv-green">{f2(bids[i] && bids[i][0])}</td>
            <td className="pv-red">{f2(asks[i] && asks[i][0])}</td><td>{f2(asks[i] && asks[i][1])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const IST = 19800;
const istLabel = (t) => { const d = new Date((t + IST) * 1000); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

function TradeChart({ candles, call }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const linesRef = useRef([]);
  const { theme } = useTheme();

  useEffect(() => {
    if (!ref.current) return undefined;
    const light = theme === "light";
    const chart = createChart(ref.current, {
      layout: { background: { color: light ? "#ffffff" : "#111318" }, textColor: light ? "#4a5068" : "#7a8099", fontSize: 11 },
      grid: { vertLines: { color: light ? "#eef0f5" : "#1a1d26" }, horzLines: { color: light ? "#eef0f5" : "#1a1d26" } },
      rightPriceScale: { borderColor: light ? "#dde0ea" : "#1e2230" },
      timeScale: { borderColor: light ? "#dde0ea" : "#1e2230", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t) => istLabel(t) },
      localization: { timeFormatter: (t) => `${istLabel(t)} IST` },
      width: ref.current.clientWidth || 600,
      height: 300,
    });
    const series = chart.addCandlestickSeries({ upColor: "#00d97e", downColor: "#ff4560", borderUpColor: "#00d97e", borderDownColor: "#ff4560", wickUpColor: "#00d97e", wickDownColor: "#ff4560" });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }); }) : null;
    if (ro) ro.observe(ref.current);
    return () => { if (ro) ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; linesRef.current = []; };
  }, [theme]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const seen = new Set();
    const data = candles
      .filter((c) => c && Number.isFinite(c.t) && Number.isFinite(c.o) && !seen.has(c.t) && seen.add(c.t))
      .sort((a, b) => a.t - b.t)
      .map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }));
    series.setData(data);
    linesRef.current.forEach((l) => { try { series.removePriceLine(l); } catch { /* ignore */ } });
    const line = (price, color, title, style = LineStyle.Dashed) => (Number.isFinite(price) ? series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }) : null);
    linesRef.current = [
      line(call.entryLo, "#3d84ff", "Entry"), line(call.entryHi, "#3d84ff", ""),
      line(call.target, "#00d97e", "Target", LineStyle.Solid), line(call.sl, "#ff4560", "SL", LineStyle.Solid),
      call.exit ? line(call.exit, "#f5a524", "PaRRVA exit") : null,
    ].filter(Boolean);
    const st = call.status || {};
    const toBar = (iso) => { if (!iso) return null; const t = Math.floor(new Date(iso).getTime() / 60000) * 60; return data.find((x) => x.time >= t) ? data.find((x) => x.time >= t).time : null; };
    const markers = [];
    const pub = toBar(call.createdAt);
    if (pub) markers.push({ time: pub, position: "aboveBar", color: "#a78bfa", shape: "arrowDown", text: `${call.name}` });
    const en = toBar(st.entryAt);
    if (en) markers.push({ time: en, position: call.side === "SELL" ? "aboveBar" : "belowBar", color: "#3d84ff", shape: call.side === "SELL" ? "arrowDown" : "arrowUp", text: "Entry" });
    const ex = toBar(st.exitAt);
    if (ex) markers.push({ time: ex, position: "aboveBar", color: st.state === "SL" ? "#ff4560" : "#00d97e", shape: "circle", text: st.state === "SL" ? "SL" : st.state === "TARGET" ? "Target" : "Exit" });
    markers.sort((a, b) => a.time - b.time);
    try { series.setMarkers(markers); } catch { /* ignore */ }
    if (chartRef.current && data.length) chartRef.current.timeScale().fitContent();
  }, [candles, call]);

  return <div ref={ref} className="pv-chart" />;
}

function History() {
  const [from, setFrom] = useState(monthStartIST());
  const [to, setTo] = useState(todayIST());
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancel = false;
    setD(null);
    getJson(`${BACKEND}/api/parrva/summary?from=${from}&to=${to}`)
      .then((x) => { if (!cancel) { setD(x); setErr(""); } })
      .catch((e) => { if (!cancel) setErr(e.message); });
    return () => { cancel = true; };
  }, [from, to]);
  const quick = (days) => { const t = todayIST(); const f = new Date(Date.parse(`${t}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10); setFrom(f); setTo(t); };
  return (
    <>
      <section className="pv-filters">
        <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} max={todayIST()} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="pv-btn" onClick={() => { setFrom(monthStartIST()); setTo(todayIST()); }}>This month</button>
        <button className="pv-btn" onClick={() => quick(30)}>30 days</button>
        <button className="pv-btn" onClick={() => quick(90)}>90 days</button>
        <button className="pv-btn" onClick={() => { setFrom("2020-01-01"); setTo(todayIST()); }}>All</button>
      </section>
      {err && <div className="pv-error">{err}</div>}
      {!d && !err && <div className="pv-empty">Loading…</div>}
      {d && (
        <>
          <Summary s={d.total} />
          <h2 className="pv-h2">Monthly</h2>
          <TotalsTable rows={d.monthly} first={(r) => r.month} firstLabel="Month" extra={(r) => r.days} extraLabel="Days" />
          <h2 className="pv-h2">Daily</h2>
          <TotalsTable rows={d.daily} first={(r) => dayMonth(r.date)} firstLabel="Date" extra={(r) => (r.source === "parrva" ? "PaRRVA exit" : "Recorded")} extraLabel="Source" />
          <p className="pv-time">
            Recorded = worked out from our own 1-minute data, replaying every PaRRVA version (trailed SL) from the minute it was published; entry at the real fill.
            Calls published before the recorder started that day are not counted. PaRRVA exit = days before recording started:
            points are PaRRVA's exit price minus the middle of the entry band; calls without an exit price count as "no record".
          </p>
        </>
      )}
    </>
  );
}

function TotalsTable({ rows, first, firstLabel, extra, extraLabel }) {
  if (!rows || !rows.length) return <div className="pv-empty">Nothing in this range.</div>;
  return (
    <div className="pv-table-wrap">
      <table className="pv-table pv-totals">
        <thead><tr><th>{firstLabel}</th><th>Calls</th><th>Target</th><th>Trail SL</th><th>SL</th><th>Exited</th><th>Open</th><th>Not trig.</th><th>Win %</th><th>Points</th><th>Points × lots</th><th>{extraLabel}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={first(r)}>
              <td>{first(r)}</td><td>{r.calls}</td><td className="pv-green">{r.target}</td><td className="pv-green">{r.trailSl || 0}</td><td className="pv-red">{r.sl}</td><td>{r.exited + r.closed}</td>
              <td>{r.open}</td><td>{r.notTriggered + r.waiting}</td><td>{r.winRate === null ? "—" : `${r.winRate}%`}</td>
              <td className={pnlClass(r.points)}>{signed(r.points)}</td><td className={pnlClass(r.pointsXLot)}>{signed(r.pointsXLot)}</td><td>{extra(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawJson() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { getJson(`${BACKEND}/api/parrva/raw`).then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="pv-error">{err}</div>;
  if (!d) return <div className="pv-empty">Loading…</div>;
  const text = JSON.stringify(d.data, null, 2);
  return (
    <>
      <div className="pv-time" style={{ margin: "8px 0" }}>{d.feed && d.feed.url} · fetched {time(d.feed && d.feed.lastOkAt)} · {d.feed && d.feed.count} calls</div>
      <button className="pv-btn pv-copy" onClick={() => { try { navigator.clipboard.writeText(text); } catch { /* no clipboard */ } }}>Copy JSON</button>
      <pre className="pv-raw-pre">{text}</pre>
    </>
  );
}
