/**
 * backend/src/parrva/recorderManager.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * Starts / stops / watches the recorder child process (recorderWorker.js) and keeps the
 * latest live data it reports, for the PaRRVA page and the Admin card.
 *
 * AUTO mode (RECORDER_AUTO=true, the default): on NSE trading days it starts at
 * RECORDER_START (default 09:14 IST) and stops at RECORDER_STOP (default 15:35 IST, like the collector), only when
 * account 2 is configured and has a token. "Start" / "Stop" on the Admin card override it for
 * the rest of the day. If the child dies during market hours it is restarted (max 1 every 30 s).
 * A heartbeat comes every 5 s; no heartbeat for 60 s -> the child is killed and restarted.
 * A stop at / after 15:25 IST is the end of the day: the worker backfills candles and writes the 3 Parquet
 * files (can take a few minutes; heartbeats continue). exportDay() re-runs the export for any day folder.
 *
 * EVENING WATCHER (2026-11-16): calls whose market closes after the recorder stops (MCX, up to 23:30 / 23:55) are
 * watched by a second, light run of the same worker (REC_MODE=watch): one data socket on account 2 with only
 * those symbols, ticks into recordings/<date>/parrva-other/, no NIFTY, no 50-level depth, no export. It only runs
 * while the recorder itself is not connected (never two data sockets at once) and stops at that market's close or
 * as soon as no such call is open.
 */
"use strict";

const path = require("path");
const { fork } = require("child_process");
const EventEmitter = require("events");
const accounts = require("../fyers/accounts");
const U = require("./util");

const WORKER = path.join(__dirname, "recorderWorker.js");
const EXPORTER = path.join(__dirname, "ofrExport.js");

class RecorderManager extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.status = null;          // last status the worker reported
    this.symbols = {};           // sym -> latest snapshot
    this.lastHb = 0;
    this.startedAt = null;
    this.lastExit = null;        // {at, code, signal, why}
    this.lastLog = [];           // last 30 worker log lines
    this.override = null;        // {day, mode:"on"|"off"} - manual Start/Stop for today
    this.wanted = { symbols: [], tbt: [] };
    this.watch = { symbols: [], until: null };   // evening watcher: symbols + market close (minutes IST)
    this.watchChild = null;
    this.watchHb = 0;
    this.watchStartedAt = null;
    this.watchStatus = null;
    this.lastWatchSpawnAt = 0;
    this.watchStopping = false;
    this.lastSpawnAt = 0;
    this.stopReason = null;
    this.stopping = false;
    this.lastExport = null;      // {at, ok, files|error}
    this.exportChild = null;
    this.timer = null;
    this.startsFile = path.join(U.dataRoot(), "recording-starts.json");
    this.starts = U.readJson(this.startsFile, {});   // "YYYY-MM-DD" -> ms of the first live data that day
  }

  /** When the recorder first had live data on that IST date (ms), or null. */
  firstStartOf(day) {
    if (!day) return null;
    if (this.starts[day]) return this.starts[day];
    // Not in the file (e.g. recorded before this file existed): read the first saved index quote of that day, once.
    if (!this.startCache) this.startCache = new Map();
    if (this.startCache.has(day)) return this.startCache.get(day);
    let ms = null;
    const dir = path.join(U.dataRoot(), "recordings", day);
    for (const f of [path.join(dir, "symbols", "NSE_NIFTY50-INDEX", "quotes.jsonl"), path.join(dir, "quotes.jsonl")]) {
      try {
        const fs = require("fs");
        const fd = fs.openSync(f, "r");
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const first = buf.slice(0, n).toString("utf8").split("\n")[0];
        const v = JSON.parse(first).recv_ms;
        if (Number.isFinite(v)) { ms = v; break; }
      } catch { /* no recording in this layout */ }
    }
    this.startCache.set(day, ms);
    return ms;
  }

  auto() { return process.env.RECORDER_AUTO !== "false"; }
  window() {
    const a = U.hhmm(process.env.RECORDER_START || "09:14"), b = U.hhmm(process.env.RECORDER_STOP || "15:35");
    return { start: Number.isFinite(a) ? a : 554, stop: Number.isFinite(b) ? b : 935 };
  }
  inWindow(ms = Date.now()) {
    const w = this.window(), m = U.istMinutes(ms);
    return U.isTradingDayIST(ms) && m >= w.start && m < w.stop;
  }
  accountReady() {
    const a = accounts.account2;
    return a.configured() && !!a.loadToken() && !(a.getTokenInfo().expired);
  }
  running() { return !!this.child; }

  /** Should the recorder be running right now? */
  shouldRun() {
    const today = U.istDate();
    if (this.override && this.override.day === today) return this.override.mode === "on" && this.accountReady();
    return this.auto() && this.inWindow() && this.accountReady();
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.warn("[Recorder] loop error:", e.message); } }, 10000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => { try { this.tick(); } catch { /* ignore */ } }, 3000);
  }

  tick() {
    // While stopping (end-of-day export can keep the worker busy for minutes) the stop timer below is the limit.
    if (this.child && !this.stopping && Date.now() - this.lastHb > 60000) {
      this.log("no heartbeat for 60 s - restarting the recorder");
      this.kill("no heartbeat");
      return;
    }
    const want = this.shouldRun();
    if (want && !this.child && !this.watchChild && Date.now() - this.lastSpawnAt > 30000) this.spawn();
    else if (!want && this.child && !this.stopping) {
      const manualOff = this.override && this.override.day === U.istDate() && this.override.mode === "off";
      this.stop(manualOff ? "stopped from Admin" : !this.accountReady() ? "account 2 token not valid" : "outside recording hours");
    }
    this.watchTick(want);
  }

  // ── evening watcher ─────────────────────────────────────────────────────────
  /** Symbols to watch after the recorder stops, and the minute (IST) their market closes. */
  setWatch(symbols, untilMin) {
    this.watch = { symbols: [...new Set(symbols || [])], until: Number.isFinite(untilMin) ? untilMin : null };
    if (this.watchChild && this.watchChild.connected && this.watch.symbols.length) {
      try { this.watchChild.send({ cmd: "subscribe", symbols: this.watch.symbols, meta: {}, watch: true }); } catch { /* gone */ }
    }
  }
  shouldWatch(recorderWanted) {
    const w = this.watch;
    if (!w.symbols.length || !w.until || !this.accountReady()) return false;
    if (this.override && this.override.day === U.istDate() && this.override.mode === "off") return false;
    const m = U.istMinutes();
    // only when the recorder is not holding a data socket (not wanted, or already closing its sockets for the export)
    const recorderBusy = this.child && !this.stopping;
    return !recorderWanted && !recorderBusy && m < w.until;
  }
  watchTick(recorderWanted) {
    if (this.watchChild && !this.watchStopping && Date.now() - this.watchHb > 60000) {
      this.log("watcher: no heartbeat for 60 s - restarting");
      try { this.watchChild.kill("SIGKILL"); } catch { /* ignore */ }
      this.watchChild = null;
      return;
    }
    const want = this.shouldWatch(recorderWanted);
    if (want && !this.watchChild && Date.now() - this.lastWatchSpawnAt > 30000) this.spawnWatch();
    else if (!want && this.watchChild && !this.watchStopping) this.stopWatch(recorderWanted ? "recorder starting" : "no open evening calls / market closed");
  }
  spawnWatch() {
    this.lastWatchSpawnAt = Date.now();
    const a = accounts.account2;
    if (!a.loadToken()) return;
    const outDir = path.join(U.dataRoot(), "recordings", U.istDate());
    const env = { ...process.env, REC_MODE: "watch", REC_APP_ID: (process.env.APP_ID_2 || "").trim().replace(/^["']|["']$/g, ""), REC_TOKEN_FILE: a.tokenFile, REC_OUT_DIR: outDir };
    let child;
    try { child = fork(WORKER, [], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] }); } catch (e) { this.log(`watcher: could not start: ${e.message}`); return; }
    this.watchChild = child;
    this.watchHb = Date.now();
    this.watchStartedAt = Date.now();
    this.watchStopping = false;
    this.log(`watcher started (pid ${child.pid}) for ${this.watch.symbols.join(", ")} until ${String(Math.floor(this.watch.until / 60)).padStart(2, "0")}:${String(this.watch.until % 60).padStart(2, "0")}`);
    child.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.hb) this.watchHb = Date.now();
      if (m.log) this.log(`[watcher] ${m.log}`);
      if (m.ready) { this.watchHb = Date.now(); this.setWatch(this.watch.symbols, this.watch.until); }
      if (m.snap) {
        this.watchHb = Date.now();
        this.watchStatus = m.snap.status || this.watchStatus;
        // the recorder is not running now: the watcher's live prices are the page's
        if (m.snap.symbols && (!this.child || this.stopping)) this.symbols = { ...this.symbols, ...m.snap.symbols };
        if (m.snap.candles) this.emit("candles", m.snap.candles);
      }
    });
    child.on("error", (e) => this.log(`watcher process error: ${e.message}`));
    child.on("exit", (code) => {
      if (this.watchChild === child) { this.watchChild = null; this.watchStopping = false; }
      if (this.watchStatus) this.watchStatus.dataConnected = false;
      this.log(`watcher stopped (code ${code})`);
    });
  }
  stopWatch(why) {
    if (!this.watchChild || this.watchStopping) return;
    this.watchStopping = true;
    const child = this.watchChild;
    try { if (child.connected) child.send({ cmd: "stop", why, export: false }); } catch { /* ignore */ }
    const t = setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* ignore */ } }, 15000);
    if (t.unref) t.unref();
  }

  /** Manual Start / Stop from the Admin card (valid for the rest of today). */
  setManual(mode) {
    if (mode === "auto") this.override = null;
    else this.override = { day: U.istDate(), mode: mode === "on" ? "on" : "off" };
    if (mode === "on" && !this.accountReady()) return { ok: false, error: "Account 2 is not logged in (or APP_ID_2 / ST_KEY_2 missing)." };
    this.lastSpawnAt = 0;
    this.tick();
    return { ok: true };
  }

  spawn() {
    this.lastSpawnAt = Date.now();
    const a = accounts.account2;
    const outDir = path.join(U.dataRoot(), "recordings", U.istDate());
    const env = {
      ...process.env,
      REC_APP_ID: (process.env.APP_ID_2 || "").trim().replace(/^["']|["']$/g, ""),
      REC_TOKEN_FILE: a.tokenFile,
      REC_OUT_DIR: outDir,
    };
    if (!a.loadToken()) { this.log("not starting: account 2 has no token"); return; }
    let child;
    try {
      child = fork(WORKER, [], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    } catch (e) {
      this.log(`could not start recorder: ${e.message}`);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.lastHb = Date.now();
    this.stopReason = null;
    this.stopping = false;
    this.log(`recorder started (pid ${child.pid}) -> ${outDir}`);
    child.on("message", (m) => { try { this.onMessage(m); } catch (e) { this.log(`bad message: ${e.message}`); } });
    child.on("error", (e) => this.log(`recorder process error: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) { this.child = null; this.stopping = false; }
      this.lastExit = { at: new Date().toISOString(), code, signal, why: this.stopReason || "exited" };
      if (this.status) { this.status.dataConnected = false; this.status.tbtConnected = false; }
      this.log(`recorder stopped (code ${code}${signal ? `, ${signal}` : ""}) - ${this.lastExit.why}`);
      this.emit("exit", this.lastExit);
    });
    this.pushSubscriptions();
  }

  onMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.hb) this.lastHb = Date.now();
    if (m.ready) { this.lastHb = Date.now(); this.pushSubscriptions(); }
    if (m.log) this.log(`[worker] ${m.log}`);
    if (m.exported) { this.lastExport = { at: new Date().toISOString(), ...m.exported }; this.log(`Parquet export ${m.exported.ok ? "OK" : "FAILED"}`); }
    if (m.snap) {
      this.lastHb = Date.now();
      this.status = m.snap.status || this.status;
      if (this.status && this.status.lastTickAt) {
        const day = U.istDate(this.status.lastTickAt);
        if (!this.starts[day]) { this.starts[day] = this.status.lastTickAt; U.writeJson(this.startsFile, this.starts); }
      }
      if (m.snap.symbols) this.symbols = m.snap.symbols;
      if (m.snap.candles) this.emit("candles", m.snap.candles);
    }
  }

  /** Symbols to record. `tbt` = up to 5 of them for 50-level depth. */
  setSymbols(symbols, tbt, meta = {}) {
    this.wanted = { symbols: [...new Set(symbols)], tbt: [...new Set(tbt)].slice(0, 5), meta };
    this.pushSubscriptions();
  }
  pushSubscriptions() {
    if (this.child && this.child.connected) {
      try { this.child.send({ cmd: "subscribe", symbols: this.wanted.symbols, tbt: this.wanted.tbt, meta: this.wanted.meta || {} }); } catch { /* child gone */ }
    }
  }

  /** exportNow: true / false, or null = the worker decides (end of day at / after 15:25 IST). */
  stop(why = "stop requested", exportNow = null) {
    if (why === "backend shutting down") this.stopWatch(why);
    if (!this.child || this.stopping) return;
    this.stopping = true;
    this.stopReason = why;
    const child = this.child;
    const willExport = exportNow === null ? U.istMinutes() >= 925 : exportNow;
    try { if (child.connected) child.send({ cmd: "stop", why, export: exportNow === null ? undefined : !!exportNow }); } catch { /* ignore */ }
    // End of day: candle backfill (<= 2 min) + Parquet export (~15 min for a full day, measured on 05 Nov data).
    // Otherwise it closes in seconds.
    const t = setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) { this.log("recorder did not stop in time - killed"); child.kill("SIGKILL"); } } catch { /* ignore */ } }, willExport ? 45 * 60000 : 15000);
    if (t.unref) t.unref();
  }

  /** Write the 3 Parquet files for a day folder again (separate process). Running recorder for today -> stop + export. */
  exportDay(day = U.istDate()) {
    if (day === U.istDate() && this.child) {
      this.override = { day, mode: "off" };
      this.stop("export requested from Admin", true);
      return { ok: true, started: "stopping the recorder and exporting" };
    }
    if (this.exportChild) return { ok: false, error: "an export is already running" };
    const dir = path.join(U.dataRoot(), "recordings", day);
    if (!require("fs").existsSync(dir)) return { ok: false, error: `no recording for ${day}` };
    const c = fork(EXPORTER, [dir], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.exportChild = c;
    this.log(`Parquet export started for ${day}`);
    c.on("exit", (code) => {
      this.exportChild = null;
      this.lastExport = { at: new Date().toISOString(), ok: code === 0, day, dir: path.join(dir, "parquet") };
      this.log(`Parquet export for ${day} ${code === 0 ? "OK" : "FAILED"}`);
    });
    return { ok: true, started: day };
  }
  kill(why) {
    if (!this.child) return;
    this.stopReason = why;
    try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
    this.child = null;
  }

  log(line) {
    const l = `${U.istClock()} ${line}`;
    console.log(`[Recorder] ${line}`);
    this.lastLog.push(l);
    if (this.lastLog.length > 30) this.lastLog.shift();
  }

  /** Everything the Admin card / PaRRVA page shows about the recorder. */
  info() {
    const st = this.status || {};
    const w = this.window();
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const today = U.istDate();
    return {
      running: this.running(),
      recording: this.running() && !!st.dataConnected,
      dataConnected: !!(this.running() && st.dataConnected),
      tbtConnected: !!(this.running() && st.tbtConnected),
      tbtEnabled: st.tbtEnabled !== false && process.env.RECORDER_TBT !== "false",
      counts: st.counts || { quotes: 0, depth5: 0, depth50: 0, errors: 0 },
      lastTickAt: st.lastTickAt ? new Date(st.lastTickAt).toISOString() : null,
      startedAt: this.startedAt && this.running() ? new Date(this.startedAt).toISOString() : null,
      symbols: this.wanted.symbols, tbtSymbols: this.wanted.tbt,
      outDir: st.outDir || path.join(U.dataRoot(), "recordings", today),
      mode: this.override && this.override.day === today ? `manual-${this.override.mode}` : this.auto() ? "auto" : "off",
      schedule: `${fmt(w.start)}-${fmt(w.stop)} IST on trading days`,
      tradingDay: U.isTradingDayIST(),
      accountReady: this.accountReady(),
      lastExit: this.lastExit,
      stopping: this.stopping, exporting: !!(st.exporting || this.exportChild), lastExport: this.lastExport || st.lastExport || null,
      setup: st.setup || null, fut: st.fut || null, expiry: st.expiry || null, atm: st.atm || null, tracked: st.tracked || 0,
      watch: {
        running: !!this.watchChild, recording: !!(this.watchChild && this.watchStatus && this.watchStatus.dataConnected),
        symbols: this.watch.symbols, until: this.watch.until,
        startedAt: this.watchChild && this.watchStartedAt ? new Date(this.watchStartedAt).toISOString() : null,
        lastTickAt: this.watchStatus && this.watchStatus.lastTickAt ? new Date(this.watchStatus.lastTickAt).toISOString() : null,
      },
      log: this.lastLog.slice(-12),
    };
  }
}

module.exports = { RecorderManager };
