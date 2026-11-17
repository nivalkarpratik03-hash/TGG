/**
 * backend/src/parrva/util.js  (NEW 2026-11-05)
 * Small shared helpers for the live PaRRVA report: IST clock, trading-day check, safe JSON files.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** "YYYY-MM-DD" in IST for a ms timestamp (default now). */
function istDate(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
/** Minutes since IST midnight. */
function istMinutes(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/** "HH:MM:SS" IST. */
function istClock(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);
}
/** Epoch ms of HH:MM IST on the given IST date (YYYY-MM-DD). */
function istAt(dateStr, hh, mm = 0) {
  return Date.parse(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
}

let holidays = new Set();
try { holidays = require("../data/holidays").NSE_BSE_HOLIDAYS_2026 || holidays; } catch { /* optional */ }

/** True on NSE trading days (Mon-Fri, not in the holiday list). Uses the IST calendar date. */
function isTradingDayIST(ms = Date.now()) {
  const key = istDate(ms);
  const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(key);
}

/** "HH:MM" -> minutes, NaN if malformed. */
function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
/** Write-then-rename so a crash never leaves a half-written file. Never throws. */
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[PaRRVA] could not write ${file}: ${err.message}`);
    return false;
  }
}

// ── market hours per call (2026-11-16: stock + MCX calls) ──────────────────────
/** True when US daylight-saving time is on for that IST date (2nd Sunday of March .. 1st Sunday of November). */
function usDst(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return false;
  const nthSunday = (month, nth) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (nth - 1) * 7; };
  const start = nthSunday(3, 2), end = nthSunday(11, 1);
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  return m === 3 ? d >= start : d < end;
}
/**
 * Minutes after IST midnight when the call's market closes.
 *   NSE / BSE (index, stock, equity): 15:30
 *   MCX: 23:30, or 23:55 while US daylight-saving time is on (MCX timing for internationally linked commodities).
 *        MCX_CLOSE=HH:MM in .env overrides it.
 */
function closeMinOf(rec) {
  const ex = String((rec && rec.exchange) || "").toUpperCase();
  if (ex === "MCX" || ex === "NCDEX") {
    const o = hhmm(process.env.MCX_CLOSE);
    if (Number.isFinite(o)) return o;
    return usDst(rec && rec.date) ? 23 * 60 + 55 : 23 * 60 + 30;
  }
  return 15 * 60 + 30;
}
/** Epoch ms when the call's market closes on the call's date (null without a date). */
function closeMsOf(rec) {
  if (!rec || !rec.date) return null;
  const m = closeMinOf(rec);
  return istAt(rec.date, Math.floor(m / 60), m % 60);
}
/**
 * Is this call part of the NIFTY order-flow dataset (recorded into recordings/<date>/symbols and the Parquet files)?
 * Only NIFTY index options on NSE. Every other call (stocks, MCX, SENSEX ...) is tracked for the report only.
 */
function isDatasetCall(rec) {
  if (!rec) return false;
  const ex = String(rec.exchange || "NSE").toUpperCase();
  const ins = String(rec.instrument || "OPTIDX").toUpperCase();
  return String(rec.underlying || "").toUpperCase() === "NIFTY" && ex === "NSE" && ins === "OPTIDX";
}

/** Root folder for everything the live PaRRVA report stores (recordings, history, results). */
function dataRoot() {
  return process.env.PARRVA_DATA_DIR
    ? path.resolve(process.env.PARRVA_DATA_DIR)
    : path.resolve(__dirname, "../../parrva_data");
}

module.exports = { IST_OFFSET_MS, istDate, istMinutes, istClock, istAt, isTradingDayIST, hhmm, num, readJson, writeJson, dataRoot, usDst, closeMinOf, closeMsOf, isDatasetCall };
