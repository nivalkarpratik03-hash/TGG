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
            if (valid || issues.length === 0) { clean++; return; }

            // ── 2026-10-02 REWRITE of the repair decision ──────────────────
            // The old code did `issues.find(GAP|CORRUPT)` — only the FIRST
            // (chronologically oldest, inside a 90-day window) issue — and
            // then `return`ed from this symbol on every skip path
            // ("today", "already repaired recently"). Consequences:
            //   • one old hole the broker can never fill (so it is flagged
            //     on every pass) permanently shadowed every LATER hole —
            //     e.g. SENSEX 24 Sep was never reached;
            //   • at most ONE day per symbol per pass was ever repaired;
            //   • that one day was repaired with delete-and-replace using a
            //     30-day fetch, which for a day older than 30 days wiped it.
            // Now: every gap day is considered, known-short days are skipped
            // PER DAY (they no longer stop the loop), and all remaining days
            // are filled together with ONE additive broker call.
            const gapDays = state.db.summarizeGaps(issues.filter((iss) => iss.type === "GAP" || iss.type === "MISSING_DAY"));
            const corruptDays = [...new Set(
              issues.filter((iss) => iss.type === "CORRUPT_OHLC" && iss.time)
                .map((iss) => new Date(iss.time + 5.5 * 3600 * 1000).toISOString().slice(0, 10))
            )];
            // 2026-10-07: ZERO_VOLUME is a real issue type now (validationEngine
            // findZeroVolumeDays) — handled by healVolumeDays below.
            const zeroVolDays = state.db.zeroVolumeDaysOf(issues);
            if (gapDays.length === 0 && corruptDays.length === 0 && zeroVolDays.length === 0) { clean++; return; }

            const MAX_DAYS_PER_PASS = 10; // newest first — recent holes matter most; the rest are picked up next pass
            const toFill = [];
            let knownSkipped = 0;
            for (const g of gapDays) {
              if (toFill.length >= MAX_DAYS_PER_PASS) break;
              const dayDate = new Date(`${g.day}T12:00:00+05:30`);
              const already = await state.db.wasDayAlreadyRepaired(symbol, dayDate, 3).catch(() => false);
              if (already) { knownSkipped++; vlog(`[Recovery] ${symbol}: ${g.day} already gap-filled in the last 3 days and still flagged — broker has no data for it, skipping this day only`); continue; }
              toFill.push(g.day);
            }

            let didWork = false;
            if (toFill.length > 0) {
              vlog(`[Recovery] ${symbol}: ${gapDays.length} gap day(s), filling ${toFill.length}: ${toFill.join(", ")}`);
              const r = await state.recoveryEngine.fillGapDays({
                symbol,
                days: toFill,
                // pass ALL args through — the old (sym, res) closure silently
                // dropped the lookback argument
                fetchCandles: (sym, res, count, lookback) => fetchCandles(sym, res, count, lookback),
                trigger,
              });
              if (r && r.success) didWork = true;
              else if (r && r.skipped) vlog(`[Recovery] ${symbol}: another repair is already running — will retry next pass`);
            }

            for (const day of corruptDays) {
              const alreadyRepaired = await state.db.wasDayAlreadyRepaired(symbol, new Date(`${day}T12:00:00+05:30`), 3).catch(() => false);
              if (alreadyRepaired) { knownSkipped++; continue; }
              await state.recoveryEngine.repairDay({
                symbol,
                tradingDay: new Date(`${day}T12:00:00+05:30`),
                fetchCandles: (sym, res, count, lookback) => fetchCandles(sym, res, count, lookback),
                trigger,
              });
              didWork = true;
            }

            // ── Zero-volume heal (additive: only writes real broker volume) ──
            // Runs AFTER gap fill / OHLC repair so a repaired day (which already
            // brings broker volume with it) is not asked about twice. A day the
            // broker already confirmed it has no volume for is skipped: today
            // for 20 min only (its rows keep arriving), past days for 3 days.
            if (zeroVolDays.length > 0) {
              const todayKey = state.db.istDateKey(Date.now());
              const stillZero = state.db.findZeroVolumeDays(
                symbol,
                await state.db.loadCandles(symbol, 1, { limit: 100000, from: new Date(Date.now() - 90 * 86400 * 1000).toISOString(), to: new Date().toISOString() })
              );
              const stillZeroDays = new Set(stillZero.map((z) => z.day));
              const toHeal = [];
              for (const day of zeroVolDays) {
                if (toHeal.length >= 10) break;
                if (!stillZeroDays.has(day)) continue; // already fixed by the repair above
                const mins = day === todayKey ? 20 : 3 * 24 * 60;
                const attempted = await state.db.wasVolumeHealAttempted(symbol, new Date(`${day}T12:00:00+05:30`), mins).catch(() => false);
                if (attempted) { knownSkipped++; continue; }
                toHeal.push(day);
              }
              if (toHeal.length > 0) {
                const r = await state.recoveryEngine.healVolumeDays({
                  symbol,
                  days: toHeal,
                  fetchCandles: (sym, res, count, lookback) => fetchCandles(sym, res, count, lookback),
                  trigger: `volume_heal:${trigger}`,
                });
                if (r && r.success) didWork = true;
                else if (r && r.skipped) vlog(`[Recovery] ${symbol}: another repair is already running — volume heal retried next pass`);
              }
            }

            if (didWork) repaired++;
            else if (knownSkipped > 0) skippedKnown++;
            else clean++;
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