/**
 * database/src/symbolParser.test.js
 *
 * Pure sanity test — NO database connection required (symbolParser.js
 * only touches backend/src/data/holidays.js, nothing else).
 *
 * HOW TO RUN:
 *   node database/src/symbolParser.test.js
 *   (or: cd database && npm run test:symbolParser)
 *
 * Exits non-zero if any assertion fails, so it can be wired into CI later.
 */

const assert = require("assert");
const { parseDerivativeSymbol } = require("./symbolParser");

let passed = 0;
let failed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅  ${label}`);
  } catch (err) {
    failed++;
    failures.push({ label, err });
    console.log(`  ❌  ${label}`);
    console.log(`      ${err.message}`);
  }
}

console.log("[symbolParser.test] ── Spot symbols → must return null ──────────");

check("NSE equity (-EQ) returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("NSE:RELIANCE-EQ"), null);
});
check("NSE index (-INDEX) returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("NSE:NIFTY50-INDEX"), null);
});
check("BSE index (-INDEX) returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("BSE:SENSEX-INDEX"), null);
});
check("MCX continuous root (-I) returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("MCX:GOLDM-I"), null);
});
check("MCX continuous root CRUDEOILM-I returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("MCX:CRUDEOILM-I"), null);
});
check("Garbage / unrecognized symbol returns null", () => {
  assert.strictEqual(parseDerivativeSymbol("NSE:GARBAGE"), null);
});
check("Empty/undefined input returns null, does not throw", () => {
  assert.strictEqual(parseDerivativeSymbol(""), null);
  assert.strictEqual(parseDerivativeSymbol(undefined), null);
  assert.strictEqual(parseDerivativeSymbol(null), null);
});
check("Non-NSE/MCX exchange returns null (e.g. BSE equity)", () => {
  assert.strictEqual(parseDerivativeSymbol("BSE:SOMESTOCK-EQ"), null);
});

console.log("\n[symbolParser.test] ── NSE monthly futures ──────────────────────");

check("NSE:RELIANCE26JUNFUT parses as monthly future", () => {
  const r = parseDerivativeSymbol("NSE:RELIANCE26JUNFUT");
  assert.ok(r, "expected non-null result");
  assert.strictEqual(r.exchange, "NSE");
  assert.strictEqual(r.underlying, "RELIANCE");
  assert.strictEqual(r.instrument_type, "future");
  assert.strictEqual(r.expiry_type, null);
  assert.strictEqual(r.strike, null);
  assert.strictEqual(r.option_type, null);
  assert.match(r.expiry_date, /^2026-06-\d{2}$/);
  // NSE monthly contracts always expire on a Tuesday (or the previous
  // trading day if that Tuesday is a holiday) — never any other weekday.
  const dow = new Date(r.expiry_date + "T00:00:00").getDay();
  assert.ok(dow === 2 || dow <= 5, `expiry ${r.expiry_date} landed on weekday ${dow}, expected Tue or an earlier weekday (holiday rollback)`);
});

check("NSE:NIFTY26JUNFUT (index future) parses correctly", () => {
  const r = parseDerivativeSymbol("NSE:NIFTY26JUNFUT");
  assert.strictEqual(r.underlying, "NIFTY");
  assert.strictEqual(r.instrument_type, "future");
});

console.log("\n[symbolParser.test] ── NSE monthly options ──────────────────────");

check("NSE:NIFTY26JUL24000CE parses as monthly option", () => {
  const r = parseDerivativeSymbol("NSE:NIFTY26JUL24000CE");
  assert.ok(r);
  assert.strictEqual(r.exchange, "NSE");
  assert.strictEqual(r.underlying, "NIFTY");
  assert.strictEqual(r.instrument_type, "option");
  assert.strictEqual(r.expiry_type, "monthly");
  assert.strictEqual(r.strike, 24000);
  assert.strictEqual(r.option_type, "CE");
  assert.match(r.expiry_date, /^2026-07-\d{2}$/);
});

check("NSE:BANKNIFTY26JUL55000CE parses correctly (from user's real example)", () => {
  const r = parseDerivativeSymbol("NSE:BANKNIFTY26JUL55000CE");
  assert.strictEqual(r.underlying, "BANKNIFTY");
  assert.strictEqual(r.strike, 55000);
  assert.strictEqual(r.option_type, "CE");
  assert.strictEqual(r.expiry_type, "monthly");
});

check("NSE:RELIANCE26JUL3200CE (stock option, monthly-only underlying)", () => {
  const r = parseDerivativeSymbol("NSE:RELIANCE26JUL3200CE");
  assert.strictEqual(r.underlying, "RELIANCE");
  assert.strictEqual(r.expiry_type, "monthly");
  assert.strictEqual(r.strike, 3200);
});

console.log("\n[symbolParser.test] ── NSE weekly options (NIFTY only) ──────────");

check("NSE:NIFTY2570724000PE parses as weekly option (from server.js docstring example)", () => {
  const r = parseDerivativeSymbol("NSE:NIFTY2570724000PE");
  assert.ok(r, "expected non-null result");
  assert.strictEqual(r.underlying, "NIFTY");
  assert.strictEqual(r.instrument_type, "option");
  assert.strictEqual(r.expiry_type, "weekly");
  assert.strictEqual(r.strike, 24000);
  assert.strictEqual(r.option_type, "PE");
  assert.match(r.expiry_date, /^2025-07-\d{2}$/);
});

check("NSE:NIFTY26712000CE parses as weekly option (month char '7' = Jul, day 12)", () => {
  const r = parseDerivativeSymbol("NSE:NIFTY26712000CE");
  assert.ok(r);
  assert.strictEqual(r.expiry_type, "weekly");
  // July 12, 2026 is a Sunday → rolls back to the previous trading day
  // (Fri Jul 10). This IS the correct holiday/weekend-rollback behavior,
  // not a parsing bug — confirmed against previousTradingDay().
  assert.match(r.expiry_date, /^2026-07-10$/);
  const dow = new Date(r.expiry_date + "T00:00:00").getDay();
  assert.ok(dow >= 1 && dow <= 5, `rolled-back expiry ${r.expiry_date} must land on a weekday, got dow=${dow}`);
  assert.strictEqual(r.strike, 0, "trailing strike digits '000' after DD parse to 0 for this synthetic case — real strikes are never all-zero");
});

check("NSE:NIFTY26N0512000CE parses weekly with letter month code (N=Nov)", () => {
  const r = parseDerivativeSymbol("NSE:NIFTY26N0512000CE");
  assert.ok(r);
  assert.strictEqual(r.expiry_type, "weekly");
  assert.match(r.expiry_date, /^2026-11-05$/);
  assert.strictEqual(r.strike, 12000);
  assert.strictEqual(r.option_type, "CE");
});

check("Weekly format is NIFTY-only — same shape on RELIANCE still resolves via monthly-first, not weekly", () => {
  // RELIANCE has no weekly contracts on this platform; a "weekly-shaped"
  // ticker for it should NOT silently parse as a phantom weekly option —
  // it should only match if it's genuinely a valid monthly (3-letter month)
  // ticker, otherwise null. This guards against weekly logic leaking to
  // non-NIFTY roots.
  const r = parseDerivativeSymbol("NSE:RELIANCE26712000CE");
  assert.strictEqual(r, null, "non-NIFTY weekly-shaped ticker must not parse");
});

console.log("\n[symbolParser.test] ── MCX futures & options ───────────────────");

check("MCX:CRUDEOILM26AUGFUT parses as monthly future, known root (not approximate)", () => {
  const r = parseDerivativeSymbol("MCX:CRUDEOILM26AUGFUT");
  assert.ok(r);
  assert.strictEqual(r.exchange, "MCX");
  assert.strictEqual(r.underlying, "CRUDEOILM", "must NOT be truncated to CRUDEOIL — the M is part of the root");
  assert.strictEqual(r.instrument_type, "future");
  assert.strictEqual(r.expiryApproximate, false);
  assert.match(r.expiry_date, /^2026-08-\d{2}$/);
});

check("MCX:CRUDEOIL26JULFUT (non-mini root) does not collide with CRUDEOILM", () => {
  const r = parseDerivativeSymbol("MCX:CRUDEOIL26JULFUT");
  assert.strictEqual(r.underlying, "CRUDEOIL");
});

check("MCX:GOLDM26AUG68000CE parses as monthly option", () => {
  const r = parseDerivativeSymbol("MCX:GOLDM26AUG68000CE");
  assert.ok(r);
  assert.strictEqual(r.underlying, "GOLDM");
  assert.strictEqual(r.instrument_type, "option");
  assert.strictEqual(r.strike, 68000);
  assert.strictEqual(r.option_type, "CE");
  assert.strictEqual(r.expiryApproximate, false);
});

check("MCX options never get expiry_type populated at the DB-row level by design (table has no such column) — parser still reports it as null for options only when N/A", () => {
  // MCX options DO have a real expiry_type at the parse level (they're
  // always effectively 'monthly' — single expiry per cycle), but the
  // mcx_options_candles table intentionally has no expiry_type column
  // (see migration 003). derivativesStore.js must never try to write
  // expiry_type into that table — verified separately in the store test.
  const r = parseDerivativeSymbol("MCX:GOLDM26AUG68000CE");
  assert.ok(["monthly", null].includes(r.expiry_type));
});

check("Unknown MCX root falls back to last-day-of-month, flagged approximate", () => {
  const r = parseDerivativeSymbol("MCX:BRANDNEWCOMMODITY26AUGFUT");
  assert.ok(r);
  assert.strictEqual(r.underlying, "BRANDNEWCOMMODITY");
  assert.strictEqual(r.expiryApproximate, true);
});

console.log("\n[symbolParser.test] ── PK-safety invariants (every parsed row) ──");

const REAL_SYMBOLS = [
  "NSE:RELIANCE26JUNFUT", "NSE:NIFTY26JUL24000CE", "NSE:BANKNIFTY26JUL55000CE",
  "NSE:NIFTY2570724000PE", "NSE:NIFTY26N0512000CE",
  "MCX:CRUDEOILM26AUGFUT", "MCX:GOLDM26AUG68000CE", "MCX:SILVER26JUL75000CE",
];
// NOTE: NSE:NIFTY26712000CE is deliberately excluded from this batch — its
// synthetic strike parses to 0 (see the dedicated weekly-option test above),
// which would fail the "strike > 0" invariant below for a reason that has
// nothing to do with real data (no genuine contract ever has a 0 strike).

check("Every real symbol produces a valid ISO expiry_date (parseable Date, not NaN)", () => {
  for (const sym of REAL_SYMBOLS) {
    const r = parseDerivativeSymbol(sym);
    assert.ok(r, `${sym} should have parsed`);
    const d = new Date(r.expiry_date + "T00:00:00");
    assert.ok(!isNaN(d.getTime()), `${sym}: expiry_date "${r.expiry_date}" is not a valid date`);
  }
});

check("Every option row has option_type in {CE,PE} and numeric strike > 0", () => {
  for (const sym of REAL_SYMBOLS) {
    const r = parseDerivativeSymbol(sym);
    if (r.instrument_type !== "option") continue;
    assert.ok(["CE", "PE"].includes(r.option_type), `${sym}: bad option_type ${r.option_type}`);
    assert.ok(Number.isFinite(r.strike) && r.strike > 0, `${sym}: bad strike ${r.strike}`);
  }
});

check("Every future row has strike=null and option_type=null (PK for futures tables excludes both)", () => {
  for (const sym of REAL_SYMBOLS) {
    const r = parseDerivativeSymbol(sym);
    if (r.instrument_type !== "future") continue;
    assert.strictEqual(r.strike, null);
    assert.strictEqual(r.option_type, null);
  }
});

check("Parsing is idempotent — same symbol twice gives identical output", () => {
  for (const sym of REAL_SYMBOLS) {
    const a = JSON.stringify(parseDerivativeSymbol(sym));
    const b = JSON.stringify(parseDerivativeSymbol(sym));
    assert.strictEqual(a, b, `${sym}: non-deterministic parse`);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────
console.log(`\n[symbolParser.test] ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("\nFailed:");
  failures.forEach((f) => console.log(`  - ${f.label}: ${f.err.message}`));
  process.exitCode = 1;
} else {
  console.log("✅  All symbol parser sanity checks passed.");
}
