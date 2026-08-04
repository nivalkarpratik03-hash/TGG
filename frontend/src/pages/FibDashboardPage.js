import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { BACKEND } from "../config";
import { useTheme } from "../App";
import { fmt } from "../utils/format";
import SymbolSearch from "../components/SymbolSearch";
import "../styles/FibDashboardPage.css";

// ── Symbols — live from the root symbols/ master via /api/symbols ──────────
// REPOINTED 2026-08-03 — was `import SYMBOLS from "../symbols.json"` (a
// bundled, build-time-frozen file). CONSOLIDATED 2026-08-03 — the fetch+cache
// logic lived in utils/symbolsApi.js (Chunk 3), shared with
// components/SymbolSearch.js and pages/ReportsPage.js. CHUNK 4 (2026-08-03):
// this page no longer has its own symbol-fetching code at all — it now uses
// the real components/SymbolSearch.js modal directly (see the search-trigger
// button in the topbar below), so the local loadSymbols() usage is gone too.

// ── Timeframe definitions ────────────────────────────────────────────────────

const INTRADAY_TFS = [
  { label: "1Hour", value: 60 },
  { label: "15Min", value: 15 },
  { label: "5Min", value: 5 },
  { label: "3Min", value: 3 },
];

const ENTRY_TFS = [
  { label: "5Min", value: 5 },
  { label: "3Min", value: 3 },
  { label: "1Min", value: 1 },
];

// Full Fib levels per document: -1.618, -1, -0.236 to 0.236 (trap), 0, 0.382, 0.500, 0.618, 0.786, 1
const FIB_LEVELS = [
  { ratio: -1.618, badge: "Ext Target" },
  { ratio: -1.000, badge: "Target" },
  { ratio: -0.618, badge: "Ext Golden" },
  { ratio: -0.236, badge: "Trap Top" },  // upper edge of trap zone
  { ratio: 0.000, badge: null },         // High (reference)
  { ratio: 0.236, badge: "Trap Bot" },  // lower edge of trap zone
  { ratio: 0.382, badge: "Support" },
  { ratio: 0.500, badge: "Mid" },
  { ratio: 0.618, badge: "Golden" },
  { ratio: 0.786, badge: "Caution" },
  { ratio: 1.000, badge: null },         // Low (reference)
];

// Trap zone is between -0.236 and +0.236
const TRAP_ZONE_TOP = -0.236;
const TRAP_ZONE_BOT = 0.236;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Compute fib levels per document:
// Bullish Mother Wave → Fib Bottom to Top (1=Low, 0=High)
//   ratio 0 = High (start/from of bull wave), ratio 1 = Low (end/to NOT right — see below)
//   Actually for a bull wave: fromPrice=Low, toPrice=High
//   ratio 0 = 0% retracement = toPrice (High), ratio 1 = 100% retracement = fromPrice (Low)
//   price = toPrice - ratio * (toPrice - fromPrice)
// Bearish Mother Wave → Fib Top to Bottom (1=High, 0=Low)
//   ratio 0 = toPrice (Low), ratio 1 = fromPrice (High) — mirror of above
// In both cases: price = toPrice + ratio * (fromPrice - toPrice)
//   which = toPrice - ratio * delta where delta = toPrice - fromPrice
// This aligns with the document: 0=High end of wave, 1=Low end, 0.382 first pullback etc.
function computeFibLevels(segment) {
  if (!segment) return [];
  const { fromPrice, toPrice } = segment;
  // For fib: "0" is the wave tip (toPrice), "1" is the wave origin (fromPrice)
  // Retracement price = toPrice + ratio * (fromPrice - toPrice)
  return FIB_LEVELS.map((f) => ({
    ratio: f.ratio,
    badge: f.badge,
    price: toPrice + f.ratio * (fromPrice - toPrice),
  }));
}

// Derive mother wave condition per document 4 cases
function getMotherWaveCondition(segment, currentPrice) {
  if (!segment || currentPrice == null) return null;
  const high = Math.max(segment.fromPrice, segment.toPrice);
  const low = Math.min(segment.fromPrice, segment.toPrice);
  const isBullWave = segment.toSide === "high"; // wave ended at a high = bullish wave

  const priceInside = currentPrice >= low && currentPrice <= high;
  const priceAbove = currentPrice > high;
  const priceBelow = currentPrice < low;

  if (priceInside && isBullWave) return "inside_bull";   // Case 1: Inside Bullish
  if (priceInside && !isBullWave) return "inside_bear";   // Case 2: Inside Bearish
  if (priceAbove) return "outside_bull";  // Case 3: Outside Bullish
  if (priceBelow) return "outside_bear";  // Case 4: Outside Bearish
  return null;
}

// Get trap zone status and fib alert per document
function getTrapZoneStatus(fibLevels, currentPrice) {
  if (!fibLevels.length || currentPrice == null) return null;
  const lvl = (ratio) => fibLevels.find((f) => Math.abs(f.ratio - ratio) < 0.001)?.price;

  const trapTop = lvl(-0.236); // upper trap edge
  const trapBot = lvl(0.236);  // lower trap edge
  const fib382 = lvl(0.382);
  const fib500 = lvl(0.500);
  const fib618 = lvl(0.618);

  if (trapTop == null || trapBot == null) return null;

  const trapHigh = Math.max(trapTop, trapBot);
  const trapLow = Math.min(trapTop, trapBot);

  const inTrap = currentPrice >= trapLow && currentPrice <= trapHigh;

  // Which side of trap zone is price touching?
  let trapBias = null;
  if (inTrap) {
    const midTrap = (trapHigh + trapLow) / 2;
    trapBias = currentPrice >= midTrap ? "short" : "buy"; // upper = short, lower = buy
  }

  // Alert: price at key fib level for the first time
  const keyLevels = [fib382, fib500, fib618].filter(Boolean);
  const tolerance = currentPrice * 0.002; // 0.2% tolerance
  const atKeyLevel = keyLevels.some((lvlPrice) => Math.abs(currentPrice - lvlPrice) <= tolerance);

  // Between swing — price between two key levels
  let betweenLevels = null;
  const orderedKeyLevels = [fib382, fib500, fib618].filter(Boolean).sort((a, b) => a - b);
  for (let i = 0; i < orderedKeyLevels.length - 1; i++) {
    if (currentPrice > orderedKeyLevels[i] && currentPrice < orderedKeyLevels[i + 1]) {
      betweenLevels = { lower: orderedKeyLevels[i], upper: orderedKeyLevels[i + 1] };
      break;
    }
  }

  return { inTrap, trapBias, trapHigh, trapLow, atKeyLevel, betweenLevels };
}

function getBias(segment) {
  if (!segment) return "neutral";
  return segment.toSide === "high" ? "bull" : "bear";
}

function deriveEntries(motherwave, fibLevels, entryTFLabel) {
  if (!motherwave || !fibLevels.length) return [];
  const bias = getBias(motherwave);
  const isBear = bias === "bear";

  const lvl = (ratio) => fibLevels.find((f) => Math.abs(f.ratio - ratio) < 0.001)?.price;
  const goldenPrice = lvl(0.618);
  const midPrice = lvl(0.500);
  const supPrice = lvl(0.382);
  const startPrice = lvl(0.000);
  const endPrice = lvl(1.000);

  if (goldenPrice == null) return [];

  const entries = [];

  if (isBear) {
    if (goldenPrice != null && supPrice != null && startPrice != null) {
      const delta = Math.abs(goldenPrice - midPrice);
      const rr = delta > 0 ? (Math.abs(goldenPrice - supPrice) / delta).toFixed(1) : "—";
      entries.push({
        dir: "sell",
        label: `▼ SELL · ${entryTFLabel}`,
        entryPrice: goldenPrice,
        stopLoss: midPrice,
        target1: supPrice,
        target2: startPrice,
        rrText: rr,
        hint: `0.618 rejection · ${entryTFLabel} Fib confluence`,
      });
    }
    if (midPrice != null && supPrice != null) {
      const delta = Math.abs(midPrice - supPrice);
      const rr = delta > 0 ? (Math.abs(midPrice - supPrice) / delta).toFixed(1) : "—";
      entries.push({
        dir: "sell",
        label: `▼ SELL · ${entryTFLabel} (Mid)`,
        entryPrice: midPrice,
        stopLoss: goldenPrice,
        target1: supPrice,
        target2: startPrice,
        rrText: rr,
        hint: `Mid (0.500) rejection · bearish continuation`,
      });
    }
    if (supPrice != null && midPrice != null) {
      entries.push({
        dir: "buy",
        label: `▲ BUY · ${entryTFLabel} (CT)`,
        entryPrice: supPrice,
        stopLoss: startPrice,
        target1: midPrice,
        target2: goldenPrice,
        rrText: "1:2",
        hint: `Support (0.382) bounce · counter-trend scalp`,
      });
    }
  } else {
    if (supPrice != null && startPrice != null && goldenPrice != null) {
      entries.push({
        dir: "buy",
        label: `▲ BUY · ${entryTFLabel}`,
        entryPrice: supPrice,
        stopLoss: startPrice,
        target1: midPrice,
        target2: goldenPrice,
        rrText: "1:2",
        hint: `0.382 support bounce · ${entryTFLabel} Fib confluence`,
      });
    }
    if (goldenPrice != null && midPrice != null && endPrice != null) {
      entries.push({
        dir: "sell",
        label: `▼ SELL · ${entryTFLabel} (CT)`,
        entryPrice: goldenPrice,
        stopLoss: endPrice,
        target1: midPrice,
        target2: supPrice,
        rrText: "1:1.5",
        hint: `Golden (0.618) rejection · counter-trend scalp`,
      });
    }
  }

  return entries;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function BiasPill({ bias }) {
  if (bias === "bear") return <span className="fdb-pill fdb-p-bear">▼ Down</span>;
  if (bias === "bull") return <span className="fdb-pill fdb-p-bull">▲ Up</span>;
  return <span className="fdb-pill fdb-p-neutral">— Neutral</span>;
}

function WaveCard({ segment, tfLabel, onClick, mwError }) {
  if (!segment) return (
    <div className="fdb-no-wave">
      {mwError ? "⚠ Mother wave unavailable — backend error" : "No mother wave detected"}
    </div>
  );
  const isBull = segment.toSide === "high";
  const delta = Math.abs(segment.toPrice - segment.fromPrice).toFixed(1);
  const waveNum = segment.waveNum != null ? segment.waveNum : null;
  return (
    <div
      className={`fdb-wave-card ${isBull ? "bull" : ""} ${onClick ? "fdb-wave-card-clickable" : ""}`}
      onClick={onClick}
      title={onClick ? "Click to open this wave on the chart" : undefined}
    >
      <div className="fdb-wave-card-header">
        <span className={`fdb-wave-dir ${isBull ? "fdb-bull-dir" : "fdb-bear-dir"}`}>
          {isBull ? "▲ Bull" : "▼ Bear"}
        </span>
        {waveNum != null && (
          <span className="fdb-wave-num">Wave {waveNum}</span>
        )}
        {onClick && <span className="fdb-wave-chart-hint">↗ Open chart</span>}
      </div>
      <div className="fdb-wave-range">
        {fmt(segment.fromPrice)} → {fmt(segment.toPrice)}
      </div>
      <div className="fdb-wave-pts">{tfLabel} &nbsp;·&nbsp; Δ {delta} pts</div>
    </div>
  );
}

function FibTable({ fibLevels, currentPrice }) {
  if (!fibLevels.length) return <div className="fdb-no-wave">No Fib data</div>;

  const lvlPrice = (ratio) => fibLevels.find((f) => Math.abs(f.ratio - ratio) < 0.001)?.price;
  const trapHigh = Math.max(lvlPrice(-0.236) ?? 0, lvlPrice(0.236) ?? 0);
  const trapLow = Math.min(lvlPrice(-0.236) ?? Infinity, lvlPrice(0.236) ?? Infinity);

  return (
    <table className="fdb-fib-tbl">
      <thead>
        <tr>
          <th>Level</th>
          <th></th>
          <th>Price</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {fibLevels.map((f) => {
          const isTrapZone = f.ratio === -0.236 || f.ratio === 0.236;
          const isInsideTrap = f.price >= trapLow && f.price <= trapHigh && !isTrapZone;
          const isCurrent = currentPrice != null && Math.abs(currentPrice - f.price) / currentPrice < 0.003;
          const isExtension = f.ratio < 0;
          return (
            <tr
              key={f.ratio}
              className={[
                isTrapZone ? "fdb-fib-trap" : "",
                isExtension && !isTrapZone ? "fdb-fib-ext" : "",
                isCurrent ? "fdb-fib-current" : "",
              ].filter(Boolean).join(" ")}
            >
              <td className="fdb-lvl-num">{f.ratio.toFixed(3)}</td>
              <td>
                {f.badge === "Support" && <span className="fdb-badge fdb-b-sup">Support</span>}
                {f.badge === "Mid" && <span className="fdb-badge fdb-b-mid">Mid</span>}
                {f.badge === "Golden" && <span className="fdb-badge fdb-b-gold">Golden</span>}
                {f.badge === "Caution" && <span className="fdb-badge fdb-b-caution">Caution</span>}
                {f.badge === "Ext Target" && <span className="fdb-badge fdb-b-ext">Ext Target</span>}
                {f.badge === "Target" && <span className="fdb-badge fdb-b-target">Target</span>}
                {f.badge === "Trap Top" && <span className="fdb-badge fdb-b-trap">Trap ↑</span>}
                {f.badge === "Trap Bot" && <span className="fdb-badge fdb-b-trap">Trap ↓</span>}
              </td>
              <td className={isCurrent ? "fdb-fib-price-now" : ""}>{fmt(f.price)}</td>
              <td>{isCurrent && <span style={{ color: "#ffcc44", fontSize: 9 }}>◄ NOW</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EntryBlock({ entry }) {
  const isSell = entry.dir === "sell";
  return (
    <div className="fdb-entry-block">
      <div className="fdb-entry-block-top">
        <span className={`fdb-entry-dir ${isSell ? "fdb-e-sell" : "fdb-e-buy"}`}>
          {entry.label}
        </span>
        <span className="fdb-rr-tag">R:R <span>{entry.rrText}</span></span>
      </div>
      <div className="fdb-e-row">
        <span className="fdb-lbl">Entry price</span>
        <span className={isSell ? "val-entry" : "val-entry-b"}>{fmt(entry.entryPrice)}</span>
      </div>
      <div className="fdb-e-row">
        <span className="fdb-lbl">Stop loss</span>
        <span className="val-sl">{fmt(entry.stopLoss)}</span>
      </div>
      <div className="fdb-e-row">
        <span className="fdb-lbl">Target 1</span>
        <span className="val-t1">{fmt(entry.target1)}</span>
      </div>
      <div className="fdb-e-row">
        <span className="fdb-lbl">Target 2</span>
        <span className="val-t2">{fmt(entry.target2)}</span>
      </div>
      <div className="fdb-e-hint">{entry.hint}</div>
    </div>
  );
}

// ── Data hook ────────────────────────────────────────────────────────────────

function useColData(symbol, tfValue) {
  const [state, setState] = useState({ status: "idle", segment: null, mwError: false });
  const abortRef = useRef(null);

  const fetchCol = useCallback(async (sym, res) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((s) => ({ ...s, status: "loading", mwError: false }));
    try {
      let data = null;
      // Backend handles live vs cached automatically based on symbol's market hours.
      // Always GET — no POST/refresh decision needed on frontend.
      try {
        const r = await fetch(
          `${BACKEND}/api/chart?symbol=${encodeURIComponent(sym)}&resolution=${res}`,
          { signal: ctrl.signal }
        );
        if (r.ok) data = await r.json();
      } catch (_) { /* network error — data stays null */ }

      if (ctrl.signal.aborted) return;

      if (data?.candles?.length) {
        // Fetch Mother Wave from backend — single source of truth in motherwave.js
        let mwResult = null;
        let mwError = false;
        try {
          const mwR = await fetch(
            `${BACKEND}/api/motherwave?symbol=${encodeURIComponent(sym)}&resolution=${res}`,
            { signal: ctrl.signal }
          );
          if (mwR.ok) {
            const mwData = await mwR.json();
            if (mwData && mwData.wave) mwResult = mwData;
          } else {
            mwError = true;
          }
        } catch (_) {
          mwError = true;
        }

        if (ctrl.signal.aborted) return;

        // Convert wave row → segment shape for FibDashboard card/chart code
        const wave = mwResult ? mwResult.wave : null;
        const segment = wave ? {
          fromPrice: wave.col1Price,
          toPrice: wave.col2Price,
          toSide: wave.dir === "bull" ? "high" : "low",
          waveNum: wave.waveNum,
          fromTime: wave.col1Time,
          toTime: wave.col2Time,
        } : null;

        const lastClose = data.candles[data.candles.length - 1].close;
        setState({
          status: "done",
          segment,
          reportMotherSegment: segment,
          candles: data.candles,
          emaHighsData: data.emaHighs || [],
          emaLowsData: data.emaLows || [],
          lastClose,
          mwError,
        });
      } else {
        setState({ status: "error", segment: null, mwError: false });
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      setState({ status: "error", segment: null, mwError: false });
    }
  }, []);

  useEffect(() => {
    if (symbol && tfValue != null) fetchCol(symbol, tfValue);
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [symbol, tfValue, fetchCol]);

  return { ...state, refetch: () => fetchCol(symbol, tfValue) };
}


// ── Column 1 — High Timeframe ────────────────────────────────────────────────

// Button that opens the chart page with the mother wave fib pre-drawn
function DrawFibOnChartBtn({ symbol, resolution, segment }) {
  if (!segment) return null;

  function handleClick() {
    // DrawingOverlay formula: price = p1 + (p2 - p1) * ratio
    //   so ratio=0 → p1, ratio=1 → p2
    // Dashboard computeFibLevels: price = toPrice + ratio * (fromPrice - toPrice)
    //   so ratio=0 → toPrice (wave TIP), ratio=1 → fromPrice (wave ORIGIN)
    // To match the dashboard:
    //   Bull wave (toSide="high"): toPrice=High (tip), fromPrice=Low (origin)
    //     → p1=toPrice(High)=0, p2=fromPrice(Low)=1  → 0 at top, 1 at bottom ✓
    //   Bear wave (toSide="low"):  toPrice=Low  (tip), fromPrice=High (origin)
    //     → p1=toPrice(Low)=0,  p2=fromPrice(High)=1 → 0 at bottom, 1 at top ✓
    const fibDrawing = encodeURIComponent(JSON.stringify({
      p1Price: segment.toPrice,        // wave TIP  → ratio 0
      p1Time: Math.round(segment.toTime / 1000),   // wave TIP time (unix sec)
      p2Price: segment.fromPrice,      // wave ORIGIN → ratio 1
      p2Time: Math.round(segment.fromTime / 1000), // wave ORIGIN time (unix sec)
    }));
    const params = new URLSearchParams({
      symbol,
      resolution: String(resolution),
      waveFrom: String(segment.fromTime),
      waveTo: String(segment.toTime),
      fibDrawing,
    });
    window.open(`/charts?${params.toString()}`, "_blank");
  }

  return (
    <button className="fdb-draw-chart-btn fdb-draw-fib-btn" onClick={handleClick} title="Open chart with Fib retracement drawn on mother wave">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1" y="1" width="14" height="14" rx="2" />
        <line x1="1" y1="4" x2="15" y2="4" strokeDasharray="2 1.5" />
        <line x1="1" y1="7" x2="15" y2="7" strokeDasharray="2 1.5" />
        <line x1="1" y1="10" x2="15" y2="10" strokeDasharray="2 1.5" />
        <line x1="1" y1="13" x2="15" y2="13" strokeDasharray="2 1.5" />
      </svg>
      Draw Fib
    </button>
  );
}

function HtfColumn({ symbol }) {
  const [activeTF, setActiveTF] = useState(1440);
  const tfOptions = [
    { label: "1Week", value: 10080 },
    { label: "1Day", value: 1440 },
    { label: "1Hour", value: 60 },
    { label: "15Min", value: 15 },
  ];

  const { status, segment, reportMotherSegment, lastClose, mwError } = useColData(symbol, activeTF);
  // Use report-style mother wave (detectMotherWave algorithm) for display
  const motherSegment = reportMotherSegment || segment;
  const fibLevels = computeFibLevels(motherSegment);
  const bias = getBias(motherSegment);
  const waveLabel = activeTF >= 10080 ? "Weekly wave" : activeTF >= 1440 ? "Daily wave" : activeTF >= 60 ? "1H wave" : "15Min wave";

  function handleWaveClick() {
    if (!motherSegment) return;
    const params = new URLSearchParams({
      symbol,
      resolution: String(activeTF),
      waveFrom: String(motherSegment.fromTime),
      waveTo: String(motherSegment.toTime),
    });
    window.open(`/charts?${params.toString()}`, "_blank");
  }

  return (
    <div className="fdb-col">
      <div className="fdb-col-head">
        High time frame<span>Trend · Mother wave · Fib</span>
      </div>

      <div className="fdb-tf-row fdb-tf-row-htf">
        {tfOptions.map((tf) => (
          <button
            key={tf.value}
            className={`fdb-tf ${activeTF === tf.value ? "on" : ""}`}
            onClick={() => setActiveTF(tf.value)}
          >
            {tf.label}
          </button>
        ))}
        <DrawFibOnChartBtn symbol={symbol} resolution={activeTF} segment={motherSegment} />
      </div>

      <div className="fdb-bias-line">
        <span>High timeframe bias</span>
        <BiasPill bias={status === "done" ? bias : "neutral"} />
      </div>

      <div className="fdb-sep" />

      <div className="fdb-col-body">
        <div className="fdb-sec-title">▸ Mother wave</div>
        {status === "loading" ? (
          <div className="fdb-state"><div className="fdb-spinner" /></div>
        ) : (
          <WaveCard segment={motherSegment} tfLabel={waveLabel} onClick={motherSegment ? handleWaveClick : undefined} mwError={mwError} />
        )}

        <div className="fdb-sep" />

        <div className="fdb-sec-title">▸ Fib retracement levels</div>
        {status === "loading" ? (
          <div className="fdb-state"><div className="fdb-spinner" /></div>
        ) : (
          <FibTable fibLevels={fibLevels} currentPrice={lastClose} />
        )}
      </div>
    </div>
  );
}


// ── Support / Resistance computation ────────────────────────────────────────
// Per document: Previous Swing Highs → Resistance, Previous Swing Lows → Support
// ── EMA 9 Support & Resistance Strategy ──────────────────────────────────────
// Support : Red candle closes BELOW EMA9-Low  → within next 3 candles a Green
//           candle fully engulfs it (open ≤ prev close AND close > prev open).
//           Confirmed Support = low of the breach (red) candle.
// Resistance: Green candle closes ABOVE EMA9-High → within next 3 candles a Red
//           candle fully engulfs it (open ≥ prev close AND close < prev open).
//           Confirmed Resistance = high of the breach (green) candle.

function computeSRLevels(candles, emaHighs, emaLows) {
  if (!candles?.length || candles.length < 4) return null;

  const lastClose = candles[candles.length - 1].close;
  const supports = [];    // { price, breachIdx, confirmIdx, time }
  const resistances = []; // { price, breachIdx, confirmIdx, time }

  for (let i = 0; i < candles.length - 1; i++) {
    const bar = candles[i];
    const emaH = emaHighs[i];
    const emaL = emaLows[i];
    const isRed = bar.close < bar.open;
    const isGreen = bar.close > bar.open;

    // ── Support: red candle closes below EMA9-Low ──────────────────────────
    if (isRed && bar.close < emaL) {
      // Look ahead up to 3 candles for bullish engulfment
      const lookAhead = Math.min(3, candles.length - 1 - i);
      for (let j = 1; j <= lookAhead; j++) {
        const conf = candles[i + j];
        const confIsGreen = conf.close > conf.open;
        // Bullish engulfment: green candle open ≤ breach close AND close > breach open
        if (confIsGreen && conf.open <= bar.close && conf.close > bar.open) {
          supports.push({
            price: bar.low,
            breachIdx: i,
            confirmIdx: i + j,
            time: bar.time,
            touches: 1,
          });
          break; // first valid confirmation only
        }
      }
    }

    // ── Resistance: green candle closes above EMA9-High ───────────────────
    if (isGreen && bar.close > emaH) {
      const lookAhead = Math.min(3, candles.length - 1 - i);
      for (let j = 1; j <= lookAhead; j++) {
        const conf = candles[i + j];
        const confIsRed = conf.close < conf.open;
        // Bearish engulfment: red candle open ≥ breach close AND close < breach open
        if (confIsRed && conf.open >= bar.close && conf.close < bar.open) {
          resistances.push({
            price: bar.high,
            breachIdx: i,
            confirmIdx: i + j,
            time: bar.time,
            touches: 1,
          });
          break;
        }
      }
    }
  }

  // Deduplicate levels within 0.3% of each other — keep most recent
  const tolerance = lastClose * 0.003;
  function dedup(levels) {
    const seen = [];
    // Iterate newest-first so we keep the most recent
    for (const lvl of [...levels].reverse()) {
      const close = seen.find((s) => Math.abs(s.price - lvl.price) <= tolerance);
      if (!close) seen.push({ ...lvl });
    }
    return seen.reverse(); // restore chronological order
  }

  const cleanSup = dedup(supports);
  const cleanRes = dedup(resistances);

  // Split into above / below current price, nearest first
  const supLevels = cleanSup
    .filter((l) => l.price < lastClose)
    .sort((a, b) => b.price - a.price); // nearest below first

  const resLevels = cleanRes
    .filter((l) => l.price > lastClose)
    .sort((a, b) => a.price - b.price); // nearest above first

  // Change-of-polarity: support levels now above price = resistance; vice versa
  const copRes = cleanSup
    .filter((l) => l.price > lastClose)
    .sort((a, b) => a.price - b.price)[0] || null;

  const copSup = cleanRes
    .filter((l) => l.price < lastClose)
    .sort((a, b) => b.price - a.price)[0] || null;

  // Mark "Key" = level touched (price revisited) more than once in candle data
  // Count how many candles have a low within tolerance of each support
  function countTouches(price, side) {
    let count = 0;
    for (const c of candles) {
      if (side === "sup" && Math.abs(c.low - price) <= tolerance) count++;
      if (side === "res" && Math.abs(c.high - price) <= tolerance) count++;
    }
    return Math.max(1, count);
  }

  const supClusters = supLevels.map((l) => ({
    avg: l.price,
    count: countTouches(l.price, "sup"),
    time: l.time,
  }));

  const resClusters = resLevels.map((l) => ({
    avg: l.price,
    count: countTouches(l.price, "res"),
    time: l.time,
  }));

  function strongest(clusters) {
    if (!clusters.length) return null;
    return clusters.reduce((best, c) => c.count >= best.count ? c : best, clusters[0]);
  }

  return {
    r3: resClusters[2] || null,
    r2: resClusters[1] || null,
    r1: resClusters[0] || null,
    current: lastClose,
    s1: supClusters[0] || null,
    s2: supClusters[1] || null,
    s3: supClusters[2] || null,
    strongestRes: strongest(resClusters),
    strongestSup: strongest(supClusters),
    copRes: copRes ? { avg: copRes.price, count: countTouches(copRes.price, "res"), time: copRes.time } : null,
    copSup: copSup ? { avg: copSup.price, count: countTouches(copSup.price, "sup"), time: copSup.time } : null,
    allResClusters: resClusters,
    allSupClusters: supClusters,
  };
}

// Build SR lines array for chart URL — converts S&R panel data to chart price lines
function buildSRLinesForChart(sr) {
  if (!sr) return [];
  const lines = [];
  const addLine = (cluster, color, label) => {
    if (cluster) lines.push({ price: Math.round(cluster.avg * 100) / 100, color, label });
  };
  addLine(sr.r3, "#ff4444", "R3");
  addLine(sr.r2, "#ff6666", "R2");
  addLine(sr.r1, "#ff9999", "R1");
  addLine(sr.s1, "#44cc44", "S1");
  addLine(sr.s2, "#66aa66", "S2");
  addLine(sr.s3, "#448844", "S3");
  if (sr.copRes) lines.push({ price: Math.round(sr.copRes.avg * 100) / 100, color: "#ff8844", label: "CoP Resistance" });
  if (sr.copSup) lines.push({ price: Math.round(sr.copSup.avg * 100) / 100, color: "#44aaff", label: "CoP Support" });
  return lines;
}

function DrawOnChartBtn({ symbol, resolution, sr }) {
  if (!sr) return null;
  const lines = buildSRLinesForChart(sr);
  if (!lines.length) return null;

  function handleClick() {
    const params = new URLSearchParams({
      symbol,
      resolution: String(resolution),
      srLines: encodeURIComponent(JSON.stringify(lines)),
    });
    window.open(`/charts?${params.toString()}`, "_blank");
  }

  return (
    <button className="fdb-draw-chart-btn" onClick={handleClick} title="Open chart with S&R lines drawn">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1" y="1" width="14" height="14" rx="2" />
        <line x1="1" y1="5.5" x2="15" y2="5.5" strokeDasharray="2,1.5" />
        <line x1="1" y1="10.5" x2="15" y2="10.5" strokeDasharray="2,1.5" />
        <polyline points="3,13 6,8 9,10 13,4" strokeWidth="1.6" />
      </svg>
      Draw on Chart
    </button>
  );
}

// ── SR Wave Lines Panel ───────────────────────────────────────────────────────
// Shows Previous Swing Highs as Resistance and Swing Lows as Support
// displayed as indicator lines (like on a chart), not bubbles

function SRPanel({ sr, status, motherSegment, fibLevels }) {
  if (status === "loading") return <div className="fdb-state"><div className="fdb-spinner" /></div>;
  if (!sr) return <div className="fdb-no-wave">No pivot data available</div>;

  const { r3, r2, r1, current, s1, s2, s3, strongestRes, strongestSup, copRes, copSup } = sr;

  // Mother wave condition
  const mwCondition = getMotherWaveCondition(motherSegment, current);
  const conditionLabels = {
    inside_bull: { label: "Inside Bullish", color: "#44cc44", desc: "Price inside MW · Bullish momentum (HH+HL)" },
    inside_bear: { label: "Inside Bearish", color: "#ff5555", desc: "Price inside MW · Bearish momentum (LL+LH)" },
    outside_bull: { label: "Outside Bullish", color: "#ffaa44", desc: "Price broke above MW high · Breakout pattern" },
    outside_bear: { label: "Outside Bearish", color: "#7777aa", desc: "Price broke below MW low · Breakdown pattern" },
  };
  const cond = conditionLabels[mwCondition];

  // Trap zone analysis
  const trapStatus = getTrapZoneStatus(fibLevels, current);

  // Determine distance bar width (visual)
  const allLevels = [r1, r2, s1, s2].filter(Boolean).map((c) => c.avg);
  const maxDist = allLevels.length
    ? Math.max(...allLevels.map((p) => Math.abs(p - current)))
    : 1;

  function WaveLine({ cluster, type, label, isCoP, isStrongest }) {
    if (!cluster) return null;
    const dist = Math.abs(cluster.avg - current);
    const barW = maxDist > 0 ? Math.min(100, (dist / maxDist) * 100) : 0;
    const pct = current > 0 ? ((cluster.avg - current) / current * 100).toFixed(2) : "0.00";
    const isRes = type === "res";
    return (
      <div className={`sr-wave-line sr-wave-${type}`}>
        <div className="sr-wave-header">
          <div className="sr-wave-label-group">
            <span className="sr-wave-tag">{label}</span>
            {isStrongest && <span className="sr-badge sr-strongest">🔥 Key</span>}
            {isCoP && <span className="sr-badge sr-cop">⟳ CoP</span>}
            <span className="sr-wave-type-hint">
              {isRes ? "Prev Swing High" : "Prev Swing Low"}
            </span>
          </div>
          <div className="sr-wave-price-group">
            <span className={`sr-wave-price sr-wave-price-${type}`}>{fmt(cluster.avg)}</span>
            <span className="sr-wave-pct" style={{ color: isRes ? "#ff8888" : "#55cc55" }}>
              {isRes ? "+" : ""}{pct}%
            </span>
          </div>
        </div>
        <div className="sr-wave-bar-track">
          <div
            className={`sr-wave-bar sr-wave-bar-${type}`}
            style={{ width: `${barW}%` }}
          />
          <span className="sr-wave-touches">{cluster.count}× touch{cluster.count !== 1 ? "es" : ""}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sr-panel">
      {/* Mother Wave Condition */}
      {cond && (
        <div className="sr-mw-condition" style={{ borderColor: cond.color }}>
          <div className="sr-mw-condition-header">
            <span className="sr-mw-label" style={{ color: cond.color }}>{cond.label}</span>
            <span className="sr-mw-tag">Market Condition</span>
          </div>
          <div className="sr-mw-desc">{cond.desc}</div>
        </div>
      )}

      {/* Trap Zone Alert */}
      {trapStatus?.inTrap && (
        <div className="sr-trap-alert">
          <div className="sr-trap-header">
            <span className="sr-trap-icon">⚠</span>
            <span className="sr-trap-label">TRAP ZONE (-0.236 to 0.236)</span>
          </div>
          <div className="sr-trap-body">
            <div className="sr-trap-row">
              <span>Price is inside No-Trade zone</span>
            </div>
            {trapStatus.trapBias === "short" && (
              <div className="sr-trap-bias sr-trap-short">
                ▼ Upper side (-0.236) → Bias: SHORT
              </div>
            )}
            {trapStatus.trapBias === "buy" && (
              <div className="sr-trap-bias sr-trap-buy">
                ▲ Lower side (0.236) → Bias: BUY
              </div>
            )}
            <div className="sr-trap-hint">Switch to 15Min S&amp;R for guidance</div>
          </div>
        </div>
      )}

      {/* Fib Alert */}
      {!trapStatus?.inTrap && trapStatus?.atKeyLevel && (
        <div className="sr-fib-alert sr-fib-alert-ready">
          <span className="sr-fib-alert-icon">🔔</span>
          <div>
            <div className="sr-fib-alert-title">GET READY FOR TRADE</div>
            <div className="sr-fib-alert-sub">Price touching key Fib level (0.382 / 0.500 / 0.618)</div>
          </div>
        </div>
      )}
      {!trapStatus?.inTrap && !trapStatus?.atKeyLevel && trapStatus?.betweenLevels && (
        <div className="sr-fib-alert sr-fib-alert-between">
          <span className="sr-fib-alert-icon">🔔</span>
          <div>
            <div className="sr-fib-alert-title">IN BETWEEN SWING</div>
            <div className="sr-fib-alert-sub">
              Between {fmt(trapStatus.betweenLevels.lower)} — {fmt(trapStatus.betweenLevels.upper)}
            </div>
          </div>
        </div>
      )}

      {/* Resistance Levels — Previous Swing Highs as wave indicator lines */}
      <div className="sr-section-label sr-section-res">▲ Resistance · Prev Swing Highs</div>
      {r3 && (
        <WaveLine
          cluster={r3} type="res" label="R3"
          isStrongest={strongestRes && Math.abs(r3.avg - strongestRes.avg) < 0.01}
          isCoP={copRes && Math.abs(r3.avg - copRes.avg) < 0.01}
        />
      )}
      {r2 && (
        <WaveLine
          cluster={r2} type="res" label="R2"
          isStrongest={strongestRes && Math.abs(r2.avg - strongestRes.avg) < 0.01}
          isCoP={copRes && Math.abs(r2.avg - copRes.avg) < 0.01}
        />
      )}
      {r1 && (
        <WaveLine
          cluster={r1} type="res" label="R1"
          isStrongest={strongestRes && Math.abs(r1.avg - strongestRes.avg) < 0.01}
          isCoP={copRes && Math.abs(r1.avg - copRes.avg) < 0.01}
        />
      )}
      {!r1 && !r2 && !r3 && (
        <div className="fdb-no-wave" style={{ paddingLeft: 8, fontSize: 11 }}>No resistance pivots above price</div>
      )}

      {/* Current Price */}
      <div className="sr-row sr-row-current">
        <span className="sr-label sr-label-current">▶ Current</span>
        <span className="sr-price sr-price-current">{fmt(current)}</span>
      </div>

      {/* Support Levels — Previous Swing Lows as wave indicator lines */}
      <div className="sr-section-label sr-section-sup">▼ Support · Prev Swing Lows</div>
      {s1 && (
        <WaveLine
          cluster={s1} type="sup" label="S1"
          isStrongest={strongestSup && Math.abs(s1.avg - strongestSup.avg) < 0.01}
          isCoP={copSup && Math.abs(s1.avg - copSup.avg) < 0.01}
        />
      )}
      {s2 && (
        <WaveLine
          cluster={s2} type="sup" label="S2"
          isStrongest={strongestSup && Math.abs(s2.avg - strongestSup.avg) < 0.01}
          isCoP={copSup && Math.abs(s2.avg - copSup.avg) < 0.01}
        />
      )}
      {s3 && (
        <WaveLine
          cluster={s3} type="sup" label="S3"
          isStrongest={strongestSup && Math.abs(s3.avg - strongestSup.avg) < 0.01}
          isCoP={copSup && Math.abs(s3.avg - copSup.avg) < 0.01}
        />
      )}
      {!s1 && !s2 && !s3 && (
        <div className="fdb-no-wave" style={{ paddingLeft: 8, fontSize: 11 }}>No support pivots below price</div>
      )}

      {/* Change of Polarity */}
      {(copRes || copSup) && (
        <div className="sr-cop-note">
          {copRes && (
            <div className="sr-cop-row sr-cop-res">
              <span className="sr-cop-icon">⟳</span>
              <span>CoP Resistance — ex-support @ {fmt(copRes.avg)} (price fell below)</span>
            </div>
          )}
          {copSup && (
            <div className="sr-cop-row sr-cop-sup">
              <span className="sr-cop-icon">⟳</span>
              <span>CoP Support — ex-resistance @ {fmt(copSup.avg)} (price broke above)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Column 2 — Intraday ──────────────────────────────────────────────────────

// ── Single-TF SR sub-panel ───────────────────────────────────────────────────

// ── Single-TF SR sub-panel ───────────────────────────────────────────────────

function SRSubPanel({ symbol, tfValue, tfLabel, motherSegment, motherFibLevels }) {
  const { status, segment, candles, emaHighsData, emaLowsData } = useColData(symbol, tfValue);
  const bias = getBias(segment);

  const sr = (status === "done" && candles?.length)
    ? computeSRLevels(candles, emaHighsData, emaLowsData)
    : null;

  // Use 1H mother wave segment for condition detection, fallback to this TF's segment
  const condSegment = motherSegment || segment;
  // Use 1H fib levels for trap zone detection if available, else compute from this TF
  const fibLvls = motherFibLevels?.length ? motherFibLevels : (segment ? computeFibLevels(segment) : []);

  return (
    <div className="sr-subpanel">
      <div className="sr-subpanel-head">
        <span className="sr-tf-label">{tfLabel}</span>
        <BiasPill bias={status === "done" ? bias : "neutral"} />
        {sr && <DrawOnChartBtn symbol={symbol} resolution={tfValue} sr={sr} />}
      </div>
      {status === "loading" ? (
        <div className="fdb-state" style={{ minHeight: 60 }}><div className="fdb-spinner" /></div>
      ) : (
        <SRPanel sr={sr} status={status} motherSegment={condSegment} fibLevels={fibLvls} />
      )}
    </div>
  );
}

function IntradayColumn({ symbol }) {
  // Also fetch 1H data to get mother wave condition and fib levels for trap zone
  const { status: htfStatus, segment: htfSegment } = useColData(symbol, 60);
  const htfFibLevels = computeFibLevels(htfSegment);

  return (
    <div className="fdb-col">
      <div className="fdb-col-head">
        Intraday · Support &amp; Resistance<span>15Min pivot levels</span>
      </div>

      <div className="fdb-col-body fdb-sr-body">
        <SRSubPanel
          symbol={symbol}
          tfValue={15}
          tfLabel="15Min"
          motherSegment={htfSegment}
          motherFibLevels={htfFibLevels}
        />
      </div>
    </div>
  );
}

// ── Column 3 — Entry ─────────────────────────────────────────────────────────

function EntryColumn({ symbol }) {
  const [activeEntryTF, setActiveEntryTF] = useState(1);

  const { status, segment } = useColData(symbol, activeEntryTF);
  const fibLevels = computeFibLevels(segment);
  const bias = getBias(segment);
  const isBull = bias === "bull";
  const isBear = bias === "bear";
  const tfLabel = ENTRY_TFS.find((t) => t.value === activeEntryTF)?.label || `${activeEntryTF}Min`;
  const entries = deriveEntries(segment, fibLevels, tfLabel);
  const sellEntries = entries.filter((e) => e.dir === "sell");
  const buyEntries = entries.filter((e) => e.dir === "buy");

  return (
    <div className="fdb-col">
      <div className="fdb-col-head">
        Entry timeframe<span>Precise entry points</span>
      </div>

      <div className="fdb-tf-row">
        {ENTRY_TFS.map((tf) => (
          <button
            key={tf.value}
            className={`fdb-tf ${activeEntryTF === tf.value ? "on" : ""}`}
            onClick={() => setActiveEntryTF(tf.value)}
          >
            {tf.label}
          </button>
        ))}
      </div>

      <div className="fdb-align-row">
        <div className={`fdb-align-dot ${isBull ? "bull" : ""}`} />
        <span>Alignment</span>
        {status === "done" && (
          <span
            className={`fdb-pill ${isBear ? "fdb-p-bear" : isBull ? "fdb-p-bull" : "fdb-p-neutral"}`}
            style={{ fontSize: 9, padding: "1px 6px" }}
          >
            {isBear ? "● Bearish · Strong" : isBull ? "● Bullish · Strong" : "● Neutral"}
          </span>
        )}
      </div>

      <div className="fdb-sep" />

      <div className="fdb-col-body">
        {status === "loading" && (
          <div className="fdb-state"><div className="fdb-spinner" /></div>
        )}

        {status === "done" && (
          <>
            {sellEntries.map((entry, i) => (
              <React.Fragment key={`sell-${i}`}>
                <div className="fdb-sec-title" style={{ color: "#ff5555" }}>
                  ▼ SELL ENTRIES · {tfLabel}{i > 0 ? ` (${i + 1})` : ""}
                </div>
                <EntryBlock entry={entry} />
                {(i < sellEntries.length - 1 || buyEntries.length > 0) && <div className="fdb-sep" />}
              </React.Fragment>
            ))}

            {buyEntries.map((entry, i) => (
              <React.Fragment key={`buy-${i}`}>
                <div className="fdb-sec-title" style={{ color: "#55cc55" }}>
                  ▲ BUY ENTRIES · {tfLabel}{i > 0 ? ` (${i + 1})` : ""}
                </div>
                <EntryBlock entry={entry} />
                {i < buyEntries.length - 1 && <div className="fdb-sep" />}
              </React.Fragment>
            ))}

            {entries.length === 0 && (
              <div className="fdb-no-wave">No entry signals — waiting for motherwave</div>
            )}
          </>
        )}

        {status === "error" && (
          <div className="fdb-no-wave">
            ⚠ Could not load {tfLabel} data — check backend connection
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function FibDashboardPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const [symbol, setSymbol] = useState(() => {
    try {
      const v = localStorage.getItem("tgg_symbol");
      return v ? JSON.parse(v) : "NSE:NIFTY50-INDEX";
    } catch { return "NSE:NIFTY50-INDEX"; }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [initialSearchQuery, setInitialSearchQuery] = useState("");
  // Mirror of searchOpen in a ref — same reasoning as ChartsPage.js's
  // openSearchWithQuery: lets fast typing append correctly even in the
  // ~60ms gap between setSearchOpen(true) and the modal's input gaining
  // focus, instead of using the (one-render-behind) searchOpen state.
  const searchOpenRef = useRef(false);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);

  function handleSymbolSelect(sym) {
    setSymbol(sym);
    localStorage.setItem("tgg_symbol", JSON.stringify(sym));
  }

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

  return (
    <div className="fdb-page">
      {/* Topbar */}
      <div className="fdb-topbar">
        <button className="fdb-back-btn" onClick={() => navigate("/")} title="Back to Home">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>

        <div className="fdb-logo-wrap">
          <img src="/tg-levels-logo.png" alt="TG Levels" className="fdb-logo-img" />
        </div>

        <div className="fdb-topbar-left">
          <span className="fdb-symbol-label">{symbol}</span>
          <span className="fdb-title-label">Wave · Fib · Entry dashboard</span>
        </div>

        <div className="fdb-topbar-right">
          {/* Symbol search — CHUNK 4 (2026-08-03): was a local always-visible
              inline input+dropdown; now opens the same full-screen search
              modal used on the chart page (components/SymbolSearch.js),
              so symbol search is one consistent experience everywhere.
              Icon-only, no text: the current symbol is already visible via
              fdb-symbol-label above, same as the "title tooltip only" pattern
              StatusBar.js uses next to the live chart. */}
          <button
            className="fdb-symbol-search-btn"
            onClick={() => setSearchOpen(true)}
            title={symbol || "Search symbol"}
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
              <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="2" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="fdb-theme-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {theme === "dark" ? "☀" : "🌙"}
          </button>
        </div>
      </div>

      <SymbolSearch
        isOpen={searchOpen}
        onClose={() => { setSearchOpen(false); setInitialSearchQuery(""); }}
        initialQuery={initialSearchQuery}
        onSelect={handleSymbolSelect}
      />

      {/* Three-column grid */}
      <div className="fdb-dash">
        <HtfColumn symbol={symbol} key={`htf-${symbol}`} />
        <IntradayColumn symbol={symbol} key={`1h-${symbol}`} />
        <EntryColumn symbol={symbol} key={`ent-${symbol}`} />
      </div>
    </div>
  );
}