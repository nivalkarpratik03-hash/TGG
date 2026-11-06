/**
 * backend/src/parrva/marketData.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fyers REST helpers for the live PaRRVA report, using the SECOND Fyers account
 * (Recorder). If account 2 has no token yet, REST falls back to account 1 so the
 * page still works (only a handful of calls: option-chain lookups and 1-minute history).
 *
 *   resolveSymbol(rec)   PaRRVA call -> real Fyers symbol, e.g. NIFTY 24350 CE 2026-11-09 -> NSE:NIFTY2611924350CE
 *                        (read from Fyers' own option chain, never built by hand, so weekly/monthly formats are always right)
 *   fetchMinuteCandles(symbol, fromMs, toMs)   1-minute candles [{t (sec), o, h, l, c, v}]
 *
 * All calls go through one queue with a small gap, so we stay far below Fyers' limits.
 */
"use strict";

const accounts = require("../fyers/accounts");

const UNDERLYING = {
  NIFTY: "NSE:NIFTY50-INDEX",
  NIFTY50: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  SENSEX: "BSE:SENSEX-INDEX",
  BANKEX: "BSE:BANKEX-INDEX",
};
const underlyingSymbol = (name) => UNDERLYING[String(name || "").toUpperCase().replace(/\s+/g, "")] || null;

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

// One REST call at a time, >= 250 ms apart, and at most PER_MIN calls in any 60 s. Fyers Standard plan allows
// 10/s and 50/minute per account; the recorder uses the same account for ~11 calls a minute, so this side
// keeps to 20 a minute and simply waits when the budget is used up.
const PER_MIN = Math.max(5, Number(process.env.PARRVA_REST_PER_MIN) || 20);
let chain = Promise.resolve();
let lastCall = 0;
const recent = [];   // timestamps of the calls in the last 60 s
function queued(fn) {
  const run = async () => {
    for (;;) {
      while (recent.length && Date.now() - recent[0] > 60000) recent.shift();
      if (recent.length < PER_MIN) break;
      await new Promise((r) => setTimeout(r, 60000 - (Date.now() - recent[0]) + 50));
    }
    const wait = 250 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    recent.push(lastCall);
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Which account REST uses right now: account 2 if it has a token, else account 1. */
function restClient() {
  const a2 = accounts.account2;
  if (a2.configured() && a2.loadToken()) return { client: a2.getClient(), account: 2 };
  const { fyersModel } = require("fyers-api-v3");
  const client = require("../fyers/client");
  const token = client.loadToken();
  if (!token || !process.env.APP_ID) throw new Error("No Fyers token (log in account 2 on the Admin page)");
  const f = new fyersModel({ path: "", enableLogging: false });
  f.setAppId(process.env.APP_ID);
  f.setRedirectUrl(client.getRedirectUri());
  f.setAccessToken(token);
  return { client: f, account: 1 };
}

// underlying|expiry -> { at, map: "strike|CE" -> symbol }
const chainCache = new Map();
// underlying -> { at, expiries: [{date: "YYYY-MM-DD", ts}] }
const expiryCache = new Map();
const ddmmyyyyToIso = (d) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

async function getChain(underlying, timestamp) {
  const { client } = restClient();
  const res = await queued(() => timeout(client.getOptionChain({ symbol: underlying, strikecount: 50, timestamp: timestamp || "" }), 12000, "getOptionChain"));
  if (!res || res.s !== "ok" || !res.data) throw new Error(`option chain ${underlying}: ${(res && (res.message || res.errmsg)) || "no data"}`);
  return res.data;
}

async function expiriesOf(underlying) {
  const hit = expiryCache.get(underlying);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.expiries;
  const data = await getChain(underlying, "");
  const expiries = (data.expiryData || []).map((e) => ({ date: ddmmyyyyToIso(e.date), ts: String(e.expiry || "") })).filter((e) => e.date && e.ts);
  expiryCache.set(underlying, { at: Date.now(), expiries });
  return expiries;
}

/** PaRRVA call -> { symbol } or { error }. Cached; at most one option-chain call per expiry every 5 minutes. */
async function resolveSymbol(rec) {
  try {
    if (!rec || !rec.strike || !["CE", "PE"].includes(rec.cp) || !rec.expiry) return { error: "call has no strike / CE-PE / expiry" };
    const und = underlyingSymbol(rec.underlying);
    if (!und) return { error: `unknown underlying ${rec.underlying}` };
    const key = `${und}|${rec.expiry}`;
    const want = `${Number(rec.strike)}|${rec.cp}`;
    let c = chainCache.get(key);
    if (c && c.map.has(want)) return { symbol: c.map.get(want), underlying: und };
    if (c && Date.now() - c.at < 5 * 60 * 1000) return { error: `strike ${rec.strike} ${rec.cp} not in Fyers option chain for ${rec.expiry}` };
    const exp = (await expiriesOf(und)).find((e) => e.date === rec.expiry);
    if (!exp) return { error: `expiry ${rec.expiry} not listed by Fyers for ${und}` };
    const data = await getChain(und, exp.ts);
    const map = new Map();
    for (const o of data.optionsChain || []) {
      if (o && o.symbol && (o.option_type === "CE" || o.option_type === "PE")) map.set(`${Number(o.strike_price)}|${o.option_type}`, o.symbol);
    }
    c = { at: Date.now(), map };
    chainCache.set(key, c);
    return map.has(want) ? { symbol: map.get(want), underlying: und } : { error: `strike ${rec.strike} ${rec.cp} not in Fyers option chain for ${rec.expiry}` };
  } catch (err) {
    return { error: err.message };
  }
}

/** 1-minute candles between two ms timestamps -> [{t, o, h, l, c, v}] (t in epoch seconds). */
async function fetchMinuteCandles(symbol, fromMs, toMs) {
  const { client } = restClient();
  const res = await queued(() => timeout(client.getHistory({
    symbol, resolution: "1", date_format: "0",
    range_from: String(Math.floor(fromMs / 1000)), range_to: String(Math.floor(toMs / 1000)), cont_flag: "1",
  }), 15000, "getHistory"));
  if (!res || res.s !== "ok") {
    if (res && res.s === "no_data") return [];
    throw new Error(`history ${symbol}: ${(res && (res.message || res.errmsg)) || "failed"}`);
  }
  return (res.candles || [])
    .filter((c) => Array.isArray(c) && c.length >= 5)
    .map((c) => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5]) || 0 }));
}

module.exports = { resolveSymbol, fetchMinuteCandles, underlyingSymbol, restClient };
