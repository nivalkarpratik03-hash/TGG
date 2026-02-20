const ExcelJS = require("exceljs");
const moment  = require("moment");
const path    = require("path");
const fs      = require("fs");

const REPORT_FILE = path.resolve("pattern_signals.xlsx");
const SHEET_NAME  = "Signals";

const HEADERS = [
  { header: "Pattern ID",          key: "patternId",       width: 30 },
  { header: "Symbol",              key: "symbol",          width: 14 },
  { header: "Crossover Type",      key: "crossoverType",   width: 20 },
  { header: "Crossover Time",      key: "crossoverTime",   width: 22 },
  { header: "Crossover Price",     key: "crossoverPrice",  width: 18 },
  { header: "Signal Candle Time",  key: "signalTime",      width: 22 },
  { header: "Signal Candle High",  key: "signalHigh",      width: 20 },
  { header: "Signal Candle Low",   key: "signalLow",       width: 20 },
  { header: "Signal Candle Close", key: "signalClose",     width: 22 },
  { header: "Next Candle Open",    key: "nextOpen",        width: 18 },
  { header: "Stop Loss Price",     key: "stopLoss",        width: 18 },
  { header: "Target Price",        key: "targetPrice",     width: 18 },
  { header: "Run Type",            key: "runType",         width: 16 },
  { header: "Detected At",         key: "detectedAt",      width: 22 },
];

const HEADER_FONT  = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
const HEADER_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const HEADER_ALIGN = { horizontal: "center", vertical: "middle" };
const BORDER       = { style: "thin", color: { argb: "FFBFBFBF" } };
const CELL_BORDER  = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const BULL_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
const BEAR_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
const PRICE_FMT    = '"₹"#,##0.00';
const DT_FMT       = "YYYY-MM-DD HH:mm";

// ─── Workbook helpers ────────────────────────────────────────────────────────

async function loadOrCreate() {
  const workbook = new ExcelJS.Workbook();
  const fileExists = fs.existsSync(REPORT_FILE);

  if (fileExists) {
    await workbook.xlsx.readFile(REPORT_FILE);
  }

  let ws = workbook.getWorksheet(SHEET_NAME);

  if (!ws) {
    // Brand new file — create sheet and write styled header row
    ws = workbook.addWorksheet(SHEET_NAME, {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    ws.columns = HEADERS;

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
      to:   { row: 1, column: HEADERS.length },
    };
  } else {
    // Existing sheet — MUST re-apply column key mappings so addRow({ key }) works correctly.
    // Without this, ExcelJS loses the key→column mapping after readFile() and
    // every addRow() call writes all values into column A on the same row.
    ws.columns = HEADERS.map((h, i) => ({
      key:   h.key,
      width: ws.getColumn(i + 1).width || h.width,
    }));
  }

  return { workbook, ws };
}

function patternExists(ws, patternId) {
  let found = false;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (row.getCell(1).value === patternId) found = true;
  });
  return found;
}

function styleDataRow(row, isBullish) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill   = isBullish ? BULL_FILL : BEAR_FILL;
    cell.border = CELL_BORDER;
    cell.font   = { name: "Arial", size: 10 };
  });
}

// ─── Resolve signal candle from updated pattern structure ────────────────────
// Bullish: signal candle = bullishBCVC   (confirmed white candle)
// Bearish: signal candle = redCandle     (confirmed red/orange candle)

function resolveSignalCandle(pattern) {
  if (pattern.crossoverType === "BULLISH_CROSSOVER") {
    const c = pattern.bullishBCVC;
    return { signalTime: c.timestamp, signalHigh: c.high, signalLow: c.low, signalClose: c.close };
  } else {
    const c = pattern.redCandle;
    return { signalTime: c.timestamp, signalHigh: c.high ?? null, signalLow: c.low, signalClose: c.close };
  }
}

// ─── Derive next-candle open from bcvc.formations ───────────────────────────

function resolveNextCandleOpen(pattern, bcvc) {
  const isBullish = pattern.crossoverType === "BULLISH_CROSSOVER";
  const signalTs  = isBullish
    ? pattern.bullishBCVC.timestampUnix
    : pattern.redCandle.timestampUnix;

  const sorted = [...bcvc.formations].sort((a, b) => a.timestampUnix - b.timestampUnix);
  const idx    = sorted.findIndex((f) => f.timestampUnix === signalTs);

  if (idx !== -1 && idx + 1 < sorted.length) {
    return sorted[idx + 1].open ?? null;
  }
  return null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

async function writePatternToExcel(symbol, pattern, isFirstRun, SEND_FIRST_RUN_NOTIFICATIONS, bcvc) {
  // Mirror exact Telegram send condition
  const shouldRecord =
    !isFirstRun || (isFirstRun && SEND_FIRST_RUN_NOTIFICATIONS);

  if (!shouldRecord) return;

  const patternId      = generatePatternId(symbol, pattern);
  const isBullish      = pattern.crossoverType === "BULLISH_CROSSOVER";
  const { signalTime, signalHigh, signalLow, signalClose } = resolveSignalCandle(pattern);
  const nextCandleOpen = resolveNextCandleOpen(pattern, bcvc);

  // Stop Loss = signal candle low
  const stopLoss = signalLow;

  // Target = 1:1 RR from next candle open
  let targetPrice = null;
  if (nextCandleOpen != null) {
    const risk  = Math.abs(nextCandleOpen - stopLoss);
    targetPrice = isBullish ? nextCandleOpen + risk : nextCandleOpen - risk;
    targetPrice = parseFloat(targetPrice.toFixed(2));
  }

  const { workbook, ws } = await loadOrCreate();

  if (patternExists(ws, patternId)) {
    console.log(`📊 Excel: Already recorded — ${patternId}`);
    return;
  }

  const row = ws.addRow({
    patternId,
    symbol,
    crossoverType:  isBullish ? "BULLISH" : "BEARISH",
    crossoverTime:  pattern.summary.crossoverTime,
    crossoverPrice: pattern.summary.crossoverPrice,
    signalTime,
    signalHigh,
    signalLow,
    signalClose,
    detectedAt:     moment().format(DT_FMT),
  });

  // Price columns: crossoverPrice(5), signalHigh(7), signalLow(8),
  //                signalClose(9), nextOpen(10), stopLoss(11), targetPrice(12)
  [5, 7, 8, 9].forEach((col) => {
    const cell = row.getCell(col);
    if (cell.value != null) cell.numFmt = PRICE_FMT;
  });

  styleDataRow(row, isBullish);

  await workbook.xlsx.writeFile(REPORT_FILE);
  console.log(`📊 Excel saved — ${patternId} | SL: ₹${stopLoss} | TP: ₹${targetPrice ?? "N/A"}`);
}

// Local copy so this module is self-contained (matches your main file)
function generatePatternId(symbol, pattern) {
  const crossoverTs = pattern.crossover.timestampUnix;
  if (pattern.crossoverType === "BULLISH_CROSSOVER") {
    return `${symbol}_BULL_${crossoverTs}_${pattern.bullishBCVC.timestampUnix}`;
  } else {
    return `${symbol}_BEAR_${crossoverTs}_${pattern.redCandle.timestampUnix}`;
  }
}

module.exports = { writePatternToExcel };