// ─── symbolCheck.js ─────────────────────────────────────────────────────────
// Boot-time Fyers symbol validation — project-plan Section 8, item 9.
//
// Runs once, very early in boot (see server.js — step 2, right after the
// boot banner, before startAutoRefresh/watchdog/initialRestFetch/tick
// stream/scanner/wireDbJobs).
//
// SPOT ONLY (index + equity) — 2026-08-09, user's explicit scope narrowing.
// Futures are deliberately NOT checked here any more: a real boot log
// showed the batched-with-no-delay futures check itself getting rate
// limited by Fyers partway through (everything from ~"J" onward in the
// alphabetically-loaded equity-futures list failed as one solid block —
// the signature of a rate limit, not 318 individually-invalid symbols).
// Rather than just fixing the pacing and keeping futures in scope, the
// user's call was to drop futures from this checker entirely: spot symbols
// have no expiry protecting them if Fyers renames one, so they're the ones
// that actually need this defensive check; futures/options are derived
// from spot and will surface naturally through Staleness/GapFill/Validator
// if something's wrong with them.
//
// Commodities are correctly never in scope here — they were never spot to
// begin with (curated as type:"future"/"commodity" only, see
// symbolsRouter.js's buildFutures()), so filtering to type:"index"/"equity"
// already excludes them without any separate exclusion logic needed.
//
// Options are never checked here either — user's earlier call: options
// move constantly and aren't meaningfully "valid/invalid" the same way a
// root symbol is.
//
// Any symbol that fails is handed to fyers/client.js's setExcludedSymbols(),
// which makes fetchCandles()/fetchOptionChain() refuse to call Fyers for it
// again for the rest of this process — so Staleness/GapFill/Validator/
// initial fetch/auto-refresh all stop wasting API calls on it automatically.
//
// Log format, per user's explicit spec: passes are NOT logged individually
// (would be 200+ lines of noise) — only totals, plus which symbols failed.
//
// FIX 2026-08-17: SymbolCheck used to run unconditionally at boot, with no
// token check first. If the Fyers token was expired, validateSymbols()
// failed all 208 symbols in one shot, and setExcludedSymbols() permanently
// added every one of them to fyers/client.js's in-memory exclusion Set —
// which is only ever added to, never cleared, and nothing re-runs
// SymbolCheck after a successful re-auth. So one expired token at boot
// silently blacklisted every spot symbol (Staleness/GapFill/Recovery/
// auto-refresh all started skipping them with "excluded (failed boot-time
// symbol validation)") for the rest of that process's life — the only fix
// was a full restart. waitForValidToken() below closes that gap: server.js
// now calls it BEFORE runSymbolCheck(), so SymbolCheck simply doesn't run
// (and can't mass-exclude anything) until the token is actually valid.
// Meanwhile the HTTP server is already listening (routes mounted before
// server.listen() in server.js), so chart/API requests keep being served
// DB-first the whole time this is waiting — nothing else is blocked.

const symbolsRouter = require("../routes/symbolsRouter");
const { validateSymbols, setExcludedSymbols } = require("../fyers/client");
const state = require("./state");

// Polls state.validateToken() (already throttled/cached 60s in state.js,
// and bust-able via bustTokenCache() — see chartRouter.js's /api/auth
// callback, which calls bustTokenCache() right after a token is saved) so
// this resolves the moment a fresh token is generated, without hammering
// Fyers. Logs once immediately, then a low-frequency reminder, so a long
// wait for manual re-auth doesn't spam the log.
const POLL_INTERVAL_MS = 5000;
const REMINDER_EVERY_N_POLLS = 12; // ~60s at the 5s interval above

async function waitForValidToken() {
  let attempt = 0;
  for (; ;) {
    const valid = await state.validateToken().catch(() => false);
    if (valid) {
      if (attempt > 0) console.log("[SymbolCheck] Fyers token now valid — proceeding.");
      return;
    }
    if (attempt === 0) {
      console.log("[SymbolCheck] Fyers token invalid/expired — waiting for a valid token before validating symbols (generate one at /api/auth/url). Chart/API requests still work from the DB in the meantime.");
    } else if (attempt % REMINDER_EVERY_N_POLLS === 0) {
      console.log("[SymbolCheck] Still waiting for a valid Fyers token...");
    }
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function runSymbolCheck() {
  const all = symbolsRouter.getSymbols();

  const spotSymbols = all
    .filter((s) => s.type === "index" || s.type === "equity")
    .map((s) => s.symbol);

  console.log(`[SymbolCheck] Validating ${spotSymbols.length} spot symbols against Fyers...`);

  const result = await validateSymbols(spotSymbols);
  setExcludedSymbols(result.failed.map((f) => f.symbol));

  console.log(`[SymbolCheck] ${result.passed.length}/${spotSymbols.length} passed — Spot failed: ${result.failed.length}`);
  if (result.failed.length > 0) {
    console.log(`[SymbolCheck] Spot FAILED: ${result.failed.map((f) => f.symbol).join(", ")}`);
  }

  return {
    totalChecked: spotSymbols.length,
    totalPassed: result.passed.length,
    spotFailed: result.failed,
  };
}

module.exports = { runSymbolCheck, waitForValidToken };