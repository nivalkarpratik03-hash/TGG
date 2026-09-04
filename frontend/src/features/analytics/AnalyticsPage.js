// AnalyticsPage.js
// ─────────────────────────────────────────────────────────────────────────
// Chunk 7 of the Analytics module (Analytics-project-plan.md). This is the
// real port of the approved mockup (strategy-analytics-mockup.html) into
// the actual React app — same theme system (useTheme / var(--bg) etc, see
// styles/index.css), same fetch/BACKEND convention every other page uses
// (see ScannerPage.js), same feature-folder pattern.
//
// WHAT CHANGED FROM THE MOCKUP (per the plan's Section 6):
//   - genTrades() (seeded-random mock generator)  -> DELETED. Replaced by a
//     real GET /api/analytics/run call.
//   - STRATEGY_DEFS (hardcoded param/condition labels in the HTML)         -> DELETED.
//     Condition columns are now DISCOVERED from whatever keys actually show
//     up in the returned trades' `conditions` objects (same "never hardcode
//     Doji columns" rule etlExport.js already follows server-side) — the
//     dropdown itself, and which strategies are usable at all, come from
//     the real GET /api/analytics/strategies response (`analyticsWired`).
//   - Excel export button -> now a real link to GET /api/analytics/export,
//     server-generated (the full trade set, not the mockup's 12-row
//     preview) — client-side SheetJS from the mockup is gone entirely.
//
// HONEST SCOPE NOTE: the approved mockup had 16 analysis sections. This
// first real pass ports the filter bar, KPI row, and one representative
// chart of each KIND the mockup used (line / doughnut / scatter / bar),
// plus the condition-chip filter and the trade table — proving the full
// real-data pipe end to end. The remaining sections are the exact same
// pattern repeated against fields already present on every trade object
// (see the trade shape below) — flagged as follow-up, not silently skipped.
//
// BACKEND FILTER SCOPE NOTE: analyticsRouter.js's /run currently accepts
// strategyId + assetClass + instrumentType + resolution only — it does NOT
// yet accept the mockup's fuller filter set (symbol, date range, direction,
// strategy params). Only the filters that are REAL right now are wired
// below; the rest are left out rather than shown as if they worked.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Chart as ChartJS,
  LineElement, PointElement, LinearScale, CategoryScale,
  BarElement, ArcElement, Tooltip, Legend, Title,
} from "chart.js";
import { Line, Bar, Doughnut, Scatter } from "react-chartjs-2";
import { BACKEND } from "../../config";
import { useTheme } from "../../App";
import "./AnalyticsPage.css";

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, BarElement, ArcElement, Tooltip, Legend, Title);

const ASSET_CLASSES = [
  { value: "index", label: "Index" },
  { value: "equity", label: "Equity" },
  { value: "commodity", label: "Commodity" },
];
const INSTRUMENT_TYPES = [
  { value: "spot", label: "Spot" },
  { value: "futures", label: "Futures" },
];
const RESOLUTIONS = [5, 15, 60, 1440];
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOLD_EDGES = [2, 5, 10, 20];
const HOLD_LABELS = ["0-2", "2-5", "5-10", "10-20", "20+"];
const BUILDER_FIELDS = [
  { key: "mfe", label: "MFE" },
  { key: "mae", label: "MAE" },
  { key: "pnl", label: "P&L" },
  { key: "rMultiple", label: "R-multiple" },
  { key: "holdBars", label: "Holding time (bars)" },
  { key: "entryHour", label: "Entry hour" },
];

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const chartTextColor = theme === "light" ? "#4a5068" : "#7a8099";
  const chartGridColor = theme === "light" ? "#d0d4e0" : "#1e2230";

  // ── Strategy list (from the real backend, wired-state included) ──────
  const [strategies, setStrategies] = useState([]);
  const [strategyId, setStrategyId] = useState("");
  const [assetClass, setAssetClass] = useState("index");
  const [instrumentType, setInstrumentType] = useState("spot");
  const [resolution, setResolution] = useState(5);

  const [result, setResult] = useState(null);   // raw /run response
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeCondKey, setActiveCondKey] = useState(null);
  const [activeCondVal, setActiveCondVal] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/analytics/strategies`)
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list);
        const firstWired = list.find((s) => s.analyticsWired);
        if (firstWired) setStrategyId(firstWired.id);
      })
      .catch((e) => setError(`Could not load strategy list: ${e.message}`));
  }, []);

  const runAnalysis = useCallback(() => {
    if (!strategyId) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ strategyId, assetClass, instrumentType, resolution: String(resolution) });
    fetch(`${BACKEND}/api/analytics/run?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.message || data.error);
          setResult(null);
        } else {
          setResult(data);
          setActiveCondKey(null);
          setActiveCondVal(null);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [strategyId, assetClass, instrumentType, resolution]);

  const trades = useMemo(() => result?.trades || [], [result]);
  const summary = result?.summary || null;

  // ── Condition keys/values discovered from the actual returned trades —
  // same "never hardcode" rule as the backend's etlExport.js column logic,
  // just done client-side here for the filter chips. ────────────────────
  const conditionOptions = useMemo(() => {
    const byKey = {};
    trades.forEach((t) => {
      if (!t.conditions) return;
      Object.entries(t.conditions).forEach(([k, v]) => {
        if (v == null) return;
        byKey[k] = byKey[k] || new Set();
        byKey[k].add(String(v));
      });
    });
    return Object.fromEntries(Object.entries(byKey).map(([k, set]) => [k, Array.from(set).sort()]));
  }, [trades]);

  const conditionFilteredTrades = useMemo(() => {
    if (!activeCondKey || activeCondVal == null) return trades;
    return trades.filter((t) => t.conditions && String(t.conditions[activeCondKey]) === activeCondVal);
  }, [trades, activeCondKey, activeCondVal]);

  // ── Equity curve (cumulative R-multiple, resolved trades only, in
  // entry-time order) ───────────────────────────────────────────────────
  const equityData = useMemo(() => {
    const resolved = trades.filter((t) => t.state === "win" || t.state === "loss")
      .slice().sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    let cum = 0;
    const points = resolved.map((t, i) => { cum += t.rMultiple || 0; return { x: i + 1, y: Number(cum.toFixed(2)) }; });
    return {
      datasets: [{
        label: "Cumulative R", data: points, borderColor: "#4fc3ff", backgroundColor: "rgba(79,195,255,0.08)",
        fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.15,
      }],
    };
  }, [trades]);

  const winLossData = useMemo(() => {
    const wins = trades.filter((t) => t.state === "win").length;
    const losses = trades.filter((t) => t.state === "loss").length;
    return { labels: ["Win", "Loss"], datasets: [{ data: [wins, losses], backgroundColor: ["#00d97e", "#ff4560"], borderWidth: 0 }] };
  }, [trades]);

  const mfeMaeData = useMemo(() => ({
    datasets: [
      { label: "Win", data: trades.filter((t) => t.state === "win").map((t) => ({ x: t.mae, y: t.mfe })), backgroundColor: "rgba(0,217,126,0.65)" },
      { label: "Loss", data: trades.filter((t) => t.state === "loss").map((t) => ({ x: t.mae, y: t.mfe })), backgroundColor: "rgba(255,69,96,0.65)" },
    ],
  }), [trades]);

  const symbolData = useMemo(() => {
    const bySymbol = {};
    trades.forEach((t) => {
      if (t.pnl == null) return;
      bySymbol[t.symbol] = (bySymbol[t.symbol] || 0) + t.pnl;
    });
    const labels = Object.keys(bySymbol);
    return {
      labels,
      datasets: [{
        label: "Net P&L",
        data: labels.map((s) => Number(bySymbol[s].toFixed(2))),
        backgroundColor: labels.map((s) => (bySymbol[s] >= 0 ? "rgba(0,217,126,0.6)" : "rgba(255,69,96,0.6)")),
      }],
    };
  }, [trades]);

  // ── Time-of-day / day-of-week / holding-time / long-vs-short ─────────
  // All built from fields already on every trade (entryHour, dow, holdBars,
  // direction) — no extra backend call needed, same as the mockup.
  const todData = useMemo(() => {
    const buckets = {};
    for (let h = 9; h <= 15; h++) buckets[h] = 0;
    trades.forEach((t) => { if (t.entryHour != null) buckets[t.entryHour] = (buckets[t.entryHour] || 0) + 1; });
    const labels = Object.keys(buckets).sort((a, b) => a - b);
    return { labels: labels.map((h) => `${h}:00`), datasets: [{ label: "Signals", data: labels.map((h) => buckets[h]), backgroundColor: "rgba(240,180,41,0.6)" }] };
  }, [trades]);

  const dowData = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    trades.forEach((t) => { if (t.dow != null && t.dow >= 0 && t.dow < 7) buckets[t.dow] += 1; });
    // Drop trailing weekend columns if genuinely empty (equities/index don't trade Sat/Sun).
    const lastNonZero = buckets.reduce((last, v, i) => (v > 0 ? i : last), 4);
    const labels = DOW_LABELS.slice(0, Math.max(5, lastNonZero + 1));
    return { labels, datasets: [{ label: "Signals", data: labels.map((_, i) => buckets[i]), backgroundColor: "rgba(79,195,255,0.55)" }] };
  }, [trades]);

  const holdData = useMemo(() => {
    const buckets = HOLD_LABELS.map(() => 0);
    trades.forEach((t) => {
      if (t.holdBars == null) return;
      let idx = HOLD_EDGES.findIndex((e) => t.holdBars <= e);
      if (idx === -1) idx = HOLD_LABELS.length - 1;
      buckets[idx] += 1;
    });
    return { labels: HOLD_LABELS.map((l) => `${l} bars`), datasets: [{ label: "Trades", data: buckets, backgroundColor: "rgba(79,195,255,0.5)" }] };
  }, [trades]);

  const longShortData = useMemo(() => {
    const winRateOf = (dir) => {
      const subset = trades.filter((t) => t.direction === dir && (t.state === "win" || t.state === "loss"));
      const wins = subset.filter((t) => t.state === "win").length;
      return subset.length ? Number(((wins / subset.length) * 100).toFixed(1)) : 0;
    };
    return {
      labels: ["Long (up)", "Short (down)"],
      datasets: [{ label: "Win rate %", data: [winRateOf("up"), winRateOf("down")], backgroundColor: "rgba(0,217,126,0.55)" }],
    };
  }, [trades]);

  // ── Custom chart builder — same idea as the locked mockup: any numeric
  // field vs any numeric field, optionally grouped. Purely client-side,
  // operates on the already-fetched trades array. ───────────────────────
  const [builderX, setBuilderX] = useState("mae");
  const [builderY, setBuilderY] = useState("mfe");
  const [builderGroup, setBuilderGroup] = useState("state");

  const builderData = useMemo(() => {
    const groupKey = builderGroup === "none" ? null : builderGroup;
    const palette = { win: "#00d97e", loss: "#ff4560", up: "#4fc3ff", down: "#f0b429" };
    if (!groupKey) {
      return { datasets: [{ label: "Trades", data: trades.map((t) => ({ x: t[builderX], y: t[builderY] })).filter((p) => p.x != null && p.y != null), backgroundColor: "rgba(79,195,255,0.55)" }] };
    }
    const groups = {};
    trades.forEach((t) => {
      const g = t[groupKey];
      if (g == null) return;
      if (t[builderX] == null || t[builderY] == null) return;
      groups[g] = groups[g] || [];
      groups[g].push({ x: t[builderX], y: t[builderY] });
    });
    return {
      datasets: Object.keys(groups).map((g) => ({
        label: g, data: groups[g], backgroundColor: (palette[g] || "#4fc3ff") + "cc",
      })),
    };
  }, [trades, builderX, builderY, builderGroup]);

  const commonChartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: chartTextColor, boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: chartTextColor }, grid: { color: chartGridColor } },
      y: { ticks: { color: chartTextColor }, grid: { color: chartGridColor } },
    },
  };
  // Single-series charts don't need a legend at all — showing one item
  // (previously rendering as "undefined" since no label was set) just
  // adds noise. Explicit opt-out per chart instead.
  const noLegendOpts = { ...commonChartOpts, plugins: { legend: { display: false } } };
  // Line chart is fed {x, y} point objects (x = trade sequence number),
  // not category labels — the x-axis must be told that explicitly or
  // Chart.js silently falls back to a category scale and renders nothing.
  const equityChartOpts = {
    ...noLegendOpts,
    scales: {
      x: { type: "linear", ticks: { color: chartTextColor }, grid: { color: chartGridColor }, title: { display: true, text: "Trade #", color: chartTextColor } },
      y: { ticks: { color: chartTextColor }, grid: { color: chartGridColor }, title: { display: true, text: "Cumulative R", color: chartTextColor } },
    },
  };
  const builderChartOpts = {
    ...commonChartOpts,
    scales: {
      x: { ticks: { color: chartTextColor }, grid: { color: chartGridColor }, title: { display: true, text: BUILDER_FIELDS.find((f) => f.key === builderX)?.label, color: chartTextColor } },
      y: { ticks: { color: chartTextColor }, grid: { color: chartGridColor }, title: { display: true, text: BUILDER_FIELDS.find((f) => f.key === builderY)?.label, color: chartTextColor } },
    },
  };

  const exportUrl = strategyId
    ? `${BACKEND}/api/analytics/export?${new URLSearchParams({ strategyId, assetClass, instrumentType, resolution: String(resolution) }).toString()}`
    : null;

  const condColumns = useMemo(() => Object.keys(conditionOptions).sort(), [conditionOptions]);

  return (
    <div className="an-page">
      <div className="an-header">
        <button className="an-back-btn" onClick={() => navigate("/")}>←</button>
        <h1>Strategy Analytics</h1>
        <span className="an-header-sub">Historical, backend-computed — see Analytics-project-plan.md</span>
      </div>

      <div className="an-body">
        {/* ── Filters ─────────────────────────────────────────────── */}
        <div className="an-panel an-filters">
          <div className="an-filter-grid">
            <div className="an-field">
              <label>Strategy</label>
              <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.analyticsWired}>
                    {s.name}{!s.analyticsWired ? " (not wired yet)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="an-field">
              <label>Instrument</label>
              <select value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
                {ASSET_CLASSES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            <div className="an-field">
              <label>Type</label>
              <select value={instrumentType} onChange={(e) => setInstrumentType(e.target.value)}>
                {INSTRUMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="an-field">
              <label>Resolution</label>
              <select value={resolution} onChange={(e) => setResolution(Number(e.target.value))}>
                {RESOLUTIONS.map((r) => <option key={r} value={r}>{r >= 1440 ? `${r / 1440}D` : `${r}m`}</option>)}
              </select>
            </div>
          </div>
          <div className="an-filter-actions">
            {error && <span className="an-error-text">{error}</span>}
            <button className="an-btn an-btn-primary" disabled={loading || !strategyId} onClick={runAnalysis}>
              {loading ? "Running…" : "Apply / Run analysis"}
            </button>
          </div>
        </div>

        {!result && !loading && !error && (
          <div className="an-empty-state">Pick a strategy and run analysis to see results.</div>
        )}

        {summary && (
          <>
            {/* ── KPI row ─────────────────────────────────────────── */}
            <div className="an-kpi-grid">
              <Kpi label="Total Trades" value={summary.total} />
              <Kpi label="Resolved" value={summary.resolvedCount} />
              <Kpi label="Win Rate" value={summary.winRatePct != null ? `${summary.winRatePct.toFixed(1)}%` : "—"} tone={summary.winRatePct >= 50 ? "pos" : "neg"} />
              <Kpi label="Expectancy" value={summary.expectancy != null ? `${summary.expectancy >= 0 ? "+" : ""}${summary.expectancy.toFixed(2)}R` : "—"} tone={summary.expectancy >= 0 ? "pos" : "neg"} />
              <Kpi label="Profit Factor" value={summary.profitFactor != null ? summary.profitFactor.toFixed(2) : "—"} tone={summary.profitFactor >= 1 ? "pos" : "neg"} />
              <Kpi label="Max Drawdown" value={summary.maxDrawdownR != null ? `${summary.maxDrawdownR.toFixed(2)}R` : "—"} tone="neg" />
              <Kpi label="Big Candle" value={summary.bigCandleCount} />
              <Kpi label="Still Open" value={summary.openCount} />
            </div>

            {/* ── Equity curve ──────────────────────────────────────── */}
            <Section title="Equity Curve" sub={`${trades.length} signals · cumulative R-multiple`}>
              <div className="an-chart-wrap tall"><Line data={equityData} options={equityChartOpts} /></div>
            </Section>

            {/* ── Win/Loss + MFE/MAE ────────────────────────────────── */}
            <div className="an-two-col">
              <Section title="Win / Loss">
                <div className="an-chart-wrap"><Doughnut data={winLossData} options={{ ...commonChartOpts, scales: undefined, cutout: "68%" }} /></div>
              </Section>
              <Section title="MFE / MAE — Excursion">
                <div className="an-chart-wrap"><Scatter data={mfeMaeData} options={commonChartOpts} /></div>
              </Section>
            </div>

            {/* ── Symbol breakdown ──────────────────────────────────── */}
            <Section title="Symbol Analysis" sub="Net P&L by symbol">
              <div className="an-chart-wrap"><Bar data={symbolData} options={{ ...noLegendOpts, indexAxis: "y" }} /></div>
            </Section>

            {/* ── Time-of-day + Day-of-week ──────────────────────────── */}
            <div className="an-two-col">
              <Section title="Time-of-Day" sub="Signals by entry hour">
                <div className="an-chart-wrap"><Bar data={todData} options={noLegendOpts} /></div>
              </Section>
              <Section title="Day-of-Week" sub="Signals by entry weekday">
                <div className="an-chart-wrap"><Bar data={dowData} options={noLegendOpts} /></div>
              </Section>
            </div>

            {/* ── Holding time + Long vs Short ────────────────────────── */}
            <div className="an-two-col">
              <Section title="Holding-Time Analysis" sub="Bars held before exit">
                <div className="an-chart-wrap"><Bar data={holdData} options={noLegendOpts} /></div>
              </Section>
              <Section title="Long vs Short" sub="Win rate by direction">
                <div className="an-chart-wrap"><Bar data={longShortData} options={{ ...noLegendOpts, scales: { ...commonChartOpts.scales, y: { ...commonChartOpts.scales.y, max: 100 } } }} /></div>
              </Section>
            </div>

            {/* ── Condition analysis (dynamic, per Section 6) ────────── */}
            {condColumns.length > 0 && (
              <Section title="Condition Analysis" sub="Filter by any condition this strategy actually returned">
                <div className="an-chip-groups">
                  {condColumns.map((key) => (
                    <div className="an-chip-row" key={key}>
                      <span className="an-chip-label">{key}</span>
                      {conditionOptions[key].map((val) => (
                        <button
                          key={val}
                          className={`an-chip ${activeCondKey === key && activeCondVal === val ? "active" : ""}`}
                          onClick={() => {
                            if (activeCondKey === key && activeCondVal === val) { setActiveCondKey(null); setActiveCondVal(null); }
                            else { setActiveCondKey(key); setActiveCondVal(val); }
                          }}
                        >
                          {val}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="an-kpi-grid an-kpi-grid-5">
                  {(() => {
                    const s = summarizeClientSide(conditionFilteredTrades);
                    return (
                      <>
                        <Kpi label="Trades" value={s.total} />
                        <Kpi label="Win Rate" value={s.winRatePct != null ? `${s.winRatePct.toFixed(1)}%` : "—"} />
                        <Kpi label="Expectancy" value={s.expectancy != null ? `${s.expectancy.toFixed(2)}R` : "—"} />
                        <Kpi label="Profit Factor" value={s.profitFactor != null ? s.profitFactor.toFixed(2) : "—"} />
                        <Kpi label="Max DD" value={s.maxDrawdownR != null ? `${s.maxDrawdownR.toFixed(2)}R` : "—"} />
                      </>
                    );
                  })()}
                </div>
              </Section>
            )}

            {/* ── Custom chart builder ────────────────────────────────── */}
            <Section title="Custom Chart Builder" sub="Power BI-style — any field vs any field">
              <div className="an-builder-controls">
                <div className="an-field">
                  <label>X-Axis</label>
                  <select value={builderX} onChange={(e) => setBuilderX(e.target.value)}>
                    {BUILDER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </div>
                <div className="an-field">
                  <label>Y-Axis</label>
                  <select value={builderY} onChange={(e) => setBuilderY(e.target.value)}>
                    {BUILDER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </div>
                <div className="an-field">
                  <label>Group by</label>
                  <select value={builderGroup} onChange={(e) => setBuilderGroup(e.target.value)}>
                    <option value="state">Win / Loss</option>
                    <option value="direction">Long / Short</option>
                    <option value="none">None</option>
                  </select>
                </div>
              </div>
              <div className="an-chart-wrap tall"><Scatter data={builderData} options={builderChartOpts} /></div>
            </Section>

            {/* ── Trade log + export ─────────────────────────────────── */}
            <Section
              title="Trade log"
              sub={`${trades.length} trades · common columns + ${condColumns.length} strategy-specific`}
              action={exportUrl && <a className="an-btn an-btn-primary" href={exportUrl}>Download Excel</a>}
            >
              <div className="an-table-wrap">
                <table className="an-table">
                  <thead>
                    <tr>
                      <th>Symbol</th><th>Dir</th><th>State</th><th>Entry</th><th>Exit</th>
                      <th>P&L</th><th>R</th><th>MFE</th><th>MAE</th>
                      {condColumns.map((c) => <th key={c}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.slice(0, 25).map((t, i) => (
                      <tr key={i}>
                        <td>{t.symbol}</td>
                        <td>{t.direction}</td>
                        <td>{t.state}</td>
                        <td>{t.entryPrice}</td>
                        <td>{t.exitPrice ?? "—"}</td>
                        <td className={t.pnl >= 0 ? "an-pos" : "an-neg"}>{t.pnl != null ? t.pnl.toFixed(2) : "—"}</td>
                        <td className={t.rMultiple >= 0 ? "an-pos" : "an-neg"}>{t.rMultiple != null ? t.rMultiple.toFixed(2) : "—"}</td>
                        <td>{t.mfe != null ? t.mfe.toFixed(2) : "—"}</td>
                        <td>{t.mae != null ? t.mae.toFixed(2) : "—"}</td>
                        {condColumns.map((c) => <td key={c}>{t.conditions?.[c] ?? "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {trades.length > 25 && <div className="an-table-note">Showing 25 of {trades.length} — download Excel for the full set.</div>}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// Small client-side re-summarize for the condition-filter chips (filters
// the ALREADY-fetched trades array — no extra backend call needed for
// this interaction, same as the mockup's instant-feeling chip filter).
function summarizeClientSide(trades) {
  const resolved = trades.filter((t) => t.state === "win" || t.state === "loss");
  const wins = resolved.filter((t) => t.state === "win");
  const total = trades.length;
  const winRatePct = resolved.length ? (wins.length / resolved.length) * 100 : null;
  const rs = resolved.map((t) => t.rMultiple || 0);
  const expectancy = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const grossWin = wins.reduce((a, t) => a + (t.rMultiple || 0), 0);
  const grossLoss = Math.abs(resolved.filter((t) => t.state === "loss").reduce((a, t) => a + (t.rMultiple || 0), 0));
  const profitFactor = grossLoss ? grossWin / grossLoss : null;
  let cum = 0, peak = 0, maxDrawdownR = 0;
  resolved.slice().sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0)).forEach((t) => {
    cum += t.rMultiple || 0; peak = Math.max(peak, cum); maxDrawdownR = Math.min(maxDrawdownR, cum - peak);
  });
  return { total, winRatePct, expectancy, profitFactor, maxDrawdownR };
}

function Kpi({ label, value, tone }) {
  return (
    <div className="an-kpi">
      <div className="an-kpi-label">{label}</div>
      <div className={`an-kpi-val ${tone === "pos" ? "an-pos" : tone === "neg" ? "an-neg" : ""}`}>{value}</div>
    </div>
  );
}

function Section({ title, sub, action, children }) {
  return (
    <div className="an-block">
      <div className="an-block-head">
        <span className="an-block-title">{title}</span>
        {sub && <span className="an-block-sub">{sub}</span>}
        {action}
      </div>
      <div className="an-panel">{children}</div>
    </div>
  );
}