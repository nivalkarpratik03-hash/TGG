/**
 * backend/src/parrva/parrvaFeed.js  (NEW 2026-11-05, webhook mode added 2026-11-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * The backend's one copy of the PaRRVA calls. Browsers never cause an upstream call:
 * every page reads the copy kept here.
 *
 * Two ways the copy is kept up to date (PARRVA_MODE):
 *
 *   webhook (production)  PaRRVA POSTs the ids of saved calls to /api/parrva/webhook (webhook.js);
 *                         we then fetch exactly those rows (?ids=..., X-API-Key). Other API calls:
 *                           - every PARRVA_SYNC_MIN (default 15) in market hours: ?updatedSince=<newest we have>,
 *                             only changed rows, in case a webhook was lost (PaRRVA retries only for seconds)
 *                         and a full check:
 *                           - once when the server starts
 *                           - at PARRVA_CHECK_TIMES on trading days (default 09:05 and 15:45 IST)
 *                           - when a heartbeat says PaRRVA has a different number of calls today
 *                           - when an admin presses "Check now" (max once per PARRVA_MIN_GAP_SEC)
 *                           - only if PARRVA_FALLBACK_POLL_MIN > 0: every N minutes while the
 *                             webhook has been silent for PARRVA_SILENT_MIN in market hours (off by default)
 *
 *   poll (default, until PaRRVA sends webhooks)
 *                         trading day 09:00-15:40 IST -> every PARRVA_POLL_SEC (default 60 s)
 *                         any other time              -> every PARRVA_IDLE_POLL_SEC (default 1800 s)
 *                         webhooks are still accepted in this mode, so both can run side by side
 *                         while PaRRVA tests their sender.
 *
 * Version history: every time a call changes, the previous version is saved to
 * parrva_data/versions.json, so the page can show v1 -> v2 -> v3.
 * The calls themselves are saved to parrva_data/calls.json, so a restart shows them at once
 * even if the PaRRVA API is down.
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

/** a is a later version of the same call than b (more edits, or same edits but updated later). */
function isNewer(a, b) {
  if (a.updateCount !== b.updateCount) return a.updateCount > b.updateCount;
  return (a.updatedMs || 0) > (b.updatedMs || 0);
}

const envNum = (k, d) => { const v = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) ? v : d; };

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
    this.callsFile = path.join(U.dataRoot(), "calls.json");
    this.checksFile = path.join(U.dataRoot(), "checks.json");
    this.checks = U.readJson(this.checksFile, {});        // IST date -> [{slot, reason, at, ok, missing, stale, error}]
    this.checkDone = new Set();                           // "date|HH:MM" already run today
    this.saveTimer = null;
    this.webhook = {
      received: 0, applied: 0, stale: 0, duplicates: 0, rejected: 0,
      lastEventAt: null, lastCallEventAt: null, lastHeartbeatAt: null, lastHeartbeat: null,
      lastRejectAt: null, lastRejectReason: null,
    };
    this.loadSaved();
  }

  url() { return (process.env.PARRVA_API_URL || DEFAULT_URL).trim(); }
  mode() { return String(process.env.PARRVA_MODE || "poll").trim().toLowerCase() === "webhook" ? "webhook" : "poll"; }
  marketHours(ms = Date.now()) { const m = U.istMinutes(ms); return U.isTradingDayIST(ms) && m >= 540 && m <= 945; }   // 09:00-15:45 IST
  silentMs() { return Math.max(2, envNum("PARRVA_SILENT_MIN", 10)) * 60000; }
  checkTimes() {
    return String(process.env.PARRVA_CHECK_TIMES || "09:05,15:45").split(",").map((x) => x.trim()).filter((x) => Number.isFinite(U.hhmm(x)));
  }
  pollMs() {
    const live = U.isTradingDayIST() && U.istMinutes() >= 540 && U.istMinutes() <= 940;   // 09:00-15:40 IST
    const sec = live ? envNum("PARRVA_POLL_SEC", 60) : envNum("PARRVA_IDLE_POLL_SEC", 1800);
    return Math.max(15, sec) * 1000;
  }

  /** Calls saved by the last run, so the page is not empty while the first check runs. */
  loadSaved() {
    const saved = U.readJson(this.callsFile, null);
    if (!saved || !Array.isArray(saved.list)) return;
    const list = [];
    for (const raw of saved.list) {
      try { const r = normalize(raw); if (r.id !== undefined && r.id !== null) list.push(r); } catch { /* skip a bad row */ }
    }
    this._setList(list);
    this._noteNewest(saved.list.filter((x) => x && typeof x === "object"));
  }
  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      U.writeJson(this.callsFile, { savedAt: new Date().toISOString(), list: this.recs.map((r) => r.raw) });
    }, 2000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  start() {
    if (this.timer) return;
    if (this.recs.length) setImmediate(() => this.emit("update", { all: this.recs, changed: this.recs }));
    if (this.mode() === "webhook") {
      this.reconcile("startup").catch(() => {});
      const tick = () => {
        this._webhookTick().catch((e) => console.warn("[PaRRVA] check failed:", e.message));
        this.timer = setTimeout(tick, 30000);
        if (this.timer.unref) this.timer.unref();
      };
      this.timer = setTimeout(tick, 30000);
      if (this.timer.unref) this.timer.unref();
      console.log(`[PaRRVA] webhook mode: API checked at start and at ${this.checkTimes().join(", ")} IST on trading days`);
      return;
    }
    const loop = async () => {
      await this.refresh().catch(() => {});
      const backoff = this.errors ? Math.min(600000, this.pollMs() * 2 ** Math.min(this.errors, 4)) : this.pollMs();
      this.timer = setTimeout(loop, backoff);
      if (this.timer.unref) this.timer.unref();
    };
    loop();
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; U.writeJson(this.callsFile, { savedAt: new Date().toISOString(), list: this.recs.map((r) => r.raw) }); }
  }

  /** Every 30 s in webhook mode: run the scheduled checks; optional fallback poll while the webhook is silent. */
  async _webhookTick() {
    const now = Date.now();
    if (U.isTradingDayIST(now)) {
      const day = U.istDate(now), min = U.istMinutes(now);
      for (const t of this.checkTimes()) {
        const at = U.hhmm(t), key = `${day}|${t}`;
        // Run once when the time is reached; if the server was down at that time, run within the next 60 min.
        if (!this.checkDone.has(key) && min >= at && min < at + 60) {
          this.checkDone.add(key);
          await this.reconcile(at >= 900 ? "close" : at < 720 ? "morning" : `check ${t}`);
        }
      }
    }
    // Safety sync for a missed webhook (PaRRVA only retries for a few seconds): one small request
    // that returns only rows changed since the newest one we have. PARRVA_SYNC_MIN=0 turns it off.
    const syncMin = envNum("PARRVA_SYNC_MIN", 15);
    if (syncMin > 0 && this.marketHours(now) && (!this.lastSyncAt || now - this.lastSyncAt >= syncMin * 60000) && (!this.lastTryAt || now - this.lastTryAt >= 60000)) {
      await this.syncSince("safety sync");
    }
    const fallback = envNum("PARRVA_FALLBACK_POLL_MIN", 0);
    if (fallback > 0 && this.marketHours(now) && this.silentFor(now) > this.silentMs() && (!this.lastTryAt || now - this.lastTryAt >= fallback * 60000)) {
      await this.reconcile("webhook silent");
    }
  }

  /** ms since the last webhook of any kind (heartbeat or call). Infinity if none since boot. */
  silentFor(now = Date.now()) { return this.webhook.lastEventAt ? now - this.webhook.lastEventAt : Infinity; }

  /** Fetch now. Concurrent callers share one request. `manual` respects the minimum gap. */
  refresh({ manual = false } = {}) {
    if (this.inflight) return this.inflight;
    const gap = Math.max(5, envNum("PARRVA_MIN_GAP_SEC", 20)) * 1000;
    if (manual && this.lastTryAt && Date.now() - this.lastTryAt < gap) return Promise.resolve(false);
    this.inflight = this._fetch().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * Full check against the PaRRVA API: fetch the whole list once and count what the webhook missed.
   * missing = calls the API has that we did not have; stale = calls where the API has a later version.
   */
  async reconcile(reason, { manual = false } = {}) {
    const gapSec = Math.max(5, envNum("PARRVA_MIN_GAP_SEC", 20));
    if (manual && !this.inflight && this.lastTryAt && Date.now() - this.lastTryAt < gapSec * 1000) {
      return { ok: false, skipped: true, error: `Checked less than ${gapSec} s ago. Try again in a few seconds.` };
    }
    const before = new Map(this.byId);
    const ok = await this.refresh();
    let missing = 0, stale = 0;
    const missingIds = [];
    if (ok) {
      for (const r of this._lastApiList || []) {
        const b = before.get(r.id);
        if (!b) { missing++; if (missingIds.length < 20) missingIds.push(r.id); } else if (isNewer(r, b)) stale++;
      }
    }
    // At startup, calls we did not have were made while this server was down: not a webhook miss.
    let loaded = null;
    if (reason === "startup") { loaded = missing + stale; missing = 0; stale = 0; missingIds.length = 0; }
    const day = U.istDate();
    const entry = { loaded, slot: reason, at: new Date().toISOString(), ok: !!ok, missing, stale, missingIds, count: ok ? (this._lastApiList || []).filter((r) => r.date === day).length : null, error: ok ? null : this.lastError };
    const list = this.checks[day] || (this.checks[day] = []);
    list.push(entry);
    if (list.length > 50) list.shift();
    for (const d of Object.keys(this.checks)) if (d < U.istDate(Date.now() - 30 * 86400000)) delete this.checks[d];
    U.writeJson(this.checksFile, this.checks);
    if (this.mode() === "webhook" && ok && (missing || stale)) console.warn(`[PaRRVA] ${reason} check: webhook had missed ${missing} new and ${stale} changed call(s); fixed from the API`);
    this.emit("check", entry);
    return entry;
  }
  checksOf(day = U.istDate()) { return this.checks[day] || []; }

  /** One GET to the PaRRVA API with the API key. Returns the parsed body. */
  async _get(params = {}) {
    this.calls++;
    const key = String(process.env.PARRVA_API_KEY || "").trim();
    const r = await axios.get(this.url(), {
      params, timeout: 20000, validateStatus: () => true,
      headers: { Accept: "application/json", "User-Agent": "TGG-Dashboard/1.0", ...(key ? { "X-API-Key": key } : {}) },
    });
    this.upstreamStatus = r.status;
    if (r.status === 401) throw new Error(key ? "PaRRVA API answered 401: PARRVA_API_KEY is wrong" : "PaRRVA API answered 401: PARRVA_API_KEY is not set in .env");
    if (r.status === 503) throw new Error("PaRRVA API answered 503: the key is not configured on the PaRRVA server");
    if (r.status < 200 || r.status >= 300) throw new Error(`PaRRVA API answered HTTP ${r.status}`);
    return r.data;
  }

  /** Every row for these query params, following page=1,2,3... until `total` rows are in. */
  async _getAll(params = {}) {
    const limit = 5000;
    const rows = [];
    let total = null;
    for (let page = 1; page <= 200; page++) {
      const body = await this._get({ ...params, page, limit });
      const list = extractList(body);
      rows.push(...list);
      total = body && Number.isFinite(Number(body.total)) ? Number(body.total) : null;
      if (!list.length || total === null || rows.length >= total) break;
    }
    return { rows, total, body: { data: rows, total } };
  }

  /** Remember the newest updatedAt we have (their own string, so a clock difference never skips rows). */
  _noteNewest(rows) {
    for (const r of rows) {
      const t = Date.parse(r.updatedAt || r.createdAt);
      if (Number.isFinite(t) && (!this.newestMs || t > this.newestMs)) { this.newestMs = t; this.newest = r.updatedAt || r.createdAt; }
    }
  }

  async _fetch() {
    const startedAt = Date.now();
    this.lastTryAt = startedAt;
    try {
      const { rows, body } = await this._getAll();
      this.raw = body;
      const norm = rows.map(normalize).filter((x) => x.id !== undefined && x.id !== null);
      this._lastApiList = norm;
      this._noteNewest(rows);
      this._applyFull(norm, startedAt);
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

  /** Upsert rows that came from an ids / updatedSince fetch. Returns how many were new or changed. */
  _upsertRows(rows) {
    let applied = 0;
    for (const raw of rows) {
      try { if (this.upsert(raw) === "applied") applied++; } catch (e) { console.warn(`[PaRRVA] bad row ${raw && raw.id}: ${e.message}`); }
    }
    this._noteNewest(rows);
    return applied;
  }

  /**
   * Webhook said these ids were saved: fetch exactly those rows (?ids=..., 1000 per request).
   * Ids that arrive while a fetch runs are collected and fetched right after it. A failed fetch is
   * tried again after 5 s, 30 s and 2 min; after that the next safety sync / check picks them up.
   */
  queueIds(ids) {
    if (!this.pendingIds) this.pendingIds = new Set();
    for (const id of ids) this.pendingIds.add(id);
    if (!this.idsRunning) this._drainIds(0).catch(() => {});
  }
  async _drainIds(attempt) {
    this.idsRunning = true;
    const ids = [...this.pendingIds];
    this.pendingIds.clear();
    const w = this.webhook;
    try {
      let got = 0, applied = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const { rows } = await this._getAll({ ids: ids.slice(i, i + 1000).join(",") });
        got += rows.length;
        applied += this._upsertRows(rows);
      }
      w.lastFetchAt = Date.now(); w.lastFetchError = null; w.lastFetchCount = got; w.applied += applied;
      this.lastOkAt = Date.now(); this.lastError = null; this.errors = 0;
    } catch (err) {
      w.lastFetchError = err.message; w.lastFetchErrorAt = Date.now();
      for (const id of ids) this.pendingIds.add(id);
      const wait = [5000, 30000, 120000][attempt];
      console.warn(`[PaRRVA] fetching ${ids.length} call(s) after a webhook failed: ${err.message}${wait ? ` - trying again in ${wait / 1000} s` : " - left for the next sync"}`);
      if (wait) {
        const t = setTimeout(() => this._drainIds(attempt + 1).catch(() => {}), wait);
        if (t.unref) t.unref();
        return;
      }
      this.pendingIds.clear();
    }
    if (this.pendingIds.size) return this._drainIds(0);
    this.idsRunning = false;
    return undefined;
  }

  /** Safety sync: only rows created or changed since the newest updatedAt we have (?updatedSince=...). */
  async syncSince(reason = "sync") {
    if (!this.newest) return this.reconcile(reason);   // nothing stored yet: full list
    this.lastSyncAt = Date.now();
    try {
      const { rows } = await this._getAll({ updatedSince: this.newest });
      const applied = this._upsertRows(rows);
      this.lastSync = { at: new Date().toISOString(), ok: true, rows: rows.length, applied };
      if (applied) console.warn(`[PaRRVA] ${reason}: ${applied} new or changed call(s) the webhook had not brought`);
      this.lastOkAt = Date.now(); this.lastError = null; this.errors = 0;
    } catch (err) {
      this.lastSync = { at: new Date().toISOString(), ok: false, error: err.message };
      this.errors++; this.lastError = err.message;
      console.warn(`[PaRRVA] ${reason} failed: ${err.message}`);
    }
    return this.lastSync;
  }

  /** Save a version snapshot when a call changed. Returns true if versions.json needs writing. */
  _snapVersion(rec) {
    const hist = this.versions[rec.id] || (this.versions[rec.id] = []);
    const last = hist[hist.length - 1];
    if (last && last.version === rec.version && VERSION_FIELDS.every((f) => last[f] === rec[f])) return false;
    const snap = { version: rec.version, at: rec.updatedAt || rec.createdAt, seenAt: new Date().toISOString() };
    for (const f of VERSION_FIELDS) snap[f] = rec[f];
    hist.push(snap);
    if (hist.length > 20) hist.shift();
    return true;
  }

  _setList(list) {
    list.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
    this.recs = list;
    this.byId = new Map(list.map((r) => [r.id, r]));
  }

  /**
   * The API list is the truth, except where a webhook brought a later version while the request was
   * on its way, or a call arrived by webhook after the API answer was made.
   */
  _applyFull(list, fetchStartedAt) {
    const changed = [];
    let versionsDirty = false;
    const seen = new Set();
    const out = [];
    for (const rec of list) {
      seen.add(rec.id);
      const cur = this.byId.get(rec.id);
      const pick = cur && isNewer(cur, rec) ? cur : rec;
      if (pick === rec) {
        if (this._snapVersion(rec)) versionsDirty = true;
        if (!cur || cur.updatedAt !== rec.updatedAt || cur.version !== rec.version) changed.push(rec);
      }
      out.push(pick);
    }
    for (const cur of this.recs) {
      if (!seen.has(cur.id) && cur.viaWebhookAt && cur.viaWebhookAt >= fetchStartedAt - 30000) out.push(cur);
    }
    const removed = this.recs.some((r) => !seen.has(r.id) && !(r.viaWebhookAt && r.viaWebhookAt >= fetchStartedAt - 30000));
    this._setList(out);
    if (versionsDirty) U.writeJson(this.versionsFile, this.versions);
    if (changed.length || removed) { this._scheduleSave(); this.emit("update", { all: this.recs, changed }); }
  }

  /** One call from the webhook. Returns "applied" or "stale" (an older or identical version). */
  upsert(rawRow) {
    const rec = normalize(rawRow);
    if (rec.id === undefined || rec.id === null) throw new Error("call has no id");
    const cur = this.byId.get(rec.id);
    if (cur && !isNewer(rec, cur)) return "stale";
    rec.viaWebhookAt = Date.now();
    const list = this.recs.filter((r) => r.id !== rec.id);
    list.push(rec);
    this._setList(list);
    if (this._snapVersion(rec)) U.writeJson(this.versionsFile, this.versions);
    this._scheduleSave();
    this.emit("update", { all: this.recs, changed: [rec] });
    return "applied";
  }

  /** A call PaRRVA deleted. Returns "applied" or "unknown". */
  remove(id) {
    const key = this.byId.has(id) ? id : this.byId.has(Number(id)) ? Number(id) : this.byId.has(String(id)) ? String(id) : null;
    if (key === null) return "unknown";
    this._setList(this.recs.filter((r) => r.id !== key));
    this._scheduleSave();
    this.emit("update", { all: this.recs, changed: [] });
    return "applied";
  }

  /**
   * Heartbeat from PaRRVA: {date, count, lastUpdatedAt}. If their count of today's calls or their
   * latest edit time differs from ours, one full check runs (at most once a minute).
   */
  heartbeat(data = {}) {
    this.webhook.lastHeartbeatAt = Date.now();
    this.webhook.lastHeartbeat = { date: data.date || null, count: U.num(data.count), lastUpdatedAt: data.lastUpdatedAt || null };
    const today = U.istDate();
    if (data.date !== today) return "ok";
    const ours = this.today();
    const theirCount = U.num(data.count);
    const theirLast = Date.parse(data.lastUpdatedAt);
    const ourLast = ours.reduce((m, r) => Math.max(m, r.updatedMs || r.createdMs || 0), 0);
    const differs = (theirCount !== null && theirCount !== ours.length) || (Number.isFinite(theirLast) && theirLast > ourLast + 1000);
    if (!differs) return "ok";
    if (this.lastTryAt && Date.now() - this.lastTryAt < 60000) return "mismatch (check already ran in the last minute)";
    this.reconcile("heartbeat mismatch").catch(() => {});
    return "mismatch (full check started)";
  }

  /** Calls whose IST date is within [from, to] (YYYY-MM-DD). No range = all. */
  list(from, to) {
    if (!from && !to) return this.recs;
    return this.recs.filter((r) => r.date && (!from || r.date >= from) && (!to || r.date <= to));
  }
  today() { return this.list(U.istDate(), U.istDate()); }
  versionsOf(id) { return this.versions[id] || []; }

  status() {
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const w = this.webhook;
    return {
      mode: this.mode(),
      url: this.url(), count: this.recs.length, calls: this.calls, errorsInARow: this.errors,
      lastOkAt: iso(this.lastOkAt), lastTryAt: iso(this.lastTryAt),
      lastError: this.lastError, upstreamStatus: this.upstreamStatus,
      pollSec: this.mode() === "poll" ? Math.round(this.pollMs() / 1000) : null,
      checkTimes: this.mode() === "webhook" ? this.checkTimes() : null,
      apiKey: !!String(process.env.PARRVA_API_KEY || "").trim(),
      syncMin: this.mode() === "webhook" ? envNum("PARRVA_SYNC_MIN", 15) : null, lastSync: this.lastSync || null, newest: this.newest || null,
      webhook: {
        configured: !!(process.env.PARRVA_WEBHOOK_SECRET && process.env.PARRVA_WEBHOOK_SECRET.trim().length >= 16),
        lastFetchAt: iso(w.lastFetchAt), lastFetchCount: w.lastFetchCount || 0, lastFetchError: w.lastFetchError || null, lastFetchErrorAt: iso(w.lastFetchErrorAt),
        pending: this.pendingIds ? this.pendingIds.size : 0,
        received: w.received, applied: w.applied, stale: w.stale, duplicates: w.duplicates, rejected: w.rejected,
        lastEventAt: iso(w.lastEventAt), lastCallEventAt: iso(w.lastCallEventAt), lastHeartbeatAt: iso(w.lastHeartbeatAt),
        lastHeartbeat: w.lastHeartbeat, lastRejectAt: iso(w.lastRejectAt), lastRejectReason: w.lastRejectReason,
      },
    };
  }
}

module.exports = { ParrvaFeed, normalize, extractList, isNewer };
