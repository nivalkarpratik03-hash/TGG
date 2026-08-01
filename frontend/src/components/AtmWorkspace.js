// AtmWorkspace.js
// ─────────────────────────────────────────────────────────────────────────────
// 3-pane ATM Workspace: CE | Underlying | PE, opened by Ctrl+Q from
// ChartsPage (always focuses CE first — click a column to focus it
// directly). Each column is fully independent (own
// live data feed via useSocket, own mini chart) and has its own × close
// button. Click a CE/PE column to focus it, then Ctrl+Shift+↑ / Ctrl+Shift+↓
// steps that column one real strike up/down — using the actual strike ladder
// Fyers returned, never a hand-built symbol.
//
// ROOT-CAUSE CONTEXT: the old Ctrl+Q/Ctrl+D shortcuts mutated the active
// panel's OWN symbol and picked the nearest strike by comparing the fetched
// chain against candles[last].close — i.e. whatever price happened to be on
// screen. That's the underlying's spot when viewing the underlying, but an
// option's own premium when already viewing a CE/PE chart, so chaining
// Ctrl+Q → Ctrl+D landed on a essentially random strike. This workspace never
// treats an option's own price as a spot proxy: it fetches the underlying's
// real live LTP itself (the same response Fyers' getOptionChain returns
// alongside the CE/PE strikes) and keeps CE/Underlying/PE as three
// permanently separate columns instead of overwriting one chart in place.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from "react";
import CandleChart from "./CandleChart";
import { useSocket } from "../hooks/useSocket";
import { BACKEND } from "../config";
import "../styles/AtmWorkspace.css";

// ─── AtmColumn — one independent mini chart with its own live data feed ──────
const AtmColumn = React.memo(function AtmColumn({
  colKey, kind, label, symbol, strike, focused, onFocus, onClose, resolution, onLastClose,
}) {
  const { chartData, loading, refresh } = useSocket();
  const lastRequestedRef = useRef(null);

  useEffect(() => {
    if (!symbol || lastRequestedRef.current === symbol) return;
    lastRequestedRef.current = symbol;
    refresh(symbol, resolution);
    // Re-fetch whenever THIS column's own symbol changes (initial mount or a
    // Ctrl+Shift+↑/↓ strike switch). resolution is fixed for the workspace's
    // lifetime (set once when it opens), so it's intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const candles = chartData?.candles || [];
  const lastClose = candles.length ? candles[candles.length - 1].close : null;

  // Reports this column's own live price up to the parent — only wired for
  // the "mid" (underlying) column below, so this is always the underlying's
  // real price, never an option's premium (see the root-cause note at the
  // top of this file on why that distinction matters).
  useEffect(() => {
    if (onLastClose && lastClose != null) onLastClose(lastClose);
  }, [lastClose, onLastClose]);

  return (
    <div
      className={`atm-col atm-col-${kind}${focused ? " atm-col-focused" : ""}`}
      onMouseDown={onFocus}
    >
      <div className="atm-col-header">
        <div className="atm-col-title">
          <span className={`atm-col-badge atm-col-badge-${kind}`}>
            {strike != null ? `${strike} ${label}` : label}
          </span>
          <span className="atm-col-symbol" title={symbol}>{symbol}</span>
        </div>
        <div className="atm-col-header-right">
          {lastClose != null && <span className="atm-col-ltp">{lastClose}</span>}
          <button
            className="atm-col-close"
            title={`Close ${label} chart`}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            ×
          </button>
        </div>
      </div>
      <div className="atm-col-body">
        {loading && !candles.length ? (
          <div className="atm-col-loading">Loading {symbol}…</div>
        ) : (
          <CandleChart
            candles={candles}
            emaHighs={chartData?.emaHighs || []}
            emaLows={chartData?.emaLows || []}
            activeResolution={chartData?.resolution ?? resolution}
            symbol={symbol}
            panelKey={`atm_${colKey}`}
            isActivePanel={focused}
          />
        )}
      </div>
    </div>
  );
});

// ─── AtmWorkspace ──────────────────────────────────────────────────────────
export default function AtmWorkspace({ baseSymbol, resolution, focus, onClose }) {
  const [spot, setSpot] = useState(null);
  const [ceStrikes, setCeStrikes] = useState([]); // [{strike_price, symbol}] ascending
  const [peStrikes, setPeStrikes] = useState([]);
  const [ceSymbol, setCeSymbol] = useState(null);
  const [peSymbol, setPeSymbol] = useState(null);
  const [open, setOpen] = useState({ ce: true, mid: true, pe: true });
  const [focused, setFocused] = useState(focus === "pe" ? "pe" : "ce");
  const [loadErr, setLoadErr] = useState(null);

  // `focus` is set once by ChartsPage when the workspace first opens
  // (always "ce"). Click the PE or Underlying column directly to focus it
  // instead — there's no longer a separate shortcut for that.
  useEffect(() => { if (focus) setFocused(focus); }, [focus]);

  // ── Initial-selection bookkeeping ──────────────────────────────────────
  // hasSelected: has ANY initial CE/PE strike been picked at all yet
  //   (real-spot-based OR the temporary middle-of-ladder fallback)?
  // selectedWithRealSpot: was that pick made using a REAL underlying price?
  //   If not (the ladder-middle fallback fired because strikes arrived
  //   before spot did), we're allowed exactly one upgrade to the real
  //   nearest-to-spot strike the moment real spot shows up.
  // userMoved: true the instant the person manually steps a strike via
  //   Ctrl+Shift+↑/↓ — once that happens we NEVER auto-reselect again,
  //   real spot or not, so a manual choice is never silently overridden.
  const hasSelected = useRef(false);
  const selectedWithRealSpot = useRef(false);
  const userMoved = useRef(false);
  // Mirrors `spot` state synchronously (state updates are async/batched, so
  // an effect's closure can't reliably read the latest value the instant
  // it's set — this ref always has the true current value the moment it's
  // needed, both for resets and for onMidLastClose).
  const spotRef = useRef(null);

  const trySelectInitial = useCallback((liveSpot, ceList, peList) => {
    if (userMoved.current) return;
    if (hasSelected.current && selectedWithRealSpot.current) return; // already correct, nothing to improve
    if (!ceList.length && !peList.length) return; // nothing to select from yet

    const nearest = (list) => (liveSpot != null
      ? list.reduce((best, s) =>
        Math.abs(s.strike_price - liveSpot) < Math.abs(best.strike_price - liveSpot) ? s : best)
      : list[Math.floor(list.length / 2)]);

    if (ceList.length) setCeSymbol(nearest(ceList).symbol);
    if (peList.length) setPeSymbol(nearest(peList).symbol);

    hasSelected.current = true;
    selectedWithRealSpot.current = liveSpot != null;
  }, []);

  // Fetch the option chain ONCE per baseSymbol — for the real strike
  // ladder only. Does NOT source spot price from this response.
  //
  // ROOT-CAUSE NOTE (2026-08-01): this used to also read the underlying's
  // own row out of `strikes` (Fyers mixes it in alongside real CE/PE rows,
  // with option_type neither "CE" nor "PE") to get a live spot LTP.
  // fyers/client.js's fetchOptionChain() now correctly filters that row
  // out before this array is ever built server-side (it was breaking the
  // derivatives storage pipeline — a real symbol never parses as a dated
  // option contract). That fix means this response can no longer supply a
  // spot price at all. Spot now comes from the "mid" column's own live
  // feed below instead (see onMidLastClose) — which is guaranteed to
  // always be the underlying itself, never an option's premium, so the
  // original safety property this file's header comment describes still
  // holds; only the SOURCE of the live number changed.
  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    // Full reset for this baseSymbol — guards against stale state from a
    // previous underlying carrying over if this component instance is ever
    // reused across a symbol change rather than fully remounted.
    setSpot(null);
    spotRef.current = null;
    setCeStrikes([]);
    setPeStrikes([]);
    setCeSymbol(null);
    setPeSymbol(null);
    hasSelected.current = false;
    selectedWithRealSpot.current = false;
    userMoved.current = false;

    const params = new URLSearchParams({ symbol: baseSymbol, strikeCount: "20" });
    fetch(`${BACKEND}/api/options/chain?${params.toString()}`)
      .then(async (res) => {
        if (res.ok) return res.json();
        // 401 specifically means the Fyers token expired — that's a known,
        // actionable case, so give a plain-English message instead of the
        // raw "HTTP 401" the generic branch below would otherwise show.
        if (res.status === 401) throw new Error("Session expired — please re-authenticate with Fyers");
        // Other failures: try to surface the backend's own error message
        // (chartRouter.js always responds with JSON { error }), falling
        // back to a plain status-code message only if that body can't be
        // parsed at all.
        let message = `Request failed (HTTP ${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch { /* body wasn't JSON — keep the fallback message */ }
        throw new Error(message);
      })
      .then((data) => {
        if (cancelled) return;
        const strikes = data.strikes || [];
        const ce = strikes
          .filter((s) => s.option_type === "CE")
          .sort((a, b) => a.strike_price - b.strike_price);
        const pe = strikes
          .filter((s) => s.option_type === "PE")
          .sort((a, b) => a.strike_price - b.strike_price);

        setCeStrikes(ce);
        setPeStrikes(pe);
        if (!ce.length && !pe.length) setLoadErr(`Fyers returned no strikes for ${baseSymbol}.`);

        // Reads spotRef (not the closed-over `spot` state) — correctly
        // picks up a real spot if the mid column's feed already reported
        // one before this fetch resolved, without ever seeing a stale
        // previous-symbol value (spotRef was reset synchronously above).
        trySelectInitial(spotRef.current, ce, pe);
      })
      .catch((err) => { if (!cancelled) setLoadErr(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSymbol]);

  // Called by the "mid" (underlying) AtmColumn every time its own live
  // price updates. This is the real spot source now (see note above).
  const onMidLastClose = useCallback((price) => {
    spotRef.current = price;
    setSpot(price);
    trySelectInitial(price, ceStrikes, peStrikes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceStrikes, peStrikes, trySelectInitial]);

  // ── Ctrl+Shift+↑ / Ctrl+Shift+↓ — move the focused CE/PE column one real
  // strike up/down using the ladder fetched above. No-ops at the ends of the
  // ladder and while the underlying column (or nothing) is focused.
  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (focused !== "ce" && focused !== "pe") return;
      const list = focused === "ce" ? ceStrikes : peStrikes;
      const curSymbol = focused === "ce" ? ceSymbol : peSymbol;
      const idx = list.findIndex((s) => s.symbol === curSymbol);
      if (idx === -1) return;
      e.preventDefault();
      const nextIdx = e.key === "ArrowUp" ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= list.length) return; // already at the end of the ladder
      userMoved.current = true; // manual choice — never auto-reselect after this
      if (focused === "ce") setCeSymbol(list[nextIdx].symbol);
      else setPeSymbol(list[nextIdx].symbol);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, ceStrikes, peStrikes, ceSymbol, peSymbol]);

  const closeCol = useCallback((col) => {
    setOpen((prev) => {
      const next = { ...prev, [col]: false };
      if (!next.ce && !next.mid && !next.pe) {
        // Last column closed — fully exit the workspace back to normal panels.
        setTimeout(onClose, 0);
      }
      return next;
    });
    setFocused((f) => (f === col ? null : f));
  }, [onClose]);

  const ceStrikeVal = ceStrikes.find((s) => s.symbol === ceSymbol)?.strike_price;
  const peStrikeVal = peStrikes.find((s) => s.symbol === peSymbol)?.strike_price;
  const openCount = (open.ce ? 1 : 0) + (open.mid ? 1 : 0) + (open.pe ? 1 : 0);

  return (
    <div className="atm-workspace">
      <div className="atm-workspace-toolbar">
        <span className="atm-workspace-title">ATM Workspace — {baseSymbol}</span>
        {spot != null && <span className="atm-workspace-spot">Spot: {spot}</span>}
        <span className="atm-workspace-hint">
          Click a chart to focus it · Ctrl+Shift+↑/↓ changes its strike · Esc closes
        </span>
        <button className="atm-workspace-closeall" onClick={onClose}>Close workspace</button>
      </div>
      <div className={`atm-workspace-grid atm-workspace-grid-${openCount || 1}`}>
        {open.ce && (
          ceSymbol ? (
            <AtmColumn
              colKey="ce" kind="ce" label="CE" symbol={ceSymbol} strike={ceStrikeVal}
              focused={focused === "ce"} onFocus={() => setFocused("ce")}
              onClose={() => closeCol("ce")} resolution={resolution}
            />
          ) : (
            <div className="atm-col atm-col-empty">{loadErr ? `Error: ${loadErr}` : "Loading CE strikes…"}</div>
          )
        )}
        {open.mid && (
          <AtmColumn
            colKey="mid" kind="mid" label="Underlying" symbol={baseSymbol} strike={null}
            focused={focused === "mid"} onFocus={() => setFocused("mid")}
            onClose={() => closeCol("mid")} resolution={resolution}
            onLastClose={onMidLastClose}
          />
        )}
        {open.pe && (
          peSymbol ? (
            <AtmColumn
              colKey="pe" kind="pe" label="PE" symbol={peSymbol} strike={peStrikeVal}
              focused={focused === "pe"} onFocus={() => setFocused("pe")}
              onClose={() => closeCol("pe")} resolution={resolution}
            />
          ) : (
            <div className="atm-col atm-col-empty">{loadErr ? `Error: ${loadErr}` : "Loading PE strikes…"}</div>
          )
        )}
      </div>
    </div>
  );
}