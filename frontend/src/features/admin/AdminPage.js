// AdminPage.js
// ─────────────────────────────────────────────────────────────────────────────
// Added 2026-08-13 — the missing frontend half of the backend's Fyers auth
// flow (/api/auth/status, /api/auth/url, /api/auth/callback in chartRouter.js).
//
// Flow:
//  1. PIN gate — POSTs to /api/admin/verify-pin, which checks against PIN in
//     backend/.env server-side. The real PIN never ships in this bundle.
//     Verified state lives in sessionStorage only (clears when the tab closes).
//  2. Status card — GET /api/auth/status tells us if today's Fyers token is
//     still valid.
//  3. "Connect to Fyers" — GET /api/auth/url for the login URL, then navigates
//     the whole tab there (window.location.href, not a new tab) so that when
//     Fyers redirects back to our backend's /api/auth/callback, and the
//     backend redirects on to here, it's the same tab landing back on /admin.
//  4. On load, reads ?auth=success / ?auth=error from the URL (set by the
//     backend's redirect) and shows a banner, then strips the query string.
//
// NOTE: the auto-redirect step (3→4) only works once PUBLIC_BACKEND_URL and
// FRONTEND_URL are set in backend/.env and PUBLIC_BACKEND_URL/api/auth/callback
// is registered as the Redirect URL in the Fyers API Dashboard. Until then,
// getAuthURL() still falls back to Fyers' generic redirect page, which means
// step 3 will land the user on Fyers' page instead of bouncing back here —
// same as the old manual flow, just without a working auto-return yet.
//
// UPDATED 2026-11-05 — TWO Fyers accounts. The panel now shows one card per
// account (GET /api/auth/accounts): account 1 = Charts (the original one),
// account 2 = Recorder (second Fyers account for live snapshots). Every call a
// card makes carries ?acc=<id> (or body.acc) so each card logs in, shows status
// and expiry for its own account only. Nicknames come from NICKNAME_1/NICKNAME_2
// in backend/.env. Account 2's Redirect URL is PUBLIC_BACKEND_URL/api/auth/callback/2.

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BACKEND } from "../../config";
import { hasValidAdminToken } from "../../utils/adminAuth";
import "./AdminPage.css";

const SESSION_KEY = "tgg_admin_verified";

export default function AdminPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [verified, setVerified] = useState(() => sessionStorage.getItem(SESSION_KEY) === "1" && hasValidAdminToken());
  const [authMode, setAuthMode] = useState(null);   // "credentials" | "pin" | "none" (asked from the server)
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");   // holds the password in credentials mode
  const [pinError, setPinError] = useState("");
  const [pinLoading, setPinLoading] = useState(false);

  // Banner from the backend's redirect (?auth=success|error&acc=<id>), shown on that account's card.
  const [redirectBanner] = useState(() => {
    const auth = searchParams.get("auth");
    if (!auth) return null;
    const acc = Number(searchParams.get("acc") || 1);
    return auth === "success"
      ? { acc, type: "success", msg: "Connected to Fyers — token saved." }
      : { acc, type: "error", msg: searchParams.get("msg") || "Fyers connection failed." };
  });
  const [accounts, setAccounts] = useState(null);   // [{ id, role, nickname, configured }]

  // Strip the query string so a refresh doesn't re-show the banner.
  useEffect(() => {
    if (searchParams.get("auth")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!verified) return;
    fetch(`${BACKEND}/api/auth/accounts`)
      .then((r) => r.json())
      .then((d) => setAccounts(Array.isArray(d.accounts) && d.accounts.length ? d.accounts : [{ id: 1, role: "Charts", nickname: "Account 1", configured: true }]))
      // Older backend without /api/auth/accounts: show just the original account.
      .catch(() => setAccounts([{ id: 1, role: "Charts", nickname: "Account 1", configured: true }]));
  }, [verified]);

  // Ask the server which login to show (username+password, or the legacy PIN).
  useEffect(() => {
    if (verified) return;
    fetch(`${BACKEND}/api/admin/auth-mode`)
      .then((r) => r.json())
      .then((d) => setAuthMode(d.mode || "pin"))
      .catch(() => setAuthMode("pin"));
  }, [verified]);

  async function submitPin(e) {
    e.preventDefault();
    setPinError("");
    setPinLoading(true);
    const creds = authMode === "credentials";
    try {
      const res = await fetch(`${BACKEND}/api/admin/${creds ? "login" : "verify-pin"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds ? { username, password: pin } : { pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.token) {
        sessionStorage.setItem(SESSION_KEY, "1");
        sessionStorage.setItem("tgg_admin_token", data.token);   // signed, expiring token — see utils/adminAuth.js
        setVerified(true);
      } else if (res.status === 429) {
        setPinError(data.error || "Too many attempts. Try again later.");
      } else {
        // Show the server's real reason (wrong credentials, locked, or a server config problem).
        setPinError(data.error || (creds ? "Invalid username or password" : "Incorrect PIN"));
      }
    } catch (err) {
      setPinError("Could not reach backend: " + err.message);
    } finally {
      setPinLoading(false);
      setPin("");
    }
  }

  function logoutAdmin() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem("tgg_admin_token");
    setVerified(false);
  }

  // ── PIN gate ───────────────────────────────────────────────────────────────
  if (!verified) {
    return (
      <div className="admin-page admin-gate">
        <form className="admin-card" onSubmit={submitPin}>
          <h1>Admin</h1>
          <p className="admin-sub">
            {authMode === "credentials"
              ? "Sign in with your admin account to manage the Fyers connection."
              : "Enter the admin PIN to manage the Fyers connection."}
          </p>
          {authMode === "credentials" && (
            <input
              type="text"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="admin-input"
            />
          )}
          <input
            type="password"
            inputMode={authMode === "credentials" ? "text" : "numeric"}
            autoFocus={authMode !== "credentials"}
            autoComplete={authMode === "credentials" ? "current-password" : "off"}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={authMode === "credentials" ? "Password" : "PIN"}
            className="admin-input"
          />
          {pinError && <div className="admin-error">{pinError}</div>}
          <button type="submit" className="admin-btn" disabled={pinLoading || !pin || (authMode === "credentials" && !username)}>
            {pinLoading ? "Checking…" : authMode === "credentials" ? "Sign in" : "Unlock"}
          </button>
          <button type="button" className="admin-link" onClick={() => navigate("/")}>
            ← Back to app
          </button>
        </form>
      </div>
    );
  }

  // ── Main admin panel: one card per Fyers account ─────────────────────────
  return (
    <div className="admin-page admin-page-multi">
      <div className="admin-multi">
        <div className="admin-header admin-multi-header">
          <h1>Fyers Connections</h1>
          <div className="admin-header-actions">
            <button className="admin-link" onClick={() => navigate("/")}>← App</button>
            <button className="admin-link" onClick={logoutAdmin}>Lock</button>
          </div>
        </div>
        <div className="admin-accounts">
          {!accounts
            ? <div className="admin-card admin-card-wide"><p className="admin-sub">Loading accounts…</p></div>
            : accounts.map((a) => (
              <FyersAccountCard
                key={a.id}
                account={a}
                initialBanner={redirectBanner && redirectBanner.acc === a.id ? redirectBanner : null}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

const fmtIST = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
function fmtLeft(ms) {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}

// Accepts either a bare auth_code or the full pasted redirect URL
// (…?s=ok&code=200&auth_code=XXXX) — extracts the code either way, so the
// user can copy-paste the whole address bar without editing it first.
function extractAuthCode(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("auth_code") || url.searchParams.get("code") || trimmed;
  } catch {
    return trimmed; // not a URL — assume it's the raw code
  }
}

/** One Fyers account: status, expiry, Generate button and manual auth_code box. */
function FyersAccountCard({ account, initialBanner }) {
  const acc = account.id;
  const q = `acc=${acc}`;
  const [status, setStatus] = useState(null); // { authenticated, authUrl, tokenInfo }
  const [statusLoading, setStatusLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState(initialBanner ? { type: initialBanner.type, msg: initialBanner.msg } : null);
  // Set when a valid token already exists and the user clicked Connect/Reconnect:
  // we ask "token already generated - create another?" before opening Fyers.
  const [confirmNew, setConfirmNew] = useState(null); // tokenInfo | null
  const [now, setNow] = useState(Date.now());          // ticks every 30s for the expiry countdown
  // Manual fallback: paste the auth_code from Fyers' generic redirect page.
  const [manualCode, setManualCode] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/auth/status?${q}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ authenticated: false, error: err.message });
    } finally {
      setStatusLoading(false);
    }
  }, [q]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Live expiry countdown: tick every 30s, and re-check status the moment the token lapses
  // so the pill flips from "Connected" to "Token expired" without a manual refresh.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const exp = status?.tokenInfo?.expiresAt;
      if (status?.authenticated && exp && new Date(exp).getTime() <= t) fetchStatus();
    }, 30000);
    return () => clearInterval(id);
  }, [status, fetchStatus]);

  // force=false: the server answers 409 if a valid token already exists -> ask first.
  // force=true : user confirmed they want another token.
  async function connectToFyers(force = false) {
    setConnecting(true);
    setConfirmNew(null);
    try {
      const res = await fetch(`${BACKEND}/api/auth/url?${q}${force ? "&force=true" : ""}`);
      const data = await res.json();
      if (res.status === 409 && data.alreadyAuthenticated) {
        setConfirmNew(data.tokenInfo || {});
        return;
      }
      if (data.url) {
        // Opens in a new tab so this page (and the manual-paste box) stays open.
        // With PUBLIC_BACKEND_URL wired up, Fyers bounces that tab back to /admin?auth=success.
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else {
        setBanner({ type: "error", msg: data.error || "Could not get Fyers login URL." });
      }
    } catch (err) {
      setBanner({ type: "error", msg: err.message });
    } finally {
      setConnecting(false);
    }
  }

  async function submitManualCode(e) {
    e.preventDefault();
    const code = extractAuthCode(manualCode);
    if (!code) return;
    setManualSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch(`${BACKEND}/api/auth/token?${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, acc }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setBanner({ type: "success", msg: "Connected to Fyers — token saved." });
        setManualCode("");
        fetchStatus();
      } else {
        setBanner({ type: "error", msg: data.error || "Token exchange failed." });
      }
    } catch (err) {
      setBanner({ type: "error", msg: err.message });
    } finally {
      setManualSubmitting(false);
    }
  }

  const nickname = status?.account?.nickname || account.nickname;
  const role = status?.account?.role || account.role;
  const configured = status?.account ? status.account.configured : account.configured;
  const roleNote = acc === 1
    ? "Used for charts, live ticks, gap-fill and data export."
    : "Used only for recording live snapshots (50-level depth). Never touches the charts account.";

  return (
    <div className="admin-card admin-card-wide admin-account-card">
      <div className="admin-header">
        <h1>{nickname}</h1>
        <span className={`admin-role-chip admin-role-${acc === 1 ? "charts" : "recorder"}`}>{acc}. {role}</span>
      </div>
      <p className="admin-sub admin-role-note">{roleNote}</p>

      {banner && (
        <div className={`admin-banner admin-banner-${banner.type}`}>
          {banner.msg}
          <button className="admin-banner-close" onClick={() => setBanner(null)}>×</button>
        </div>
      )}

      {!configured ? (
        <div className="admin-note" style={{ marginTop: 0 }}>
          <strong>Not configured.</strong> Add <code>APP_ID_{acc}</code> and <code>ST_KEY_{acc}</code> (and{" "}
          <code>NICKNAME_{acc}</code>) to the backend's <code>.env</code>, register{" "}
          <code>PUBLIC_BACKEND_URL/api/auth/callback/{acc}</code> as this Fyers app's Redirect URL, then restart the backend.
        </div>
      ) : (
        <>
          <div className="admin-status-row">
            <span className="admin-status-label">Status:</span>
            {statusLoading ? (
              <span className="admin-status-pill admin-status-pending">Checking…</span>
            ) : status?.authenticated ? (
              <span className="admin-status-pill admin-status-ok">Connected</span>
            ) : status?.tokenInfo?.exists && status.tokenInfo.expired ? (
              <span className="admin-status-pill admin-status-bad">Token expired</span>
            ) : (
              <span className="admin-status-pill admin-status-bad">Not connected</span>
            )}
            <button className="admin-link" onClick={fetchStatus} disabled={statusLoading}>
              Refresh
            </button>
          </div>

          <p className="admin-sub">
            {status?.authenticated
              ? "A token has already been generated and is valid."
              : status?.tokenInfo?.exists && status.tokenInfo.expired
                ? "The saved token has expired. Connect below to generate a new one — Fyers access tokens expire daily."
                : "No valid token. Connect below to authenticate — Fyers access tokens expire daily."}
          </p>

          {status?.tokenInfo?.exists && (() => {
            const t = status.tokenInfo;
            const left = new Date(t.expiresAt).getTime() - now;
            const soon = left > 0 && left < 60 * 60 * 1000;
            return (
              <div className="admin-token-info" style={{ margin: "8px 0 12px", fontSize: 13, lineHeight: 1.6 }}>
                <div>Token generated: <strong>{fmtIST(t.issuedAt)}</strong></div>
                <div>
                  Expires{t.source === "estimated" ? " (estimated)" : ""}: <strong>{fmtIST(t.expiresAt)}</strong>
                  {" "}— <strong style={{ color: left <= 0 ? "#e5484d" : soon ? "#f5a524" : "inherit" }}>{fmtLeft(left)}</strong>
                </div>
                {left <= 0 && <div style={{ color: "#e5484d" }}>Token expired — reconnect to resume.</div>}
                {soon && <div style={{ color: "#f5a524" }}>Token expires within the hour. Reconnect before it lapses.</div>}
              </div>
            );
          })()}

          {confirmNew && (
            <div className="admin-banner admin-banner-error" style={{ display: "block" }}>
              <strong>A token is already generated and still valid.</strong>
              {confirmNew.expiresAt ? <> It was created {fmtIST(confirmNew.issuedAt)} and expires {fmtIST(confirmNew.expiresAt)}.</> : null}
              {" "}Do you want to create one more token?
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button className="admin-btn admin-btn-primary" onClick={() => connectToFyers(true)}>Yes, create new token</button>
                <button className="admin-btn" onClick={() => setConfirmNew(null)}>Cancel</button>
              </div>
            </div>
          )}

          <button className="admin-btn admin-btn-primary" onClick={() => connectToFyers(false)} disabled={connecting}>
            {connecting ? "Opening Fyers…" : status?.authenticated ? "Generate new token" : `Log in as ${nickname}`}
          </button>

          <form className="admin-manual-form" onSubmit={submitManualCode}>
            <label className="admin-manual-label">
              Landed on Fyers' generic page instead of back here? Paste the <code>auth_code</code>{" "}
              (or the whole page URL) below:
            </label>
            <div className="admin-manual-row">
              <input
                type="text"
                className="admin-input admin-input-inline"
                placeholder="Paste auth_code or full URL"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
              />
              <button
                type="submit"
                className="admin-btn admin-btn-secondary"
                disabled={manualSubmitting || !manualCode.trim()}
              >
                {manualSubmitting ? "Submitting…" : "Submit"}
              </button>
            </div>
          </form>

          {acc === 2 && <RecorderPanel />}

          <div className="admin-note">
            <strong>Redirect URL for this Fyers app:</strong>{" "}
            <code>PUBLIC_BACKEND_URL/api/auth/callback{acc === 1 ? "" : `/${acc}`}</code>. If it isn't registered
            in the Fyers API Dashboard you'll land on Fyers' generic page and need to paste the <code>auth_code</code> above.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Recorder status + Start / Stop (2026-11-05). Shown on the account-2 card.
 * Reads GET /api/parrva/recorder every 5 s; POST /api/parrva/recorder {mode} needs the admin login.
 */
function RecorderPanel() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/parrva/recorder`);
      const d = await r.json();
      setInfo(d);
    } catch (e) {
      setInfo(null);
      setErr(`Could not read recorder status: ${e.message}`);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  async function setMode(mode) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${BACKEND}/api/parrva/recorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) setErr(d.error || `Failed (HTTP ${r.status})`);
      setTimeout(load, 1500);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <div className="admin-rec">{err || "Loading recorder status…"}</div>;
  const ageS = info.lastTickAt ? Math.round((now - new Date(info.lastTickAt).getTime()) / 1000) : null;
  const pill = info.recording && ageS !== null && ageS < 30
    ? ["ok", "Recording"]
    : info.running
      ? ["pending", info.dataConnected ? "Connected, waiting for ticks" : "Starting…"]
      : ["bad", "Not recording"];
  const c = info.counts || {};
  const fmtN = (x) => (Number(x) || 0).toLocaleString("en-IN");
  const modeText = info.mode === "auto" ? `Auto (${info.schedule})` : info.mode === "manual-on" ? "Started by hand (today)" : info.mode === "manual-off" ? "Stopped by hand (today)" : "Auto start is off";

  return (
    <div className="admin-rec">
      <div className="admin-rec-head">
        <strong>Recorder</strong>
        <span className={`admin-status-pill admin-status-${pill[0]}`}>{pill[1]}</span>
      </div>
      <div className="admin-rec-grid">
        <span>Mode</span><span>{modeText}</span>
        <span>Last tick</span><span>{ageS === null ? "—" : ageS < 2 ? "just now" : `${ageS}s ago`}</span>
        <span>Saved</span><span>{fmtN(c.quotes)} quotes · {fmtN(c.depth5)} depth-5 · {fmtN(c.depth50)} depth-50{c.errors ? ` · ${fmtN(c.errors)} errors` : ""}</span>
        <span>50-level</span><span>{!info.tbtEnabled ? "off" : info.tbtConnected ? `live: future + ATM pair${(info.tbtSymbols || []).length ? ` + up to 2 of ${info.tbtSymbols.length} open PaRRVA calls` : ""}` : info.running ? "connecting…" : "—"}</span>
        <span>PaRRVA</span><span className="admin-rec-syms">{(info.symbols || []).length ? info.symbols.join(", ") : "— (PaRRVA calls of today appear here)"}</span>
        {info.fut && <><span>Recording</span><span className="admin-rec-syms">{info.fut} · ATM {info.atm || "—"} · expiry {info.expiry || "—"} · {info.tracked || 0} symbols (index, future, ATM ±6, PaRRVA calls)</span></>}
        <span>Folder</span><span className="admin-rec-syms">{info.outDir}</span>
        <span>Parquet</span><span>{info.exporting || info.stopping ? "writing index / futures / options.parquet…" : info.lastExport ? (info.lastExport.ok ? `written ${new Date(info.lastExport.at).toLocaleTimeString("en-IN")}${info.lastExport.files ? " · " + info.lastExport.files.map((f) => `${f.file} ${fmtN(f.rows)} rows`).join(" · ") : ""}` : `failed${info.lastExport.error ? ": " + info.lastExport.error : ""}`) : "written automatically when the recorder stops after 15:25"}</span>
        {!info.running && info.lastExit && <><span>Last stop</span><span>{info.lastExit.why}{info.lastExit.code !== null && info.lastExit.code !== undefined ? ` (exit code ${info.lastExit.code})` : ""}{info.lastExit.at ? ` at ${new Date(info.lastExit.at).toLocaleTimeString("en-IN")}` : ""}</span></>}
        {!info.accountReady && <><span>Note</span><span style={{ color: "#f5a524" }}>Log in this account first — the recorder only runs with a valid token.</span></>}
      </div>
      {(info.log || []).length > 0 && (
        <details className="admin-rec-log" open={!info.recording}>
          <summary>Recorder log (last {Math.min(8, info.log.length)} lines)</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: "6px 0", opacity: 0.85 }}>{info.log.slice(-8).join("\n")}</pre>
        </details>
      )}
      {err && <div className="admin-error" style={{ margin: "8px 0" }}>{err}</div>}
      <div className="admin-rec-actions">
        <button className="admin-btn admin-btn-primary" disabled={busy || info.running || !info.accountReady} onClick={() => setMode("on")}>Start now</button>
        <button className="admin-btn" disabled={busy || !info.running} onClick={() => setMode("off")}>Stop</button>
        <button className="admin-btn" disabled={busy || info.mode === "auto"} onClick={() => setMode("auto")} title="Go back to the automatic schedule">Auto</button>
        <button className="admin-btn" disabled={busy || info.exporting || info.stopping} onClick={() => setMode("export")} title="Write today's 3 Parquet files now (stops the recorder first if it is running)">Export Parquet</button>
      </div>
    </div>
  );
}
