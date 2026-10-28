/**
 * backend/src/scripts/orderFlowRecorder.js   (ONE FILE - put it next to orderFlowFeedCheck.js)
 *
 * Records, for ONE trading day, everything sir's order-flow engine needs, as JSON-lines (JSONL) files:
 *   NIFTY FUTURES  +  the ATM CE and ATM PE (re-picked as price moves)  +  the NIFTY 50 index price
 *   1. Data socket  : every quote tick (all fields) + 5-level depth
 *   2. TBT socket   : every 50-level depth frame (with sequence number)
 *   3. REST         : quote snapshots, 1-minute candles (with OI), end-of-day backfill
 *   4. Engine files : <symbol>/engine.jsonl  = schema-2 Q/D lines exactly as orderflow_engine.py reads them
 *
 * RUN (PowerShell, inside backend/, market hours, backend + other capture scripts STOPPED):
 *   node src/scripts/orderFlowRecorder.js
 *   node src/scripts/orderFlowRecorder.js --probe                (also test >5 symbols / unsubscribe / extra connections, see PROBE)
 *   node src/scripts/orderFlowRecorder.js --selftest             (offline test of the logic, no Fyers needed)
 *
 * OPTIONS (all optional)
 *   --out <dir>            default backend/orderflow_data/<date>
 *   --until HH:MM          IST stop time, default 15:35
 *   --atm-ref fut|index    which price picks the ATM strike, default fut (as in the spec); index price is always recorded too
 *   --atm-step 50  --atm-hyst 5  --atm-dwell 30     strike step, extra points beyond +-25 before switching, min seconds between switches
 *   --cycle weekly|monthly default weekly (falls back to the other one)
 *   --fut NSE:NIFTY26OCTFUT   force the futures symbol
 *   --engine-depth dp|tbt|rebuilt  which depth goes into engine.jsonl. DEFAULT dp = clean 5-level feed (verified 13-Oct).
 *                          tbt = SDK-merged 50 levels (found corrupt on 13-Oct), rebuilt = our own 50-level book (see TBT RAW)
 *   --save-rebuilt         also write symbols/<SYMBOL>/tbt50_rebuilt.jsonl (every rebuilt 50-level frame)
 *   --no-tbt               skip the TBT socket
 *   --rest-snap-sec 10     REST snapshot interval
 *   --wait                 for scheduled/unattended starts: before 09:00 IST on a trading day it waits for 09:00; on a weekend/NSE holiday/after 15:30 it exits quietly (code 0)
 *   --wait-token           if the Fyers token is missing/expired it keeps checking every 30 s (until the stop time) so you can log in from your phone via /admin; then it starts
 *   --window 6             data socket (quotes + 5-level) is subscribed ONCE at start for ATM +-6 strikes (CE+PE); no subscribe/unsubscribe all day
 *                          (13-Oct/14-Oct: strike switches on the data socket broke it). TBT 50-level still follows the ATM pair.
 *   --supervise            restart automatically (same --out folder, files appended) if the data socket is dead for --dead-min minutes (default 10)
 *   --chain-sec 60  --chain-width 2   REST option chain (IV + Greeks) every N seconds for ATM +-width strikes (CE and PE)
 *   --dest "G:\\My Drive"    after the day, copy the Parquet files there (size + row count re-checked)
 *   --no-parquet           skip the automatic Parquet export at the end
 *   --export-only <folder> do NOT connect; only convert an existing day folder to Parquet (needs parquetjs-lite, already in the project)
 *   --probe  --probe-delay-min 20  --probe-conns 0     live limit test, see PROBE below
 *   --force                run outside market hours (connection test only)
 *
 * FILES WRITTEN under <out>/
 *   symbols/<SYMBOL>/quotes.jsonl   every sf/if tick, ALL raw fields + recv_ms, recv_ist, ts (unified exchange-seconds)
 *   symbols/<SYMBOL>/depth5.jsonl   every 5-level dp message, ALL raw fields + recv_ms, ts
 *   symbols/<SYMBOL>/tbt50.jsonl    every TBT frame: recv_ms, ts, feed_ts, feed_ts_raw, send_ts_raw, seq, snapshot, tbq, tsq,
 *                                   n_bid, n_ask, qf (quality letters), bid_price/bid_qty/bid_orders/ask_price/ask_qty/ask_orders
 *                                   (arrays are position = level, trailing zeros trimmed - pad with 0 up to 50)
 *   symbols/<SYMBOL>/tbt_raw.jsonl  TBT RAW: every update exactly as Fyers sends it, BEFORE the SDK merges it: recv_ms, seq, packet_snapshot,
 *                                   feed_ts_raw, send_ts_raw, tbq, tsq, n_asks, n_bids, asks/bids = [[price, qty, orders, num], ...]
 *                                   (num = the level number field that the Fyers SDK ignores)
 *   tbt_raw_samples.jsonl           the first 3 complete raw messages per symbol, for checking the message layout
 *   symbols/<SYMBOL>/engine.jsonl   H header, Q lines {t,ts,p,q,v,b,a}, D lines {t,ts,bids,asks,snap}  (ts never goes backwards)
 *   rest_option_chain.jsonl         REST option chain every --chain-sec: bid, ask, ltp, oi, volume, iv, delta, gamma, theta, vega (+ the raw entry)
 *   parquet/index.parquet, futures.parquet, options.parquet   written at the end (or with --export-only): exactly 3 files per day.
 *                                   column event_type = quote | depth5 | depth50 | candle_1m | rest_snapshot | chain (options only: IV + Greeks)
 *   rest_snapshots.jsonl            REST getQuotes of index+FUT+CE+PE, plus what the websocket last saw (to compare)
 *   rest_candles.jsonl              REST 1-minute candles (open, high, low, close, volume, oi), written each minute
 *   rest_candles_full.jsonl         whole-day REST 1-minute candles per symbol, fetched at the end
 *   atm_changes.jsonl               every ATM switch (when, price, old/new strike and symbols)
 *   events.jsonl                    connects, closes, errors, server errors, stalls, seq gaps, clamps ...
 *   probe_results.json              only with --probe
 *   summary.json                    counts and quality numbers, written at the end (and every 5 minutes)
 *
 * CLOCK: quote ticks carry exchange time; the 5-level depth message carries none, so it is mapped with a measured
 * PC-vs-exchange offset. TBT frames carry exchange time. engine.jsonl timestamps are forced non-decreasing, so the
 * engine can never drop events as "late" (that is what produced 0 candles in the 12-Oct feed check).
 *
 * TBT RAW / REBUILD: on 13-Oct 90% of SDK-merged futures frames had repeated or unsorted prices. The SDK writes each update level at its
 * array index and ignores the level's own `num` field. This recorder (a) saves the raw updates, (b) rebuilds the book itself using `num`
 * as the level position (hypothesis, to be proven by the numbers below), and (c) compares the top 5 levels of BOTH books with the
 * independent 5-level feed (+-1.5 s). summary.json -> dp_top5_match {sdk_merged_pct, rebuilt_pct} and tbt_rebuilt_quality_flags.
 *
 * PROBE (--probe): after --probe-delay-min minutes, on a SEPARATE TBT connection it (A) subscribes 6 symbols on one channel
 * to see whether the server refuses (>5), (B) unsubscribes one and subscribes another, (C) with --probe-conns N opens N more
 * connections to see which one is refused. The main recording is not touched. Result: probe_results.json + events.jsonl.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = "orderFlowRecorder v1";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : d; };
const has = (n) => argv.includes("--" + n);
const num = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── time helpers (IST) ─────────────────────────────
const IST_MS = 19800000;
const istStamp = (ms) => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 23);
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMin = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDow = (ms) => new Date(ms + IST_MS).getUTCDay();
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
/** trading-day / market-hours gate. state: open | before (wait for 09:00) | closed */
function marketGate(nowMs, holidays) {
  const d = istDate(nowMs), m = istMin(nowMs), dow = istDow(nowMs);
  if (dow === 0 || dow === 6) return { state: "closed", reason: "weekend" };
  if (holidays && holidays.has(d)) return { state: "closed", reason: "NSE holiday" };
  if (m < 540) return { state: "before", reason: "before 09:00 IST", waitMs: (540 - m) * 60000 - new Date(nowMs + IST_MS).getUTCSeconds() * 1000 };
  if (m >= 930) return { state: "closed", reason: "after 15:30 IST" };
  return { state: "open", reason: "" };
}
/** polls validate() until it returns true or the deadline passes (token refreshed from the phone through the backend's /admin login) */
async function waitForValidToken(validate, { deadlineMs, pollMs = 30000, log = console.log, now = Date.now, sleepFn = sleep } = {}) {
  let last = 0;
  while (now() < deadlineMs) {
    let ok = false; try { ok = !!(await validate()); } catch { ok = false; }
    if (ok) return true;
    if (last === 0 || now() - last >= 300000) { last = now(); log(`[${istStamp(now()).slice(11, 19)}] waiting for a valid Fyers token - log in via /admin on the backend (checking every ${pollMs / 1000} s)`); }
    await sleepFn(pollMs);
  }
  return false;
}
/** Fyers Standard plan allows 5 REST requests per second (error code -360). Retry such calls after a short wait instead of failing. */
const isRateLimit = (e) => !!e && (e.code === -360 || e.code === 429 || /requests\/second|too many requests|request limit|rate limit/i.test(String((e && e.message) || e)));
async function withRateRetry(fn, { tries = 15, waitMs = 1200, log = console.log, what = "request", sleepFn = sleep } = {}) {
  for (let i = 1; ; i++) {
    try { const r = await fn(); if (r && typeof r === "object" && r.s === "error" && isRateLimit(r)) throw r; return r; }
    catch (e) { if (!isRateLimit(e) || i >= tries) throw e; if (i === 1 || i % 5 === 0) log(`  Fyers 5-requests-per-second limit hit during ${what} - waiting and retrying (${i}/${tries})`); await sleepFn(waitMs + Math.floor(Math.random() * 400)); }
  }
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
/** exchange timestamps may come in s / ms / us / ns -> seconds; NaN when missing or not a real epoch */
const normTs = (v) => { let x = num(v); if (!Number.isFinite(x) || x <= 0) return NaN; if (x > 1e17) x /= 1e9; else if (x > 1e14) x /= 1e6; else if (x > 1e11) x /= 1e3; return x > 1.5e9 ? x : NaN; };

// ───────────────────────────── pure helpers (also used by --selftest) ─────────────────────────────
// ───────────────────────────── IV + GREEKS (computed here; Fyers' option chain does not send them) ─────────────────────────────
// Same method and assumptions as the project's services/blackScholes.js + ivEnrichment.js: Black-Scholes, risk-free rate 7%, no dividend,
// spot = NIFTY 50 index price at the same moment, expiry = 15:30 IST on the expiry date, T in years = ms / (365 days).
// iv is a DECIMAL (0.18 = 18%). delta per index point, gamma per point, theta per calendar day (price points), vega per 1 vol point (0.01).
const RISK_FREE = 0.07;
const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const normCdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = normPdf(x), pp = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x >= 0 ? 1 - pp : pp; };
function bsPrice(S, K, T, r, v, type) {
  if (!(T > 0) || !(v > 0)) return Math.max(0, type === "CE" ? S - K : K - S);
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sq), d2 = d1 - v * sq;
  return type === "CE" ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2) : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
function ownIV(price, S, K, T, type, r = RISK_FREE) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0) || (type !== "CE" && type !== "PE")) return null;
  const dk = K * Math.exp(-r * T), intr = Math.max(0, type === "CE" ? S - dk : dk - S), ub = type === "CE" ? S : K;
  if (price < intr - 1e-6 || price > ub + 1e-6) return null;
  const vega = (v) => { const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sq); return S * normPdf(d1) * sq; };
  let v = 0.3;
  for (let i = 0; i < 50; i++) { const df = bsPrice(S, K, T, r, v, type) - price; if (Math.abs(df) < 1e-4) return Math.round(v * 10000) / 10000; const vg = vega(v); if (vg < 1e-8) break; v -= df / vg; if (v <= 0 || v > 5) break; }
  let lo = 1e-4, hi = 5; const flo = bsPrice(S, K, T, r, lo, type) - price, fhi = bsPrice(S, K, T, r, hi, type) - price;
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2, fm = bsPrice(S, K, T, r, mid, type) - price; if (Math.abs(fm) < 1e-4) return Math.round(mid * 10000) / 10000; if ((flo < 0) === (fm < 0)) lo = mid; else hi = mid; }
  return Math.round(((lo + hi) / 2) * 10000) / 10000;
}
let projIV = null; try { projIV = require("../services/blackScholes").impliedVolatility; } catch { /* project file not next to us (selftest elsewhere) - use ownIV */ }
const solveIV = (price, S, K, T, type) => (projIV ? projIV(price, S, K, T, type, RISK_FREE) : ownIV(price, S, K, T, type, RISK_FREE));
const yearsTo = (expiryMs, ms) => (expiryMs - ms) / (365 * 24 * 3600 * 1000);
/** -> { iv, delta, gamma, theta, vega, t_years } ; every value null when it cannot be solved (never a fake 0) */
function greeksFor(price, S, K, expiryMs, ms, type) {
  const out = { iv: null, delta: null, gamma: null, theta: null, vega: null, t_years: null };
  if (!Number.isFinite(expiryMs) || !Number.isFinite(S) || !Number.isFinite(K) || !(price > 0)) return out;
  const T = yearsTo(expiryMs, ms); out.t_years = T; if (!(T > 0)) return out;
  const iv = solveIV(price, S, K, T, type); if (!(iv > 0)) return out;
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * iv * iv) * T) / (iv * sq), d2 = d1 - iv * sq, ek = K * Math.exp(-RISK_FREE * T);
  out.iv = iv; out.delta = type === "CE" ? normCdf(d1) : normCdf(d1) - 1; out.gamma = normPdf(d1) / (S * iv * sq); out.vega = (S * normPdf(d1) * sq) / 100;
  out.theta = (-(S * normPdf(d1) * iv) / (2 * sq) + (type === "CE" ? -RISK_FREE * ek * normCdf(d2) : RISK_FREE * ek * normCdf(-d2))) / 365;
  return out;
}

/** PC clock vs exchange clock. offset = low percentile of (recv - exchange) over the last samples (= skew + minimum latency). */
class ClockSync {
  constructor(n = 300) { this.n = n; this.buf = []; this.cache = 0; this.dirty = 1; this.samples = 0; }
  observe(recvMs, exchSec) {
    const o = recvMs / 1000 - exchSec;
    if (!Number.isFinite(o) || Math.abs(o) > 3600) return;
    this.buf.push(o); if (this.buf.length > this.n) this.buf.shift(); this.dirty++; this.samples++;
  }
  offset() {
    if (!this.buf.length) return 0;
    if (this.dirty >= 20 || this.dirty === 1) {
      const s = [...this.buf].sort((a, b) => a - b);
      this.cache = s[this.buf.length < 20 ? Math.floor(s.length / 2) : Math.floor(s.length * 0.1)]; this.dirty = 2;
    }
    return this.cache;
  }
  toExch(recvMs) { return recvMs / 1000 - this.offset(); }
}

/** Which strike is "ATM", and when to switch. Spec: strike = nearest step to price; switch when price moves past +-step/2. */
class AtmTracker {
  constructor({ step = 50, hyst = 5, dwellMs = 30000 } = {}) { this.step = step; this.hyst = hyst; this.dwellMs = dwellMs; this.current = null; this.lastSwitch = 0; }
  nearest(price) { return Math.round(price / this.step) * this.step; }
  init(price, nowMs) { this.current = this.nearest(price); this.lastSwitch = nowMs; return this.current; }
  check(price, nowMs) {
    if (this.current === null || !(price > 0)) return null;
    const n = this.nearest(price);
    if (n === this.current) return null;
    if (Math.abs(price - this.current) <= this.step / 2 + this.hyst) return null;
    if (nowMs - this.lastSwitch < this.dwellMs) return null;
    return n;
  }
  commit(to, nowMs) { this.current = to; this.lastSwitch = nowMs; }
  fail(nowMs) { this.lastSwitch = nowMs; }
}

const trimZ = (a) => { let k = a.length; while (k > 0 && !a[k - 1]) k--; return a.slice(0, k); };
const fix50 = (a, f) => { const o = new Array(50).fill(0); if (Array.isArray(a)) for (let i = 0; i < 50 && i < a.length; i++) { const v = f(a[i]); o[i] = Number.isFinite(v) ? v : 0; } return o; };
const strictly = (a, dir) => a.every((x, i) => i === 0 || (dir === "desc" ? x < a[i - 1] : x > a[i - 1]));

/** One SDK TBT depth object -> row fields + quality letters. null if malformed. */
function tbtFrame(d) {
  if (!d || !["bidprice", "askprice", "bidqty", "askqty", "bidordn", "askordn"].every((k) => Array.isArray(d[k]))) return null;
  const rq = (x) => Math.round(num(x));
  const bp = fix50(d.bidprice, num), bq = fix50(d.bidqty, rq), bo = fix50(d.bidordn, rq);
  const ap = fix50(d.askprice, num), aq = fix50(d.askqty, rq), ao = fix50(d.askordn, rq);
  const live = (p, q, i) => p[i] > 0 && q[i] > 0;
  let nb = 0, lb = 0, na = 0, la = 0;
  for (let i = 0; i < 50; i++) { if (live(bp, bq, i)) { nb++; lb = i + 1; } if (live(ap, aq, i)) { na++; la = i + 1; } }
  const bids = bp.filter((_, i) => live(bp, bq, i)), asks = ap.filter((_, i) => live(ap, aq, i));
  let qf = "";
  if (lb > nb || la > na) qf += "G";
  if (!(strictly(bids, "desc") && strictly(asks, "asc"))) qf += "M";
  if (bids.length && asks.length && bids[0] >= asks[0]) qf += "X";
  if (!nb && !na) qf += "E";
  return {
    feed_ts: normTs(d.timestamp), feed_ts_raw: String(d.timestamp), send_ts_raw: String(d.sendtime), seq: Math.round(num(d.seqNo)), snapshot: !!d.snapshot,
    tbq: Math.round(num(d.tbq)) || 0, tsq: Math.round(num(d.tsq)) || 0, n_bid: nb, n_ask: na, qf,
    bid_price: bp, bid_qty: bq, bid_orders: bo, ask_price: ap, ask_qty: aq, ask_orders: ao,
    bidsLive: bp.map((p, i) => [p, bq[i]]).filter((x) => x[0] > 0 && x[1] > 0), asksLive: ap.map((p, i) => [p, aq[i]]).filter((x) => x[0] > 0 && x[1] > 0),
  };
}

/** unwrap protobuf wrapper values ({value}), Long objects and plain numbers -> Number (NaN if missing) */
const pv = (x) => { if (x === null || x === undefined) return NaN; let v = x; if (typeof v === "object" && !(typeof v.toNumber === "function")) v = "value" in v ? v.value : NaN; if (v && typeof v === "object" && typeof v.toNumber === "function") v = v.toNumber(); return Number(v); };
/** signature of the best 5 live levels each side: [[price,qty],...] -> string (price in paise) */
const sigOf = (bids, asks) => bids.slice(0, 5).map((x) => Math.round(x[0] * 100) + ":" + x[1]).join(",") + "|" + asks.slice(0, 5).map((x) => Math.round(x[0] * 100) + ":" + x[1]).join(",");
/** counts how often the independent 5-level feed (dp) equals the top 5 of a TBT book (sdk-merged / rebuilt) within +-win ms */
class SigMatcher {
  constructor(win = 1500) { this.win = win; this.hist = { sdk: [], rb: [] }; this.pend = []; this.n = 0; this.hit = { sdk: 0, rb: 0 }; }
  push(kind, ms, sig) {
    const h = this.hist[kind];
    if (h.length && h[h.length - 1].sig === sig) h[h.length - 1].ms2 = ms; else h.push({ ms, ms2: ms, sig });
    while (h.length && h[0].ms2 < ms - 6000) h.shift();
    for (const p of this.pend) if (!p[kind] && Math.abs(ms - p.ms) <= this.win && p.sig === sig) p[kind] = true;
  }
  dp(ms, sig) {
    const e = { ms, sig, sdk: false, rb: false };
    for (const kind of ["sdk", "rb"]) for (const x of this.hist[kind]) if (x.sig === sig && x.ms2 >= ms - this.win && x.ms <= ms + this.win) { e[kind] = true; break; }
    this.pend.push(e); this.flush(ms);
  }
  flush(now) { while (this.pend.length && this.pend[0].ms < now - this.win - 100) { const p = this.pend.shift(); this.n++; if (p.sdk) this.hit.sdk++; if (p.rb) this.hit.rb++; } }
}

// ───────────────────────────── file writer (never throws) ─────────────────────────────
class LineWriter {
  constructor(file, onErr) {
    this.file = file; this.lines = 0; this.err = null; this.closed = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.s = fs.createWriteStream(file, { flags: "a" });
    this.s.on("error", (e) => { this.err = e; if (onErr) onErr(file, e); });
  }
  write(o) {
    if (this.err || this.closed) return false;
    try { this.s.write(JSON.stringify(o) + "\n"); this.lines++; return true; } catch (e) { this.err = e; return false; }
  }
  close() { return new Promise((r) => { if (this.closed) return r(); this.closed = true; try { this.s.end(r); } catch { r(); } }); }
}

// ───────────────────────────── the recorder core ─────────────────────────────
/**
 * io = { dataSub(syms, withDepth), dataUnsub(syms), tbtSub(syms), tbtUnsub(syms) }   (real sockets in live mode, mocks in selftest)
 * cfg = { outDir, engineDepth, atmRole("fut"|"index"), atm (AtmTracker), resolveStrike(strike)->{ce,pe}|null, io, now() }
 */
class Recorder {
  constructor(cfg) {
    this.cfg = cfg; this.io = cfg.io; this.now = cfg.now || Date.now; this.clock = new ClockSync(); this.atm = cfg.atm;
    this.recs = new Map(); this.writers = []; this.rolling = false; this.cur = null; this.errCount = 0; this.startMs = this.now();
    fs.mkdirSync(cfg.outDir, { recursive: true });
    this.evW = this.open(path.join(cfg.outDir, "events.jsonl"));
    this.atmW = this.open(path.join(cfg.outDir, "atm_changes.jsonl"));
    this.sampW = this.open(path.join(cfg.outDir, "tbt_raw_samples.jsonl"));
    this.chainW = this.open(path.join(cfg.outDir, "rest_option_chain.jsonl"));
    this.counts = { quotes: 0, depth5: 0, tbt: 0, malformed: 0, clamped: 0 };
    this.lastPrice = { fut: NaN, index: NaN };
  }
  open(file) { const w = new LineWriter(file, (f, e) => { this.errCount++; console.error(`[writer] ${f}: ${e.message}`); }); this.writers.push(w); return w; }
  ev(event, detail = {}) { const o = { time_ist: istStamp(this.now()), event, ...detail }; this.evW.write(o); if (!/^(seq_gap)$/.test(event)) console.log(`[${o.time_ist.slice(11, 19)}] ${event} ${Object.keys(detail).length ? JSON.stringify(detail).slice(0, 200) : ""}`); }
  err(where, e) { this.errCount++; this.ev("error", { where, message: (e && e.message) || String(e) }); }

  /** start tracking a symbol (role: fut|ce|pe|index) */
  track(sym, role, meta = {}) {
    let r = this.recs.get(sym);
    if (r) { r.role = role; r.active = true; return r; }
    const dir = path.join(this.cfg.outDir, "symbols", safeName(sym));
    r = { sym, role, meta, active: true, dir, lastEngineTs: 0, lastSeq: null, seqGaps: 0, seqMissed: 0, seqResync: 0, seqBack: 0, n: { q: 0, d5: 0, tbt: 0 }, qf: { G: 0, M: 0, X: 0, E: 0 }, last: {}, w: {}, m: new SigMatcher(), book: null, numMin: null, qfRb: { G: 0, M: 0, X: 0, E: 0 }, nRaw: 0, nRb: 0, rawSamples: 0 };
    r.w.quotes = this.open(path.join(dir, "quotes.jsonl"));
    if (role !== "index") {
      r.w.d5 = this.open(path.join(dir, "depth5.jsonl")); r.w.tbt = this.open(path.join(dir, "tbt50.jsonl")); r.w.eng = this.open(path.join(dir, "engine.jsonl"));
      r.w.raw = this.open(path.join(dir, "tbt_raw.jsonl"));
      if (this.cfg.saveRebuilt) r.w.rb = this.open(path.join(dir, "tbt50_rebuilt.jsonl"));
      r.w.eng.write({ t: "H", schema: 2, symbol: sym, role, date: istDate(this.now()), depth_levels: this.cfg.engineDepth === "dp" ? 5 : 50, depth_source: this.cfg.engineDepth, ts_clock: "exchange seconds, non-decreasing", recorder: VERSION });
      r.w.tbt.write({ t: "H", symbol: sym, note: "arrays: position = level, trailing zeros trimmed, pad with 0 to 50", recorder: VERSION });
    }
    this.recs.set(sym, r); this.ev("track", { sym, role });
    return r;
  }
  mono(r, ts) { if (ts < r.lastEngineTs) { ts = r.lastEngineTs; this.counts.clamped++; } else r.lastEngineTs = ts; return ts; }

  onQuote(t, recvMs) {
    const r = this.recs.get(t.symbol); if (!r) return;
    const exch = (() => { const a = normTs(t.exch_feed_time); return Number.isFinite(a) ? a : normTs(t.last_traded_time); })();
    if (Number.isFinite(exch)) this.clock.observe(recvMs, exch);
    const ts = Number.isFinite(exch) ? exch : this.clock.toExch(recvMs);
    this.counts.quotes++; r.n.q++;
    r.w.quotes.write({ ...t, recv_ms: recvMs, recv_ist: istStamp(recvMs), ts });
    const p = num(t.ltp), b = num(t.bid_price), a = num(t.ask_price);
    r.last = { ltp: p, bid: b, ask: a, vol: num(t.vol_traded_today), recv: recvMs };
    if (r.w.eng && p > 0) r.w.eng.write({ t: "Q", ts: this.mono(r, ts), p, q: num(t.last_traded_qty) || 0, v: num(t.vol_traded_today) || 0, b: Number.isFinite(b) ? b : null, a: Number.isFinite(a) ? a : null });
    if (r.role === "fut") this.lastPrice.fut = p; if (r.role === "index") this.lastPrice.index = p;
    if (r.role === this.cfg.atmRole && p > 0) this.maybeRoll(p, recvMs);
  }

  onDepth5(t, recvMs) {
    const r = this.recs.get(t.symbol); if (!r || !r.w.d5) return;
    const ts = this.clock.toExch(recvMs);
    this.counts.depth5++; r.n.d5++;
    { const L = (k) => [1, 2, 3, 4, 5].map((i) => num(t[k + i])); const bp = L("bid_price"), bs = L("bid_size"), ap = L("ask_price"), as = L("ask_size");
      r.m.dp(recvMs, sigOf(bp.map((p, i) => [p, bs[i]]).filter((x) => x[0] > 0 && x[1] > 0), ap.map((p, i) => [p, as[i]]).filter((x) => x[0] > 0 && x[1] > 0))); }
    r.w.d5.write({ ...t, recv_ms: recvMs, recv_ist: istStamp(recvMs), ts });
    if (this.cfg.engineDepth === "dp") {
      const L = (k) => [1, 2, 3, 4, 5].map((i) => num(t[k + i]));
      const bp = L("bid_price"), bs = L("bid_size"), ap = L("ask_price"), as = L("ask_size");
      r.w.eng.write({ t: "D", ts: this.mono(r, ts), bids: bp.map((p, i) => [p, bs[i]]).filter((x) => x[0] > 0 && x[1] > 0), asks: ap.map((p, i) => [p, as[i]]).filter((x) => x[0] > 0 && x[1] > 0), snap: false });
    }
  }

  onTbt(sym, d, recvMs) {
    const r = this.recs.get(sym); if (!r || !r.w.tbt) return;
    const f = tbtFrame(d);
    if (!f) { this.counts.malformed++; return; }
    const ts = Number.isFinite(f.feed_ts) ? f.feed_ts : this.clock.toExch(recvMs);
    this.counts.tbt++; r.n.tbt++;
    if (Number.isFinite(f.seq) && f.seq > 0) {
      if (r.lastSeq !== null) {
        if (f.seq === r.lastSeq + 1) { /* consecutive */ }
        else if (f.snapshot) { r.seqResync++; }
        else if (f.seq > r.lastSeq + 1) { r.seqGaps++; r.seqMissed += f.seq - r.lastSeq - 1; if (r.seqGaps <= 50) this.ev("seq_gap", { sym, from: r.lastSeq, to: f.seq, missed: f.seq - r.lastSeq - 1 }); }
        else r.seqBack++;
      }
      r.lastSeq = f.seq;
    }
    for (const c of f.qf) r.qf[c]++;
    r.m.push("sdk", recvMs, sigOf(f.bidsLive, f.asksLive));
    r.w.tbt.write({ recv_ms: recvMs, recv_ist: istStamp(recvMs), ts, feed_ts: f.feed_ts, feed_ts_raw: f.feed_ts_raw, send_ts_raw: f.send_ts_raw, seq: f.seq, snapshot: f.snapshot, tbq: f.tbq, tsq: f.tsq, n_bid: f.n_bid, n_ask: f.n_ask, qf: f.qf,
      bid_price: trimZ(f.bid_price), bid_qty: trimZ(f.bid_qty), bid_orders: trimZ(f.bid_orders), ask_price: trimZ(f.ask_price), ask_qty: trimZ(f.ask_qty), ask_orders: trimZ(f.ask_orders) });
    if (this.cfg.engineDepth === "tbt") r.w.eng.write({ t: "D", ts: this.mono(r, ts), bids: f.bidsLive, asks: f.asksLive, snap: f.snapshot });
  }

  /** RAW hook: called with the decoded protobuf packet BEFORE the SDK merges it. Saves it verbatim and rebuilds our own book. */
  onTbtPacket(packet, recvMs) {
    if (!packet || !packet.feeds) return;
    const snap = !!packet.snapshot;
    for (const v of Object.values(packet.feeds)) {
      const sym = v && v.ticker, r = this.recs.get(sym);
      if (!r || !r.w.raw || !v.depth) continue;
      const lv = (l) => [pv(l.price) / 100, pv(l.qty), pv(l.nord), pv(l.num)];
      const asks = (v.depth.asks || []).map(lv), bids = (v.depth.bids || []).map(lv);
      const tbq = pv(v.depth.tbq), tsq = pv(v.depth.tsq), seq = pv(v.sequenceNo), feed = pv(v.feedTime), send = pv(v.sendTime);
      r.nRaw++;
      r.w.raw.write({ recv_ms: recvMs, recv_ist: istStamp(recvMs), seq, packet_snapshot: snap, feed_ts_raw: feed, send_ts_raw: send, tbq, tsq, n_asks: asks.length, n_bids: bids.length, asks, bids });
      if (r.rawSamples < 3) { r.rawSamples++; let txt = ""; try { txt = JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)).slice(0, 8000); } catch { txt = "unserialisable"; } this.sampW.write({ symbol: sym, time_ist: istStamp(recvMs), packet_keys: Object.keys(packet), packet_snapshot: snap, message: txt }); }
      this.applyRebuilt(r, snap, asks, bids, tbq, tsq, feed, send, seq, recvMs);
    }
  }
  /** our own book: level position = `num` (hypothesis: the level number), snapshot packet resets the book, missing fields keep the old value */
  applyRebuilt(r, snap, asks, bids, tbq, tsq, feed, send, seq, recvMs) {
    const z = () => new Array(50).fill(0);
    if (!r.book || snap) r.book = { bp: z(), bq: z(), bo: z(), ap: z(), aq: z(), ao: z(), tbq: 0, tsq: 0 };
    const B = r.book;
    for (const l of asks.concat(bids)) if (Number.isFinite(l[3])) r.numMin = r.numMin === null ? l[3] : Math.min(r.numMin, l[3]);
    const base = r.numMin === 0 ? 0 : 1;
    const put = (P, Qa, O, arr) => arr.forEach((l, i) => { const pos = Number.isFinite(l[3]) ? l[3] - base : i; if (!(pos >= 0 && pos < 50)) return; if (Number.isFinite(l[0])) P[pos] = l[0]; if (Number.isFinite(l[1])) Qa[pos] = l[1]; if (Number.isFinite(l[2])) O[pos] = l[2]; });
    put(B.ap, B.aq, B.ao, asks); put(B.bp, B.bq, B.bo, bids);
    if (Number.isFinite(tbq)) B.tbq = tbq; if (Number.isFinite(tsq)) B.tsq = tsq;
    const fr = tbtFrame({ bidprice: B.bp, askprice: B.ap, bidqty: B.bq, askqty: B.aq, bidordn: B.bo, askordn: B.ao, tbq: B.tbq, tsq: B.tsq, snapshot: snap, timestamp: feed, sendtime: send, seqNo: seq });
    if (!fr) return;
    r.nRb++; for (const c of fr.qf) r.qfRb[c]++;
    r.m.push("rb", recvMs, sigOf(fr.bidsLive, fr.asksLive));
    const ts = Number.isFinite(fr.feed_ts) ? fr.feed_ts : this.clock.toExch(recvMs);
    if (this.cfg.engineDepth === "rebuilt" && r.w.eng) r.w.eng.write({ t: "D", ts: this.mono(r, ts), bids: fr.bidsLive, asks: fr.asksLive, snap });
    if (r.w.rb) r.w.rb.write({ recv_ms: recvMs, recv_ist: istStamp(recvMs), ts, src: "rebuilt-num", feed_ts: fr.feed_ts, seq: fr.seq, snapshot: snap, tbq: fr.tbq, tsq: fr.tsq, n_bid: fr.n_bid, n_ask: fr.n_ask, qf: fr.qf,
      bid_price: trimZ(fr.bid_price), bid_qty: trimZ(fr.bid_qty), bid_orders: trimZ(fr.bid_orders), ask_price: trimZ(fr.ask_price), ask_qty: trimZ(fr.ask_qty), ask_orders: trimZ(fr.ask_orders) });
  }

  /** REST option chain rows. Fyers sends bid/ask/ltp/oi/volume only (no Greeks on 13-Oct), so IV + Greeks are computed here from ltp and the index price. */
  onOptionChain(list, spot, recvMs, want) {
    let n = 0;
    for (const e of list || []) {
      if (!e || !e.symbol || (want && !want.has(e.symbol))) continue;
      const K = num(e.strike_price), g = greeksFor(num(e.ltp), spot, K, this.cfg.expiryMs, recvMs, e.option_type);
      this.chainW.write({ recv_ms: recvMs, recv_ist: istStamp(recvMs), underlying_price: Number.isFinite(spot) ? spot : null, symbol: e.symbol, strike: K, option_type: e.option_type, bid: num(e.bid), ask: num(e.ask), ltp: num(e.ltp), oi: num(e.oi), volume: num(e.volume), iv: g.iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, t_years: g.t_years, greeks_src: g.iv === null ? null : "computed Black-Scholes r=7% spot=index price ltp", raw: e });
      n++;
    }
    return n;
  }

  // ── ATM rolling ──
  maybeRoll(price, nowMs) {
    if (this.rolling || !this.atm) return;
    const to = this.atm.check(price, nowMs); if (to === null) return;
    this.rolling = true;
    this.rollAtm(to, price, nowMs).catch((e) => this.err("rollAtm", e)).then(() => { this.rolling = false; });
  }
  /** subscribe the NEW pair first (3+2 = 5 TBT symbols, still within the limit), then drop the OLD pair */
  async rollAtm(to, price, nowMs) {
    const from = this.cur ? this.cur.strike : this.atm.current;
    let pair = null;
    try { pair = await this.cfg.resolveStrike(to); } catch (e) { this.err("resolveStrike", e); }
    if (!pair || !pair.ce || !pair.pe) { this.atm.fail(nowMs); this.ev("atm_switch_failed", { to, reason: "symbols not found" }); return false; }
    this.track(pair.ce, "ce", { strike: to }); this.track(pair.pe, "pe", { strike: to });
    const inWin = (a) => !!(this.cfg.windowSyms && this.cfg.windowSyms.has(a));
    if (!(inWin(pair.ce) && inWin(pair.pe))) { if (this.cfg.windowSyms) this.ev("atm_outside_window", { strike: to, note: "price left the subscribed strike window - subscribing these on the data socket" }); this.io.dataSub([pair.ce, pair.pe], true); }
    if (this.cfg.useTbt) this.io.tbtSub([pair.ce, pair.pe]);
    const old = this.cur && this.cur.ce ? { ce: this.cur.ce, pe: this.cur.pe } : null;
    if (old && (old.ce !== pair.ce || old.pe !== pair.pe)) {
      if (this.cfg.useTbt) this.io.tbtUnsub([old.ce, old.pe]);
      if (!(inWin(old.ce) && inWin(old.pe))) { const t = setTimeout(() => { try { this.io.dataUnsub([old.ce, old.pe]); } catch (e) { this.err("dataUnsub", e); } }, (this.cfg.dataGraceSec || 20) * 1000); if (t.unref) t.unref(); }
      for (const s of [old.ce, old.pe]) { const r = this.recs.get(s); if (r) r.active = false; }
    }
    this.cur = { strike: to, ce: pair.ce, pe: pair.pe };
    this.atm.commit(to, nowMs);
    this.atmW.write({ time_ist: istStamp(nowMs), recv_ms: nowMs, ref: this.cfg.atmRole, ref_price: price, from_strike: from, to_strike: to, old_ce: old && old.ce, old_pe: old && old.pe, new_ce: pair.ce, new_pe: pair.pe });
    this.ev("atm_switch", { from, to, price, ce: pair.ce, pe: pair.pe });
    return true;
  }

  summary() {
    const syms = {};
    for (const r of this.recs.values()) { r.m.flush(this.now()); const mm = r.m, pct = (x) => (mm.n ? Math.round((1000 * x) / mm.n) / 10 : null); syms[r.sym] = { raw_packets: r.nRaw, rebuilt_frames: r.nRb, tbt_rebuilt_quality_flags: r.qfRb, dp_top5_match: { checked: mm.n, sdk_merged_pct: pct(mm.hit.sdk), rebuilt_pct: pct(mm.hit.rb) }, role: r.role, active: r.active, quotes: r.n.q, depth5: r.n.d5, tbt50: r.n.tbt, seq_gaps: r.seqGaps, seq_missed: r.seqMissed, seq_resync: r.seqResync, seq_backwards: r.seqBack, tbt_quality_flags: r.qf, engine_lines: r.w.eng ? r.w.eng.lines : 0 }; }
    return { recorder: VERSION, time_ist: istStamp(this.now()), started_ist: istStamp(this.startMs), counts: this.counts, clock_offset_sec: Number(this.clock.offset().toFixed(3)), clock_samples: this.clock.samples, atm_current: this.cur, errors: this.errCount, symbols: syms };
  }
  writeSummary() { try { fs.writeFileSync(path.join(this.cfg.outDir, "summary.json"), JSON.stringify(this.summary(), null, 2)); } catch (e) { this.errCount++; } }
  async closeAll() { for (const r of this.recs.values()) r.m.flush(Infinity); this.writeSummary(); await Promise.all(this.writers.map((w) => w.close())); }
}

// ───────────────────────────── LIVE mode ─────────────────────────────
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

async function runLive() {
  require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
  const { fyersModel, fyersDataSocket, fyersTbtSocket } = require("fyers-api-v3");
  const { loadToken, getRedirectUri, validateToken, fetchOptionChain } = require("../fyers/client");
  const S = require("../driveExport/driveShared");
  let holidays = new Set(); try { holidays = require("../data/holidays").NSE_BSE_HOLIDAYS_2026 || holidays; } catch { /* optional */ }
  let curated = null; try { curated = require("../derivatives/curatedUnderlyingsLoader"); } catch { /* optional */ }

  let t0 = Date.now();
  const gate0 = marketGate(t0, holidays);
  if (gate0.state === "before" && has("wait") && !has("force")) { console.log(`[${istStamp(t0).slice(11, 19)}] ${gate0.reason} - waiting ${Math.round(gate0.waitMs / 60000)} min for 09:00 IST ...`); await sleep(gate0.waitMs); t0 = Date.now(); }
  else if (gate0.state !== "open" && !has("force")) { console.error(`Market closed now (${gate0.reason}). ${has("wait") ? "Nothing to record today - exiting." : "Run in market hours, or use --force."}`); process.exit(has("wait") ? 0 : 1); }
  const today = istDate(t0);
  const untilMin = hhmm(opt("until", "15:35")); if (!Number.isFinite(untilMin)) { console.error("--until must be HH:MM"); process.exit(1); }
  const outDir = path.resolve(opt("out", path.resolve(__dirname, `../../orderflow_data/${today}`)));
  const atmRole = opt("atm-ref", "fut") === "index" ? "index" : "fut";
  const engineDepth = ["dp", "tbt", "rebuilt"].includes(opt("engine-depth", "dp")) ? opt("engine-depth", "dp") : "dp";
  const saveRebuilt = has("save-rebuilt");
  const useTbt = !has("no-tbt");
  const step = Number(opt("atm-step", 50)), hyst = Number(opt("atm-hyst", 5)), dwell = Number(opt("atm-dwell", 30));

  console.log(`=== ${VERSION} === ${today}  output: ${outDir}\nStop the backend and other capture scripts first. Ctrl+C stops cleanly.\n`);
  if (!(await withRateRetry(() => validateToken(), { what: "token check" }))) {
    if (!has("wait-token")) { console.error("Fyers token invalid/expired - log in via /admin and rerun (or start with --wait-token to wait for the login)."); process.exit(1); }
    const okTok = await waitForValidToken(validateToken, { deadlineMs: Date.parse(`${today}T00:00:00+05:30`) + untilMin * 60000 });
    if (!okTok) { console.error("No valid Fyers token before the stop time - nothing recorded."); process.exit(1); }
    console.log("Fyers token is valid now - starting.");
  }
  const token = loadToken(), appId = process.env.APP_ID;
  if (!token || !appId) { console.error("Missing token or APP_ID in .env"); process.exit(1); }
  const f = new fyersModel({ path: "", enableLogging: false });
  f.setAppId(appId); f.setRedirectUrl(getRedirectUri()); f.setAccessToken(token);
  const quoteV = (sym) => withRateRetry(async () => { const r = await withTimeout(f.getQuotes([sym]), 15000, "getQuotes"); if (r && r.s === "error") throw r; return r && r.d && r.d[0] && r.d[0].v; }, { what: "quote " + sym });
  const quoteOf = async (sym) => { const v = await quoteV(sym); return num(v && (v.lp ?? v.ltp)); };

  // ── resolve index, expiries, FUT, ATM pair ──
  const entry = curated && curated.findCuratedEntry ? curated.findCuratedEntry("NIFTY", "NSE") : null;
  const lookup = (entry && entry.spotSymbol) || "NSE:NIFTY50-INDEX";
  const spot = await quoteOf(lookup); if (!Number.isFinite(spot)) throw new Error(`index price via REST failed for ${lookup}`);
  const found = await withRateRetry(() => S.resolveCycles(fetchOptionChain, lookup), { what: "option expiry lookup" });
  const wantMonthly = opt("cycle", "weekly") === "monthly";
  const cyc = wantMonthly ? (found.monthly || found.weekly) : (found.weekly || found.monthly);
  const mon = found.monthly || found.weekly;
  if (!cyc) throw new Error("no option expiry found");
  let fut = opt("fut", null);
  if (!fut) {
    const [, mm, yyyy] = mon.date.split("-").map(Number);
    for (let k = 0; k < 2 && !fut; k++) {
      const d = new Date(Date.UTC(yyyy, mm - 1 + k, 1)), cand = `NSE:NIFTY${String(d.getUTCFullYear()).slice(2)}${MON[d.getUTCMonth()]}FUT`;
      const lp = await quoteOf(cand).catch(() => NaN);
      if (Number.isFinite(lp) && lp > 0) fut = cand;
    }
  }
  if (!fut) throw new Error("NIFTY futures symbol not found (use --fut NSE:NIFTY26OCTFUT)");
  const futLtp = await quoteOf(fut);
  console.log(`index ${lookup} = ${spot}   futures ${fut} = ${futLtp}   option expiry ${cyc.date}   ATM reference: ${atmRole}`);

  let chainMap = new Map();   // strike -> {CE, PE}
  const loadChain = async (count) => {
    const chain = await withRateRetry(() => fetchOptionChain(lookup, { strikeCount: count, timestamp: cyc.expiry }), { what: "option chain" });
    const m = new Map();
    for (const s of chain.strikes || []) { const k = Number(s.strike_price); if (!Number.isFinite(k) || !s.symbol) continue; const e = m.get(k) || {}; e[s.option_type] = s.symbol; m.set(k, e); }
    if (m.size) chainMap = m;
  };
  await loadChain(Number(opt("strike-count", 20)));
  const refPrice = atmRole === "fut" ? futLtp : spot;
  const atm = new AtmTracker({ step, hyst, dwellMs: dwell * 1000 });
  const atm0 = atm.init(refPrice, Date.now());
  const p0 = chainMap.get(atm0);
  if (!p0 || !p0.CE || !p0.PE) throw new Error(`ATM strike ${atm0} CE/PE not found in the option chain`);

  // ── sockets (io layer) ──
  const W = Math.max(0, Number(opt("window", 6))), winSyms = new Set(), winList = [];
  for (let k = -W; k <= W; k++) { const pp = chainMap.get(atm0 + k * step); if (pp && pp.CE && pp.PE) { winSyms.add(pp.CE); winSyms.add(pp.PE); winList.push([atm0 + k * step, pp]); } }
  console.log(`data socket window: ${winList.length} strikes (${winSyms.size} option symbols) subscribed once for the whole day`);
  const rec = new Recorder({
    outDir, engineDepth, saveRebuilt, atmRole, atm, useTbt, dataGraceSec: 20, windowSyms: W > 0 ? winSyms : undefined,
    expiryMs: (() => { const [dd, mm2, yy] = cyc.date.split("-").map(Number); return Date.parse(`${yy}-${String(mm2).padStart(2, "0")}-${String(dd).padStart(2, "0")}T15:30:00+05:30`); })(),
    resolveStrike: async (strike) => {
      let p = chainMap.get(strike);
      if (!p || !p.CE || !p.PE) { await loadChain(Number(opt("strike-count", 20)) * 2); p = chainMap.get(strike); }
      return p && p.CE && p.PE ? { ce: p.CE, pe: p.PE } : null;
    },
    io: {
      dataSub: (syms, withDepth) => dataIo.sub(syms, withDepth), dataUnsub: (syms) => dataIo.unsub(syms),
      tbtSub: (syms) => tbtIo.sub(syms), tbtUnsub: (syms) => tbtIo.unsub(syms),
    },
  });
  rec.track(lookup, "index"); rec.track(fut, "fut"); rec.track(p0.CE, "ce", { strike: atm0 }); rec.track(p0.PE, "pe", { strike: atm0 });
  for (const [k, pp] of winList) { rec.track(pp.CE, "ce", { strike: k }); rec.track(pp.PE, "pe", { strike: k }); }
  rec.cur = { strike: atm0, ce: p0.CE, pe: p0.PE };
  rec.ev("start", { fut, index: lookup, atm: atm0, ce: p0.CE, pe: p0.PE, expiry: cyc.date, atm_ref: atmRole, engine_depth: engineDepth, tbt: useTbt });
  process.on("uncaughtException", (e) => rec.err("uncaughtException", e));
  process.on("unhandledRejection", (e) => rec.err("unhandledRejection", e));

  // data socket (quotes + 5-level depth)
  const dataSubs = new Set([lookup, fut, p0.CE, p0.PE, ...winSyms]); let dataOpen = false, lastData = Date.now(), lastRealMsg = Date.now(), lastReconnect = 0, ending = false, deadLogged = false;
  const deadMin = Math.max(2, Number(opt("dead-min", 10)));
  const sk = fyersDataSocket.getInstance(`${appId}:${token}`, "", false);
  if (typeof sk.autoReconnect === "function") sk.autoReconnect(10); else if (typeof sk.autoreconnect === "function") sk.autoreconnect(10);
  const safe = (fn, what) => { try { return fn(); } catch (e) { rec.err(what || "safe", e); } };
  const subData = (syms, withDepth) => { const q = syms; const dp = syms.filter((s) => s !== lookup); safe(() => sk.subscribe(q), "data.subscribe"); if (withDepth && dp.length) safe(() => sk.subscribe(dp, true), "data.subscribe.depth"); };
  const dataIo = {
    sub: (syms, withDepth) => { syms.forEach((s) => dataSubs.add(s)); if (dataOpen) subData(syms, withDepth); },
    unsub: (syms) => { syms.forEach((s) => dataSubs.delete(s)); if (dataOpen) { safe(() => sk.unsubscribe(syms), "data.unsubscribe"); safe(() => sk.unsubscribe(syms.filter((s) => s !== lookup), true), "data.unsubscribe.depth"); } },
  };
  sk.on("connect", () => { dataOpen = true; lastData = Date.now(); rec.ev("data_connect"); subData([...dataSubs], true); safe(() => { if (sk.FullMode !== undefined) sk.mode(sk.FullMode); }, "data.mode"); });
  sk.on("error", (e) => rec.ev("data_error", { message: (e && e.message) || String(e) }));
  sk.on("close", () => { dataOpen = false; if (!ending) rec.ev("data_close"); });
  sk.on("message", (m) => {
    const recv = Date.now(); lastData = recv; lastRealMsg = recv;
    for (const t of Array.isArray(m) ? m : [m]) {
      try {
        if (!t || typeof t !== "object" || !t.symbol) continue;
        if (t.type === "sf" || t.type === "if") rec.onQuote(t, recv); else if (t.type === "dp") rec.onDepth5(t, recv);
      } catch (e) { rec.err("data_message", e); }
    }
  });

  // TBT socket (50-level depth). channel "1". limit = 5 symbols per connection (proved by the server).
  const makeTbt = () => { const e0 = console.error; console.error = (...a) => { if (String(a[0]).startsWith("Error fetching URL")) return; e0(...a); }; try { return new fyersTbtSocket(`${appId}:${token}`, "", false, false); } finally { console.error = e0; } };
  const tbtDesired = new Set(); let tbtOpen = false; let tbt = null;
  const tbtIo = {
    sub: (syms) => { syms.forEach((s) => tbtDesired.add(s)); if (tbtOpen) safe(() => { tbt.subscribe(syms, "1", "depth"); tbt.switchChannel(new Set(), new Set(["1"])); }, "tbt.subscribe"); },
    unsub: (syms) => {
      syms.forEach((s) => tbtDesired.delete(s));
      if (tbtOpen) safe(() => tbt.unsubscribe(syms, "1", "depth"), "tbt.unsubscribe");
      safe(() => { if (tbt && tbt.subsinfo && typeof tbt.subsinfo.unsubscribe === "function") tbt.subsinfo.unsubscribe(syms, "1"); }, "tbt.subsinfo.fix"); // SDK bug: its unsubscribe() re-adds the symbols to its own memory
    },
  };
  if (useTbt) {
    tbt = makeTbt(); tbt.autoreconnect(50); tbtIo.sub([fut, p0.CE, p0.PE]);
    safe(() => { const ds = tbt.datastore, orig = ds.updateDepth.bind(ds); ds.updateDepth = (packet, cb, diff) => { try { rec.onTbtPacket(packet, Date.now()); } catch (e) { rec.err("tbt_raw", e); } return orig(packet, cb, diff); }; rec.ev("tbt_raw_hook_installed"); }, "tbt.rawhook");
    tbt.on("open", () => { tbtOpen = true; rec.ev("tbt_open"); safe(() => { if (tbtDesired.size) { tbt.subscribe([...tbtDesired], "1", "depth"); tbt.switchChannel(new Set(), new Set(["1"])); } }, "tbt.open"); });
    tbt.on("depth", (symbol, d) => { try { rec.onTbt(symbol, d, Date.now()); } catch (e) { rec.err("tbt_depth", e); } });
    tbt.on("servererror", (m) => rec.ev("tbt_servererror", { message: typeof m === "string" ? m : JSON.stringify(m) }));
    tbt.on("error", (e) => rec.ev("tbt_error", { message: (e && e.message) || String(e) }));
    tbt.on("close", () => { tbtOpen = false; if (!ending) rec.ev("tbt_close"); });
  }
  sk.connect(); if (useTbt) tbt.connect();

  // ── REST: serialized queue ──
  let restP = Promise.resolve(); const rq = (fn) => { restP = restP.then(fn).catch((e) => rec.err("rest", e)); return restP; };
  const snapW = rec.open(path.join(outDir, "rest_snapshots.jsonl")), candW = rec.open(path.join(outDir, "rest_candles.jsonl")), fullW = rec.open(path.join(outDir, "rest_candles_full.jsonl"));
  const activeSyms = () => { const a = [lookup, fut]; if (rec.cur) a.push(rec.cur.ce, rec.cur.pe); return a; };
  const allSyms = () => [...rec.recs.keys()];
  const snapSec = Math.max(2, Number(opt("rest-snap-sec", 10))), chainSec = Math.max(10, Number(opt("chain-sec", 60))), chainWidth = Math.max(0, Number(opt("chain-width", 2)));
  const doChain = () => rq(async () => {
    const r = await withTimeout(f.getOptionChain({ symbol: lookup, strikecount: Math.max(10, chainWidth + 8), timestamp: cyc.expiry }), 15000, "getOptionChain");
    const list = (r && r.data && r.data.optionsChain) || [];
    const ks = [...chainMap.keys()].sort((a, b) => Math.abs(a - rec.cur.strike) - Math.abs(b - rec.cur.strike)).slice(0, 2 * chainWidth + 1), want = new Set();
    for (const k of ks) { const pp = chainMap.get(k); if (pp.CE) want.add(pp.CE); if (pp.PE) want.add(pp.PE); }
    const n = rec.onOptionChain(list, rec.lastPrice.index, Date.now(), want);
    if (!n) rec.ev("chain_empty", { listed: list.length, wanted: want.size });
  });
  const doSnapshot = () => rq(async () => {
    const syms = activeSyms(); const r = await withTimeout(f.getQuotes(syms), 15000, "snapshot getQuotes"); const now = Date.now();
    const q = {}; for (const x of (r && r.d) || []) if (x && x.n) q[x.n] = x.v;
    const ws = {}; for (const s of syms) { const rr = rec.recs.get(s); if (rr && rr.last && rr.last.recv) ws[s] = { ltp: rr.last.ltp, bid: rr.last.bid, ask: rr.last.ask, vol: rr.last.vol, age_ms: now - rr.last.recv }; }
    snapW.write({ recv_ms: now, recv_ist: istStamp(now), clock_offset_sec: rec.clock.offset(), rest: q, ws });
  });
  const fetchCandles = async (sym, from, to) => {
    const call = () => withTimeout(f.getHistory({ symbol: sym, resolution: "1", date_format: "0", range_from: String(from), range_to: String(to), cont_flag: "1", oi_flag: "1" }), 20000, "getHistory");
    const r = await withRateRetry(async () => { const x = await call(); if (x && x.s === "error") throw x; return x; }, { tries: 6, what: "candles " + sym });
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
    for (const s of allSyms()) { try { const cs = await fetchCandles(s, from, to); cs.forEach((c) => fullW.write(c)); rec.ev("rest_backfill", { sym: s, candles: cs.length }); } catch (e) { rec.ev("rest_backfill_error", { sym: s, message: e.message }); } await sleep(400); }
  };

  // ── periodic tasks ──
  let lastChain = 0, lastSnap = 0, lastStatus = 0, lastSum = 0, lastTok = Date.now(), finishing = false;
  const timer = setInterval(() => {
    const now = Date.now(), m = istMin(now), sec = new Date(now + IST_MS).getUTCSeconds();
    if (now - lastSnap >= snapSec * 1000) { lastSnap = now; doSnapshot(); }
    if (now - lastChain >= chainSec * 1000) { lastChain = now; doChain(); }
    if (sec >= 7 && Math.floor(now / 60000) !== lastCandleMin) { lastCandleMin = Math.floor(now / 60000); doCandles(); }
    if (m >= 556 && m < 929 && now - lastData > 90000 && now - lastReconnect > 300000) { lastReconnect = now; rec.ev("data_stall_reconnect", { silent_sec: Math.round((now - lastData) / 1000) }); safe(() => { sk.close(); }); setTimeout(() => safe(() => sk.connect(), "data.reconnect"), 2000); }
    else if (m >= 556 && m < 929 && now - lastData > 20000 && (now - lastData) % 20000 < 1000) rec.ev("data_silent", { sec: Math.round((now - lastData) / 1000) });
    if (m >= 556 && m < 929 && now - lastRealMsg > deadMin * 60000 && !deadLogged) {
      deadLogged = true;
      if (process.env.OFR_CHILD === "1") { rec.ev("data_socket_dead_restart", { silent_min: Math.round((now - lastRealMsg) / 60000), note: "supervisor restarts the recorder" }); clearInterval(timer); safe(() => sk.close()); if (useTbt) safe(() => tbt.close()); rec.closeAll().then(() => process.exit(75)); }
      else rec.ev("DATA_SOCKET_DEAD", { silent_min: Math.round((now - lastRealMsg) / 60000), note: "no quotes/5-level data. TBT continues. Run with --supervise to restart automatically" });
    }
    if (now - lastTok > 1800000) { lastTok = now; validateToken().then((ok) => { if (!ok) rec.ev("TOKEN_INVALID", { note: "Fyers token expired - log in via /admin; running sockets may drop" }); }).catch(() => {}); }
    if (now - lastSum > 300000) { lastSum = now; rec.writeSummary(); }
    if (now - lastStatus > 30000) { lastStatus = now; const c = rec.counts; console.log(`[${istStamp(now).slice(11, 19)}] FUT ${rec.lastPrice.fut} IDX ${rec.lastPrice.index} ATM ${rec.cur && rec.cur.strike} | quotes ${c.quotes} d5 ${c.depth5} tbt ${c.tbt} | clock offset ${rec.clock.offset().toFixed(1)}s clamped ${c.clamped} errors ${rec.errCount}`); }
    if (m >= untilMin && !has("force")) finish(`reached ${opt("until", "15:35")} IST`);
  }, 1000);

  // ── probe ──
  if (has("probe") && useTbt) setTimeout(() => runProbe().catch((e) => rec.err("probe", e)), Number(opt("probe-delay-min", 20)) * 60000);
  async function runProbe() {
    const R = { started_ist: istStamp(Date.now()), tests: [] }; rec.ev("probe_start");
    const ks = [...chainMap.keys()].sort((a, b) => Math.abs(a - rec.cur.strike) - Math.abs(b - rec.cur.strike));
    const pool = [fut]; for (const k of ks) { const p = chainMap.get(k); if (p.CE) pool.push(p.CE); if (p.PE) pool.push(p.PE); if (pool.length >= 9) break; }
    const six = pool.slice(0, 6), seventh = pool[6], extra = pool.slice(7);
    const mk = (label) => { const o = { label, open: false, closed: 0, errors: [], serr: [], frames: {} }; o.sock = makeTbt(); o.sock.on("open", () => { o.open = true; }); o.sock.on("close", () => { o.closed++; }); o.sock.on("error", (e) => o.errors.push((e && e.message) || String(e))); o.sock.on("servererror", (m) => o.serr.push(typeof m === "string" ? m : JSON.stringify(m))); o.sock.on("depth", (s) => { o.frames[s] = (o.frames[s] || 0) + 1; }); return o; };
    const waitOpen = async (o) => { for (let i = 0; i < 100 && !o.open; i++) await sleep(100); return o.open; };
    const rep = (o) => ({ opened: o.open, closes: o.closed, symbols_with_frames: Object.keys(o.frames).length, frames: Object.values(o.frames).reduce((a, b) => a + b, 0), server_errors: [...new Set(o.serr)], sdk_errors: [...new Set(o.errors)].slice(0, 3) });
    const p1 = mk("probe1"); p1.sock.connect();
    if (await waitOpen(p1)) {
      p1.sock.subscribe(six, "1", "depth"); p1.sock.switchChannel(new Set(), new Set(["1"])); await sleep(12000);
      const a = rep(p1); R.tests.push({ test: "A: 6 symbols on one channel (limit is believed to be 5)", ...a, verdict: a.server_errors.length ? "REFUSED: " + a.server_errors.join(" | ") : (a.symbols_with_frames >= 6 ? "NO ERROR - all 6 delivered" : `no error, but only ${a.symbols_with_frames} of 6 delivered`) });
      if (seventh) { const before = Object.keys(p1.frames).length; safe(() => p1.sock.unsubscribe([six[5]], "1", "depth")); safe(() => p1.sock.subsinfo.unsubscribe([six[5]], "1")); await sleep(1500); p1.serr.length = 0; p1.sock.subscribe([seventh], "1", "depth"); await sleep(8000); const b = rep(p1); R.tests.push({ test: "B: unsubscribe 1 symbol, subscribe another (rolling strikes)", server_errors: b.server_errors, new_symbol_got_frames: !!p1.frames[seventh], verdict: b.server_errors.length ? "ERROR: " + b.server_errors.join(" | ") : (p1.frames[seventh] ? "OK - swap works" : "no error but new symbol silent") }); }
    } else R.tests.push({ test: "A/B", verdict: "probe connection did not open", ...rep(p1) });
    const conns = Number(opt("probe-conns", 0)), cs = [p1];
    for (let i = 0; i < conns && extra.length; i++) { const o = mk("conn" + (i + 2)); o.sock.connect(); const ok = await waitOpen(o); if (ok) { o.sock.subscribe([extra[i % extra.length]], "1", "depth"); o.sock.switchChannel(new Set(), new Set(["1"])); } await sleep(8000); cs.push(o); const r = rep(o); R.tests.push({ test: `C: extra TBT connection #${i + 2} (main = 1, probe1 = 2)`, ...r, verdict: !r.opened ? "NOT OPENED (refused?) " + r.sdk_errors.join(" | ") : r.frames ? "OK - delivered frames" : "opened but no frames " + r.server_errors.join(" | ") }); }
    for (const o of cs) safe(() => o.sock.close());
    R.finished_ist = istStamp(Date.now()); fs.writeFileSync(path.join(outDir, "probe_results.json"), JSON.stringify(R, null, 2));
    rec.ev("probe_done", { tests: R.tests.map((t) => t.verdict) });
  }

  // ── finish ──
  async function finish(why) {
    if (finishing) return; finishing = true; ending = true; clearInterval(timer);
    console.log(`\nStopping (${why}) ...`);
    safe(() => sk.close()); if (useTbt) safe(() => tbt.close());
    await sleep(500); await restP.catch(() => {});
    try { await withTimeout(finalBackfill(), 120000, "backfill"); } catch (e) { rec.err("backfill", e); }
    await rec.closeAll();
    if (!has("no-parquet")) { console.log("\nParquet export ..."); try { await exportParquet(outDir, opt("dest", null)); } catch (e) { rec.err("parquet", e); console.error("Parquet export failed (JSONL files are safe, rerun with --export-only):", e.message); } }
    const s = rec.summary(); console.log("\nSUMMARY"); console.log(JSON.stringify({ counts: s.counts, clock_offset_sec: s.clock_offset_sec, errors: s.errors }, null, 1));
    for (const [k, v] of Object.entries(s.symbols)) console.log(`  ${v.role.padEnd(5)} ${k}: quotes ${v.quotes}, d5 ${v.depth5}, tbt50 ${v.tbt50}, seq gaps ${v.seq_gaps} (missed ${v.seq_missed}), sdk-merged flags ${JSON.stringify(v.tbt_quality_flags)} | rebuilt flags ${JSON.stringify(v.tbt_rebuilt_quality_flags)} | raw ${v.raw_packets} | dp top-5 match: sdk ${v.dp_top5_match.sdk_merged_pct}% rebuilt ${v.dp_top5_match.rebuilt_pct}% (of ${v.dp_top5_match.checked})`);
    console.log(`\nFiles are in ${outDir}`); process.exit(0);
  }
  process.on("SIGINT", () => finish("Ctrl+C"));
  process.on("SIGTERM", () => finish("terminated"));
  doSnapshot(); // first snapshot immediately
}

// ───────────────────────────── PARQUET EXPORT: 3 files per day (index, futures, options) ─────────────────────────────
const readline = require("readline");
async function* jsonlRows(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m && m.t === "H") continue; yield m; }
}
/** column types: S text, I int64, D double, B boolean, D[] / I[] = list (the 50 levels, position = level) */
const COMMON = [["event_type", "S"], ["symbol", "S"], ["role", "S"], ["strike", "D"], ["option_type", "S"], ["recv_ms", "I"], ["recv_ist", "S"], ["ts", "D"]];
const Q_COLS = [["exch_feed_time", "I"], ["last_traded_time", "I"], ["ltp", "D"], ["last_traded_qty", "I"], ["vol_traded_today", "I"], ["bid_price", "D"], ["ask_price", "D"], ["bid_size", "I"], ["ask_size", "I"], ["tot_buy_qty", "I"], ["tot_sell_qty", "I"],
  ["avg_trade_price", "D"], ["open_price", "D"], ["high_price", "D"], ["low_price", "D"], ["prev_close_price", "D"], ["ch", "D"], ["chp", "D"], ["lower_ckt", "D"], ["upper_ckt", "D"], ["type", "S"]];
const D5_COLS = ["bid_price", "ask_price", "bid_size", "ask_size", "bid_order", "ask_order"].flatMap((k) => [1, 2, 3, 4, 5].map((i) => [k + i, k.endsWith("price") ? "D" : "I"]));
const D50_COLS = [["src", "S"], ["feed_ts", "D"], ["feed_ts_raw", "S"], ["send_ts_raw", "S"], ["seq", "I"], ["snapshot", "B"], ["tbq", "I"], ["tsq", "I"], ["n_bid", "I"], ["n_ask", "I"], ["qf", "S"],
  ["l50_bid_price", "D[]"], ["l50_bid_qty", "I[]"], ["l50_bid_orders", "I[]"], ["l50_ask_price", "D[]"], ["l50_ask_qty", "I[]"], ["l50_ask_orders", "I[]"]];
const CANDLE_COLS = [["minute_epoch_s", "I"], ["minute_ist", "S"], ["open", "D"], ["high", "D"], ["low", "D"], ["close", "D"], ["volume", "I"], ["oi", "I"], ["iv", "D"], ["underlying_price", "D"]];
const SNAP_COLS = [["clock_offset_sec", "D"], ["lp", "D"], ["bid", "D"], ["ask", "D"], ["atp", "D"], ["spread", "D"], ["tt", "I"], ["imbalance", "D"], ["mkt_imbalance", "D"], ["reference_price", "D"], ["indicative_price", "D"],
  ["ws_ltp", "D"], ["ws_bid", "D"], ["ws_ask", "D"], ["ws_vol", "I"], ["ws_age_ms", "I"]];
const GREEK_COLS = [["ltp", "D"], ["bid", "D"], ["ask", "D"], ["delta", "D"], ["gamma", "D"], ["theta", "D"], ["vega", "D"], ["t_years", "D"], ["greeks_src", "S"]];
const unionCols = (...lists) => { const m = new Map(); for (const l of lists) for (const [n, t] of l) { if (m.has(n) && m.get(n) !== t) throw new Error(`column ${n} has two types`); m.set(n, t); } return [...m]; };
const FILE_COLS = {
  index: unionCols(COMMON, Q_COLS, CANDLE_COLS, SNAP_COLS),
  futures: unionCols(COMMON, Q_COLS, D5_COLS, D50_COLS, CANDLE_COLS, SNAP_COLS),
  options: unionCols(COMMON, Q_COLS, D5_COLS, D50_COLS, CANDLE_COLS, SNAP_COLS, GREEK_COLS),
};
const coerce = (v, t) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (t.endsWith("[]")) { if (!Array.isArray(v)) return undefined; const o = new Array(50).fill(0); for (let i = 0; i < 50 && i < v.length; i++) { const x = Number(v[i]); o[i] = Number.isFinite(x) ? (t[0] === "I" ? Math.round(x) : x) : 0; } return o; }
  if (t === "S") return String(v);
  if (t === "B") return !!v;
  const x = Number(v); if (!Number.isFinite(x)) return undefined; return t === "I" ? Math.round(x) : x;
};
const symInfo = (sym, roles) => { const m = /(\d{5})(CE|PE)$/.exec(sym); return { role: roles.get(sym) || (m ? m[2].toLowerCase() : /FUT$/.test(sym) ? "fut" : /INDEX$/.test(sym) ? "index" : ""), strike: m ? Number(m[1]) : undefined, option_type: m ? m[2] : undefined }; };
const kindOf = (role) => (role === "fut" ? "futures" : role === "index" ? "index" : "options");

/**
 * Converts a recorded day folder into exactly 3 Parquet files: index.parquet, futures.parquet, options.parquet (GZIP).
 * Every row has event_type = quote | depth5 | depth50 | candle_1m | rest_snapshot (| chain for options = IV + Greeks).
 * Rows are grouped by event_type and symbol, each group in time order - sort by recv_ms (or minute_epoch_s) for one timeline.
 * Row counts are re-read from the written files and checked.
 */
async function exportParquet(outDir, destDir, log = console.log) {
  const parquet = require("parquetjs-lite");
  const pdir = path.join(outDir, "parquet"); fs.mkdirSync(pdir, { recursive: true });
  for (const f of fs.readdirSync(pdir)) if (f.endsWith(".parquet")) fs.unlinkSync(path.join(pdir, f));   // never mix with an older export
  const roles = new Map(); for await (const e of jsonlRows(path.join(outDir, "events.jsonl"))) if (e.event === "track") roles.set(e.sym, e.role);
  const dirSym = new Map([...roles.keys()].map((x) => [safeName(x), x]));
  const tables = new Map();
  const table = async (kind) => {
    if (tables.has(kind)) return tables.get(kind);
    const cols = FILE_COLS[kind];
    const schema = new parquet.ParquetSchema(Object.fromEntries(cols.map(([n, t]) => [n, t.endsWith("[]") ? { type: t[0] === "I" ? "INT64" : "DOUBLE", repeated: true, compression: "GZIP" } : { type: { S: "UTF8", I: "INT64", D: "DOUBLE", B: "BOOLEAN" }[t], optional: true, compression: "GZIP" }])));
    const file = path.join(pdir, kind + ".parquet"); const w = await parquet.ParquetWriter.openFile(schema, file);
    const t = { kind, file, w, cols, n: 0, bad: 0, by: {} }; tables.set(kind, t); return t;
  };
  const add = async (kind, o) => {
    const t = await table(kind), row = {};
    for (const [n, ty] of t.cols) { const v = coerce(o[n], ty); if (v !== undefined) row[n] = v; }
    try { await t.w.appendRow(row); t.n++; t.by[o.event_type] = (t.by[o.event_type] || 0) + 1; } catch (e) { t.bad++; if (t.bad === 1) log(`  [warn] ${kind}: row skipped (${e.message})`); }
  };
  const symDir = path.join(outDir, "symbols");
  for (const d of fs.existsSync(symDir) ? fs.readdirSync(symDir) : []) {
    const dir = path.join(symDir, d); if (!fs.statSync(dir).isDirectory()) continue;
    let sym = dirSym.get(d); if (!sym) { for await (const q of jsonlRows(path.join(dir, "quotes.jsonl"))) { sym = q.symbol; break; } } if (!sym) continue;
    const info = symInfo(sym, roles), kind = kindOf(info.role), base = { symbol: sym, ...info };
    for await (const q of jsonlRows(path.join(dir, "quotes.jsonl"))) await add(kind, { ...q, ...base, event_type: "quote" });
    if (info.role === "index") continue;
    for await (const q of jsonlRows(path.join(dir, "depth5.jsonl"))) await add(kind, { ...q, ...base, event_type: "depth5" });
    const rbF = path.join(dir, "tbt50_rebuilt.jsonl"), useRb = fs.existsSync(rbF) && fs.statSync(rbF).size > 0;
    for await (const q of jsonlRows(useRb ? rbF : path.join(dir, "tbt50.jsonl"))) {
      const { bid_price, bid_qty, bid_orders, ask_price, ask_qty, ask_orders, ...rest } = q;
      await add(kind, { ...rest, ...base, event_type: "depth50", src: useRb ? "rebuilt-num" : "sdk-merged (unreliable)", l50_bid_price: bid_price, l50_bid_qty: bid_qty, l50_bid_orders: bid_orders, l50_ask_price: ask_price, l50_ask_qty: ask_qty, l50_ask_orders: ask_orders });
    }
  }
  let expiryMs = NaN; for await (const e of jsonlRows(path.join(outDir, "events.jsonl"))) if (e.event === "start" && e.expiry) { const [dd, mm, yy] = String(e.expiry).split("-").map(Number); expiryMs = Date.parse(`${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T15:30:00+05:30`); break; }
  const fullF = path.join(outDir, "rest_candles_full.jsonl"), candF = fs.existsSync(fullF) && fs.statSync(fullF).size > 0 ? fullF : path.join(outDir, "rest_candles.jsonl");   // whole-day file exists only after a clean stop
  const cands = [], seenC = new Set(); for await (const c of jsonlRows(candF)) { const ck = c.sym + "|" + c.minute_epoch_s; if (seenC.has(ck)) continue; seenC.add(ck); cands.push(c); }
  const spotAt = new Map(); for (const c of cands) if (symInfo(c.sym, roles).role === "index") spotAt.set(c.minute_epoch_s, c.close);
  for (const c of cands) { const si = symInfo(c.sym, roles), spot = spotAt.get(c.minute_epoch_s), iv = si.strike && spot ? greeksFor(c.close, spot, si.strike, expiryMs, c.minute_epoch_s * 1000, si.option_type).iv : null; await add(kindOf(si.role), { ...c, symbol: c.sym, ...si, event_type: "candle_1m", iv, underlying_price: si.role === "index" ? undefined : spot }); }
  for await (const sn of jsonlRows(path.join(outDir, "rest_snapshots.jsonl"))) for (const [sym, v] of Object.entries(sn.rest || {})) { const w = (sn.ws && sn.ws[sym]) || {}, si = symInfo(sym, roles); await add(kindOf(si.role), { ...v, symbol: sym, ...si, event_type: "rest_snapshot", recv_ms: sn.recv_ms, recv_ist: sn.recv_ist, clock_offset_sec: sn.clock_offset_sec, ws_ltp: w.ltp, ws_bid: w.bid, ws_ask: w.ask, ws_vol: w.vol, ws_age_ms: w.age_ms }); }
  for await (const g of jsonlRows(path.join(outDir, "rest_option_chain.jsonl"))) { if (!(g.iv > 0)) { const x = greeksFor(g.ltp, g.underlying_price, g.strike, expiryMs, g.recv_ms, g.option_type); if (x.iv !== null) Object.assign(g, x, { greeks_src: "computed at export: Black-Scholes r=7% spot=index price ltp" }); } await add("options", { ...g, ...symInfo(g.symbol, roles), event_type: "chain" }); }
  const report = []; let allOk = true;
  for (const t of tables.values()) {
    await t.w.close(); const r = await parquet.ParquetReader.openFile(t.file); const rows = Number(r.getRowCount()); await r.close();
    const ok = rows === t.n; if (!ok) allOk = false; report.push({ file: path.basename(t.file), rows, written: t.n, skipped: t.bad, mb: +(fs.statSync(t.file).size / 1e6).toFixed(2), ok, by: t.by });
  }
  for (const x of report) { log(`  ${x.ok ? "OK  " : "FAIL"} ${x.file.padEnd(17)} ${String(x.rows).padStart(8)} rows  ${String(x.mb).padStart(6)} MB${x.skipped ? "  (" + x.skipped + " rows skipped)" : ""}`); log(`       ${Object.entries(x.by).map(([k, v]) => k + " " + v).join(" | ")}`); }
  if (destDir && allOk) {
    let date = istDate(Date.now()); try { date = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")).started_ist.slice(0, 10); } catch { /* keep today */ }
    const dd = path.join(destDir, "TGG_Dataset", "INDEX", "NIFTY", "orderflow", date); fs.mkdirSync(dd, { recursive: true });
    for (const x of report) { const src = path.join(pdir, x.file), dst = path.join(dd, x.file); fs.copyFileSync(src, dst); const r = await parquet.ParquetReader.openFile(dst); const n = Number(r.getRowCount()); await r.close(); if (fs.statSync(dst).size !== fs.statSync(src).size || n !== x.rows) { allOk = false; log(`  FAIL copy check ${x.file}`); } }
    log(`  copied to ${dd} ${allOk ? "- sizes and row counts re-checked OK" : "- CHECK FAILED"}`);
  }
  log(allOk ? `PARQUET COMPLETE: ${report.length} files in ${pdir}` : "PARQUET: some checks failed - see FAIL lines");
  return { ok: allOk, report, dir: pdir };
}

// ───────────────────────────── SELFTEST (offline) ─────────────────────────────
async function runSelfTest() {
  const os = require("os"); const { spawnSync } = require("child_process");
  const results = []; const ok = (c, what, detail = "") => { results.push(!!c); console.log(`  [${c ? "PASS" : "FAIL"}] ${what}${detail ? " - " + detail : ""}`); };
  console.log(`=== ${VERSION} SELFTEST (no network) ===`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-"));
  // 1. pure helpers
  ok(normTs(1791789621) === 1791789621 && normTs(1791789621123) === 1791789621.123 && normTs("1791789621123456789") === 1791789621.123456789 && Number.isNaN(normTs(0)) && Number.isNaN(normTs(5)), "normTs handles s/ms/ns, rejects 0 and small numbers");
  const cs = new ClockSync(); for (let i = 0; i < 100; i++) cs.observe(1791789628000 + i * 1000 + (i % 7) * 40, 1791789621 + i);
  ok(Math.abs(cs.offset() - 7) < 0.3, "ClockSync finds the ~7 s PC-vs-exchange offset", `offset ${cs.offset().toFixed(2)} s`);
  const at = new AtmTracker({ step: 50, hyst: 5, dwellMs: 30000 }); at.init(22440, 0);
  ok(at.current === 22450, "ATM = nearest 50 (22440 -> 22450)");
  ok(at.check(22474, 60000) === null && at.check(22481, 60000) === 22500, "ATM does not switch inside +-25(+5), switches beyond");
  at.commit(22500, 100000); ok(at.check(22540, 110000) === null && at.check(22551, 140000) === 22550, "ATM dwell time stops flapping");
  { const S0 = 22440, K0 = 22450, T0 = 2 / (24 * 365), sg = 0.35, c = bsPrice(S0, K0, T0, RISK_FREE, sg, "CE"), pu = bsPrice(S0, K0, T0, RISK_FREE, sg, "PE");
    const gc = greeksFor(c, S0, K0, 1000 + T0 * 365 * 24 * 3600 * 1000, 1000, "CE"), gp = greeksFor(pu, S0, K0, 1000 + T0 * 365 * 24 * 3600 * 1000, 1000, "PE");
    ok(Math.abs(gc.iv - sg) < 2e-3 && Math.abs(gp.iv - sg) < 2e-3, "IV solver recovers the volatility used to price the option (call and put)", `call ${gc.iv} put ${gp.iv}`);
    ok(Math.abs(gc.delta - gp.delta - 1) < 1e-6 && Math.abs(gc.gamma - gp.gamma) < 1e-9 && Math.abs(gc.vega - gp.vega) < 1e-9, "Greeks obey put-call parity (delta_call - delta_put = 1, same gamma and vega)");
    ok(gc.gamma > 0 && gc.vega > 0 && gc.theta < 0 && gc.delta > 0 && gc.delta < 1, "Greek signs are right (gamma>0, vega>0, theta<0, 0<delta<1)");
    const bad = greeksFor(0.01, 22440, 22000, 1000 + T0 * 365 * 24 * 3600 * 1000, 1000, "CE"); ok(bad.iv === null && bad.delta === null, "impossible price gives null, never a fake number");
    ok(ownIV(120.5, 22440, 22450, T0, "CE") > 0, "ownIV solves a normal case"); }
  const fr = (n, base, seq, snap) => ({ bidprice: Array.from({ length: 50 }, (_, i) => (i < n ? base - 0.05 * i : 0)), askprice: Array.from({ length: 50 }, (_, i) => (i < n ? base + 0.05 * (i + 1) : 0)), bidqty: Array.from({ length: 50 }, (_, i) => (i < n ? 100 + i : 0)), askqty: Array.from({ length: 50 }, (_, i) => (i < n ? 200 + i : 0)), bidordn: Array.from({ length: 50 }, (_, i) => (i < n ? 3 : 0)), askordn: Array.from({ length: 50 }, (_, i) => (i < n ? 4 : 0)), tbq: 1000, tsq: 2000, snapshot: !!snap, timestamp: 1791789621 + seq, sendtime: 1791789621000000000, seqNo: seq });
  const tf = tbtFrame(fr(50, 22440, 10, true)); ok(tf && tf.n_bid === 50 && tf.n_ask === 50 && tf.qf === "", "tbtFrame reads 50+50 levels, no quality flags");
  const bad = fr(50, 22440, 11); bad.bidprice[10] = 99999; ok(tbtFrame(bad).qf.includes("M"), "tbtFrame flags unsorted bids (M)");
  ok(tbtFrame({}) === null, "tbtFrame returns null for a malformed frame");
  // 2. Recorder with mock io, real files
  const calls = []; const io = { dataSub: (s, d) => calls.push(["dataSub", s, d]), dataUnsub: (s) => calls.push(["dataUnsub", s]), tbtSub: (s) => calls.push(["tbtSub", s]), tbtUnsub: (s) => calls.push(["tbtUnsub", s]) };
  let T = 1791789628000; const atm = new AtmTracker({ step: 50, hyst: 5, dwellMs: 30000 });
  const rec = new Recorder({ outDir: dir, engineDepth: "tbt", atmRole: "fut", atm, useTbt: true, dataGraceSec: 0.05, expiryMs: 1791789628000 + 2 * 3600 * 1000, now: () => T, io, resolveStrike: async (k) => ({ ce: `NSE:NIFTY26O13${k}CE`, pe: `NSE:NIFTY26O13${k}PE` }) });
  const FUT = "NSE:NIFTY26OCTFUT", CE = "NSE:NIFTY26O1322450CE", PE = "NSE:NIFTY26O1322450PE", IDX = "NSE:NIFTY50-INDEX";
  rec.track(IDX, "index"); rec.track(FUT, "fut"); rec.track(CE, "ce"); rec.track(PE, "pe"); rec.cur = { strike: 22450, ce: CE, pe: PE }; atm.init(22440, T);
  let vol = 1000, px = 22440;
  for (let i = 0; i < 400; i++) {
    T += 250; const ex = 1791789621 + Math.floor(i / 4); if (i % 5 === 0) { vol += 65; }
    rec.onQuote({ symbol: FUT, type: "sf", ltp: px, last_traded_qty: i % 5 === 0 ? 65 : 0, vol_traded_today: vol, bid_price: px - 0.05, ask_price: px + 0.05, bid_size: 130, ask_size: 195, tot_buy_qty: 5e5, tot_sell_qty: 7e5, avg_trade_price: 22439.2, exch_feed_time: ex, last_traded_time: ex - 3, open_price: 22400, high_price: 22460, low_price: 22390, prev_close_price: 22410, ch: 30, chp: 0.13, upper_ckt: 0, lower_ckt: 0 }, T);
    if (i % 3 === 0) rec.onDepth5({ symbol: FUT, type: "dp", bid_price1: px - 0.05, bid_price2: px - 0.1, bid_price3: 0, bid_price4: 0, bid_price5: 0, ask_price1: px + 0.05, ask_price2: px + 0.1, ask_price3: 0, ask_price4: 0, ask_price5: 0, bid_size1: 130, bid_size2: 65, ask_size1: 195, ask_size2: 130, bid_order1: 2, ask_order1: 3 }, T);
    if (i % 2 === 0) rec.onTbt(FUT, fr(50, px, 100 + (i === 200 ? i + 5 : i / 2), i === 0), T);
    if (i === 100) rec.onTbt(CE, fr(20, 120, 5, true), T);
    if (i === 150) px = 22490;           // moves beyond +-30 of 22450 -> ATM switch
  }
  await sleep(300);
  ok(rec.cur && rec.cur.strike === 22500, "ATM switched 22450 -> 22500 on the futures price", rec.cur ? String(rec.cur.strike) : "");
  const order = calls.map((c) => c[0]); ok(order.indexOf("tbtSub") >= 0 && order.indexOf("tbtSub") < order.indexOf("tbtUnsub"), "new strikes subscribed BEFORE old ones dropped (never above 5 TBT symbols)", order.join(">"));
  ok(calls.find((c) => c[0] === "tbtSub")[1].length === 2 && calls.find((c) => c[0] === "tbtUnsub")[1].length === 2, "TBT: +2 symbols then -2 symbols (3 -> 5 -> 3)");
  ok(calls.some((c) => c[0] === "dataUnsub"), "old strikes unsubscribed from the data socket after the grace period");
  const s = rec.summary().symbols[FUT]; ok(s.seq_gaps === 1 && s.seq_missed > 0, "sequence gap detected", `gaps ${s.seq_gaps} missed ${s.seq_missed}`);
  const nch = rec.onOptionChain([{ symbol: CE, strike_price: 22450, option_type: "CE", bid: 120, ask: 121, ltp: 120.5, oi: 5000, volume: 900, greeks: { iv: 14.2, delta: 0.52, gamma: 0.001, theta: -22, vega: 8 } }, { symbol: "NSE:OTHER", greeks: {} }], 22440, T, new Set([CE]));
  ok(nch === 1, "option chain: IV/Greeks rows are written only for the wanted symbols");
  rec.ev("selftest_done"); await rec.closeAll();
  const rd = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const fd = path.join(dir, "symbols", safeName(FUT));
  const eng = rd(path.join(fd, "engine.jsonl")), q = rd(path.join(fd, "quotes.jsonl")), d5 = rd(path.join(fd, "depth5.jsonl")), tb = rd(path.join(fd, "tbt50.jsonl"));
  ok(eng[0].t === "H" && eng.filter((x) => x.t === "Q").length === 400 && eng.some((x) => x.t === "D" && x.bids.length === 50), "engine.jsonl: header, 400 Q lines, D lines with 50 levels", `${eng.length} lines`);
  let mono = true; for (let i = 2; i < eng.length; i++) if (eng[i].ts < eng[i - 1].ts) mono = false; ok(mono, "engine.jsonl timestamps never go backwards");
  ok(q.length === 400 && q[0].tot_buy_qty === 5e5 && q[0].avg_trade_price === 22439.2 && q[0].recv_ms && q[0].ts, "quotes.jsonl keeps every raw field + recv_ms + ts");
  ok(d5.length > 100 && d5[0].bid_order1 === 2 && d5[0].ask_size2 === 130, "depth5.jsonl keeps every 5-level field");
  ok(tb.length > 100 && tb[1].bid_price.length === 50 && tb[1].seq >= 0 && "send_ts_raw" in tb[1] && "tsq" in tb[1], "tbt50.jsonl keeps seq, tbq/tsq, send time and 50 levels");
  ok(fs.existsSync(path.join(dir, "atm_changes.jsonl")) && rd(path.join(dir, "atm_changes.jsonl")).length === 1, "atm_changes.jsonl has the switch");
  ok(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")).counts.quotes === 400, "summary.json written");
  { let pq = null; try { pq = require("parquetjs-lite"); } catch { /* optional here */ }
    if (pq) {
      const rr = await exportParquet(dir, null, () => {});
      const on = fs.readdirSync(path.join(dir, "parquet")).filter((x) => x.endsWith(".parquet"));
      ok(rr.ok && on.length === rr.report.length && on.length <= 3 && on.every((x) => ["index.parquet", "futures.parquet", "options.parquet"].includes(x)), "Parquet export: only index / futures / options files, all re-read with matching row counts", on.join(" "));
      const fu = rr.report.find((x) => x.file === "futures.parquet"), op = rr.report.find((x) => x.file === "options.parquet");
      ok(fu && fu.by.quote === 400 && fu.by.depth5 > 100 && fu.by.depth50 > 100 && op && op.by.chain === 1, "Parquet: futures has quote (400), depth5 and depth50 rows; options has the IV/Greeks chain row", JSON.stringify(fu && fu.by));
      const readAll = async (f) => { const r = await pq.ParquetReader.openFile(path.join(dir, "parquet", f)), c = r.getCursor(), out = []; for (let x = await c.next(); x; x = await c.next()) out.push(x); await r.close(); return out; };
      const orows = await readAll("options.parquet"), row = orows.find((x) => x.event_type === "chain");
      ok(row && row.iv > 0 && row.delta > 0 && row.delta < 1 && row.gamma > 0 && row.theta < 0 && row.vega > 0 && row.underlying_price === 22440 && /Black-Scholes/.test(row.greeks_src) && row.role === "ce" && row.strike === 22450, "Parquet: chain row has computed IV + Greeks, strike and role", `iv ${row && row.iv} delta ${row && row.delta && row.delta.toFixed(3)}`);
      const frows = await readAll("futures.parquet"), d50 = frows.find((x) => x.event_type === "depth50"), qrow = frows.find((x) => x.event_type === "quote");
      ok(d50 && d50.l50_bid_price.length === 50 && d50.l50_ask_qty.length === 50 && qrow && qrow.ltp > 0 && Number(qrow.tot_buy_qty) === 5e5, "Parquet: depth50 rows keep 50-level lists; quote rows keep every quote column");
    } else console.log("  [SKIP] parquetjs-lite not installed here - Parquet check skipped"); }
  { // window mode: strike switches must NOT touch the data socket (only TBT)
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "ofr3-")), calls3 = []; let T3 = 1791789700000;
    const io3 = { dataSub: (a) => calls3.push(["dataSub", a]), dataUnsub: (a) => calls3.push(["dataUnsub", a]), tbtSub: (a) => calls3.push(["tbtSub", a]), tbtUnsub: (a) => calls3.push(["tbtUnsub", a]) };
    const sy = (k, t) => `NSE:NIFTY26O13${k}${t}`, win = new Set([sy(22450, "CE"), sy(22450, "PE"), sy(22500, "CE"), sy(22500, "PE")]);
    const r3 = new Recorder({ outDir: dir3, engineDepth: "dp", atmRole: "fut", atm: new AtmTracker(), useTbt: true, dataGraceSec: 0.05, windowSyms: win, now: () => T3, io: io3, resolveStrike: async (k) => ({ ce: sy(k, "CE"), pe: sy(k, "PE") }) });
    r3.cur = { strike: 22450, ce: sy(22450, "CE"), pe: sy(22450, "PE") }; r3.atm.init(22440, T3);
    await r3.rollAtm(22500, 22490, T3); await sleep(150);
    ok(calls3.map((c) => c[0]).join() === "tbtSub,tbtUnsub", "window mode: a strike switch inside the window touches only TBT, never the data socket", calls3.map((c) => c[0]).join());
    await r3.rollAtm(22600, 22590, T3); await sleep(150);
    ok(calls3.some((c) => c[0] === "dataSub" && c[1].includes(sy(22600, "CE"))), "window mode: a strike OUTSIDE the window is still subscribed on the data socket (fallback)");
    ok(fs.readFileSync(path.join(dir3, "events.jsonl"), "utf8").includes("atm_outside_window"), "window mode: leaving the window is logged (atm_outside_window)");
    await r3.closeAll(); fs.rmSync(dir3, { recursive: true, force: true });
  }
  { // supervisor: restarts a child that exits with 75, stops on a normal exit
    const tmp = path.join(dir, "child.js"), flag = path.join(dir, "ran.txt");
    fs.writeFileSync(tmp, `const fs=require("fs");const f=${JSON.stringify(flag)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));process.exit(process.env.OFR_CHILD==="1"&&n<2?75:0);`);
    const rs = await runSupervised([tmp], { untilMin: 24 * 60, log: () => {}, restartDelayMs: 50 });
    ok(rs.runs === 3 && rs.code === 0, "supervisor restarts a child that exits with 75 (data socket dead) and stops after a normal exit", `runs ${rs.runs}, final code ${rs.code}`);
  }
  { const H = new Set(["2026-10-15"]), at = (x) => Date.parse(x + "+05:30");
    const g1 = marketGate(at("2026-10-14T08:30:00"), H), g2 = marketGate(at("2026-10-14T09:30:00"), H), g3 = marketGate(at("2026-10-14T16:00:00"), H), g4 = marketGate(at("2026-10-17T10:00:00"), H), g5 = marketGate(at("2026-10-15T10:00:00"), H);
    ok(g1.state === "before" && Math.abs(g1.waitMs - 30 * 60000) < 1000 && g2.state === "open" && g3.state === "closed" && g4.reason === "weekend" && g5.reason === "NSE holiday", "marketGate: waits before 09:00 (30 min at 08:30), open 09:30, closed after 15:30, weekend and holiday detected", `${g1.state}/${g2.state}/${g3.state}/${g4.reason}/${g5.reason}`);
    let calls = 0, clock = 0; const okTok = await waitForValidToken(async () => ++calls > 3, { deadlineMs: 10 * 3600000, pollMs: 30000, log: () => {}, now: () => clock, sleepFn: async (ms) => { clock += ms; } });
    const noTok = await waitForValidToken(async () => false, { deadlineMs: 600000, pollMs: 30000, log: () => {}, now: () => clock, sleepFn: async (ms) => { clock += ms; } });
    ok(okTok === true && calls === 4 && noTok === false, "waitForValidToken: keeps checking until the token becomes valid, gives up at the deadline", `valid after ${calls} checks`); }
  { let n = 0; const logs = [];
    const okv = await withRateRetry(async () => { if (++n < 4) throw { code: -360, message: "You've reached the Standard plan limit of 5 requests/second.", s: "error" }; return "done"; }, { waitMs: 1, log: (m) => logs.push(m), sleepFn: async () => {} });
    let other = null; try { await withRateRetry(async () => { throw new Error("some other failure"); }, { waitMs: 1, sleepFn: async () => {} }); } catch (e) { other = e.message; }
    let gave = null; try { await withRateRetry(async () => ({ s: "error", code: -360, message: "limit of 5 requests/second" }), { tries: 3, waitMs: 1, log: () => {}, sleepFn: async () => {} }); } catch (e) { gave = e.code; }
    ok(okv === "done" && n === 4 && logs.length >= 1 && other === "some other failure" && gave === -360, "rate-limit retry: retries the -360 error until it works, fails fast on other errors, gives up after the retry limit", `succeeded on try ${n}`); }
  // 2b. TBT RAW hook + rebuilt book, through the REAL SDK DataStore (offline, synthetic packets)
  ok(pv({ value: 5 }) === 5 && pv(7) === 7 && Number.isNaN(pv(null)) && pv({ toNumber: () => 9 }) === 9, "pv unwraps protobuf wrapper values, plain numbers and Long");
  const sm = new SigMatcher(); sm.push("rb", 1000, "s"); sm.dp(1200, "s"); sm.push("sdk", 1500, "x"); sm.flush(99999);
  ok(sm.n === 1 && sm.hit.rb === 1 && sm.hit.sdk === 0, "SigMatcher counts a 5-level match for the right book only");
  try {
    const sdk = require("fyers-api-v3"); const e0 = console.error; console.error = () => {}; let t; try { t = new sdk.fyersTbtSocket("a:b", "", false, false); } finally { console.error = e0; }
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ofr2-")); let T2 = 1791789700000;
    const r2 = new Recorder({ outDir: dir2, engineDepth: "rebuilt", saveRebuilt: true, atmRole: "fut", atm: null, useTbt: true, now: () => T2, io, resolveStrike: async () => null });
    r2.track(FUT, "fut");
    const ds = t.datastore, orig = ds.updateDepth.bind(ds); ds.updateDepth = (pk, cb2, diff) => { r2.onTbtPacket(pk, T2); return orig(pk, cb2, diff); };
    const W = (x) => ({ value: x });
    const lvl = (i, side) => ({ price: W(side === "a" ? 2265000 + 50 * i : 2264950 - 50 * i), qty: W(100 + i), nord: W(2), num: W(i + 1) });
    const mk = (snap, seq, a, b) => ({ snapshot: snap, feeds: { x: { ticker: FUT, feedTime: W(1791789700 + seq), sendTime: W(1791789700000 + seq), sequenceNo: seq, depth: { tbq: W(1000), tsq: W(2000), asks: a, bids: b } } } });
    const sdkFrames = []; const cb = (sym, d) => { sdkFrames.push(tbtFrame(d)); r2.onTbt(sym, d, T2); };
    ds.updateDepth(mk(true, 1, Array.from({ length: 50 }, (_, i) => lvl(i, "a")), Array.from({ length: 50 }, (_, i) => lvl(i, "b"))), cb, false);
    T2 += 500;
    const chg = (i, side, q) => ({ ...lvl(i, side), qty: W(q) });   // a diff that changes only the quantity of level 3 and level 7
    ds.updateDepth(mk(false, 2, [chg(2, "a", 999), chg(6, "a", 777)], [chg(2, "b", 888), chg(6, "b", 666)]), cb, false);
    await sleep(100); await r2.closeAll();
    const f2 = path.join(dir2, "symbols", safeName(FUT)); const raw = rd(path.join(f2, "tbt_raw.jsonl")), rb = rd(path.join(f2, "tbt50_rebuilt.jsonl")).filter((x) => !x.t), e2 = rd(path.join(f2, "engine.jsonl"));
    ok(raw.length === 2 && raw[0].n_asks === 50 && raw[1].n_asks === 2 && raw[0].asks[0][3] === 1 && raw[1].asks[0][3] === 3, "tbt_raw.jsonl keeps each update exactly as sent, including the level `num`", `${raw.length} raw lines`);
    ok(rb.length === 2 && rb[1].ask_qty[2] === 999 && rb[1].ask_qty[6] === 777 && rb[1].bid_qty[2] === 888 && rb[1].ask_qty[0] === 100 && rb[1].qf === "", "rebuilt book puts the diff at level num-1 and keeps all other levels, no quality flags");
    ok(sdkFrames.length === 2 && sdkFrames[1].ask_qty[0] === 999 && sdkFrames[1].ask_qty[1] === 777 && sdkFrames[1].qf.includes("M"), "SDK merge puts the same diff at array positions 1-2 and breaks the price order (the suspected bug, shown on synthetic data)");
    ok(e2.filter((x) => x.t === "D").length === 2 && e2.filter((x) => x.t === "D")[1].asks[2][1] === 999, "--engine-depth rebuilt writes the rebuilt book into engine.jsonl");
    ok(fs.existsSync(path.join(dir2, "tbt_raw_samples.jsonl")) && rd(path.join(dir2, "tbt_raw_samples.jsonl")).length === 2 && JSON.parse(fs.readFileSync(path.join(dir2, "summary.json"), "utf8")).symbols[FUT].raw_packets === 2, "raw samples + summary (raw_packets, dp_top5_match) written");
    fs.rmSync(dir2, { recursive: true, force: true });
  } catch (e) { ok(false, "raw/rebuilt test crashed", e.message.split("\n")[0]); }
  // 3. real engine, if found
  const eng_py = [opt("engine", ""), path.resolve(__dirname, "orderflow_engine.py"), path.resolve(process.cwd(), "orderflow_engine.py")].find((p) => p && fs.existsSync(p));
  if (eng_py) {
    const py = ["python", "python3", "py"].find((c) => spawnSync(c, ["--version"]).status === 0);
    if (py) { const r = spawnSync(py, [eng_py, path.join(fd, "engine.jsonl"), "--ceiling", "22500", "--floor", "22300"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } }); const out = (r.stdout || "") + (r.stderr || ""); ok(r.status === 0 && /candles? finalized|finalized/i.test(out) && !/\b0 candles finalized/i.test(out), "sir's engine reads engine.jsonl and finalizes candles", r.status === 0 ? (out.split("\n").filter((x) => /candles? finalized/i.test(x))[0] || "") : "engine error: " + out.trim().split("\n").slice(-1)[0].slice(0, 140)); }
    else console.log("  [SKIP] python not found - engine check skipped");
  } else console.log("  [SKIP] orderflow_engine.py not found next to this script (use --engine <path>) - engine check skipped");
  // 4. SDK shape
  try {
    const sdk = require("fyers-api-v3"); ok(typeof sdk.fyersTbtSocket === "function" && typeof sdk.fyersDataSocket === "function", "fyers-api-v3 exports both sockets");
    const e0 = console.error; console.error = () => {}; let t; try { t = new sdk.fyersTbtSocket("a:b", "", false, false); } finally { console.error = e0; }
    ok(["subscribe", "unsubscribe", "switchChannel", "autoreconnect", "connect", "close", "on"].every((m) => typeof t[m] === "function") && typeof t.subsinfo.unsubscribe === "function", "TBT socket has subscribe/unsubscribe/switchChannel/autoreconnect + subsinfo.unsubscribe (SDK memory fix works)");
    t.subsinfo.subscribe(["A", "B", "C"], "1", "depth"); t.subsinfo.unsubscribe(["A", "B"], "1"); ok([...t.subsinfo.getSymbolsInfo("1")].join() === "C", "subsinfo.unsubscribe really removes symbols");
  } catch (e) { console.log(`  [SKIP] fyers-api-v3 not installed here (${e.message.split("\n")[0]}) - SDK shape check skipped`); }
  fs.rmSync(dir, { recursive: true, force: true });
  const bad2 = results.filter((x) => !x).length; console.log(`\n${results.length - bad2}/${results.length} checks passed${bad2 ? " - " + bad2 + " FAILED" : ""}`); process.exit(bad2 ? 1 : 0);
}

// ───────────────────────────── main ─────────────────────────────
/** Runs this same script as a child and restarts it (exit code 75 = data socket dead) until the stop time. Same --out folder, files are appended. */
function runSupervised(args, { untilMin, log = console.log, restartDelayMs = 5000 } = {}) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    let n = 0;
    const run = () => {
      n++; log(`[supervisor] starting run #${n}`);
      const c = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, OFR_CHILD: "1" } });
      c.on("error", (e) => { log("[supervisor] cannot start: " + e.message); resolve({ code: 1, runs: n }); });
      c.on("exit", (code) => { if (code === 75 && istMin(Date.now()) < untilMin) { log("[supervisor] data socket was dead - restarting in " + restartDelayMs / 1000 + " s"); setTimeout(run, restartDelayMs); } else resolve({ code: code || 0, runs: n }); });
    };
    run();
  });
}

if (require.main === module && has("supervise") && process.env.OFR_CHILD !== "1" && !has("selftest") && !has("export-only")) {
  process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});   // Ctrl+C reaches the child, which stops cleanly; the supervisor then ends too
  runSupervised(process.argv.slice(1).filter((a) => a !== "--supervise"), { untilMin: hhmm(opt("until", "15:35")) }).then((r) => process.exit(r.code));
} else if (require.main === module) {
  (has("selftest") ? runSelfTest() : has("export-only") ? exportParquet(path.resolve(opt("export-only", ".")), opt("dest", null)).then((r) => process.exit(r.ok ? 0 : 1)) : runLive()).catch((e) => { console.error("FAILED:", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e); process.exit(1); });
}
module.exports = { exportParquet, ClockSync, AtmTracker, tbtFrame, normTs, Recorder, LineWriter };