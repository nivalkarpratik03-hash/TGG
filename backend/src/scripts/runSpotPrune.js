/**
 * backend/src/scripts/runSpotPrune.js
 *
 * Manual runner for pruneOldSpot.js's rolling spot retention sweep. Not
 * wired into scheduler.js yet, on purpose — this is meant to be triggered
 * and watched by hand first. Wiring it into the periodic scheduler is a
 * separate decision for later, once a real run has been reviewed.
 *
 * Usage:
 *   node backend/src/scripts/runSpotPrune.js                    (dry run, rolling gate)
 *   node backend/src/scripts/runSpotPrune.js --initial          (dry run, bypasses the 6-month gate)
 *   node backend/src/scripts/runSpotPrune.js --initial --confirm  (LIVE — archives + deletes now)
 *   node backend/src/scripts/runSpotPrune.js --confirm          (LIVE, rolling gate only)
 */

const { runSpotPruneSweep, KEEP_DAYS, ROLL_TRIGGER_DAYS } = require("../spot/pruneOldSpot");

const DRY_RUN = !process.argv.includes("--confirm");
const INITIAL = process.argv.includes("--initial");

async function main() {
  console.log(DRY_RUN
    ? "=== DRY RUN — nothing will be written or deleted. Pass --confirm to apply. ==="
    : "=== LIVE RUN — will export and delete rows. ===");
  console.log(`Mode: ${INITIAL ? "INITIAL (bypasses the 6-month gate — every symbol with data older than the keep window is touched)" : "ROLLING (only symbols whose earliest row is older than the 6-month gate are touched)"}`);
  console.log(`Keep window: newest ${KEEP_DAYS} days. Rolling gate: ${ROLL_TRIGGER_DAYS} days.\n`);

  const result = await runSpotPruneSweep({ initial: INITIAL, dryRun: DRY_RUN });

  console.log("\n=== SUMMARY ===");
  console.log(`Scanned: ${result.scanned}`);
  console.log(`Skipped (under the 6-month gate): ${result.skippedUnderGate}`);
  console.log(`Archived: ${result.archived}`);
  console.log(`Pruned (rows actually deleted): ${result.pruned}`);
  console.log(`Failed (left untouched): ${result.failed.length}`);
  if (result.failed.length) console.log(result.failed);
  if (DRY_RUN) console.log("\nThis was a DRY RUN — nothing was changed. Re-run with --confirm to apply for real.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error("runSpotPrune failed:", err); process.exit(1); });
