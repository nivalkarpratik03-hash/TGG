// OptionsChainModal.js
// ─────────────────────────────────────────────────────────────────────────
// TradingView-style options chain: expiry-month tabs + Calls/Strike/Puts
// ladder.
//
// ROOT-CAUSE FIX (2026-08-11): this used to build everything OFFLINE —
// guessing the strike step/ladder locally (buildStrikeLadder) and hand-
// encoding Fyers' expiry date format (nextMonthlyExpiries + optionSymbol).
// That guessed encoding is frequently rejected by Fyers as "Invalid symbol
// provided" (confirmed live: MCX:GOLDM26AUG152800CE — a guessed strike/
// expiry combo that was never actually listed), which is the exact same
// class of bug AtmWorkspace.js's Ctrl+Q flow and ChartsPage.js's Auto-ATM
// were already fixed for by going through GET /api/options/chain instead
// of guessing. This modal now does the same: it fetches the REAL expiry
// list and REAL per-strike symbol strings straight from Fyers (via the
// backend's /api/options/chain route → fyers/client.js's fetchOptionChain),
// and never constructs a symbol string itself. See utils/optionsChain.js —
// buildStrikeLadder/optionSymbol/nextMonthlyExpiries and their private
// helpers were deleted there since this was their only caller.
//
// Supports: NSE equities, NSE/BSE indices, MCX commodities.
// ─────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import "./OptionsChainModal.css";
import { getOptionRoot, MCX_COMMODITIES, WEEKLY_EXPIRY_COMMODITIES } from "../../utils/optionsChain";
import { BACKEND } from "../../config";

const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Fyers' expiryData[].date has been observed in both ISO ("YYYY-MM-DD") and
// "DD-MM-YYYY" form — try ISO first, then DD-MM-YYYY, and fall back to null
// (never an Invalid Date) rather than guess. Mirrors the same dual-format
// parsing backend/src/derivatives/derivativesGapFill.js already uses for
// this exact field, kept separate here since browser code can't import that
// Node module (same pattern as holidays.js/holidayCalendar.js).
function parseExpiryDateString(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const iso = new Date(dateStr + "T00:00:00");
  if (!isNaN(iso.getTime())) return iso;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dateStr);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function formatExpiryLabel(dateStr) {
  const d = parseExpiryDateString(dateStr);
  if (!d) return dateStr || "?"; // never seen a fresh sample — show the raw string rather than hide it
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd} ${MONTH_CODES[d.getMonth()]}`;
}

// Props:
//   isOpen      — boolean
//   onClose     — () => void
//   underlying  — { symbol, name } of the equity/index/commodity
//   spot        — number | null — last close price (cosmetic ATM highlight
//                 + spot line only; never used to build or guess a symbol)
//   onSelect    — (optionSymbolString) => void
export default function OptionsChainModal({ isOpen, onClose, underlying, spot, loading, onSelect }) {
  const [expiries, setExpiries] = useState([]); // [{date, expiry}] straight from Fyers
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [rows, setRows] = useState({ ce: new Map(), pe: new Map() }); // strike_price -> real symbol, for the ACTIVE tab only
  const [chainLoading, setChainLoading] = useState(false);
  const [chainErr, setChainErr] = useState(null);

  // Cache of already-fetched expiries, keyed by that expiry's `expiry`
  // timestamp — switching tabs back and forth never re-hits the network.
  const cacheRef = useRef(new Map());

  const { root, isIndex, isCommodity } = useMemo(
    () => (underlying ? getOptionRoot(underlying.symbol) : { root: "", isIndex: false, isCommodity: false }),
    [underlying]
  );

  const isWeeklyExpiry = isCommodity && WEEKLY_EXPIRY_COMMODITIES.has(root);
  const commCfg = isCommodity ? MCX_COMMODITIES[root] : null;

  const fetchChain = useCallback((timestamp) => {
    const params = new URLSearchParams({ symbol: underlying.symbol, strikeCount: "20" });
    if (timestamp) params.set("timestamp", String(timestamp));
    return fetch(`${BACKEND}/api/options/chain?${params.toString()}`).then(async (res) => {
      if (res.ok) return res.json();
      if (res.status === 401) throw new Error("Session expired — please re-authenticate with Fyers");
      let message = `Request failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch { /* body wasn't JSON — keep the fallback message */ }
      throw new Error(message);
    });
  }, [underlying]);

  const applyChainData = useCallback((data) => {
    const ce = new Map();
    const pe = new Map();
    for (const s of data.strikes || []) {
      if (s.option_type === "CE") ce.set(s.strike_price, s.symbol);
      else if (s.option_type === "PE") pe.set(s.strike_price, s.symbol);
    }
    setRows({ ce, pe });
  }, []);

  // Full reset + fetch the nearest expiry whenever the modal opens on a new
  // underlying — gives us both the real expiry list (for tabs) and that
  // first tab's real strikes in one call.
  useEffect(() => {
    if (!isOpen || !underlying) return;
    let cancelled = false;
    setExpiryIdx(0);
    setExpiries([]);
    setRows({ ce: new Map(), pe: new Map() });
    setChainErr(null);
    cacheRef.current = new Map();
    setChainLoading(true);

    fetchChain(null)
      .then((data) => {
        if (cancelled) return;
        const exps = data.expiries || [];
        setExpiries(exps);
        applyChainData(data);
        if (exps[0]) cacheRef.current.set(exps[0].expiry, data);
      })
      .catch((err) => { if (!cancelled) setChainErr(err.message); })
      .finally(() => { if (!cancelled) setChainLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, underlying?.symbol]);

  // Switch tab → use the cache if we already have this expiry's real
  // strikes, otherwise fetch that specific expiry's timestamp.
  const selectExpiry = useCallback((idx) => {
    setExpiryIdx(idx);
    const exp = expiries[idx];
    if (!exp) return;
    const cached = cacheRef.current.get(exp.expiry);
    if (cached) {
      applyChainData(cached);
      setChainErr(null);
      return;
    }
    let cancelled = false;
    setChainLoading(true);
    setChainErr(null);
    fetchChain(exp.expiry)
      .then((data) => {
        if (cancelled) return;
        cacheRef.current.set(exp.expiry, data);
        applyChainData(data);
      })
      .catch((err) => { if (!cancelled) setChainErr(err.message); })
      .finally(() => { if (!cancelled) setChainLoading(false); });
    return () => { cancelled = true; };
  }, [expiries, fetchChain, applyChainData]);

  if (!isOpen || !underlying) return null;

  const expiry = expiries[expiryIdx];

  // Merge CE/PE strike sets — real data occasionally lists a strike on only
  // one side near the edges of the ladder, so union rather than assume both
  // sides always match.
  const strikes = Array.from(new Set([...rows.ce.keys(), ...rows.pe.keys()])).sort((a, b) => a - b);

  const atm = (spot && strikes.length)
    ? strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best))
    : null;

  function handleOverlayDown(e) {
    if (e.target === e.currentTarget) onClose();
  }

  function pick(strike, kind) {
    const sym = kind === "CE" ? rows.ce.get(strike) : rows.pe.get(strike);
    if (!sym) return; // shouldn't happen — button only renders when the symbol exists
    onSelect(sym);
    onClose();
  }

  return (
    <div className="oc-overlay" onMouseDown={handleOverlayDown}>
      <div className="oc-modal" role="dialog" aria-modal="true" aria-label="Options Chain">

        {/* Header */}
        <div className="oc-header">
          <div className="oc-title-row">
            <div className="oc-title-left">
              <span className="oc-title">{underlying.name} Options</span>
              {isCommodity && (
                <span className="oc-badge oc-badge-commodity">MCX</span>
              )}
              {isIndex && (
                <span className="oc-badge oc-badge-index">INDEX</span>
              )}
              {isWeeklyExpiry && (
                <span className="oc-badge oc-badge-weekly" title="Silver Micro has weekly expiries every Friday">WEEKLY</span>
              )}
              {commCfg && (
                <span className="oc-badge oc-badge-unit">{commCfg.unit}</span>
              )}
            </div>
            <button className="oc-icon-btn" onClick={onClose} title="Close (Esc)">
              <CloseIcon />
            </button>
          </div>

          {/* Expiry tabs — real dates straight from Fyers, no guessing */}
          {expiries.length > 0 && (
            <div className="oc-expiry-tabs">
              {expiries.map((e, i) => (
                <button
                  key={e.expiry ?? i}
                  className={`oc-expiry-tab${i === expiryIdx ? " oc-expiry-tab-active" : ""}`}
                  onClick={() => selectExpiry(i)}
                >
                  {formatExpiryLabel(e.date)}
                </button>
              ))}
            </div>
          )}

          {/* Column headers */}
          <div className="oc-col-headers">
            <span className="oc-col-calls">Calls</span>
            <span className="oc-col-strike">
              Strike {commCfg ? <span className="oc-col-strike-unit">({commCfg.unit})</span> : null}
            </span>
            <span className="oc-col-puts">Puts</span>
          </div>
        </div>

        {/* Body */}
        <div className="oc-body">
          {chainErr ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">Couldn't load the options chain</div>
              <div className="oc-empty-sub">{chainErr}</div>
            </div>
          ) : chainLoading && strikes.length === 0 ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">Loading {underlying.name} options…</div>
              <div className="oc-empty-sub">Fetching the real chain from Fyers.</div>
            </div>
          ) : loading && !spot ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">Loading {underlying.name} price…</div>
              <div className="oc-empty-sub">Fetching the latest data for the spot line.</div>
            </div>
          ) : strikes.length === 0 ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">No strikes available for {expiry ? formatExpiryLabel(expiry.date) : "this expiry"}</div>
            </div>
          ) : (
            strikes.map((strike, idx) => {
              const callSym = rows.ce.get(strike);
              const putSym = rows.pe.get(strike);
              const isAtm = strike === atm;

              const nextStrike = strikes[idx + 1];
              const showSpotLine = spot && nextStrike && spot > strike && spot < nextStrike;

              const strikeFmt = Number.isInteger(strike)
                ? strike.toLocaleString("en-IN")
                : strike.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

              return (
                <React.Fragment key={strike}>
                  <div className={`oc-row${isAtm ? " oc-row-atm" : ""}`}>
                    {callSym ? (
                      <button className="oc-cell oc-call" onClick={() => pick(strike, "CE")} title={callSym}>
                        Call {strikeFmt}
                      </button>
                    ) : <span className="oc-cell" />}
                    <span className="oc-strike">{strikeFmt}</span>
                    {putSym ? (
                      <button className="oc-cell oc-put" onClick={() => pick(strike, "PE")} title={putSym}>
                        Put {strikeFmt}
                      </button>
                    ) : <span className="oc-cell" />}
                  </div>
                  {showSpotLine && (
                    <div className="oc-spot-line-row">
                      <div className="oc-spot-line-left" />
                      <div className="oc-spot-line-badge">
                        {root} {spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className="oc-spot-line-right" />
                    </div>
                  )}
                </React.Fragment>
              );
            })
          )}
        </div>

      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}