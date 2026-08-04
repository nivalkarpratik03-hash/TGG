/**
 * mwScanHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared Motherwave-scan helpers used by ScannerPage.js and StrategiesPage.js.
 * Consolidated per Section 4c of TGG-project-plan.md (fibPrice / fmtTime /
 * stageLabel / mwWave / isMWBull / waveSize / getZoneTray / buildChartUrl were
 * duplicated verbatim across both pages — 2-file cluster, moved here on the
 * user's explicit override of the 3+ threshold rule).
 *
 * RECONSTRUCTION NOTE (2026-08-04): this file was never actually written to
 * the delivered output in the session that consolidated it — the page files
 * were edited to import from it, but the file itself is missing, which is
 * the direct cause of the "Module not found" build error. The original
 * function bodies were not recoverable from that session's transcript. Every
 * function below was rebuilt from hard evidence only (no invented logic):
 *   - field names/shapes cross-checked against backend/src/services/motherwave.js
 *     (buildWaveObj, fibPrice, sp, bull) and backend/src/strategies/scannerS1.S2.S3.js
 *     (patternStage values, result.error)
 *   - trap-zone bounds (-0.236 / 0.236) and the fib formula cross-checked
 *     against frontend/src/pages/FibDashboardPage.js, which computes the same
 *     thing independently and already matches
 *   - stage pill class names ("s1"/"s2"/"s3"/"mw"/"error"/"none") taken
 *     directly from ScannerPage.css / StrategiesPage.css, which already exist
 *     and were clearly built to be driven by this function
 *   - buildChartUrl's query params (symbol, resolution, waveFrom, waveTo)
 *     taken directly from ChartsPage.js's own urlParams parser
 * The one place this is a judgment call, not a lookup: the exact wording of
 * stageLabel's `text` values (cosmetic only, doesn't affect any logic). Please
 * eyeball those against what you remember and tell me if any label is wrong —
 * everything else here is traceable to the cited source line.
 */

import { formatTimeIST } from "../../utils/istUtils";

// ─── Time formatting ──────────────────────────────────────────────────────────
// istUtils.js is the documented single source of truth for IST time formatting
// (see its own header comment). fmtTime is a thin alias so both pages can keep
// their existing short call sites without re-implementing the formatter.
export function fmtTime(ts) {
  return formatTimeIST(ts);
}

// ─── Motherwave field access ──────────────────────────────────────────────────
// r.motherwave is the full { wave, fibLevels, invalidation } shape returned by
// backend detectMotherWaveForAPI (motherwave.js). All access goes through
// r.motherwave.wave.*, per the header comments in both page files.
export function mwWave(r) {
  return r?.motherwave?.wave || null;
}

// wave.dir is set by backend buildWaveObj as bull(seg) ? "bull" : "bear"
// (motherwave.js: const bull = s => s.toSide === "high").
export function isMWBull(r) {
  return mwWave(r)?.dir === "bull";
}

// wave.delta is already computed server-side as sp(seg) = Math.abs(toPrice - fromPrice)
// (motherwave.js buildWaveObj). Recomputed defensively if delta is ever missing.
export function waveSize(r) {
  const w = mwWave(r);
  if (!w) return 0;
  if (typeof w.delta === "number") return w.delta;
  return Math.abs((w.toPrice ?? 0) - (w.fromPrice ?? 0));
}

// ─── Fib price + zone classification ───────────────────────────────────────────
// Same formula as backend motherwave.js fibPrice(): price = toPrice + ratio * (fromPrice - toPrice).
// Verified independently against FibDashboardPage.js's computeFibLevels, which
// uses the identical formula for the same trap-zone bounds (-0.236 / 0.236).
function fibPrice(w, ratio) {
  const to = w.toPrice;
  const from = w.fromPrice;
  return to + ratio * (from - to);
}

// getZoneTray — per your explicit "keep it 0.5%" decision (this is Scanner's
// original version, now the single canonical one both pages use):
//   - trap zone bounded by fibPrice(w, -0.236) .. fibPrice(w, 0.236), matching
//     FibDashboardPage.js's TRAP_ZONE_TOP/TRAP_ZONE_BOT constants exactly
//   - near382 / hot618 use a 0.5% tolerance band around the 0.382 / 0.618 levels
// r.trapZone (precomputed server-side high/low) is used as the "is this row
// even zone-eligible" gate, consistent with how both pages already read
// r.trapZone elsewhere (e.g. the "Zone {low}–{high}" display).
export function getZoneTray(r) {
  const w = mwWave(r);
  if (!w || !r.trapZone) return "other";

  const currentPrice = r.trapZone.center ?? (r.trapZone.high + r.trapZone.low) / 2;
  const span = Math.abs((w.toPrice ?? 0) - (w.fromPrice ?? 0));
  const tol = span * 0.005; // 0.5%

  if (Math.abs(currentPrice - fibPrice(w, 0.618)) <= tol) return "hot618";
  if (Math.abs(currentPrice - fibPrice(w, 0.382)) <= tol) return "near382";

  const trapTop = fibPrice(w, -0.236);
  const trapBot = fibPrice(w, 0.236);
  const trapHigh = Math.max(trapTop, trapBot);
  const trapLow = Math.min(trapTop, trapBot);
  if (currentPrice >= trapLow && currentPrice <= trapHigh) return "trap";

  return "other";
}

// ─── Stage label ────────────────────────────────────────────────────────────
// r.patternStage values are set by backend scannerS1.S2.S3.js scan():
//   "none" (default) | "motherwave" | "trapzone" | "s1" | "s2" | "s3_complete"
// r.error is set by the same file on failure (e.g. "insufficient_data").
// cls values below ("s1"/"s2"/"s3"/"mw"/"error"/"none") match the CSS classes
// that already exist in ScannerPage.css / StrategiesPage.css
// (.stage-pill.s1/.s2/.s3/.mw/.error/.none and .sp-stage-pill equivalents).
export function stageLabel(r) {
  if (r?.error) return { cls: "error", text: "Error" };

  switch (r?.patternStage) {
    case "s3_complete":
      return { cls: "s3", text: "S3" };
    case "s2":
      return { cls: "s2", text: "S2" };
    case "s1":
      return { cls: "s1", text: "S1" };
    case "trapzone":
    case "motherwave":
      return { cls: "mw", text: "MW" };
    default:
      return { cls: "none", text: "—" };
  }
}

// ─── Chart URL builder ──────────────────────────────────────────────────────
// Query params match ChartsPage.js's own urlParams parser exactly
// (symbol, resolution, waveFrom, waveTo → urlWaveTarget as {fromMs, toMs}).
export function buildChartUrl(symbol, timeframe, mw) {
  const wave = mw?.wave || mw;
  const params = new URLSearchParams({ symbol, resolution: String(timeframe) });
  if (wave?.fromTime) params.set("waveFrom", String(wave.fromTime));
  if (wave?.toTime) params.set("waveTo", String(wave.toTime));
  return `/charts?${params.toString()}`;
}
