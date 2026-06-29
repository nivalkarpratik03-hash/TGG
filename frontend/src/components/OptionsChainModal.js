// OptionsChainModal.js
// ─────────────────────────────────────────────────────────────────────────
// TradingView-style options chain: expiry-month tabs + Calls/Strike/Puts
// ladder. Strike ladder is centered on the spot price the caller passes in
// (the underlying's last known close, already available from chart data).
//
// ROOT-CAUSE NOTE: this used to build each cell's option symbol locally via
// optionSymbol() (guessed Fyers date-encoding). That guess regularly
// produced symbols Fyers rejected as "Invalid symbol provided" — a
// widely-reported problem with that encoding scheme, not unique to this
// project. Symbols are now fetched live from Fyers' own option chain
// response (/api/options/chain), which returns the literal, always-valid
// `symbol` string per strike — no guessing. The local strike ladder
// (buildStrikeLadder) is still used to decide WHICH strikes to show/center
// around spot, but the actual symbol string for each cell comes from the
// live chain lookup, not from optionSymbol().
// ─────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useEffect, useCallback } from "react";
import "../styles/OptionsChainModal.css";
import {
  nextMonthlyExpiries,
  buildStrikeLadder,
  getOptionRoot,
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
  // wrong around expiry day. Fyers always knows the exact dates AND gives us
  // the `expiry` timestamp value each tab needs to fetch ITS real strikes.
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
    const underlyingSym = underlying.symbol;
    try {
      const res = await fetch(`${BACKEND}/api/options/chain?symbol=${encodeURIComponent(underlyingSym)}&strikeCount=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.expiries && data.expiries.length > 0) {
        // Keep both the display date AND the raw `expiry` timestamp — the
        // timestamp is what /api/options/chain needs to fetch THIS expiry's
        // real strikes (omitting it always returns the nearest expiry only).
        const MONTH_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
        const shaped = data.expiries.map((e) => {
          const dateStr = e.date;
          let label = dateStr;
          try {
            const [dd, mm, yyyy] = dateStr.split("-");
            label = `${dd} ${MONTH_SHORT[parseInt(mm, 10) - 1]}`;
          } catch { /* keep raw date string if parsing fails */ }
          return { label, timestamp: e.expiry, approx: false };
        });
        setExpiries(shaped);
        setExpiriesSource("fyers");
      }
    } catch (err) {
      // Silently fall back to local — no error shown to user. NOTE: local
      // fallback expiries have no `timestamp`, so the chain fetch below
      // will request the nearest expiry's strikes regardless of which
      // local tab is selected — see the "approx" warning shown in that case.
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

  // ── Real strike symbols for the SELECTED expiry tab ───────────────────────
  // Fetched fresh whenever the expiry tab or underlying changes. Keyed by
  // "strike:CE"/"strike:PE" → real Fyers symbol string.
  const [strikeSymbols, setStrikeSymbols] = useState(new Map());
  const [chainStatus, setChainStatus] = useState("idle"); // idle | loading | ok | error

  useEffect(() => {
    if (!isOpen || !underlying?.symbol) return;
    const expiry = expiries[expiryIdx];
    let cancelled = false;
    setChainStatus("loading");
    const params = new URLSearchParams({ symbol: underlying.symbol, strikeCount: "20" });
    if (expiry?.timestamp) params.set("timestamp", expiry.timestamp);

    fetch(`${BACKEND}/api/options/chain?${params.toString()}`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => {
        if (cancelled) return;
        const map = new Map();
        for (const s of data.strikes || []) {
          map.set(`${s.strike_price}:${s.option_type}`, s.symbol);
        }
        setStrikeSymbols(map);
        setChainStatus(map.size > 0 ? "ok" : "error");
      })
      .catch(() => {
        if (cancelled) return;
        setStrikeSymbols(new Map());
        setChainStatus("error");
      });

    return () => { cancelled = true; };
  }, [isOpen, underlying?.symbol, expiryIdx, expiries]);

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

  // Looks up the REAL Fyers symbol for a strike+kind from the live chain
  // fetch. Returns null if not yet loaded/available — callers must guard
  // against null rather than falling back to a hand-built guess, since
  // that guess is exactly what was producing "Invalid symbol" errors.
  function realSymbolFor(strike, kind) {
    return strikeSymbols.get(`${strike}:${kind}`) || null;
  }

  function pick(strike, kind) {
    const sym = realSymbolFor(strike, kind);
    if (!sym) return; // not loaded yet / Fyers doesn't list this strike — button is disabled in this case anyway
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
                key={(e.timestamp || e.code || e.label) + i}
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
          {chainStatus === "error" && (
            <div className="oc-expiry-approx-note">
              Couldn't load live strike symbols from Fyers for this expiry — selection is disabled until it's available. Try another expiry tab or reopen the chain.
            </div>
          )}
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
          ) : chainStatus === "loading" ? (
            <div className="oc-empty">
              <div className="oc-empty-msg">Loading live option symbols…</div>
              <div className="oc-empty-sub">Fetching real strike data from Fyers for this expiry.</div>
            </div>
          ) : (
            strikes.map((strike, idx) => {
              const callSym = realSymbolFor(strike, "CE");
              const putSym = realSymbolFor(strike, "PE");
              const isAtm = strike === atm;

              const nextStrike = strikes[idx + 1];
              const showSpotLine = spot && nextStrike && spot > strike && spot < nextStrike;

              const strikeFmt = Number.isInteger(strike)
                ? strike.toLocaleString("en-IN")
                : strike.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

              return (
                <React.Fragment key={strike}>
                  <div className={`oc-row${isAtm ? " oc-row-atm" : ""}`}>
                    <button
                      className="oc-cell oc-call"
                      onClick={() => pick(strike, "CE")}
                      disabled={!callSym}
                      title={callSym || "Not available from Fyers for this expiry"}
                    >
                      Call {strikeFmt}
                    </button>
                    <span className="oc-strike">{strikeFmt}</span>
                    <button
                      className="oc-cell oc-put"
                      onClick={() => pick(strike, "PE")}
                      disabled={!putSym}
                      title={putSym || "Not available from Fyers for this expiry"}
                    >
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