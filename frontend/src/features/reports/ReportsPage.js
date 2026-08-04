// ReportsPage.js
// Wave Report page — fetches real candle data from the backend for the selected
// timeframe, runs the exact same wave algorithm as the chart, and displays the
// resulting wave table with proper Dow Theory labels (HH / LH / HL / LL).

import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { updateWavesIndicatorPure } from "../../indicators/WavesIndicator";
import { toISTDate, formatShortDateIST, formatTimeIST } from "../../utils/istUtils";
import { useTheme } from "../../App";
import "./ReportsPage.css";
import { fmt } from "../../utils/format";
import { TIMEFRAMES } from "../../utils/formatResolution";
import SymbolSearch from "../../shared/components/SymbolSearch";

import { BACKEND } from "../../config";

// ── Symbols — live from the root symbols/ master via /api/symbols ──────────
// REPOINTED 2026-08-03 — was `import SYMBOLS from "../symbols.json"` (a
// bundled, build-time-frozen file). CONSOLIDATED 2026-08-03 — the fetch+cache
// logic lived in utils/symbolsApi.js (Chunk 3), shared with
// components/SymbolSearch.js and pages/FibDashboardPage.js. CHUNK 4
// (2026-08-03): this page no longer fetches symbols itself at all — it now
// uses the real components/SymbolSearch.js modal directly (see the
// search-trigger button in the topbar below), so the local loadSymbols()
// usage is gone too.

// ── Timeframes ────────────────────────────────────────────────────────────────
// ── Helpers ───────────────────────────────────────────────────────────────────
// toISTStr previously did its own manual IST offset math (tsMs + 5.5h, then
// read UTC date parts) — a duplicate of what istUtils.js already handles
// properly via Intl timeZone: "Asia/Kolkata". Same "dd/Mon HH:MM" output,
// now composed from the two real istUtils exports instead of hand-rolled.
// See TGG-project-plan.md Section 4c/4g.
function toISTStr(tsMs) {
  if (!tsMs) return "—";
  return `${formatShortDateIST(tsMs)} ${formatTimeIST(tsMs)}`;
}


// ── Build table rows ──────────────────────────────────────────────────────────
// col1 = wave START (fromTime/fromPrice), col2 = wave END (toTime/toPrice)
function buildTableRows(segments) {
  return segments.map((seg, i) => {
    const isBull = seg.toSide === "high";
    const delta = Math.abs(seg.toPrice - seg.fromPrice);
    const label = `${seg.prevWaveType || "—"}\u2192${seg.currWaveType || "—"}`;
    const date = toISTDate(seg.fromTime);

    return {
      id: `seg-${i}`,
      n: i + 1,
      date,
      dir: isBull ? "bull" : "bear",
      label,
      col1Time: seg.fromTime,
      col1Price: seg.fromPrice,
      col2Time: seg.toTime,
      col2Price: seg.toPrice,
      delta: +delta.toFixed(2),
      waveNum: seg.waveNum,
    };
  });
}

// ── Mother Wave Chain Section ─────────────────────────────────────────────────
// Shows the full MW chain: current (mwNo=0) + all previous invalidated MWs.
// chain comes from motherWave.chain: [{ mwNo, wave, fibLevels, invalidation }]
function MotherWaveSection({ motherWave, onWaveClick }) {
  if (!motherWave) return null;

  // Build chain: current first, then previous sorted by mwNo (-1, -2, ...)
  const chain = motherWave.chain
    ? [...motherWave.chain].sort((a, b) => b.mwNo - a.mwNo)  // 0 first, then -1, -2...
    : [{ mwNo: 0, wave: motherWave.wave, fibLevels: motherWave.fibLevels, invalidation: motherWave.invalidation }];

  // Current MW fib section — only shown for current (mwNo=0)
  const current = chain.find(c => c.mwNo === 0);
  const { wave: curWave, fibLevels: curFibs, invalidation: curInv } = current || {};
  const isCurBull = curWave?.dir === "bull";

  const fibOrder = isCurBull
    ? ["-0.618", "0.0", "0.236", "0.382", "0.5", "0.618", "0.786", "1.0"]
    : ["1.0", "0.786", "0.618", "0.5", "0.382", "0.236", "0.0", "-0.618"];

  const allFibPrices = curFibs ? Object.values(curFibs) : [];
  const minP = allFibPrices.length ? Math.min(...allFibPrices) : 0;
  const maxP = allFibPrices.length ? Math.max(...allFibPrices) : 1;
  const priceRange = maxP - minP || 1;
  function barWidth(level) {
    const price = curFibs[level];
    return Math.max(8, Math.round(((price - minP) / priceRange) * 100));
  }

  return (
    <div className="mw-section">
      <div className="mw-header-row">
        <span className="mw-title">Mother Wave Chain</span>
        <span className="mw-subtitle">
          {chain.length === 1
            ? "Current confirmed Mother Wave"
            : `Current MW + ${chain.length - 1} previously invalidated wave${chain.length > 2 ? "s" : ""}`}
          {curInv != null && (
            <> · Current invalidation at{" "}
              <span className="mw-inv-price-inline">{fmt(curInv)}</span>{" "}(−0.618)
            </>
          )}
        </span>
      </div>

      {/* Full chain table */}
      <div className="mw-table-wrap">
        <table className="cr-table mw-table mw-chain-table">
          <thead>
            <tr>
              <th className="mw-th-no">MW No.</th>
              <th className="cr-th-wave">Wave</th>
              <th className="cr-th-wave cr-th-label">Pattern</th>
              <th className="cr-th-dir">Direction</th>
              <th className="cr-th">Start</th>
              <th className="cr-th">End</th>
              <th className="cr-th">Δ</th>
              <th className="cr-th">Status</th>
            </tr>
          </thead>
          <tbody>
            {chain.map(({ mwNo, wave, invalidation: inv }) => {
              const isBull = wave.dir === "bull";
              const isCurrent = mwNo === 0;
              return (
                <tr
                  key={mwNo}
                  className={`cr-row cr-row-clickable ${isCurrent ? "mw-row-highlight" : "mw-row-prev"}`}
                  onClick={() => onWaveClick(wave)}
                  title={isCurrent ? "Current Mother Wave — click to open on chart" : "Invalidated MW — click to open on chart"}
                >
                  {/* MW No. */}
                  <td>
                    <span className={`mw-chain-no ${isCurrent ? "mw-chain-no-current" : "mw-chain-no-prev"}`}>
                      {mwNo === 0 ? "0" : mwNo}
                    </span>
                  </td>

                  {/* Wave No. */}
                  <td><span className="cr-w-num">{wave.waveNum}</span></td>

                  {/* Pattern label */}
                  <td>
                    <span className="cr-w-label cr-w-label-standalone">{wave.label}</span>
                  </td>

                  {/* Direction */}
                  <td>
                    {isBull
                      ? <span className="cr-badge cr-badge-bull">▲ Bullish</span>
                      : <span className="cr-badge cr-badge-bear">▼ Bearish</span>}
                  </td>

                  {/* Start */}
                  <td>
                    <span className="cr-time">{toISTStr(wave.col1Time ?? wave.fromTime)}</span>
                    <span className="cr-price">{fmt(wave.col1Price ?? wave.fromPrice)}</span>
                  </td>

                  {/* End */}
                  <td>
                    <span className="cr-time">{toISTStr(wave.col2Time ?? wave.toTime)}</span>
                    <span className="cr-price">{fmt(wave.col2Price ?? wave.toPrice)}</span>
                  </td>

                  {/* Delta */}
                  <td>
                    <span className={`cr-delta ${isBull ? "cr-bull" : "cr-bear"}`}>
                      {isBull ? "+" : "−"}{wave.delta.toFixed(2)}
                    </span>
                  </td>

                  {/* Status */}
                  <td>
                    {isCurrent
                      ? <span className="mw-status-badge mw-status-current">✓ Current MW</span>
                      : <span className="mw-status-badge mw-status-invalidated">✗ Invalidated</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Fibonacci levels for current MW only */}
      {curFibs && (
        <div className="mw-fib-wrap">
          <div className="mw-fib-title">Fibonacci Retracement Levels — Current MW (0)</div>
          <div className="mw-fib-grid">
            {fibOrder.map((level) => {
              const price = curFibs[level];
              const isInv = level === "-0.618";
              const isAnchor = level === "0.0" || level === "1.0";
              const bw = barWidth(level);
              return (
                <div key={level}
                  className={`mw-fib-row${isInv ? " mw-fib-inv" : ""}${isAnchor ? " mw-fib-anchor" : ""}`}
                >
                  <span className="mw-fib-level">{level}</span>
                  <div className="mw-fib-bar-track">
                    <div className="mw-fib-bar-fill"
                      style={{
                        width: `${bw}%`,
                        background: isInv ? "#3d84ff" : isCurBull ? "#639922" : "#E24B4A",
                      }}
                    />
                  </div>
                  <span className={`mw-fib-price${isInv ? " mw-fib-inv-price" : ""}`}>
                    {fmt(price)}
                  </span>
                  {isInv && <span className="mw-fib-tag">Invalidation</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const [timeframe, setTimeframe] = useState(() => {
    try { const v = localStorage.getItem("tgg_resolution"); return v ? JSON.parse(v) : 15; }
    catch { return 15; }
  });

  const [symbol, setSymbol] = useState(() => {
    try { const v = localStorage.getItem("tgg_symbol"); return v ? JSON.parse(v) : "NSE:NIFTY50-INDEX"; }
    catch { return "NSE:NIFTY50-INDEX"; }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [initialSearchQuery, setInitialSearchQuery] = useState("");
  // Mirror of searchOpen in a ref — same reasoning as ChartsPage.js's
  // openSearchWithQuery: lets fast typing append correctly even in the
  // ~60ms gap between setSearchOpen(true) and the modal's input gaining
  // focus, instead of using the (one-render-behind) searchOpen state.
  const searchOpenRef = useRef(false);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);

  const [candles, setCandles] = useState([]);
  const [emaHighs, setEmaHighs] = useState([]);
  const [emaLows, setEmaLows] = useState([]);
  const [loadState, setLoadState] = useState("idle");
  const [errMsg, setErrMsg] = useState("");

  // Filters
  const [fDate, setFDate] = useState("all");
  const [fDir, setFDir] = useState("all");
  const [fSize, setFSize] = useState("all");
  const [fQ, setFQ] = useState("");

  // Sort
  const [sortCol, setSortCol] = useState("delta");
  const [sortDir, setSortDir] = useState("asc");

  // ── Fetch ───────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (sym, res) => {
    setLoadState("loading");
    setErrMsg("");
    setFDate("all"); setFDir("all"); setFSize("all"); setFQ("");
    setSortCol("delta"); setSortDir("asc");
    try {
      // Backend handles live vs cached automatically based on symbol's market hours.
      // Always GET — no POST/refresh decision needed on frontend.
      const r = await fetch(`${BACKEND}/api/chart?symbol=${encodeURIComponent(sym)}&resolution=${res}`);
      const data = r.ok ? await r.json() : null;

      if (data?.candles?.length) {
        setCandles(data.candles);
        setEmaHighs(data.emaHighs || []);
        setEmaLows(data.emaLows || []);
        setLoadState("done");
      } else {
        setLoadState("error");
        setErrMsg(`No candle data for ${sym}. Check backend connection and try Refresh.`);
      }
    } catch (e) {
      setLoadState("error");
      setErrMsg(e.message || "Network error connecting to backend.");
    }
  }, []);

  useEffect(() => { fetchData(symbol, timeframe); }, [symbol, timeframe, fetchData]);

  // Type-to-search — CHUNK 4 follow-up (2026-08-04): matches the chart
  // page's behavior (pages/ChartsPage.js) — typing a plain letter anywhere
  // on the page (not inside an input/textarea, no modifier keys, digits
  // excluded) opens the symbol search modal pre-filled with that letter.
  // Simpler than ChartsPage.js's version: this page only ever has ONE
  // search instance, so there's no panelActionsRef indirection needed —
  // this listener talks directly to this page's own searchOpen state.
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key.length !== 1 || e.key === " ") return;
      if (e.key >= "0" && e.key <= "9") return;
      e.preventDefault();
      setInitialSearchQuery((prev) => (searchOpenRef.current ? prev + e.key : e.key));
      searchOpenRef.current = true;
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleSymbolSelect(sym) {
    setCandles([]);
    setEmaHighs([]);
    setEmaLows([]);
    setSymbol(sym);
    localStorage.setItem("tgg_symbol", JSON.stringify(sym));
  }

  function handleTimeframeChange(tf) {
    setCandles([]);
    setEmaHighs([]);
    setEmaLows([]);
    setTimeframe(tf);
    localStorage.setItem("tgg_resolution", JSON.stringify(tf));
  }

  // ── Wave computation ────────────────────────────────────────────────────────
  const { allWaves, allDates } = useMemo(() => {
    if (!candles.length) return { allWaves: [], allDates: [] };
    const { segments } = updateWavesIndicatorPure(candles, emaHighs, emaLows);
    const rows = buildTableRows(segments);
    // 7d fix (2026-08-04): was `.sort().reverse()` on the formatted date
    // STRING (e.g. "4/8/2026"). That's a text sort, not a calendar sort —
    // it broke across month/day-of-month boundaries once the toISTDate fix
    // (Section 4d) switched the display to unpadded d/m/yyyy, e.g.
    // "10/8/2026" would sort before "9/8/2026" as text. Fixed by sorting on
    // each date's real underlying timestamp (col1Time, the same raw value
    // toISTDate was given to produce the display string) instead of the
    // string itself. Display format is untouched — only the sort key changed.
    const dateTsByDate = {};
    rows.forEach((w) => {
      if (dateTsByDate[w.date] === undefined || w.col1Time < dateTsByDate[w.date]) {
        dateTsByDate[w.date] = w.col1Time;
      }
    });
    const dates = [...new Set(rows.map((w) => w.date))]
      .sort((a, b) => dateTsByDate[b] - dateTsByDate[a]); // most recent first, same order as before
    return { allWaves: rows, allDates: dates };
  }, [candles, emaHighs, emaLows]);

  // ── Mother Wave — fetched from backend (single source of truth) ────────────
  const [motherWave, setMotherWave] = useState(null);

  useEffect(() => {
    if (!symbol || timeframe == null) return;
    let cancelled = false;
    // /api/chart auto-refreshes internally when market is live, so by the time
    // this fires the server cache is already fresh — no delay needed.
    fetch(`${BACKEND}/api/motherwave?symbol=${encodeURIComponent(symbol)}&resolution=${timeframe}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled) return;
        setMotherWave(data && data.wave ? data : null);
      })
      .catch(() => { if (!cancelled) setMotherWave(null); });
    return () => { cancelled = true; };
  }, [symbol, timeframe]);

  // ── Filter + sort ───────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let data = allWaves.filter((w) => {
      if (fDate !== "all" && w.date !== fDate) return false;
      if (fDir === "bull" && w.dir !== "bull") return false;
      if (fDir === "bear" && w.dir !== "bear") return false;
      if (fSize === "small" && w.delta >= 30) return false;
      if (fSize === "medium" && (w.delta < 30 || w.delta > 80)) return false;
      if (fSize === "large" && w.delta <= 80) return false;
      if (fQ && !String(w.waveNum).includes(fQ.trim())) return false;
      return true;
    });

    if (sortCol && sortDir) {
      data = [...data].sort((a, b) => {
        const av = sortCol === "delta" ? a.delta : sortCol === "col1Time" ? a.col1Time : a.col2Time;
        const bv = sortCol === "delta" ? b.delta : sortCol === "col1Time" ? b.col1Time : b.col2Time;
        if (sortDir === "asc") return typeof av === "number" ? av - bv : av > bv ? 1 : -1;
        return typeof av === "number" ? bv - av : bv > av ? 1 : -1;
      });
    } else {
      data = [...data].sort((a, b) => b.col1Time - a.col1Time);
    }

    return data;
  }, [allWaves, fDate, fDir, fSize, fQ, sortCol, sortDir]);

  // ── Stats ───────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!filtered.length) return { total: 0, avg: "0.0", maxBull: "0.00", maxBear: "0.00" };
    const deltas = filtered.map((w) => w.delta);
    const bullWaves = filtered.filter((w) => w.dir === "bull");
    const bearWaves = filtered.filter((w) => w.dir === "bear");
    return {
      total: filtered.length,
      avg: (deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1),
      maxBull: bullWaves.length ? Math.max(...bullWaves.map((w) => w.delta)).toFixed(2) : "0.00",
      maxBear: bearWaves.length ? Math.max(...bearWaves.map((w) => w.delta)).toFixed(2) : "0.00",
    };
  }, [filtered]);

  const maxDelta = useMemo(() => filtered.reduce((acc, w) => Math.max(acc, w.delta), 1), [filtered]);

  // ── Open wave on ChartsPage in new tab ──────────────────────────────────────
  function handleWaveClick(w) {
    const params = new URLSearchParams({
      symbol,
      resolution: String(timeframe),
      waveFrom: String(w.col1Time),
      waveTo: String(w.col2Time),
    });
    window.open(`/charts?${params.toString()}`, "_blank");
  }

  // ── Sort helpers ─────────────────────────────────────────────────────────────
  function handleColSort(col) {
    if (sortCol === col) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") { setSortDir(null); setSortCol(null); }
      else { setSortDir("asc"); setSortCol(col); }
    } else { setSortCol(col); setSortDir("asc"); }
  }
  function clearSort() { setSortCol(null); setSortDir(null); }

  function sortArrow(col) {
    if (sortCol !== col || !sortDir) return <span className="cr-sort-arrow inactive">↕</span>;
    return <span className="cr-sort-arrow active">{sortDir === "" ? "↑" : "↓"}</span>;
  }

  const sortLabel = !sortCol ? "Sort by Δ" : sortDir === "asc" ? "Δ Ascending" : "Δ Descending";
  const isSortedByDelta = sortCol === "delta" && sortDir;
  const tfLabel = TIMEFRAMES.find((t) => t.value === timeframe)?.label || String(timeframe);
  let lastDate = "";

  return (
    <div className="cr-page">

      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <div className="cr-topbar">
        <button className="cr-back-btn" onClick={() => navigate("/")} title="Back to Home">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>

        <div className="cr-logo">
          <img src="/tg-levels-logo.png" alt="TG Levels" className="cr-logo-img" />
        </div>

        {/* Symbol search — CHUNK 4 (2026-08-03): was a local always-visible
            inline input+dropdown; now opens the same full-screen search
            modal used on the chart page (components/SymbolSearch.js), same
            as FibDashboardPage. NOTE (not the same button style as Fib's,
            deliberately): this page has no other place showing the current
            symbol — the old input's value WAS the only display of it — so
            unlike Fib's icon-only button (which relies on a separate
            fdb-symbol-label elsewhere), this button shows the symbol text
            plus icon, to avoid silently hiding it from view. */}
        <div className="cr-topbar-search">
          <button
            className="cr-symbol-search-btn"
            onClick={() => setSearchOpen(true)}
            title="Search symbol"
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
              <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="2" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>{symbol}</span>
          </button>
        </div>

        <SymbolSearch
          isOpen={searchOpen}
          onClose={() => { setSearchOpen(false); setInitialSearchQuery(""); }}
          initialQuery={initialSearchQuery}
          onSelect={handleSymbolSelect}
        />

        <div style={{ flex: 1 }} />

        {/* Timeframe pills */}
        <div className="cr-tf-group">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              className={`cr-tf-btn ${timeframe === tf.value ? "active" : ""}`}
              onClick={() => handleTimeframeChange(tf.value)}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <button
          className="cr-reload-btn"
          onClick={() => fetchData(symbol, timeframe)}
          disabled={loadState === "loading"}
          title="Reload"
        >
          <span style={{ display: "inline-block", animation: loadState === "loading" ? "cr-spin 0.8s linear infinite" : "none" }}>↻</span>
        </button>

        <button
          className="cr-theme-btn"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          {theme === "dark" ? "☀" : "🌙"}
        </button>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="cr-body">

        {loadState === "loading" && (
          <div className="cr-state-overlay">
            <div className="cr-spinner" />
            <span>Loading {tfLabel} wave data…</span>
          </div>
        )}

        {loadState === "error" && (
          <div className="cr-state-overlay cr-state-error">
            <span>⚠ {errMsg}</span>
            <button className="cr-reload-btn" style={{ marginTop: 12 }} onClick={() => fetchData(symbol, timeframe)}>Retry</button>
          </div>
        )}

        {(loadState === "done" || (loadState === "idle" && allWaves.length > 0)) && (
          <>
            {/* Stats */}
            <div className="cr-stat-row">
              <div className="cr-stat">
                <div className="cr-stat-lbl">Total Waves</div>
                <div className="cr-stat-val">{stats.total}</div>
              </div>
              <div className="cr-stat">
                <div className="cr-stat-lbl">Avg Wave Δ</div>
                <div className="cr-stat-val">{stats.avg}</div>
              </div>
              <div className="cr-stat">
                <div className="cr-stat-lbl">Largest Bullish Δ</div>
                <div className="cr-stat-val cr-bull">+{stats.maxBull}</div>
              </div>
              <div className="cr-stat">
                <div className="cr-stat-lbl">Largest Bearish Δ</div>
                <div className="cr-stat-val cr-bear">−{stats.maxBear}</div>
              </div>
            </div>

            {/* ── Mother Wave Section ─────────────────────────────────────── */}
            <MotherWaveSection motherWave={motherWave} onWaveClick={handleWaveClick} />

            {/* Filter controls */}
            <div className="cr-controls">
              <div className="cr-select-wrap">
                <select value={fDate} onChange={(e) => setFDate(e.target.value)} className="cr-select">
                  <option value="all">All dates</option>
                  {allDates.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              <div className="cr-select-wrap">
                <select value={fDir} onChange={(e) => setFDir(e.target.value)} className="cr-select">
                  <option value="all">All directions</option>
                  <option value="bull">Bullish only ▲</option>
                  <option value="bear">Bearish only ▼</option>
                </select>
              </div>

              <div className="cr-select-wrap">
                <select value={fSize} onChange={(e) => setFSize(e.target.value)} className="cr-select">
                  <option value="all">All sizes</option>
                  <option value="small">Small (&lt; 30)</option>
                  <option value="medium">Medium (30–80)</option>
                  <option value="large">Large (&gt; 80)</option>
                </select>
              </div>

              <div className="cr-sort-group">
                <button
                  className={`cr-sort-btn ${sortCol === "delta" && sortDir ? "active" : ""}`}
                  onClick={() => handleColSort("delta")}
                >
                  <span>{sortLabel}</span>
                  <span className="cr-sort-icon">{sortCol === "delta" && sortDir ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                </button>
                {sortCol && sortDir && (
                  <button className="cr-clear-sort" onClick={clearSort} title="Clear sort">✕</button>
                )}
              </div>

              <div className="cr-search-wrap">
                <input
                  type="text" value={fQ}
                  onChange={(e) => setFQ(e.target.value)}
                  placeholder="Wave #..." className="cr-search"
                />
                {fQ && <button className="cr-search-clear" onClick={() => setFQ("")} title="Clear">✕</button>}
              </div>

              <span className="cr-row-count">{filtered.length} rows shown</span>
            </div>

            {/* Table */}
            <div className="cr-table-wrap">
              <table className="cr-table">
                <thead>
                  <tr>
                    <th className="cr-th-wave">Wave</th>
                    <th className="cr-th-wave cr-th-label">Wave</th>
                    <th className="cr-th-dir">Direction</th>
                    <th
                      className={`cr-th-sortable ${sortCol === "col1Time" ? "cr-th-sorted" : ""}`}
                      onClick={() => handleColSort("col1Time")}
                    >
                      Time / Price {sortArrow("col1Time")}
                    </th>
                    <th
                      className={`cr-th-sortable ${sortCol === "col2Time" ? "cr-th-sorted" : ""}`}
                      onClick={() => handleColSort("col2Time")}
                    >
                      Time / Price {sortArrow("col2Time")}
                    </th>
                    <th
                      className={`cr-th-sortable ${sortCol === "delta" ? "cr-th-sorted" : ""}`}
                      onClick={() => handleColSort("delta")}
                    >
                      Wave Δ (abs) {sortArrow("delta")}
                    </th>
                    <th className="cr-th">Strength Bar</th>
                    <th className="cr-th">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="cr-no-data">
                        {allWaves.length === 0
                          ? "No waves detected — ensure backend has data for this timeframe."
                          : "No waves match the current filters."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((w) => {
                      const showDateSep = !isSortedByDelta && w.date !== lastDate;
                      if (showDateSep) lastDate = w.date;
                      const barW = Math.max(4, Math.round((w.delta / maxDelta) * 100));
                      const isBull = w.dir === "bull";
                      const isMotherWave = motherWave && w.waveNum === motherWave.wave.waveNum;

                      return (
                        <React.Fragment key={w.id}>
                          {showDateSep && (
                            <tr className="cr-date-sep">
                              <td colSpan={8}>— {w.date} —</td>
                            </tr>
                          )}
                          <tr
                            className={`cr-row cr-row-clickable${isMotherWave ? " cr-row-mother" : ""}`}
                            onClick={() => handleWaveClick(w)}
                            title={isMotherWave ? "Mother Wave — click to open on chart" : "Click to open this wave on the chart"}
                          >
                            <td>
                              <span className="cr-w-num">{w.waveNum}</span>
                              {isMotherWave && <span className="cr-mother-tag">M</span>}
                            </td>
                            <td><span className="cr-w-label cr-w-label-standalone">{w.label}</span></td>
                            <td>
                              {isBull
                                ? <span className="cr-badge cr-badge-bull">▲ Bullish</span>
                                : <span className="cr-badge cr-badge-bear">▼ Bearish</span>}
                            </td>
                            <td>
                              <span className="cr-time">{toISTStr(w.col1Time)}</span>
                              <span className="cr-price">{fmt(w.col1Price)}</span>
                            </td>
                            <td>
                              <span className="cr-time">{toISTStr(w.col2Time)}</span>
                              <span className="cr-price">{fmt(w.col2Price)}</span>
                            </td>
                            <td>
                              <span className={`cr-delta ${isBull ? "cr-bull" : "cr-bear"}`}>
                                {isBull ? "+" : "−"}{w.delta.toFixed(2)}
                              </span>
                            </td>
                            <td>
                              <div className="cr-bar-wrap">
                                <div className="cr-bar-bg">
                                  <div
                                    className="cr-bar-fill"
                                    style={{ width: `${barW}%`, background: isBull ? "#639922" : "#E24B4A" }}
                                  />
                                </div>
                                <span className="cr-bar-pct">{barW}%</span>
                              </div>
                            </td>
                            <td><SizeBadge delta={w.delta} /></td>
                          </tr>
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SizeBadge({ delta }) {
  if (delta < 30) return <span className="cr-badge cr-badge-sm">Small</span>;
  if (delta <= 80) return <span className="cr-badge cr-badge-med">Medium</span>;
  return <span className="cr-badge cr-badge-lg-bull">Large</span>;
}