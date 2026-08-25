// ─── catchUp.js ─────────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k. Restructured 2026-08-06 (items 2, 3, 4, 6 of the ongoing
// cleanup plan, Section 4l) — see the two functions below for what changed
// and why; the short version is documented in TGG-project-plan.md's
// "Correct flow" note, kept in sync with this file.
//
// This file used to hold ONE function (runCuratedSymbolCatchUp) that did
// Validator+Recovery immediately followed by a staleness sweep, both over
// the same curated 205-symbol spot-only list, fired once at boot (or once
// on token re-auth). It's now TWO separate, independently-callable
// functions:
//
//   sweepCuratedStaleness(trigger) — spot-only (equity + index; commodities
//     have no spot symbol, see curatedUnderlyingsLoader.js — they're
//     covered by GapFill's futures instead, never by this sweep). Sources
//     its symbol list from root (symbols/index.json + symbols/equity.json)
//     via curatedUnderlyingsLoader.js, unchanged from before. Delegates
//     the actual sweep loop to dataFetch.js's new sweepStalenessForSymbols()
//     (item 3 — that used to be an inline loop right here).
//
//   runValidatorRecovery(trigger) — Validator+Recovery, EXPANDED scope
//     (item 2): no longer limited to the curated spot list. Sources its
//     symbol list from state.db.getAllTrackedSymbols() — i.e. whatever is
//     ACTUALLY IN THE DATABASE right now (spot candles table + all 6
//     derivatives tables), not a fixed curated file. This deliberately
//     does not take GapFill's returned discoveredSymbols as an input —
//     see validationEngine.js's getAllTrackedSymbols() for why.
//
// Neither function calls the other, and neither calls GapFill — the actual
// Staleness → GapFill → Validator → Recovery ORDER (item 6) and the 3x/day
// SCHEDULE (item 4) both now live in gapFillScheduler.js's fire(), which
// calls all three of these functions in sequence under its existing
// once-per-day-per-checkpoint gate. This file no longer owns any ordering
// or scheduling decision — it only knows how to run each of its two pieces
// once, given a trigger label, exactly as before.
const { fetchCandles } = require("../fyers/client");
const { loadIndexSpotSymbols, loadStockSpotSymbols } = require("../derivatives/curatedUnderlyingsLoader");
const state = require("./state");
const { vlog } = require("../utils/verboseLog");

// Same IST-offset arithmetic already used in fyers/tickStream.js's nowIST()
// and derivatives/gapFillScheduler.js's istDateString() — reused here, not
// reinvented, just extended to a full readable timestamp instead of only
// hours/minutes or only a date. Explicit "+05:30" suffix (not "Z") so this
// never gets misread as UTC — this project runs for an IST-only market, so
// every completion log should read in IST, not the server's local/UTC time.
function nowISTTimestamp() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const y = ist.getUTCFullYear();
  const mo = pad(ist.getUTCMonth() + 1);
  const day = pad(ist.getUTCDate());
  const h = pad(ist.getUTCHours());
  const mi = pad(ist.getUTCMinutes());
  const s = pad(ist.getUTCSeconds());
  const ms = pad(ist.getUTCMilliseconds(), 3);
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${ms}+05:30`;
}

function createCatchUp({ dataFetch }) {
  // Two independent in-flight guards — sweepCuratedStaleness and
  // runValidatorRecovery can now be called separately (by
  // gapFillScheduler.js's fire(), in sequence, but as two distinct calls)
  // so each needs its own guard rather than one shared flag protecting
  // both at once, the way the single combined function used to.
  let _stalenessInFlight = false;
  let _validatorInFlight = false;

  // ── Staleness sweep — spot-only, root-sourced ──────────────────────────
  async function sweepCuratedStaleness(trigger = "startup") {
    if (!state.dbEnabled || !state.db) return;

    if (_stalenessInFlight) {
      console.log(`[Staleness] Sweep already running — skipping duplicate ${trigger} trigger`);
      return;
    }
    _stalenessInFlight = true;

    try {
      let curatedSymbols = [];
      try {
        const indexSpot = loadIndexSpotSymbols();
        const stockSpot = loadStockSpotSymbols();
        curatedSymbols = [...indexSpot, ...stockSpot].map((s) => s.symbol).filter(Boolean);
      } catch (e) {
        console.warn("[Staleness] Could not load symbols/index.json + symbols/equity.json for sweep:", e.message);
        return;
      }

      if (trigger === "startup") {
        // Wait for initialRestFetch to finish (it runs right before the boot call)
        await new Promise((r) => setTimeout(r, 5000));
      }

      const tokenOk = await state.validateToken().catch(() => false);
      if (!tokenOk) {
        console.log(`[Staleness] ${trigger}: skipped — token invalid. Will run after re-auth.`);
        return;
      }

      const startTime = new Date().toISOString();
      console.log(`[Staleness] ${trigger}: started ${startTime}`);
      const r = await dataFetch.sweepStalenessForSymbols(curatedSymbols, trigger);
      const endTime = new Date().toISOString();
      const upToDate = r.checked - r.backfilled - (r.failed?.length || 0);
      const failedStr = r.failed && r.failed.length > 0 ? `, FAILED ${r.failed.length} (${r.failed.slice(0, 5).join(", ")}${r.failed.length > 5 ? "..." : ""})` : "";
      const statusStr = r.backfilled === 0 && upToDate === r.checked
        ? `all ${r.checked} symbols up to date`
        : `${r.backfilled} backfilled, ${upToDate} up to date`;
      console.log(`[Staleness] ${trigger}: ended ${endTime} — ${statusStr}${failedStr}`);
    } finally {
      _stalenessInFlight = false;
    }
  }

  // ── Validator + Recovery — expanded scope, DB-sourced ──────────────────
  async function runValidatorRecovery(trigger = "startup") {
    if (!state.recoveryEngine || !state.dbEnabled || !state.db) return;

    if (_validatorInFlight) {
      console.log(`[Recovery] Validator/Recovery already running — skipping duplicate ${trigger} trigger`);
      return;
    }
    _validatorInFlight = true;

    try {
      let trackedSymbols = [];
      try {
        trackedSymbols = await state.db.getAllTrackedSymbols();
      } catch (e) {
        console.warn("[Recovery] Could not load tracked symbols from DB for validator/recovery scan:", e.message);
        return;
      }

      const tokenOk = await state.validateToken().catch(() => false);
      if (!tokenOk) {
        console.log(`[Recovery] Validator/Recovery (${trigger}): skipped — token invalid. Will repair after re-auth.`);
        return;
      }

      const startTime = new Date().toISOString();
      console.log(`[Recovery] Validator/Recovery (${trigger}): started ${startTime} — checking tracked symbols...`);
      let repaired = 0;
      let clean = 0;
      let skippedKnown = 0;
      const CONCURRENCY = 3;
      const BATCH_DELAY_MS = 1000;

      for (let i = 0; i < trackedSymbols.length; i += CONCURRENCY) {
        const batch = trackedSymbols.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (symbol) => {
          try {
            const { valid, issues } = await state.db.validateHistorical(symbol, 1);
            if (!valid && issues.length > 0) {
              const gapIssue = issues.find((iss) => iss.type === "GAP" || iss.type === "CORRUPT_OHLC");
              if (gapIssue) {
                const tradingDay = new Date(gapIssue.time || Date.now());
                const todayStr = new Date().toISOString().slice(0, 10);
                if (tradingDay.toISOString().slice(0, 10) >= todayStr) {
                  vlog(`[Recovery] ${symbol}: skipping today's in-progress candles (not a real gap)`);
                  clean++;
                  return;
                }

                const alreadyRepaired = await state.db.wasDayAlreadyRepaired(symbol, tradingDay, 3).catch(() => false);
                if (alreadyRepaired) {
                  vlog(`[Recovery] ${symbol}: ${tradingDay.toISOString().slice(0, 10)} already repaired recently and still flagged — likely a genuine short broker day, skipping re-repair`);
                  skippedKnown++;
                  return;
                }

                vlog(`[Recovery] ${symbol}: ${issues.length} issue(s) — repairing gap at ${tradingDay.toISOString().slice(0, 10)}`); await state.recoveryEngine.repairDay({
                  symbol,
                  tradingDay,
                  fetchCandles: (sym, res) => fetchCandles(sym, res),
                  trigger,
                });
                repaired++;
              }
            } else {
              clean++;
            }
          } catch (e) {
            console.warn(`[Recovery] ${symbol} scan error:`, e.message);
          }
        }));
        if (i + CONCURRENCY < trackedSymbols.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }
      console.log(`[Recovery] Validator/Recovery (${trigger}) complete — ${clean} clean, ${repaired} repaired, ${skippedKnown} skipped (known short day) out of ${trackedSymbols.length} tracked symbols — at ${nowISTTimestamp()}`);
    } finally {
      _validatorInFlight = false;
    }
  }

  return { sweepCuratedStaleness, runValidatorRecovery };
}

module.exports = createCatchUp;