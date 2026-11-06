/**
 * backend/src/parrva/parrvaFeed.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE backend poller for the PaRRVA recommendations API. Browsers never cause an
 * upstream call: every page reads the copy kept here.
 *
 * How often it calls PaRRVA (no rate-limit risk):
 *   - trading day 09:00-15:40 IST  -> every PARRVA_POLL_SEC   (default 60 s)  ~400 calls/day
 *   - any other time               -> every PARRVA_IDLE_POLL_SEC (default 1800 s = 30 min)
 *   - after an error               -> waits twice as long each time (max 10 min), then back to normal
 *   - "Refresh now" on the page    -> at most once per PARRVA_MIN_GAP_SEC (default 20 s)
 * The API ignores from/to and always returns every recommendation, so one plain call serves
 * every date range; filtering happens here.
 *
 * Version history: PaRRVA only sends the latest version of each call (updateCount = number of
 * edits). Every time we see a call change, the previous version is saved to
 * parrva_data/versions.json, so the page can show v1 -> v2 -> v3 like the replay report.
 */
"use strict";

const EventEmitter = require("events");
const path = require("path");
const axios = require("axios");
const U = require("./util");

const DEFAULT_URL = "https://tgcare.tglevels.com/api/public/recommendations";
const VERSION_FIELDS = ["entryLo", "entryHi", "target", "sl", "exit", "lot", "strike", "cp", "side", "expiry", "intraday"];

const s = (v) => (v === undefined || v === null ? "" : String(v).trim());

/** Raw PaRRVA row -> the shape the dashboard uses. Unknown fields stay available in `raw`. */
function normalize(r) {
  const n = U.num;
  const entryLo = n(r.entryPriceStart), entryHi = n(r.entryPriceEnd);
  const lo = entryLo !== null && entryHi !== null ? Math.min(entryLo, entryHi) : entryLo ?? entryHi;
  const hi = entryLo !== null && entryHi !== null ? Math.max(entryLo, entryHi) : entryHi ?? entryLo;
  const createdMs = Date.parse(r.createdAt);
  const updatedMs = Date.parse(r.updatedAt);
  const exit = n(r.exitPrice);
  return {
    id: r.id,
    name: s(r.adviceName) || `#${r.id}`,
    version: (n(r.updateCount) || 0) + 1,
    updateCount: n(r.updateCount) || 0,
    role: s(r.role),
    product: s(r.productName),
    exchange: s(r.exchangeName).toUpperCase(),
    underlying: s(r.contractName).toUpperCase(),
    instrument: s(r.instrument).toUpperCase(),
    expiry: s(r.contractExpiryDate).slice(0, 10),
    strike: n(r.optionStrikePrice),
    cp: s(r.ceOrPe).toUpperCase(),
    side: s(r.buyOrSell).toUpperCase() || "BUY",
    lot: n(r.lot) || 1,
    priceType: s(r.priceType),
    entryLo: lo, entryHi: hi,
    target: n(r.targetPrice),
    sl: n(r.stopLoss),
    exit: exit && exit > 0 ? exit : null,          // 0 = not exited
    intraday: /^y/i.test(s(r.ifIntraday)),
    source: s(r.source),
    createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
    updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
    createdMs: Number.isFinite(createdMs) ? createdMs : null,
    updatedMs: Number.isFinite(updatedMs) ? updatedMs : null,
    date: Number.isFinite(createdMs) ? U.istDate(createdMs) : null,   // IST trading date of the call
    label: [s(r.contractName).toUpperCase(), n(r.optionStrikePrice), s(r.ceOrPe).toUpperCase()].filter((x) => x !== "" && x !== null).join(" "),
    raw: r,
  };
}

/** The list inside whatever wrapper the API uses ({data:[...]} today). */
function extractList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["data", "recommendations", "results", "items", "rows"]) if (Array.isArray(body[k])) return body[k];
  }
  return [];
}

class ParrvaFeed extends EventEmitter {
  constructor() {
    super();
    this.recs = [];               // normalized, newest first
    this.byId = new Map();
    this.raw = null;              // last upstream body
    this.lastOkAt = null;
    this.lastTryAt = null;
    this.lastError = null;
    this.upstreamStatus = null;
    this.calls = 0;               // upstream calls since boot
    this.errors = 0;
    this.timer = null;
    this.inflight = null;
    this.versionsFile = path.join(U.dataRoot(), "versions.json");
    this.versions = U.readJson(this.versionsFile, {});   // id -> [{version, at, ...fields}]
  }

  url() { return (process.env.PARRVA_API_URL || DEFAULT_URL).trim(); }
  pollMs() {
    const live = U.isTradingDayIST() && U.istMinutes() >= 540 && U.istMinutes() <= 940;   // 09:00-15:40 IST
    const sec = live ? Number(process.env.PARRVA_POLL_SEC || 60) : Number(process.env.PARRVA_IDLE_POLL_SEC || 1800);
    return Math.max(15, Number.isFinite(sec) ? sec : 60) * 1000;
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      await this.refresh().catch(() => {});
      const backoff = this.errors ? Math.min(600000, this.pollMs() * 2 ** Math.min(this.errors, 4)) : this.pollMs();
      this.timer = setTimeout(loop, backoff);
      if (this.timer.unref) this.timer.unref();
    };
    loop();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Fetch now. Concurrent callers share one request. `manual` respects the minimum gap. */
  refresh({ manual = false } = {}) {
    if (this.inflight) return this.inflight;
    const gap = Math.max(5, Number(process.env.PARRVA_MIN_GAP_SEC || 20)) * 1000;
    if (manual && this.lastTryAt && Date.now() - this.lastTryAt < gap) return Promise.resolve(false);
    this.inflight = this._fetch().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _fetch() {
    this.lastTryAt = Date.now();
    this.calls++;
    try {
      const r = await axios.get(this.url(), {
        timeout: 15000, validateStatus: () => true,
        headers: { Accept: "application/json", "User-Agent": "TGG-Dashboard/1.0" },
      });
      this.upstreamStatus = r.status;
      if (r.status < 200 || r.status >= 300) throw new Error(`PaRRVA API answered HTTP ${r.status}`);
      const list = extractList(r.data);
      if (!Array.isArray(list)) throw new Error("PaRRVA API answer has no list");
      this.raw = r.data;
      this._apply(list.map(normalize));
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.errors = 0;
      return true;
    } catch (err) {
      this.errors++;
      this.lastError = err.message;
      console.warn(`[PaRRVA] fetch failed (${this.errors} in a row): ${err.message}`);
      return false;
    }
  }

  _apply(list) {
    const changed = [];
    let versionsDirty = false;
    for (const rec of list) {
      const prev = this.byId.get(rec.id);
      const hist = this.versions[rec.id] || (this.versions[rec.id] = []);
      const snap = { version: rec.version, at: rec.updatedAt || rec.createdAt, seenAt: new Date().toISOString() };
      for (const f of VERSION_FIELDS) snap[f] = rec[f];
      const last = hist[hist.length - 1];
      if (!last || last.version !== rec.version || VERSION_FIELDS.some((f) => last[f] !== rec[f])) {
        hist.push(snap);
        if (hist.length > 20) hist.shift();
        versionsDirty = true;
      }
      if (!prev || prev.updatedAt !== rec.updatedAt || prev.version !== rec.version) changed.push(rec);
    }
    list.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
    this.recs = list;
    this.byId = new Map(list.map((r) => [r.id, r]));
    if (versionsDirty) U.writeJson(this.versionsFile, this.versions);
    if (changed.length) this.emit("update", { all: list, changed });
  }

  /** Calls whose IST date is within [from, to] (YYYY-MM-DD). No range = all. */
  list(from, to) {
    if (!from && !to) return this.recs;
    return this.recs.filter((r) => r.date && (!from || r.date >= from) && (!to || r.date <= to));
  }
  today() { return this.list(U.istDate(), U.istDate()); }
  versionsOf(id) { return this.versions[id] || []; }

  status() {
    return {
      url: this.url(), count: this.recs.length, calls: this.calls, errorsInARow: this.errors,
      lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
      lastTryAt: this.lastTryAt ? new Date(this.lastTryAt).toISOString() : null,
      lastError: this.lastError, upstreamStatus: this.upstreamStatus, pollSec: Math.round(this.pollMs() / 1000),
    };
  }
}

module.exports = { ParrvaFeed, normalize, extractList };
