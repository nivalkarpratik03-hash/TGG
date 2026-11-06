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
    if (want && !this.child && Date.now() - this.lastSpawnAt > 30000) this.spawn();
    else if (!want && this.child && !this.stopping) {
      const manualOff = this.override && this.override.day === U.istDate() && this.override.mode === "off";
      this.stop(manualOff ? "stopped from Admin" : !this.accountReady() ? "account 2 token not valid" : "outside recording hours");
    }
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
      log: this.lastLog.slice(-12),
    };
  }
}

module.exports = { RecorderManager };
