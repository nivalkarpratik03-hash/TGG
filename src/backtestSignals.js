/**
 * backtest_signals.js
 *
 * Reads pattern_signals.xlsx (10-column format), fetches candle history via Fyers,
 * syncs using unix timestamp from Pattern ID, computes SL / Target / Entry / PnL
 * from live Fyers data, walks forward candles to check hits, writes backtest_results.xlsx.
 *
 * Excel columns (1-based):
 *   1  Pattern ID        6  Signal Candle Time
 *   2  Symbol            7  Signal Candle High
 *   3  Crossover Type    8  Signal Candle Low
 *   4  Crossover Time    9  Signal Candle Close
 *   5  Crossover Price   10 Detected At
 *
 * PnL logic:
 *   - CLOSED trades (TARGET HIT / SL HIT): PnL = hitPrice − entryPrice (bull) or reversed (bear)
 *   - OPEN trades: PnL columns left blank (no mark-to-market assumption)
 *   - PnL % = PnL pts / entryPrice × 100
 *
 * Usage:     node backtest_signals.js
 * Exported:  runBacktest, readSignals, backtestSignal, writeResults, fetchCandles
 */

const ExcelJS = require("exceljs");
const moment  = require("moment");
const path    = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const INPUT_FILE  = path.resolve("pattern_signals.xlsx");
const OUTPUT_FILE = path.resolve("backtest_results.xlsx");
const SHEET_NAME  = "Signals";

const fyers = require("../utils/func/fyersapi");

const RESOLUTION = "5"; // 15-min candles
const PRICE_FMT  = '"₹"#,##0.00';
const PCT_FMT    = '0.00"%"';
const DT_FMT     = "YYYY-MM-DD HH:mm";

// ─── Styling ──────────────────────────────────────────────────────────────────

const HEADER_FONT  = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
const HEADER_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const HEADER_ALIGN = { horizontal: "center", vertical: "middle" };
const BORDER       = { style: "thin", color: { argb: "FFBFBFBF" } };
const CELL_BORDER  = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

const FILLS = {
  TARGET_HIT: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } }, // green
  SL_HIT:     { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } }, // red/orange
  OPEN:       { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }, // yellow
  ERROR:      { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } }, // grey
};

const RESULT_HEADERS = [
  { header: "Pattern ID",          key: "patternId",     width: 34 },
  { header: "Symbol",              key: "symbol",        width: 18 },
  { header: "Crossover Type",      key: "crossoverType", width: 16 },
  { header: "Signal Candle Time",  key: "signalTime",    width: 22 },
  { header: "Signal Candle High",  key: "signalHigh",    width: 20 },
  { header: "Signal Candle Low",   key: "signalLow",     width: 20 },
  { header: "Signal Candle Close", key: "signalClose",   width: 22 },
  { header: "Entry (Next Open)",   key: "entryPrice",    width: 18 },
  { header: "Stop Loss",           key: "stopLoss",      width: 16 },
  { header: "Target (1:1 RR)",     key: "target",        width: 16 },
  { header: "Sync OK?",            key: "syncOk",        width: 12 },
  { header: "Result",              key: "result",        width: 14 },
  { header: "Hit Candle Time",     key: "hitTime",       width: 22 },
  { header: "Hit Price",           key: "hitPrice",      width: 16 },
  { header: "Candles to Hit",      key: "candlesToHit",  width: 16 },
  { header: "PnL (pts)",           key: "pnlPoints",     width: 14 },
  { header: "PnL %",               key: "pnlPct",        width: 10 },
  { header: "Notes",               key: "notes",         width: 40 },
];

// 1-based column indices for formatting
const PRICE_COLS = [5, 6, 7, 8, 9, 10, 14, 16]; // price fields + PnL pts
const PCT_COLS   = [17];                           // PnL %

// ─── Pattern ID parser ────────────────────────────────────────────────────────
// Format: SYMBOL_BULL_<crossoverTs>_<signalTs>  /  SYMBOL_BEAR_<crossoverTs>_<signalTs>

function parsePatternId(patternId) {
  const parts = patternId.split("_");
  return {
    signalTs:    parseInt(parts[parts.length - 1], 10),
    crossoverTs: parseInt(parts[parts.length - 2], 10),
  };
}

// ─── PnL calculation ──────────────────────────────────────────────────────────

/**
 * Calculate PnL for a closed trade.
 * @param {number} entryPrice
 * @param {number} exitPrice
 * @param {boolean} isBullish
 * @returns {{ pnlPoints: number, pnlPct: number }}
 */
function calcPnl(entryPrice, exitPrice, isBullish) {
  const pnlPoints = parseFloat(
    (isBullish ? exitPrice - entryPrice : entryPrice - exitPrice).toFixed(2)
  );
  const pnlPct = parseFloat(((pnlPoints / entryPrice) * 100).toFixed(3));
  return { pnlPoints, pnlPct };
}

// ─── Fyers candle fetch ───────────────────────────────────────────────────────

async function fetchCandles(symbol, fromDate, toDate) {
  const response = await fyers.getHistory({
    symbol,
    resolution:  RESOLUTION,
    date_format: "1",
    range_from:  fromDate.format("YYYY-MM-DD"),
    range_to:    toDate.format("YYYY-MM-DD"),
    cont_flag:   "1",
  });

  if (!response || response.s !== "ok" || !response.candles) {
    throw new Error(`Fyers API error for ${symbol}: ${JSON.stringify(response)}`);
  }

  return response.candles.map(([ts, open, high, low, close, volume]) => ({
    timestampUnix: ts,
    timestamp: moment.unix(ts).format(DT_FMT),
    open, high, low, close, volume,
  }));
}

// ─── Read signals from Excel ──────────────────────────────────────────────────

async function readSignals(inputFile = INPUT_FILE) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inputFile);
  const ws = wb.getWorksheet(SHEET_NAME);

  const signals = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;

    const get = (col) => {
      const v = row.getCell(col).value;
      if (v && typeof v === "object" && v.result !== undefined) return v.result;
      return v;
    };

    const patternId = String(get(1) ?? "").trim();
    if (!patternId) return;

    const { signalTs } = parsePatternId(patternId);

    signals.push({
      patternId,
      symbol:        String(get(2) ?? "").trim(),
      crossoverType: String(get(3) ?? "").trim(), // "BULLISH" or "BEARISH"
      detectedAt:    String(get(10) ?? "").trim(),
      signalTs, // unix ts from Pattern ID — single source of truth for Fyers sync
    });
  });

  return signals;
}

// ─── Backtest one signal ──────────────────────────────────────────────────────

/**
 * 1. Parse signal unix timestamp from Pattern ID
 * 2. Fetch Fyers candles from signal date → today
 * 3. Find signal candle by unix timestamp (sync guaranteed on match)
 * 4. Compute from Fyers data:
 *      SL         = signal candle low
 *      Entry      = next candle open
 *      Target     = entry ± risk  (1:1 RR)
 * 5. Walk forward candles to find first SL or Target hit
 * 6. Calculate PnL for closed trades
 */
async function backtestSignal(signal) {
  const result = {
    patternId:     signal.patternId,
    symbol:        signal.symbol,
    crossoverType: signal.crossoverType,
    signalTime:    null,
    signalHigh:    null,
    signalLow:     null,
    signalClose:   null,
    entryPrice:    null,
    stopLoss:      null,
    target:        null,
    syncOk:        null,
    result:        "OPEN",
    hitTime:       null,
    hitPrice:      null,
    candlesToHit:  null,
    pnlPoints:     null,
    pnlPct:        null,
    notes:         "",
  };

  if (!signal.signalTs || isNaN(signal.signalTs)) {
    result.result = "ERROR";
    result.notes  = "Could not parse signal timestamp from Pattern ID";
    return result;
  }

  const signalMoment = moment.unix(signal.signalTs);
  const fromDate     = signalMoment.clone().subtract(1, "day");
  const toDate       = moment().add(2, "day");

  let candles;
  try {
    candles = await fetchCandles(signal.symbol, fromDate, toDate);
  } catch (err) {
    result.result = "ERROR";
    result.notes  = `Fyers fetch failed: ${err.message}`;
    return result;
  }

  // ── Sync: find signal candle by unix timestamp ────────────────────────────
  const signalIdx = candles.findIndex((c) => c.timestampUnix === signal.signalTs);

  if (signalIdx === -1) {
    result.result = "ERROR";
    result.notes  = `Signal ts=${signal.signalTs} (${signalMoment.format(DT_FMT)} IST) not found in Fyers data`;
    return result;
  }

  const signalCandle = candles[signalIdx];
  const entryCandle  = candles[signalIdx + 1];

  result.syncOk    = "YES";
  result.signalTime  = signalCandle.timestamp;
  result.signalHigh  = signalCandle.high;
  result.signalLow   = signalCandle.low;
  result.signalClose = signalCandle.close;
  result.stopLoss    = signalCandle.low;

  if (!entryCandle) {
    result.result = "OPEN";
    result.notes  = "Entry candle not yet available — trade not entered";
    return result;
  }

  result.entryPrice = entryCandle.open;

  const isBullish = signal.crossoverType === "BULLISH";
  const risk      = Math.abs(entryCandle.open - signalCandle.low);
  result.target   = parseFloat(
    (isBullish ? entryCandle.open + risk : entryCandle.open - risk).toFixed(2)
  );

  // ── Walk forward candles ──────────────────────────────────────────────────
  const forwardCandles = candles.slice(signalIdx + 2);

  if (forwardCandles.length === 0) {
    result.result = "OPEN";
    result.notes  = "No candles after entry yet — trade open";
    return result;
  }

  let candleCount = 0;
  let hit         = null;

  for (const candle of forwardCandles) {
    candleCount++;

    if (isBullish) {
      const tpHit = candle.high >= result.target;
      const slHit = candle.low  <= result.stopLoss;
      if (slHit && tpHit) { hit = { result: "SL HIT",     hitTime: candle.timestamp, hitPrice: result.stopLoss }; break; }
      if (tpHit)           { hit = { result: "TARGET HIT", hitTime: candle.timestamp, hitPrice: result.target   }; break; }
      if (slHit)           { hit = { result: "SL HIT",     hitTime: candle.timestamp, hitPrice: result.stopLoss }; break; }
    } else {
      const tpHit = candle.low  <= result.target;
      const slHit = candle.high >= result.stopLoss;
      if (slHit && tpHit) { hit = { result: "SL HIT",     hitTime: candle.timestamp, hitPrice: result.stopLoss }; break; }
      if (tpHit)           { hit = { result: "TARGET HIT", hitTime: candle.timestamp, hitPrice: result.target   }; break; }
      if (slHit)           { hit = { result: "SL HIT",     hitTime: candle.timestamp, hitPrice: result.stopLoss }; break; }
    }
  }

  if (hit) {
    result.result       = hit.result;
    result.hitTime      = hit.hitTime;
    result.hitPrice     = hit.hitPrice;
    result.candlesToHit = candleCount;

    // ── PnL: only calculated for closed trades ────────────────────────────
    const { pnlPoints, pnlPct } = calcPnl(result.entryPrice, hit.hitPrice, isBullish);
    result.pnlPoints = pnlPoints;
    result.pnlPct    = pnlPct;
  } else {
    result.result = "OPEN";
    result.notes  = `Checked ${forwardCandles.length} candle(s) — neither SL nor Target hit yet`;
    // pnlPoints / pnlPct left null for open trades
  }

  return result;
}

// ─── Write results to Excel ───────────────────────────────────────────────────

async function writeResults(rows, outputFile = OUTPUT_FILE) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Backtest Results", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = RESULT_HEADERS;

  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font      = HEADER_FONT;
    cell.fill      = HEADER_FILL;
    cell.alignment = HEADER_ALIGN;
    cell.border    = CELL_BORDER;
  });
  headerRow.commit();

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: RESULT_HEADERS.length },
  };

  for (const r of rows) {
    const row = ws.addRow({
      patternId:     r.patternId,
      symbol:        r.symbol,
      crossoverType: r.crossoverType,
      signalTime:    r.signalTime,
      signalHigh:    r.signalHigh,
      signalLow:     r.signalLow,
      signalClose:   r.signalClose,
      entryPrice:    r.entryPrice    ?? null,
      stopLoss:      r.stopLoss      ?? null,
      target:        r.target        ?? null,
      syncOk:        r.syncOk,
      result:        r.result,
      hitTime:       r.hitTime,
      hitPrice:      r.hitPrice      ?? null,
      candlesToHit:  r.candlesToHit  ?? null,
      pnlPoints:     r.pnlPoints     ?? null,
      pnlPct:        r.pnlPct        ?? null,
      notes:         r.notes,
    });

    PRICE_COLS.forEach((col) => {
      const cell = row.getCell(col);
      if (cell.value != null) cell.numFmt = PRICE_FMT;
    });

    PCT_COLS.forEach((col) => {
      const cell = row.getCell(col);
      if (cell.value != null) cell.numFmt = PCT_FMT;
    });

    // PnL pts font: green if positive, red if negative
    const pnlCell = row.getCell(16);
    if (pnlCell.value != null) {
      pnlCell.font = {
        name: "Arial", size: 10, bold: true,
        color: { argb: r.pnlPoints >= 0 ? "FF006400" : "FF8B0000" },
      };
    }
    const pctCell = row.getCell(17);
    if (pctCell.value != null) {
      pctCell.font = {
        name: "Arial", size: 10, bold: true,
        color: { argb: r.pnlPct >= 0 ? "FF006400" : "FF8B0000" },
      };
    }

    const fill =
      r.result === "TARGET HIT" ? FILLS.TARGET_HIT :
      r.result === "SL HIT"     ? FILLS.SL_HIT     :
      r.result === "ERROR"      ? FILLS.ERROR       :
                                  FILLS.OPEN;

    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = CELL_BORDER;
      if (!cell.font?.bold) {
        cell.font = { name: "Arial", size: 10 };
      }
      cell.fill = fill;
    });

    row.commit();
  }

  // ── Summary row ───────────────────────────────────────────────────────────
  const closedRows  = rows.filter((r) => r.result === "TARGET HIT" || r.result === "SL HIT");
  const wins        = rows.filter((r) => r.result === "TARGET HIT").length;
  const losses      = rows.filter((r) => r.result === "SL HIT").length;
  const totalPnl    = closedRows.reduce((sum, r) => sum + (r.pnlPoints ?? 0), 0);
  const winRate     = closedRows.length > 0 ? ((wins / closedRows.length) * 100).toFixed(1) : "—";

  ws.addRow({}); // blank spacer

  const summaryRow = ws.addRow({
    patternId:  `SUMMARY — ${wins}W / ${losses}L / ${rows.filter(r => r.result === "OPEN").length} OPEN  |  Win Rate: ${winRate}%`,
    pnlPoints:  parseFloat(totalPnl.toFixed(2)),
    notes:      `Total closed trades: ${closedRows.length} of ${rows.length}`,
  });

  summaryRow.eachCell({ includeEmpty: false }, (cell) => {
    cell.font   = { name: "Arial", bold: true, size: 11 };
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.border = CELL_BORDER;
    cell.font   = {
      name: "Arial", bold: true, size: 11,
      color: { argb: "FFFFFFFF" },
    };
  });

  // Colour the summary PnL cell
  const summaryPnlCell = summaryRow.getCell(16);
  if (summaryPnlCell.value != null) {
    summaryPnlCell.numFmt = PRICE_FMT;
    summaryPnlCell.font   = {
      name: "Arial", bold: true, size: 11,
      color: { argb: totalPnl >= 0 ? "FF90EE90" : "FFFF6B6B" },
    };
  }

  summaryRow.commit();

  await wb.xlsx.writeFile(outputFile);
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Run the full backtest pipeline.
 * @param {object}  [opts]
 * @param {string}  [opts.inputFile]    Override input xlsx path
 * @param {string}  [opts.outputFile]   Override output xlsx path
 * @param {number}  [opts.delayMs=300]  Delay between Fyers API calls (ms)
 * @returns {Promise<object[]>}         Array of result objects
 */
async function runBacktest(opts = {}) {
  const inputFile  = opts.inputFile  ?? INPUT_FILE;
  const outputFile = opts.outputFile ?? OUTPUT_FILE;
  const delayMs    = opts.delayMs    ?? 300;

  console.log("📂 Reading signals from", inputFile);
  const signals = await readSignals(inputFile);
  console.log(`   Found ${signals.length} signal rows`);

  const results = [];

  for (const signal of signals) {
    process.stdout.write(`   Backtesting ${signal.patternId} ... `);
    try {
      const r = await backtestSignal(signal);
      results.push(r);
      const pnlStr = r.pnlPoints != null ? ` | PnL: ${r.pnlPoints > 0 ? "+" : ""}${r.pnlPoints} pts (${r.pnlPct}%)` : "";
      console.log(`${r.result}${r.hitTime ? " @ " + r.hitTime : ""}${pnlStr}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        patternId: signal.patternId, symbol: signal.symbol,
        crossoverType: signal.crossoverType,
        signalTime: null, signalHigh: null, signalLow: null, signalClose: null,
        entryPrice: null, stopLoss: null, target: null,
        syncOk: null, result: "ERROR",
        hitTime: null, hitPrice: null, candlesToHit: null,
        pnlPoints: null, pnlPct: null,
        notes: err.message,
      });
    }

    await new Promise((res) => setTimeout(res, delayMs));
  }

  console.log("\n📊 Writing results to", outputFile);
  await writeResults(results, outputFile);
  console.log("✅ Done!\n");

  const closed   = results.filter((r) => ["TARGET HIT", "SL HIT"].includes(r.result));
  const totalPnl = closed.reduce((s, r) => s + (r.pnlPoints ?? 0), 0);
  const wins     = results.filter((r) => r.result === "TARGET HIT").length;
  const losses   = results.filter((r) => r.result === "SL HIT").length;

  console.log("Summary:");
  console.log(`  TARGET HIT : ${wins}`);
  console.log(`  SL HIT     : ${losses}`);
  console.log(`  OPEN       : ${results.filter(r => r.result === "OPEN").length}`);
  console.log(`  ERROR      : ${results.filter(r => r.result === "ERROR").length}`);
  console.log(`  Win Rate   : ${closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : "—"}%`);
  console.log(`  Total PnL  : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} pts`);

  return results;
}

module.exports = {
  runBacktest,    // full pipeline: read → backtest → write
  readSignals,    // parse xlsx → array of signal objects
  backtestSignal, // backtest a single signal object → result object
  writeResults,   // write result array → xlsx
  fetchCandles,   // fetch raw Fyers candles for symbol + date range
  calcPnl,        // calculate PnL for a single trade
};

