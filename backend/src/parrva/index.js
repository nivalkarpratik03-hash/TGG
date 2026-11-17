/**
 * backend/src/parrva/index.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * The live PaRRVA report service. One instance per backend process (createParrvaLive()).
 *
 *   feed      parrvaFeed.js       PaRRVA calls: webhook (webhook.js) + API checks, or API polling
 *   alerts    alerts.js           Telegram alerts from the Admin page status (systemStatus.js)
 *   symbols   marketData.js       each of today's calls -> its real Fyers option symbol
 *   recorder  recorderManager.js  child process on Fyers account 2: ticks, 5- and 50-level depth, files
 *   candles   here                1-minute candles per symbol: Fyers history (REST) + live recorder candles
 *   ticks     tickStore.js        1-second bars from the recorder's tick file (status is judged on these)
 *   status    tradeStatus.js      entry / target / SL / exit / points per call
 *
 * Stored under PARRVA_DATA_DIR (default backend/parrva_data):
 *   versions.json                 every version of every call we have seen
 *   symbols.json                  call id -> Fyers option symbol (so earlier days still find their data)
 *   candles/<date>.json           the day's 1-minute candles (saved every 5 min and at the end of the day)
 *   secbars/<date>.json           the day's 1-second bars per option + how far the tick file was read
 *   results/<date>.json           final status of every call of that day (written after 15:31 IST)
 *                                 + the same rows in Postgres table parrva_results (resultsDb.js), used when the file is gone
 *   recordings/<date>/*.jsonl     raw recorder files (quotes, depth5, depth50, events)
 *   recordings/<date>/parrva-other/<SYMBOL>/quotes.jsonl   ticks of non-NIFTY calls (stock, MCX ...), report only
 * After the day is final and on Drive (Parquet + results.json) and in Postgres, driveUpload.js deletes the day's
 * recordings, candles, secbars and results file together; the page then reads that day from Postgres.
 * MCX calls: tracked until the MCX close (evening watcher in recorderManager.js), final ~30 min after it.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const U = require("./util");
const { ParrvaFeed } = require("./parrvaFeed");
const { RecorderManager } = require("./recorderManager");
const market = require("./marketData");
const { evaluate, summarize } = require("./tradeStatus");
const { TickStore, pastStore } = require("./tickStore");
const { Alerts } = require("./alerts");
const { ResultsDb } = require("./resultsDb");
const { DriveUpload } = require("./driveUpload");

// Bump when the status rules change, so the day's results file is rewritten with the new rules.
const RULES_VERSION = 4;   // 4 = tick-level checks + AVOIDED + points from the band (05 Nov 2026)

class ParrvaLive {
  constructor() {
    this.feed = new ParrvaFeed();
    this.recorder = new RecorderManager();
    this.symbolOf = new Map();       // rec.id -> { symbol, underlying, error, at }
    this.closeOfSym = new Map();     // symbol -> market close (minutes IST) of the call it belongs to
    this.symbolsFile = path.join(U.dataRoot(), "symbols.json");
    this.savedSymbols = U.readJson(this.symbolsFile, {});   // rec.id -> symbol, kept across restarts and days
    this.candles = new Map();        // symbol -> Map(t -> candle)
    this.restAt = new Map();         // symbol -> last REST history fetch (ms)
    this.failAt = new Map();         // symbol -> last failed REST history fetch (ms), retried after 2 min
    this.candleDay = U.istDate();
    this.resolving = null;
    this.timers = [];
    this.started = false;
    this.loadCandles(this.candleDay);
    this.ticks = new TickStore(this.candleDay);
    this.alerts = new Alerts(this);   // Telegram alerts from the Admin page status (2026-11-07)
    this.db = new ResultsDb();        // final results in Postgres (2026-11-13)
    this.drive = new DriveUpload(this);   // Parquet -> Google Drive, then old recordings deleted (2026-11-13)
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.feed.on("update", () => this.sync().catch((e) => console.warn("[PaRRVA] sync failed:", e.message)));
    this.recorder.on("candles", (cs) => this.mergeLive(cs));
    this.feed.start();
    this.recorder.startLoop();
    this.alerts.start();
    this.openDb();
    this.drive.start();
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn("[PaRRVA]", e.message)); }, ms); if (t.unref) t.unref(); this.timers.push(t); };
    every(120000, () => this.restRefresh());      // heal gaps with Fyers history (only symbols that need it)
    every(300000, () => this.saveCandles());      // keep today's candles on disk
    every(60000, () => this.endOfDay());          // results file after the close
    every(60000, () => this.sync());              // new day / token now valid / unresolved symbols retry
    every(600000, () => { if (this.db.enabled() && !this.db.ready) return this.openDb(); return null; });   // database came back
    console.log("[PaRRVA] live report service started");
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.alerts.stop();
    this.drive.stop();
    this.feed.stop();
    this.recorder.stop("backend shutting down");
    this.saveCandles();
  }

  /** Open the results table and copy in any results files it does not have yet. */
  openDb() {
    if (this._dbOpening) return this._dbOpening;
    this._dbOpening = this.db.init()
      .then((ok) => (ok ? this.db.backfillFrom(path.join(U.dataRoot(), "results"), (d) => this.recorder.firstStartOf(d)) : 0))
      .catch((e) => console.warn("[PaRRVA DB]", e.message))
      .finally(() => { this._dbOpening = null; });
    return this._dbOpening;
  }

  // ── symbols + subscriptions ───────────────────────────────────────────────
  async sync() {
    const today = U.istDate();
    if (today !== this.candleDay) {          // new trading day
      this.ticks.refresh({ minGapMs: 0, all: true });
      this.saveCandles();
      this.candles = new Map(); this.closeOfSym = new Map(); this.restAt = new Map(); this.failAt = new Map(); this.candleDay = today;
      this.loadCandles(today);
      this.ticks = new TickStore(today);
    }
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      const calls = this.feed.today();
      const dayDone = this.dayDone(today);   // results final: no more Fyers history needed for today
      for (const und of new Set(calls.map((r) => market.underlyingSymbol(r.underlying)).filter(Boolean))) {
        if (!dayDone && this.needsBackfill(und)) await this.backfill(und).catch((e) => this.warnOnce(e.message, `history ${und}`));
      }
      for (const rec of calls) {
        const known = this.symbolOf.get(rec.id);
        const key = `${rec.exchange}|${rec.instrument}|${rec.underlying}|${rec.expiry}|${rec.strike}|${rec.cp}`;
        const sameContract = known && known.key === key;
        if (sameContract && (known.symbol || Date.now() - known.at < 5 * 60 * 1000)) continue;
        const r = await market.resolveSymbol(rec);
        // Not logged in: nothing was sent to Fyers, so look again on the next sync (every 60 s) instead of in 5 min.
        this.symbolOf.set(rec.id, { ...r, key, at: r.error === market.NOT_LOGGED_IN ? 0 : Date.now() });
        if (r.symbol && this.savedSymbols[rec.id] !== r.symbol) { this.savedSymbols[rec.id] = r.symbol; U.writeJson(this.symbolsFile, this.savedSymbols); }
        if (r.symbol) this.closeOfSym.set(r.symbol, U.closeMinOf(rec));
        if (r.symbol && !dayDone && this.needsBackfill(r.symbol)) await this.backfill(r.symbol).catch((e) => this.warnOnce(e.message, `history ${r.symbol}`));
        if (r.error) this.warnOnce(r.error, `${rec.name} ${rec.label}`);
      }
      this.pushSubscriptions(calls);
    })().finally(() => { this.resolving = null; });
    return this.resolving;
  }

  /** Same error for many calls (e.g. no valid token) -> one line per 30 min, not one per call. */
  warnOnce(error, what) {
    if (!this.warned) this.warned = new Map();
    const last = this.warned.get(error);
    if (last && Date.now() - last < 30 * 60000) return;
    this.warned.set(error, Date.now());
    console.warn(`[PaRRVA] ${what}: ${error}${last === undefined ? "" : " (still failing)"} - same error for other calls is hidden for 30 min`);
  }

  /**
   * Symbols for the recorder. Only NIFTY index options are recorded into the NIFTY dataset (meta.dataset = true);
   * every other call (stock, MCX, SENSEX ...) is tracked for this report only, into recordings/<date>/parrva-other.
   * 50-level depth only for NIFTY calls. Calls whose market closes after the NIFTY recorder stops (MCX) are handed
   * to the evening watcher (recorderManager.setWatch) until their market closes.
   */
  pushSubscriptions(calls = this.feed.today()) {
    const syms = new Set();
    const tbt = [];
    const meta = {};
    const watch = new Set();
    let watchUntil = 0;
    const nowMin = U.istMinutes();
    for (const rec of calls) {
      const und = market.underlyingSymbol(rec.underlying);
      if (und) syms.add(und);
      const s = this.symbolOf.get(rec.id);
      if (!s || !s.symbol) continue;
      const dataset = U.isDatasetCall(rec);
      syms.add(s.symbol);
      meta[s.symbol] = { expiry: rec.expiry, dataset: dataset || (meta[s.symbol] && meta[s.symbol].dataset) || false };
      const st = this.statusOf(rec);
      const live = ["WAITING", "OPEN", "NO_DATA"].includes(st.state);
      if (dataset && live && !tbt.includes(s.symbol)) tbt.push(s.symbol);   // newest first (feed is sorted)
      const close = U.closeMinOf(rec);
      if (!dataset && live && close > 935 && nowMin < close) { watch.add(s.symbol); watchUntil = Math.max(watchUntil, close); }
    }
    if (!syms.size) syms.add("NSE:NIFTY50-INDEX");
    this.recorder.setSymbols([...syms], tbt.slice(0, 5), meta);
    this.recorder.setWatch([...watch], watchUntil || null);
  }

  // ── candles ───────────────────────────────────────────────────────────────
  candleMap(sym) {
    let m = this.candles.get(sym);
    if (!m) { m = new Map(); this.candles.set(sym, m); }
    return m;
  }
  candlesOf(sym) {
    const m = this.candles.get(sym);
    return m ? [...m.values()].sort((a, b) => a.t - b.t) : [];
  }
  mergeLive(cs) {
    for (const [sym, list] of Object.entries(cs || {})) {
      const m = this.candleMap(sym);
      for (const c of list || []) {
        if (!c || !Number.isFinite(c.t)) continue;
        if (U.istDate(c.t * 1000) !== this.candleDay) continue;
        const old = m.get(c.t);
        // Live candle wins for the minute it covers; keep the wider range if REST already had one.
        m.set(c.t, old ? { t: c.t, o: old.o, h: Math.max(old.h, c.h), l: Math.min(old.l, c.l), c: c.c, v: Math.max(old.v || 0, c.v || 0) } : c);
      }
    }
  }
  /** Never fetched, or the last fetch failed more than 2 minutes ago. */
  needsBackfill(sym) {
    return !this.restAt.has(sym) && Date.now() - (this.failAt.get(sym) || 0) > 120000;
  }
  async backfill(sym) {
    const day = this.candleDay;
    const close = this.closeOfSym.get(sym) || 930;   // MCX symbols trade into the evening
    const from = U.istAt(day, 9, close > 930 ? 0 : 15);
    const to = Math.min(Date.now(), U.istAt(day, Math.floor(close / 60), close % 60));
    if (to <= from) return;
    this.restAt.set(sym, Date.now());
    let list;
    try {
      list = await market.fetchMinuteCandles(sym, from, to);
      this.failAt.delete(sym);
    } catch (e) {
      // Forget it so sync() tries again (after a restart past the close this used to leave "No data" for good).
      this.restAt.delete(sym); this.failAt.set(sym, Date.now());
      throw e;
    }
    const m = this.candleMap(sym);
    for (const c of list) {
      if (U.istDate(c.t * 1000) !== day) continue;
      const old = m.get(c.t);
      m.set(c.t, old ? { t: c.t, o: c.o, h: Math.max(old.h, c.h), l: Math.min(old.l, c.l), c: old.c, v: Math.max(old.v || 0, c.v) } : c);
    }
  }
  /** REST top-up for symbols of unfinished calls, only when the recorder is not giving us ticks. */
  async restRefresh() {
    const m = U.istMinutes();
    if (!U.isTradingDayIST() || m < 540) return;
    const info = this.recorder.info();
    const recording = info.recording || (info.watch && info.watch.recording);
    for (const rec of this.feed.today()) {
      const s = this.symbolOf.get(rec.id);
      if (!s || !s.symbol) continue;
      if (m < (U.closeMinOf(rec) > 930 ? 540 : 555) || m > U.closeMinOf(rec) + 5) continue;   // this call's market hours
      const st = this.statusOf(rec).state;
      if (!["WAITING", "OPEN", "NO_DATA"].includes(st)) continue;
      const last = this.restAt.get(s.symbol) || 0;
      if (recording && Date.now() - last < 15 * 60 * 1000) continue;   // recorder covers it; heal gaps every 15 min
      await this.backfill(s.symbol).catch((e) => this.warnOnce(e.message, `history ${s.symbol}`));
    }
  }
  candleFile(day) { return path.join(U.dataRoot(), "candles", `${day}.json`); }
  saveCandles() {
    // The day is final and its files were cleaned up after the Drive upload: do not write them again.
    if (this.dayDone(this.candleDay) && !fs.existsSync(path.join(U.dataRoot(), "recordings", this.candleDay))) return;
    try { this.ticks.save(); } catch (e) { console.warn("[PaRRVA] save ticks:", e.message); }
    if (!this.candles.size) return;
    const out = {};
    for (const [sym, m] of this.candles) out[sym] = [...m.values()].sort((a, b) => a.t - b.t);
    U.writeJson(this.candleFile(this.candleDay), out);
  }
  loadCandles(day) {
    const data = U.readJson(this.candleFile(day), null);
    if (!data) return;
    for (const [sym, list] of Object.entries(data)) {
      const m = this.candleMap(sym);
      for (const c of list || []) if (c && Number.isFinite(c.t)) m.set(c.t, c);
    }
  }

  /**
   * The call's Fyers symbol, also for earlier days: resolved this run -> symbols.json -> results file ->
   * a symbol in that day's saved data with the same strike + CE/PE (+ expiry date in the name when it can tell).
   */
  symbolFor(rec) {
    const live = (this.symbolOf.get(rec.id) || {}).symbol;
    if (live) return live;
    if (this.savedSymbols[rec.id]) return this.savedSymbols[rec.id];
    const res = rec.date ? this.resultsOf(rec.date) : null;
    if (res && res[rec.id] && res[rec.id].symbol) return res[rec.id].symbol;
    if (!rec.date || !rec.strike || !rec.cp) return null;
    if (!this._symGuess) this._symGuess = new Map();
    const key = `${rec.date}|${rec.underlying}|${rec.strike}|${rec.cp}|${rec.expiry}`;
    if (this._symGuess.has(key)) return this._symGuess.get(key);
    const names = new Set(Object.keys(this.savedCandlesOf(rec.date) || {}));
    try { for (const d of fs.readdirSync(path.join(U.dataRoot(), "recordings", rec.date, "symbols"))) names.add(d.replace(/^([A-Z]+)_/, "$1:")); } catch { /* none */ }
    const tail = `${Number(rec.strike)}${rec.cp}`;
    let hits = [...names].filter((x) => x.endsWith(tail) && x.includes(String(rec.underlying || "").toUpperCase()));
    if (hits.length > 1 && rec.expiry) {   // weekly names carry yyMdd / monthly yyMMM - prefer the one matching the expiry
      const [y, m, d] = rec.expiry.split("-");
      const wk = `${y.slice(2)}${"123456789OND"[Number(m) - 1]}${d}`, mo = `${y.slice(2)}${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(m) - 1]}`;
      const weekly = hits.filter((x) => x.includes(wk + tail)), monthly = hits.filter((x) => x.includes(mo + tail));
      if (weekly.length) hits = weekly; else if (monthly.length) hits = monthly;
    }
    const sym = hits.length === 1 ? hits[0] : null;
    this._symGuess.set(key, sym);
    return sym;
  }

  // ── status ────────────────────────────────────────────────────────────────
  snapshotOf(sym) { return (sym && this.recorder.symbols[sym]) || null; }
  /**
   * Price bars for the status engine: the recorder's 1-second bars, with 1-minute candles only for the
   * minutes before the first recorded tick (e.g. the recorder started late).
   */
  barsFor(sym, candles, ticks) {
    const sec = ticks && ticks.barsOf(sym);
    if (!sec || !sec.length) return candles || [];
    const first = sec[0].t;
    return (candles || []).filter((c) => c.t + 60 <= first).concat(sec);
  }
  statusOf(rec) {
    const s = this.symbolOf.get(rec.id);
    if (rec.date !== this.candleDay) return this.pastStatus(rec);
    if (this.callDone(rec)) {
      // This call's result is final (30 min after its market closed): use the saved one (results file / Postgres),
      // so the page and later rewrites stay right after the day's recordings, candles and second-bars were deleted.
      const res = this.resultsOf(rec.date);
      const saved = res && res[rec.id];
      if (saved && saved.status && res._meta && res._meta.rules === RULES_VERSION) return { ...saved.status, source: "recorded" };
    }
    const sym = (s && s.symbol) || this.symbolFor(rec);   // same symbol the page shows (also when this run has not resolved it yet)
    const snap = this.snapshotOf(sym);
    const fresh = snap && snap.recv && Date.now() - snap.recv < 120000;
    this.ticks.refresh();
    const bars = sym ? this.barsFor(sym, this.candlesOf(sym), this.ticks) : [];
    return evaluate(rec, bars, { ltp: fresh && Number.isFinite(snap.ltp) ? snap.ltp : null }, Date.now(), this.feed.versionsOf(rec.id));
  }
  /** Status of a call from an earlier day: our saved result if we have it, else PaRRVA's exit price. */
  pastStatus(rec) {
    // The day's results file when it was written by the current rules; otherwise re-worked from the saved
    // ticks / candles (so rule fixes apply to old days too); an older saved status is the last fallback.
    const res = this.resultsOf(rec.date);
    const saved = res && res[rec.id];
    if (saved && saved.status && res._meta && res._meta.rules === RULES_VERSION) return { ...saved.status, source: "recorded" };
    const candles = this.savedCandlesOf(rec.date);
    const sym = (saved && saved.symbol) || this.symbolFor(rec);
    const ticks = sym ? pastStore(rec.date) : null;
    const bars = sym ? this.barsFor(sym, candles && candles[sym], ticks) : [];
    if (bars.length) return { ...evaluate(rec, bars, {}, Date.now(), this.feed.versionsOf(rec.id)), source: "recorded" };
    if (saved && saved.status) return { ...saved.status, source: "recorded" };
    const st = { state: "UNKNOWN", entryPrice: null, exitPrice: null, points: null, source: "parrva" };
    if (rec.exit !== null && rec.entryLo !== null && rec.entryHi !== null) {
      // No market data: entry at the band edge (BUY = top, SELL = bottom), exit at PaRRVA's exit price.
      const fill = rec.side === "SELL" ? rec.entryLo : rec.entryHi;
      st.state = "EXITED"; st.entryPrice = fill; st.exitPrice = rec.exit; st.fill = "band";
      st.points = Math.round((rec.side === "SELL" ? fill - rec.exit : rec.exit - fill) * 100) / 100;
    }
    return st;
  }
  savedCandlesOf(day) {
    if (!this._candleCache) this._candleCache = new Map();
    const hit = this._candleCache.get(day);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
    const data = U.readJson(this.candleFile(day), null);
    this._candleCache.set(day, { at: Date.now(), data });
    if (this._candleCache.size > 40) this._candleCache.delete(this._candleCache.keys().next().value);
    return data;
  }
  resultsFile(day) { return path.join(U.dataRoot(), "results", `${day}.json`); }
  resultsOf(day) {
    if (!this._resCache) this._resCache = new Map();
    const hit = this._resCache.get(day);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    // the results file first; the database copy when the file is gone (recordings cleaned up / new server)
    const data = U.readJson(this.resultsFile(day), null) || this.db.get(day);
    this._resCache.set(day, { at: Date.now(), data });
    return data;
  }
  /**
   * Minute (IST) after which the day's results are final: 30 min after the last market close of the day's calls
   * (16:00 on a day with only NSE / BSE calls, like before; about 00:00 when an MCX call was given).
   */
  finalMinOf(day) {
    let close = 930;
    for (const rec of this.feed.list(day, day)) close = Math.max(close, U.closeMinOf(rec));
    return Math.min(close + 30, 1439);
  }
  /** One call's result is final: 30 min after its own market closed (NSE 16:00, MCX ~00:00), or an earlier day. */
  callDone(rec, now = Date.now()) {
    if (!rec || !rec.date) return false;
    if (rec.date < U.istDate(now)) return true;
    const close = U.closeMsOf(rec);
    return close !== null && now >= Math.min(close + 30 * 60000, U.istAt(rec.date, 23, 59));
  }
  /** The day's results are final (earlier day, or today after finalMinOf). */
  dayDone(day) {
    const today = U.istDate();
    if (day < today) return true;
    return day === today && U.istMinutes() >= this.finalMinOf(day);
  }
  endOfDay() {
    const day = this.candleDay;
    if (!U.isTradingDayIST() || U.istMinutes() < 931) return;
    const file = this.resultsFile(day);
    const calls = this.feed.list(day, day);
    if (!calls.length) return;
    let prev = null;
    try { prev = fs.existsSync(file) ? U.readJson(file, null) : null; } catch { prev = null; }
    const done = U.istMinutes() > this.finalMinOf(day);
    // Rewrite until the results are final (late PaRRVA exits, MCX calls still open), then leave it alone -
    // unless it was written by older rules.
    if (prev && prev._meta && prev._meta.rules === RULES_VERSION && done) {
      if (this.db.ready && !this.db.hasDay(day)) this.db.saveDay(day, prev, this.recorder.firstStartOf(day));   // database was down at the close
      return;
    }
    // Final and already cleaned up after the Drive upload (results file gone, rows in Postgres): never recompute
    // from the deleted files - that would overwrite the good rows.
    if (!prev && done && this.db.ready && this.db.hasDay(day)) return;
    this.ticks.refresh({ minGapMs: 0, all: true });                  // every tick of the day before judging
    const out = { _meta: { rules: RULES_VERSION, writtenAt: new Date().toISOString() } };
    for (const rec of calls) {
      const s = this.symbolOf.get(rec.id) || {};
      out[rec.id] = { name: rec.name, label: rec.label, symbol: s.symbol || null, rec: { ...rec, raw: undefined }, status: this.statusOf(rec), excluded: this.flagsOf(rec).excluded };
    }
    this.saveCandles();
    U.writeJson(file, out);
    this.db.saveDay(day, out, this.recorder.firstStartOf(day));   // same rows into Postgres (skipped when unchanged)
    if (this._resCache) this._resCache.delete(day);
  }

  /**
   * Was this call published before the recorder started that day? Shown as "Before recording" and NOT counted
   * in the totals. Days with no recording at all are not marked.
   */
  flagsOf(rec) {
    const start = this.recorder.firstStartOf(rec.date) || this.db.startOf(rec.date);
    const before = !!(start && rec.createdMs && rec.createdMs < start);
    const vers = this.feed.versionsOf(rec.id);
    const firstSeen = vers.length ? vers[0].version : rec.version;
    const incomplete = firstSeen > 1;
    // A call published before the recorder started is shown ("Before recording", result from Fyers 1-minute data)
    // but never counted in the totals, so its points can be checked by hand.
    return { excluded: before, beforeRecording: before, recordingStartedAt: start ? new Date(start).toISOString() : null, versionsIncomplete: incomplete };
  }

  // ── what the routes return ────────────────────────────────────────────────
  view(rec, { withRaw = false } = {}) {
    const s = { ...(this.symbolOf.get(rec.id) || {}) };
    if (!s.symbol) s.symbol = this.symbolFor(rec);
    const snap = rec.date === this.candleDay ? this.snapshotOf(s.symbol) : null;
    const { raw, ...r } = rec;
    return {
      ...r, ...this.flagsOf(rec), raw: withRaw ? raw : undefined,
      symbol: s.symbol || null, symbolError: s.error || null,
      status: this.statusOf(rec),
      market: snap ? { ltp: snap.ltp ?? null, bid: snap.bid ?? null, ask: snap.ask ?? null, vol: snap.vol ?? null, oi: snap.oi ?? null, chp: snap.chp ?? null, ageMs: snap.recv ? Date.now() - snap.recv : null, depth5: snap.depth5 || null, depth50: snap.depth50 || null } : null,
    };
  }
  live(day = U.istDate()) {
    const calls = this.feed.list(day, day).map((r) => this.view(r));
    const index = {};
    for (const und of new Set(calls.map((c) => market.underlyingSymbol(c.underlying)).filter(Boolean))) {
      const snap = this.snapshotOf(und);
      if (snap) index[und] = { ltp: snap.ltp ?? null, chp: snap.chp ?? null, ageMs: snap.recv ? Date.now() - snap.recv : null };
    }
    return {
      date: day, today: day === this.candleDay, now: new Date().toISOString(),
      calls, summary: summarize(calls.map((c) => ({ rec: c, status: c.status }))),
      index, recorder: this.recorder.info(), feed: this.feed.status(),
    };
  }
  detail(id) {
    const rec = this.feed.byId.get(Number(id)) || this.feed.byId.get(id);
    if (!rec) return null;
    const v = this.view(rec, { withRaw: true });
    let candles = [];
    let indexCandles = [];
    const und = market.underlyingSymbol(rec.underlying);
    if (rec.date === this.candleDay) {
      candles = v.symbol ? this.candlesOf(v.symbol) : [];
      indexCandles = und ? this.candlesOf(und) : [];
    } else {
      const saved = U.readJson(this.candleFile(rec.date), null) || {};
      const res = this.resultsOf(rec.date) || {};
      const sym = v.symbol || (res[rec.id] && res[rec.id].symbol) || this.symbolFor(rec);
      candles = (sym && saved[sym]) || [];
      indexCandles = (und && saved[und]) || [];
    }
    return { call: v, versions: this.feed.versionsOf(rec.id), candles, indexCandles };
  }
  summary(from, to) {
    const days = new Map();
    for (const rec of this.feed.list(from, to)) {
      if (!rec.date) continue;
      if (!days.has(rec.date)) days.set(rec.date, []);
      days.get(rec.date).push({ rec: { ...rec, ...this.flagsOf(rec) }, status: this.statusOf(rec) });
    }
    const daily = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, items]) => ({ date, ...summarize(items), source: items.some((x) => x.status.source === "parrva") ? "parrva" : "recorded" }));
    const months = new Map();
    for (const [date, items] of days) {
      const k = date.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(...items);
    }
    const monthly = [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([month, items]) => ({ month, days: new Set(items.map((x) => x.rec.date)).size, ...summarize(items) }));
    return { from: from || null, to: to || null, daily, monthly, total: summarize([...days.values()].flat()) };
  }
}

let singleton = null;
function getParrvaLive() {
  if (!singleton) singleton = new ParrvaLive();
  return singleton;
}

module.exports = { getParrvaLive, ParrvaLive };
