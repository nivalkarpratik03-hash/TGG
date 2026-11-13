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
 *                        A day's recordings folder is deleted only when:
 *                          its 3 files are on Drive with the right sizes, AND its results are in the database
 *                          (or the day had no calls), AND (for today) it is after 16:05 IST, when the results are final.
 *                        Otherwise it is kept and the Admin page says why. Today's small candles / secbars files
 *                        are kept until the next day so today's page still shows the right status after a restart.
 *
 * Works only on folders whose export finished and was checked (parquet/export.json written by ofrExport.js).
 * Writes recordings/<date>/drive.json after a checked upload. Runs every 2 min, one day at a time, never throws.
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
    try { return fs.readdirSync(path.join(U.dataRoot(), "recordings")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { return []; }
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
    if (!fs.existsSync(this.recDir(day))) return this.logOf(day);   // folder already deleted after its upload
    const d = U.readJson(path.join(this.recDir(day), "drive.json"), null);
    const m = this.exported(day);
    if (!d || !d.ok || !m) return null;
    // the upload must be of THIS export (a re-export makes it upload again)
    return m.files.every((f) => d.files && d.files.some((x) => x.file === f.file && x.size === f.size)) ? d : null;
  }
  busyDay(day) {
    const info = this.svc.recorder.info ? this.svc.recorder.info() : {};
    if (day === U.istDate() && (this.svc.recorder.running() || info.stopping || info.exporting)) return true;
    return !!this.svc.recorder.exportChild;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.mode()) {
        for (const day of this.days()) {
          if (this.busyDay(day) || this.uploaded(day) || !this.exported(day)) continue;
          const f = this.fails.get(day);
          if (f && Date.now() - f.at < RETRY_MS[Math.min(f.n - 1, RETRY_MS.length - 1)]) continue;
          await this.upload(day);
          break;   // one day per tick
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
      log[day] = rec;
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

  /** Delete uploaded days beyond the newest RECORDINGS_KEEP_DAYS, only when safe. */
  cleanup() {
    const today = U.istDate();
    // today only after 16:05 IST (results final, export done) and when nothing is running for it
    const days = this.days().filter((d) => d < today || (d === today && U.istMinutes() >= 965 && !this.busyDay(d)));
    const old = days.slice(0, Math.max(0, days.length - this.keepDays()));
    const kept = {};
    const deleted = [];
    for (const day of old) {
      if (!this.mode()) { kept[day] = "Drive is not set up"; continue; }
      if (!this.uploaded(day)) { kept[day] = this.exported(day) ? "not on Drive yet" : "no checked Parquet export"; continue; }
      const calls = this.svc.feed.list(day, day).length;
      if (calls && !(this.svc.db && this.svc.db.ready && this.svc.db.hasDay(day))) { kept[day] = "results not in the database yet"; continue; }
      try {
        fs.rmSync(this.recDir(day), { recursive: true, force: true });
        if (day !== today) for (const sub of ["candles", "secbars"]) fs.rmSync(path.join(U.dataRoot(), sub, `${day}.json`), { force: true });
        deleted.push(day);
        console.log(`[Drive] ${day}: on Drive and in the database - local recordings deleted`);
      } catch (e) { kept[day] = `delete failed: ${e.message}`; }
    }
    if (deleted.length || Object.keys(kept).length || !this.lastCleanup) this.lastCleanup = { at: new Date().toISOString(), deleted, kept };
    else this.lastCleanup.at = new Date().toISOString();
  }

  info() {
    const today = U.istDate();
    return {
      mode: this.mode(), dest: this.mode() ? this.destOf(today) : null, keepDays: this.keepDays(),
      today: { exported: !!this.exported(today), uploaded: this.uploaded(today) },
      last: this.last || (() => { const l = U.readJson(this.logFile(), {}) || {}; const k = Object.keys(l).sort().pop(); return k ? l[k] : null; })(), lastError: this.lastError, cleanup: this.lastCleanup,
    };
  }
}

module.exports = { DriveUpload };
