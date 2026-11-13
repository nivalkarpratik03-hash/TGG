/**
 * backend/src/parrva/alerts.js  (NEW 2026-11-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * Telegram message when a System status row turns red, and one when it is fine again.
 * Also a login reminder at 08:45 IST on trading days if a Fyers account is not logged in.
 *
 *   - checks every 30 s; a row must be red on 2 checks in a row (about 1 minute) before it alerts,
 *     so a short reconnect does not send anything
 *   - one message per problem, one "fixed" message when it clears; at most 20 messages an hour
 *   - on / off from the Admin page, saved in parrva_data/alerts.json
 *
 * ENV
 *   ALERT_TELEGRAM_BOT_TOKEN   bot token from @BotFather (a new bot, not the recorder bot)
 *   ALERT_TELEGRAM_CHAT_ID     chat or group id that gets the messages
 *   ALERT_REMINDER_AT          login reminder time, default 08:45 (empty = no reminder)
 */
"use strict";

const path = require("path");
const axios = require("axios");
const U = require("./util");
const { compute } = require("./systemStatus");

const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");

class Alerts {
  constructor(svc) {
    this.svc = svc;
    this.file = path.join(U.dataRoot(), "alerts.json");
    const saved = U.readJson(this.file, {});
    this.enabled = saved.enabled !== false;
    this.savedOpen = saved.day === U.istDate() && saved.open && typeof saved.open === "object" ? saved.open : {};   // key -> {name, at}
    this.badCount = new Map();   // row key -> consecutive red checks
    this.alerted = new Map(Object.entries(this.savedOpen));   // row key -> {name, at}; kept over a restart the same day
    this.sentTimes = [];
    this.lastSendError = null;
    this.lastSentAt = null;
    this.reminderDay = null;
    this.timer = null;
  }

  configured() { return !!(clean(process.env.ALERT_TELEGRAM_BOT_TOKEN) && clean(process.env.ALERT_TELEGRAM_CHAT_ID)); }
  info() {
    return {
      enabled: this.enabled, configured: this.configured(),
      lastSentAt: this.lastSentAt ? new Date(this.lastSentAt).toISOString() : null, lastError: this.lastSendError,
      open: [...this.alerted.values()].map((a) => a.name),
    };
  }
  setEnabled(on) {
    this.enabled = !!on;
    this.save();
    return this.info();
  }
  save() { U.writeJson(this.file, { enabled: this.enabled, day: U.istDate(), open: Object.fromEntries(this.alerted) }); }

  start() {
    if (this.timer) return;
    const run = () => { try { this.tick(); } catch (e) { console.warn("[Alerts]", e.message); } };
    this.timer = setInterval(run, 30000);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  tick(now = Date.now()) {
    if (this.day !== U.istDate(now)) {
      if (this.day) this.alerted.clear();
      this.day = U.istDate(now);
    }
    const status = compute(this.svc, null, now);
    const rows = status.groups.flatMap((g) => g.rows);
    for (const r of rows) {
      if (r.state === "bad") {
        const n = (this.badCount.get(r.key) || 0) + 1;
        this.badCount.set(r.key, n);
        if (n === 2 && !this.alerted.has(r.key)) {
          this.alerted.set(r.key, { name: r.name, at: now });
          this.save();
          this.send(`TGG problem: ${r.name}\n${r.detail}\n(${U.istClock(now)} IST)`);
        }
      } else {
        this.badCount.delete(r.key);
        const a = this.alerted.get(r.key);
        if (a && (r.state === "ok" || r.state === "off")) {
          this.alerted.delete(r.key);
          this.save();
          this.send(`TGG fixed: ${r.name}\n${r.detail}\n(was broken for ${Math.max(1, Math.round((now - a.at) / 60000))} min)`);
        }
      }
    }
    // Login reminder
    const at = U.hhmm(process.env.ALERT_REMINDER_AT === undefined ? "08:45" : process.env.ALERT_REMINDER_AT);
    const day = U.istDate(now), min = U.istMinutes(now);
    if (Number.isFinite(at) && U.isTradingDayIST(now) && this.reminderDay !== day && min >= at && min < at + 30) {
      this.reminderDay = day;
      const missing = rows.filter((r) => r.key.startsWith("fyers") && r.state !== "ok" && r.value !== "not set up").map((r) => r.name);
      if (missing.length) this.send(`TGG reminder: log in to Fyers on the Admin page before 09:14\nNot logged in: ${missing.join(", ")}`);
    }
  }

  /** Send one message. Never throws. Returns {ok, error}. */
  async send(text, { force = false } = {}) {
    if (!this.configured()) return { ok: false, error: "ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID not set" };
    if (!this.enabled && !force) return { ok: false, error: "alerts are off" };
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600000);
    if (this.sentTimes.length >= 20 && !force) return { ok: false, error: "20 messages in the last hour, holding the rest" };
    this.sentTimes.push(now);
    try {
      const r = await axios.post(`https://api.telegram.org/bot${clean(process.env.ALERT_TELEGRAM_BOT_TOKEN)}/sendMessage`,
        { chat_id: clean(process.env.ALERT_TELEGRAM_CHAT_ID), text, disable_web_page_preview: true },
        { timeout: 10000, validateStatus: () => true });
      if (r.status !== 200 || !r.data || r.data.ok !== true) throw new Error((r.data && r.data.description) || `Telegram answered HTTP ${r.status}`);
      this.lastSentAt = now; this.lastSendError = null;
      return { ok: true };
    } catch (err) {
      // never log the URL: it contains the bot token
      this.lastSendError = err.response ? `HTTP ${err.response.status}` : String(err.message || err).replace(/bot\d+:[\w-]+/g, "bot***");
      console.warn(`[Alerts] Telegram send failed: ${this.lastSendError}`);
      return { ok: false, error: this.lastSendError };
    }
  }
}

module.exports = { Alerts };
