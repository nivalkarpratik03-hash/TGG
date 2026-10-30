/**
 * middleware/security.js  (NEW — production hardening)
 *
 * One place for everything that protects the API:
 *   - helmet security headers (+ x-powered-by off)
 *   - gzip/deflate compression (skips Socket.IO)
 *   - signed, expiring admin session tokens (issued by POST /api/admin/verify-pin)
 *   - requireAdminForWrites: every non-GET /api request needs a valid admin token,
 *     except a small allow-list of routes ordinary chart users legitimately need.
 *   - strict PIN-attempt limiter (brute-force protection)
 *
 * ENV
 *   ADMIN_SESSION_SECRET   REQUIRED in production. >= 32 random chars. Signs admin tokens.
 *   PIN                    Admin PIN (already used by the app). Use 8+ chars in production.
 *   ADMIN_SESSION_TTL_MIN  Token lifetime in minutes (default 480).
 *   ADMIN_PROTECT_WRITES   "false" turns the write-gate off (only for a fully private network).
 */
const crypto = require("crypto");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const IS_PROD = process.env.NODE_ENV === "production";
const TTL_MS = (parseInt(process.env.ADMIN_SESSION_TTL_MIN || "480", 10) || 480) * 60 * 1000;
const PROTECT_WRITES = process.env.ADMIN_PROTECT_WRITES !== "false";

function secret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

/** Fail fast at boot instead of running with a guessable/unset secret. */
function assertProductionConfig() {
  const problems = [];
  if (PROTECT_WRITES && !secret()) problems.push("ADMIN_SESSION_SECRET must be set (>= 32 chars)");
  if (!process.env.PIN) problems.push("PIN must be set");
  else if (IS_PROD && process.env.PIN.length < 8) problems.push("PIN should be at least 8 characters in production");
  if (IS_PROD && !process.env.CORS_ORIGINS && !process.env.PUBLIC_FRONTEND_ORIGIN) {
    console.warn("[Security] CORS_ORIGINS not set — cross-origin browser requests will be blocked (same-origin still works).");
  }
  if (problems.length) {
    const msg = "[Security] Refusing to start: " + problems.join("; ");
    if (IS_PROD) { console.error(msg); process.exit(1); }
    else console.warn(msg + "  (continuing because NODE_ENV != production)");
  }
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signAdminToken() {
  const key = secret();
  if (!key) return null;
  const payload = b64u(JSON.stringify({ r: "admin", exp: Date.now() + TTL_MS, n: crypto.randomBytes(8).toString("hex") }));
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  const key = secret();
  if (!key || typeof token !== "string" || token.length > 512) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp, r } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return r === "admin" && typeof exp === "number" && exp > Date.now();
  } catch { return false; }
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractToken(req) {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7);
  const x = req.headers["x-admin-token"];
  return typeof x === "string" ? x : null;
}

// Non-GET routes that regular (non-admin) chart users need. Everything else
// that mutates state or triggers heavy work needs an admin token.
const PUBLIC_WRITE_ROUTES = new Set(["/api/admin/verify-pin", "/api/chart/refresh"]);

function requireAdminForWrites(req, res, next) {
  if (!PROTECT_WRITES) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();
  if (PUBLIC_WRITE_ROUTES.has(req.path)) return next();
  if (verifyAdminToken(extractToken(req))) return next();
  return res.status(401).json({ error: "Admin authentication required. Verify your PIN on the /admin page first." });
}

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.PIN_MAX_ATTEMPTS || "5", 10),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: "Too many PIN attempts. Try again in 15 minutes." },
});

/**
 * In production, replace the body of any HTTP 500 JSON error with a generic message
 * (the original is logged server-side). ~40 routes do `res.status(500).json({ error: err.message })`,
 * which can leak SQL fragments, file paths and library internals to anonymous clients.
 * 4xx messages (validation errors the client can act on) are left untouched.
 */
function sanitize5xx(req, res, next) {
  if (!IS_PROD && process.env.EXPOSE_ERRORS !== "false") return next();
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 500 && body && typeof body === "object" && "error" in body) {
      console.error(`[HTTP 500] ${req.method} ${req.originalUrl}: ${body.error}`);
      return orig({ error: "Internal server error" });
    }
    return orig(body);
  };
  next();
}

function applySecurity(app) {
  app.disable("x-powered-by");
  app.use(sanitize5xx);
  app.use(helmet({
    // CSP is intentionally OFF: the TradingView charting library and CRA bundle
    // rely on inline styles/workers/blob URLs. Enable gradually in Report-Only mode.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
  }));
  app.use(compression({
    level: 4,          // zlib default (6) costs ~2-3x the CPU for ~5% smaller output; this is a single-threaded event loop
    threshold: 1024,
    filter: (req, res) => (req.path.startsWith("/socket.io") ? false : compression.filter(req, res)),
  }));
}

module.exports = {
  applySecurity, assertProductionConfig, requireAdminForWrites, pinLimiter,
  signAdminToken, verifyAdminToken, safeEqual, extractToken,
};