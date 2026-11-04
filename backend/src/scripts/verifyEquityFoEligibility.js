/**
 * backend/src/scripts/verifyEquityFoEligibility.js
 * ─────────────────────────────────────────────────────────────────────────
 * One-time live verification of F&O eligibility for every equity in
 * symbols/equity.json, using real Fyers option-chain calls.
 *
 * This CHECKS ALL 202 equities, including the 9 already recorded in
 * symbols/equity-fo-exclusions.json -- no skipping. Those 9 (8 in
 * excluded[], 1 -- DALBHARAT -- in confirmedEligibleButPartiallyListed[])
 * were individually hand-verified live in the Fyers app already, so this
 * run treats them as a KNOWN-ANSWER TEST SET: if this script's live result
 * for one of those 9 disagrees with the already-confirmed answer, that is
 * treated as evidence the SCRIPT's method is wrong for that case -- not as
 * evidence the manual answer was wrong. Every one of the 9 gets an
 * explicit knownAnswerComparison entry (match or mismatch) in the output,
 * separate from the excluded[] list build.
 *
 * METHOD
 *   For each equity's own spot symbol (e.g. NSE:EXIDEIND-EQ), call
 *   fetchOptionChain() directly -- the same function derivativesGapFill.js
 *   and backtestOptionDataFetch.js already use. This queries Fyers'
 *   getOptionChain API against the real spot symbol itself.
 *
 *   - 0 real CE/PE strikes returned -> no listed F&O -> goes to excluded[].
 *   - 1+ real CE/PE strikes returned -> has F&O -> not excluded.
 *
 *   NOTE: this script does NOT attempt to separate "genuinely no F&O" from
 *   "F&O exists but this month's contract isn't listed yet" (the DALBHARAT
 *   case). fetchOptionChain() asks for whatever expiries Fyers currently
 *   has live -- if none are listed, that looks identical to "no F&O" from
 *   this script's point of view. That is exactly why DALBHARAT is left as
 *   a manual review item in knownAnswerComparison rather than auto-decided:
 *   a 0-strikes result for DALBHARAT today could mean either "still not
 *   listed" (expected, matches the known situation) or something else --
 *   this script cannot tell those apart, only a person reading the result
 *   can.
 *
 * USAGE
 *   node src/scripts/verifyEquityFoEligibility.js [--out <path>]
 *
 *   Requires a valid Fyers access token already connected via
 *   /admin in the frontend, exactly like every other script in backend/src.
 *
 * OUTPUT
 *   Writes a REPORT file (default: symbols/equity-fo-verification-report.json)
 *   -- does NOT overwrite symbols/equity-fo-exclusions.json automatically.
 *   Review knownAnswerComparison[] first; only apply the new excluded[]
 *   list to equity-fo-exclusions.json by hand once the comparison confirms
 *   the script's method is trustworthy.
 *
 * DELETE THIS FILE after the run + review -- one-time verification tool,
 * not wired into the server or any scheduler, same lifecycle as
 * backtestOptionDataFetch.js is for its own one-time use case.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { fetchOptionChain } = require("../fyers/client");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const EQUITY_JSON_PATH = path.resolve(__dirname, "../../../symbols/equity.json");
const EXCLUSIONS_JSON_PATH = path.resolve(__dirname, "../../../symbols/equity-fo-exclusions.json");
const DEFAULT_REPORT_PATH = path.resolve(__dirname, "../../../symbols/equity-fo-verification-report.json");

// Same spirit as backtestOptionDataFetch.js's CHAIN_POLITE_DELAY_MS --
// ~202 live calls back-to-back risk Fyers rate limits.
const CHAIN_POLITE_DELAY_MS = 500;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = (args[i] || "").replace(/^--/, "");
    out[key] = args[i + 1];
  }
  return out;
}

// Build the known-answer map from the EXISTING exclusions file: the 8
// hand-verified excluded[] entries (known answer = "no F&O") plus the 1
// confirmedEligibleButPartiallyListed[] entry (known answer = "has F&O,
// partial listing"). This script's live result for each of these 9 gets
// compared against this map -- used to sanity-check the script itself,
// not to decide the final excluded[] list for these 9.
function loadKnownAnswers() {
  try {
    const existing = JSON.parse(fs.readFileSync(EXCLUSIONS_JSON_PATH, "utf8"));
    const knownAnswers = new Map();
    for (const e of existing.excluded || []) {
      knownAnswers.set(e.underlying, { knownAnswer: "no_fo", knownReason: e.reason });
    }
    for (const e of existing.confirmedEligibleButPartiallyListed || []) {
      knownAnswers.set(e.underlying, { knownAnswer: "has_fo_partial_listing", knownReason: e.note });
    }
    return knownAnswers;
  } catch (err) {
    console.warn(`[verifyEquityFoEligibility] Could not read existing exclusions file (${err.message}) -- running with an empty known-answer set, no comparison will be possible.`);
    return new Map();
  }
}

async function main() {
  const args = parseArgs();
  const outPath = args.out ? path.resolve(args.out) : DEFAULT_REPORT_PATH;

  const { equities } = JSON.parse(fs.readFileSync(EQUITY_JSON_PATH, "utf8"));
  console.log(`[verifyEquityFoEligibility] Loaded ${equities.length} equities from symbols/equity.json. Checking ALL of them live against Fyers, including the 9 already recorded in equity-fo-exclusions.json...`);

  const knownAnswers = loadKnownAnswers();
  console.log(`[verifyEquityFoEligibility] Loaded ${knownAnswers.size} known answer(s) from the existing exclusions file for comparison.`);

  const excluded = [];
  const eligible = [];
  const errored = [];
  const knownAnswerComparison = [];

  for (let i = 0; i < equities.length; i++) {
    const eq = equities[i];
    const known = knownAnswers.get(eq.name);

    try {
      const { strikes } = await fetchOptionChain(eq.symbol);
      const liveResult = strikes.length === 0 ? "no_fo" : "has_fo";

      if (strikes.length === 0) {
        excluded.push({
          underlying: eq.name,
          reason: `Fyers option chain: 0 real CE/PE strikes returned for ${eq.symbol} (checked ${new Date().toISOString().slice(0, 10)}).`,
        });
      } else {
        eligible.push(eq.name);
      }

      if (known) {
        // "has_fo_partial_listing" collapses to "no_fo" or "has_fo" for
        // comparison purposes -- a 0-strikes live result for DALBHARAT is
        // NOT automatically a disagreement (still-not-listed matches the
        // known situation), so that specific case is always flagged
        // "REVIEW", never auto-scored match/mismatch.
        let verdict;
        if (known.knownAnswer === "has_fo_partial_listing") {
          verdict = "REVIEW (partial-listing case -- 0 strikes today does not necessarily mean disagreement, read knownReason)";
        } else {
          verdict = known.knownAnswer === liveResult ? "MATCH" : "MISMATCH";
        }
        knownAnswerComparison.push({
          underlying: eq.name,
          knownAnswer: known.knownAnswer,
          knownReason: known.knownReason,
          liveResult,
          liveStrikeCount: strikes.length,
          verdict,
        });
        console.log(`[verifyEquityFoEligibility] (${i + 1}/${equities.length}) ${eq.name} -- KNOWN-ANSWER CHECK: live=${liveResult} (${strikes.length} strikes) known=${known.knownAnswer} -> ${verdict}`);
      } else {
        console.log(`[verifyEquityFoEligibility] (${i + 1}/${equities.length}) ${eq.name} -- ${liveResult === "no_fo" ? "NO F&O (0 strikes)" : `has F&O (${strikes.length} strikes)`}`);
      }
    } catch (err) {
      errored.push({ underlying: eq.name, error: err.message });
      console.warn(`[verifyEquityFoEligibility] (${i + 1}/${equities.length}) ${eq.name} -- ERROR: ${err.message} (left OUT of excluded[] -- unverified, not confirmed either way)`);
    }

    if (i < equities.length - 1) await delay(CHAIN_POLITE_DELAY_MS);
  }

  const mismatches = knownAnswerComparison.filter((c) => c.verdict === "MISMATCH");

  const output = {
    _readme: "Verification REPORT from backend/src/scripts/verifyEquityFoEligibility.js -- NOT a drop-in replacement for symbols/equity-fo-exclusions.json. Review knownAnswerComparison[] first (this run's result against the 9 already hand-verified entries) before applying excluded[] below to the real exclusions file.",
    runDate: new Date().toISOString().slice(0, 10),
    coverage: {
      totalEquities: equities.length,
      liveChecked: equities.length - errored.length,
      errored: errored.length,
    },
    knownAnswerComparison,
    knownAnswerSummary: {
      totalKnown: knownAnswerComparison.length,
      matches: knownAnswerComparison.filter((c) => c.verdict === "MATCH").length,
      mismatches: mismatches.length,
      reviewNeeded: knownAnswerComparison.filter((c) => c.verdict.startsWith("REVIEW")).length,
      note: mismatches.length > 0
        ? `${mismatches.length} MISMATCH(ES) FOUND -- treat this script's method as unverified until these are individually reviewed. Do not apply excluded[] below to equity-fo-exclusions.json until resolved.`
        : "No mismatches against the known-answer set. Still review REVIEW-flagged entries by hand before applying excluded[] below.",
    },
    excluded,
    eligibleCount: eligible.length,
    erroredDuringVerification: errored,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`\n[verifyEquityFoEligibility] Done. ${eligible.length} confirmed with F&O, ${excluded.length} confirmed with no F&O, ${errored.length} errored (unverified).`);
  console.log(`[verifyEquityFoEligibility] Known-answer comparison: ${output.knownAnswerSummary.matches} match, ${output.knownAnswerSummary.mismatches} mismatch, ${output.knownAnswerSummary.reviewNeeded} need manual review.`);
  console.log(`[verifyEquityFoEligibility] Report written to ${outPath} -- this does NOT overwrite equity-fo-exclusions.json. Review it, then apply by hand.`);
}

main().catch((err) => {
  console.error("[verifyEquityFoEligibility] FAILED:", err);
  process.exit(1);
});