const rateLimit = require("express-rate-limit");

// FIX: the private-IP exemption used to match ANY address starting with
// "172.", but the real RFC1918 private range is only 172.16.0.0–172.31.255.255
// (i.e. second octet 16-31). "172." also matches large chunks of the public
// internet (e.g. Cloudflare's 172.64.0.0/13), so the old check was quietly
// exempting outside traffic from the rate limit too. This checks the actual
// octet range instead of just the string prefix.
function isPrivate172(ip) {
  // Strip an IPv4-mapped IPv6 prefix if present (e.g. "::ffff:172.16.0.1")
  const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const match = clean.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const secondOctet = parseInt(match[1], 10);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isPrivateIp(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("::ffff:192.168.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    isPrivate172(ip)
  );
}

module.exports = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isPrivateIp(req.ip || ""),
});