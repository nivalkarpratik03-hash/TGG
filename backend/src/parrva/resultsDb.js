/**
 * backend/src/parrva/resultsDb.js  (NEW 2026-11-13)
 * ─────────────────────────────────────────────────────────────────────────────
 * Final result of every PaRRVA call in Postgres (table parrva_results, see
 * database/migrations/007_parrva_results.sql). Written after the close together with
 * results/<date>.json; Daily / Monthly fall back to it for any day that has no results file,
 * so the raw recordings and parquet_data folders can be deleted after the Drive upload.
 *
 *   - uses the same Postgres as the rest of the dashboard (DATABASE_URL in backend/.env)
 *   - creates the table on start if it is missing (same SQL as the migration)
 *   - all rows are kept in memory (about 20 rows a day), so reads never wait for the database
 *   - on start, every results/<date>.json not yet in the table is copied in (one-time backfill)
 *   - never throws: a database problem is shown on the Admin page and the files keep working
 *
 * ENV  DATABASE_URL (or PGHOST ...)   the dashboard database
 *      PARRVA_RESULTS_DB=false         turns this off
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATION = path.resolve(__dirname, "../../../database/migrations/007_parrva_results.sql");

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

class ResultsDb {
  constructor(getPool = null) {
    this.getPool = getPool;
    this.pool = null;
    this.days = new Map();       // date -> results object in the results-file shape
    this.starts = new Map();     // date -> recording start ms
    this.hash = new Map();       // date -> hash of the last saved content
    this.ready = false;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastSaved = null;       // {day, rows, at}
    this.queue = Promise.resolve();
  }

  enabled() {
    if (String(process.env.PARRVA_RESULTS_DB || "").trim().toLowerCase() === "false") return false;
    return !!(process.env.DATABASE_URL || process.env.PGHOST || this.getPool);
  }

  _pool() {
    if (!this.pool) this.pool = this.getPool ? this.getPool() : require("../../../database/src/pool").pool;
    return this.pool;
  }

  _fail(what, err) {
    const msg = `${what}: ${String((err && err.message) || err).slice(0, 200)}`;
    if (msg !== this.lastError) console.warn(`[PaRRVA DB] ${msg}`);
    this.lastError = msg;
    this.lastErrorAt = Date.now();
  }

  /** Create the table if needed and load every row. Safe to call again (retries after an error). */
  async init() {
    if (!this.enabled()) return false;
    try {
      const sql = fs.readFileSync(MIGRATION, "utf8");
      await this._pool().query(sql);
      await this.load();
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (err) {
      this.ready = false;
      this._fail("could not open the parrva_results table", err);
      return false;
    }
  }

  async load() {
    const { rows } = await this._pool().query(
      `SELECT call_id, trade_date::text AS day, advice_name, label, symbol, counted, rules_version,
              recording_started_at, written_at, call, status
         FROM parrva_results ORDER BY trade_date, call_id`);
    const days = new Map();
    const starts = new Map();
    for (const r of rows) {
      let d = days.get(r.day);
      if (!d) { d = { _meta: { rules: null, writtenAt: null, from: "database" } }; days.set(r.day, d); }
      const rules = r.rules_version === null ? null : Number(r.rules_version);
      if (rules !== null && (d._meta.rules === null || rules < d._meta.rules)) d._meta.rules = rules;
      const w = r.written_at ? new Date(r.written_at).toISOString() : null;
      if (w && (!d._meta.writtenAt || w > d._meta.writtenAt)) d._meta.writtenAt = w;
      d[String(r.call_id)] = { name: r.advice_name, label: r.label, symbol: r.symbol, rec: r.call || null, status: r.status || null, counted: r.counted };
      if (r.recording_started_at && !starts.has(r.day)) starts.set(r.day, new Date(r.recording_started_at).getTime());
    }
    this.days = days;
    this.starts = starts;
  }

  /** The day in the results-file shape, or null. */
  get(day) { return this.days.get(day) || null; }
  /** Recording start of that day (ms), or null. */
  startOf(day) { return this.starts.has(day) ? this.starts.get(day) : null; }
  hasDay(day) { return this.days.has(day); }

  /**
   * Upsert one day. `results` is the results-file object ({_meta, [id]: {name, label, symbol, rec, status}}).
   * Skips the write when nothing changed since the last save. Queued, never throws.
   */
  saveDay(day, results, startMs = null) {
    if (!this.enabled() || !day || !results) return Promise.resolve(false);
    const p = this.queue.then(() => this._save(day, results, startMs)).catch((e) => { this._fail(`saving ${day}`, e); return false; });
    this.queue = p;
    return p;
  }

  async _save(day, results, startMs) {
    if (!this.ready && !(await this.init())) return false;
    const rules = results._meta ? results._meta.rules : null;
    const ids = Object.keys(results).filter((k) => k !== "_meta" && results[k]);
    if (!ids.length) return false;
    const h = crypto.createHash("sha1").update(JSON.stringify([ids.map((id) => [id, results[id].status, results[id].rec && results[id].rec.updatedAt, results[id].symbol]), rules, startMs])).digest("hex");
    if (this.hash.get(day) === h) return false;

    const start = iso(startMs);
    const client = await this._pool().connect();
    try {
      await client.query("BEGIN");
      for (const id of ids) {
        const x = results[id];
        const rec = x.rec || {};
        const st = x.status || {};
        const created = rec.createdMs || Date.parse(rec.createdAt);
        const counted = !(startMs && Number.isFinite(created) && created < startMs);
        const lv = st.levelsUsed || {};
        await client.query(
          `INSERT INTO parrva_results (call_id, trade_date, advice_name, label, symbol, side, lot, published_at,
             entry_lo, entry_hi, target, stop_loss, parrva_exit, result, entry_at, entry_price, fill_type,
             exit_at, exit_price, points, real_points, counted, source, rules_version, recording_started_at,
             call, status, written_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW())
           ON CONFLICT (call_id) DO UPDATE SET
             trade_date=EXCLUDED.trade_date, advice_name=EXCLUDED.advice_name, label=EXCLUDED.label, symbol=EXCLUDED.symbol,
             side=EXCLUDED.side, lot=EXCLUDED.lot, published_at=EXCLUDED.published_at, entry_lo=EXCLUDED.entry_lo,
             entry_hi=EXCLUDED.entry_hi, target=EXCLUDED.target, stop_loss=EXCLUDED.stop_loss, parrva_exit=EXCLUDED.parrva_exit,
             result=EXCLUDED.result, entry_at=EXCLUDED.entry_at, entry_price=EXCLUDED.entry_price, fill_type=EXCLUDED.fill_type,
             exit_at=EXCLUDED.exit_at, exit_price=EXCLUDED.exit_price, points=EXCLUDED.points, real_points=EXCLUDED.real_points,
             counted=EXCLUDED.counted, source=EXCLUDED.source, rules_version=EXCLUDED.rules_version,
             recording_started_at=EXCLUDED.recording_started_at, call=EXCLUDED.call, status=EXCLUDED.status, written_at=NOW()`,
          [
            Number(id), day, x.name || rec.name || null, x.label || rec.label || null, x.symbol || null,
            rec.side || null, num(rec.lot), iso(rec.createdAt),
            num(rec.entryLo), num(rec.entryHi), num(rec.target), num(lv.sl !== undefined ? lv.sl : rec.sl), num(rec.exit),
            String(st.state || "UNKNOWN"), iso(st.entryAt), num(st.entryPrice), st.fill ? String(st.fill) : null,
            iso(st.exitAt), num(st.exitPrice), num(st.points), num(st.realPoints),
            counted, st.source || (st.state && st.state !== "UNKNOWN" ? "recorded" : "parrva"), num(rules), start,
            JSON.stringify({ ...rec, raw: undefined }), JSON.stringify(st),
          ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // keep the in-memory copy in step
    const d = { _meta: { rules, writtenAt: new Date().toISOString(), from: "database" } };
    for (const id of ids) d[id] = { name: results[id].name, label: results[id].label, symbol: results[id].symbol, rec: results[id].rec ? { ...results[id].rec, raw: undefined } : null, status: results[id].status };
    this.days.set(day, { ...(this.days.get(day) || {}), ...d });
    if (start) this.starts.set(day, startMs);
    this.hash.set(day, h);
    this.lastSaved = { day, rows: ids.length, at: new Date().toISOString() };
    this.lastError = null;
    return true;
  }

  /** Copy every results/<date>.json that is not in the table yet (or newer than the table). */
  async backfillFrom(dir, startOf) {
    if (!this.ready) return 0;
    let n = 0;
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return 0; }
    for (const f of files) {
      const day = f.slice(0, 10);
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const have = this.days.get(day);
      const fileAt = data && data._meta && data._meta.writtenAt;
      if (have && (!fileAt || (have._meta.writtenAt && have._meta.writtenAt >= fileAt))) continue;
      if (await this.saveDay(day, data, startOf(day))) n++;
    }
    if (n) console.log(`[PaRRVA DB] copied ${n} earlier day(s) into parrva_results`);
    return n;
  }

  info() {
    return {
      enabled: this.enabled(), ready: this.ready, days: this.days.size,
      rows: [...this.days.values()].reduce((s, d) => s + Object.keys(d).length - 1, 0),
      lastSaved: this.lastSaved, lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }
}

module.exports = { ResultsDb };
