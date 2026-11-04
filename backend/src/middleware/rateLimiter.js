const rateLimit = require("express-rate-limit");

// Private-network exemption is for LOCAL DEVELOPMENT only. In production every
// client (including the ALB's health checker, handled via the /health skip below)
// is rate-limited, so a spoofed X-Forwarded-For can no longer bypass the limiter
// by claiming a 10.x / 192.168.x address.
const EXEMPT_PRIVATE = process.env.RATE_LIMIT_EXEMPT_PRIVATE
  ? process.env.RATE_LIMIT_EXEMPT_PRIVATE === "true"
  : process.env.NODE_ENV !== "production";

function isPrivate172(ip) {
  const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const match = clean.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = parseInt(match[1], 10);
  return second >= 16 && second <= 31;
}

function isPrivateIp(ip) {
  return (
    ip === "127.0.0.1" || ip === "::1" ||
    ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:192.168.") ||
    ip.startsWith("192.168.") || ip.startsWith("10.") || isPrivate172(ip)
  );
}

module.exports = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_MIN || "300", 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/health" || req.path === "/ready" ||
    (EXEMPT_PRIVATE && isPrivateIp(req.ip || "")),
  message: { error: "Too many requests — slow down." },
});