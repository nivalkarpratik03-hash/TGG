/**
 * utils/inputValidation.js (NEW)
 * Small, dependency-free validators shared by REST routes and Socket.IO handlers.
 */
// Fyers symbols look like  NSE:NIFTY50-INDEX  /  NSE:RELIANCE-EQ  /  NSE:NIFTY2610625000CE  /  MCX:CRUDEOIL26OCTFUT
const SYMBOL_RE = /^[A-Z0-9]{2,10}:[A-Z0-9&_\-.]{1,60}$/;

function isValidSymbol(s) {
  return typeof s === "string" && s.length <= 80 && SYMBOL_RE.test(s);
}

const ALLOWED_RESOLUTIONS = new Set([1, 3, 5, 15, 30, 60, 240, 1440, 10080, 43200]);

/** Returns a valid integer resolution, the fallback if input is absent, or null if invalid. */
function parseResolution(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && ALLOWED_RESOLUTIONS.has(n) ? n : null;
}

module.exports = { isValidSymbol, parseResolution, SYMBOL_RE, ALLOWED_RESOLUTIONS };