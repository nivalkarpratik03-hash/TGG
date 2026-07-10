/**
 * Fyers API v3 — using fyers-api-v3 npm package
 * Token is read from fyers_access_token.txt (written by generate.js)
 */

const fs = require("fs");
const path = require("path");
const { fyersModel } = require("fyers-api-v3");

const ROOT = path.resolve(__dirname, "../..");
const TOKEN_FILE = path.join(ROOT, "fyers_access_token.txt");
const REFRESH_FILE = path.join(ROOT, "fyers_refresh_token.txt");

function rejectAfter(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[Fyers] ${label} timed out after ${ms}ms`)), ms)
  );
}

/**
 * P3 #15 — dedup-by-time + sort-ascending used to be copy-pasted identically
 * in both fetchDailyCandles() and fetchCandles()'s intraday chunk merge.
 * Single source of truth now.
 */
function dedupSortCandles(candles) {
  const seen = new Set();
  return candles
    .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, token.trim(), "utf8");
}

function getFyersClient() {
  const token = loadToken();
  if (!token) throw new Error("No access token. Run: node src/generate.js");
  const appId = process.env.APP_ID;
  if (!appId) throw new Error("APP_ID missing in .env");
  const fyers = new fyersModel({ path: "", enableLogging: false });
  fyers.setAppId(appId);
  fyers.setRedirectUrl("https://trade.fyers.in/api-login/redirect-uri/index.html");
  fyers.setAccessToken(token);
  return fyers;
}

function getAuthURL() {
  const appId = process.env.APP_ID;
  if (!appId) throw new Error("APP_ID not set in .env");
  const fyers = new fyersModel({ path: "", enableLogging: false });
  return fyers.generateAuthCode({
    client_id: appId,

    redirect_uri: "https://trade.fyers.in/api-login/redirect-uri/index.html",
    response_type: "code",
    state: "sample_state",
  });
}

async function generateToken(authCode) {
  const appId = process.env.APP_ID;
  const secretKey = process.env.ST_KEY;
  if (!appId || !secretKey) throw new Error("APP_ID / ST_KEY missing in .env");
  const fyers = new fyersModel({ path: "", enableLogging: false });
  const response = await fyers.generate_access_token({
    client_id: appId,
    secret_key: secretKey,
    auth_code: authCode,
    grant_type: "authorization_code",
  });
  if (response.s !== "ok") throw new Error("Token exchange failed: " + JSON.stringify(response));
  saveToken(response.access_token);
  if (response.refresh_token) fs.writeFileSync(REFRESH_FILE, response.refresh_token.trim(), "utf8");
  return response.access_token;
}

async function validateToken() {
  const token = loadToken();
  if (!token) return false;
  try {
    const fyers = getFyersClient();
    const res = await Promise.race([fyers.get_profile(), rejectAfter(8000, "validateToken")]);
    return res && res.s === "ok";
  } catch (err) {
    console.warn("[Fyers] validateToken failed:", err.message);
    return false;
  }
}

// ── IST helpers ───────────────────────────────────────────────────────────────
const IST_OFFSET_S = 5.5 * 3600;
const MARKET_OPEN_IST_S = (9 * 60 + 15) * 60; // 09:15 IST in seconds from midnight

function endOfTodayIST(nowSec) {
  const istMidnightSec = Math.floor((nowSec + IST_OFFSET_S) / 86400) * 86400 - IST_OFFSET_S;
  return istMidnightSec + 86399;
}

function normalizeDailyTimestamp(epochSec) {
  const IST_OFFSET_MS = IST_OFFSET_S * 1000;
  const istMs = epochSec * 1000 + IST_OFFSET_MS;
  const istMidnightMs = Math.floor(istMs / 86400000) * 86400000;
  return (istMidnightMs - IST_OFFSET_MS) / 1000 + MARKET_OPEN_IST_S;
}

/**
 * Monday 09:15 IST anchor for the ISO week containing epochSec.
 * Uses getUTCDay() on IST-shifted time to avoid timezone day-boundary bugs.
 */
function weekAnchor(epochSec) {
  const IST_OFFSET_MS = IST_OFFSET_S * 1000;
  const istMs = epochSec * 1000 + IST_OFFSET_MS;
  const dow = new Date(istMs).getUTCDay(); // 0=Sun,1=Mon,...,6=Sat in IST
  const daysSinceMon = (dow + 6) % 7;     // Mon=0, Tue=1, ..., Sun=6
  const msIntoISTDay = istMs % 86400000;
  const mondayISTMidnightMs = istMs - msIntoISTDay - daysSinceMon * 86400000;
  return (mondayISTMidnightMs - IST_OFFSET_MS) / 1000 + MARKET_OPEN_IST_S;
}

// ── Smart lookback calculator ─────────────────────────────────────────────────
function calcLookbackDays(resolution) {
  const res = String(resolution).toUpperCase();
  if (res === "W" || res === "10080") return 1095; // 3 years = 4 chunks max (was 3650 = 11 chunks, caused rate storm)
  if (res === "D" || res === "1440") return 730;
  const mins = parseInt(res, 10) || 3;
  if (mins === 60) return 150;
  if (mins === 15) return 60;
  return 30;
}

// ── Daily-candle fetcher ──────────────────────────────────────────────────────
/**
 * Fetches daily candles in NEWEST-FIRST chunk order.
 *
 * KEY FIX: Previously chunks were built oldest→newest. If Fyers silently fails
 * any chunk, the newest data (most recent year) was missing. Now we build chunks
 * anchored to TODAY and walk backwards, so the most recent data is always
 * fetched first and guaranteed to be present.
 *
 * Each chunk is max 360 days (Fyers limit is 365 days per daily request).
 */
async function fetchDailyCandles(symbol, lookbackDays) {
  const fyers = getFyersClient();
  const now = Math.floor(Date.now() / 1000);
  const todayEnd = endOfTodayIST(now);
  const totalFrom = now - lookbackDays * 86400;

  const CHUNK_DAYS = 360;
  const TIMEOUT_MS = 20_000;
  const chunkSizeS = CHUNK_DAYS * 86400;

  // Build chunks from today BACKWARDS (newest first)
  const chunksNewestFirst = [];
  let chunkEnd = todayEnd;
  while (chunkEnd > totalFrom) {
    const chunkStart = Math.max(totalFrom, chunkEnd - chunkSizeS);
    chunksNewestFirst.push({ from: chunkStart, to: chunkEnd });
    chunkEnd = chunkStart - 1;
  }

  console.log(
    `[Fyers] fetchDailyCandles: ${chunksNewestFirst.length} chunks (newest first) | ` +
    `${new Date(totalFrom * 1000).toISOString().slice(0, 10)} → ` +
    `${new Date(todayEnd * 1000).toISOString().slice(0, 10)}`
  );

  function parseRaw(res) {
    if (!res || res.s !== "ok") return null;
    return (res.candles || [])
      .map((c) => ({
        time: normalizeDailyTimestamp(c[0]) * 1000,
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }))
      .filter(
        (c) =>
          Number.isFinite(c.time) && c.time > 0 &&
          Number.isFinite(c.open) && c.open > 0 &&
          Number.isFinite(c.close) && c.close > 0
      );
  }

  const allCandles = [];
  let successChunks = 0;
  let failChunks = 0;

  // Fetch newest-first so recent data is always present even if old chunks fail
  for (const chunk of chunksNewestFirst) {
    const label = `${new Date(chunk.from * 1000).toISOString().slice(0, 10)}→${new Date(chunk.to * 1000).toISOString().slice(0, 10)}`;
    let res;
    try {
      res = await Promise.race([
        fyers.getHistory({
          symbol, resolution: "D", date_format: "0",
          range_from: String(chunk.from), range_to: String(chunk.to), cont_flag: "1",
        }),
        rejectAfter(TIMEOUT_MS, `fetchDailyCandles ${label}`),
      ]);
    } catch (err) {
      failChunks++;
      console.warn(`[Fyers] Daily chunk FAILED ${label}: ${err.message}`);
      continue;
    }

    const parsed = parseRaw(res);
    if (parsed && parsed.length > 0) {
      successChunks++;
      allCandles.push(...parsed);
      console.log(`[Fyers] Daily chunk OK ${label}: ${parsed.length} candles`);
    } else {
      failChunks++;
      console.warn(`[Fyers] Daily chunk EMPTY ${label}: s=${res?.s} msg="${res?.message || res?.errmsg || "?"}"`);
    }
  }

  console.log(`[Fyers] fetchDailyCandles: ${successChunks} ok / ${failChunks} failed / ${allCandles.length} total`);

  if (allCandles.length === 0) return [];

  // Deduplicate and sort ascending
  const sorted = dedupSortCandles(allCandles);

  console.log(
    `[Fyers] Daily final: ${sorted.length} candles | ` +
    `${new Date(sorted[0].time).toISOString().slice(0, 10)} → ` +
    `${new Date(sorted[sorted.length - 1].time).toISOString().slice(0, 10)}`
  );

  return sorted;
}

// ── Aggregate daily → weekly ──────────────────────────────────────────────────
function aggregateDailyToWeekly(dailyCandles) {
  const weekMap = new Map();
  for (const d of dailyCandles) {
    const anchorMs = weekAnchor(Math.floor(d.time / 1000)) * 1000;
    if (!weekMap.has(anchorMs)) {
      weekMap.set(anchorMs, {
        time: anchorMs, open: d.open, high: d.high,
        low: d.low, close: d.close, volume: d.volume,
      });
    } else {
      const w = weekMap.get(anchorMs);
      w.high = Math.max(w.high, d.high);
      w.low = Math.min(w.low, d.low);
      w.close = d.close;
      w.volume += d.volume;
    }
  }
  return [...weekMap.values()].sort((a, b) => a.time - b.time);
}

// ── Fetch historical candles ──────────────────────────────────────────────────
async function fetchCandles(symbol, resolution, count = 10000, lookbackDaysOverride = null) {
  const fyers = getFyersClient();
  const now = Math.floor(Date.now() / 1000);
  const isWeekly = resolution === 10080 || String(resolution).toUpperCase() === "W";
  const isDaily = resolution === 1440 || String(resolution).toUpperCase() === "D";
  const lookbackDays = lookbackDaysOverride != null ? lookbackDaysOverride : calcLookbackDays(resolution);

  // ── WEEKLY ────────────────────────────────────────────────────────────────
  if (isWeekly) {
    console.log(`[Fyers] Weekly: aggregating from daily over ${lookbackDays}d`);
    const daily = await fetchDailyCandles(symbol, lookbackDays);
    if (daily.length === 0) throw new Error(`[Fyers] No daily candles for ${symbol} — cannot build weekly`);
    const weekly = aggregateDailyToWeekly(daily);
    console.log(
      `[Fyers] ${symbol} W: ${daily.length} daily → ${weekly.length} weekly | ` +
      `${new Date(weekly[0].time).toISOString().slice(0, 10)} → ` +
      `${new Date(weekly[weekly.length - 1].time).toISOString().slice(0, 10)}`
    );
    return weekly;
  }

  // ── DAILY ────────────────────────────────────────────────────────────────
  if (isDaily) {
    const daily = await fetchDailyCandles(symbol, lookbackDays);
    if (daily.length === 0) throw new Error(`[Fyers] No daily candles for ${symbol}`);
    console.log(
      `[Fyers] ${symbol} D: ${daily.length} candles | ` +
      `${new Date(daily[0].time).toISOString().slice(0, 10)} → ` +
      `${new Date(daily[daily.length - 1].time).toISOString().slice(0, 10)}`
    );
    return daily;
  }

  // ── INTRADAY ──────────────────────────────────────────────────────────────
  const fyersResolution = String(resolution);
  const CHUNK_DAYS = 90;
  const TIMEOUT_MS = 15_000;
  const chunkSizeS = CHUNK_DAYS * 86400;
  const todayEnd = endOfTodayIST(now);
  const totalFrom = now - lookbackDays * 86400;

  function parseIntraday(res) {
    if (!res || res.s !== "ok") return null;
    return (res.candles || [])
      .map((c) => ({ time: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
      .filter(
        (c) =>
          Number.isFinite(c.time) && c.time > 0 &&
          Number.isFinite(c.open) && c.open > 0 &&
          Number.isFinite(c.close) && c.close > 0
      );
  }

  // Intraday: also newest-first so recent data is guaranteed
  const chunks = [];
  let chunkEnd = todayEnd;
  while (chunkEnd > totalFrom) {
    const chunkStart = Math.max(totalFrom, chunkEnd - chunkSizeS);
    chunks.push({ from: chunkStart, to: chunkEnd }); // newest first
    chunkEnd = chunkStart - 1;
  }

  const allCandles = [];
  for (const chunk of chunks) {
    let res;
    try {
      res = await Promise.race([
        fyers.getHistory({
          symbol, resolution: fyersResolution, date_format: "0",
          range_from: String(chunk.from), range_to: String(chunk.to), cont_flag: "1",
        }),
        rejectAfter(TIMEOUT_MS, `fetchCandles intraday`),
      ]);
    } catch (err) {
      // Rate-limit errors are transient (Fyers' window resets quickly) —
      // one short retry recovers most of them instead of silently giving
      // up and serving stale data for the rest of the session. Any other
      // error (timeout, bad symbol, etc.) still skips immediately as before.
      if (/limit/i.test(err.message)) {
        console.warn(`[Fyers] Intraday chunk hit rate limit — retrying once in 1.5s...`);
        await new Promise((r) => setTimeout(r, 1500));
        try {
          res = await Promise.race([
            fyers.getHistory({
              symbol, resolution: fyersResolution, date_format: "0",
              range_from: String(chunk.from), range_to: String(chunk.to), cont_flag: "1",
            }),
            rejectAfter(TIMEOUT_MS, `fetchCandles intraday`),
          ]);
        } catch (err2) {
          console.warn(`[Fyers] Intraday chunk failed again after retry (${err2.message}) — skipping`);
          continue;
        }
      } else {
        console.warn(`[Fyers] Intraday chunk failed (${err.message}) — skipping`);
        continue;
      }
    }
    const parsed = parseIntraday(res);
    if (parsed && parsed.length > 0) allCandles.push(...parsed);
    else console.warn(`[Fyers] Intraday chunk empty: ${res?.message || res?.errmsg || "unknown"}`);
  }

  if (allCandles.length === 0) throw new Error(`Fyers getHistory returned no candles for ${symbol} res=${fyersResolution}`);

  const deduped = dedupSortCandles(allCandles);

  console.log(`[Fyers] ${symbol} ${fyersResolution}: ${deduped.length} candles over ${lookbackDays}d (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`);
  return deduped;
}


/**
 * fetchOptionChain -- returns the REAL, broker-confirmed option symbols for
 * an underlying's option chain, for a specific expiry (or the nearest one
 * if no timestamp given).
 *
 * ROOT-CAUSE NOTE: hand-building option symbols locally (guessing at Fyers'
 * date-encoding scheme) produces strings Fyers frequently rejects with
 * "Invalid symbol provided" -- a documented, widely-hit problem, not unique
 * to this project. Fyers' own `getOptionChain` response already includes
 * the literal, always-valid `symbol` string for every strike in
 * `data.optionsChain[].symbol` -- this function returns that directly
 * instead of constructing anything.
 *
 * @param {string} underlyingSymbol  e.g. "NSE:NIFTY50-INDEX", "BSE:SENSEX-INDEX"
 * @param {object} [opts]
 * @param {number} [opts.strikeCount=20]  strikes each side of ATM to request
 * @param {string} [opts.timestamp]       Fyers expiry timestamp (epoch seconds,
 *                                        as a string) to select a specific
 *                                        expiry -- omit for the nearest one.
 * @returns {Promise<{expiries: Array<{date,expiry}>, strikes: Array<{symbol,strike_price,option_type,ltp,oi}>}>}
 *          Returns { expiries: [], strikes: [] } if unavailable.
 */
async function fetchOptionChain(underlyingSymbol, opts = {}) {
  const { strikeCount = 20, timestamp = "" } = opts;
  try {
    const fyers = getFyersClient();
    const res = await Promise.race([
      fyers.getOptionChain({ symbol: underlyingSymbol, strikecount: strikeCount, timestamp }),
      rejectAfter(10_000, "fetchOptionChain"),
    ]);
    if (!res || res.s !== "ok" || !res.data) {
      console.warn(`[Fyers] fetchOptionChain: no data for ${underlyingSymbol} -- s=${res?.s} msg="${res?.message || res?.errmsg || "?"}"`);
      return { expiries: [], strikes: [] };
    }
    const expiries = (res.data.expiryData || [])
      .map((e) => ({ date: e.date || e.expiry, expiry: e.expiry || e.date }))
      .filter((e) => e.date);
    // optionsChain entries carry the real tradable symbol per strike -- this
    // is the whole point of calling this function instead of building one.
    const strikes = (res.data.optionsChain || [])
      .filter((s) => s && s.symbol)
      .map((s) => ({
        symbol: s.symbol,
        strike_price: Number(s.strike_price),
        option_type: s.option_type, // "CE" | "PE"
        ltp: Number(s.ltp) || 0,
        oi: Number(s.oi) || 0,
      }));
    console.log(`[Fyers] fetchOptionChain ${underlyingSymbol}: ${expiries.length} expiries, ${strikes.length} real strike symbols`);
    return { expiries, strikes };
  } catch (err) {
    console.warn(`[Fyers] fetchOptionChain error for ${underlyingSymbol}:`, err.message);
    return { expiries: [], strikes: [] };
  }
}

module.exports = { loadToken, saveToken, getAuthURL, generateToken, validateToken, fetchCandles, fetchOptionChain };