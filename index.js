const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
require("dotenv").config();
const fs = require("fs");
const moment = require("moment");
// const TelegramBot = require('node-telegram-bot-api');
const EMAManager = require("./utils/func/emaManager");
const BCVCManager = require("./utils/func/bcvcManager");
const bot = require("./utils/func/telegram");
const fyers = require("./utils/func/fyersapi");
const { authenticate } = require("./src/generate");
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
const telegramchat = "8559767849";
/////////////------------pnlbot
// const telegramtoken = "7764791634:AAGGwGa6Sl7jNauuQvgnTXRTVixikBZCb-g";
// const telegramchat = "7781596314";
let patternSchedulerTimeout = null;
let isExecuting = false;
const emaManager = new EMAManager(fyers);
const bcvcManager = new BCVCManager(fyers);
const SEND_FIRST_RUN_NOTIFICATIONS = true;
const symbols = ["NSE:DIVISLAB-EQ"];

const app = express();

// const refresh_token =
//   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZDoxIiwiZDoyIiwieDowIiwieDoxIiwieDoyIl0sImF0X2hhc2giOiJnQUFBQUFCcGxVRGFENklHeXBNY1UwVVFJMWhEMXlMT0FrYnhVTE1YV1ZhZHNsLWNiUmJEVy14NzJfb2VoNlFRUHlxVTVsdTdUbUF2WGRObDh3R00yZzJwRHBfbGQxXzhia2VWNlVEY2tKclVqeHhMaGw5TFJncz0iLCJkaXNwbGF5X25hbWUiOiIiLCJvbXMiOiJLMSIsImhzbV9rZXkiOiI0ZDcwNTIwMzlmMmM2NzI3NGViNzBlZTNlZmU4NzU0Y2E3ZDAyMDg1ZTQ1ZDhkY2FlOGRiMzJiOSIsImlzRGRwaUVuYWJsZWQiOiJOIiwiaXNNdGZFbmFibGVkIjoiTiIsImZ5X2lkIjoiWFQwMzYyOSIsImFwcFR5cGUiOjEwMCwiZXhwIjoxNzcyNjcwNjAwLCJpYXQiOjE3NzEzODkxNDYsImlzcyI6ImFwaS5meWVycy5pbiIsIm5iZiI6MTc3MTM4OTE0Niwic3ViIjoicmVmcmVzaF90b2tlbiJ9.P-JdUPGC4hdwVOxo08zd7kVxS6XVyhUV5YwC5XToqOU";
const refresh_token =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZDoxIiwiZDoyIiwieDowIiwieDoxIiwieDoyIl0sImF0X2hhc2giOiJnQUFBQUFCcGxxakh5ekVBajNCeUhRY3Z0ZEpkeWx4WWNZY0tzdmNIQk12ZGJTdDZBWjlQRE9wcV9CeEFuek5OUmN0aHRtYWJqek1xeG1zeEpCdjZlRFptSFJ5Q0dEcVJ6c2Q5VVRpS2h3ems0SlFKc05tX2sxZz0iLCJkaXNwbGF5X25hbWUiOiIiLCJvbXMiOiJLMSIsImhzbV9rZXkiOiI5YzM5OTNlMTM2ZTkxYjJhNWNjNTI1NmMxNDlkMjI4ZDQ2YzU3NDJjZTg1ZjYyODAwMTIzYzIxZCIsImlzRGRwaUVuYWJsZWQiOiJOIiwiaXNNdGZFbmFibGVkIjoiTiIsImZ5X2lkIjoiRkFJNDY2NDAiLCJhcHBUeXBlIjoxMDAsImV4cCI6MTc3Mjc1NzAwMCwiaWF0IjoxNzcxNDgxMjg3LCJpc3MiOiJhcGkuZnllcnMuaW4iLCJuYmYiOjE3NzE0ODEyODcsInN1YiI6InJlZnJlc2hfdG9rZW4ifQ.o-_-luxPPPsWeWlzHnGz6SvGsfsE-eE_0NnDM_Iyoig";
var tempauth;

const raw = localStorage.getItem("token");
tempauth = raw ? JSON.parse(raw) : null;

let data = {
  grant_type: "refresh_token",
  appIdHash: process.env.HASH_ID,
  refresh_token: refresh_token,
  pin: process.env.PIN,
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
      validation: {
        totalBearishBCVCs: bearishFormations.length,
        bearishCandleColor: lastBearishBCVC.candleColor,
        bearishHigh: bearishHigh,
        bullishClose: confirmingBullish.close,
        bullishHigh: confirmingBullish.high,
        closedAboveBearishHigh: true,
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
      (f) => f.candleColor === "red" || f.candleColor === "orange",
    );

    if (bearishCandlesAfterWhite.length === 0) {
      return {
        found: false,
        reason: "No RED/ORANGE candles found after the last WHITE BCVC",
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
      validation: {
        totalBullishBCVCs: bullishFormations.length,
        whiteLow: whiteLow,
        whiteClose: lastWhiteBCVC.close,
        redClose: confirmingBearish.close,
        redLow: confirmingBearish.low,
        closedBelowWhiteLow: true,
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
      },
    };
  }

  return {
    found: false,
    reason: `Unknown crossover type: ${latestCrossover.type}`,
  };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
let sentPatterns = new Set(); // Patterns already notified today
let symbolCrossoverCache = new Map(); // Symbol -> {crossoverTimestamp, crossoverType} for intraday tracking

const startlogic = async (isFirstRun = false) => {
  try {
    // const symbols = loadSymbols(INPUT_EXCEL, SYMBOL_COLUMN);
    console.log(symbols);

    const now = moment();
    const today = now.format("YYYY-MM-DD");

    const TRADING_DAYS_LOOKBACK = 1;
    const { lookbackDate, calendarDaysBack, tradingDaysCount } =
      getTrailingTradingDays(TRADING_DAYS_LOOKBACK);

    const BCVC_LOOKBACK_DAYS = calendarDaysBack + 2;

    // For daily runs, we process ALL symbols that have recent crossovers
    // No need for "targeted scan" since it's fresh every morning
    const symbolsToProcess = symbols.slice(0, Math.min(208, symbols.length));

    let patternsFound = 0;
    let newPatternsFound = 0;
    let crossoversChecked = 0;
    let recentCrossovers = 0;
    let skippedSymbols = 0;
    let differentCrossoversDetected = 0; // Count of symbols with multiple crossovers today

    const BATCH_SIZE = 20;
    const WAIT_TIME = 15000;

    console.log(`\n🕐 Current Time: ${now.format("YYYY-MM-DD HH:mm:ss")}`);
    console.log(
      `🔄 Run Type: ${isFirstRun ? "INITIAL RUN (no notifications)" : "SCHEDULED RUN (notifications enabled)"}`,
    );
    console.log(`🎯 Processing ALL symbols with recent crossovers`);
    console.log(
      `📅 Checking for crossovers since: ${lookbackDate.format("YYYY-MM-DD HH:mm:ss")} (${tradingDaysCount} trading days)`,
    );
    console.log(
      `📊 BCVC fetch period: ${BCVC_LOOKBACK_DAYS} days (${calendarDaysBack} lookback + 2 buffer)`,
    );
    console.log(
      `⚙️  Rate Limiting: Processing ${BATCH_SIZE} symbols, then waiting ${WAIT_TIME / 1000} seconds`,
    );
    console.log(`📝 Patterns already notified today: ${sentPatterns.size}`);
    console.log("=".repeat(60));

    for (let i = 0; i < symbolsToProcess.length; i++) {
      const symbol = symbolsToProcess[i];
      console.log(
        `\n--- Processing Symbol ${i + 1}/${symbolsToProcess.length}: ${symbol} ---`,
      );

      try {
        const emadata = await emaManager.generateEMAReport(symbol);

        if (!emadata.crossover || emadata.crossover.length === 0) {
          console.log(`⏭️  Skipping ${symbol}: No crossovers found`);
          continue;
        }

        crossoversChecked++;
        const latestCrossover = emadata.crossover[0];
        const crossoverTime = moment.unix(latestCrossover.timestampUnix);

        if (crossoverTime.isBefore(lookbackDate)) {
          const daysAgo = now.diff(crossoverTime, "days");
          const hoursAgo = now.diff(crossoverTime, "hours");
          console.log(
            `⏭️  Skipping ${symbol}: Latest crossover is ${daysAgo} calendar days (${hoursAgo} hours) old`,
          );
          console.log(
            `   Crossover: ${latestCrossover.type} at ${crossoverTime.format("YYYY-MM-DD HH:mm")} (${crossoverTime.format("dddd")})`,
          );
          continue;
        }

        // 🔥 CRITICAL FIX: Check if this is a DIFFERENT crossover than what we've seen today
        const cachedCrossover = symbolCrossoverCache.get(symbol);
        const currentCrossoverKey = `${latestCrossover.type}_${latestCrossover.timestampUnix}`;

        let isNewOrDifferentCrossover = false;

        if (!cachedCrossover) {
          // First time seeing this symbol's crossover today
          isNewOrDifferentCrossover = true;
          symbolCrossoverCache.set(symbol, {
            crossoverTimestamp: latestCrossover.timestampUnix,
            crossoverType: latestCrossover.type,
            key: currentCrossoverKey,
          });
          console.log(
            `✓ New crossover detected for ${symbol}: ${latestCrossover.type}`,
          );
        } else if (cachedCrossover.key !== currentCrossoverKey) {
          // 🎯 DIFFERENT crossover detected (direction changed or new timestamp)
          // This is the KEY scenario: bullish -> bearish or bearish -> bullish
          isNewOrDifferentCrossover = true;
          differentCrossoversDetected++;
          console.log(`🔄 ⚡ DIFFERENT CROSSOVER DETECTED for ${symbol}!`);
          console.log(
            `   Previous: ${cachedCrossover.crossoverType} @ ${moment.unix(cachedCrossover.crossoverTimestamp).format("HH:mm")}`,
          );
          console.log(
            `   Current: ${latestCrossover.type} @ ${crossoverTime.format("HH:mm")}`,
          );
          console.log(`   👉 This is a REVERSAL - will check for new pattern`);

          // Update cache with new crossover
          symbolCrossoverCache.set(symbol, {
            crossoverTimestamp: latestCrossover.timestampUnix,
            crossoverType: latestCrossover.type,
            key: currentCrossoverKey,
          });
        }

        // 🔥 SMART SKIP LOGIC: Only skip if SAME crossover already has pattern sent
        if (!isNewOrDifferentCrossover && !isFirstRun) {
          // Generate the specific pattern ID for THIS crossover
          const crossoverTypePrefix = latestCrossover.type.includes("BULLISH")
            ? "BULL"
            : "BEAR";
          const potentialPatternPrefix = `${symbol}_${crossoverTypePrefix}_${latestCrossover.timestampUnix}`;

          // Check if this EXACT crossover already has a pattern sent
          const alreadySentThisPattern = Array.from(sentPatterns).some(
            (patternId) => patternId.startsWith(potentialPatternPrefix),
          );

          if (alreadySentThisPattern) {
            skippedSymbols++;
            console.log(
              `⏭️  Skipping ${symbol}: Pattern already sent for this crossover`,
            );
            const matchingPattern = Array.from(sentPatterns).find((id) =>
              id.startsWith(potentialPatternPrefix),
            );
            console.log(`   Pattern ID: ${matchingPattern}`);
            continue;
          } else {
            console.log(
              `✓ Processing ${symbol}: Same crossover but pattern not sent yet (still forming)`,
            );
          }
        }

        recentCrossovers++;
        const daysAgo = now.diff(crossoverTime, "days");
        const hoursAgo = now.diff(crossoverTime, "hours");
        const minutesAgo = now.diff(crossoverTime, "minutes");

        console.log(`✓ Recent crossover found:`);
        console.log(`  Type: ${latestCrossover.type}`);
        console.log(
          `  Time: ${crossoverTime.format("YYYY-MM-DD HH:mm:ss")} (${crossoverTime.format("dddd")})`,
        );
        console.log(
          `  Age: ${daysAgo} calendar days, ${hoursAgo % 24} hours, ${minutesAgo % 60} minutes ago`,
        );
        console.log(`  Relative: ${crossoverTime.fromNow()}`);

        console.log(
          `📊 Fetching BCVC data for ${symbol} (${BCVC_LOOKBACK_DAYS} days)...`,
        );
        let bcvc;

        if (latestCrossover.type === "BEARISH_CROSSOVER") {
          console.log(
            `  🔻 Bearish crossover detected - including RED candles`,
          );
          bcvc = await bcvcManager.getHistoricalBCVC(
            symbol,
            "15",
            BCVC_LOOKBACK_DAYS,
            "red",
          );
        } else {
          console.log(
            `  🚀 Bullish crossover detected - BCVC with white, orange & maroon`,
          );
          bcvc = await bcvcManager.getHistoricalBCVC(
            symbol,
            "15",
            BCVC_LOOKBACK_DAYS,
          );
          // No special flag needed — maroon is now always detected in analyzeBCVC
        }

        const pattern = analyzePattern(emadata, bcvc);
        if (pattern.found) {
          patternsFound++;

          const patternId = generatePatternId(symbol, pattern);
          const isNewPattern = !sentPatterns.has(patternId);

          console.log(`✅ PATTERN FOUND for ${symbol}!`);
          console.log(`📊 Crossover Type: ${pattern.crossoverType}`);
          console.log(`🆔 Pattern ID: ${patternId}`);
          console.log(
            `🔔 Status: ${isNewPattern ? "NEW - Will send notification" : "ALREADY SENT - Skipping notification"}`,
          );

          const formattedSummary = {
            ...pattern.summary,
            crossoverTime: moment
              .unix(pattern.crossover.timestampUnix)
              .format("YYYY-MM-DD HH:mm"),
            crossoverAge: moment
              .unix(pattern.crossover.timestampUnix)
              .fromNow(),
          };

          console.log(`📊 Summary:`, JSON.stringify(formattedSummary, null, 2));
          console.log(
            `✓ Validation:`,
            JSON.stringify(pattern.validation, null, 2),
          );
          var telegramMessage = "";

        if (pattern.crossoverType === "BULLISH_CROSSOVER") {
            console.log(`🚀 Bullish Crossover: ${pattern.crossover.timestamp} @ ${pattern.crossover.price}`);
            console.log(`🔴 Bearish BCVCs found: ${pattern.validation.totalBearishBCVCs} (${pattern.validation.bearishCandleColor.toUpperCase()})`);
            console.log(`🔴 Last Bearish BCVC: ${pattern.lastBearishBCVC.timestamp} (High: ${pattern.lastBearishBCVC.high})`);
            console.log(`🚀 Bullish BCVC: ${pattern.bullishBCVC.timestamp} (Close: ${pattern.bullishBCVC.close}) - CLOSED ABOVE BEARISH HIGH ✓`);
            telegramMessage = `
🚀 <b>BULLISH PATTERN FOUND</b> 🚀

📈 <b>Symbol:</b> ${symbol}

🔄 <b>Bullish Crossover:</b>
  • Time: ${pattern.crossover.timestamp}
  • Price: ₹${pattern.crossover.price}
  • Age: ${formattedSummary.crossoverAge}

🔴 <b>Bearish BCVCs (${pattern.validation.totalBearishBCVCs} found):</b>
  • Last Bearish Time: ${pattern.lastBearishBCVC.timestamp}
  • Last Bearish Type: ${pattern.validation.bearishCandleColor.toUpperCase()} candle
  • Last Bearish High: ₹${pattern.lastBearishBCVC.high}
  • Last Bearish Close: ₹${pattern.lastBearishBCVC.close}

🚀 <b>Bullish BCVC (Entry Signal):</b>
  • Time: ${pattern.bullishBCVC.timestamp}
  • High: ₹${pattern.bullishBCVC.high}
  • Close: ₹${pattern.bullishBCVC.close}
  • ✅ CLOSED ABOVE BEARISH HIGH

📊 <b>Validation:</b>
  • Total Bearish BCVCs: ${pattern.validation.totalBearishBCVCs}
  • Ref Candle: ${pattern.validation.bearishCandleColor.toUpperCase()}
  • Last Bearish High: ₹${pattern.validation.bearishHigh}
  • Bullish High: ₹${pattern.validation.bullishHigh}
  • Bullish Close: ₹${pattern.validation.bullishClose}

⏰ <b>Detected:</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
`.trim();
          } else if (pattern.crossoverType === "BEARISH_CROSSOVER") {
            // ✅ Updated console logs
            console.log(
              `🔴 Bearish Crossover: ${pattern.crossover.timestamp} @ ${pattern.crossover.price}`,
            );
            console.log(
              `⚪ White BCVCs found: ${pattern.validation.totalBullishBCVCs}`,
            );
            console.log(
              `⚪ Last White BCVC: ${pattern.lastWhiteBCVC.timestamp} (Low: ${pattern.lastWhiteBCVC.low})`,
            );
            console.log(
              `🔻 Bearish Candle: ${pattern.redCandle.timestamp} (Close: ${pattern.redCandle.close}) - CLOSED BELOW WHITE LOW ✓`,
            );

            // ✅ Updated Telegram message
            telegramMessage = `
🔴 <b>BEARISH PATTERN FOUND</b> 🔴

📉 <b>Symbol:</b> ${symbol}

🔄 <b>Bearish Crossover:</b>
  • Time: ${pattern.crossover.timestamp}
  • Price: ₹${pattern.crossover.price}
  • Age: ${formattedSummary.crossoverAge}

⚪ <b>Bullish BCVCs (${pattern.validation.totalBullishBCVCs} found):</b>
  • Last White Time: ${pattern.lastWhiteBCVC.timestamp}
  • Last White Low: ₹${pattern.lastWhiteBCVC.low}
  • Last White Close: ₹${pattern.lastWhiteBCVC.close}

🔻 <b>Bearish Candle (Entry Signal):</b>
  • Time: ${pattern.redCandle.timestamp}
  • Low: ₹${pattern.redCandle.low}
  • Close: ₹${pattern.redCandle.close}
  • ✅ CLOSED BELOW WHITE LOW

📊 <b>Validation:</b>
  • Total Bullish BCVCs: ${pattern.validation.totalBullishBCVCs}
  • Last White Low: ₹${pattern.validation.whiteLow}
  • Bearish Close: ₹${pattern.validation.redClose}
  • Bearish Low: ₹${pattern.validation.redLow}

⏰ <b>Detected:</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
`.trim();
          }

          // ✅ NOW guard sending on isFirstRun / isNewPattern — message is always ready
          if (!isFirstRun && isNewPattern) {
            newPatternsFound++;
            try {
              // await bot.sendMessage(telegramchat, telegramMessage, {
              //   parse_mode: "HTML",
              // });
              console.log(`✅ Telegram notification sent for ${symbol}`);
              sentPatterns.add(patternId);
              console.log(`📝 Pattern tracked: ${patternId}`);
            } catch (telegramError) {
              console.error(
                `❌ Failed to send Telegram message:`,
                telegramError.message,
              );
            }
          } else {
            if (isFirstRun) {
              if (SEND_FIRST_RUN_NOTIFICATIONS) {
                console.log(
                  `🔔 First run with notifications ENABLED - sending alert`,
                );
                try {
                  await bot.sendMessage(telegramchat, telegramMessage, {
                    parse_mode: "HTML",
                  });
                  console.log(`✅ Telegram notification sent for ${symbol}`);
                  sentPatterns.add(patternId);
                  console.log(`📝 Pattern tracked: ${patternId}`);
                } catch (telegramError) {
                  console.error(
                    `❌ Failed to send Telegram message:`,
                    telegramError.message,
                  );
                }
              } else {
                console.log(
                  `🔕 First run - storing pattern without notification`,
                );
                sentPatterns.add(patternId);
                console.log(`📝 Pattern tracked: ${patternId}`);
              }
            } else {
              console.log(`⏭️  Pattern already sent previously - skipping`);
            }
          }
        } else {
          console.log(`❌ Pattern not found for ${symbol}: ${pattern.reason}`);
          console.log(   
            `   Will check again in next run if crossover still recent`,
          );
        }
      } catch (error) {
        console.error(`Error processing ${symbol}:`, error.message);
      }

      if ((i + 1) % BATCH_SIZE === 0 && i + 1 < symbolsToProcess.length) {
        const waitUntil = moment().add(WAIT_TIME / 1000, "seconds");
        console.log("\n" + "⏸️ ".repeat(30));
        console.log(`⏸️  RATE LIMIT: Processed ${i + 1} symbols`);
        console.log(
          `⏸️  Waiting ${WAIT_TIME / 1000} seconds to avoid API limits...`,
        );
        console.log(`⏸️  Will resume at: ${waitUntil.format("HH:mm:ss")}`);
        console.log("⏸️ ".repeat(30) + "\n");

        await delay(WAIT_TIME);

        console.log(`✅ Resuming processing...`);
      }
    }

    // Summary statistics
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY STATISTICS");
    console.log("=".repeat(60));
    console.log(`Scan completed at: ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
    console.log(`Total symbols in list: ${symbols.length}`);
    console.log(`Symbols processed this run: ${symbolsToProcess.length}`);
    console.log(`Symbols skipped (already sent): ${skippedSymbols}`);
    console.log(
      `🔄 Symbols with DIFFERENT crossovers today: ${differentCrossoversDetected} ⚡`,
    );
    console.log(`Symbols with crossovers: ${crossoversChecked}`);
    console.log(
      `Recent crossovers (within ${tradingDaysCount} trading days): ${recentCrossovers}`,
    );
    console.log(`Total patterns found: ${patternsFound}`);
    console.log(`New patterns (not previously notified): ${newPatternsFound}`);
    console.log(
      `Telegram notifications sent: ${isFirstRun && !SEND_FIRST_RUN_NOTIFICATIONS ? 0 : newPatternsFound}`,
    );
    console.log(`Total patterns tracked today: ${sentPatterns.size}`);
    console.log(
      `Success rate: ${recentCrossovers > 0 ? ((patternsFound / recentCrossovers) * 100).toFixed(2) : 0}%`,
    );
    console.log("=".repeat(60));
  } catch (error) {
    console.log(error);
  }
};

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

  let firstRun = moment().hour(9).minute(15).second(0).millisecond(0);

  if (now.isAfter(firstRun)) {
    firstRun = now.clone().second(0).millisecond(0);
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
    let nextRun = moment().hour(9).minute(15).second(0).millisecond(0);

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
// authenticate()

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;

app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
