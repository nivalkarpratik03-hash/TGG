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
  colKey, kind, label, symbol, strike, focused, onFocus, onClose, resolution,
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

  // Fetch the option chain ONCE per baseSymbol — this single response gives
  // us the real live spot price (the underlying rides along in the same
  // Fyers getOptionChain payload as its own row, option_type neither CE nor
  // PE) plus the full real strike ladder for both kinds, so strike-switching
  // never has to guess or hand-build a symbol.
  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
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
        const underlyingRow = strikes.find(
          (s) => s.option_type !== "CE" && s.option_type !== "PE" && s.ltp
        );
        const spotPrice = underlyingRow?.ltp || null;

        setCeStrikes(ce);
        setPeStrikes(pe);
        setSpot(spotPrice);

        const nearest = (list) => (spotPrice != null
          ? list.reduce((best, s) =>
            Math.abs(s.strike_price - spotPrice) < Math.abs(best.strike_price - spotPrice) ? s : best)
          : list[Math.floor(list.length / 2)]);

        if (ce.length) setCeSymbol(nearest(ce).symbol);
        if (pe.length) setPeSymbol(nearest(pe).symbol);
        if (!ce.length && !pe.length) setLoadErr(`Fyers returned no strikes for ${baseSymbol}.`);
      })
      .catch((err) => { if (!cancelled) setLoadErr(err.message); });
    return () => { cancelled = true; };
  }, [baseSymbol]);

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