/**
 * backend/src/utils/symbolValidation.js
 *
 * P3 #18 — scannerRunner.js had isValidScanSymbol(), backtestRunner.js had
 * its own separate isValidSymbol() — different names, byte-identical logic
 * (reject MCX continuous-root "-I" tickers, e.g. "MCX:CRUDEOIL-I", which
 * aren't real tradable contracts). Single source of truth now.
 */
"use strict";

function isValidSymbol(symbol) {
  if (!symbol) return false;
  const s = String(symbol).trim().toUpperCase();
  if (s.startsWith("MCX:") && /-I$/.test(s.split(":")[1] || "")) return false;
  return true;
}

module.exports = { isValidSymbol };
