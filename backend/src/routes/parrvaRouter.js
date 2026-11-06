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
 *   GET  /api/parrva/refresh                   ask for a PaRRVA fetch now (max once per 20 s)
 *   GET  /api/parrva/recorder                  recorder status
 *   POST /api/parrva/recorder  {mode:"on"|"off"|"auto"}   Start / Stop for today (admin login needed)
 *   POST /api/parrva/recorder  {mode:"export", day?}      write the 3 Parquet files now (today: stops the recorder first)
 */
"use strict";

const express = require("express");
const { getParrvaLive } = require("../parrva");

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
    const done = await svc.feed.refresh({ manual: true });
    res.json({ ok: true, refreshed: !!done, feed: svc.feed.status() });
  }));

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
