/**
 * backend/src/parrva/tradeStatus.js  (NEW 2026-11-05, UPDATED: version replay, real fill, trailed SL, tick-level, AVOIDED)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE function: one PaRRVA call + its version history + price bars (+ live price) -> trade status.
 * No I/O, fully unit-tested (parrva.selftest.js).
 *
 * PRICE BARS: 1-second bars built from the recorder's ticks when we have them (exact, like the Telegram bot),
 * otherwise 1-minute candles. Each bar is {t (epoch s), o, h, l, c} plus optional `d` = length in seconds
 * (default 60). With 1-second bars every rule below is to the tick; with minutes it is to the minute.
 *
 * VERSIONS: PaRRVA only sends the latest version of a call, but the backend saves every version it sees.
 * A version counts from the moment it was published: each bar is judged with the last version published
 * at or before the bar's start (for minute bars: from the next full minute). A trailed SL is never applied
 * to earlier prices.
 *
 * Rules (BUY; SELL is the mirror image):
 *   - ENTRY at the first bar that trades inside the entry band (low <= entryHi and high >= entryLo), only after
 *     the call was published and before PaRRVA exited it.
 *     REAL FILL, always inside the band: the bar's open if it opened inside the band, otherwise the band edge
 *     crossed to get in. A live tick inside the band = entry at that tick.
 *   - After entry: TARGET when high >= target, SL when low <= stop loss. Both in the same bar -> SL, flagged.
 *     On a minute entry bar, prices from before the entry are not used (came up from below -> no SL check
 *     in that minute; came down from above -> no target check in that minute).
 *     A stop loss at or above the fill (trailed) -> TRAIL_SL.
 *   - PaRRVA exit price -> EXITED at that price, unless target / SL came first.
 *     PaRRVA exit before the price ever reached the band -> AVOIDED (no trade, 0 points).
 *   - Still open after 15:30 IST -> CLOSED at the last price.
 * States: NO_DATA, WAITING, NOT_TRIGGERED, AVOIDED, OPEN, TARGET, SL, TRAIL_SL, EXITED, CLOSED.
 * points     = per unit, measured from the band (BUY: entry low, SELL: entry high), like the Telegram bot.
 *              This is the official number. Positive = profit.
 * realPoints = the same trade measured from the real fill price (extra info).
 */
"use strict";

const U = require("./util");

const LEVELS = ["entryLo", "entryHi", "target", "sl"];
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Time-ordered level sets: [{fromMs, entryLo, entryHi, target, sl, version}].
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
  if (!list.length) return [{ fromMs: 0, version: rec.version, ...pick(rec) }];
  // A version applies to bars that start at or after its publish time (the first one from the start).
  return list.map((v, i) => ({ fromMs: i === 0 ? 0 : v.ms, version: v.version, ...pick(v) }));
}
const levelsAt = (tl, ms) => { let cur = tl[0]; for (const l of tl) { if (l.fromMs <= ms) cur = l; else break; } return cur; };
const startMs = (b) => b.t * 1000;
const endMs = (b) => (b.t + (b.d || 60)) * 1000;

function evaluate(rec, candles, live = {}, nowMs = Date.now(), versions = null) {
  const isSell = rec.side === "SELL";
  const out = {
    state: "NO_DATA", entryAt: null, entryPrice: null, fill: null, exitAt: null, exitPrice: null,
    points: null, ltp: Number.isFinite(live.ltp) ? live.ltp : null, livePoints: null,
    realPoints: null, mfe: null, mae: null, sameMinute: false, note: null,
    levelsUsed: null, trailed: false, versionsKnown: (versions || []).length, resolution: null,
  };
  const tl = levelTimeline(rec, versions);
  if (tl.some((l) => !Number.isFinite(l.entryLo) || !Number.isFinite(l.entryHi) || !Number.isFinite(l.target) || !Number.isFinite(l.sl))) {
    out.note = "call has no entry / target / stop loss";
    return out;
  }
  const created = rec.createdMs || 0;
  // A bar counts if it ends after the call was published (minute bars: the publishing minute is included).
  const bars = (candles || []).filter((c) => c && Number.isFinite(c.t) && endMs(c) > created && Number.isFinite(c.h) && Number.isFinite(c.l)).sort((a, b) => a.t - b.t);
  out.resolution = bars.length ? ((bars[0].d || 60) < 60 ? "tick" : "minute") : null;
  const dayEndMs = rec.date ? U.istAt(rec.date, 15, 30) : null;
  const dayOver = dayEndMs !== null && nowMs >= dayEndMs;
  const nowLv = levelsAt(tl, nowMs);
  const exitMs = rec.exit !== null ? (rec.updatedMs || Infinity) : Infinity;   // when PaRRVA exited the call

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
  for (let i = 0; i < bars.length; i++) {
    if (startMs(bars[i]) >= exitMs) break;                         // PaRRVA already exited before this bar
    if (touchedEntry(bars[i], levelsAt(tl, startMs(bars[i])))) { entered = i; break; }
  }

  if (entered < 0) {
    if (rec.exit !== null) {
      out.state = "AVOIDED"; out.points = null; out.levelsUsed = nowLv;
      out.exitAt = rec.updatedAt || null; out.exitPrice = rec.exit;
      out.note = "PaRRVA exited the call before the price reached the entry band";
      return out;
    }
    const inBand = out.ltp !== null && out.ltp >= nowLv.entryLo && out.ltp <= nowLv.entryHi;
    if (inBand && rec.exit === null && !dayOver) {
      out.state = "OPEN"; out.entryAt = new Date(nowMs).toISOString(); out.entryPrice = out.ltp; out.fill = "tick";
      out.livePoints = 0; out.levelsUsed = nowLv;
      return out;
    }
    out.state = dayOver ? "NOT_TRIGGERED" : "WAITING";
    out.levelsUsed = nowLv;
    return out;
  }

  const eBar = bars[entered];
  const eL = levelsAt(tl, startMs(eBar));
  const f = fillOf(eBar, eL);
  const fill = r2(f.px);
  const bandRef = isSell ? eL.entryHi : eL.entryLo;
  out.entryAt = new Date(startMs(eBar)).toISOString();
  out.entryPrice = fill;
  out.fill = f.how;
  const pts = (exitPx) => r2(isSell ? bandRef - exitPx : exitPx - bandRef);       // official: from the band
  const realPts = (exitPx) => r2(isSell ? fill - exitPx : exitPx - fill);
  // Minute entry bar that came in from outside the band: its extreme on that side happened before the entry.
  const wide = (eBar.d || 60) >= 60;
  const fromBelow = wide && eBar.o < eL.entryLo, fromAbove = wide && eBar.o > eL.entryHi;
  let best = -Infinity, worst = Infinity;
  let L = eL;

  for (let i = entered; i < bars.length; i++) {
    const c = bars[i];
    L = levelsAt(tl, startMs(c));
    // Range of the bar that is after the entry (on a minute entry bar, drop the side seen before the entry).
    let hi = c.h, lo = c.l;
    if (i === entered && fromBelow) lo = Math.min(fill, c.c);
    if (i === entered && fromAbove) hi = Math.max(fill, c.c);
    best = Math.max(best, isSell ? fill - lo : hi - fill);
    worst = Math.min(worst, isSell ? fill - hi : lo - fill);
    const tHit = isSell ? lo <= L.target : hi >= L.target;
    const sHit = isSell ? hi >= L.sl : lo <= L.sl;
    if (tHit || sHit) {
      out.exitAt = new Date(startMs(c)).toISOString();
      if (sHit) {
        const trailed = isSell ? L.sl <= fill : L.sl >= fill;
        out.state = trailed ? "TRAIL_SL" : "SL"; out.trailed = trailed;
        out.exitPrice = L.sl; out.sameMinute = tHit && sHit;
      } else { out.state = "TARGET"; out.exitPrice = L.target; }
      out.points = pts(out.exitPrice);
      break;
    }
    if (rec.exit !== null && exitMs < endMs(c)) {
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
      out.state = "CLOSED"; out.exitPrice = last.c; out.exitAt = new Date(startMs(last)).toISOString(); out.points = pts(last.c);
      out.note = "closed at the last price of the day";
    } else {
      out.state = "OPEN";
      out.levelsUsed = nowLv;
      out.livePoints = pts(out.ltp !== null ? out.ltp : bars[bars.length - 1].c);
    }
  }
  if (out.points !== null) out.realPoints = realPts(out.exitPrice);
  return out;
}

/** Totals for a list of {rec, status}. Items with rec.excluded (before recording) are counted apart and not in the totals. */
function summarize(items) {
  const s = { calls: 0, excluded: 0, triggered: 0, target: 0, sl: 0, trailSl: 0, exited: 0, closed: 0, open: 0, waiting: 0, notTriggered: 0, avoided: 0, wins: 0, losses: 0, points: 0, realPoints: 0, pointsXLot: 0, openPoints: 0 };
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
    else if (st === "AVOIDED") s.avoided++;
    if (["TARGET", "SL", "TRAIL_SL", "EXITED", "CLOSED", "OPEN"].includes(st)) s.triggered++;
    if (status && Number.isFinite(status.points)) {
      s.points += status.points; s.realPoints += Number.isFinite(status.realPoints) ? status.realPoints : status.points; s.pointsXLot += status.points * ((rec && rec.lot) || 1);
      if (status.points > 0) s.wins++; else if (status.points < 0) s.losses++;
    }
    if (status && st === "OPEN" && Number.isFinite(status.livePoints)) s.openPoints += status.livePoints;
  }
  s.points = r2(s.points); s.realPoints = r2(s.realPoints); s.pointsXLot = r2(s.pointsXLot); s.openPoints = r2(s.openPoints);
  const decided = s.wins + s.losses;
  s.winRate = decided ? Math.round((s.wins / decided) * 1000) / 10 : null;
  return s;
}

module.exports = { evaluate, summarize, levelTimeline };
