/**
 * backend/src/parrva/recorderWorker.js  (NEW 2026-11-05, REWRITTEN same day: same data + Parquet as the Telegram bot)
 * ─────────────────────────────────────────────────────────────────────────────
 * The dashboard RECORDER. Runs as its OWN child process (forked by recorderManager.js), logged in with the
 * SECOND Fyers account (the Fyers data socket is a process-wide singleton, so it cannot share the main
 * backend process with the chart stream of account 1).
 *
 * It records exactly what backend/src/scripts/orderFlowRecorder.js records (the collector behind the files
 * the Telegram bot sends), using that file's own Recorder class (required, NOT changed):
 *   NIFTY 50 index, the NIFTY month future, ATM +-6 strikes CE+PE of the weekly expiry (subscribed once),
 *   every quote tick + 5-level depth, 50-level depth (TBT) for the future + the ATM pair (re-picked as price
 *   moves, rebuilt book = src "rebuilt-num"), REST quote snapshots every 10 s, REST option chain every 60 s
 *   (ATM +-2, IV + Greeks), REST 1-minute candles, whole-day candle backfill at the end.
 * PLUS, for the PaRRVA page: every option of today's PaRRVA calls is recorded too (if outside the window),
 * and up to 2 of the newest open calls get 50-level depth (5 per connection: future + ATM pair + 2).
 *
 * At the end of the day (stop at / after 15:25 IST) it writes the Parquet files, same columns as the bot's:
 *   <PARRVA_DATA_DIR>/recordings/<date>/parquet/index.parquet, futures.parquet, options.parquet
 * Folder layout = orderFlowRecorder's (symbols/<SYMBOL>/quotes.jsonl ..., events.jsonl, rest_*.jsonl).
 *
 * IPC in : {cmd:"subscribe", symbols:[...], tbt:[...], meta:{sym:{expiry}}}  {cmd:"stop", why, export?}
 * IPC out: {hb}  {ready}  {snap:{status, symbols:{sym:{...}}, candles:{sym:[...]}}}  {log}  {exported:{ok, report}}
 * Env    : REC_APP_ID, REC_TOKEN_FILE, REC_OUT_DIR, RECORDER_TBT (false = no 50-level depth)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const send = (m) => { try { if (process.send) process.send(m); } catch { /* parent gone */ } };
// Log lines go to the manager (it prints them once as "[Recorder] [worker] ..."); printed here only without a parent.
const log = (...a) => { const s = a.map(String).join(" "); if (process.send) send({ log: s }); else console.log(`[RecorderWorker] ${s}`); };
// The collector's Recorder prints every event (track x30, connects ...) - all of it is in events.jsonl already.
// Keep the terminal quiet: only problems are printed.
{
  const out = console.log.bind(console);
  console.log = (...a) => {
    const line = a.map(String).join(" ");
    if (/^\[\d\d:\d\d:\d\d\] /.test(line) && !/error|dead|DEAD|TOKEN|stall|silent|failed|outside/i.test(line)) return;
    out(...a);
  };
}

const appId = process.env.REC_APP_ID;
const tokenFile = process.env.REC_TOKEN_FILE;
const outDir = process.env.REC_OUT_DIR;
const useTbt = process.env.RECORDER_TBT !== "false";
let token = "";
try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* checked below */ }
if (!appId || !token || !outDir) {
  log(`cannot start: ${!appId ? "APP_ID_2 missing" : !token ? "account 2 has no token (log in on Admin)" : "no output folder"}`);
  setTimeout(() => process.exit(2), 200);
  return;   // eslint-disable-line no-useless-return
}

let fyers;
try { fyers = require("fyers-api-v3"); } catch (e) { log("fyers-api-v3 not installed:", e.message); setTimeout(() => process.exit(2), 200); return; }   // eslint-disable-line no-useless-return
const { fyersModel, fyersDataSocket, fyersTbtSocket } = fyers;
const { Recorder, AtmTracker } = require("../scripts/orderFlowRecorder");   // the collector's own code, unchanged
const { exportParquet } = require("./ofrExport");

// ── helpers (same behaviour as orderFlowRecorder.js) ─────────────────────────
const IST_MS = 19800000;
const istStamp = (ms) => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 23);
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMin = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const num = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const n = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);
// Fyers Standard plan: 10 requests / second AND 50 requests / minute (message "...plan limit of 50 requests/minute").
const isRateLimit = (e) => !!e && (e.code === -360 || e.code === 429 || /requests\/second|requests\/minute|plan limit|too many requests|request limit|rate limit/i.test(String((e && e.message) || e)));
const isMinuteLimit = (e) => /requests\/minute|plan limit/i.test(String((e && e.message) || e));
async function withRateRetry(fn, { tries = 15, waitMs = 1200 } = {}) {
  for (let i = 1; ; i++) {
    try { const r = await fn(); if (r && typeof r === "object" && r.s === "error" && isRateLimit(r)) throw r; return r; }
    catch (e) {
      if (!isRateLimit(e) || i >= tries) throw e;
      if (i === 1) log(`Fyers request limit hit - waiting (${(e && e.message) || e})`.slice(0, 200));
      await sleep((isMinuteLimit(e) ? 15000 : waitMs) + Math.floor(Math.random() * 400));   // per-minute limit: wait it out
    }
  }
}
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const INDEX = "NSE:NIFTY50-INDEX";
const STEP = 50, WINDOW = 6, SNAP_SEC = 10, CHAIN_SEC = 60, CHAIN_WIDTH = 2, DEAD_MIN = 10;
const optRole = (s) => { const m = /(CE|PE)$/.exec(String(s || "")); return m ? m[1].toLowerCase() : null; };
const dmyToIso = (d) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

process.on("uncaughtException", (e) => { log("uncaughtException:", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e); });
process.on("unhandledRejection", (e) => { log("unhandledRejection:", e && e.message ? e.message : e); });

// ── REST client (account 2) ──────────────────────────────────────────────────
const f = new fyersModel({ path: "", enableLogging: false });
f.setAppId(appId);
f.setAccessToken(token);
const quoteV = (sym) => withRateRetry(async () => { const r = await withTimeout(f.getQuotes([sym]), 15000, "getQuotes"); if (r && r.s === "error") throw r; return r && r.d && r.d[0] && r.d[0].v; });
const quoteOf = async (sym) => { const v = await quoteV(sym); return num(v && (v.lp ?? v.ltp)); };
/** Same shape as fyers/client.js fetchOptionChain, but on account 2. */
async function fetchOptionChain(sym, { strikeCount = 20, timestamp = "" } = {}) {
  const res = await withRateRetry(() => withTimeout(f.getOptionChain({ symbol: sym, strikecount: strikeCount, timestamp }), 15000, "getOptionChain"));
  if (!res || res.s !== "ok" || !res.data) return { expiries: [], strikes: [] };
  const expiries = (res.data.expiryData || []).map((e) => ({ date: e.date || e.expiry, expiry: e.expiry || e.date })).filter((e) => e.date);
  const strikes = (res.data.optionsChain || []).filter((o) => o && o.symbol && (o.option_type === "CE" || o.option_type === "PE"));
  return { expiries, strikes };
}
/** weekly / monthly expiry, the same way as the collector (driveShared.resolveCycles); simple fallback if that file is missing. */
async function resolveCycles() {
  try {
    const S = require("../driveExport/driveShared");
    const found = await S.resolveCycles(fetchOptionChain, INDEX);
    if (found && (found.weekly || found.monthly)) return found;
  } catch (e) { log("expiry lookup via driveShared failed, using the fallback:", e.message); }
  const { expiries } = await fetchOptionChain(INDEX, { strikeCount: 2 });
  if (!expiries.length) throw new Error("no option expiries from Fyers (token valid?)");
  const iso = (e) => dmyToIso(e.date) || "";
  const first = expiries[0];
  const sameMonth = expiries.filter((e) => iso(e).slice(0, 7) === iso(first).slice(0, 7));
  const monthly = sameMonth[sameMonth.length - 1];
  return { weekly: first === monthly ? null : first, monthly };
}

// ── live state for the dashboard (the files are written by Recorder) ───────────
const latest = new Map();      // sym -> {ltp, bid, ask, vol, oi, chp, recv, depth5, depth50}
const candles = new Map();     // sym -> Map(minuteSec -> {t,o,h,l,c,v, v0})
const dirtyCandles = new Set();
const state = { dataConnected: false, tbtConnected: false, lastTickAt: null, startedAt: Date.now(), connects: 0, closes: 0, setup: "starting", exporting: false, lastExport: null };

function onCandleTick(sym, price, cumVol, recvMs) {
  if (!(price > 0)) return;
  const t = Math.floor(recvMs / 60000) * 60;
  let m = candles.get(sym);
  if (!m) { m = new Map(); candles.set(sym, m); }
  let c = m.get(t);
  if (!c) {
    const keys = [...m.keys()];
    const prev = keys.length ? m.get(keys[keys.length - 1]) : null;
    c = { t, o: price, h: price, l: price, c: price, v: 0, v0: cumVol !== null ? cumVol : (prev ? prev.v0 + prev.v : null) };
    m.set(t, c);
    if (m.size > 420) m.delete(m.keys().next().value);
  }
  c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price;
  if (cumVol !== null && c.v0 !== null) c.v = Math.max(0, cumVol - c.v0);
  dirtyCandles.add(sym);
}
function liveQuote(t, recv) {
  state.lastTickAt = recv;
  const L = latest.get(t.symbol) || {};
  L.ltp = n(t.ltp) ?? L.ltp; L.bid = n(t.bid_price) ?? L.bid; L.ask = n(t.ask_price) ?? L.ask;
  L.vol = n(t.vol_traded_today) ?? L.vol; L.oi = n(t.oi) ?? L.oi; L.chp = n(t.chp) ?? L.chp;
  L.recv = recv;
  latest.set(t.symbol, L);
  onCandleTick(t.symbol, n(t.ltp), n(t.vol_traded_today), recv);
}
function liveDepth5(t, recv) {
  const lv = (k) => [1, 2, 3, 4, 5].map((i) => n(t[k + i]) || 0);
  const bp = lv("bid_price"), bs = lv("bid_size"), bo = lv("bid_order"), ap = lv("ask_price"), as = lv("ask_size"), ao = lv("ask_order");
  const L = latest.get(t.symbol) || {};
  L.depth5 = { bids: bp.map((p, i) => [p, bs[i], bo[i]]).filter((x) => x[0] > 0), asks: ap.map((p, i) => [p, as[i], ao[i]]).filter((x) => x[0] > 0), tbq: n(t.tot_buy_qty), tsq: n(t.tot_sell_qty), recv };
  latest.set(t.symbol, L);
}
function liveDepth50(sym, d, recv) {
  if (!d || !Array.isArray(d.bidprice) || !Array.isArray(d.askprice)) return;
  const arr = (a) => (Array.isArray(a) ? a.slice(0, 50).map((x) => n(x) || 0) : []);
  const bp = arr(d.bidprice), bq = arr(d.bidqty), ap = arr(d.askprice), aq = arr(d.askqty);
  const live = (p, q) => p.map((x, i) => [x, q[i]]).filter((x) => x[0] > 0 && x[1] > 0);
  const bids = live(bp, bq), asks = live(ap, aq);
  const L = latest.get(sym) || {};
  L.depth50 = { tbq: n(d.tbq), tsq: n(d.tsq), levelsBid: bids.length, levelsAsk: asks.length, bidQty: bids.reduce((s, x) => s + x[1], 0), askQty: asks.reduce((s, x) => s + x[1], 0), bids: bids.slice(0, 10), asks: asks.slice(0, 10), recv };
  latest.set(sym, L);
}

// ── main ─────────────────────────────────────────────────────────────────────
let rec = null, sk = null, tbt = null, timer = null, report = null, finishing = false;
const pendingSubs = { msg: null };
const hb = setInterval(() => send({ hb: Date.now() }), 5000);   // keeps running during the end-of-day export

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const today = istDate(Date.now());

  // ── resolve index, expiries, FUT, ATM pair (as the collector does) ──
  state.setup = "resolving symbols";
  const spot = await quoteOf(INDEX);
  if (!Number.isFinite(spot)) throw new Error(`index price via REST failed for ${INDEX}`);
  const found = await resolveCycles();
  const cyc = found.weekly || found.monthly, mon = found.monthly || found.weekly;
  if (!cyc) throw new Error("no option expiry found");
  const cycType = found.weekly ? "weekly" : "monthly";
  let fut = null;
  const [, mm, yyyy] = mon.date.split("-").map(Number);
  for (let k = 0; k < 2 && !fut; k++) {
    const d = new Date(Date.UTC(yyyy, mm - 1 + k, 1)), cand = `NSE:NIFTY${String(d.getUTCFullYear()).slice(2)}${MON[d.getUTCMonth()]}FUT`;
    const lp = await quoteOf(cand).catch(() => NaN);
    if (Number.isFinite(lp) && lp > 0) fut = cand;
  }
  if (!fut) throw new Error("NIFTY futures symbol not found");
  const futLtp = await quoteOf(fut);

  let chainMap = new Map();   // strike -> {CE, PE}
  const loadChain = async (count) => {
    const chain = await fetchOptionChain(INDEX, { strikeCount: count, timestamp: cyc.expiry });
    const m = new Map();
    for (const s of chain.strikes || []) { const k = Number(s.strike_price); if (!Number.isFinite(k) || !s.symbol) continue; const e = m.get(k) || {}; e[s.option_type] = s.symbol; m.set(k, e); }
    if (m.size) chainMap = m;
  };
  await loadChain(20);
  const atm = new AtmTracker({ step: STEP, hyst: 5, dwellMs: 30000 });
  const atm0 = atm.init(futLtp, Date.now());
  const p0 = chainMap.get(atm0);
  if (!p0 || !p0.CE || !p0.PE) throw new Error(`ATM strike ${atm0} CE/PE not found in the option chain`);
  const winSyms = new Set(), winList = [];
  for (let k = -WINDOW; k <= WINDOW; k++) { const pp = chainMap.get(atm0 + k * STEP); if (pp && pp.CE && pp.PE) { winSyms.add(pp.CE); winSyms.add(pp.PE); winList.push([atm0 + k * STEP, pp]); } }
  const expiryMs = (() => { const [dd, m2, yy] = cyc.date.split("-").map(Number); return Date.parse(`${yy}-${String(m2).padStart(2, "0")}-${String(dd).padStart(2, "0")}T15:30:00+05:30`); })();

  // ── sockets ──
  const safe = (fn, what) => { try { return fn(); } catch (e) { if (rec) rec.err(what || "safe", e); return undefined; } };
  const dataSubs = new Set([INDEX, fut, p0.CE, p0.PE, ...winSyms]);
  let dataOpen = false, lastData = Date.now(), lastRealMsg = Date.now(), lastReconnect = 0, deadLogged = false;
  try { fyersDataSocket.instance = null; } catch { /* ignore */ }
  sk = fyersDataSocket.getInstance(`${appId}:${token}`, "", false);
  if (typeof sk.autoReconnect === "function") sk.autoReconnect(10); else if (typeof sk.autoreconnect === "function") sk.autoreconnect(10);
  const isIdx = (s) => /-INDEX$/.test(s);
  const subData = (syms, withDepth) => { safe(() => sk.subscribe(syms), "data.subscribe"); const dp = syms.filter((s) => !isIdx(s)); if (withDepth && dp.length) safe(() => sk.subscribe(dp, true), "data.subscribe.depth"); };
  const dataIo = {
    sub: (syms, withDepth) => { syms.forEach((s) => dataSubs.add(s)); if (dataOpen) subData(syms, withDepth); },
    unsub: (syms) => { syms.forEach((s) => dataSubs.delete(s)); if (dataOpen) { safe(() => sk.unsubscribe(syms), "data.unsubscribe"); safe(() => sk.unsubscribe(syms.filter((s) => !isIdx(s)), true), "data.unsubscribe.depth"); } },
  };
  const tbtDesired = new Set(); let tbtOpen = false;
  const tbtIo = {
    sub: (syms) => { syms.forEach((s) => tbtDesired.add(s)); if (tbtOpen) safe(() => { tbt.subscribe(syms, "1", "depth"); tbt.switchChannel(new Set(), new Set(["1"])); }, "tbt.subscribe"); },
    unsub: (syms) => {
      syms.forEach((s) => tbtDesired.delete(s));
      if (tbtOpen) safe(() => tbt.unsubscribe(syms, "1", "depth"), "tbt.unsubscribe");
      safe(() => { if (tbt && tbt.subsinfo && typeof tbt.subsinfo.unsubscribe === "function") tbt.subsinfo.unsubscribe(syms, "1"); }, "tbt.subsinfo.fix");
    },
  };

  rec = new Recorder({
    outDir, engineDepth: "dp", saveRebuilt: true, atmRole: "fut", atm, useTbt: useTbt && typeof fyersTbtSocket === "function", dataGraceSec: 20, windowSyms: winSyms, expiryMs,
    resolveStrike: async (strike) => {
      let p = chainMap.get(strike);
      if (!p || !p.CE || !p.PE) { await loadChain(40); p = chainMap.get(strike); }
      return p && p.CE && p.PE ? { ce: p.CE, pe: p.PE } : null;
    },
    io: { dataSub: (s, d) => dataIo.sub(s, d), dataUnsub: (s) => dataIo.unsub(s), tbtSub: (s) => tbtIo.sub(s), tbtUnsub: (s) => tbtIo.unsub(s) },
  });
  rec.track(INDEX, "index"); rec.track(fut, "fut"); rec.track(p0.CE, "ce", { strike: atm0 }); rec.track(p0.PE, "pe", { strike: atm0 });
  for (const [k, pp] of winList) { rec.track(pp.CE, "ce", { strike: k }); rec.track(pp.PE, "pe", { strike: k }); }
  rec.cur = { strike: atm0, ce: p0.CE, pe: p0.PE };
  rec.ev("start", { fut, index: INDEX, atm: atm0, ce: p0.CE, pe: p0.PE, expiry: cyc.date, expiry_type: cycType, atm_ref: "fut", engine_depth: "dp", tbt: rec.cfg.useTbt, recorder: "dashboard (account 2)" });

  // Dashboard hooks: the Recorder writes the files, we only keep the latest values for the page.
  const oq = rec.onQuote.bind(rec), od = rec.onDepth5.bind(rec), ot = rec.onTbt.bind(rec);
  rec.onQuote = (t, recv) => { oq(t, recv); liveQuote(t, recv); };
  rec.onDepth5 = (t, recv) => { od(t, recv); liveDepth5(t, recv); };
  rec.onTbt = (sym, d, recv) => { ot(sym, d, recv); liveDepth50(sym, d, recv); };

  // PaRRVA calls: extra option symbols, and up to 2 extra 50-level slots (future + ATM pair use 3 of 5).
  const extraTbt = new Set();
  const applyExtraTbt = (want) => {
    if (!rec.cfg.useTbt) return;
    const core = new Set([fut, rec.cur && rec.cur.ce, rec.cur && rec.cur.pe]);
    const next = new Set((want || [...extraTbt]).filter((s) => optRole(s) && !core.has(s)).slice(0, 2));
    const rem = [...extraTbt].filter((s) => !next.has(s) && !core.has(s)), add = [...next].filter((s) => !tbtDesired.has(s));
    extraTbt.clear(); next.forEach((s) => extraTbt.add(s));
    if (rem.length) tbtIo.unsub(rem);
    if (add.length) tbtIo.sub(add);
    if (rem.length || add.length) rec.ev("parrva_tbt", { add, remove: rem, extra: [...extraTbt] });
  };
  const roll = rec.rollAtm.bind(rec);
  rec.rollAtm = async (...a) => { const r = await roll(...a); applyExtraTbt(null); return r; };   // ATM switch may drop a PaRRVA symbol -> re-add
  const known = new Set();
  const onSubscribe = (msg) => {
    for (const s of msg.symbols || []) {
      if (typeof s !== "string" || !s.includes(":") || known.has(s)) continue;
      known.add(s);
      const role = optRole(s);
      if (role && !rec.recs.has(s)) {
        rec.track(s, role);
        const exp = msg.meta && msg.meta[s] && msg.meta[s].expiry;
        if (exp && exp !== dmyToIso(cyc.date)) rec.ev("expiry", { sym: s, expiry_date: exp, expiry_type: exp === dmyToIso(mon.date) ? "monthly" : "weekly" });
        dataIo.sub([s], true);
        rec.ev("parrva_symbol", { sym: s });
      } else if (!role && !dataSubs.has(s)) dataIo.sub([s], false);   // other index for the page only (not recorded)
    }
    applyExtraTbt(msg.tbt || []);
  };

  sk.on("connect", () => { dataOpen = true; state.dataConnected = true; state.connects++; lastData = Date.now(); rec.ev("data_connect"); subData([...dataSubs], true); safe(() => { if (sk.FullMode !== undefined) sk.mode(sk.FullMode); }, "data.mode"); });
  sk.on("error", (e) => rec.ev("data_error", { message: (e && e.message) || String(e) }));
  sk.on("close", () => { dataOpen = false; state.dataConnected = false; state.closes++; if (!finishing) rec.ev("data_close"); });
  sk.on("message", (m) => {
    const recv = Date.now(); lastData = recv; lastRealMsg = recv;
    for (const t of Array.isArray(m) ? m : [m]) {
      try {
        if (!t || typeof t !== "object" || !t.symbol) continue;
        if (t.type === "sf" || t.type === "if") { if (rec.recs.has(t.symbol)) rec.onQuote(t, recv); else liveQuote(t, recv); }
        else if (t.type === "dp") rec.onDepth5(t, recv);
      } catch (e) { rec.err("data_message", e); }
    }
  });

  if (rec.cfg.useTbt) {
    const e0 = console.error;
    console.error = (...a) => { if (String(a[0]).startsWith("Error fetching URL")) return; e0(...a); };
    try { tbt = new fyersTbtSocket(`${appId}:${token}`, "", false, false); } finally { console.error = e0; }
    tbt.autoreconnect(50); tbtIo.sub([fut, p0.CE, p0.PE]);
    safe(() => { const ds = tbt.datastore, orig = ds.updateDepth.bind(ds); ds.updateDepth = (packet, cb, diff) => { try { rec.onTbtPacket(packet, Date.now()); } catch (e) { rec.err("tbt_raw", e); } return orig(packet, cb, diff); }; rec.ev("tbt_raw_hook_installed"); }, "tbt.rawhook");
    tbt.on("open", () => { tbtOpen = true; state.tbtConnected = true; rec.ev("tbt_open"); safe(() => { if (tbtDesired.size) { tbt.subscribe([...tbtDesired], "1", "depth"); tbt.switchChannel(new Set(), new Set(["1"])); } }, "tbt.open"); });
    tbt.on("depth", (symbol, d) => { try { rec.onTbt(symbol, d, Date.now()); } catch (e) { rec.err("tbt_depth", e); } });
    tbt.on("servererror", (m) => rec.ev("tbt_servererror", { message: typeof m === "string" ? m : JSON.stringify(m) }));
    tbt.on("error", (e) => rec.ev("tbt_error", { message: (e && e.message) || String(e) }));
    tbt.on("close", () => { tbtOpen = false; state.tbtConnected = false; if (!finishing) rec.ev("tbt_close"); });
  }
  sk.connect(); if (tbt) tbt.connect();

  // ── REST (one at a time), same jobs and files as the collector ──
  let restP = Promise.resolve(); const rq = (fn) => { restP = restP.then(fn).catch((e) => rec.err("rest", e)); return restP; };
  const snapW = rec.open(path.join(outDir, "rest_snapshots.jsonl")), candW = rec.open(path.join(outDir, "rest_candles.jsonl")), fullW = rec.open(path.join(outDir, "rest_candles_full.jsonl"));
  const activeSyms = () => { const a = [INDEX, fut]; if (rec.cur) a.push(rec.cur.ce, rec.cur.pe); return a; };
  const doChain = () => rq(async () => {
    const r = await withTimeout(f.getOptionChain({ symbol: INDEX, strikecount: Math.max(10, CHAIN_WIDTH + 8), timestamp: cyc.expiry }), 15000, "getOptionChain");
    const list = (r && r.data && r.data.optionsChain) || [];
    const ks = [...chainMap.keys()].sort((a, b) => Math.abs(a - rec.cur.strike) - Math.abs(b - rec.cur.strike)).slice(0, 2 * CHAIN_WIDTH + 1), want = new Set();
    for (const k of ks) { const pp = chainMap.get(k); if (pp.CE) want.add(pp.CE); if (pp.PE) want.add(pp.PE); }
    const cnt = rec.onOptionChain(list, rec.lastPrice.index, Date.now(), want);
    if (!cnt) rec.ev("chain_empty", { listed: list.length, wanted: want.size });
  });
  const doSnapshot = () => rq(async () => {
    const syms = activeSyms(); const r = await withTimeout(f.getQuotes(syms), 15000, "snapshot getQuotes"); const now = Date.now();
    const q = {}; for (const x of (r && r.d) || []) if (x && x.n) q[x.n] = x.v;
    const ws = {}; for (const s of syms) { const rr = rec.recs.get(s); if (rr && rr.last && rr.last.recv) ws[s] = { ltp: rr.last.ltp, bid: rr.last.bid, ask: rr.last.ask, vol: rr.last.vol, age_ms: now - rr.last.recv }; }
    snapW.write({ recv_ms: now, recv_ist: istStamp(now), clock_offset_sec: rec.clock.offset(), rest: q, ws });
  });
  const fetchCandles = async (sym, from, to) => {
    const call = () => withTimeout(f.getHistory({ symbol: sym, resolution: "1", date_format: "0", range_from: String(from), range_to: String(to), cont_flag: "1", oi_flag: "1" }), 20000, "getHistory");
    const r = await withRateRetry(async () => { const x = await call(); if (x && x.s === "error") throw x; return x; }, { tries: 6 });
    return ((r && r.candles) || []).map((c) => ({ sym, minute_epoch_s: c[0], minute_ist: istStamp(c[0] * 1000).slice(0, 16), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], oi: c.length > 6 ? c[6] : null }));
  };
  const seenCandle = new Set(); let lastCandleMin = -1;
  const doCandles = () => rq(async () => {
    const now = Math.floor(Date.now() / 1000), cur = Math.floor(now / 60) * 60;
    for (const s of activeSyms()) {
      try { for (const c of await fetchCandles(s, cur - 360, now)) { const k = c.sym + "|" + c.minute_epoch_s; if (c.minute_epoch_s < cur && !seenCandle.has(k)) { seenCandle.add(k); candW.write(c); } } }
      catch (e) { rec.ev("rest_candle_error", { sym: s, message: e.message }); }
      await sleep(300);
    }
  });
  const finalBackfill = async () => {
    const from = Math.floor(Date.parse(`${today}T03:45:00Z`) / 1000), to = Math.floor(Date.now() / 1000);
    for (const s of rec.recs.keys()) { try { const cs = await fetchCandles(s, from, to); cs.forEach((c) => fullW.write(c)); rec.ev("rest_backfill", { sym: s, candles: cs.length }); } catch (e) { rec.ev("rest_backfill_error", { sym: s, message: e.message }); } await sleep(400); }
  };

  let lastChain = 0, lastSnap = 0, lastSum = 0;
  timer = setInterval(() => {
    const now = Date.now(), m = istMin(now), sec = new Date(now + IST_MS).getUTCSeconds();
    if (now - lastSnap >= SNAP_SEC * 1000) { lastSnap = now; doSnapshot(); }
    if (now - lastChain >= CHAIN_SEC * 1000) { lastChain = now; doChain(); }
    if (sec >= 7 && Math.floor(now / 60000) !== lastCandleMin) { lastCandleMin = Math.floor(now / 60000); doCandles(); }
    if (m >= 556 && m < 929 && now - lastData > 90000 && now - lastReconnect > 300000) { lastReconnect = now; rec.ev("data_stall_reconnect", { silent_sec: Math.round((now - lastData) / 1000) }); safe(() => sk.close()); setTimeout(() => safe(() => sk.connect(), "data.reconnect"), 2000); }
    if (m >= 556 && m < 929 && now - lastRealMsg > DEAD_MIN * 60000 && !deadLogged) {
      // Same as the collector's supervisor: restart the whole recorder (the manager starts it again, files are appended).
      deadLogged = true; rec.ev("data_socket_dead_restart", { silent_min: Math.round((now - lastRealMsg) / 60000) });
      finish("data socket dead", { exportNow: false, code: 75 });
    }
    if (now - lastSum > 300000) { lastSum = now; rec.writeSummary(); }
  }, 1000);

  finishCtx.finalBackfill = finalBackfill; finishCtx.restDone = () => restP.catch(() => {});
  state.setup = "running";
  state.fut = fut; state.expiry = dmyToIso(cyc.date); state.window = winList.map((x) => x[0]);
  log(`recording: index ${spot}, ${fut} ${futLtp}, expiry ${cyc.date} (${cycType}), ATM ${atm0}, window ${winList.length} strikes -> ${outDir}`);
  doSnapshot();
  if (pendingSubs.msg) onSubscribe(pendingSubs.msg);
  pendingSubs.handler = onSubscribe;
  send({ ready: true });
}

// ── reporting to the manager ────────────────────────────────────────────────
report = setInterval(() => {
  const symbols = {};
  for (const [sym, L] of latest) symbols[sym] = L;
  const cs = {};
  for (const sym of dirtyCandles) { const m = candles.get(sym); if (m) cs[sym] = [...m.values()].slice(-3).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })); }
  dirtyCandles.clear();
  const c = rec ? rec.counts : {};
  send({
    snap: {
      status: {
        ...state, outDir, pid: process.pid, tbtEnabled: !!(rec && rec.cfg.useTbt),
        counts: { quotes: c.quotes || 0, depth5: c.depth5 || 0, depth50: c.tbt || 0, errors: rec ? rec.errCount : 0 },
        atm: rec && rec.cur ? rec.cur.strike : null, tracked: rec ? rec.recs.size : 0,
      },
      symbols, candles: cs,
    },
  });
}, 1000);

// ── stop / end of day ───────────────────────────────────────────────────────
const finishCtx = { finalBackfill: null, restDone: null };
async function finish(why, { exportNow = null, code = 0 } = {}) {
  if (finishing) return; finishing = true;
  const doExport = exportNow === null ? istMin(Date.now()) >= 925 : exportNow;   // at / after 15:25 IST -> end of day
  log(`stopping (${why})${doExport ? " - end of day: candle backfill + Parquet export" : ""}`);
  if (timer) clearInterval(timer);
  try { if (sk) sk.close(); } catch { /* ignore */ }
  try { if (tbt) tbt.close(); } catch { /* ignore */ }
  if (rec) {
    rec.ev("stop", { why, export: doExport });
    await sleep(500);
    if (finishCtx.restDone) await finishCtx.restDone();
    if (doExport && finishCtx.finalBackfill) { try { await withTimeout(finishCtx.finalBackfill(), 120000, "backfill"); } catch (e) { rec.err("backfill", e); } }
    await rec.closeAll();
    if (doExport) {
      state.exporting = true;
      try {
        const r = await exportParquet(outDir, null, (l) => log(l));
        state.lastExport = { at: new Date().toISOString(), ok: r.ok, files: r.report.map((x) => ({ file: x.file, rows: x.rows, mb: x.mb })) };
        send({ exported: state.lastExport });
      } catch (e) { log("Parquet export failed (JSONL files are safe; run: node src/parrva/ofrExport.js <day folder>):", e.message); send({ exported: { ok: false, error: e.message } }); }
      state.exporting = false;
    }
  }
  clearInterval(report); clearInterval(hb);
  setTimeout(() => process.exit(code), 200);
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.cmd === "subscribe") { pendingSubs.msg = msg; if (pendingSubs.handler) pendingSubs.handler(msg); }
  else if (msg.cmd === "stop") finish(msg.why || "stop requested", { exportNow: msg.export === undefined ? null : !!msg.export });
});
process.on("disconnect", () => finish("parent disconnected"));
process.on("SIGTERM", () => finish("SIGTERM"));
process.on("SIGINT", () => finish("SIGINT"));

main().catch((e) => {
  log("recorder could not start:", e && e.message ? e.message : e);
  clearInterval(report); clearInterval(hb);
  setTimeout(() => process.exit(1), 200);
});
