// MAIN FILE 

const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
require("dotenv").config();
const fs = require("fs");
const moment = require("moment");
const { writePatternToExcel } = require("./src/excelReports");
const UnifiedAnalyzer = require("./utils/func/Unifiedanalyze");
const SRAnalyzer = require("./utils/func/srAnalyzer");
const { analyzeDowTheory, buildDowTheoryTelegramBlock } = require("./utils/func/dowTheory");
// const TelegramBot = require('node-telegram-bot-api');
const EMAManager = require("./utils/func/emaManager");
const BCVCManager = require("./utils/func/bcvcManager");
const bot = require("./utils/func/telegram");
const fyers = require("./utils/func/fyersapi");
const { runBacktest } = require("./src/backtestSignals");
const INPUT_EXCEL = "./NIFTY.xlsx";
const SYMBOL_COLUMN = "symbol";
if (typeof localStorage === "undefined" || localStorage === null) {
  var LocalStorage = require("node-localstorage").LocalStorage;
  localStorage = new LocalStorage("./scratch");
}
/////////////------------ogbot
// const telegramtoken = '8199688040:AAHGqr4cECCMb9kd4qXNM5bKAXXrqj8shQk';
// const telegramchat = "-1003727905299";
/////////////------------pgfbot
// const telegramtoken = "8390227157:AAFYQ2eWFAJdm9P8me9Nk2voYe00Mn33dSU";
// const telegramchat = "8559767849";
// const telegramchat = "8559767849";
/////////////------------pnlbot
// const telegramtoken = "7764791634:AAGGwGa6Sl7jNauuQvgnTXRTVixikBZCb-g";
// const telegramchat = "7781596314";
/////////////------------Lazy bot
// const telegramtoken = "8529663033:AAEBTgtqjKdqg3lG89ZMclD8lPTxN7mp3BI"
const telegramchat = "8559767849"

let patternSchedulerTimeout = null;
let isExecuting = false;
const emaManager = new EMAManager(fyers);
const bcvcManager = new BCVCManager(fyers);
const srAnalyzer = new SRAnalyzer();
 const unifiedAnalyzer = new UnifiedAnalyzer(fyers);
// const unifiedAnalyzer = new UnifiedAnalyzer(fyers, {
//   volumePeriod:           20,
//   volumeProportion:       1.25,
//   bigCandleLookbackPeriod: 7,
//   bigCandleProportion:    1.3,
// });

const SEND_FIRST_RUN_NOTIFICATIONS = true;
// const symbols = ["NSE:TORNTPHARM-EQ"];

const app = express();

const refresh_token =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZDoxIiwiZDoyIiwieDowIiwieDoxIiwieDoyIl0sImF0X2hhc2giOiJnQUFBQUFCcGxVRGFENklHeXBNY1UwVVFJMWhEMXlMT0FrYnhVTE1YV1ZhZHNsLWNiUmJEVy14NzJfb2VoNlFRUHlxVTVsdTdUbUF2WGRObDh3R00yZzJwRHBfbGQxXzhia2VWNlVEY2tKclVqeHhMaGw5TFJncz0iLCJkaXNwbGF5X25hbWUiOiIiLCJvbXMiOiJLMSIsImhzbV9rZXkiOiI0ZDcwNTIwMzlmMmM2NzI3NGViNzBlZTNlZmU4NzU0Y2E3ZDAyMDg1ZTQ1ZDhkY2FlOGRiMzJiOSIsImlzRGRwaUVuYWJsZWQiOiJOIiwiaXNNdGZFbmFibGVkIjoiTiIsImZ5X2lkIjoiWFQwMzYyOSIsImFwcFR5cGUiOjEwMCwiZXhwIjoxNzcyNjcwNjAwLCJpYXQiOjE3NzEzODkxNDYsImlzcyI6ImFwaS5meWVycy5pbiIsIm5iZiI6MTc3MTM4OTE0Niwic3ViIjoicmVmcmVzaF90b2tlbiJ9.P-JdUPGC4hdwVOxo08zd7kVxS6XVyhUV5YwC5XToqOU";
var tempauth;

const raw = localStorage.getItem("token");
tempauth = raw ? JSON.parse(raw) : null;

let data = {
  grant_type: "refresh_token",
  appIdHash: "e86d29ff056bcc78df9cd894f163914c9b2d7581cc0aaf417fe03cbbfbd97db4",
  refresh_token: refresh_token,
  pin: "1234",
};
async function createAccess() {
  try {
    const response = await axios.post(
      "https://api-t1.fyers.in/api/v3/validate-refresh-token",
      data,
    );

    console.log("Success:", response.data.access_token);
    localStorage.setItem("token", JSON.stringify(response.data.access_token));
    const raw = localStorage.getItem("token");

    tempauth = raw ? JSON.parse(raw) : null;
    console.log("Status:", response.status);
    return response.data;
  } catch (error) {
    console.error("Error:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    }
    throw error;
  }
}

const runauth = async () => {
  await createAccess();
  fyers.setAppId(process.env.APP_ID);

  fyers.setRedirectUrl("https://www.google.com/");

  fyers.setAccessToken(tempauth);

  fyers
    .get_profile()
    .then((response) => {
      console.log(response);
    })
    .catch((err) => {
      console.log(err);
    });
};
function loadSymbols(inputExcel, columnName = "symbol") {
  const workbook = XLSX.readFile(inputExcel);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (!data.length) {
    throw new Error("Excel file is empty");
  }

  if (!(columnName in data[0])) {
    throw new Error(`Column '${columnName}' not found in Excel`);
  }

  let cleanSymbols = data
    .map((row) => String(row[columnName]).trim().toUpperCase())
    .filter((s) => s.length > 3)
    .map((s) => (s.endsWith("-EQ") ? s : `${s}-EQ`));

  console.log("✅ Symbols ready for FYERS:", cleanSymbols.slice(0, 10));
  console.log(`✅ Loaded ${cleanSymbols.length} symbols`);

  return cleanSymbols;
}

const getTradingMinutesBetween = (startUnix, endUnix) => {
  const TRADING_START = { hour: 9, minute: 15 };  // adjust to your market open
  const TRADING_END = { hour: 15, minute: 30 };    // adjust to your market close
  const TRADING_MINUTES_PER_DAY =
    (TRADING_END.hour * 60 + TRADING_END.minute) -
    (TRADING_START.hour * 60 + TRADING_START.minute);

  let start = moment.unix(startUnix);
  let end = moment.unix(endUnix);

  let totalMinutes = 0;
  let current = start.clone();

  while (current.isBefore(end)) {
    const next = moment.min(
      current.clone().endOf("day"),
      end
    );

    // Check if current day is a trading day (skip weekends)
    const dayOfWeek = current.day();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const tradingStart = current.clone().startOf("day")
        .hour(TRADING_START.hour).minute(TRADING_START.minute).second(0);
      const tradingEnd = current.clone().startOf("day")
        .hour(TRADING_END.hour).minute(TRADING_END.minute).second(0);

      const effectiveStart = moment.max(current, tradingStart);
      const effectiveEnd = moment.min(next, tradingEnd);

      if (effectiveEnd.isAfter(effectiveStart)) {
        totalMinutes += effectiveEnd.diff(effectiveStart, "minutes");
      }
    }

    current = current.clone().startOf("day").add(1, "day")
      .hour(TRADING_START.hour).minute(TRADING_START.minute).second(0);
  }

  return totalMinutes;
};

const getSRBeforeSignal = (rawCandles, signalCandleTs, signalCandleClose) => {
  if (!rawCandles || rawCandles.length === 0) return null;
  if (!srAnalyzer) {                              // ← guard
    console.error("srAnalyzer not initialized");
    return null;
  }

  const candlesBeforeSignal = rawCandles.filter((c) => c[0] < signalCandleTs);

  if (candlesBeforeSignal.length < 20) {
    console.log("⚠️ Not enough pre-signal candles for SR analysis");
    return null;
  }

  try {                                           // ← wrap in try/catch
    return srAnalyzer.analyze(candlesBeforeSignal, signalCandleClose);
  } catch (err) {
    console.error("SR analysis failed:", err.message);
    return null;
  }
};
const analyzePattern = (emadata, bcvc) => {
  if (!emadata.crossover || emadata.crossover.length === 0) {
    return { found: false, reason: "No crossovers found" };
  }
  const isToday = (timestampUnix) => {
    const candleDate = moment.unix(timestampUnix).format("YYYY-MM-DD");
    const today = moment().format("YYYY-MM-DD");
    return candleDate === today;
  };
  const latestCrossover = emadata.crossover[0];
  const crossoverTimestamp = latestCrossover.timestampUnix;

  const formationsAfterCrossover = bcvc.formations
    .filter((formation) => formation.timestampUnix > crossoverTimestamp)
    .sort((a, b) => a.timestampUnix - b.timestampUnix);

  if (formationsAfterCrossover.length === 0) {
    return {
      found: false,
      reason: "No BCVC formations found after the crossover",
    };
  }

  if (latestCrossover.type === "BULLISH_CROSSOVER") {
    // Accept orange AND maroon as bearish reference candles
    const bearishFormations = formationsAfterCrossover.filter(
      (f) => f.candleColor === "orange" || f.candleColor === "maroon",
    );

    if (bearishFormations.length === 0) {
      return {
        found: false,
        reason:
          "No BEARISH BCVC (orange/maroon) found after the bullish crossover",
      };
    }

    // Use the bearish candle with the highest high as reference
    const lastBearishBCVC = bearishFormations.reduce((prev, curr) =>
      curr.high > prev.high ? curr : prev,
    );
    const bearishHigh = lastBearishBCVC.high;

    const formationsAfterLastBearish = formationsAfterCrossover.filter(
      (f) => f.timestampUnix > lastBearishBCVC.timestampUnix,
    );

    if (formationsAfterLastBearish.length === 0) {
      return {
        found: false,
        reason: `No BCVC found after the last BEARISH BCVC (${lastBearishBCVC.candleColor})`,
      };
    }

    const confirmingBullish = formationsAfterLastBearish.find(
      (f) => f.isBullish && f.candleColor === "white" && f.close > bearishHigh,
    );

    if (!confirmingBullish) {
      return {
        found: false,
        reason: `No BULLISH BCVC closed above last BEARISH BCVC high (${bearishHigh}) [ref: ${lastBearishBCVC.candleColor}]`,
      };
    }

    const elapsedMinutes = getTradingMinutesBetween(crossoverTimestamp, confirmingBullish.timestampUnix);
    const candlesBetween = elapsedMinutes <= 150 ? 10 : Math.ceil(elapsedMinutes / 15);

    if (!isToday(confirmingBullish.timestampUnix)) {
      return {
        found: false,
        reason: `Bullish signal candle is not from today (found: ${moment.unix(confirmingBullish.timestampUnix).format("YYYY-MM-DD")})`,
      };
    }

    return {
      found: true,
      crossoverType: "BULLISH_CROSSOVER",
      crossover: latestCrossover,
      bearishBCVCs: bearishFormations,
      lastBearishBCVC: lastBearishBCVC,
      bullishBCVC: confirmingBullish,
      candlesBetween,
      validation: {
        totalBearishBCVCs: bearishFormations.length,
        bearishCandleColor: lastBearishBCVC.candleColor,
        bearishHigh: bearishHigh,
        bullishClose: confirmingBullish.close,
        bullishHigh: confirmingBullish.high,
        closedAboveBearishHigh: true,
        candlesBetween,
      },
      summary: {
        crossoverTime: latestCrossover.timestamp,
        lastBearishTime: lastBearishBCVC.timestamp,
        bullishTime: confirmingBullish.timestamp,
        crossoverPrice: latestCrossover.price,
        bearishHigh: bearishHigh,
        bearishClose: lastBearishBCVC.close,
        bullishClose: confirmingBullish.close,
        bullishHigh: confirmingBullish.high,
        candlesBetween,
      },
    };
  } else if (latestCrossover.type === "BEARISH_CROSSOVER") {
    const bullishFormations = formationsAfterCrossover.filter(
      (f) => f.isBullish && f.candleColor === "white",
    );

    if (bullishFormations.length === 0) {
      return {
        found: false,
        reason: "No WHITE (BULLISH) BCVC found after the bearish crossover",
      };
    }

    const lastWhiteBCVC = bullishFormations.reduce((prev, curr) =>
      curr.low < prev.low ? curr : prev,
    );
    const whiteLow = lastWhiteBCVC.low;

    const formationsAfterLastWhite = formationsAfterCrossover.filter(
      (f) => f.timestampUnix > lastWhiteBCVC.timestampUnix,
    );

    if (formationsAfterLastWhite.length === 0) {
      return {
        found: false,
        reason: "No candles found after the last WHITE BCVC",
      };
    }

    const bearishCandlesAfterWhite = formationsAfterLastWhite.filter(
      (f) => f.candleColor === "red" || f.candleColor === "orange" || f.candleColor === "maroon",
    );

    if (bearishCandlesAfterWhite.length === 0) {
      return {
        found: false,
        reason: "No RED/ORANGE/maroon candles found after the last WHITE BCVC",
      };
    }

    const confirmingBearish = bearishCandlesAfterWhite.find(
      (f) => f.close < whiteLow,
    );

    if (!confirmingBearish) {
      return {
        found: false,
        reason: `No RED/ORANGE candle closed below last WHITE BCVC low (${whiteLow})`,
      };
    }

    const elapsedMinutes = getTradingMinutesBetween(crossoverTimestamp, confirmingBearish.timestampUnix);
    const candlesBetween = elapsedMinutes <= 150 ? 10 : Math.ceil(elapsedMinutes / 15);
    if (!isToday(confirmingBearish.timestampUnix)) {
      return {
        found: false,
        reason: `Bearish signal candle is not from today (found: ${moment.unix(confirmingBearish.timestampUnix).format("YYYY-MM-DD")})`,
      };
    }

    return {
      found: true,
      crossoverType: "BEARISH_CROSSOVER",
      crossover: latestCrossover,
      bullishBCVCs: bullishFormations,
      lastWhiteBCVC: lastWhiteBCVC,
      redCandle: confirmingBearish,
      candlesBetween,
      validation: {
        totalBullishBCVCs: bullishFormations.length,
        whiteLow: whiteLow,
        whiteClose: lastWhiteBCVC.close,
        redClose: confirmingBearish.close,
        redLow: confirmingBearish.low,
        closedBelowWhiteLow: true,
        candlesBetween,
      },
      summary: {
        crossoverTime: latestCrossover.timestamp,
        lastWhiteTime: lastWhiteBCVC.timestamp,
        redTime: confirmingBearish.timestamp,
        crossoverPrice: latestCrossover.price,
        whiteLow: whiteLow,
        whiteClose: lastWhiteBCVC.close,
        redClose: confirmingBearish.close,
        redLow: confirmingBearish.low,
        candlesBetween,
      },
    };
  }

  return {
    found: false,
    reason: `Unknown crossover type: ${latestCrossover.type}`,
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getTradingViewLink = (symbol) => {
  // Strip NSE: prefix and -EQ suffix → e.g. "NSE:BAJAJFINSV-EQ" → "BAJAJFINSV"
  const clean = symbol
    .replace(/^NSE:/i, "")
    .replace(/-EQ$/i, "");
  // 15-min chart on NSE
  return `https://www.tradingview.com/chart/?symbol=NSE%3A${clean}&interval=15`;
};

const getTrailingTradingDays = (tradingDaysCount) => {
  const now = moment();
  let calendarDaysBack = 0;
  let tradingDaysFound = 0;

  while (tradingDaysFound < tradingDaysCount) {
    calendarDaysBack++;
    const checkDate = moment().subtract(calendarDaysBack, "days");
    const dayOfWeek = checkDate.day();

    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      tradingDaysFound++;
    }
  }

  // ✅ FIX: Set lookback to 9:15 AM of that trading day, not current time
  const lookbackDate = moment()
    .subtract(calendarDaysBack, "days")
    .hour(9)
    .minute(15)
    .second(0)
    .millisecond(0);

  console.log(`📊 Trading Days Calculation:`);
  console.log(`  Requested: ${tradingDaysCount} trading days`);
  console.log(`  Requires: ${calendarDaysBack} calendar days to look back`);
  console.log(`  Lookback Date: ${lookbackDate.format("YYYY-MM-DD HH:mm:ss")}`);
  console.log(`  Today is: ${now.format("dddd, YYYY-MM-DD")}`);

  return { lookbackDate, calendarDaysBack, tradingDaysCount };
};

const generatePatternId = (symbol, pattern) => {
  const crossoverTime = pattern.crossover.timestampUnix;

  if (pattern.crossoverType === "BULLISH_CROSSOVER") {
    const signalTime = pattern.bullishBCVC.timestampUnix;
    return `${symbol}_BULL_${crossoverTime}_${signalTime}`;
  } else {
    const signalTime = pattern.redCandle.timestampUnix;
    return `${symbol}_BEAR_${crossoverTime}_${signalTime}`;
  }
};

// 🎯 OPTIMIZED FOR INTRADAY: Track only within current session
// Since you run fresh daily, we only need to prevent duplicate notifications
// for SAME crossover within the trading day (not across days)

// const startlogic = async (isFirstRun = false) => {
//   try {
//     const symbols = loadSymbols(INPUT_EXCEL, SYMBOL_COLUMN);
//     console.log(symbols);

//     const now = moment();
//     const today = now.format("YYYY-MM-DD");

//     const TRADING_DAYS_LOOKBACK = 1;
//     const { lookbackDate, calendarDaysBack, tradingDaysCount } =
//       getTrailingTradingDays(TRADING_DAYS_LOOKBACK);

//     const BCVC_LOOKBACK_DAYS = calendarDaysBack + 2;

//     // For daily runs, we process ALL symbols that have recent crossovers
//     // No need for "targeted scan" since it's fresh every morning
//     const symbolsToProcess = symbols.slice(0, Math.min(208, symbols.length));

//     let patternsFound = 0;
//     let newPatternsFound = 0;
//     let crossoversChecked = 0;
//     let recentCrossovers = 0;
//     let skippedSymbols = 0;
//     let differentCrossoversDetected = 0; // Count of symbols with multiple crossovers today
//     ``
//     const BATCH_SIZE = 25;
//     const WAIT_TIME = 5000;

//     console.log(`\n🕐 Current Time: ${now.format("YYYY-MM-DD HH:mm:ss")}`);
//     console.log(
//       `🔄 Run Type: ${isFirstRun ? "INITIAL RUN (no notifications)" : "SCHEDULED RUN (notifications enabled)"}`,
//     );
//     console.log(`🎯 Processing ALL symbols with recent crossovers`);
//     console.log(
//       `📅 Checking for crossovers since: ${lookbackDate.format("YYYY-MM-DD HH:mm:ss")} (${tradingDaysCount} trading days)`,
//     );
//     console.log(
//       `📊 BCVC fetch period: ${BCVC_LOOKBACK_DAYS} days (${calendarDaysBack} lookback + 2 buffer)`,
//     );
//     console.log(
//       `⚙️  Rate Limiting: Processing ${BATCH_SIZE} symbols, then waiting ${WAIT_TIME / 1000} seconds`,
//     );
//     console.log(`📝 Patterns already notified today: ${sentPatterns.size}`);
//     console.log("=".repeat(60));

//     for (let i = 0; i < symbolsToProcess.length; i++) {
//       const symbol = symbolsToProcess[i];
//       console.log(
//         `\n--- Processing Symbol ${i + 1}/${symbolsToProcess.length}: ${symbol} ---`,
//       );

//       try {
//         const emadata = await emaManager.generateEMAReport(symbol);

//         if (!emadata.crossover || emadata.crossover.length === 0) {
//           console.log(`⏭️  Skipping ${symbol}: No crossovers found`);
//           continue;
//         }

//         crossoversChecked++;
//         const latestCrossover = emadata.crossover[0];
//         const crossoverTime = moment.unix(latestCrossover.timestampUnix);

//         if (crossoverTime.isBefore(lookbackDate)) {
//           const daysAgo = now.diff(crossoverTime, "days");
//           const hoursAgo = now.diff(crossoverTime, "hours");
//           console.log(
//             `⏭️  Skipping ${symbol}: Latest crossover is ${daysAgo} calendar days (${hoursAgo} hours) old`,
//           );
//           console.log(
//             `   Crossover: ${latestCrossover.type} at ${crossoverTime.format("YYYY-MM-DD HH:mm")} (${crossoverTime.format("dddd")})`,
//           );
//           continue;
//         }

//         // 🔥 CRITICAL FIX: Check if this is a DIFFERENT crossover than what we've seen today
//         const cachedCrossover = symbolCrossoverCache.get(symbol);
//         const currentCrossoverKey = `${latestCrossover.type}_${latestCrossover.timestampUnix}`;

//         let isNewOrDifferentCrossover = false;

//         if (!cachedCrossover) {
//           // First time seeing this symbol's crossover today
//           isNewOrDifferentCrossover = true;
//           symbolCrossoverCache.set(symbol, {
//             crossoverTimestamp: latestCrossover.timestampUnix,
//             crossoverType: latestCrossover.type,
//             key: currentCrossoverKey,
//           });
//           console.log(
//             `✓ New crossover detected for ${symbol}: ${latestCrossover.type}`,
//           );
//         } else if (cachedCrossover.key !== currentCrossoverKey) {
//           // 🎯 DIFFERENT crossover detected (direction changed or new timestamp)
//           // This is the KEY scenario: bullish -> bearish or bearish -> bullish
//           isNewOrDifferentCrossover = true;
//           differentCrossoversDetected++;
//           console.log(`🔄 ⚡ DIFFERENT CROSSOVER DETECTED for ${symbol}!`);
//           console.log(
//             `   Previous: ${cachedCrossover.crossoverType} @ ${moment.unix(cachedCrossover.crossoverTimestamp).format("HH:mm")}`,
//           );
//           console.log(
//             `   Current: ${latestCrossover.type} @ ${crossoverTime.format("HH:mm")}`,
//           );
//           console.log(`   👉 This is a REVERSAL - will check for new pattern`);

//           // Update cache with new crossover
//           symbolCrossoverCache.set(symbol, {
//             crossoverTimestamp: latestCrossover.timestampUnix,
//             crossoverType: latestCrossover.type,
//             key: currentCrossoverKey,
//           });
//         }

//         // 🔥 SMART SKIP LOGIC: Only skip if SAME crossover already has pattern sent
//         if (!isNewOrDifferentCrossover && !isFirstRun) {
//           // Generate the specific pattern ID for THIS crossover
//           const crossoverTypePrefix = latestCrossover.type.includes("BULLISH")
//             ? "BULL"
//             : "BEAR";
//           const potentialPatternPrefix = `${symbol}_${crossoverTypePrefix}_${latestCrossover.timestampUnix}`;

//           // Check if this EXACT crossover already has a pattern sent
//           const alreadySentThisPattern = Array.from(sentPatterns).some(
//             (patternId) => patternId.startsWith(potentialPatternPrefix),
//           );

//           if (alreadySentThisPattern) {
//             skippedSymbols++;
//             console.log(
//               `⏭️  Skipping ${symbol}: Pattern already sent for this crossover`,
//             );
//             const matchingPattern = Array.from(sentPatterns).find((id) =>
//               id.startsWith(potentialPatternPrefix),
//             );
//             console.log(`   Pattern ID: ${matchingPattern}`);
//             continue;
//           } else {
//             console.log(
//               `✓ Processing ${symbol}: Same crossover but pattern not sent yet (still forming)`,
//             );
//           }
//         }

//         recentCrossovers++;
//         const daysAgo = now.diff(crossoverTime, "days");
//         const hoursAgo = now.diff(crossoverTime, "hours");
//         const minutesAgo = now.diff(crossoverTime, "minutes");

//         console.log(`✓ Recent crossover found:`);
//         console.log(`  Type: ${latestCrossover.type}`);
//         console.log(
//           `  Time: ${crossoverTime.format("YYYY-MM-DD HH:mm:ss")} (${crossoverTime.format("dddd")})`,
//         );
//         console.log(
//           `  Age: ${daysAgo} calendar days, ${hoursAgo % 24} hours, ${minutesAgo % 60} minutes ago`,
//         );
//         console.log(`  Relative: ${crossoverTime.fromNow()}`);

//         console.log(
//           `📊 Fetching BCVC data for ${symbol} (${BCVC_LOOKBACK_DAYS} days)...`,
//         );
//         let bcvc;

//         if (latestCrossover.type === "BEARISH_CROSSOVER") {
//           console.log(
//             `  🔻 Bearish crossover detected - including RED candles`,
//           );
//           bcvc = await bcvcManager.getHistoricalBCVC(
//             symbol,
//             "15",
//             BCVC_LOOKBACK_DAYS,
//             "red",
//           );
//         } else {
//           console.log(
//             `  🚀 Bullish crossover detected - BCVC with white, orange & maroon`,
//           );
//           bcvc = await bcvcManager.getHistoricalBCVC(
//             symbol,
//             "15",
//             BCVC_LOOKBACK_DAYS,
//           );
//           // No special flag needed — maroon is now always detected in analyzeBCVC
//         }

//         const pattern = analyzePattern(emadata, bcvc);
//         if (pattern.found) {
//           patternsFound++;

//           const patternId = generatePatternId(symbol, pattern);
//           const isNewPattern = !sentPatterns.has(patternId);

//           console.log(`✅ PATTERN FOUND for ${symbol}!`);
//           console.log(`📊 Crossover Type: ${pattern.crossoverType}`);
//           console.log(`🆔 Pattern ID: ${patternId}`);
//           console.log(
//             `🔔 Status: ${isNewPattern ? "NEW - Will send notification" : "ALREADY SENT - Skipping notification"}`,
//           );

//           const formattedSummary = {
//             ...pattern.summary,
//             crossoverTime: moment
//               .unix(pattern.crossover.timestampUnix)
//               .format("YYYY-MM-DD HH:mm"),
//             crossoverAge: moment
//               .unix(pattern.crossover.timestampUnix)
//               .fromNow(),
//           };

//           console.log(`📊 Summary:`, JSON.stringify(formattedSummary, null, 2));
//           console.log(
//             `✓ Validation:`,
//             JSON.stringify(pattern.validation, null, 2),
//           );
//           var telegramMessage = "";

//           if (pattern.crossoverType === "BULLISH_CROSSOVER") {
//             console.log(
//               `🚀 Bullish Crossover: ${pattern.crossover.timestamp} @ ${pattern.crossover.price}`,
//             );
//             console.log(
//               `🔴 Bearish BCVCs found: ${pattern.validation.totalBearishBCVCs} (${pattern.validation.bearishCandleColor.toUpperCase()})`,
//             );
//             console.log(
//               `🔴 Last Bearish BCVC: ${pattern.lastBearishBCVC.timestamp} (High: ${pattern.lastBearishBCVC.high})`,
//             );
//             console.log(
//               `🚀 Bullish BCVC: ${pattern.bullishBCVC.timestamp} (Close: ${pattern.bullishBCVC.close}) - CLOSED ABOVE BEARISH HIGH ✓`,
//             );
//             const tvLink = getTradingViewLink(symbol);
//             const bullEntryPrice = pattern.bullishBCVC.close; // next candle open ≈ signal close
//             const bullSL = pattern.bullishBCVC.low;
//             const bullRisk = +(bullEntryPrice - bullSL).toFixed(2);
//             const bullTarget = +(bullEntryPrice + bullRisk).toFixed(2);
//             telegramMessage = `
// 🟢 <b>BULLISH PATTERN FOUND</b> ${symbol} 
// ━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 <b>Chart :</b> <a href="${tvLink}"> ${symbol} (15min)</a>
// 📈 Candle Span ${pattern.candlesBetween} /10

// 📥 Entry : ₹${bullEntryPrice} (next candle open)
// 🛑 Stop Loss : ₹${bullSL} (signal candle low)
// 🎯 Target : ₹${bullTarget} (1:1 RR)
// 📉 Risk : ₹${bullRisk} pts

// 🔄 <b>Bullish Crossover :</b> ${pattern.crossover.timestamp}  ${formattedSummary.crossoverAge}

// 🔴 <b>Bearish BCVCs (${pattern.validation.totalBearishBCVCs} found) :</b> ${pattern.lastBearishBCVC.timestamp} ${pattern.validation.bearishCandleColor.toUpperCase()} candle
  
// 🚀 <b>Bullish BCVC (Entry Signal) :</b> ${pattern.bullishBCVC.timestamp} White Candle

// ⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
// `.trim();
//           } else if (pattern.crossoverType === "BEARISH_CROSSOVER") {
//             // ✅ Updated console logs
//             console.log(
//               `🔴 Bearish Crossover: ${pattern.crossover.timestamp} @ ${pattern.crossover.price}`,
//             );
//             console.log(
//               `⚪ White BCVCs found: ${pattern.validation.totalBullishBCVCs}`,
//             );
//             console.log(
//               `⚪ Last White BCVC: ${pattern.lastWhiteBCVC.timestamp} (Low: ${pattern.lastWhiteBCVC.low})`,
//             );
//             console.log(
//               `🔻 Bearish Candle: ${pattern.redCandle.timestamp} (Close: ${pattern.redCandle.close}) - CLOSED BELOW WHITE LOW ✓`,
//             );
//             // ✅ Updated Telegram message
//             const tvLink = getTradingViewLink(symbol);
//             const bearEntryPrice = pattern.redCandle.close; // next candle open ≈ signal close
//             const bearSL = pattern.redCandle.high;
//             const bearRisk = +(bearSL - bearEntryPrice).toFixed(2);
//             const bearTarget = +(bearEntryPrice - bearRisk).toFixed(2);
//             telegramMessage = `
// 🔴 <b>BEARISH PATTERN FOUND</b> ${symbol}
// ━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 <b>Chart :</b> <a href="${tvLink}">${symbol} (15min)</a>
// 📉 Candle Span :${pattern.candlesBetween} /10

// 📥 Entry : ₹${bearEntryPrice} (next candle open)
// 🛑 Stop Loss : ₹${bearSL} (signal candle high)
// 🎯 Target : ₹${bearTarget} (1:1 RR)
// 📈 Risk : ₹${bearRisk} pts

// 🔄 <b>Bearish Crossover:</b> ${pattern.crossover.timestamp}  ${formattedSummary.crossoverAge}

// ⚪ <b>Bullish BCVCs (${pattern.validation.totalBullishBCVCs} found) :</b> ${pattern.lastWhiteBCVC.timestamp}

// 🔻 <b>Bearish Candle (Entry Signal) :</b> ${pattern.redCandle.timestamp}

// ⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
// `.trim();
//           }
//           const sendAndRecord = async () => {
//             // 1) Telegram
//             await bot.sendMessage(telegramchat, telegramMessage, {
//               parse_mode: "HTML",
//             });
//             console.log(`✅ Telegram notification sent for ${symbol}`);

//             // 2) Excel  (bcvc already in scope from the outer for-loop)
//             await writePatternToExcel(
//               symbol,
//               pattern,
//               isFirstRun,
//               SEND_FIRST_RUN_NOTIFICATIONS,
//               bcvc,
//             );

//             // 3) Mark as sent in memory
//             sentPatterns.add(patternId);
//             console.log(`📝 Pattern tracked: ${patternId}`);
//           };
//           // ✅ NOW guard sending on isFirstRun / isNewPattern — message is always ready
//           if (!isFirstRun && isNewPattern) {
//             newPatternsFound++;
//             try {
//               await bot.sendMessage(telegramchat, telegramMessage, {
//                 parse_mode: "HTML",
//               });
//               await writePatternToExcel(
//                 symbol,
//                 pattern,
//                 isFirstRun,
//                 SEND_FIRST_RUN_NOTIFICATIONS,
//                 bcvc,
//               );
//               console.log(`✅ Telegram notification sent for ${symbol}`);
//               sentPatterns.add(patternId);
//               console.log(`📝 Pattern tracked: ${patternId}`);
//             } catch (telegramError) {
//               console.error(
//                 `❌ Failed to send Telegram message:`,
//                 telegramError.message,
//               );
//             }
//           } else {
//             if (isFirstRun) {
//               if (SEND_FIRST_RUN_NOTIFICATIONS) {
//                 // First run WITH notifications enabled — send + save
//                 console.log(
//                   `🔔 First run with notifications ENABLED - sending alert`,
//                 );
//                 try {
//                   await sendAndRecord();
//                 } catch (err) {
//                   console.error(
//                     `❌ Failed to send/save for ${symbol}:`,
//                     err.message,
//                   );
//                 }
//               } else {
//                 // First run WITHOUT notifications — save to Excel only, no Telegram
//                 console.log(
//                   `🔕 First run - storing pattern without Telegram notification`,
//                 );
//                 try {
//                   await writePatternToExcel(
//                     symbol,
//                     pattern,
//                     isFirstRun,
//                     SEND_FIRST_RUN_NOTIFICATIONS,
//                     bcvc,
//                   );
//                   sentPatterns.add(patternId);
//                   console.log(`📝 Pattern tracked (Excel only): ${patternId}`);
//                 } catch (err) {
//                   console.error(
//                     `❌ Failed to save to Excel for ${symbol}:`,
//                     err.message,
//                   );
//                 }
//               }
//             } else {
//               console.log(`⏭️  Pattern already sent previously - skipping`);
//             }
//           }
//         } else {
//           console.log(`❌ Pattern not found for ${symbol}: ${pattern.reason}`);
//           console.log(
//             `   Will check again in next run if crossover still recent`,
//           );
//         }
//       } catch (error) {
//         console.error(`Error processing ${symbol}:`, error.message);
//       }

//       if ((i + 1) % BATCH_SIZE === 0 && i + 1 < symbolsToProcess.length) {
//         const waitUntil = moment().add(WAIT_TIME / 1000, "seconds");
//         console.log("\n" + "⏸️ ".repeat(30));
//         console.log(`⏸️  RATE LIMIT: Processed ${i + 1} symbols`);
//         console.log(`⏸️  Waiting ${WAIT_TIME / 1000} seconds to avoid API limits...`);
//         console.log(`⏸️  Will resume at: ${waitUntil.format("HH:mm:ss")}`);
//         console.log("⏸️ ".repeat(30) + "\n");

//         await delay(WAIT_TIME);

//         console.log(`✅ Resuming processing...`);
//       }
//     }

//     // Summary statistics
//     console.log("\n" + "=".repeat(60));
//     console.log("📊 SUMMARY STATISTICS");
//     console.log("=".repeat(60));
//     console.log(`Scan completed at: ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
//     console.log(`Total symbols in list: ${symbols.length}`);
//     console.log(`Symbols processed this run: ${symbolsToProcess.length}`);
//     console.log(`Symbols skipped (already sent): ${skippedSymbols}`);
//     console.log(
//       `🔄 Symbols with DIFFERENT crossovers today: ${differentCrossoversDetected} ⚡`,
//     );
//     console.log(`Symbols with crossovers: ${crossoversChecked}`);
//     console.log(
//       `Recent crossovers (within ${tradingDaysCount} trading days): ${recentCrossovers}`,
//     );
//     console.log(`Total patterns found: ${patternsFound}`);
//     console.log(`New patterns (not previously notified): ${newPatternsFound}`);
//     console.log(
//       `Telegram notifications sent: ${isFirstRun && !SEND_FIRST_RUN_NOTIFICATIONS ? 0 : newPatternsFound}`,
//     );
//     console.log(`Total patterns tracked today: ${sentPatterns.size}`);
//     console.log(
//       `Success rate: ${recentCrossovers > 0 ? ((patternsFound / recentCrossovers) * 100).toFixed(2) : 0}%`,
//     );
//     console.log("=".repeat(60));
//   } catch (error) {
//     console.log(error);
//   }
// };
let sentPatterns = new Set(); // Patterns already notified today
let symbolCrossoverCache = new Map(); // Symbol -> {crossoverTimestamp, crossoverType} for intraday tracking

const startlogic = async (isFirstRun = false) => {
  try {
    const symbols = loadSymbols(INPUT_EXCEL, SYMBOL_COLUMN);

    const now = moment();

    const TRADING_DAYS_LOOKBACK = 1;
    const { lookbackDate, calendarDaysBack, tradingDaysCount } =
      getTrailingTradingDays(TRADING_DAYS_LOOKBACK);

    const symbolsToProcess = symbols.slice(0, Math.min(208, symbols.length));

    let patternsFound           = 0;
    let newPatternsFound        = 0;
    let crossoversChecked       = 0;
    let recentCrossovers        = 0;
    let skippedSymbols          = 0;
    let differentCrossoversDetected = 0;

    // Rate-limit: one symbol every 400 ms = ~2.5 starts/sec.
    // Sequential (concurrency=1) is safest; raise if your plan allows more.
    const MIN_DELAY_MS = 400;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`${now.format("YYYY-MM-DD HH:mm:ss")} | ${isFirstRun ? "INITIAL RUN" : "SCHEDULED RUN"}`);
    console.log(`Crossover lookback : ${lookbackDate.format("YYYY-MM-DD HH:mm:ss")}`);
    console.log(`Symbols to process : ${symbolsToProcess.length}`);
    console.log(`Delay between calls: ${MIN_DELAY_MS}ms`);
    console.log("=".repeat(60));

    for (let i = 0; i < symbolsToProcess.length; i++) {
      const symbol = symbolsToProcess[i];
      console.log(`\n--- [${i + 1}/${symbolsToProcess.length}] ${symbol} ---`);

      // ── EARLY EXIT — skip if we already sent for this crossover ──────
      const maybeCached = symbolCrossoverCache.get(symbol);
      if (maybeCached && !isFirstRun) {
        const short  = maybeCached.crossoverType === "BULLISH_CROSSOVER" ? "BULL" : "BEAR";
        const prefix = `${symbol}_${short}_${maybeCached.crossoverTimestamp}`;
        if (Array.from(sentPatterns).some((id) => id.startsWith(prefix))) {
          skippedSymbols++;
          console.log(`  skip: already sent`);
          // Still apply inter-request delay to stay under rate limit
          await _sleep(MIN_DELAY_MS);
          continue;
        }
      }

      // ── SINGLE API CALL — fetch candles + compute EMA + BCVC ─────────
      let result;
      try {
        result = await unifiedAnalyzer.analyze(symbol);
      } catch (err) {
        console.error(`  ERROR analyze: ${err.message}`);
        await _sleep(MIN_DELAY_MS);
        continue;
      }

      await _sleep(MIN_DELAY_MS); // always delay after API call

      if (!result) {
        console.log(`  skip: analyze returned null`);
        continue;
      }

      const { emadata, bcvc } = result;

      // ── CROSSOVER CHECK ───────────────────────────────────────────────
      if (!emadata.crossover || emadata.crossover.length === 0) {
        console.log(`  skip: no crossovers`);
        continue;
      }

      crossoversChecked++;
      const latestCrossover = emadata.crossover[0];
      const crossoverTime   = moment.unix(latestCrossover.timestampUnix);

      if (crossoverTime.isBefore(lookbackDate)) {
        console.log(`  skip: crossover too old (${crossoverTime.fromNow()})`);
        continue;
      }

      // ── DIRECTION-CHANGE DETECTION ────────────────────────────────────
      const currentKey      = `${latestCrossover.type}_${latestCrossover.timestampUnix}`;
      const cachedCrossover = symbolCrossoverCache.get(symbol);
      let isNewOrDifferentCrossover = false;

      if (!cachedCrossover) {
        isNewOrDifferentCrossover = true;
        symbolCrossoverCache.set(symbol, {
          crossoverTimestamp: latestCrossover.timestampUnix,
          crossoverType:      latestCrossover.type,
          key:                currentKey,
        });
        console.log(`  new crossover: ${latestCrossover.type}`);

      } else if (cachedCrossover.key !== currentKey) {
        isNewOrDifferentCrossover = true;
        differentCrossoversDetected++;
        console.log(`  reversal: ${cachedCrossover.crossoverType} → ${latestCrossover.type}`);
        symbolCrossoverCache.set(symbol, {
          crossoverTimestamp: latestCrossover.timestampUnix,
          crossoverType:      latestCrossover.type,
          key:                currentKey,
        });
      }

      // Re-check skip with confirmed crossover key
      if (!isNewOrDifferentCrossover && !isFirstRun) {
        const short      = latestCrossover.type.includes("BULLISH") ? "BULL" : "BEAR";
        const patternPfx = `${symbol}_${short}_${latestCrossover.timestampUnix}`;
        if (Array.from(sentPatterns).some((id) => id.startsWith(patternPfx))) {
          skippedSymbols++;
          console.log(`  skip: already sent`);
          continue;
        }
      }

      recentCrossovers++;
      console.log(`  crossover: ${latestCrossover.type} @ ${crossoverTime.format("HH:mm")} (${crossoverTime.fromNow()})`);

      // ── PATTERN ANALYSIS — uses same analyzePattern() as before ───────
      const pattern = analyzePattern(emadata, bcvc);

      if (!pattern.found) {
        console.log(`  no pattern: ${pattern.reason}`);
        continue;
      }

      patternsFound++;

      // ── SR ANALYSIS — uses already-fetched rawCandles (no extra API call) ──
      const srAnalysis = getSRBeforeSignal(
        emadata.rawCandles,
        pattern.crossover.timestampUnix,
        pattern.crossover.price,
      );
      bcvc.srAnalysis = srAnalysis;

      // ── DOW THEORY ANALYSIS — uses already-fetched rawCandles (no extra API call) ──
      const signalDir = pattern.crossoverType === "BULLISH_CROSSOVER" ? "BULLISH" : "BEARISH";
      const dowAnalysis = analyzeDowTheory(emadata.rawCandles, signalDir);

      // ── PATTERN ID + DEDUP ────────────────────────────────────────────
      const patternId    = generatePatternId(symbol, pattern);
      const isNewPattern = !sentPatterns.has(patternId);

      console.log(`  PATTERN: ${pattern.crossoverType} | ${isNewPattern ? "NEW" : "SEEN"}`);

      // ── BUILD TELEGRAM MESSAGE ────────────────────────────────────────
      const crossoverAge = moment.unix(pattern.crossover.timestampUnix).fromNow();
      const tvLink       = getTradingViewLink(symbol);
      let telegramMessage = "";

      if (pattern.crossoverType === "BULLISH_CROSSOVER") {
        const bullEntryPrice = pattern.bullishBCVC.close;
        const bullSL         = pattern.bullishBCVC.low;
        const bullRisk       = +(bullEntryPrice - bullSL).toFixed(2);
        const bullTarget     = +(bullEntryPrice + bullRisk).toFixed(2);
        const srBlock        = BCVCManager.buildSRTelegramBlock(bcvc.srAnalysis, "BULLISH");
        const dowBlock       = buildDowTheoryTelegramBlock(dowAnalysis);

        telegramMessage = `
🟢 <b>BULLISH PATTERN FOUND</b> ${symbol}
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Chart :</b> <a href="${tvLink}"> ${symbol} (15min)</a>
📈 Candle Span ${pattern.candlesBetween} /10

📥 Entry : ₹${bullEntryPrice} (next candle open)
🛑 Stop Loss : ₹${bullSL} (signal candle low)
🎯 Target : ₹${bullTarget} (1:1 RR)
📉 Risk : ₹${bullRisk} pts

🔄 <b>Bullish Crossover :</b> ${pattern.crossover.timestamp}  ${crossoverAge}
🔴 <b>Bearish BCVCs (${pattern.validation.totalBearishBCVCs} found) :</b> ${pattern.lastBearishBCVC.timestamp} ${pattern.validation.bearishCandleColor.toUpperCase()} candle
🚀 <b>Bullish BCVC (Entry Signal) :</b> ${pattern.bullishBCVC.timestamp} White Candle
${srBlock}
${dowBlock}

⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}`.trim();

      } else if (pattern.crossoverType === "BEARISH_CROSSOVER") {
        const bearEntryPrice = pattern.redCandle.close;
        const bearSL         = pattern.redCandle.high;
        const bearRisk       = +(bearSL - bearEntryPrice).toFixed(2);
        const bearTarget     = +(bearEntryPrice - bearRisk).toFixed(2);
        const srBlock        = BCVCManager.buildSRTelegramBlock(bcvc.srAnalysis, "BEARISH");
        const dowBlock       = buildDowTheoryTelegramBlock(dowAnalysis);

        telegramMessage = `
🔴 <b>BEARISH PATTERN FOUND</b> ${symbol}
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Chart :</b> <a href="${tvLink}">${symbol} (15min)</a>
📉 Candle Span :${pattern.candlesBetween} /10

📥 Entry : ₹${bearEntryPrice} (next candle open)
🛑 Stop Loss : ₹${bearSL} (signal candle high)
🎯 Target : ₹${bearTarget} (1:1 RR)
📈 Risk : ₹${bearRisk} pts

🔄 <b>Bearish Crossover:</b> ${pattern.crossover.timestamp}  ${crossoverAge}
⚪ <b>Bullish BCVCs (${pattern.validation.totalBullishBCVCs} found) :</b> ${pattern.lastWhiteBCVC.timestamp}
🔻 <b>Bearish Candle (Entry Signal) :</b> ${pattern.redCandle.timestamp}
${srBlock}
${dowBlock}

⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}`.trim();
      }

      // ── SEND / RECORD ─────────────────────────────────────────────────
      const sendAndRecord = async () => {
        await bot.sendMessage(telegramchat, telegramMessage, { parse_mode: "HTML" });
        await writePatternToExcel(symbol, pattern, isFirstRun, SEND_FIRST_RUN_NOTIFICATIONS, bcvc);
        sentPatterns.add(patternId);
        newPatternsFound++;
        console.log(`  sent: Telegram + Excel`);
      };

      try {
        if (isFirstRun) {
          if (SEND_FIRST_RUN_NOTIFICATIONS) {
            console.log(`  first run + notifications ENABLED → sending`);
            await sendAndRecord();
          } else {
            console.log(`  first run + notifications DISABLED → Excel only`);
            await writePatternToExcel(symbol, pattern, isFirstRun, SEND_FIRST_RUN_NOTIFICATIONS, bcvc);
            sentPatterns.add(patternId);
          }
        } else if (isNewPattern) {
          await sendAndRecord();
        } else {
          console.log(`  skip: already notified`);
        }
      } catch (err) {
        console.error(`  ERROR send/record: ${err.message}`);
      }
    }

    // ── SUMMARY ──────────────────────────────────────────────────────────
    console.log(`\n${"=".repeat(60)}`);
    console.log(`SUMMARY`);
    console.log(`Symbols processed    : ${symbolsToProcess.length}`);
    console.log(`Skipped (sent)       : ${skippedSymbols}`);
    console.log(`Reversals detected   : ${differentCrossoversDetected}`);
    console.log(`Crossovers checked   : ${crossoversChecked}`);
    console.log(`Recent crossovers    : ${recentCrossovers}`);
    console.log(`Patterns found       : ${patternsFound}`);
    console.log(`New (notified)       : ${newPatternsFound}`);
    console.log(`Tracked today        : ${sentPatterns.size}`);
    console.log("=".repeat(60));

  } catch (error) {
    console.error("startlogic error:", error);
  }
};

// helper used inside startlogic
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startPatternScheduler = () => {
  stopPatternScheduler();

  const now = moment();
  const startTime = moment().hour(9).minute(15).second(0).millisecond(0);
  const endTime = moment().hour(15).minute(45).second(0).millisecond(0);

  // if (now.isAfter(endTime)) {
  //   console.log("⏰ Trading hours ended (after 3:15 PM). Pattern scheduler will not start.");
  //   console.log("⏰ Will resume tomorrow at 9:15 AM");
  //   return;
  // }

  // if (now.isBefore(startTime)) {
  //   console.log("⏰ Before trading hours. Pattern scheduler will start at 9:15 AM");
  //   const delay = startTime.diff(now);
  //   patternSchedulerTimeout = setTimeout(startPatternScheduler, delay);
  //   return;
  // }

  let firstRun = moment().hour(9).minute(15).second(10).millisecond(0);

  if (now.isAfter(firstRun)) {
    firstRun = now.clone().second(10).millisecond(0);
  }

  // if (firstRun.isAfter(endTime)) {
  //   console.log("⏰ Next run would be after 3:15 PM. Pattern scheduler stopped.");
  //   return;
  // }             

  const delay = firstRun.diff(moment());
  console.log(
    `⏳ Pattern detection will start at: ${firstRun.format("HH:mm:ss")}`,
  );
  console.log(`⏰ Auto-stop scheduled at: ${endTime.format("HH:mm:ss")}`);
  console.log(`⏰ Will run every 15 minutes during trading hours\n`);

  let isFirstRun = true;

  const scheduleNext = () => {
    const now = moment();

    // if (now.isAfter(endTime)) {
    //   console.log("⏰ 3:15 PM reached. Stopping pattern scheduler...");
    //   stopPatternScheduler();
    //   return;
    // }

    if (isExecuting) {
      console.log("⚠️ startlogic already executing, skipping this cycle");

      const nextRun = calculateNextAlignedRun(now);

      if (nextRun.isAfter(endTime)) {
        console.log("⏰ Next run would be after 3:15 PM. Stopping scheduler.");
        return;
      }

      const delay = Math.max(0, nextRun.diff(now));
      patternSchedulerTimeout = setTimeout(scheduleNext, delay);
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `▶ Pattern Detection Started: ${now.format("YYYY-MM-DD HH:mm:ss")}`,
    );
    console.log(`▶ Run Type: ${isFirstRun ? "INITIAL RUN" : "SCHEDULED RUN"}`);
    console.log("=".repeat(60) + "\n");

    const nextRun = calculateNextAlignedRun(now);

    isExecuting = true;
    startlogic(isFirstRun)
      .then(() => {
        const completedAt = moment();

        console.log(
          `\n✅ Pattern detection completed at: ${completedAt.format("YYYY-MM-DD HH:mm:ss")}`,
        );

        if (isFirstRun) {
          isFirstRun = false;
          console.log(
            `✅ Initial baseline established. Future runs will send Telegram notifications.\n`,
          );
        }

        if (nextRun.isAfter(endTime)) {
          console.log(
            `⏰ Next run (${nextRun.format("HH:mm:ss")}) would be after 3:15 PM. Stopping scheduler.`,
          );
          stopPatternScheduler();
          return;
        }

        console.log(
          `⏰ Next run scheduled at: ${nextRun.format("HH:mm:ss")}\n`,
        );

        const delay = Math.max(0, nextRun.diff(moment()));
        patternSchedulerTimeout = setTimeout(scheduleNext, delay);
      })
      .catch((error) => {
        console.error(`\n❌ Pattern detection error:`, error);

        if (nextRun.isAfter(endTime)) {
          console.log(
            `⏰ Next run would be after 3:15 PM. Stopping scheduler.`,
          );
          stopPatternScheduler();
          return;
        }

        console.log(`⏰ Retrying at: ${nextRun.format("HH:mm:ss")}\n`);

        const delay = Math.max(0, nextRun.diff(moment()));
        patternSchedulerTimeout = setTimeout(scheduleNext, delay);
      })
      .finally(() => {
        isExecuting = false;
      });
  };

  const calculateNextAlignedRun = (now) => {
    let nextRun = moment().hour(9).minute(15).second(10).millisecond(0);

    while (nextRun.isSameOrBefore(now)) {
      nextRun.add(15, "minute");
    }
    return nextRun;
  };

  patternSchedulerTimeout = setTimeout(scheduleNext, delay);
};

const stopPatternScheduler = () => {
  if (patternSchedulerTimeout) {
    clearTimeout(patternSchedulerTimeout);
    patternSchedulerTimeout = null;
    console.log("🛑 Pattern detection scheduler stopped.");
  }
  isExecuting = false;
};

// Start the scheduler
startPatternScheduler();
// runauth()
// startlogic(true)
// runBacktest()
const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;

app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
