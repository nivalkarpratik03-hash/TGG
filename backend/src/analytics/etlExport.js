"use strict";
/**
 * etlExport.js — Chunk 5 of the Analytics module (Analytics-project-plan.md
 * Section 5). Turns one analytics result (runAnalytics.js's output — trades
 * + summary) into a real .xlsx workbook: a "Trades" sheet with common
 * columns plus that strategy's own condition columns, and a "Summary"
 * sheet with the aggregate KPIs.
 *
 * Reuses the `xlsx` package already a backend dependency
 * (backend/package.json) — same library the frontend moczkup already uses
 * client-side (SheetJS), just generating server-side here so a full trade
 * set can be exported, not only the mockup's 12-row preview.
 *
 * Strategy-specific columns are DISCOVERED from the actual trades supplied
 * (union of every key seen under each trade's `conditions` object), never
 * hardcoded — same "don't hardcode Doji columns" rule as everywhere else
 * in this module. A strategy with different condition fields gets
 * different columns automatically, no code change needed here.
 */

const XLSX = require("xlsx");

const COMMON_COLUMNS = [
  "symbol", "direction", "state",
  "entryTime", "entryPrice", "stopPrice", "targetPrice",
  "exitTime", "exitPrice", "exitReason",
  "pnl", "rMultiple", "mfe", "mae", "holdBars",
  "entryHour", "dow",
];

function _fmtTime(ms) {
  if (ms == null) return "";
  return new Date(ms).toISOString();
}

// Union of every conditions key seen across all trades, sorted so column
// order is stable run to run (not insertion-order-dependent).
function _conditionColumns(trades) {
  const keys = new Set();
  for (const t of trades) {
    if (t.conditions && typeof t.conditions === "object") {
      Object.keys(t.conditions).forEach((k) => keys.add(k));
    }
  }
  return Array.from(keys).sort();
}

// Exported separately from buildWorkbook() so it's directly unit-testable
// (plain objects/arrays in, no SheetJS involved) without needing to parse
// a workbook back open just to check the row shape is right.
function tradesToRows(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const condCols = _conditionColumns(list);
  return list.map((t) => {
    const row = {};
    for (const col of COMMON_COLUMNS) {
      let v = t[col];
      if (col === "entryTime" || col === "exitTime") v = _fmtTime(v);
      row[col] = v == null ? "" : v;
    }
    for (const cc of condCols) {
      const v = t.conditions ? t.conditions[cc] : undefined;
      row[`cond_${cc}`] = v == null ? "" : v;
    }
    return row;
  });
}

function summaryToRows(summary) {
  const s = summary || {};
  return Object.entries(s).map(([metric, value]) => ({ metric, value: value == null ? "" : value }));
}

// `analyticsResult` = runAnalytics.js's output shape: { strategyId, trades,
// summary, skipped, computedAt }.
function buildWorkbook(analyticsResult) {
  const trades = (analyticsResult && analyticsResult.trades) || [];
  const summary = (analyticsResult && analyticsResult.summary) || {};

  const wb = XLSX.utils.book_new();

  const tradeRows = tradesToRows(trades);
  const tradesSheet = XLSX.utils.json_to_sheet(tradeRows, { header: tradeRows.length ? undefined : COMMON_COLUMNS });
  XLSX.utils.book_append_sheet(wb, tradesSheet, "Trades");

  const summaryRows = summaryToRows(summary);
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  return wb;
}

function toBuffer(analyticsResult) {
  const wb = buildWorkbook(analyticsResult);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function toFile(analyticsResult, filePath) {
  const wb = buildWorkbook(analyticsResult);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { buildWorkbook, toBuffer, toFile, tradesToRows, summaryToRows, COMMON_COLUMNS };
