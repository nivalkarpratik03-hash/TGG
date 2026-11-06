/**
 * backend/src/parrva/tradeStatus.js  (NEW 2026-11-05, UPDATED same day: version replay + real fill + trailed SL)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE function: one PaRRVA call + its version history + the option's 1-minute candles
 * (+ live price) -> trade status. No I/O, fully unit-tested (parrva.selftest.js).
 *
 * VERSIONS: PaRRVA only sends the latest version of a call, but the backend saves every version it
 * sees (parrvaFeed.js, checked every minute). Each minute of the trade is judged with the levels
 * that were valid at that minute: v1 until v2 was published, then v2, and so on. A version counts
 * from the first full minute after it was published. So a stop loss trailed up to 220 at 13:22
 * only matters from 13:23 - it is never applied to the trade's earlier minutes.
 *
 * Rules (BUY; SELL is the mirror image):
 *   - ENTRY in the first minute that actually trades inside the entry band (low <= entryHi and high >= entryLo).
 *     REAL FILL price, always inside the band: that minute's open if it opened inside the band, otherwise the
 *     band edge price crossed to get in (came down from above -> top of band, came up from below -> bottom).
 *     A live tick inside the band before the minute closes = entry at that tick.
 *   - After entry, each minute: TARGET when high >= target, SL when low <= stop loss (levels of that minute).
 *     Both in the same minute -> SL (conservative), flagged `sameMinute`.
 *     A stop loss at or above the fill price (trailed) -> state TRAIL_SL (profit or break-even).
 *   - PaRRVA exit price (exitPrice > 0) -> EXITED at that price, unless target / SL came first.
 *   - Still open after 15:30 IST on the call's day -> CLOSED at the last price.
 * States: NO_DATA, WAITING, NOT_TRIGGERED, OPEN, TARGET, SL, TRAIL_SL, EXITED, CLOSED.
 * points = per unit, option price points, from the fill price. Positive = profit.
 */
"use strict";

const U = require("./util");

const LEVELS = ["entryLo", "entryHi", "target", "sl"];
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Time-ordered level sets: [{fromSec, entryLo, entryHi, target, sl, version}].
 * The first set always starts at 0 (applies from the beginning). Unknown fields fall back to the call.
 */
function levelTimeline(rec, versions) {
  const list = (versions || [])
    .filter((v) => v && LEVELS.every((k) => v[k] === null || v[k] === undefined || Number.isFinite(Number(v[k]))))
    .map((v) => ({ ...v, ms: Date.parse(v.at) }))
    .filter((v) => Number.isFinite(v.ms))
    .sort((a, b) => a.ms - b.ms || (a.version || 0) - (b.version || 0));
  const pick = (v) => {
    const o = {};
    for (const k of LEVELS) o[k] = v[k] !== null && v[k] !== undefined ? Number(v[k]) : rec[k];
    return o;
  };
  if (!list.length) return [{ fromSec: 0, version: rec.version, ...pick(rec) }];
  return list.map((v, i) => ({
    // A version applies from the first full minute after it was published (the first one from the start).
    fromSec: i === 0 ? 0 : Math.ceil(v.ms / 60000) * 60,
    version: v.version,
    ...pick(v),
  }));
}
const levelsAt = (tl, sec) => { let cur = tl[0]; for (const l of tl) { if (l.fromSec <= sec) cur = l; else break; } return cur; };

function evaluate(rec, candles, live = {}, nowMs = Date.now(), versions = null) {
  const isSell = rec.side === "SELL";
  const out = {
    state: "NO_DATA", entryAt: null, entryPrice: null, fill: null, exitAt: null, exitPrice: null,
    points: null, ltp: Number.isFinite(live.ltp) ? live.ltp : null, livePoints: null,
    mfe: null, mae: null, sameMinute: false, note: null,
    levelsUsed: null, trailed: false, versionsKnown: (versions || []).length,
  };
  const tl = levelTimeline(rec, versions);
  if (tl.some((l) => !Number.isFinite(l.entryLo) || !Number.isFinite(l.entryHi) || !Number.isFinite(l.target) || !Number.isFinite(l.sl))) {
    out.note = "call has no entry / target / stop loss";
    return out;
  }
  const startSec = rec.createdMs ? Math.floor(rec.createdMs / 60000) * 60 : 0;
  const bars = (candles || []).filter((c) => c && c.t >= startSec && Number.isFinite(c.h) && Number.isFinite(c.l)).sort((a, b) => a.t - b.t);
  const dayEndMs = rec.date ? U.istAt(rec.date, 15, 30) : null;
  const dayOver = dayEndMs !== null && nowMs >= dayEndMs;
  const nowLv = levelsAt(tl, Math.floor(nowMs / 1000));

  if (!bars.length && out.ltp === null) {
    if (rec.exit !== null) { out.state = "NOT_TRIGGERED"; out.note = "exited by PaRRVA, no market data recorded"; }
    return out;
  }

  const touchedEntry = (c, L) => c.l <= L.entryHi && c.h >= L.entryLo;
  const fillOf = (c, L) => {
    if (c.o >= L.entryLo && c.o <= L.entryHi) return { px: c.o, how: "open" };
    return c.o > L.entryHi ? { px: L.entryHi, how: "band" } : { px: L.entryLo, how: "band" };
  };

  let entered = -1;
  for (let i = 0; i < bars.length; i++) if (touchedEntry(bars[i], levelsAt(tl, bars[i].t))) { entered = i; break; }

  if (entered < 0) {
    const inBand = out.ltp !== null && out.ltp >= nowLv.entryLo && out.ltp <= nowLv.entryHi;
    if (inBand && rec.exit === null && !dayOver) {
      out.state = "OPEN"; out.entryAt = new Date(nowMs).toISOString(); out.entryPrice = out.ltp; out.fill = "tick";
      out.livePoints = 0; out.levelsUsed = nowLv;
      return out;
    }
    out.state = rec.exit !== null || dayOver ? "NOT_TRIGGERED" : "WAITING";
    out.levelsUsed = nowLv;
    return out;
  }

  const eBar = bars[entered];
  const f = fillOf(eBar, levelsAt(tl, eBar.t));
  const fill = r2(f.px);
  out.entryAt = new Date(eBar.t * 1000).toISOString();
  out.entryPrice = fill;
  out.fill = f.how;
  const pts = (exitPx) => r2(isSell ? fill - exitPx : exitPx - fill);
  let best = -Infinity, worst = Infinity;
  let L = levelsAt(tl, eBar.t);

  for (let i = entered; i < bars.length; i++) {
    const c = bars[i];
    L = levelsAt(tl, c.t);
    best = Math.max(best, isSell ? fill - c.l : c.h - fill);
    worst = Math.min(worst, isSell ? fill - c.h : c.l - fill);
    const tHit = isSell ? c.l <= L.target : c.h >= L.target;
    const sHit = isSell ? c.h >= L.sl : c.l <= L.sl;
    if (tHit || sHit) {
      out.exitAt = new Date(c.t * 1000).toISOString();
      if (sHit) {
        const trailed = isSell ? L.sl <= fill : L.sl >= fill;
        out.state = trailed ? "TRAIL_SL" : "SL"; out.trailed = trailed;
        out.exitPrice = L.sl; out.sameMinute = tHit && sHit;
      } else { out.state = "TARGET"; out.exitPrice = L.target; }
      out.points = pts(out.exitPrice);
      break;
    }
    if (rec.exit !== null && rec.updatedMs && rec.updatedMs < (c.t + 60) * 1000) {
      out.state = "EXITED"; out.exitPrice = rec.exit; out.exitAt = rec.updatedAt; out.points = pts(rec.exit);
      break;
    }
  }
  out.levelsUsed = L;
  out.mfe = Number.isFinite(best) ? r2(best) : null;
  out.mae = Number.isFinite(worst) ? r2(worst) : null;

  if (out.exitPrice === null) {
    if (rec.exit !== null) {
      out.state = "EXITED"; out.exitPrice = rec.exit; out.exitAt = rec.updatedAt; out.points = pts(rec.exit);
    } else if (dayOver && rec.intraday !== false) {
      const last = bars[bars.length - 1];
      out.state = "CLOSED"; out.exitPrice = last.c; out.exitAt = new Date(last.t * 1000).toISOString(); out.points = pts(last.c);
      out.note = "closed at the last price of the day";
    } else {
      out.state = "OPEN";
      out.levelsUsed = nowLv;
      out.livePoints = pts(out.ltp !== null ? out.ltp : bars[bars.length - 1].c);
    }
  }
  return out;
}

/** Totals for a list of {rec, status}. Items with rec.excluded (before recording) are counted apart and not in the totals. */
function summarize(items) {
  const s = { calls: 0, excluded: 0, triggered: 0, target: 0, sl: 0, trailSl: 0, exited: 0, closed: 0, open: 0, waiting: 0, notTriggered: 0, wins: 0, losses: 0, points: 0, pointsXLot: 0, openPoints: 0 };
  for (const { rec, status } of items) {
    if (rec && rec.excluded) { s.excluded++; continue; }
    s.calls++;
    const st = status && status.state;
    if (st === "TARGET") s.target++;
    else if (st === "SL") s.sl++;
    else if (st === "TRAIL_SL") s.trailSl++;
    else if (st === "EXITED") s.exited++;
    else if (st === "CLOSED") s.closed++;
    else if (st === "OPEN") s.open++;
    else if (st === "WAITING") s.waiting++;
    else if (st === "NOT_TRIGGERED") s.notTriggered++;
    if (["TARGET", "SL", "TRAIL_SL", "EXITED", "CLOSED", "OPEN"].includes(st)) s.triggered++;
    if (status && Number.isFinite(status.points)) {
      s.points += status.points; s.pointsXLot += status.points * ((rec && rec.lot) || 1);
      if (status.points > 0) s.wins++; else if (status.points < 0) s.losses++;
    }
    if (status && st === "OPEN" && Number.isFinite(status.livePoints)) s.openPoints += status.livePoints;
  }
  s.points = r2(s.points); s.pointsXLot = r2(s.pointsXLot); s.openPoints = r2(s.openPoints);
  const decided = s.wins + s.losses;
  s.winRate = decided ? Math.round((s.wins / decided) * 1000) / 10 : null;
  return s;
}

module.exports = { evaluate, summarize, levelTimeline };
