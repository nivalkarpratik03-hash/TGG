/**
 * backend/src/driveExport/driveShared.js
 * Shared helpers for the daily-options -> Drive TEST scripts
 * (driveLiveCapture.js, driveBuildMinuteCsv.js). Pure functions where
 * possible so they can be unit-tested without Fyers or a database.
 * Does not touch the existing archive/prune code.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { parseDerivativeSymbol } = require("../../../database/src/parsing/symbolParser");

const ROOTS_FILE = path.resolve(__dirname, "../../../symbols/drive-export-roots.json");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadDriveRoots() {
  const j = JSON.parse(fs.readFileSync(ROOTS_FILE, "utf8"));
  const roots = j.roots || [];
  for (const r of roots) {
    if (!r.name || !r.exchange || !Array.isArray(r.cycles) || !r.cycles.length) {
      throw new Error(`drive-export-roots.json: bad entry ${JSON.stringify(r)}`);
    }
  }
  return roots;
}

// ── time ─────────────────────────────────────────────────────────────────────
function istDate(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }
function istTime(ms, withMs = false) {
  const s = new Date(ms + IST_OFFSET_MS).toISOString();
  return s.slice(11, withMs ? 23 : 19);
}
function istStamp(ms, withMs = false) { return `${istDate(ms)} ${istTime(ms, withMs)}`; }
function istMinutesOfDay(ms) { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function istWeekday(ms) { return new Date(ms + IST_OFFSET_MS).getUTCDay(); } // 0 Sun .. 6 Sat
/** "DD-MM-YYYY" -> "YYYY-MM-DD" (Fyers chain date format -> ISO). */
function dmyToIso(s) { const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s); }

// ── csv ──────────────────────────────────────────────────────────────────────
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Append-mode CSV writer; writes the header only when the file is new/empty. */
function makeCsvWriter(filepath, columns) {
  // Same header -> append (a same-day rerun continues the file). Different header -> the old file is
  // renamed so new columns are never written under an old header line.
  if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
    const first = fs.readFileSync(filepath, "utf8").split("\n", 1)[0].replace(/\r$/, "").replace(/^\uFEFF/, "");
    if (first !== columns.join(",")) fs.renameSync(filepath, `${filepath}.old-${Date.now()}`);
  }
  const isNew = !fs.existsSync(filepath) || fs.statSync(filepath).size === 0;
  const stream = fs.createWriteStream(filepath, { flags: "a", encoding: "utf8" });
  if (isNew) stream.write(columns.join(",") + "\n");
  return {
    row(obj) { stream.write(columns.map((c) => csvCell(obj[c])).join(",") + "\n"); },
    close() { return new Promise((res) => stream.end(res)); },
  };
}
/** Minimal CSV reader (handles quotes) -> array of objects. */
function readCsv(filepath) {
  const text = fs.readFileSync(filepath, "utf8").replace(/^\uFEFF/, "");
  const rows = []; let cur = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { cur.push(cell); cell = ""; }
    else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || cur.length) { cur.push(cell); rows.push(cur); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ── strikes / ATM window (same tie rule as services/bulkOptionFetch.js: tie -> lower strike) ──
function nearestStrikeIndex(sortedStrikes, price) {
  let lo = 0, hi = sortedStrikes.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sortedStrikes[mid] <= price) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  if (i < 0) return 0;
  if (i === sortedStrikes.length - 1) return i;
  return (price - sortedStrikes[i]) <= (sortedStrikes[i + 1] - price) ? i : i + 1;
}
function uniqueSortedStrikes(strikes) { return [...new Set(strikes.map((s) => s.strike_price))].sort((a, b) => a - b); }
/** Strike prices within +-width positions of the ATM index (clipped to the list). */
function windowStrikes(sortedStrikes, atmIdx, width) {
  const out = [];
  for (let k = -width; k <= width; k++) { const j = atmIdx + k; if (j >= 0 && j < sortedStrikes.length) out.push(sortedStrikes[j]); }
  return out;
}

// ── expiry cycles ────────────────────────────────────────────────────────────
/**
 * Finds the nearest weekly and nearest monthly expiry by asking Fyers for each
 * live expiry's chain and classifying one real symbol with the project's own
 * parseDerivativeSymbol() - never by guessing from the date.
 * @param {Function} fetchOptionChain  fyers/client.js fetchOptionChain (injected for tests)
 * @returns {{weekly: object|null, monthly: object|null, table: object[]}}
 */
async function resolveCycles(fetchOptionChain, lookupSymbol, { maxProbe = 8, delayMs = 700 } = {}) {
  const probe = await fetchOptionChain(lookupSymbol, { strikeCount: 2 });
  if (!probe.expiries.length) throw new Error(`No live expiries returned for ${lookupSymbol} (token invalid, or no live contracts).`);
  const found = { weekly: null, monthly: null };
  const table = [];
  for (const e of probe.expiries.slice(0, maxProbe)) {
    const chain = await fetchOptionChain(lookupSymbol, { strikeCount: 2, timestamp: e.expiry });
    const sample = chain.strikes[0] && chain.strikes[0].symbol;
    const parsed = sample ? parseDerivativeSymbol(sample) : null;
    const type = parsed ? parsed.expiry_type : "unknown";
    table.push({
      chain_date: e.date, expiry_epoch: e.expiry, sample_symbol: sample || "", classified_as: type,
      parser_expiry_date: parsed ? parsed.expiry_date : "",
      dates_agree: parsed ? parsed.expiry_date === dmyToIso(e.date) : false,
    });
    if ((type === "weekly" || type === "monthly") && !found[type]) found[type] = { date: e.date, expiry: e.expiry, dateIso: dmyToIso(e.date) };
    if (found.weekly && found.monthly) break;
    await sleep(delayMs);
  }
  return { ...found, table };
}

// ── bid/ask change tracking ──────────────────────────────────────────────────
/**
 * Best-effort extraction of bid/ask from one websocket message. The key names
 * are NOT confirmed for this account yet - that is what the live test is for -
 * so several candidates are tried, and the raw message is always logged too.
 */
function extractQuote(t) {
  const pick = (...keys) => { for (const k of keys) if (t[k] !== undefined && t[k] !== null) return Number(t[k]); return undefined; };
  return {
    bid: pick("bid_price", "bid", "bp"),
    ask: pick("ask_price", "ask", "ap"),
    bidSize: pick("bid_size", "bs"),
    askSize: pick("ask_size", "as"),
  };
}
function makeQuoteTracker() {
  const state = new Map();
  return {
    state(symbol) { return state.get(symbol) || null; },
    /** Merges any defined fields; returns {changed, state}. Partial (changed-fields-only) updates are handled. */
    update(symbol, q) {
      const prev = state.get(symbol) || {};
      const next = { ...prev };
      let changed = false;
      for (const k of ["bid", "ask", "bidSize", "askSize"]) {
        if (q[k] !== undefined && !Number.isNaN(q[k])) { if (prev[k] !== q[k]) changed = true; next[k] = q[k]; }
      }
      state.set(symbol, next);
      return { changed, state: next };
    },
  };
}

// ── join quote changes onto minute rows ──────────────────────────────────────
/** quotesByKey: Map(key -> [{ms, bid, ask}] sorted by ms). Returns {count, last} for [minuteStartMs, +60s). */
function quotesForMinute(list, minuteStartMs) {
  if (!list || !list.length) return { count: 0, last: null };
  const end = minuteStartMs + 60000;
  let lo = 0, hi = list.length - 1, lastIdx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].ms < end) { lastIdx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (lastIdx < 0) return { count: 0, last: null };
  let first = lastIdx;
  while (first >= 0 && list[first].ms >= minuteStartMs) first--;
  return { count: lastIdx - first, last: list[lastIdx] }; // last = latest change at or before the end of this minute
}

module.exports = {
  loadDriveRoots, istDate, istTime, istStamp, istMinutesOfDay, istWeekday, dmyToIso,
  csvCell, makeCsvWriter, readCsv, nearestStrikeIndex, uniqueSortedStrikes, windowStrikes,
  resolveCycles, extractQuote, makeQuoteTracker, quotesForMinute, sleep, IST_OFFSET_MS,
};