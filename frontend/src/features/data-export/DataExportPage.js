// DataExportPage.js
// ─────────────────────────────────────────────────────────────────────────
// Universal historical-data download page — search any live NSE/BSE/MCX
// symbol (spot, future, or option), pick a date range + timeframe, and get
// an .xlsx straight into this browser's Downloads folder.
//
// Talks only to /api/data-export/* (routes/dataExportRouter.js) and the
// EXISTING /api/auth/status endpoint (routes/chartRouter.js) for the
// token-valid/invalid banner — that endpoint already exists and is used
// nowhere else in the frontend yet, so this page is its first consumer,
// not a new duplicate of it.
//
// The actual file download reuses the exact same technique
// AnalyticsPage.js already uses for its "Download Excel" button — a plain
// <a href="..."> pointing at a backend endpoint that sets
// Content-Disposition: attachment, letting the browser handle the save
// natively. No blob/fetch trickery, nothing reinvented.
// ─────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { BACKEND } from "../../config";
import "./DataExportPage.css";

const SEGMENTS = [
  { id: "spot", label: "Spot" },
  { id: "future", label: "Future" },
  { id: "option", label: "Option" },
];

const TIMEFRAMES = [
  { id: "1min", label: "1 minute" },
  { id: "3min", label: "3 minute" },
  { id: "5min", label: "5 minute" },
  { id: "15min", label: "15 minute" },
  { id: "1hr", label: "1 hour" },
  { id: "1day", label: "1 day" },
];

const SEARCH_DEBOUNCE_MS = 300;
const AUTH_POLL_MS = 30_000;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function DataExportPage() {
  // ── Token status — same /api/auth/status endpoint chartRouter.js
  // already exposes and the homepage card now also reads. ────────────────
  const [auth, setAuth] = useState({ loading: true, authenticated: false, authUrl: null });

  useEffect(() => {
    let cancelled = false;
    function check() {
      fetch(`${BACKEND}/api/auth/status`)
        .then((r) => r.json())
        .then((data) => { if (!cancelled) setAuth({ loading: false, authenticated: !!data.authenticated, authUrl: data.authUrl || null }); })
        .catch(() => { if (!cancelled) setAuth({ loading: false, authenticated: false, authUrl: null }); });
    }
    check();
    const t = setInterval(check, AUTH_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // ── Search state ─────────────────────────────────────────────────────
  const [segment, setSegment] = useState("spot");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selected, setSelected] = useState(null); // the chosen result object
  const [selectedExpiry, setSelectedExpiry] = useState("");

  const boxRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    // Changing segment invalidates whatever was picked/typed before —
    // a spot symbol string isn't a valid option contract and vice versa.
    setSelected(null);
    setSelectedExpiry("");
    setResults([]);
    setQuery("");
  }, [segment]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }

    setSearching(true);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams({ q, segment });
      fetch(`${BACKEND}/api/data-export/symbols?${params.toString()}`)
        .then((r) => r.json())
        .then((data) => {
          setResults(Array.isArray(data) ? data : []);
          setDropdownOpen(true);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, segment]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Options carry an expiry per contract — derived straight from the
  // already-fetched results (no second API call) so picking an expiry
  // just narrows the same list to that date.
  const expiryOptions = useMemo(() => {
    if (segment !== "option") return [];
    const dates = new Set(results.map((r) => r.expiryDate).filter(Boolean));
    return Array.from(dates).sort();
  }, [segment, results]);

  const visibleResults = useMemo(() => {
    if (segment === "option" && selectedExpiry) {
      return results.filter((r) => r.expiryDate === selectedExpiry);
    }
    return results;
  }, [segment, results, selectedExpiry]);

  const handleSelect = useCallback((entry) => {
    setSelected(entry);
    setQuery(entry.symbol);
    setDropdownOpen(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setQuery("");
    setResults([]);
  }, []);

  // ── Date range + timeframe ───────────────────────────────────────────
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6); // sensible default: last 6 months
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(todayISO());
  const [timeframe, setTimeframe] = useState("5min");

  const dateRangeValid = fromDate && toDate && fromDate <= toDate;
  const canDownload = auth.authenticated && !!selected && dateRangeValid;

  const downloadUrl = useMemo(() => {
    if (!selected) return null;
    const params = new URLSearchParams({
      symbol: selected.symbol,
      from: fromDate,
      to: toDate,
      timeframe,
    });
    return `${BACKEND}/api/data-export/download?${params.toString()}`;
  }, [selected, fromDate, toDate, timeframe]);

  return (
    <div className="de-page">
      <div className="de-grid-bg" aria-hidden="true" />

      <header className="de-header">
        <div className="de-brand">
          <div className="de-brand-mark">TG</div>
          TG Levels
        </div>
        <nav className="de-crumb">
          <Link to="/">Home</Link>
          <span className="de-sep">/</span>
          <span className="de-here">Data Export</span>
        </nav>
      </header>

      <main className="de-main">
        <div className="de-title-block">
          <h1>Data Export</h1>
          <p>Search any symbol across NSE, BSE and MCX, pick a segment and date range, and download the candle history as an Excel file — straight to this device.</p>
        </div>

        <div className={`de-token-banner ${auth.loading ? "de-token-loading" : auth.authenticated ? "de-token-valid" : "de-token-invalid"}`}>
          <div className="de-token-left">
            <span className="de-dot" />
            <span>
              {auth.loading
                ? "Checking Fyers token…"
                : auth.authenticated
                  ? "Fyers token is valid — ready to fetch data."
                  : "No valid Fyers token found. Please first generate a valid token from Admin."}
            </span>
          </div>
          {!auth.loading && !auth.authenticated && (
            <Link to="/admin" className="de-admin-link">Go to Admin →</Link>
          )}
        </div>

        <form className="de-form" onSubmit={(e) => e.preventDefault()}>
          {/* ── Symbol search ─────────────────────────────────────── */}
          <fieldset>
            <label className="de-label">Symbol</label>
            <div className="de-symbol-search" ref={boxRef}>
              <div className="de-input-wrap">
                <SearchIcon />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
                  onFocus={() => { if (results.length) setDropdownOpen(true); }}
                  placeholder="Type a symbol or company name… e.g. BEML, RELIANCE, NIFTY"
                  autoComplete="off"
                />
                <span className="de-universal-tag">live · all exchanges</span>
              </div>

              {dropdownOpen && query.trim().length >= 2 && (
                <div className="de-suggest-list">
                  {searching && <div className="de-suggest-empty">Searching…</div>}
                  {!searching && visibleResults.length === 0 && (
                    <div className="de-suggest-empty">No live {segment} symbols match "{query}"</div>
                  )}
                  {!searching && visibleResults.map((r) => (
                    <div key={r.symbol} className="de-suggest-item" onMouseDown={() => handleSelect(r)}>
                      <div className="de-suggest-main">
                        <div className="de-suggest-symbol">{r.symbol}</div>
                        <div className="de-suggest-name">{r.name}</div>
                      </div>
                      <span className={`de-type-pill de-type-${r.type}`}>{r.type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selected && (
              <div className="de-selected-chip">
                <span className="de-chip-sym">{selected.symbol} — {selected.name}</span>
                <span className={`de-type-pill de-type-${selected.type}`}>{selected.type}</span>
                <span className="de-chip-clear" onClick={clearSelection}>✕</span>
              </div>
            )}

            <div className="de-info-note">Pulled live from Fyers' own symbol master (NSE, BSE) plus this app's curated MCX list — not a fixed list, so anything currently tradable will show up.</div>
          </fieldset>

          {/* ── Segment ───────────────────────────────────────────── */}
          <fieldset>
            <label className="de-label">Segment</label>
            <div className="de-segment-toggle">
              {SEGMENTS.map((s) => (
                <div
                  key={s.id}
                  className={`de-segment-btn ${segment === s.id ? "de-segment-active" : ""}`}
                  onClick={() => setSegment(s.id)}
                >
                  {s.label}
                </div>
              ))}
            </div>

            {segment === "option" && (
              <div className="de-expiry-block">
                <label className="de-label" style={{ marginTop: 16 }}>Expiry</label>
                <select value={selectedExpiry} onChange={(e) => setSelectedExpiry(e.target.value)} disabled={expiryOptions.length === 0}>
                  <option value="">{expiryOptions.length ? "All expiries" : "Type a symbol to load expiries"}</option>
                  {expiryOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <div className="de-info-note de-warn">Only currently live, unexpired option contracts are available — Fyers doesn't provide historical data for expired options.</div>
              </div>
            )}
          </fieldset>

          {/* ── Date range + timeframe ────────────────────────────── */}
          <fieldset>
            <label className="de-label">Date range &amp; timeframe</label>
            <div className="de-row-three">
              <div>
                <label className="de-label">From</label>
                <input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div>
                <label className="de-label">To</label>
                <input type="date" value={toDate} min={fromDate} max={todayISO()} onChange={(e) => setToDate(e.target.value)} />
              </div>
              <div>
                <label className="de-label">Timeframe</label>
                <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                  {TIMEFRAMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
            </div>
            {!dateRangeValid && <div className="de-info-note de-warn">"From" date must be on or before "To" date.</div>}
          </fieldset>

          <div className="de-submit-row">
            {canDownload ? (
              <a className="de-download-btn" href={downloadUrl}>
                <DownloadIcon />
                Download .xlsx
              </a>
            ) : (
              <button type="button" className="de-download-btn de-download-disabled" disabled title={
                !auth.authenticated ? "Generate a valid Fyers token first" :
                  !selected ? "Pick a symbol from the search results first" :
                    "Fix the date range first"
              }>
                <DownloadIcon />
                Download .xlsx
              </button>
            )}
            <div className="de-format-badge">Excel (.xlsx)</div>
          </div>
        </form>
      </main>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
  );
}
