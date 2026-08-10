// ─── symbolCheck.js ─────────────────────────────────────────────────────────
// Boot-time Fyers symbol validation — project-plan Section 8, item 9.
//
// Runs once, very early in boot (see server.js — step 2, right after the
// boot banner, before startAutoRefresh/watchdog/initialRestFetch/tick
// stream/scanner/wireDbJobs). Every SPOT (index + equity) and FUTURES
// (future + commodity) symbol in the curated universe is checked against
// Fyers via a real Quotes API call, in batches. Options are never checked
// here — user's explicit call: options move constantly and aren't
// meaningfully "valid/invalid" the same way a root symbol is.
//
// Any symbol that fails is handed to fyers/client.js's setExcludedSymbols(),
// which makes fetchCandles()/fetchOptionChain() refuse to call Fyers for it
// again for the rest of this process — so Staleness/GapFill/Validator/
// initial fetch/auto-refresh all stop wasting API calls on it automatically,
// without each of those modules needing its own separate check.
//
// Log format, per user's explicit spec: passes are NOT logged individually
// (would be 200+ lines of noise) — only totals, plus which symbols failed.

const symbolsRouter = require("../routes/symbolsRouter");
const { validateSymbols, setExcludedSymbols } = require("../fyers/client");

async function runSymbolCheck() {
  const all = symbolsRouter.getSymbols();

  const spotSymbols = all
    .filter((s) => s.type === "index" || s.type === "equity")
    .map((s) => s.symbol);
  const futSymbols = all
    .filter((s) => s.type === "future" || s.type === "commodity")
    .map((s) => s.symbol);

  console.log(`[SymbolCheck] Validating ${spotSymbols.length} spot + ${futSymbols.length} futures symbols against Fyers...`);

  const [spotResult, futResult] = await Promise.all([
    validateSymbols(spotSymbols),
    validateSymbols(futSymbols),
  ]);

  const allFailed = [...spotResult.failed, ...futResult.failed];
  setExcludedSymbols(allFailed.map((f) => f.symbol));

  const totalChecked = spotSymbols.length + futSymbols.length;
  const totalPassed = spotResult.passed.length + futResult.passed.length;

  console.log(`[SymbolCheck] ${totalPassed}/${totalChecked} passed — Spot failed: ${spotResult.failed.length}, Futures failed: ${futResult.failed.length}`);
  if (spotResult.failed.length > 0) {
    console.log(`[SymbolCheck] Spot FAILED: ${spotResult.failed.map((f) => f.symbol).join(", ")}`);
  }
  if (futResult.failed.length > 0) {
    console.log(`[SymbolCheck] Futures FAILED: ${futResult.failed.map((f) => f.symbol).join(", ")}`);
  }

  return {
    totalChecked, totalPassed,
    spotFailed: spotResult.failed,
    futFailed: futResult.failed,
  };
}

module.exports = { runSymbolCheck };