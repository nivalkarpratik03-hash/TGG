/**
 * backend/src/parrva/parrva.selftest.js  — offline checks for the live PaRRVA logic (no Fyers, no network).
 * Run:  node src/parrva/parrva.selftest.js      (from backend/)
 */
"use strict";

const assert = require("assert");
const { normalize } = require("./parrvaFeed");
const { evaluate, summarize } = require("./tradeStatus");

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { console.error("  FAIL", name, "\n      ", e.message); process.exitCode = 1; } };

// A real row as PaRRVA returns it (05 Nov 2026).
const row = {
  id: 151, adviceName: "TG1268", role: "RA", productName: "TG PACK", exchangeName: "NSE", contractName: "NIFTY", instrument: "OPTIDX",
  contractExpiryDate: "2026-11-09", optionStrikePrice: 24350, ceOrPe: "CE", buyOrSell: "BUY", lot: 1, priceType: "PR",
  entryPriceStart: 185, entryPriceEnd: 187, targetPrice: 205, stopLoss: 174, exitPrice: 0, ifIntraday: "YES", source: "form",
  updateCount: 1, createdAt: "2026-11-05T11:32:32.848+05:30", updatedAt: "2026-11-05T11:37:56.371+05:30",
};
const rec = normalize(row);
const sec = (hhmm) => Date.parse(`2026-11-05T${hhmm}:00+05:30`) / 1000;
const bar = (hhmm, o, h, l, c) => ({ t: sec(hhmm), o, h, l, c, v: 0 });
const before = Date.parse("2026-11-05T13:00:00+05:30");
const after = Date.parse("2026-11-05T15:45:00+05:30");

console.log("PaRRVA self-test");
t("normalize: name, contract, levels, version, date", () => {
  assert.strictEqual(rec.name, "TG1268");
  assert.strictEqual(rec.label, "NIFTY 24350 CE");
  assert.strictEqual(rec.entryLo, 185); assert.strictEqual(rec.entryHi, 187);
  assert.strictEqual(rec.target, 205); assert.strictEqual(rec.sl, 174);
  assert.strictEqual(rec.exit, null);
  assert.strictEqual(rec.version, 2);
  assert.strictEqual(rec.intraday, true);
  assert.strictEqual(rec.date, "2026-11-05");
  assert.strictEqual(rec.expiry, "2026-11-09");
});
t("no candles -> NO_DATA", () => assert.strictEqual(evaluate(rec, [], {}, before).state, "NO_DATA"));
t("candles before the call are ignored -> WAITING", () => {
  const s = evaluate(rec, [bar("11:20", 180, 181, 179, 180), bar("11:33", 190, 192, 189, 191)], {}, before);
  assert.strictEqual(s.state, "WAITING");
});
t("entry then target -> TARGET, fill = top of band (opened above it)", () => {
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188), bar("11:40", 195, 206, 194, 205)], {}, before);
  assert.strictEqual(s.state, "TARGET"); assert.strictEqual(s.entryPrice, 187); assert.strictEqual(s.fill, "band"); assert.strictEqual(s.points, 18);
});
t("entry then SL -> SL, negative points", () => {
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188), bar("11:41", 180, 181, 173, 175)], {}, before);
  assert.strictEqual(s.state, "SL"); assert.strictEqual(s.points, -13);
});
t("target and SL in the same minute -> SL, flagged", () => {
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188), bar("11:42", 190, 210, 170, 190)], {}, before);
  assert.strictEqual(s.state, "SL"); assert.strictEqual(s.sameMinute, true);
});
t("entered and still running -> OPEN with live points", () => {
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188)], { ltp: 196 }, before);
  assert.strictEqual(s.state, "OPEN"); assert.strictEqual(s.livePoints, 9);
});
t("live tick inside entry before the minute closes -> OPEN", () => {
  const s = evaluate(rec, [bar("11:33", 192, 193, 190, 191)], { ltp: 186.5 }, before);
  assert.strictEqual(s.state, "OPEN");
});
t("PaRRVA exit price -> EXITED", () => {
  const r2 = normalize({ ...row, exitPrice: 196.05, updatedAt: "2026-11-05T11:50:00+05:30" });
  const s = evaluate(r2, [bar("11:33", 190, 191, 186, 188), bar("11:50", 195, 197, 194, 196)], {}, before);
  assert.strictEqual(s.state, "EXITED"); assert.strictEqual(s.points, 9.05);
});
t("day over, still open -> CLOSED at last price", () => {
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188), bar("15:29", 195, 196, 194, 195)], {}, after);
  assert.strictEqual(s.state, "CLOSED"); assert.strictEqual(s.points, 8);
});
t("day over, never entered -> NOT_TRIGGERED", () => {
  const s = evaluate(rec, [bar("11:33", 195, 199, 190, 196)], {}, after);
  assert.strictEqual(s.state, "NOT_TRIGGERED");
});
t("SELL call is mirrored", () => {
  const sell = normalize({ ...row, buyOrSell: "SELL", entryPriceStart: 185, entryPriceEnd: 187, targetPrice: 170, stopLoss: 195 });
  const s = evaluate(sell, [bar("11:33", 184, 186, 183, 185), bar("11:40", 175, 176, 169, 170)], {}, before);
  assert.strictEqual(s.state, "TARGET"); assert.strictEqual(s.entryPrice, 185); assert.strictEqual(s.points, 15);
});
t("summarize counts and points", () => {
  const s = summarize([
    { rec, status: { state: "TARGET", points: 19 } },
    { rec, status: { state: "SL", points: -12 } },
    { rec, status: { state: "OPEN", livePoints: 4 } },
    { rec, status: { state: "WAITING" } },
  ]);
  assert.strictEqual(s.calls, 4); assert.strictEqual(s.target, 1); assert.strictEqual(s.sl, 1);
  assert.strictEqual(s.points, 7); assert.strictEqual(s.openPoints, 4); assert.strictEqual(s.winRate, 50);
});
t("real fill = minute open when it opened inside the band", () => {
  const s = evaluate(rec, [bar("11:33", 186, 188, 185.5, 187)], {}, before);
  assert.strictEqual(s.entryPrice, 186); assert.strictEqual(s.fill, "open");
});
const vers = [
  { version: 1, at: "2026-11-05T11:32:32+05:30", entryLo: 185, entryHi: 187, target: 205, sl: 174 },
  { version: 2, at: "2026-11-05T11:50:30+05:30", entryLo: 185, entryHi: 187, target: 205, sl: 190 },
];
t("price below the band does not count as entry until it trades up into it", () => {
  const s1 = evaluate(rec, [bar("11:33", 179, 182, 178, 181)], {}, before);
  assert.strictEqual(s1.state, "WAITING");
  const s2 = evaluate(rec, [bar("11:33", 179, 182, 178, 181), bar("11:35", 182, 186, 181, 185)], {}, before);
  assert.strictEqual(s2.state, "OPEN"); assert.strictEqual(s2.entryPrice, 185); assert.strictEqual(s2.fill, "band");
});
t("trailed SL only counts from the minute after it was published", () => {
  // 11:45 low 185 is above v1 SL 174; v2's SL 190 must NOT be applied to 11:45.
  const s = evaluate(rec, [bar("11:33", 190, 191, 186, 188), bar("11:45", 188, 189, 185, 188), bar("11:50", 195, 196, 194, 195), bar("11:52", 192, 193, 189, 190)], {}, before, vers);
  assert.strictEqual(s.state, "TRAIL_SL"); assert.strictEqual(s.trailed, true);
  assert.strictEqual(s.exitPrice, 190); assert.strictEqual(s.points, 3);
  assert.strictEqual(s.exitAt, new Date(sec("11:52") * 1000).toISOString());
});
t("without version history the latest levels are used (old behaviour)", () => {
  const r6 = normalize({ ...row, stopLoss: 190 });
  const s = evaluate(r6, [bar("11:33", 190, 191, 186, 188), bar("11:45", 188, 189, 185, 188)], {}, before);
  assert.strictEqual(s.state, "TRAIL_SL");
});
t("summarize leaves out calls before recording", () => {
  const s = summarize([{ rec: { ...rec, excluded: true }, status: { state: "SL", points: -10 } }, { rec, status: { state: "TRAIL_SL", points: 3 } }]);
  assert.strictEqual(s.calls, 1); assert.strictEqual(s.excluded, 1); assert.strictEqual(s.points, 3); assert.strictEqual(s.trailSl, 1); assert.strictEqual(s.winRate, 100);
});
console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
