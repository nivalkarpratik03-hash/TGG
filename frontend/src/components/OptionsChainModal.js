// OptionsChainModal.js
// ─────────────────────────────────────────────────────────────────────────
// TradingView-style options chain: expiry-month tabs + Calls/Strike/Puts
// ladder. 100% offline — no Fyers API calls. Strike ladder is centered on
// the spot price the caller passes in (the underlying's last known close,
// already available from chart data — never fetched separately here).
// Supports: NSE equities, NSE/BSE indices, MCX commodities.
// ─────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useEffect, useCallback } from "react";
import "../styles/OptionsChainModal.css";
import {
  nextMonthlyExpiries,
  buildStrikeLadder,
  getOptionRoot,
  optionSymbol,
  MCX_COMMODITIES,
  WEEKLY_EXPIRY_COMMODITIES,
  INDEX_WEEKLY_EXPIRY_DAY,
} from "../utils/optionsChain";
import { BACKEND } from "../config";

// Props:
//   isOpen      — boolean
//   onClose     — () => void
//   underlying  — { symbol, name } of the equity/index/commodity
//   spot        — number | null — last close price
//   onSelect    — (optionSymbolString) => void
export default function OptionsChainModal({ isOpen, onClose, underlying, spot, loading, onSelect }) {
  const [expiryIdx, setExpiryIdx] = useState(0);

  useEffect(() => { if (isOpen) setExpiryIdx(0); }, [isOpen, underlying?.symbol]);

  // eslint-disable-next-line no-unused-vars
  const { exch, root, isIndex, isCommodity, strikeStep, commodityName } = useMemo(
    () => (underlying ? getOptionRoot(underlying.symbol) : { exch: "NSE", root: "", isIndex: false, isCommodity: false, strikeStep: 50, decimals: 0 }),
    [underlying]
  );

  const isWeeklyCommodity = isCommodity && WEEKLY_EXPIRY_COMMODITIES.has(root);
  // NIFTY/SENSEX trade weekly (Tuesday/Thursday respectively) — every other
  // index (BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYIT) is monthly-only.
  const isWeeklyIndex = isIndex && INDEX_WEEKLY_EXPIRY_DAY[root] != null;
  const isWeeklyExpiry = isWeeklyCommodity || isWeeklyIndex;

  // ── Expiry list: fetch live from Fyers via backend, fall back to local calc ──
  // Local calc (nextMonthlyExpiries) uses hardcoded calendar math and can be
  // wrong around expiry day. Fyers always knows the exact dates.
  const localExpiries = useMemo(
    () => nextMonthlyExpiries(
      isWeeklyExpiry ? 6 : 3,
      isCommodity ? root : null,
      isIndex ? root : null
    ),
    [isCommodity, isIndex, isWeeklyExpiry, root]
  );
  const [expiries, setExpiries] = useState(localExpiries);
  const [expiriesSource, setExpiriesSource] = useState("local"); // "local" | "fyers"

  const fetchLiveExpiries = useCallback(async () => {
    if (!underlying?.symbol) return;
    // Derive the underlying symbol for option chains
    // (e.g. option symbol → its index, equity → itself)
    const underlyingSym = underlying.symbol;
    try {
      const res = await fetch(`${BACKEND}/api/options/expiries?symbol=${encodeURIComponent(underlyingSym)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.expiries && data.expiries.length > 0) {
        // Convert "DD-MM-YYYY" strings to the { label, code, approx } shape
        // that the rest of the modal expects from nextMonthlyExpiries.
        // code = the Fyers monthly expiry code used in option symbols (e.g. "26JUL")
        const MONTH_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
        const shaped = data.expiries.map((dateStr) => {
          const [dd, mm, yyyy] = dateStr.split("-");
          const yy = yyyy.slice(2);
          const monIdx = parseInt(mm, 10) - 1;
          const code = `${yy}${MONTH_SHORT[monIdx]}`;
          return { label: dateStr, code, approx: false };
        });
        setExpiries(shaped);
        setExpiriesSource("fyers");
      }
    } catch (err) {
      // Silently fall back to local — no error shown to user
      setExpiries(localExpiries);
      setExpiriesSource("local");
    }
  }, [underlying?.symbol, localExpiries]);

  useEffect(() => {
    if (!isOpen) return;
    setExpiries(localExpiries);   // show local immediately
    setExpiriesSource("local");
    fetchLiveExpiries();          // then upgrade to live Fyers data
  }, [isOpen, underlying?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pass override step for commodities; for indices pass the root so INDEX_STRIKE_STEPS kicks in
  const { strikes, atm } = useMemo(
    () => buildStrikeLadder(
      spot,
      isIndex ? root : null,
      14,
      isCommodity ? strikeStep : null
    ),
    [spot, isIndex, isCommodity, root, strikeStep]
  );

  if (!isOpen || !underlying) return null;

  const expiry = expiries[expiryIdx];
  const noSpot = !spot || spot <= 0;

  // Commodity config for the unit badge
  const commCfg = isCommodity ? MCX_COMMODITIES[root] : null;

  function handleOverlayDown(e) {
    if (e.target === e.currentTarget) onClose();
  }

  function pick(strike, kind) {
    const sym = optionSymbol(exch, root, expiry.code, strike, kind);
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
                <span
                  className="oc-badge oc-badge-weekly"
                  title={
                    isWeeklyIndex
                      ? `${root} has a weekly expiry every ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][INDEX_WEEKLY_EXPIRY_DAY[root]]}`
                      : "Silver Micro has weekly expiries every Friday"
                  }
                >
                  WEEKLY
                </span>
              )}
              {commCfg && (
                <span className="oc-badge oc-badge-unit">{commCfg.unit}</span>
              )}
            </div>
            <button className="oc-icon-btn" onClick={onClose} title="Close (Esc)">
              <CloseIcon />
            </button>
          </div>

          {/* Expiry tabs */}
          <div className="oc-expiry-tabs">
            {expiries.map((e, i) => (
              <button
                key={e.code + i}
                className={`oc-expiry-tab${i === expiryIdx ? " oc-expiry-tab-active" : ""}`}
                onClick={() => setExpiryIdx(i)}
                title={e.approx ? "Approximate — verify exact expiry date with your broker before expiry day" : "Expiry date from Fyers"}
              >
                {e.label}
              </button>
            ))}
            <span
              className={`oc-expiry-source-badge oc-expiry-source-${expiriesSource}`}
              title={expiriesSource === "fyers" ? "Expiry dates fetched live from Fyers" : "Approximate dates — could not reach Fyers"}
            >
              {expiriesSource === "fyers" ? "● live" : "~ approx"}
            </span>
          </div>
          {expiry?.approx && (
            <div className="oc-expiry-approx-note">
              ~ Approximate date — {isWeeklyExpiry ? "Silver Micro expires every Friday; confirm exact date with your broker" : "MCX confirms the exact expiry a few days ahead each month"}
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
          {noSpot ? (
            loading ? (
              <div className="oc-empty">
                <div className="oc-empty-msg">Loading {underlying.name} price…</div>
                <div className="oc-empty-sub">Fetching the latest data to build the strike range.</div>
              </div>
            ) : (
              <div className="oc-empty">
                <div className="oc-empty-msg">No price data loaded yet for {underlying.name}</div>
                <div className="oc-empty-sub">Open this symbol's chart first so a strike range can be built around its last price.</div>
              </div>
            )
          ) : strikes.length === 0 ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">Couldn't build a strike ladder</div>
            </div>
          ) : (
            strikes.map((strike, idx) => {
              const callSym = optionSymbol(exch, root, expiry.code, strike, "CE");
              const putSym = optionSymbol(exch, root, expiry.code, strike, "PE");
              const isAtm = strike === atm;

              const nextStrike = strikes[idx + 1];
              const showSpotLine = spot && nextStrike && spot > strike && spot < nextStrike;

              const strikeFmt = Number.isInteger(strike)
                ? strike.toLocaleString("en-IN")
                : strike.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

              return (
                <React.Fragment key={strike}>
                  <div className={`oc-row${isAtm ? " oc-row-atm" : ""}`}>
                    <button className="oc-cell oc-call" onClick={() => pick(strike, "CE")} title={callSym}>
                      Call {strikeFmt}
                    </button>
                    <span className="oc-strike">{strikeFmt}</span>
                    <button className="oc-cell oc-put" onClick={() => pick(strike, "PE")} title={putSym}>
                      Put {strikeFmt}
                    </button>
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