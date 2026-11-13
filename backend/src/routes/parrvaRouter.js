/**
 * backend/src/routes/parrvaRouter.js  (2026-11-05 — live PaRRVA report)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every route reads the copy kept by the backend (parrva/index.js). No route ever calls the
 * PaRRVA API directly, so any number of open pages costs PaRRVA nothing extra.
 *
 *   GET  /api/parrva/recommendations?from&to   normalized calls (+ raw), filtered by IST date
 *   GET  /api/parrva/raw                       last PaRRVA answer exactly as received
 *   GET  /api/parrva/live[?date=YYYY-MM-DD]    calls + live status + market snapshot + totals + recorder
 *   GET  /api/parrva/call/:id                  one call: status, versions, 1-minute candles (option + index)
 *   GET  /api/parrva/summary?from&to           daily and monthly totals
 *   GET  /api/parrva/refresh                   poll mode: ask for a PaRRVA fetch now (max once per 20 s)
 *                                              webhook mode: no API call, the page just reloads our copy
 *   GET  /api/parrva/system                    Admin page "System status" (no Fyers / PaRRVA call)
 *   POST /api/parrva/check                     full check against the PaRRVA API now (admin, max once per 20 s)
 *   POST /api/parrva/alerts  {enabled}         Telegram alerts on / off (admin)
 *   POST /api/parrva/alerts/test               send a test Telegram message (admin)
 *   POST /api/parrva/webhook                   PaRRVA pushes calls here (mounted in server.js, see parrva/webhook.js)
 *   GET  /api/parrva/recorder                  recorder status
 *   POST /api/parrva/recorder  {mode:"on"|"off"|"auto"}   Start / Stop for today (admin login needed)
 *   POST /api/parrva/recorder  {mode:"export", day?}      write the 3 Parquet files now (today: stops the recorder first)
 */
"use strict";

const express = require("express");
const { getParrvaLive } = require("../parrva");
const { compute: systemStatus } = require("../parrva/systemStatus");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => (typeof v === "string" && DATE.test(v) ? v : undefined);

module.exports = function createParrvaRouter() {
  const router = express.Router();
  const svc = getParrvaLive();
  // A page opened before the first fetch finished waits for it (once), instead of showing nothing.
  const ready = async () => { if (!svc.feed.lastOkAt && !svc.feed.lastTryAt) await svc.feed.refresh().catch(() => {}); };
  const wrap = (fn) => async (req, res) => {
    try { await ready(); await fn(req, res); } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  };

  router.get("/recommendations", wrap((req, res) => {
    const from = date(req.query.from), to = date(req.query.to);
    const list = svc.feed.list(from, to).map((r) => svc.view(r, { withRaw: true }));
    res.json({ ok: !svc.feed.lastError || svc.feed.recs.length > 0, data: list, count: list.length, total: svc.feed.recs.length, feed: svc.feed.status() });
  }));

  router.get("/raw", wrap((req, res) => res.json({ ok: true, feed: svc.feed.status(), data: svc.feed.raw })));

  router.get("/live", wrap((req, res) => res.json({ ok: true, ...svc.live(date(req.query.date)) })));

  router.get("/call/:id", wrap((req, res) => {
    const d = svc.detail(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: "No such PaRRVA call" });
    return res.json({ ok: true, ...d });
  }));

  router.get("/summary", wrap((req, res) => res.json({ ok: true, ...svc.summary(date(req.query.from), date(req.query.to)) })));

  router.get("/refresh", wrap(async (req, res) => {
    // Webhook mode: calls arrive by themselves, so a page Refresh never costs a PaRRVA API call.
    if (svc.feed.mode() === "webhook") return res.json({ ok: true, refreshed: false, mode: "webhook", feed: svc.feed.status() });
    const done = await svc.feed.refresh({ manual: true });
    return res.json({ ok: true, refreshed: !!done, feed: svc.feed.status() });
  }));

  // ── Admin page: System status, Check now, alerts ──
  router.get("/system", (req, res) => {
    try { res.json(systemStatus(svc, svc.alerts.info())); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  router.post("/check", async (req, res) => {
    try {
      const r = await svc.feed.reconcile("manual", { manual: true });
      res.status(r.skipped ? 429 : 200).json({ ok: !!r.ok, ...r });
    } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  });
  router.post("/alerts", (req, res) => {
    const on = req.body && req.body.enabled;
    if (typeof on !== "boolean") return res.status(400).json({ ok: false, error: "enabled must be true or false" });
    return res.json({ ok: true, ...svc.alerts.setEnabled(on) });
  });
  router.post("/alerts/test", async (req, res) => {
    const r = await svc.alerts.send("TGG test message: alerts from the Admin page work.", { force: true });
    res.status(r.ok ? 200 : 400).json(r);
  });

  router.get("/recorder", (req, res) => res.json({ ok: true, ...svc.recorder.info() }));
  router.post("/recorder", (req, res) => {
    const mode = req.body && req.body.mode;
    if (mode === "export") {
      const day = req.body.day && /^\d{4}-\d{2}-\d{2}$/.test(req.body.day) ? req.body.day : undefined;
      const r = svc.recorder.exportDay(day);
      return res.status(r.ok ? 200 : 400).json({ ...r, ...svc.recorder.info() });
    }
    if (!["on", "off", "auto"].includes(mode)) return res.status(400).json({ ok: false, error: "mode must be on, off, auto or export" });
    const r = svc.recorder.setManual(mode);
    if (mode === "on") svc.pushSubscriptions();
    return res.status(r.ok ? 200 : 400).json({ ...r, ...svc.recorder.info() });
  });

  return router;
};
