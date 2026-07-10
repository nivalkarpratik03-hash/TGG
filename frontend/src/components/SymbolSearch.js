// SymbolSearch.js
// ─── Full-screen search modal — TradingView / Fyers style ──────────────────
// Opens when user clicks the symbol button in StatusBar.
// Features: category tabs, recent searches (localStorage), live filter, keyboard nav.
// ───────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from "react";
import "../styles/SymbolSearch.css";
import { BACKEND } from "../config";

// ── Module-level cache shared across all instances ─────────────────────────
let _symbolsCache = [];
let _symbolsLoaded = false;
async function loadSymbols() {
  if (_symbolsLoaded) return _symbolsCache;
  try {
    const r = await fetch(`${BACKEND}/api/symbols`);
    if (r.ok) _symbolsCache = await r.json();
  } catch { }
  _symbolsLoaded = true;
  return _symbolsCache;
}

// ── Recent searches — localStorage ────────────────────────────────────────
const RECENT_KEY = "tgg_recent_symbols";
const MAX_RECENT = 8;

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch { return []; }
}
function addRecent(sym) {
  try {
    let arr = getRecent();
    arr = [sym, ...arr.filter(s => s.symbol !== sym.symbol)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(arr));
  } catch { }
}

// ── Type detection ─────────────────────────────────────────────────────────
// NOTE: The server already sets the correct `type` field on every symbol.
// This fallback only fires for symbols loaded from localStorage (recent
// searches) that may predate the server's type field.
function getType(sym) {
  if (sym.type) return sym.type;
  const s = sym.symbol.toUpperCase();
  if (/\d{2}[A-Z]{3}\d+(CE|PE)$/.test(s)) return "option";
  if (/\d{2}[A-Z]{3}FUT$/.test(s)) return "future";
  if (s.startsWith("MCX:")) return "commodity";
  if (s.includes("INDEX") || s.includes("SENSEX")) return "index";
  if (s.endsWith("-ETF") || s.endsWith("-EF")) return "etf";
  return "equity";
}

function getExchange(sym) {
  const idx = sym.symbol.indexOf(":");
  return idx >= 0 ? sym.symbol.slice(0, idx) : "NSE";
}

function getTicker(sym) {
  const idx = sym.symbol.indexOf(":");
  return idx >= 0 ? sym.symbol.slice(idx + 1) : sym.symbol;
}

// ── Display name for a symbol ─────────────────────────────────────────────
// For commodity-type entries the server returns the clean name ("Crude Oil (MCX)")
// For future-type entries it may return "Crude Oil FUT (26JUL)"
// We always show sym.name as-is — the server sets it correctly.
function getDisplayName(sym) {
  return sym.name;
}

// ── Ticker display: strip the dated month from MCX futures for readability ──
// "CRUDEOIL26JULFUT" → "CRUDEOIL" for the sub-line ticker display only
function getDisplayTicker(sym) {
  const ticker = getTicker(sym);
  // Strip dated month+FUT suffix for MCX futures so the ticker reads cleanly
  return ticker.replace(/\d{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/i, "");
}

// ── Type badge config ───────────────────────────────────────────────────────
const TYPE_META = {
  index: { label: "INDEX", color: "#3d84ff", bg: "rgba(61,132,255,0.13)" },
  equity: { label: "EQ", color: "#00d97e", bg: "rgba(0,217,126,0.11)" },
  commodity: { label: "COMDTY", color: "#ffc135", bg: "rgba(255,193,53,0.12)" },
  future: { label: "FUT", color: "#ff5c8a", bg: "rgba(255,92,138,0.13)" },
  option: { label: "OPT", color: "#22c3dd", bg: "rgba(34,195,221,0.13)" },
  etf: { label: "ETF", color: "#7c5cfc", bg: "rgba(124,92,252,0.13)" },
};

// ── Category tabs ───────────────────────────────────────────────────────────
const TABS = [
  { id: "all", label: "All" },
  { id: "equity", label: "Stocks" },
  { id: "index", label: "Index" },
  { id: "commodity", label: "Commodity" },
  { id: "future", label: "Futures" },
  { id: "option", label: "Options" },
  { id: "etf", label: "ETF" },
];

// ── Search aliases ─────────────────────────────────────────────────────────
// Maps common alternate spellings/abbreviations to the name string to match.
const SEARCH_ALIASES = {
  "nat gas": "natural gas",
  "natgas": "natural gas",
  "nat. gas": "natural gas",
  "ng": "natural gas",
  "nat gas mini": "natural gas mini",
  "ngm": "natural gas mini",
  "natgasmini": "natural gas mini",
  "crude": "crude oil",
  "crudeoil": "crude oil",
  "crude mini": "crude oil mini",
  "crudeoilm": "crude oil mini",
  "silvermic": "silver micro",
  "silver micro": "silver micro",
  "zincmini": "zinc mini",
  "leadmini": "lead mini",
  "goldm": "gold mini",
  "goldpetal": "gold petal",
};

// ═══════════════════════════════════════════════════════════════════════════
// SymbolSearch
// Props:
//   isOpen      — boolean
//   onClose     — () => void
//   onSelect    — (symbolString) => void
//   onOpenOptionsChain — (sym) => void  (optional; called instead of onSelect
//                         when picking a result while the "Options" tab is
//                         active, since options need a strike chain, not a
//                         single symbol)
// initialQuery — string (optional) — seeds the search box on open, used by
//                the "type anywhere to search" shortcut (the keystroke that
//                triggered the open is the first character of the query,
//                so the modal must open already showing it, not empty).
export default function SymbolSearch({ isOpen, onClose, onSelect, onOpenOptionsChain, initialQuery }) {
  const [symbols, setSymbols] = useState([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  const inputRef = useRef(null);

  // Load symbols once
  useEffect(() => { loadSymbols().then(setSymbols); }, []);

  // Fresh recent list when opened
  useEffect(() => {
    if (isOpen) {
      setQuery(initialQuery || "");
      setTab("all");
      setActiveIdx(-1);
      setRecent(getRecent());
      const t = setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        // Cursor at the end, not a full selection — so the next keystroke
        // extends what was already typed instead of replacing it.
        if (initialQuery) el.setSelectionRange(el.value.length, el.value.length);
      }, 60);
      return () => clearTimeout(t);
    }
  }, [isOpen, initialQuery]);

  // Prune Recent Searches against the live symbol list. A dated future/option
  // (e.g. a monthly contract) that has since expired and been pruned
  // server-side would otherwise sit in localStorage forever — or until
  // pushed out by MAX_RECENT newer searches — and clicking it would send an
  // expired/invalid symbol straight to the chart, failing the exact same way
  // a stale dated MCX/NSE contract request does elsewhere in the app.
  // Equities/indices never expire, so this only ever drops genuinely dead
  // dated contracts, never a real symbol.
  useEffect(() => {
    if (isOpen && symbols.length > 0) {
      const validSymbols = new Set(symbols.map(s => s.symbol));
      setRecent(prev => {
        const pruned = prev.filter(s => validSymbols.has(s.symbol));
        if (pruned.length !== prev.length) {
          try { localStorage.setItem(RECENT_KEY, JSON.stringify(pruned)); } catch { }
        }
        return pruned;
      });
    }
  }, [isOpen, symbols]);

  // Live search filter
  useEffect(() => {
    const q = query.toLowerCase().trim();
    if (!q) { setResults([]); setActiveIdx(-1); return; }

    // Resolve alias (e.g. "natgas" → "natural gas")
    const expandedQ = SEARCH_ALIASES[q] || q;

    let pool = symbols;
    if (tab === "option") {
      // Options tab: show underlyings (equity, index, commodity) — picking one
      // opens the live options chain modal.
      pool = symbols.filter(s => {
        const t = getType(s);
        return t === "equity" || t === "index" || t === "commodity";
      });
    } else if (tab !== "all") {
      pool = symbols.filter(s => getType(s) === tab);
    }

    const hits = pool
      .filter(s => {
        const name = s.name.toLowerCase();
        const ticker = getTicker(s).toLowerCase();
        // Strip dated month suffix (e.g. "26JULFUT") to match on root only
        const root = ticker
          .replace(/\d{2}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)fut$/i, "")
          .replace(/-(eq|be|index|etf|pp|sm|i)$/i, "");
        return (
          name.startsWith(q) || name.includes(q) ||
          name.startsWith(expandedQ) || name.includes(expandedQ) ||
          ticker.startsWith(q) || root.startsWith(q) || root.includes(q)
        );
      })
      .sort((a, b) => {
        const q2 = expandedQ;
        const rA = getTicker(a).toLowerCase()
          .replace(/\d{2}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)fut$/i, "")
          .replace(/-(eq|be|index|etf|i)$/i, "");
        const rB = getTicker(b).toLowerCase()
          .replace(/\d{2}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)fut$/i, "")
          .replace(/-(eq|be|index|etf|i)$/i, "");
        const sA = rA.startsWith(q) || rA.startsWith(q2) ? 0
          : a.name.toLowerCase().startsWith(q) || a.name.toLowerCase().startsWith(q2) ? 1 : 2;
        const sB = rB.startsWith(q) || rB.startsWith(q2) ? 0
          : b.name.toLowerCase().startsWith(q) || b.name.toLowerCase().startsWith(q2) ? 1 : 2;
        if (sA !== sB) return sA - sB;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 24);

    setResults(hits);
    setActiveIdx(-1);
  }, [query, tab, symbols]);

  // Keyboard nav
  function handleKeyDown(e) {
    const list = query ? results : recent;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      if (activeIdx >= 0 && list[activeIdx]) {
        handleSelect(list[activeIdx]);
      } else if (query.trim()) {
        onSelect(query.trim().toUpperCase());
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  function handleSelect(sym) {
    addRecent(sym);
    if (tab === "option" && onOpenOptionsChain) {
      onOpenOptionsChain(sym);
      onClose();
      return;
    }
    onSelect(sym.symbol);
    onClose();
  }

  function handleOverlayDown(e) {
    if (e.target === e.currentTarget) onClose();
  }

  if (!isOpen) return null;

  const showRecent = !query && recent.length > 0;
  const showResults = !!query;
  const showEmpty = showResults && results.length === 0;
  const showHint = !query && recent.length === 0;

  return (
    <div className="ss-overlay" onMouseDown={handleOverlayDown}>
      <div className="ss-modal" role="dialog" aria-modal="true" aria-label="Symbol Search">

        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="ss-header">
          <div className="ss-search-row">
            <SearchIcon />
            <input
              ref={inputRef}
              className="ss-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search symbol or company…"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button className="ss-icon-btn" onClick={() => setQuery("")} title="Clear">
                <ClearIcon />
              </button>
            )}
            <button className="ss-icon-btn ss-close-btn" onClick={onClose} title="Close (Esc)">
              <CloseIcon />
            </button>
          </div>

          {/* Tabs */}
          <div className="ss-tabs" role="tablist">
            {TABS.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`ss-tab${tab === t.id ? " ss-tab-active" : ""}`}
                onClick={() => { setTab(t.id); setActiveIdx(-1); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="ss-body">

          {/* Recent */}
          {showRecent && (
            <div className="ss-section">
              <div className="ss-section-label">
                <ClockIcon /> Recent Searches
              </div>
              {recent.map((s, i) => (
                <SymbolRow
                  key={s.symbol}
                  sym={s}
                  active={i === activeIdx}
                  onSelect={handleSelect}
                  onHover={() => setActiveIdx(i)}
                  optionsMode={tab === "option"}
                />
              ))}
            </div>
          )}

          {/* Results */}
          {showResults && !showEmpty && (
            <div className="ss-section">
              {results.map((s, i) => (
                <SymbolRow
                  key={s.symbol}
                  sym={s}
                  active={i === activeIdx}
                  onSelect={handleSelect}
                  onHover={() => setActiveIdx(i)}
                  optionsMode={tab === "option"}
                />
              ))}
            </div>
          )}

          {/* No results */}
          {showEmpty && (
            <div className="ss-empty">
              <div className="ss-empty-glyph">⊘</div>
              <div className="ss-empty-msg">No results for <strong>"{query}"</strong></div>
              <div className="ss-empty-sub">Try a ticker (e.g. RELIANCE, CRUDE OIL) or company name</div>
            </div>
          )}

          {/* First-open hint */}
          {showHint && (
            <div className="ss-empty">
              <div className="ss-empty-glyph">⌕</div>
              <div className="ss-empty-msg">Search NSE, MCX or Indices</div>
              <div className="ss-empty-sub">Type a company name or ticker symbol</div>
            </div>
          )}

        </div>

        {/* ── Footer hint ─────────────────────────────────────────── */}
        <div className="ss-footer">
          <span><KbdKey>↑↓</KbdKey> navigate</span>
          <span><KbdKey>↵</KbdKey> select</span>
          <span><KbdKey>Esc</KbdKey> close</span>
        </div>

      </div>
    </div>
  );
}

// ── Symbol row ─────────────────────────────────────────────────────────────
function SymbolRow({ sym, active, onSelect, onHover, optionsMode }) {
  const type = getType(sym);
  const exchange = getExchange(sym);
  const ticker = getDisplayTicker(sym);  // clean ticker without dated month
  const meta = optionsMode
    ? { label: "CHAIN →", color: "#22c3dd", bg: "rgba(34,195,221,0.13)" }
    : (TYPE_META[type] || { label: "SYM", color: "#7a8099", bg: "rgba(122,128,153,0.1)" });

  return (
    <div
      className={`ss-row${active ? " ss-row-active" : ""}`}
      onMouseDown={() => onSelect(sym)}
      onMouseEnter={onHover}
    >
      <div className="ss-row-icon">
        <ExchangeDot exchange={exchange} />
      </div>
      <div className="ss-row-body">
        <div className="ss-row-name">{getDisplayName(sym)}</div>
        <div className="ss-row-sub">
          <span className="ss-exchange">{exchange}</span>
          <span className="ss-sep2">·</span>
          <span className="ss-ticker">{ticker}</span>
        </div>
      </div>
      <div className="ss-row-badge">
        <span className="ss-badge" style={{ color: meta.color, background: meta.bg }}>
          {meta.label}
        </span>
      </div>
    </div>
  );
}

// ── Exchange dot ───────────────────────────────────────────────────────────
const EXCH_COLORS = {
  NSE: "#00d97e",
  BSE: "#ffc135",
  MCX: "#ff8c00",
};
function ExchangeDot({ exchange }) {
  const color = EXCH_COLORS[exchange] || "#7a8099";
  return (
    <div className="ss-exch-dot" style={{ background: color + "22", border: `1px solid ${color}44` }}>
      <span style={{ color, fontSize: 7, fontWeight: 800, letterSpacing: "0.02em" }}>
        {exchange.slice(0, 1)}
      </span>
    </div>
  );
}

// ── Kbd hint ───────────────────────────────────────────────────────────────
function KbdKey({ children }) {
  return <span className="ss-kbd">{children}</span>;
}

// ── Icons (inline SVG, no external deps) ───────────────────────────────────
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="ss-search-icon">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}