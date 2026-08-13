/**
 * database/src/candleValidation.js
 *
 * P3 #12 — isValidCandle() used to be defined twice, byte-for-byte
 * identical, once in candleStore.js and once in derivativesStore.js.
 * Single source of truth now — both require this file.
 *
 * A candle is valid only if every OHLC field is a finite positive number
 * and the high/low bounds are internally consistent (high is the max,
 * low is the min). Used to filter out corrupt/partial rows before they're
 * ever written to the DB.
 */
"use strict";

function isValidCandle(c) {
  return (
    c &&
    Number.isFinite(c.time) && c.time > 0 &&
    Number.isFinite(c.open) && c.open > 0 &&
    Number.isFinite(c.high) && c.high > 0 &&
    Number.isFinite(c.low) && c.low > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    c.high >= c.low &&
    c.high >= c.open &&
    c.high >= c.close &&
    c.low <= c.open &&
    c.low <= c.close
  );
}

module.exports = { isValidCandle };
