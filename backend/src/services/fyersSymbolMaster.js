/**
 * backend/src/services/fyersSymbolMaster.js
 * ─────────────────────────────────────────────────────────────────────────
 * UNIVERSAL symbol search for the Data Export feature.
 *
 * routes/symbolsRouter.js's getSymbols() is a hand-curated list (~200
 * equities + a handful of indices/commodities, see that file's own header
 * comment) — deliberately small and vetted for the rest of this app
 * (Scanner/Backtest/Charts). It does NOT contain every NSE/BSE-listed
 * symbol, so something like "BEML" (a real, tradable NSE equity, just not
 * one of the curated 202) has no way to be found there.
 *
 * Fyers itself separately publishes free, no-auth, daily-updated "symbol
 * master" files — the exact list of every symbol Fyers' broker API will
 * accept — at fixed public URLs (documented across Fyers' own community
 * forum and every third-party Fyers integration, e.g. the open-source
 * OpenAlgo project's broker/fyers/database/master_contract_db.py, whose
 * column layout below is taken from):
 *   https://public.fyers.in/sym_details/NSE_CM.csv   — NSE equities + indices
 *   https://public.fyers.in/sym_details/NSE_FO.csv   — NSE futures + options
 *   https://public.fyers.in/sym_details/BSE_CM.csv   — BSE equities + indices
 *   https://public.fyers.in/sym_details/BSE_FO.csv   — BSE futures + options
 *
 * Each row's confirmed column order (21 comma-separated fields, no header
 * row in the file itself):
 *   0 fytoken, 1 name, 2 exchangeInstrumentType, 3 lotSize, 4 tickSize,
 *   5 isin, 6 tradingSession, 7 lastUpdateDate, 8 expiryEpochSeconds,
 *   9 symbol (the real tradable Fyers ticker — e.g. "NSE:BEML-EQ",
 *     "NSE:BEML26NOVFUT", "NSE:BEML26NOV3200CE" — this is the whole point
 *     of using this file instead of guessing symbols),
 *   10 exchangeCode, 11 segmentCode, 12 scripCode, 13 underlyingSymbol,
 *   14 underlyingScripCode, 15 strikePrice, 16 optionType ("CE"/"PE"/"XX"),
 *   17 underlyingFyToken, 18-20 reserved.
 *
 * CLASSIFICATION (no numeric-code guesswork needed — derived purely from
 * columns 8 and 16, which are unambiguous):
 *   optionType is CE/PE            → "option"
 *   optionType is XX AND has an expiry → "future"
 *   optionType is XX AND no expiry     → "spot" (equity/index)
 *
 * SCOPE NOTE (deliberate, not an oversight): MCX commodities are NOT
 * included here. MCX's own public master file is only published as JSON
 * with a different, less-documented shape (unlike the four CSVs above,
 * which have confirmed real sample rows to build against). Rather than
 * guess at an unverified schema and risk silently-wrong MCX results, MCX
 * commodity search keeps using the existing, already-tested
 * symbols/commodity.json + symbolsRouter.js's buildFutures() — that part
 * of "Data Export" search is unchanged. If/when the MCX JSON schema is
 * confirmed, it can be added here the same way.
 *
 * CACHING: Fyers updates these files roughly once a day. Refetched every
 * CACHE_TTL_MS and served from memory in between — one shared cache for
 * every request, not one download per search keystroke.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const axios = require("axios");
const { exchangeOf } = require("../routes/symbolsRouter");

const SOURCES = {
  NSE_CM: "https://public.fyers.in/sym_details/NSE_CM.csv",
  NSE_FO: "https://public.fyers.in/sym_details/NSE_FO.csv",
  BSE_CM: "https://public.fyers.in/sym_details/BSE_CM.csv",
  BSE_FO: "https://public.fyers.in/sym_details/BSE_FO.csv",
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — Fyers refreshes these ~once/day
const FETCH_TIMEOUT_MS = 20_000;

let _cache = { entries: [], fetchedAt: 0, sourceErrors: [] };
let _inFlight = null; // dedupes concurrent refreshes (e.g. two users searching at the same moment)

/**
 * One CSV row → a plain entry, or null if the row doesn't have a usable
 * symbol (col 9) — malformed/short rows are skipped, never thrown on, so
 * one bad line can't take down the whole search feature.
 */
function parseRow(cols, exchangeLabel) {
  if (!cols || cols.length < 17) return null;
  const symbol = (cols[9] || "").trim();
  if (!symbol) return null;

  const name = (cols[1] || "").trim();
  const underlying = (cols[13] || "").trim() || symbol.split(":").pop();
  const optionType = (cols[16] || "XX").trim().toUpperCase();
  const expiryEpochRaw = (cols[8] || "").trim();
  const expiryEpoch = expiryEpochRaw ? Number(expiryEpochRaw) : 0;
  const strikeRaw = (cols[15] || "").trim();
  const strike = strikeRaw ? Number(strikeRaw) : null;

  let type;
  if (optionType === "CE" || optionType === "PE") type = "option";
  else if (expiryEpoch > 0) type = "future";
  else type = "spot";

  const expiryDate = expiryEpoch > 0
    ? new Date(expiryEpoch * 1000).toISOString().slice(0, 10)
    : null;

  return {
    symbol,
    name: name || symbol,
    underlying,
    exchange: exchangeOf({ symbol }) || exchangeLabel,
    type, // "spot" | "future" | "option"
    expiryDate,
    strike: strike != null && strike > 0 ? strike : null,
    optionType: type === "option" ? optionType : null,
  };
}

/**
 * Minimal CSV line splitter. Every confirmed real sample row from Fyers
 * (see this file's header) has plain comma-separated fields with no
 * embedded commas or quoting, so a straight split is correct for the data
 * this actually receives — this quote-aware version is only a safety net
 * in case a future field ever contains one, so a stray comma can't
 * silently shift every column after it.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvText(text, exchangeLabel) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseRow(splitCsvLine(line), exchangeLabel);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function downloadOne(key, url) {
  const res = await axios.get(url, { responseType: "text", timeout: FETCH_TIMEOUT_MS });
  const exchangeLabel = key.startsWith("BSE") ? "BSE" : "NSE";
  return parseCsvText(res.data, exchangeLabel);
}

/**
 * Refreshes the in-memory cache. Each of the 4 sources is fetched
 * independently — if one fails (network blip, Fyers hiccup), the others
 * still populate the cache rather than the whole search feature going
 * empty. Matches this repo's existing "skip a failed chunk, don't die"
 * philosophy (see fyers/client.js's fetchDailyCandles()/fetchCandles()).
 */
async function refresh() {
  const sourceErrors = [];
  const results = await Promise.all(
    Object.entries(SOURCES).map(async ([key, url]) => {
      try {
        return await downloadOne(key, url);
      } catch (err) {
        console.warn(`[FyersSymbolMaster] Failed to download ${key}: ${err.message}`);
        sourceErrors.push({ source: key, error: err.message });
        return [];
      }
    })
  );

  const entries = results.flat();
  _cache = { entries, fetchedAt: Date.now(), sourceErrors };
  console.log(
    `[FyersSymbolMaster] Refreshed: ${entries.length} symbols` +
    (sourceErrors.length ? ` (${sourceErrors.length} source(s) failed: ${sourceErrors.map(e => e.source).join(", ")})` : "")
  );
  return _cache;
}

/** Ensures the cache is populated and fresh enough, without ever running two refreshes at once. */
async function ensureFresh() {
  const isStale = Date.now() - _cache.fetchedAt > CACHE_TTL_MS;
  const isEmpty = _cache.entries.length === 0;
  if (!isStale && !isEmpty) return _cache;
  if (_inFlight) return _inFlight; // another caller is already refreshing — wait on that one
  _inFlight = refresh().finally(() => { _inFlight = null; });
  return _inFlight;
}

/**
 * @param {string} query           free text — matched against symbol ticker, name, and underlying
 * @param {object} [opts]
 * @param {"spot"|"future"|"option"} [opts.type]   restrict to one segment
 * @param {"NSE"|"BSE"} [opts.exchange]
 * @param {number} [opts.limit=50]
 * @returns {Promise<object[]>}
 */
async function searchUniversalSymbols(query, opts = {}) {
  const { type, exchange, limit = 50 } = opts;
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  await ensureFresh();

  let pool = _cache.entries;
  if (type) pool = pool.filter((e) => e.type === type);
  if (exchange) pool = pool.filter((e) => e.exchange === exchange.toUpperCase());

  const starts = [];
  const includes = [];
  for (const e of pool) {
    const ticker = e.symbol.split(":").pop().toLowerCase();
    const nameLower = e.name.toLowerCase();
    const underlyingLower = e.underlying.toLowerCase();
    if (ticker.startsWith(q) || underlyingLower.startsWith(q) || nameLower.startsWith(q)) {
      starts.push(e);
    } else if (ticker.includes(q) || nameLower.includes(q)) {
      includes.push(e);
    }
    if (starts.length >= limit) break; // pool is large (NSE_FO alone is tens of thousands of rows) — stop early once satisfied
  }

  return [...starts, ...includes].slice(0, limit);
}

/** Forces a fresh download on next search — exposed for a manual admin refresh, same shape as symbolsRouter's POST /refresh. */
async function refreshUniversalSymbols() {
  return refresh();
}

function getCacheInfo() {
  return { count: _cache.entries.length, fetchedAt: _cache.fetchedAt, sourceErrors: _cache.sourceErrors };
}

module.exports = { searchUniversalSymbols, refreshUniversalSymbols, getCacheInfo };
