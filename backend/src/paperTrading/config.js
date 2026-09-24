/**
 * backend/src/paperTrading/config.js
 * ─────────────────────────────────────────────────────────────────
 * Per-strategy Auto Entry configuration (strategy_paper_config table).
 *
 * One row per strategy id from strategyRegistry.js. `ensureSeeded()` is
 * called once at boot (see server.js) and inserts a disabled, default
 * row for any strategy that doesn't have one yet — new strategies added
 * to the registry later automatically get a config row on next boot,
 * no manual migration needed.
 *
 * Defaults (fixed points, not %) — deliberately conservative, meant to
 * be tuned per strategy from the Paper Trading dashboard, not treated
 * as final numbers:
 *   sl_points: 20, target_points: 40, qty: 1, enabled: false
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { query } = require("../../../database/src/pool");
const strategies = require("../strategies/strategyRegistry");

const DEFAULTS = { slPoints: 20, targetPoints: 40, qty: 1 };

/** Insert a default (disabled) config row for any strategy missing one. Safe to call repeatedly. */
async function ensureSeeded() {
  for (const s of strategies) {
    await query(
      `INSERT INTO strategy_paper_config (strategy_id, enabled, sl_points, target_points, qty)
       VALUES ($1, FALSE, $2, $3, $4)
       ON CONFLICT (strategy_id) DO NOTHING`,
      [s.id, DEFAULTS.slPoints, DEFAULTS.targetPoints, DEFAULTS.qty]
    );
  }
  console.log(`[PaperTrading] Config seeded for ${strategies.length} strategies.`);
}

/** All strategies joined with their current paper-trading config (used by the dashboard's Auto Entry tab). */
async function getAllConfigs() {
  const rows = await query(`SELECT * FROM strategy_paper_config ORDER BY strategy_id`, []);
  const byId = new Map(rows.map((r) => [r.strategy_id, r]));
  return strategies.map((s) => {
    const cfg = byId.get(s.id) || { enabled: false, sl_points: DEFAULTS.slPoints, target_points: DEFAULTS.targetPoints, qty: DEFAULTS.qty };
    return {
      strategyId: s.id,
      strategyName: s.name,
      enabled: !!cfg.enabled,
      slPoints: Number(cfg.sl_points),
      targetPoints: Number(cfg.target_points),
      qty: Number(cfg.qty),
    };
  });
}

async function getConfig(strategyId) {
  const rows = await query(`SELECT * FROM strategy_paper_config WHERE strategy_id=$1`, [strategyId]);
  if (!rows.length) return null;
  const r = rows[0];
  return { strategyId, enabled: !!r.enabled, slPoints: Number(r.sl_points), targetPoints: Number(r.target_points), qty: Number(r.qty) };
}

/** Partial update — only fields present in `patch` are changed. */
async function updateConfig(strategyId, patch) {
  const current = await getConfig(strategyId);
  if (!current) throw new Error(`Unknown strategy id: ${strategyId}`);

  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
    slPoints: patch.slPoints !== undefined ? Number(patch.slPoints) : current.slPoints,
    targetPoints: patch.targetPoints !== undefined ? Number(patch.targetPoints) : current.targetPoints,
    qty: patch.qty !== undefined ? Number(patch.qty) : current.qty,
  };

  await query(
    `UPDATE strategy_paper_config
       SET enabled=$2, sl_points=$3, target_points=$4, qty=$5, updated_at=now()
     WHERE strategy_id=$1`,
    [strategyId, next.enabled, next.slPoints, next.targetPoints, next.qty]
  );

  return { strategyId, ...next };
}

module.exports = { ensureSeeded, getAllConfigs, getConfig, updateConfig, DEFAULTS };