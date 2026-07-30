"use strict";

const fs = require("fs");
const { loadOptionChainWorkbook } = require("./dataLoader");
const { runStrategyForSeries, PARAMS } = require("./strategy");
const { computeTradeResult } = require("./backtestEngine");
const { summarize, printReport, buildFullTradeLog } = require("./report");

function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: node src/index.js <path-to-backtest-xlsx>");
    process.exit(1);
  }

  console.log(`Loading ${xlsxPath} ...`);
  const { symbols } = loadOptionChainWorkbook(xlsxPath, "CE");
  console.log(`${symbols.length} CE strikes found, running strategy on each contract's own chart...`);

  const allTrades = [];
  let symbolsWithSignals = 0;

  for (const sym of symbols) {
    let symbolTradeCount = 0;
    if (sym.bars.length >= 3) {
      const { trades } = runStrategyForSeries(sym.bars, PARAMS);
      for (const { entry, exitInfo } of trades) {
        const trade = computeTradeResult(entry, exitInfo, sym.bars, sym.symbol, sym.strike);
        allTrades.push(trade);
        symbolTradeCount++;
      }
    }
    if (symbolTradeCount > 0) {
      symbolsWithSignals++;
      console.log(`  ${sym.symbol} (strike ${sym.strike}): ${symbolTradeCount} signal(s)`);
    }
  }

  console.log(`\n${symbolsWithSignals}/${symbols.length} strikes produced at least one signal.`);
  console.log("\n" + "=".repeat(70));
  console.log("BACKTEST SUMMARY -- POOLED ACROSS ALL CE STRIKES");
  console.log("=".repeat(70));
  const summary = summarize(allTrades);
  console.log(printReport(summary));

  console.log("\nFull trade log:");
  const fullLog = buildFullTradeLog(allTrades);
  console.table(
    fullLog.map((t) => ({
      symbol: t.symbol,
      strike: t.strike,
      steps: t.steps,
      entryDate: t.entryDate,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      reason: t.exitReason,
      big: t.bigCandleTag ? "Y" : "",
      P1: t.p1,
      P2: t.p2,
      entryPx: t.entryPx,
      exitPx: t.exitPx,
      R: t.rMultiple?.toFixed(2),
    }))
  );

  const csvHeader = "index,symbol,strike,steps,isAtm,entryDate,entryTime,exitDate,exitTime,exitReason,bigCandleTag,p1,p2,entryPx,exitPx,rMultiple";
  const csvRows = fullLog.map((t) =>
    [t.index, t.symbol, t.strike, t.steps, t.isAtm, t.entryDate, t.entryTime, t.exitDate, t.exitTime, t.exitReason, t.bigCandleTag, t.p1, t.p2, t.entryPx, t.exitPx, t.rMultiple].join(",")
  );
  const csvPath = "output_full_trade_log.csv";
  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"));
  console.log(`\nFull trade log (${fullLog.length} rows) with P1/P2/entry/exit written to ${csvPath}`);
}

main();