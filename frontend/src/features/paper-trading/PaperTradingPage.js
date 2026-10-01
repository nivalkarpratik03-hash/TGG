// PaperTradingPage.js
// ─────────────────────────────────────────────────────────────────
// Global Paper Trading Dashboard. ONE page, backed by the ONE shared
// backend engine (/api/papertrading) — every strategy's Auto Entry and
// every Manual Entry trade live in the same table, so this page is just
// three views over that one table: Auto Entry (config + live), Manual
// Entry (place trade + live), Reports (EOD tradesheets, both sources).
// ─────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { BACKEND } from "../../config";
import { useTheme } from "../../App";
import SymbolSearch from "../../shared/components/SymbolSearch";
import "./PaperTradingPage.css";

const TABS = [
  { id: "auto", label: "Auto Entry" },
  { id: "manual", label: "Manual Entry" },
  { id: "reports", label: "Reports" },
];

function todayIST() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

async function api(path, opts) {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

export default function PaperTradingPage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [tab, setTab] = useState("auto");

  return (
    <div className="pt-page" data-theme={theme}>
      <div className="pt-header">
        <button className="pt-back" onClick={() => navigate("/")}>← Back</button>
        <h1>Paper Trading</h1>
        <div className="pt-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`pt-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-body">
        {tab === "auto" && <AutoEntryTab />}
        {tab === "manual" && <ManualEntryTab />}
        {tab === "reports" && <ReportsTab />}
      </div>
    </div>
  );
}

// ─── Auto Entry ─────────────────────────────────────────────────────────────
function AutoEntryTab() {
  const [configs, setConfigs] = useState([]);
  const [openTrades, setOpenTrades] = useState([]);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [cfg, trades] = await Promise.all([
        api("/api/papertrading/config"),
        api("/api/papertrading/trades?source=auto&status=OPEN"),
      ]);
      setConfigs(cfg);
      setOpenTrades(trades);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 2000); // live LTP / unrealised P&L
    return () => clearInterval(id);
  }, [load]);

  async function patch(strategyId, patchObj) {
    setSavingId(strategyId);
    try {
      await api(`/api/papertrading/config/${strategyId}`, { method: "PUT", body: JSON.stringify(patchObj) });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="pt-section">
      {error && <div className="pt-error">{error}</div>}

      <h2>Strategy Auto Entry</h2>
      <p className="pt-hint">
        Turn a strategy on to automatically open a paper trade the moment it signals. SL/Target are
        fixed points per strategy — edit and they apply to the next signal.
      </p>

      <table className="pt-table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Enabled</th>
            <th>SL (pts)</th>
            <th>Target (pts)</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>
          {configs.map((c) => (
            <ConfigRow key={c.strategyId} cfg={c} saving={savingId === c.strategyId} onPatch={(p) => patch(c.strategyId, p)} />
          ))}
        </tbody>
      </table>

      <h2>Open Auto-Entry Positions</h2>
      <TradesTable trades={openTrades} showStrategy />
    </div>
  );
}

function ConfigRow({ cfg, saving, onPatch }) {
  const [sl, setSl] = useState(cfg.slPoints);
  const [target, setTarget] = useState(cfg.targetPoints);
  const [qty, setQty] = useState(cfg.qty);

  useEffect(() => { setSl(cfg.slPoints); setTarget(cfg.targetPoints); setQty(cfg.qty); }, [cfg.slPoints, cfg.targetPoints, cfg.qty]);

  return (
    <tr className={saving ? "pt-row-saving" : ""}>
      <td>
        <div className="pt-strategy-name">{cfg.strategyName}</div>
        <div className="pt-strategy-id">{cfg.strategyId}</div>
      </td>
      <td>
        <label className="pt-switch">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          <span />
        </label>
      </td>
      <td>
        <input
          className="pt-input-num" type="number" value={sl}
          onChange={(e) => setSl(e.target.value)}
          onBlur={() => Number(sl) !== cfg.slPoints && onPatch({ slPoints: Number(sl) })}
        />
      </td>
      <td>
        <input
          className="pt-input-num" type="number" value={target}
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() => Number(target) !== cfg.targetPoints && onPatch({ targetPoints: Number(target) })}
        />
      </td>
      <td>
        <input
          className="pt-input-num" type="number" value={qty}
          onChange={(e) => setQty(e.target.value)}
          onBlur={() => Number(qty) !== cfg.qty && onPatch({ qty: Number(qty) })}
        />
      </td>
    </tr>
  );
}

// ─── Manual Entry ───────────────────────────────────────────────────────────
function ManualEntryTab() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState("LONG");
  const [qty, setQty] = useState(1);
  const [slMode, setSlMode] = useState("points");
  const [sl, setSl] = useState(20);
  const [target, setTarget] = useState(40);
  const [openTrades, setOpenTrades] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const trades = await api("/api/papertrading/trades?source=manual&status=OPEN");
      setOpenTrades(trades);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 2000); // live LTP / unrealised P&L
    return () => clearInterval(id);
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!symbol) { setError("Pick a symbol first"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const body = { symbol, side, qty: Number(qty) };
      if (slMode === "points") { body.slPoints = Number(sl); body.targetPoints = Number(target); }
      else { body.slPrice = Number(sl); body.targetPrice = Number(target); }
      await api("/api/papertrading/manual", { method: "POST", body: JSON.stringify(body) });
      setSymbol("");
      await load();
    } catch (e2) {
      setError(e2.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function closeTrade(id) {
    try {
      await api(`/api/papertrading/close/${id}`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="pt-section">
      {error && <div className="pt-error">{error}</div>}

      <h2>Place Manual Trade</h2>
      <form className="pt-manual-form" onSubmit={submit}>
        <div className="pt-field">
          <label>Symbol</label>
          <button type="button" className="pt-symbol-btn" onClick={() => setSearchOpen(true)}>
            {symbol || "Select symbol…"}
          </button>
        </div>

        <div className="pt-field">
          <label>Side</label>
          <select value={side} onChange={(e) => setSide(e.target.value)}>
            <option value="LONG">Long</option>
            <option value="SHO  RT">Short</option>
          </select>
        </div>

        <div className="pt-field">
          <label>Qty</label>
          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>

        <div className="pt-field">
          <label>SL / Target as</label>
          <select value={slMode} onChange={(e) => setSlMode(e.target.value)}>
            <option value="points">Points from entry</option>
            <option value="price">Exact price</option>
          </select>
        </div>

        <div className="pt-field">
          <label>Stop Loss</label>
          <input type="number" value={sl} onChange={(e) => setSl(e.target.value)} />
        </div>

        <div className="pt-field">
          <label>Target</label>
          <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>

        <button type="submit" className="pt-submit" disabled={submitting}>
          {submitting ? "Placing…" : "Place Trade"}
        </button>
      </form>

      <SymbolSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} onSelect={(s) => { setSymbol(s); setSearchOpen(false); }} />

      <h2>Open Manual Positions</h2>
      <TradesTable trades={openTrades} onClose={closeTrade} />
    </div>
  );
}

// ─── Reports ────────────────────────────────────────────────────────────────
function ReportsTab() {
  const [date, setDate] = useState(todayIST());
  const [source, setSource] = useState("auto");
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/papertrading/report/${source}/${date}`);
      setReport(r);
      setError(null);
    } catch (e) {
      setError(e.message);
      setReport(null);
    }
  }, [source, date]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="pt-section">
      <div className="pt-report-controls">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="auto">Auto Entry Report</option>
          <option value="manual">Manual Entry Report</option>
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      {error && <div className="pt-error">{error}</div>}
      {!report ? null : source === "auto" ? <AutoReport report={report} /> : <ManualReport report={report} />}
    </div>
  );
}

function OverallCards({ overall }) {
  return (
    <div className="pt-stat-cards">
      <StatCard label="Total Trades" value={overall.totalTrades} />
      <StatCard label="Winning" value={overall.winningTrades} tone="green" />
      <StatCard label="Losing" value={overall.losingTrades} tone="red" />
      <StatCard label="Win Rate" value={`${overall.winRate}%`} />
      <StatCard label="Net P&L" value={fmtNum(overall.netPnl)} tone={overall.netPnl >= 0 ? "green" : "red"} />
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className={`pt-stat-card ${tone || ""}`}>
      <div className="pt-stat-value">{value}</div>
      <div className="pt-stat-label">{label}</div>
    </div>
  );
}

function AutoReport({ report }) {
  return (
    <div>
      <h2>Auto Entry — {report.tradingDay}</h2>
      <OverallCards overall={report.overall} />
      {report.strategies.map((s) => (
        <div key={s.strategyId} className="pt-strategy-block">
          <h3>{s.strategyName || s.strategyId}</h3>
          <OverallCards overall={s} />
          <TradesTable trades={s.trades} />
        </div>
      ))}
      {!report.strategies.length && <p className="pt-hint">No auto-entry trades on this day.</p>}
    </div>
  );
}

function ManualReport({ report }) {
  return (
    <div>
      <h2>Manual Entry — {report.tradingDay}</h2>
      <OverallCards overall={report.overall} />
      <TradesTable trades={report.trades} />
      {!report.trades.length && <p className="pt-hint">No manual trades on this day.</p>}
    </div>
  );
}

// ─── Shared trades table ────────────────────────────────────────────────────
function TradesTable({ trades, onClose, showStrategy }) {
  if (!trades || !trades.length) return <p className="pt-hint">No trades.</p>;
  return (
    <table className="pt-table">
      <thead>
        <tr>
          {showStrategy && <th>Strategy</th>}
          <th>Symbol</th>
          <th>Side</th>
          <th>Qty</th>
          <th>Entry</th>
          <th>SL</th>
          <th>Target</th>
          {trades.some((t) => t.status === "OPEN") && <th>LTP</th>}
          <th>Exit</th>
          <th>Reason</th>
          <th>P&L</th>
          <th>Status</th>
          {onClose && <th></th>}
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            {showStrategy && <td>{t.strategy_name || t.strategy_id}</td>}
            <td>{t.symbol}</td>
            <td className={t.side === "LONG" ? "pt-long" : "pt-short"}>{t.side}</td>
            <td>{t.qty}</td>
            <td>{fmtNum(t.entry_price)}</td>
            <td>{fmtNum(t.sl_price)}</td>
            <td>{fmtNum(t.target_price)}</td>
            {trades.some((x) => x.status === "OPEN") && <td>{t.status === "OPEN" ? fmtNum(t.ltp) : "—"}</td>}
            <td>{fmtNum(t.exit_price)}</td>
            <td>{t.exit_reason || "—"}</td>
            {(() => {
              const v = t.status === "OPEN" ? t.unrealised : t.pnl;
              return <td className={Number(v) > 0 ? "pt-long" : Number(v) < 0 ? "pt-short" : ""}>{fmtNum(v)}{t.status === "OPEN" && v != null ? " *" : ""}</td>;
            })()}
            <td>{t.status}</td>
            {onClose && <td>{t.status === "OPEN" && <button className="pt-close-btn" onClick={() => onClose(t.id)}>Close</button>}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}