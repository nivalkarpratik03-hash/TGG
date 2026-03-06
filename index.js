// MAIN FILE

const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
require("dotenv").config();
const fs = require("fs");
const moment = require("moment");
const { writePatternToExcel } = require("./src/excelReports");
// const TelegramBot = require('node-telegram-bot-api');
const { authenticate, getStoredTokens } = require("./src/generate")
const { authenticate, getStoredTokens } = require("./src/generate")
const EMAManager = require("./utils/func/emaManager");
const BCVCManager = require("./utils/func/bcvcManager");
const SRAnalyzer = require("./utils/func/srAnalyzer");
const {
  analyzeDowTheory,
  buildDowTheoryTelegramBlock,
} = require("./utils/func/dowTheory");
const { analyzeWaves, buildWaveAnalysisTelegramBlock } = require("./utils/func/waveAnalysis");

const {
  analyzeWyckoff,
  buildWyckoffTelegramBlock,
} = require("./utils/func/wyckoff");
const {
  scoreEntry,
  buildEntryMapTelegramBlock,
} = require("./utils/func/entryMap");

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
const telegramchat = "-1003727905299";
/////////////------------pgfbot
// const telegramtoken = "8390227157:AAFYQ2eWFAJdm9P8me9Nk2voYe00Mn33dSU";
// const telegramchat = "8559767849";
// const telegramchat = "8559767849";
/////////////------------pnlbot
// const telegramtoken = "7764791634:AAGGwGa6Sl7jNauuQvgnTXRTVixikBZCb-g";
// const telegramchat = "7781596314";
/////////////------------Lazy bot
// const telegramtoken = "8529663033:AAEBTgtqjKdqg3lG89ZMclD8lPTxN7mp3BI"
// const telegramchat = "8559767849";

let patternSchedulerTimeout = null;
let isExecuting = false;
const emaManager = new EMAManager(fyers);
const bcvcManager = new BCVCManager(fyers);
const srAnalyzer = new SRAnalyzer();
const SEND_FIRST_RUN_NOTIFICATIONS = false;
// const symbols = ["NSE:DIVISLAB-EQ","NSE:SUPREMEIND-EQ","NSE:PIDILITIND-EQ","NSE:DABUR-EQ","NSE:BHEL-EQ","NSE:ASTRAL-EQ"];

const app = express();

// const refresh_token =
//   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZDoxIiwiZDoyIiwieDowIiwieDoxIiwieDoyIl0sImF0X2hhc2giOiJnQUFBQUFCcGxVRGFENklHeXBNY1UwVVFJMWhEMXlMT0FrYnhVTE1YV1ZhZHNsLWNiUmJEVy14NzJfb2VoNlFRUHlxVTVsdTdUbUF2WGRObDh3R00yZzJwRHBfbGQxXzhia2VWNlVEY2tKclVqeHhMaGw5TFJncz0iLCJkaXNwbGF5X25hbWUiOiIiLCJvbXMiOiJLMSIsImhzbV9rZXkiOiI0ZDcwNTIwMzlmMmM2NzI3NGViNzBlZTNlZmU4NzU0Y2E3ZDAyMDg1ZTQ1ZDhkY2FlOGRiMzJiOSIsImlzRGRwaUVuYWJsZWQiOiJOIiwiaXNNdGZFbmFibGVkIjoiTiIsImZ5X2lkIjoiWFQwMzYyOSIsImFwcFR5cGUiOjEwMCwiZXhwIjoxNzcyNjcwNjAwLCJpYXQiOjE3NzEzODkxNDYsImlzcyI6ImFwaS5meWVycy5pbiIsIm5iZiI6MTc3MTM4OTE0Niwic3ViIjoicmVmcmVzaF90b2tlbiJ9.P-JdUPGC4hdwVOxo08zd7kVxS6XVyhUV5YwC5XToqOU";
const tokens = getStoredTokens()
var tempauth;

const raw = localStorage.getItem("token");
tempauth = raw ? JSON.parse(raw) : null;

let data = {
  grant_type: "refresh_token",
  // appIdHash: "e86d29ff056bcc78df9cd894f163914c9b2d7581cc0aaf417fe03cbbfbd97db4",
  // pin: "1234",
  appIdHash: process.env.HASH_ID,
  refresh_token: tokens.refresh_token,
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

let niftyBiasCache = null;
let niftyBiasCacheTime = null;

const getNiftyBias = async () => {
  if (
    niftyBiasCache &&
    niftyBiasCacheTime &&
    Date.now() - niftyBiasCacheTime < 15 * 60 * 1000
  ) {
    return niftyBiasCache;
  }

  try {
    const validTo = moment();
    const validFrom = moment().subtract(10, "days");

    const response = await fyers.getHistory({
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "15",
      date_format: "1",
      range_from: validFrom.format("YYYY-MM-DD"),
      range_to: validTo.format("YYYY-MM-DD"),
      cont_flag: "1",
    });

    if (!response || !response.candles || response.candles.length < 25) {
      return {
        bias: "UNKNOWN",
        emoji: "❓",
        reason: "Insufficient data",
        ema20: "N/A",
        currentPrice: "N/A",
      };
    }

    let candles = response.candles;
    const lastCloseTime = moment
      .unix(candles[candles.length - 1][0])
      .add(15, "minutes");
    if (moment().isBefore(lastCloseTime)) candles = candles.slice(0, -1);

    const closes = candles.map((c) => parseFloat(c[4]));
    const period = 20;
    const multiplier = 2 / (period + 1);
    let ema20 = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema20 = (closes[i] - ema20) * multiplier + ema20;
    }

    const currentPrice = closes[closes.length - 1];
    const distPct = (((currentPrice - ema20) / ema20) * 100).toFixed(2);

    let bias, emoji, reason;

    if (currentPrice > ema20 * 1.001) {
      bias = "LONG";
      emoji = "🟢";
      reason = `₹${currentPrice.toFixed(0)} above 20 EMA ₹${ema20.toFixed(0)} (+${distPct}%)`;
    } else if (currentPrice < ema20 * 0.999) {
      bias = "SHORT";
      emoji = "🔴";
      reason = `₹${currentPrice.toFixed(0)} below 20 EMA ₹${ema20.toFixed(0)} (${distPct}%)`;
    } else {
      bias = "CHOPPY";
      emoji = "⚠️";
      reason = `₹${currentPrice.toFixed(0)} at 20 EMA ₹${ema20.toFixed(0)} — no clear direction`;
    }

    const result = {
      bias,
      emoji,
      reason,
      currentPrice: +currentPrice.toFixed(2),
      ema20: +ema20.toFixed(2),
    };
    niftyBiasCache = result;
    niftyBiasCacheTime = Date.now();

    console.log(`📊 Nifty Bias: ${bias} | ${reason}`);
    return result;
  } catch (err) {
    console.error("❌ Nifty bias fetch failed:", err.message);
    return {
      bias: "UNKNOWN",
      emoji: "❓",
      reason: "Fetch error",
      ema20: "N/A",
      currentPrice: "N/A",
    };
  }
};

// ─────────────────────────────────────────────────────────────────
// BLOCK 2: Tiered exit calculator — add above startlogic()
// ─────────────────────────────────────────────────────────────────

const calcTieredExits = (entryPrice, sl, direction) => {
  const isBull = direction === "BULLISH_CROSSOVER";
  const risk = isBull
    ? +(entryPrice - sl).toFixed(2)
    : +(sl - entryPrice).toFixed(2);
  const t1 = isBull
    ? +(entryPrice + risk * 1).toFixed(2)
    : +(entryPrice - risk * 1).toFixed(2);
  const t2 = isBull
    ? +(entryPrice + risk * 2).toFixed(2)
    : +(entryPrice - risk * 2).toFixed(2);
  return { risk, t1, t2 };
};

// ─────────────────────────────────────────────────────────────────
// BLOCK 3: Daily bias message — add above startPatternScheduler()
// ─────────────────────────────────────────────────────────────────

const sendDailyBiasMessage = async () => {
  const bias = await getNiftyBias();

  const strategyLine =
    bias.bias === "LONG"
      ? "✅ Bullish setups favoured today\n⚠️  Bearish signals are counter-trend — confirm carefully"
      : bias.bias === "SHORT"
        ? "✅ Bearish setups favoured today\n⚠️  Bullish signals are counter-trend — confirm carefully"
        : "⚠️  Nifty is choppy — confirm every signal carefully before acting";

  const msg = `
${bias.emoji} <b>DAILY MARKET BIAS — ${moment().format("DD MMM YYYY")}</b>
━━━━━━━━━━━━━━━━━━━━━━━━
🧭 Bias         : <b>${bias.bias}</b>
📊 Nifty        : ₹${bias.currentPrice}
📈 20 EMA (15m) : ₹${bias.ema20}
📝 Reason       : ${bias.reason}

📋 <b>Team Strategy:</b>
${strategyLine}

⏰ ${moment().format("HH:mm:ss")}
`.trim();

  try {
    await bot.sendMessage(telegramchat, msg, { parse_mode: "HTML" });
    console.log(`✅ Daily bias message sent: ${bias.bias}`);
  } catch (err) {
    console.error("❌ Failed to send daily bias message:", err.message);
  }

  return bias;
};

// ─────────────────────────────────────────────────────────────────
// IMPROVEMENT 5: Daily EMA20 Bias per Symbol
// Fetch daily candles for a stock and check price vs 20-period EMA.
// Only take bullish 15m signals when daily trend is also LONG,
// and bearish 15m signals when daily trend is SHORT.
// ─────────────────────────────────────────────────────────────────
const dailyBiasCache = new Map(); // symbol → { bias, time }

const getDailyBias = async (symbol) => {
  const cached = dailyBiasCache.get(symbol);
  if (cached && Date.now() - cached.time < 60 * 60 * 1000) {
    // cache valid for 1 hour (daily candles don't change intraday)
    return cached.bias;
  }

  try {
    const validTo = moment();
    const validFrom = moment().subtract(80, "days"); // enough for EMA20

    const response = await fyers.getHistory({
      symbol,
      resolution: "D",
      date_format: "1",
      range_from: validFrom.format("YYYY-MM-DD"),
      range_to: validTo.format("YYYY-MM-DD"),
      cont_flag: "1",
    });

    if (!response || !response.candles || response.candles.length < 21) {
      return "UNKNOWN";
    }

    const closes = response.candles.map((c) => parseFloat(c[4]));
    const period = 20;
    const multiplier = 2 / (period + 1);
    let ema20 = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema20 = (closes[i] - ema20) * multiplier + ema20;
    }

    const lastClose = closes[closes.length - 1];
    let bias;
    if (lastClose > ema20 * 1.005) bias = "LONG";
    else if (lastClose < ema20 * 0.995) bias = "SHORT";
    else bias = "CHOPPY";

    dailyBiasCache.set(symbol, { bias, time: Date.now() });
    console.log(`📅 Daily bias for ${symbol}: ${bias} | Close ₹${lastClose.toFixed(0)} vs EMA20 ₹${ema20.toFixed(0)}`);
    return bias;
  } catch (err) {
    console.error(`⚠️  getDailyBias failed for ${symbol}:`, err.message);
    return "UNKNOWN";
  }
};

const getSRBeforeSignal = (rawCandles, signalCandleTs, signalCandleClose) => {
  if (!rawCandles || rawCandles.length === 0) return null;

  // Keep only candles that CLOSED before the signal candle
  const candlesBeforeSignal = rawCandles.filter((c) => c[0] < signalCandleTs);

  if (candlesBeforeSignal.length < 20) {
    console.log("⚠️ Not enough pre-signal candles for SR analysis");
    return null;
  }

  return srAnalyzer.analyze(candlesBeforeSignal, signalCandleClose);
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
  const TRADING_START = { hour: 9, minute: 15 }; // adjust to your market open
  const TRADING_END = { hour: 15, minute: 30 }; // adjust to your market close
  const TRADING_MINUTES_PER_DAY =
    TRADING_END.hour * 60 +
    TRADING_END.minute -
    (TRADING_START.hour * 60 + TRADING_START.minute);

  let start = moment.unix(startUnix);
  let end = moment.unix(endUnix);

  let totalMinutes = 0;
  let current = start.clone();

  while (current.isBefore(end)) {
    const next = moment.min(current.clone().endOf("day"), end);

    // Check if current day is a trading day (skip weekends)
    const dayOfWeek = current.day();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const tradingStart = current
        .clone()
        .startOf("day")
        .hour(TRADING_START.hour)
        .minute(TRADING_START.minute)
        .second(0);
      const tradingEnd = current
        .clone()
        .startOf("day")
        .hour(TRADING_END.hour)
        .minute(TRADING_END.minute)
        .second(0);

      const effectiveStart = moment.max(current, tradingStart);
      const effectiveEnd = moment.min(next, tradingEnd);

      if (effectiveEnd.isAfter(effectiveStart)) {
        totalMinutes += effectiveEnd.diff(effectiveStart, "minutes");
      }
    }

    current = current
      .clone()
      .startOf("day")
      .add(1, "day")
      .hour(TRADING_START.hour)
      .minute(TRADING_START.minute)
      .second(0);
  }

  return totalMinutes;
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

  // IMPROVEMENT 2: Gap/Open Filter — reject crossovers formed before 09:30
  if (isCrossoverInGapZone(crossoverTimestamp)) {
    return {
      found: false,
      reason: `Crossover at ${moment.unix(crossoverTimestamp).format("HH:mm")} is in gap-open zone (before 09:30)`,
    };
  }

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

    const elapsedMinutes = getTradingMinutesBetween(
      crossoverTimestamp,
      confirmingBullish.timestampUnix,
    );
    const candlesBetween =
      elapsedMinutes <= 150 ? 10 : Math.ceil(elapsedMinutes / 15);

    // IMPROVEMENT 3: Hard cap — pattern must complete within 10 candles (2.5h)
    if (candlesBetween > 10) {
      return {
        found: false,
        reason: `Pattern too old: ${candlesBetween} candles since crossover (max 10)`,
      };
    }

    // IMPROVEMENT 1: Time-window filter — signal candle must be in trading window
    if (!isInTradingWindow(confirmingBullish.timestampUnix)) {
      return {
        found: false,
        reason: `Bullish signal candle at ${moment.unix(confirmingBullish.timestampUnix).format("HH:mm")} is outside high-probability window (09:30-11:30 or 14:00-15:15)`,
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
      (f) =>
        f.candleColor === "red" ||
        f.candleColor === "orange" ||
        f.candleColor === "maroon",
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

    const elapsedMinutes = getTradingMinutesBetween(
      crossoverTimestamp,
      confirmingBearish.timestampUnix,
    );
    const candlesBetween =
      elapsedMinutes <= 150 ? 10 : Math.ceil(elapsedMinutes / 15);

    // IMPROVEMENT 3: Hard cap — pattern must complete within 10 candles (2.5h)
    if (candlesBetween > 10) {
      return {
        found: false,
        reason: `Pattern too old: ${candlesBetween} candles since crossover (max 10)`,
      };
    }

    // IMPROVEMENT 1: Time-window filter — signal candle must be in trading window
    if (!isInTradingWindow(confirmingBearish.timestampUnix)) {
      return {
        found: false,
        reason: `Bearish signal candle at ${moment.unix(confirmingBearish.timestampUnix).format("HH:mm")} is outside high-probability window (09:30-11:30 or 14:00-15:15)`,
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

// ─────────────────────────────────────────────────────────────────
// IMPROVEMENT 1: Time-Window Filter
// Only accept signal candles in high-probability windows:
//   Morning  : 09:30 – 11:30 (mins 570–690)
//   Afternoon: 14:00 – 15:15 (mins 840–915)
// ─────────────────────────────────────────────────────────────────
const isInTradingWindow = (timestampUnix) => {
  const m = moment.unix(timestampUnix);
  const mins = m.hours() * 60 + m.minutes();
  return (mins >= 570 && mins <= 690) || (mins >= 840 && mins <= 915);
};

// ─────────────────────────────────────────────────────────────────
// IMPROVEMENT 2: Gap/Open Filter
// Reject crossovers that formed during the noisy gap-open period
// (before 09:30 AM — first 15-min candle open).
// ─────────────────────────────────────────────────────────────────
const isCrossoverInGapZone = (timestampUnix) => {
  const m = moment.unix(timestampUnix);
  const mins = m.hours() * 60 + m.minutes();
  return mins < 570; // before 09:30
};

const getTradingViewLink = (symbol) => {
  // Strip NSE: prefix and -EQ suffix → e.g. "NSE:BAJAJFINSV-EQ" → "BAJAJFINSV"
  const clean = symbol.replace(/^NSE:/i, "").replace(/-EQ$/i, "");
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
let sentPatterns = new Set(); // Patterns already notified today
let symbolCrossoverCache = new Map(); // Symbol -> {crossoverTimestamp, crossoverType} for intraday tracking

const startlogic = async (isFirstRun = false) => {
  try {
    const symbols = loadSymbols(INPUT_EXCEL, SYMBOL_COLUMN);
    console.log(symbols);
    const niftyBias = await getNiftyBias();
    console.log(
      `🧭 Nifty Bias this run: ${niftyBias.bias} | ${niftyBias.reason}`,
    );

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
    ``;
    const BATCH_SIZE = 25;
    const WAIT_TIME = 5000;

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
          const signalCandle =
            pattern.crossoverType === "BULLISH_CROSSOVER"
              ? pattern.bullishBCVC
              : pattern.redCandle;

          // IMPROVEMENT 5: Daily EMA20 alignment — skip counter-trend setups
          const dailyBias = await getDailyBias(symbol);
          if (
            (pattern.crossoverType === "BULLISH_CROSSOVER" && dailyBias === "SHORT") ||
            (pattern.crossoverType === "BEARISH_CROSSOVER" && dailyBias === "LONG")
          ) {
            console.log(
              `⏭️  Skipping ${symbol}: Daily bias (${dailyBias}) is counter to 15m signal (${pattern.crossoverType})`,
            );
            continue;
          }

          const srAnalysis = getSRBeforeSignal(
            emadata.rawCandles,
            pattern.crossover.timestampUnix,
            signalCandle.close,
          );

          // Attach to bcvc so buildSRTelegramBlock (already called below) gets real data
          bcvc.srAnalysis = srAnalysis;

          // IMPROVEMENT 7: S/R-Based SL Optimization
          // Tighten SL to nearest validated S/R level if it's within 0.5% of signal candle's low/high
          let optimizedSL;
          if (pattern.crossoverType === "BULLISH_CROSSOVER") {
            const rawSL = signalCandle.low;
            const ns = srAnalysis && !srAnalysis.error && srAnalysis.support?.[0];
            if (ns && ns.price < rawSL && Math.abs(ns.price - rawSL) / rawSL <= 0.005) {
              optimizedSL = ns.price;
              console.log(`📍 SL tightened from ₹${rawSL} to ₹${optimizedSL.toFixed(2)} (S/R support level)`);
            } else {
              optimizedSL = rawSL;
            }
          } else {
            const rawSL = signalCandle.high;
            const nr = srAnalysis && !srAnalysis.error && srAnalysis.resistance?.[0];
            if (nr && nr.price > rawSL && Math.abs(nr.price - rawSL) / rawSL <= 0.005) {
              optimizedSL = nr.price;
              console.log(`📍 SL tightened from ₹${rawSL} to ₹${optimizedSL.toFixed(2)} (S/R resistance level)`);
            } else {
              optimizedSL = rawSL;
            }
          }

          const dowAnalysis = analyzeDowTheory(
            emadata.rawCandles,
            pattern.crossoverType,
          );
          const dowBlock = buildDowTheoryTelegramBlock(dowAnalysis);

          // Wyckoff analysis
          let wyckoffAnalysis = null;
          let wyckoffBlock = "";
          try {
            wyckoffAnalysis = analyzeWyckoff(emadata.rawCandles);
            wyckoffBlock = buildWyckoffTelegramBlock(wyckoffAnalysis);
          } catch (e) {
            console.error("⚠️ Wyckoff analysis failed:", e.message);
          }

          let waveAnalysis = null;
          let waveBlock = "";
          try {
            waveAnalysis = analyzeWaves(emadata.rawCandles);
            waveBlock = buildWaveAnalysisTelegramBlock(waveAnalysis);
            console.log(
              `🌊 Wave structure for ${symbol}: ${waveAnalysis.structureLabel} | ${waveAnalysis.waveCount} completed waves`,
            );
          } catch (e) {
            console.error("⚠️ Wave analysis failed:", e.message);
          }

          // Entry quality scoring — use optimizedSL for accurate R/R
          let entryScore = null;
          let entryMapBlock = "";
          try {
            const sc =
              pattern.crossoverType === "BULLISH_CROSSOVER"
                ? pattern.bullishBCVC
                : pattern.redCandle;
            const ep = sc.close;
            entryScore = scoreEntry({
              pattern,
              srAnalysis,
              dowAnalysis,
              wyckoffAnalysis,
              waveAnalysis,
              waveAnalysis,
              niftyBias,
              signalCandle: sc,
              entryPrice: ep,
              stopLoss: optimizedSL,
              direction: pattern.crossoverType,
            });
            entryMapBlock = buildEntryMapTelegramBlock(entryScore);
          } catch (e) {
            console.error("⚠️ Entry scoring failed:", e.message);
          }

          // IMPROVEMENT 4: Score Gate — only proceed with Grade A or A+ (score >= 65)
          if (entryScore && entryScore.totalScore < 65) {
            console.log(
              `⏭️  Skipping ${symbol}: Entry score ${entryScore.totalScore}/100 (${entryScore.grade}) — below minimum threshold (65). ${entryScore.recommendation}`,
            );
            continue;
          }

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
            const tvLink = getTradingViewLink(symbol);
            const bullEntryPrice = pattern.bullishBCVC.close;
            const bullSL = optimizedSL; // IMPROVEMENT 6+7: uses S/R-optimized SL
            const { risk, t1, t2 } = calcTieredExits(
              bullEntryPrice,
              bullSL,
              "BULLISH_CROSSOVER",
            );

            const alignLabel =
              niftyBias.bias === "LONG"
                ? `${niftyBias.emoji} ${niftyBias.bias} — Aligned ✅`
                : niftyBias.bias === "SHORT"
                  ? `${niftyBias.emoji} ${niftyBias.bias} — Counter Trend ⚠️`
                  : `${niftyBias.emoji} ${niftyBias.bias} — Choppy ⚠️`;

            const dailyBiasLabel = dailyBias === "LONG" ? "📅🟢 Daily Trend: BULLISH — Aligned" : `📅 Daily Trend: ${dailyBias}`;

            const srBlock = BCVCManager.buildSRTelegramBlock(
              bcvc.srAnalysis,
              "BULLISH",
            );

            telegramMessage = `
🟢 <b>BULLISH SIGNAL</b> — ${symbol}
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Chart      :</b> <a href="${tvLink}">${symbol} (15min)</a>
📈 Candle Span : ${pattern.candlesBetween}/10

📥 <b>Entry      :</b> ₹${bullEntryPrice} (next candle open)
🛑 <b>Stop Loss  :</b> ₹${bullSL}  |  Risk : ₹${risk} pts

🎯 <b>Tiered Exits:</b>
   T1 → ₹${t1}   Book 40% → move SL to breakeven
   T2 → ₹${t2}   Book 40% → trail the rest
   T3 → Trail remaining 20%: SL below each new EMA9-Low close 🔍
${entryMapBlock ? `\n${entryMapBlock}` : ""}
🧭 Nifty Bias  : ${alignLabel}
${dailyBiasLabel}

🔄 <b>Crossover  :</b> ${pattern.crossover.timestamp} (${moment.unix(pattern.crossover.timestampUnix).fromNow()})
🔴 <b>Bearish BCVCs :</b> ${pattern.validation.totalBearishBCVCs} found | Last: ${pattern.lastBearishBCVC.timestamp} [${pattern.validation.bearishCandleColor.toUpperCase()}]
🚀 <b>Entry Signal :</b> ${pattern.bullishBCVC.timestamp} — White candle
${srBlock}
${dowBlock}
${wyckoffBlock ? `\n${wyckoffBlock}` : ""}
${waveBlock ? `\n${waveBlock}` : ""}
${waveBlock ? `\n${waveBlock}` : ""}
⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
`.trim();
          }

          // ── BEARISH message ──
          else if (pattern.crossoverType === "BEARISH_CROSSOVER") {
            const tvLink = getTradingViewLink(symbol);
            const bearEntryPrice = pattern.redCandle.close;
            const bearSL = optimizedSL; // IMPROVEMENT 6+7: uses S/R-optimized SL
            const { risk, t1, t2 } = calcTieredExits(
              bearEntryPrice,
              bearSL,
              "BEARISH_CROSSOVER",
            );

            const alignLabel =
              niftyBias.bias === "SHORT"
                ? `${niftyBias.emoji} ${niftyBias.bias} — Aligned ✅`
                : niftyBias.bias === "LONG"
                  ? `${niftyBias.emoji} ${niftyBias.bias} — Counter Trend ⚠️`
                  : `${niftyBias.emoji} ${niftyBias.bias} — Choppy ⚠️`;

            const dailyBiasLabel = dailyBias === "SHORT" ? "📅🔴 Daily Trend: BEARISH — Aligned" : `📅 Daily Trend: ${dailyBias}`;

            const srBlock = BCVCManager.buildSRTelegramBlock(
              bcvc.srAnalysis,
              "BEARISH",
            );

            telegramMessage = `
🔴 <b>BEARISH SIGNAL</b> — ${symbol}
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Chart      :</b> <a href="${tvLink}">${symbol} (15min)</a>
📉 Candle Span : ${pattern.candlesBetween}/10

📥 <b>Entry      :</b> ₹${bearEntryPrice} (next candle open)
🛑 <b>Stop Loss  :</b> ₹${bearSL}  |  Risk : ₹${risk} pts

🎯 <b>Tiered Exits:</b>
   T1 → ₹${t1}   Book 40% → move SL to breakeven
   T2 → ₹${t2}   Book 40% → trail the rest
   T3 → Trail remaining 20%: SL above each new EMA9-High close 🔍
${entryMapBlock ? `\n${entryMapBlock}` : ""}
🧭 Nifty Bias  : ${alignLabel}
${dailyBiasLabel}

🔄 <b>Crossover  :</b> ${pattern.crossover.timestamp} (${moment.unix(pattern.crossover.timestampUnix).fromNow()})
⚪ <b>Bullish BCVCs :</b> ${pattern.validation.totalBullishBCVCs} found | Last: ${pattern.lastWhiteBCVC.timestamp}
🔻 <b>Entry Signal :</b> ${pattern.redCandle.timestamp} — Bearish candle
${srBlock}
${dowBlock}
${wyckoffBlock ? `\n${wyckoffBlock}` : ""}
${waveBlock ? `\n${waveBlock}` : ""}
${waveBlock ? `\n${waveBlock}` : ""}
⏰ <b>Detected :</b> ${moment().format("YYYY-MM-DD HH:mm:ss")}
`.trim();
          }
          const sendAndRecord = async () => {
            // 1) Telegram
            await bot.sendMessage(telegramchat, telegramMessage, {
              parse_mode: "HTML",
            });
            console.log(`✅ Telegram notification sent for ${symbol}`);

            // 2) Excel  (bcvc already in scope from the outer for-loop)
            await writePatternToExcel(
              symbol,
              pattern,
              isFirstRun,
              SEND_FIRST_RUN_NOTIFICATIONS,
              bcvc,
            );

            // 3) Mark as sent in memory
            sentPatterns.add(patternId);
            console.log(`📝 Pattern tracked: ${patternId}`);
          };
          // ✅ NOW guard sending on isFirstRun / isNewPattern — message is always ready
          if (!isFirstRun && isNewPattern) {
            newPatternsFound++;
            try {
              await bot.sendMessage(telegramchat, telegramMessage, {
                parse_mode: "HTML",
              });
              await writePatternToExcel(
                symbol,
                pattern,
                isFirstRun,
                SEND_FIRST_RUN_NOTIFICATIONS,
                bcvc,
              );
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
                // First run WITH notifications enabled — send + save
                console.log(
                  `🔔 First run with notifications ENABLED - sending alert`,
                );
                try {
                  await sendAndRecord();
                } catch (err) {
                  console.error(
                    `❌ Failed to send/save for ${symbol}:`,
                    err.message,
                  );
                }
              } else {
                // First run WITHOUT notifications — save to Excel only, no Telegram
                console.log(
                  `🔕 First run - storing pattern without Telegram notification`,
                );
                try {
                  await writePatternToExcel(
                    symbol,
                    pattern,
                    isFirstRun,
                    SEND_FIRST_RUN_NOTIFICATIONS,
                    bcvc,
                  );
                  sentPatterns.add(patternId);
                  console.log(`📝 Pattern tracked (Excel only): ${patternId}`);
                } catch (err) {
                  console.error(
                    `❌ Failed to save to Excel for ${symbol}:`,
                    err.message,
                  );
                }
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
      .then(async () => {
        const completedAt = moment();

        console.log(
          `\n✅ Pattern detection completed at: ${completedAt.format("YYYY-MM-DD HH:mm:ss")}`,
        );

        if (isFirstRun) {
          isFirstRun = false;
          await sendDailyBiasMessage();
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
// startPatternScheduler();
// runauth();
// startlogic(true)
// authenticate()
runBacktest();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;

app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
