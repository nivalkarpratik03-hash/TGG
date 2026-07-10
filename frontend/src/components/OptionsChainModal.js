// OptionsChainModal.js
// ─────────────────────────────────────────────────────────────────────────
// TradingView-style options chain: expiry-month tabs + Calls/Strike/Puts
// ladder. 100% offline — no Fyers API calls. Strike ladder is centered on
// the spot price the caller passes in (the underlying's last known close,
// already available from chart data — never fetched separately here).
// Supports: NSE equities, NSE/BSE indices, MCX commodities.
// ─────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useEffect } from "react";
import "../styles/OptionsChainModal.css";
import {
  nextMonthlyExpiries,
  buildStrikeLadder,
  getOptionRoot,
  optionSymbol,
  MCX_COMMODITIES,
  WEEKLY_EXPIRY_COMMODITIES,
} from "../utils/optionsChain";

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

  const isWeeklyExpiry = isCommodity && WEEKLY_EXPIRY_COMMODITIES.has(root);

  // nextMonthlyExpiries uses the same roll logic as symbolsRouter so the
  // first expiry tab always matches the contract month shown in search results.
  //
  // BUG FIX: this call never passed the 3rd arg (indexRoot), so the
  // "NIFTY/SENSEX trade weekly" branch inside nextMonthlyExpiries() was
  // never reached from the real UI — NIFTY and SENSEX silently fell through
  // to the generic monthly-only path, showing the wrong expiry tabs (missing
  // every weekly expiry, and using the wrong weekday for the monthly one).
  // Passing `isIndex ? root : null` lets nextMonthlyExpiries look up
  // INDEX_WEEKLY_EXPIRY_DAY[root] itself — it already no-ops correctly for
  // every other index (BANKNIFTY/FINNIFTY/MIDCPNIFTY/NIFTYIT), which aren't
  // in that table and fall through to the monthly-only path as intended.
  const expiries = useMemo(
    () => nextMonthlyExpiries(isWeeklyExpiry ? 4 : 3, isCommodity ? root : null, isIndex ? root : null),
    [isCommodity, isIndex, isWeeklyExpiry, root]
  );

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

          {/* Expiry tabs */}
          <div className="oc-expiry-tabs">
            {expiries.map((e, i) => (
              <button
                key={e.code + i}
                className={`oc-expiry-tab${i === expiryIdx ? " oc-expiry-tab-active" : ""}`}
                onClick={() => setExpiryIdx(i)}
                title={e.approx ? "Approximate — verify exact expiry date with your broker before expiry day" : undefined}
              >
                {e.label}
              </button>
            ))}
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