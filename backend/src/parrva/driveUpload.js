/**
 * backend/src/parrva/driveUpload.js  (NEW 2026-11-13)
 * ─────────────────────────────────────────────────────────────────────────────
 * After the day's Parquet export, copies the 3 files to Google Drive (same folder as the Telegram bot:
 * TGG_Dataset/INDEX/NIFTY/orderflow/<date>), checks every file's size on Drive, and only then lets the
 * day's raw recordings be deleted.
 *
 *   Two ways to reach Drive (set ONE of them; none = no upload, nothing is ever deleted):
 *     PARQUET_DRIVE_DIR=G:\My Drive      a folder (Windows PC with Google Drive for Desktop - like the bot)
 *     PARQUET_DRIVE_REMOTE=gdrive:       an rclone remote (AWS / Linux; one-time `rclone config`)
 *   PARQUET_DRIVE_PATH   folder inside Drive, default TGG_Dataset/INDEX/NIFTY/orderflow
 *   RCLONE_BIN           rclone program, default "rclone"
 *   RECORDINGS_KEEP_DAYS recorded days kept on this machine after upload, default 0 = delete as soon as safe.
 *
 * Per day, into the same Drive folder TGG_Dataset/INDEX/NIFTY/orderflow/<date>/:
 *   1. the 3 NIFTY Parquet files, as soon as the export finished and was checked (parquet/export.json, ofrExport.js)
 *   2. results.json = the day's final PaRRVA results (same content as results/<date>.json and Postgres), once the
 *      day is final (16:00 IST, or about 30 min after the MCX close on a day with an MCX call)
 * Every file's size is checked on Drive after the copy.
 *
 * 2026-11-16: everything of a day is deleted TOGETHER, right after both uploads, when all of these hold:
 *   the Parquet files are on Drive (days with a recording), results.json is on Drive and the results are in
 *   Postgres (days with calls), and the day is final (+5 min) with nothing running for it.
 * Deleted: recordings/<date>/ (incl. parrva-other), candles/<date>.json, secbars/<date>.json, results/<date>.json.
 * The page then reads that day from Postgres. Otherwise nothing is deleted and the Admin page says why.
 * Writes recordings/<date>/drive.json + drive-uploads.json (log, last 90 days). Runs every 2 min, never throws.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const U = require("./util");

const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
const RETRY_MS = [2, 10, 30, 60].map((m) => m * 60000);

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || err.message;
        return reject(new Error(err.code === "ENOENT" ? `${bin} is not installed on this machine` : msg.slice(0, 300)));
      }
      return resolve(String(stdout || ""));
    });
  });
}

class DriveUpload {
  /** svc: the ParrvaLive service (recorder, db, feed) */
  constructor(svc) {
    this.svc = svc;
    this.busy = false;
    this.fails = new Map();      // day -> {n, at, error}
    this.last = null;            // {day, at, dest, files}
    this.lastError = null;       // {day, at, error}
    this.lastCleanup = null;     // {at, deleted: [days], kept: {day: reason}}
    this.timer = null;
  }

  mode() {
    if (clean(process.env.PARQUET_DRIVE_REMOTE)) return "rclone";
    if (clean(process.env.PARQUET_DRIVE_DIR)) return "folder";
    return null;
  }
  subPath(day) {
    const base = clean(process.env.PARQUET_DRIVE_PATH) || "TGG_Dataset/INDEX/NIFTY/orderflow";
    return `${base.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/${day}`;
  }
  remoteOf(day) {
    const r = clean(process.env.PARQUET_DRIVE_REMOTE);
    return `${r}${r.endsWith(":") || r.endsWith("/") ? "" : "/"}${this.subPath(day)}`;
  }
  destOf(day) {
    return this.mode() === "rclone" ? this.remoteOf(day) : path.join(clean(process.env.PARQUET_DRIVE_DIR), ...this.subPath(day).split("/"));
  }
  keepDays() { const n = parseInt(process.env.RECORDINGS_KEEP_DAYS || "0", 10); return Number.isFinite(n) && n >= 0 ? n : 0; }
  recDir(day) { return path.join(U.dataRoot(), "recordings", day); }

  start() {
    if (this.timer) return;
    const tick = () => { this.tick().catch((e) => console.warn("[Drive]", e.message)); };
    this.timer = setInterval(tick, 120000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(tick, 30000).unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Days with a recordings folder, oldest first. */
  days() {
    const set = new Set();
    try { fs.readdirSync(path.join(U.dataRoot(), "recordings")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).forEach((d) => set.add(d)); } catch { /* none */ }
    try { fs.readdirSync(path.join(U.dataRoot(), "results")).map((f) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)).filter(Boolean).forEach((m) => set.add(m[1])); } catch { /* none */ }
    return [...set].sort();
  }
  resultsFile(day) { return path.join(U.dataRoot(), "results", `${day}.json`); }
  /**
   * This machine recorded that day. Only then is its results.json uploaded: a PC that did not record (RECORDER_AUTO=false)
   * would otherwise overwrite the server's good results on Drive with its own empty ones.
   */
  recordedHere(day) { try { return !!this.svc.recorder.firstStartOf(day); } catch { return false; } }
  /** Fingerprint of the day's results, so a later change (e.g. an MCX call given after 16:00) uploads again. */
  resultsHash(data) {
    const ids = Object.keys(data || {}).filter((k) => k !== "_meta").sort();
    return require("crypto").createHash("sha1").update(JSON.stringify(ids.map((id) => [id, data[id] && data[id].status && data[id].status.state, data[id] && data[id].status && data[id].status.points]))).digest("hex").slice(0, 16);
  }
  /** results.json of that day on Drive (checked) and still the same as the day's current results. */
  resultsUploaded(day) {
    const l = this.logOf(day);
    const r = l && l.results;
    if (!r) return null;
    const data = this.resultsData(day);
    return !data || !r.hash || r.hash === this.resultsHash(data) ? r : null;
  }
  /** Results final for that day (svc.dayDone), and nothing is running for it. */
  dayFinal(day) {
    if (this.busyDay(day)) return false;
    if (typeof this.svc.dayDone !== "function") return day < U.istDate();
    if (day < U.istDate()) return true;
    return this.svc.dayDone(day) && U.istMinutes() >= Math.min(this.svc.finalMinOf(day) + 5, 1439);
  }
  exported(day) {
    const m = U.readJson(path.join(this.recDir(day), "parquet", "export.json"), null);
    if (!m || !m.ok || !Array.isArray(m.files) || !m.files.length) return null;
    for (const f of m.files) {
      let st; try { st = fs.statSync(path.join(this.recDir(day), "parquet", f.file)); } catch { return null; }
      if (st.size !== f.size) return null;
    }
    return m;
  }
  logFile() { return path.join(U.dataRoot(), "drive-uploads.json"); }
  /** Checked uploads by day (kept after the day folder is deleted). */
  logOf(day) { const l = U.readJson(this.logFile(), {}); return (l && l[day]) || null; }
  uploaded(day) {
    // folder already deleted after its upload (or recreated with only parrva-other ticks): the log says it
    if (!fs.existsSync(path.join(this.recDir(day), "parquet"))) { const l = this.logOf(day); return l && l.files ? l : null; }
    const d = U.readJson(path.join(this.recDir(day), "drive.json"), null);
    const m = this.exported(day);
    if (!d || !d.ok || !m) return null;
    // the upload must be of THIS export (a re-export makes it upload again)
    return m.files.every((f) => d.files && d.files.some((x) => x.file === f.file && x.size === f.size)) ? d : null;
  }
  busyDay(day) {
    const info = this.svc.recorder.info ? this.svc.recorder.info() : {};
    if (day === U.istDate() && (this.svc.recorder.running() || info.stopping || info.exporting || (info.watch && info.watch.running))) return true;
    return !!this.svc.recorder.exportChild;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.mode()) {
        for (const day of this.days()) {
          const parquetDue = !this.busyDay(day) && !this.uploaded(day) && !!this.exported(day);
          const resultsDue = !parquetDue && this.recordedHere(day) && !this.resultsUploaded(day) && this.dayFinal(day) && !!this.resultsData(day);
          if (!parquetDue && !resultsDue) continue;
          const f = this.fails.get(day);
          if (f && Date.now() - f.at < RETRY_MS[Math.min(f.n - 1, RETRY_MS.length - 1)]) continue;
          if (parquetDue) await this.upload(day); else await this.uploadResults(day);
          break;   // one upload per tick
        }
      }
      this.cleanup();
    } finally { this.busy = false; }
  }

  /** Copy + check one day. Returns {ok, error}. */
  async upload(day) {
    const m = this.exported(day);
    if (!m) return { ok: false, error: "export not finished" };
    const src = path.join(this.recDir(day), "parquet");
    const dest = this.destOf(day);
    try {
      if (this.mode() === "rclone") {
        const bin = clean(process.env.RCLONE_BIN) || "rclone";
        await run(bin, ["copy", src, dest, "--include", "*.parquet", "--retries", "3", "--low-level-retries", "10"], 30 * 60000);
        const list = JSON.parse(await run(bin, ["lsjson", dest, "--files-only"], 5 * 60000));
        for (const f of m.files) {
          const on = list.find((x) => x.Name === f.file);
          if (!on) throw new Error(`${f.file} is not on Drive after the copy`);
          if (Number(on.Size) !== f.size) throw new Error(`${f.file} on Drive is ${on.Size} bytes, expected ${f.size}`);
        }
      } else {
        fs.mkdirSync(dest, { recursive: true });
        for (const f of m.files) {
          fs.copyFileSync(path.join(src, f.file), path.join(dest, f.file));
          const size = fs.statSync(path.join(dest, f.file)).size;
          if (size !== f.size) throw new Error(`${f.file} copy is ${size} bytes, expected ${f.size}`);
        }
      }
      const rec = { ok: true, day, at: new Date().toISOString(), dest, files: m.files.map((f) => ({ file: f.file, size: f.size, rows: f.rows })) };
      U.writeJson(path.join(this.recDir(day), "drive.json"), rec);
      const log = U.readJson(this.logFile(), {}) || {};
      log[day] = { ...rec, results: (log[day] && log[day].results) || undefined };
      for (const k of Object.keys(log).sort().slice(0, -90)) delete log[k];
      U.writeJson(this.logFile(), log);
      this.fails.delete(day);
      this.last = rec;
      if (this.lastError && this.lastError.day === day) this.lastError = null;
      console.log(`[Drive] ${day}: ${m.files.length} Parquet file(s) uploaded to ${dest} and checked`);
      return { ok: true };
    } catch (err) {
      const f = this.fails.get(day) || { n: 0 };
      f.n++; f.at = Date.now(); f.error = err.message;
      this.fails.set(day, f);
      this.lastError = { day, at: new Date().toISOString(), error: err.message, tries: f.n };
      console.warn(`[Drive] ${day}: upload failed (try ${f.n}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** The day's final results (results file, else the Postgres copy), or null when the day had no calls. */
  resultsData(day) {
    const file = U.readJson(this.resultsFile(day), null);
    if (file && Object.keys(file).some((k) => k !== "_meta")) return file;
    const db = this.svc.db && this.svc.db.ready ? this.svc.db.get(day) : null;
    return db && Object.keys(db).some((k) => k !== "_meta") ? db : null;
  }

  /** Copy results.json of the day next to the Parquet files and check its size. */
  async uploadResults(day) {
    const data = this.resultsData(day);
    if (!data) return { ok: false, error: "no results" };
    const tmpDir = path.join(U.dataRoot(), "drive-tmp", day);
    const src = path.join(tmpDir, "results.json");
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(src, JSON.stringify(data, null, 1));
      const size = fs.statSync(src).size;
      const dest = this.destOf(day);
      if (this.mode() === "rclone") {
        const bin = clean(process.env.RCLONE_BIN) || "rclone";
        await run(bin, ["copyto", src, `${dest}/results.json`, "--retries", "3", "--low-level-retries", "10"], 10 * 60000);
        const list = JSON.parse(await run(bin, ["lsjson", dest, "--files-only"], 5 * 60000));
        const on = list.find((x) => x.Name === "results.json");
        if (!on) throw new Error("results.json is not on Drive after the copy");
        if (Number(on.Size) !== size) throw new Error(`results.json on Drive is ${on.Size} bytes, expected ${size}`);
      } else {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(src, path.join(dest, "results.json"));
        const got = fs.statSync(path.join(dest, "results.json")).size;
        if (got !== size) throw new Error(`results.json copy is ${got} bytes, expected ${size}`);
      }
      const calls = Object.keys(data).filter((k) => k !== "_meta").length;
      const r = { at: new Date().toISOString(), size, calls, hash: this.resultsHash(data) };
      const log = U.readJson(this.logFile(), {}) || {};
      log[day] = { ...(log[day] || { day }), results: r };
      for (const k of Object.keys(log).sort().slice(0, -90)) delete log[k];
      U.writeJson(this.logFile(), log);
      this.fails.delete(day);
      if (this.lastError && this.lastError.day === day) this.lastError = null;
      this.lastResults = { day, ...r, dest };
      console.log(`[Drive] ${day}: results.json (${calls} call(s)) uploaded to ${dest} and checked`);
      return { ok: true };
    } catch (err) {
      const f = this.fails.get(day) || { n: 0 };
      f.n++; f.at = Date.now(); f.error = err.message;
      this.fails.set(day, f);
      this.lastError = { day, at: new Date().toISOString(), error: `results.json: ${err.message}`, tries: f.n };
      console.warn(`[Drive] ${day}: results.json upload failed (try ${f.n}): ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** Delete uploaded days beyond the newest RECORDINGS_KEEP_DAYS, only when safe. */
  cleanup() {
    const today = U.istDate();
    // today only once its results are final (+5 min) and nothing runs for it; earlier days always
    const days = this.days().filter((d) => d < today || (d === today && this.dayFinal(d)));
    const old = days.slice(0, Math.max(0, days.length - this.keepDays()));
    const kept = {};
    const deleted = [];
    for (const day of old) {
      if (!this.mode()) { kept[day] = "Drive is not set up"; continue; }
      // a NIFTY recording (symbols/) needs its Parquet on Drive; a folder with only parrva-other (MCX evening ticks after
      // the first cleanup) does not
      const hasRec = fs.existsSync(path.join(this.recDir(day), "symbols")) || (fs.existsSync(this.recDir(day)) && !(this.logOf(day) && this.logOf(day).files));
      if (hasRec && !this.uploaded(day)) { kept[day] = this.exported(day) ? "not on Drive yet" : "no checked Parquet export"; continue; }
      const calls = this.svc.feed.list(day, day).length;
      if (calls && !(this.svc.db && this.svc.db.ready && this.svc.db.hasDay(day))) { kept[day] = "results not in the database yet"; continue; }
      if (calls && this.recordedHere(day) && !this.resultsUploaded(day)) { kept[day] = "results.json not on Drive yet"; continue; }
      try {
        fs.rmSync(this.recDir(day), { recursive: true, force: true });
        for (const sub of ["candles", "secbars", "results"]) fs.rmSync(path.join(U.dataRoot(), sub, `${day}.json`), { force: true });
        deleted.push(day);
        console.log(`[Drive] ${day}: on Drive and in the database - recordings, candles, second-bars and results file deleted`);
      } catch (e) { kept[day] = `delete failed: ${e.message}`; }
    }
    if (deleted.length || Object.keys(kept).length || !this.lastCleanup) this.lastCleanup = { at: new Date().toISOString(), deleted, kept };
    else this.lastCleanup.at = new Date().toISOString();
  }

  info() {
    const today = U.istDate();
    return {
      mode: this.mode(), dest: this.mode() ? this.destOf(today) : null, keepDays: this.keepDays(),
      today: { exported: !!this.exported(today), uploaded: this.uploaded(today), results: this.resultsUploaded(today), final: this.dayFinal(today) },
      lastResults: this.lastResults || null,
      last: this.last || (() => { const l = U.readJson(this.logFile(), {}) || {}; const k = Object.keys(l).sort().pop(); return k ? l[k] : null; })(), lastError: this.lastError, cleanup: this.lastCleanup,
    };
  }
}

module.exports = { DriveUpload };
