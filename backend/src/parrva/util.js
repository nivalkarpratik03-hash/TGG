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

/** Root folder for everything the live PaRRVA report stores (recordings, history, results). */
function dataRoot() {
  return process.env.PARRVA_DATA_DIR
    ? path.resolve(process.env.PARRVA_DATA_DIR)
    : path.resolve(__dirname, "../../parrva_data");
}

module.exports = { IST_OFFSET_MS, istDate, istMinutes, istClock, istAt, isTradingDayIST, hhmm, num, readJson, writeJson, dataRoot };
