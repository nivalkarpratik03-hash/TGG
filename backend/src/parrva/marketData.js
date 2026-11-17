/**
 * backend/src/parrva/marketData.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fyers REST helpers for the live PaRRVA report, using the SECOND Fyers account
 * (Recorder) only. Account 1 (charts) is never used here. If account 2 is not logged in,
 * nothing is sent to Fyers (only a handful of calls anyway: option-chain lookups and 1-minute history).
 *
 *   resolveSymbol(rec)   PaRRVA call -> real Fyers symbol, e.g. NIFTY 24350 CE 2026-11-09 -> NSE:NIFTY2611924350CE
 *                        (2026-11-16: also stock options via NSE:<NAME>-EQ's option chain, MCX options via the MCX future's
 *                        option chain, futures / equity checked with a quote - no symbol files)
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

/**
 * PaRRVA REST (symbol lookup, 1-minute history) uses ONLY account 2 (the recorder account).
 * Account 1 is kept for charts, so its rate limit is never touched here (2026-11-09).
 * No token or an expired token -> nothing is sent to Fyers; the caller shows "account 2 not logged in".
 */
const NOT_LOGGED_IN = "Account 2 (recorder) is not logged in or its token expired - log in on the Admin page";
function restClient() {
  const a2 = accounts.account2;
  const info = a2.configured() ? a2.getTokenInfo() : null;
  if (!info || !info.exists || info.expired) throw new Error(NOT_LOGGED_IN);
  return { client: a2.getClient(), account: 2 };
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

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const cleanName = (x) => String(x || "").toUpperCase().replace(/\s+/g, "");
/** Fyers monthly future name for a YYYY-MM-DD expiry (+k months): MCX:CRUDEOIL26DECFUT, NSE:COFORGE26NOVFUT. */
function futName(exch, und, isoDate, k = 0) {
  const [y, m] = String(isoDate).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${exch}:${cleanName(und)}${String(d.getUTCFullYear()).slice(2)}${MON[d.getUTCMonth()]}FUT`;
}
const kindOf = (rec) => {
  const ins = String((rec && rec.instrument) || "").toUpperCase();
  if (["CE", "PE"].includes(rec && rec.cp) || /^OPT/.test(ins) || ins === "IDO") return "option";
  if (/^FUT/.test(ins)) return "future";
  return "equity";
};
const failCache = new Map();   // underlying -> { at, error }: Fyers had no option chain for it (retried after 30 min)

/**
 * Option of one underlying -> { symbol } or { error }. Same way as the charts (fyers/client.js fetchOptionChain):
 * Fyers' option chain of the underlying gives the real expiry list and the exact symbol of every strike.
 * Cached; at most one option-chain call per underlying + expiry every 5 minutes.
 */
async function optionFromChain(rec, und) {
  const key = `${und}|${rec.expiry}`;
  const want = `${Number(rec.strike)}|${rec.cp}`;
  let c = chainCache.get(key);
  if (c && c.map.has(want)) return { symbol: c.map.get(want), underlying: und };
  if (c && Date.now() - c.at < 5 * 60 * 1000) return { error: `strike ${rec.strike} ${rec.cp} not in Fyers option chain for ${rec.expiry}` };
  const exp = (await expiriesOf(und)).find((e) => e.date === rec.expiry);
  if (!exp) return { error: `expiry ${rec.expiry} not listed by Fyers for ${und}`, noExpiry: true };
  const data = await getChain(und, exp.ts);
  const map = new Map();
  for (const o of data.optionsChain || []) {
    if (o && o.symbol && (o.option_type === "CE" || o.option_type === "PE")) map.set(`${Number(o.strike_price)}|${o.option_type}`, o.symbol);
  }
  c = { at: Date.now(), map };
  chainCache.set(key, c);
  return map.has(want) ? { symbol: map.get(want), underlying: und } : { error: `strike ${rec.strike} ${rec.cp} not in Fyers option chain for ${rec.expiry}` };
}
async function chainOrFail(rec, und) {
  const f = failCache.get(und);
  if (f && Date.now() - f.at < 30 * 60000) return { error: f.error, noExpiry: true };
  try { return await optionFromChain(rec, und); }
  catch (e) {
    if (e.message === NOT_LOGGED_IN) throw e;
    failCache.set(und, { at: Date.now(), error: e.message });
    return { error: e.message, noExpiry: true };
  }
}
/** A symbol we had to build (future / equity) is used only when Fyers quotes it. */
const verified = new Map();   // symbol -> { at, ok, error }
async function verifySymbol(sym) {
  const v = verified.get(sym);
  if (v && (v.ok || Date.now() - v.at < 30 * 60000)) return v.ok ? { symbol: sym } : { error: v.error };
  const { client } = restClient();
  const res = await queued(() => timeout(client.getQuotes([sym]), 12000, "getQuotes"));
  const row = res && Array.isArray(res.d) ? res.d.find((x) => x && x.n === sym) : null;
  const ok = !!(res && res.s === "ok" && row && row.s !== "error" && row.v && !row.v.errmsg && Number.isFinite(Number(row.v.lp)));
  const error = ok ? null : `${sym} is not a valid Fyers symbol (${(row && row.v && row.v.errmsg) || (res && (res.message || res.errmsg)) || "no quote"})`;
  verified.set(sym, { at: Date.now(), ok, error });
  return ok ? { symbol: sym } : { error };
}

/**
 * PaRRVA call -> { symbol } or { error }. Never guesses: every symbol comes from Fyers or is checked with Fyers.
 *   index option (NIFTY, SENSEX ...)   option chain of the index (as before)
 *   stock option (OPTSTK, COFORGE)     option chain of NSE:COFORGE-EQ, PaRRVA's expiry, exact strike + CE/PE
 *   MCX option                         option chain of the MCX future (that month's, else next month's) whose
 *                                      expiry list has PaRRVA's expiry - same as the chart's option chain
 *   future (stock / index / MCX)       Fyers monthly name (e.g. MCX:CRUDEOIL26DECFUT), used only if Fyers quotes it
 *   equity                             NSE:<NAME>-EQ, used only if Fyers quotes it
 * All on account 2 (one or two calls per new contract, cached).
 */
async function resolveSymbol(rec) {
  try {
    if (!rec || !rec.underlying) return { error: "call has no contract name" };
    const exch = String(rec.exchange || "NSE").toUpperCase();
    const und = cleanName(rec.underlying);
    const kind = kindOf(rec);
    if (kind === "option") {
      if (!rec.strike || !["CE", "PE"].includes(rec.cp) || !rec.expiry) return { error: "call has no strike / CE-PE / expiry" };
      const idx = underlyingSymbol(und);
      if (idx) return await optionFromChain(rec, idx);
      if (exch === "MCX") {
        const errs = [];
        for (const k of [0, 1]) {
          const r = await chainOrFail(rec, futName("MCX", und, rec.expiry, k));
          if (r.symbol || !r.noExpiry) return r;
          errs.push(r.error);
        }
        return { error: `MCX option ${und} ${rec.strike} ${rec.cp} ${rec.expiry}: ${errs.join(" / ")}` };
      }
      if (exch !== "NSE") return { error: `${exch} stock options are not supported yet` };
      return await chainOrFail(rec, `NSE:${und}-EQ`);
    }
    if (kind === "future") {
      if (!rec.expiry) return { error: "call has no expiry" };
      return await verifySymbol(futName(exch === "MCX" ? "MCX" : exch, und, rec.expiry));
    }
    if (exch !== "NSE") return { error: `${exch} equity is not supported yet` };
    return await verifySymbol(`NSE:${und}-EQ`);
  } catch (err) {
    return { error: err.message };
  }
}
const isIndexOption = (rec) => kindOf(rec) === "option" && !!underlyingSymbol(rec && rec.underlying);

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

module.exports = { resolveSymbol, fetchMinuteCandles, underlyingSymbol, restClient, NOT_LOGGED_IN, isIndexOption, futName };
