/**
 * backend/src/parrva/webhook.js  (NEW 2026-11-07, PaRRVA's own format 2026-11-09)
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/parrva/webhook — PaRRVA calls this every time recommendations are saved.
 * Format = PaRRVA's WEBHOOK_INTEGRATION.md:
 *
 *   Headers  X-Webhook-Id: <eventId>
 *            X-Webhook-Timestamp: <unix seconds>
 *            X-Webhook-Signature: sha256=<hex HMAC-SHA256(PARRVA_WEBHOOK_SECRET, "<timestamp>.<raw body>")>
 *   Body     { "event": "derivative.recommendation.saved", "eventId": "...", "occurredAt": "...",
 *              "items": [ { "id": 9001, "adviceName": "TG1119", "action": "created" | "updated" }, ... ] }
 *
 * The webhook carries ids only. We answer 200 at once and then fetch those rows from the PaRRVA API
 * (?ids=..., X-API-Key) in the background (parrvaFeed.queueIds). Mounted in server.js BEFORE
 * express.json(), the API rate limiter and the admin write-gate, because the signature is checked on
 * the exact bytes PaRRVA sent.
 *
 * Answers: 200 stored / duplicate · 400 bad body · 401 bad signature or timestamp > 5 min off ·
 *          503 secret not set on our side. (PaRRVA retries only network errors, 408, 429 and 5xx.)
 *
 * ENV  PARRVA_WEBHOOK_SECRET   = PaRRVA's WEBHOOK_SECRET (same value on both sides)
 *      PARRVA_API_KEY          = PaRRVA's PUBLIC_API_KEY (used for the fetch, see parrvaFeed.js)
 *      PARRVA_WEBHOOK_MAX_SKEW_SEC  allowed clock difference, default 300
 */
"use strict";

const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const SEEN_MAX = 20000;
const SEEN_TTL_MS = 48 * 3600 * 1000;
const MAX_ITEMS = 5000;

function secret() {
  const v = String(process.env.PARRVA_WEBHOOK_SECRET || "").trim();
  return v.length >= 16 ? v : null;
}

/** "sha256=<hex>" for this timestamp and raw body (same as PaRRVA's sender). */
function sign(secretValue, timestamp, rawBody) {
  const h = crypto.createHmac("sha256", secretValue);
  h.update(`${timestamp}.`);
  h.update(rawBody);
  return `sha256=${h.digest("hex")}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Generous per-IP limit: PaRRVA sends one request per save, this only stops floods. */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PARRVA_WEBHOOK_PER_MIN || "600", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many webhook requests from this address." },
});

function createWebhookHandler(getFeed) {
  const seen = new Map();   // eventId -> ms received

  const remember = (id) => {
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) {
      const cut = Date.now() - SEEN_TTL_MS;
      for (const [k, t] of seen) { if (t < cut || seen.size > SEEN_MAX * 0.9) seen.delete(k); else break; }
    }
  };

  return function parrvaWebhook(req, res) {
    const feed = getFeed();
    const w = feed.webhook;
    const reject = (status, error) => {
      w.rejected++; w.lastRejectAt = Date.now(); w.lastRejectReason = `${status}: ${error}`;
      if (w.rejected <= 20 || w.rejected % 100 === 0) console.warn(`[PaRRVA webhook] rejected (${status}): ${error}`);
      return res.status(status).json({ ok: false, error });
    };

    const key = secret();
    if (!key) return reject(503, "Webhook is not set up on the dashboard yet (PARRVA_WEBHOOK_SECRET missing).");

    const ts = String(req.get("x-webhook-timestamp") || "");
    const sig = String(req.get("x-webhook-signature") || "");
    if (!/^\d{9,11}$/.test(ts)) return reject(401, "X-Webhook-Timestamp missing or not unix seconds.");
    const skew = Math.max(30, parseInt(process.env.PARRVA_WEBHOOK_MAX_SKEW_SEC || "300", 10) || 300);
    if (Math.abs(Date.now() / 1000 - Number(ts)) > skew) return reject(401, `X-Webhook-Timestamp is more than ${skew} s away from our clock.`);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!sig || !safeEqual(sig, sign(key, ts, raw))) return reject(401, "X-Webhook-Signature does not match.");

    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return reject(400, "Body is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400, "Body must be a JSON object.");
    const eventId = String(body.eventId || req.get("x-webhook-id") || "");
    if (!eventId || eventId.length > 128) return reject(400, "eventId must be a string of 1-128 characters.");
    if (body.event !== "derivative.recommendation.saved") return reject(400, `Unknown event "${String(body.event).slice(0, 60)}".`);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) return reject(400, `items must be a list of 1-${MAX_ITEMS} entries.`);
    const ids = [];
    for (const it of body.items) {
      const id = it && it.id;
      if (!(Number.isInteger(id) && id > 0) && !(typeof id === "string" && /^\d{1,18}$/.test(id))) return reject(400, "every item needs a numeric id.");
      ids.push(Number(id));
    }

    w.received++;
    w.lastEventAt = Date.now();
    w.lastCallEventAt = Date.now();
    w.lastItems = body.items.slice(0, 5).map((i) => `${i.adviceName || i.id}${i.action ? ` ${i.action}` : ""}`).join(", ") + (body.items.length > 5 ? ` +${body.items.length - 5} more` : "");
    if (seen.has(eventId)) { w.duplicates++; return res.json({ ok: true, result: "duplicate" }); }
    remember(eventId);

    // Reply first, fetch after: a slow reply makes PaRRVA retry.
    res.json({ ok: true, result: "queued", items: ids.length });
    setImmediate(() => { try { feed.queueIds([...new Set(ids)]); } catch (e) { console.warn(`[PaRRVA webhook] could not queue ${eventId}: ${e.message}`); } });
    return undefined;
  };
}

module.exports = { createWebhookHandler, limiter, sign };
