/**
 * backend/src/parrva/ofrExport.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * End-of-day Parquet export for the dashboard recorder: exactly 3 files per day, index.parquet,
 * futures.parquet and options.parquet, in <day folder>/parquet/.
 *
 * The code below is COPIED from backend/src/scripts/orderFlowRecorder.js (the collector whose files the
 * Telegram bot sends), so the columns, event types and values are the same. That script is NOT changed.
 * One addition, to match the files the bot sends today: options rows also get
 *   expiry_date (YYYY-MM-DD), expiry_type (weekly | monthly), days_to_expiry (calendar days from the day).
 *
 * Manual run (any day folder):  node src/parrva/ofrExport.js parrva_data/recordings/2026-11-05
 */
"use strict";

const fs = require("fs");
const path = require("path");

const IST_MS = 19800000;
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istStamp = (ms) => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 23);
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

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
// ADDED (dashboard recorder): same three columns as the files the Telegram bot sends.
const EXPIRY_COLS = [["expiry_date", "S"], ["expiry_type", "S"], ["days_to_expiry", "I"]];
const dmyToIso = (d) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? String(d) : null); };
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const unionCols = (...lists) => { const m = new Map(); for (const l of lists) for (const [n, t] of l) { if (m.has(n) && m.get(n) !== t) throw new Error(`column ${n} has two types`); m.set(n, t); } return [...m]; };
const FILE_COLS = {
  index: unionCols(COMMON, Q_COLS, CANDLE_COLS, SNAP_COLS),
  futures: unionCols(COMMON, Q_COLS, D5_COLS, D50_COLS, CANDLE_COLS, SNAP_COLS),
  options: unionCols(COMMON, Q_COLS, D5_COLS, D50_COLS, CANDLE_COLS, SNAP_COLS, GREEK_COLS, EXPIRY_COLS),
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
  // ADDED: expiry per option symbol (the day's main expiry from the "start" event, other expiries from "expiry" events).
  const dayIso = /^\d{4}-\d{2}-\d{2}$/.test(path.basename(outDir)) ? path.basename(outDir) : istDate(Date.now());
  let mainExp = null; const expOf = new Map();
  for await (const e of jsonlRows(path.join(outDir, "events.jsonl"))) {
    if (e.event === "start" && e.expiry && !mainExp) mainExp = { expiry_date: dmyToIso(e.expiry), expiry_type: e.expiry_type || null };
    if (e.event === "expiry" && e.sym) expOf.set(e.sym, { expiry_date: dmyToIso(e.expiry_date), expiry_type: e.expiry_type || null });
  }
  const expiryCols = (sym) => { const x = expOf.get(sym) || mainExp; return x && x.expiry_date ? { expiry_date: x.expiry_date, expiry_type: x.expiry_type || undefined, days_to_expiry: daysBetween(dayIso, x.expiry_date) } : {}; };
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
    if (kind === "options" && o.symbol) o = { ...expiryCols(o.symbol), ...o };
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


module.exports = { exportParquet, greeksFor, FILE_COLS };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node src/parrva/ofrExport.js <day folder>"); process.exit(1); }
  exportParquet(path.resolve(dir), null).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
}
