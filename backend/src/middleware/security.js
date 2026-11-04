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
  if (authMode() === "none") problems.push("set ADMIN_USERS (recommended) or PIN so someone can log in as admin");
  else if (authMode() === "pin" && IS_PROD && process.env.PIN.length < 8) problems.push("PIN should be at least 8 characters in production (or switch to ADMIN_USERS)");
  if (ADMIN_USERS_RAW() && parseAdminUsers().size === 0) problems.push("ADMIN_USERS is set but no valid 'username:scrypt$salt$hash' entry was found");
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

function signAdminToken(user = "admin") {
  const key = secret();
  if (!key) return null;
  const exp = Date.now() + TTL_MS;
  const payload = b64u(JSON.stringify({ r: "admin", u: String(user).slice(0, 64), exp, n: crypto.randomBytes(8).toString("hex") }));
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp).toISOString() };
}

// ── Admin accounts ──────────────────────────────────────────────────────────
// ADMIN_USERS="alice:scrypt$<salt>$<hash>,bob:scrypt$<salt>$<hash>"
// Create entries with:  node backend/src/scripts/hashPassword.js
// Only salted scrypt hashes live in the environment — never plain-text passwords.
const ADMIN_USERS_RAW = () => (process.env.ADMIN_USERS || "").trim();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function parseAdminUsers() {
  const users = new Map();
  for (const entry of ADMIN_USERS_RAW().split(",")) {
    const i = entry.indexOf(":");
    if (i < 1) continue;
    const name = entry.slice(0, i).trim().toLowerCase();
    const hash = entry.slice(i + 1).trim();
    if (name && hash.startsWith("scrypt$")) users.set(name, hash);
  }
  return users;
}

/** "credentials" (ADMIN_USERS set) | "pin" (legacy single PIN) | "none" (not configured) */
function authMode() {
  if (ADMIN_USERS_RAW()) return "credentials";
  return process.env.PIN ? "pin" : "none";
}

const DUMMY_HASH = hashPassword("dummy-password-for-timing");

/** Returns the canonical username on success, otherwise null. Equal work for unknown users (no user enumeration by timing). */
function checkCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string" || username.length > 64 || password.length > 256) return null;
  const name = username.trim().toLowerCase();
  const stored = parseAdminUsers().get(name);
  const ok = verifyPassword(password, stored || DUMMY_HASH);
  return stored && ok ? name : null;
}

// Per-username lockout on top of the per-IP limiter (stops distributed guessing on one account).
const failures = new Map(); // name -> { n, until }
const LOCK_AFTER = parseInt(process.env.LOGIN_MAX_ATTEMPTS || "5", 10);
const LOCK_MS = 15 * 60 * 1000;
function isLocked(name) {
  const f = failures.get(String(name || "").trim().toLowerCase());
  return !!(f && f.until && f.until > Date.now());
}
function recordFailure(name) {
  const k = String(name || "").trim().toLowerCase().slice(0, 64);
  const f = failures.get(k) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCK_AFTER) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  failures.set(k, f);
  if (failures.size > 5000) failures.clear();   // memory guard
}
function recordSuccess(name) { failures.delete(String(name || "").trim().toLowerCase()); }

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
const PUBLIC_WRITE_ROUTES = new Set(["/api/admin/verify-pin", "/api/admin/login", "/api/chart/refresh"]);

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
  message: { ok: false, error: "Too many failed login attempts from this address. Try again in 15 minutes." },
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
  hashPassword, verifyPassword, checkCredentials, authMode, isLocked, recordFailure, recordSuccess, hasSecret: () => !!secret(),
};