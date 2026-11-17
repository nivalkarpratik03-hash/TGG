/**
 * backend/src/parrva/systemStatus.js  (NEW 2026-11-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that decides what is fine and what is wrong, for the Admin page "System status"
 * panel (GET /api/parrva/system) and for the Telegram alerts (alerts.js). Reads only what the
 * backend already has in memory or on disk: no Fyers call, no PaRRVA call.
 *
 * Each row: { key, state: "ok" | "warn" | "bad" | "off", name, detail, value, action? }
 *   ok   working          warn  needs a look soon       bad  broken now        off  idle / not due yet
 */
"use strict";

const U = require("./util");
const accounts = require("../fyers/accounts");

const RANK = { off: 0, ok: 1, warn: 2, bad: 3 };
const clock = (ms) => U.istClock(ms).slice(0, 5);
const clockS = (ms) => U.istClock(ms);
const ago = (ms, now) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
};
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// depth-50 counter seen last time, to notice when it stops growing while "connected"
let d50 = { count: -1, at: 0 };

function fyersRows(now) {
  const trading = U.isTradingDayIST(now);
  return [accounts.account1, accounts.account2].map((a) => {
    const role = a.id === 1 ? "Account 1 · charts" : "Account 2 · recorder";
    const key = `fyers${a.id}`;
    if (!a.configured()) return { key, state: "off", name: a.nickname(), detail: `${role} · app id / secret not set in .env`, value: "not set up" };
    let info = { exists: false };
    try { info = a.getTokenInfo() || info; } catch { /* treat as no token */ }
    if (!info.exists || info.expired) {
      return { key, state: trading ? "bad" : "warn", name: a.nickname(), detail: `${role} · ${info.exists ? `token expired at ${clock(Date.parse(info.expiresAt))}` : "not logged in"}`, value: "Log in above" };
    }
    return { key, state: "ok", name: a.nickname(), detail: role, value: `Valid till ${clock(Date.parse(info.expiresAt))}` };
  });
}

function recorderRows(svc, now) {
  const r = svc.recorder;
  const info = r.info();
  const w = r.window();
  const min = U.istMinutes(now);
  const inWin = r.inWindow(now);
  const marketOpen = min >= 555 && min < 930;   // 09:15-15:30, when ticks must flow
  const lastTick = info.lastTickAt ? Date.parse(info.lastTickAt) : null;
  const manualOff = info.mode === "manual-off";
  const rows = [];

  // Quotes (index, future, options)
  if (!inWin && !info.running) {
    const why = !U.isTradingDayIST(now) ? "Not a trading day" : min < w.start ? `Starts at ${fmtMin(w.start)}` : `Stopped at ${fmtMin(w.stop)} (scheduled)`;
    rows.push({ key: "quotes", state: "off", name: "Quotes", detail: why, value: min < w.start ? "not started" : "stopped" });
  } else if (manualOff && !info.running) {
    rows.push({ key: "quotes", state: "warn", name: "Quotes", detail: "Stopped by hand today. Press Auto or Start below to record again.", value: "stopped" });
  } else if (!info.accountReady) {
    rows.push({ key: "quotes", state: "bad", name: "Quotes", detail: "Account 2 is not logged in, so the recorder cannot run.", value: "not recording" });
  } else if (!info.running) {
    rows.push({ key: "quotes", state: "bad", name: "Quotes", detail: info.lastExit ? `Recorder stopped: ${info.lastExit.why}. It restarts by itself.` : "Recorder is starting.", value: "not recording" });
  } else if (!info.dataConnected) {
    rows.push({ key: "quotes", state: inWin && marketOpen ? "bad" : "warn", name: "Quotes", detail: "Connecting to Fyers…", value: "connecting" });
  } else {
    const age = lastTick ? now - lastTick : Infinity;
    const what = `Index, future, ${info.tracked ? `${info.tracked} symbols` : "options"}`;
    if (!marketOpen) rows.push({ key: "quotes", state: "ok", name: "Quotes", detail: `${what} · market closed, few ticks`, value: lastTick ? `last tick ${ago(lastTick, now)}` : "connected" });
    else if (age > 60000) rows.push({ key: "quotes", state: "bad", name: "Quotes", detail: `${what} · no ticks for ${Math.round(age / 1000)} s`, value: lastTick ? `last tick ${ago(lastTick, now)}` : "no ticks" });
    else if (age > 20000) rows.push({ key: "quotes", state: "warn", name: "Quotes", detail: `${what} · ticks slow`, value: `last tick ${ago(lastTick, now)}` });
    else rows.push({ key: "quotes", state: "ok", name: "Quotes", detail: what, value: `last tick ${ago(lastTick, now)}` });
  }

  // 50-level depth
  const c50 = (info.counts && info.counts.depth50) || 0;
  if (c50 !== d50.count) d50 = { count: c50, at: now };
  const extra = Math.min(2, (info.tbtSymbols || []).length);
  if (!info.tbtEnabled) rows.push({ key: "depth50", state: "off", name: "50-level depth", detail: "Turned off (RECORDER_TBT=false)", value: "off" });
  else if (!info.running) rows.push({ key: "depth50", state: "off", name: "50-level depth", detail: "Runs with the recorder", value: "—" });
  else if (!info.tbtConnected) rows.push({ key: "depth50", state: inWin && marketOpen ? "bad" : "warn", name: "50-level depth", detail: "Not connected", value: "connecting" });
  else {
    const still = now - d50.at;
    const detail = `Future + ATM pair${extra ? ` + ${extra} PaRRVA call${extra > 1 ? "s" : ""}` : ""} · ${3 + extra} of 5 slots`;
    if (marketOpen && still > 120000) rows.push({ key: "depth50", state: "warn", name: "50-level depth", detail: `${detail} · no new updates for ${Math.round(still / 1000)} s`, value: c50.toLocaleString("en-IN") });
    else rows.push({ key: "depth50", state: "ok", name: "50-level depth", detail, value: `${c50.toLocaleString("en-IN")} saved` });
  }

  // ATM
  rows.push(info.running && info.atm
    ? { key: "atm", state: "ok", name: "ATM", detail: `Strike ${Number(info.atm).toLocaleString("en-IN")} from the index · ${info.fut || ""}${info.expiry ? ` · expiry ${info.expiry}` : ""}`, value: `${info.tracked || 0} symbols` }
    : { key: "atm", state: "off", name: "ATM", detail: "Set from the index when the recorder starts", value: "—" });

  // Evening watcher for MCX calls (recorderManager, 2026-11-16) - shown only when there is such a call
  const wt = info.watch || {};
  if ((wt.symbols && wt.symbols.length) || wt.running) {
    const until = Number.isFinite(wt.until) ? fmtMin(wt.until) : "the close";
    const wTick = wt.lastTickAt ? Date.parse(wt.lastTickAt) : null;
    if (wt.recording) rows.push({ key: "watch", state: "ok", name: "Evening calls", detail: `Tracking ${wt.symbols.join(", ")} until ${until}`, value: wTick ? `last tick ${ago(wTick, now)}` : "connected" });
    else if (wt.running) rows.push({ key: "watch", state: "warn", name: "Evening calls", detail: `Connecting for ${wt.symbols.join(", ")}…`, value: "connecting" });
    else if (info.running && !info.stopping) rows.push({ key: "watch", state: "off", name: "Evening calls", detail: `${wt.symbols.join(", ")} tracked by the recorder now; after it stops, until ${until}`, value: "waiting" });
    else if (!info.accountReady) rows.push({ key: "watch", state: "bad", name: "Evening calls", detail: `Account 2 is not logged in, so ${wt.symbols.join(", ")} cannot be tracked`, value: "not tracking" });
    else rows.push({ key: "watch", state: "warn", name: "Evening calls", detail: `Starting for ${wt.symbols.join(", ")} (until ${until})`, value: "starting" });
  }

  // Parquet
  const ex = info.lastExport;
  const today = U.istDate(now);
  const onDrive = svc.drive ? svc.drive.uploaded(U.istDate(now)) : null;
  if (info.exporting || info.stopping) rows.push({ key: "parquet", state: "warn", name: "Parquet files", detail: "Writing index / futures / options…", value: "writing" });
  else if (ex && U.istDate(Date.parse(ex.at)) === today) {
    rows.push(ex.ok
      ? { key: "parquet", state: "ok", name: "Parquet files", detail: ex.files ? ex.files.map((f) => `${f.file} ${Number(f.rows || 0).toLocaleString("en-IN")} rows`).join(" · ") : `Saved in ${ex.dir || "parquet folder"}`, value: `saved ${clock(Date.parse(ex.at))}` }
      : { key: "parquet", state: "bad", name: "Parquet files", detail: `Export failed${ex.error ? `: ${ex.error}` : ""}. Press Export Parquet below to retry.`, value: "failed" });
  } else if (onDrive) {
    rows.push({ key: "parquet", state: "ok", name: "Parquet files", detail: `index · futures · options made and checked on Drive at ${clock(Date.parse(onDrive.at))}`, value: "on Drive" });
  } else if (U.isTradingDayIST(now) && min >= w.stop + 15 && !r.starts[today]) {
    rows.push({ key: "parquet", state: "off", name: "Parquet files", detail: "Nothing was recorded today, so there is nothing to export", value: "—" });
  } else if (U.isTradingDayIST(now) && min >= w.stop + 15) {
    rows.push({ key: "parquet", state: "bad", name: "Parquet files", detail: `Not written today, although the recorder should have stopped at ${fmtMin(w.stop)}. Press Export Parquet below.`, value: "missing" });
  } else rows.push({ key: "parquet", state: "off", name: "Parquet files", detail: `Made automatically after the ${fmtMin(w.stop)} stop`, value: "waiting" });

  // Google Drive upload + local cleanup (driveUpload.js)
  if (svc.drive) {
    const d = svc.drive.info();
    const cl = d.cleanup;
    const keptOld = cl ? Object.entries(cl.kept) : [];
    const tail = cl && cl.deleted.length ? ` · deleted local ${cl.deleted.join(", ")}` : "";
    if (!d.mode) {
      rows.push({ key: "drive", state: "off", name: "Google Drive", detail: "Not set up (PARQUET_DRIVE_DIR or PARQUET_DRIVE_REMOTE in .env). Recordings stay on this machine.", value: "off" });
    } else if (d.lastError && !(d.last && d.last.day === d.lastError.day && d.last.at > d.lastError.at)) {
      rows.push({ key: "drive", state: d.lastError.tries >= 2 ? "bad" : "warn", name: "Google Drive", detail: `Upload of ${d.lastError.day} failed (try ${d.lastError.tries}, retrying): ${d.lastError.error}`, value: "failed" });
    } else if (d.today.uploaded) {
      const n = (d.today.uploaded.files || []).length || 3;
      const res = d.today.results
        ? ` · results.json (${d.today.results.calls} call${d.today.results.calls === 1 ? "" : "s"}) at ${clock(Date.parse(d.today.results.at))}`
        : svc.feed.list(today, today).length ? ` · results.json after ${fmtMin(Math.min(svc.finalMinOf(today) + 5, 1439))}` : "";
      rows.push({ key: "drive", state: "ok", name: "Google Drive", detail: `${n} Parquet files of today checked on Drive at ${clock(Date.parse(d.today.uploaded.at))}${res} · ${d.today.uploaded.dest}${tail}`, value: d.today.results ? `${n + 1} files on Drive` : "uploaded" });
    } else if (d.today.exported) {
      rows.push({ key: "drive", state: "warn", name: "Google Drive", detail: `Uploading today's files to ${d.dest}…`, value: "uploading" });
    } else {
      const waiting = keptOld.filter(([, why]) => ["not on Drive yet", "results not in the database yet", "results.json not on Drive yet"].includes(why));
      rows.push({
        key: "drive", state: "off", name: "Google Drive",
        detail: `Uploads after the Parquet export · ${d.keepDays ? `keeps the last ${d.keepDays} uploaded day(s) here` : "local recordings deleted after a checked upload"}${tail}${waiting.length ? ` · waiting: ${waiting.map(([k, v]) => `${k} (${v})`).join(", ")}` : ""}`,
        value: d.last ? `last ${d.last.day}` : "waiting",
      });
    }
  }

  return rows;
}

function parrvaRows(svc, now) {
  const f = svc.feed;
  const st = f.status();
  const wh = st.webhook;
  const rows = [];
  const marketHours = f.marketHours(now);
  const today = U.istDate(now);

  if (st.mode === "webhook" || wh.received || wh.configured) {
    // PaRRVA's webhook only arrives when a call is saved (no heartbeat), so silence is normal.
    const last = wh.lastEventAt ? Date.parse(wh.lastEventAt) : null;
    const fetchErr = wh.lastFetchError && (!wh.lastFetchAt || Date.parse(wh.lastFetchErrorAt) > Date.parse(wh.lastFetchAt));
    const rejectedRecently = wh.lastRejectAt && now - Date.parse(wh.lastRejectAt) < 3600000;
    let state, detail;
    if (!wh.configured) { state = st.mode === "webhook" ? "bad" : "off"; detail = "PARRVA_WEBHOOK_SECRET is not set in .env"; }
    else if (st.mode === "webhook" && !st.apiKey) { state = "bad"; detail = "PARRVA_API_KEY is not set in .env, so calls named by a webhook cannot be fetched"; }
    else if (fetchErr) { state = "bad"; detail = `Webhook arrived but fetching the calls failed: ${wh.lastFetchError}${wh.pending ? ` (${wh.pending} waiting, retrying)` : ""}`; }
    else if (rejectedRecently) { state = "warn"; detail = `A request was rejected in the last hour: ${wh.lastRejectReason}`; }
    else if (last) { state = "ok"; detail = `Last: ${wh.lastItems || "—"} at ${clockS(last)}${wh.lastFetchAt ? ` · fetched ${wh.lastFetchCount} row(s)` : ""}`; }
    else { state = st.mode === "webhook" ? "ok" : "off"; detail = "Nothing received yet. A webhook arrives only when PaRRVA saves a call."; }
    rows.push({
      key: "webhook", state, name: st.mode === "webhook" ? "Webhook" : "Webhook (test, polling still on)",
      detail, value: last ? ago(last, now) : "none yet", action: state === "bad" ? "check" : undefined,
    });
    if (st.mode === "webhook" && st.syncMin > 0) {
      const ls = st.lastSync;
      rows.push(ls && !ls.ok
        ? { key: "sync", state: "bad", name: `Safety sync (every ${st.syncMin} min)`, detail: `Last sync failed: ${ls.error}`, value: "failed", action: "check" }
        : { key: "sync", state: ls ? "ok" : "off", name: `Safety sync (every ${st.syncMin} min)`, detail: ls ? `Only changed rows · last at ${clockS(Date.parse(ls.at))}${ls.applied ? ` · found ${ls.applied} the webhook had missed` : ""}` : "Runs in market hours (09:00-15:45)", value: ls ? `${ls.applied} missed` : "waiting" });
    }
  }

  if (st.mode === "poll") {
    const ok = st.lastOkAt ? Date.parse(st.lastOkAt) : null;
    const bad = st.errorsInARow > 0;
    rows.push({
      key: "api", state: bad ? (st.errorsInARow >= 3 ? "bad" : "warn") : ok ? "ok" : "off", name: `PaRRVA API (every ${st.pollSec} s)`,
      detail: bad ? `${st.errorsInARow} failed in a row: ${st.lastError}` : `${st.calls} call${st.calls === 1 ? "" : "s"} since start`, value: ok ? `last ${ago(ok, now)}` : "—",
    });
  } else {
    const checks = f.checksOf(today);
    const times = f.checkTimes();
    const show = (key, name, pick, dueText, dueMin) => {
      const c = pick(checks);
      if (!c) {
        const late = Number.isFinite(dueMin) && U.isTradingDayIST(now) && U.istMinutes(now) > dueMin + 60;
        return { key, state: late ? "warn" : "off", name, detail: late ? `Did not run at ${dueText}` : `Runs at ${dueText}`, value: "waiting", action: late ? "check" : undefined };
      }
      const at = clockS(Date.parse(c.at));
      if (!c.ok) return { key, state: "bad", name, detail: `Could not reach the PaRRVA API at ${at}: ${c.error}`, value: "failed", action: "check" };
      const fixed = c.missing + c.stale;
      return {
        key, state: fixed ? "warn" : "ok", name,
        detail: fixed ? `At ${at} the webhook had missed ${c.missing} new and ${c.stale} changed call(s). Fixed from the API.`
          : c.slot === "startup" ? `Server started: loaded the PaRRVA list at ${at}${c.loaded ? ` (${c.loaded} new or changed since the last run)` : ""}`
          : `Matched the PaRRVA list at ${at}`,
        value: fixed ? `${fixed} fixed` : "0 missing",
      };
    };
    const morningT = times.find((t) => U.hhmm(t) < 720);
    const closeT = times.find((t) => U.hhmm(t) >= 900);
    rows.push(show("check_morning", "Morning check", (cs) => [...cs].reverse().find((c) => c.slot === "morning" || c.slot === "startup"), morningT ? `${morningT} or server start` : "server start", morningT ? U.hhmm(morningT) : NaN));
    rows.push(show("check_close", "End of day check", (cs) => [...cs].reverse().find((c) => c.slot === "close" || (closeT && c.ok && U.istMinutes(Date.parse(c.at)) >= U.hhmm(closeT))), closeT || "—", closeT ? U.hhmm(closeT) : NaN));
    const lastOther = [...checks].reverse().find((c) => !["morning", "startup", "close"].includes(c.slot));
    if (lastOther) {
      const r = show("check_other", "Last extra check", () => lastOther, "", NaN);
      r.detail = `${lastOther.slot}: ${r.detail}`;
      if (r.state === "bad") r.state = "warn";
      rows.push(r);
    }
  }

  const calls = f.today();
  const excluded = calls.filter((c) => svc.flagsOf(c).excluded).length;
  rows.push({
    key: "calls", state: calls.length ? "ok" : "off", name: "Counted calls",
    detail: calls.length ? `${calls.length - excluded} counted${excluded ? ` · ${excluded} before recording, not counted` : ""}` : "No calls yet today",
    value: String(calls.length - excluded),
  });

  // Results database (parrva_results in Postgres)
  if (svc.db) {
    const d = svc.db.info();
    if (!d.enabled) rows.push({ key: "resultsdb", state: "off", name: "Results database", detail: "DATABASE_URL is not set, results are kept in files only", value: "off" });
    else if (!d.ready || (d.lastError && (!d.lastSaved || Date.parse(d.lastErrorAt) > Date.parse(d.lastSaved.at)))) {
      rows.push({ key: "resultsdb", state: "bad", name: "Results database", detail: `${d.lastError || "Not connected yet"}. Results stay in the files and are copied in when it works again.`, value: "not saving" });
    } else {
      rows.push({
        key: "resultsdb", state: "ok", name: "Results database",
        detail: d.lastSaved ? `Saved ${d.lastSaved.rows} call(s) of ${d.lastSaved.day} at ${clockS(Date.parse(d.lastSaved.at))}` : "Connected · today's results are saved after 15:31",
        value: `${d.days} day(s)`,
      });
    }
  }
  return rows;
}

/** Whole panel. `alerts` is passed in by alerts.js so the panel shows the toggle state. */
function compute(svc, alertsInfo = null, now = Date.now()) {
  const groups = [
    { key: "fyers", title: "Fyers logins", rows: fyersRows(now) },
    { key: "recorder", title: "Recorder (account 2)", rows: recorderRows(svc, now) },
    { key: "parrva", title: "PaRRVA calls", rows: parrvaRows(svc, now) },
  ];
  const all = groups.flatMap((g) => g.rows);
  const worst = all.reduce((m, r) => (RANK[r.state] > RANK[m] ? r.state : m), "off");
  let summary;
  const first = (st) => all.find((r) => r.state === st);
  if (worst === "bad" || worst === "warn") {
    const r = first(worst);
    const n = all.filter((x) => x.state === worst).length;
    summary = { state: worst, title: `${r.name}: ${r.value}`, detail: `${r.detail}${n > 1 ? ` (+${n - 1} more ${worst === "bad" ? "problem" : "warning"}${n > 2 ? "s" : ""} below)` : ""}` };
  } else {
    const info = svc.recorder.info();
    const bits = [];
    if (info.running && info.startedAt) bits.push(`Recording since ${clockS(Date.parse(info.startedAt))}`);
    bits.push(`${svc.feed.today().length} calls today`);
    const wl = svc.feed.webhook.lastCallEventAt || svc.feed.lastOkAt;
    if (wl) bits.push(`last PaRRVA update ${clockS(wl)}`);
    summary = { state: worst === "ok" ? "ok" : "off", title: worst === "ok" ? "All systems normal" : "Idle", detail: bits.join(" · ") };
  }
  return { ok: true, at: new Date(now).toISOString(), mode: svc.feed.mode(), summary, groups, alerts: alertsInfo };
}

module.exports = { compute, RANK };
