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

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BACKEND } from "../../config";
import "./AdminPage.css";

const SESSION_KEY = "tgg_admin_verified";

export default function AdminPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [verified, setVerified] = useState(() => sessionStorage.getItem(SESSION_KEY) === "1");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinLoading, setPinLoading] = useState(false);

  const [status, setStatus] = useState(null); // { authenticated, authUrl }
  const [statusLoading, setStatusLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'success'|'error', msg }
  // Set when a valid token already exists and the user clicked Connect/Reconnect:
  // we ask "token already generated - create another?" before opening Fyers.
  const [confirmNew, setConfirmNew] = useState(null); // tokenInfo | null
  const [now, setNow] = useState(Date.now());          // ticks every 30s for the expiry countdown

  // Added 2026-08-13 — manual fallback for when the auto-redirect isn't wired
  // up yet (PUBLIC_BACKEND_URL/FRONTEND_URL unset, or not registered as the
  // Fyers app's Redirect URL). User pastes the auth_code shown on Fyers'
  // generic redirect page and this POSTs it to /api/auth/token directly —
  // same endpoint generate.js's CLI prompt used to call.
  const [manualCode, setManualCode] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // ── Read ?auth=success/error from the backend's redirect, once ───────────
  useEffect(() => {
    const auth = searchParams.get("auth");
    if (!auth) return;
    if (auth === "success") {
      setBanner({ type: "success", msg: "Connected to Fyers — token saved." });
    } else if (auth === "error") {
      setBanner({ type: "error", msg: searchParams.get("msg") || "Fyers connection failed." });
    }
    // Strip the query string so a refresh doesn't re-show the banner.
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/auth/status`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ authenticated: false, error: err.message });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (verified) fetchStatus();
  }, [verified, fetchStatus]);

  // Live expiry countdown: tick every 30s, and re-check status the moment the token lapses
  // so the pill flips from "Connected" to "Token expired" without a manual refresh.
  useEffect(() => {
    if (!verified) return undefined;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const exp = status?.tokenInfo?.expiresAt;
      if (status?.authenticated && exp && new Date(exp).getTime() <= t) fetchStatus();
    }, 30000);
    return () => clearInterval(id);
  }, [verified, status, fetchStatus]);

  async function submitPin(e) {
    e.preventDefault();
    setPinError("");
    setPinLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/admin/verify-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        sessionStorage.setItem(SESSION_KEY, "1");
        sessionStorage.setItem("tgg_admin_token", data.token);   // signed, expiring token — see utils/adminAuth.js
        setVerified(true);
      } else {
        setPinError(data.error || "Incorrect PIN");
      }
    } catch (err) {
      setPinError("Could not reach backend: " + err.message);
    } finally {
      setPinLoading(false);
      setPin("");
    }
  }

  const fmtIST = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
  function fmtLeft(ms) {
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
  }

  // force=false: the server answers 409 if a valid token already exists -> ask first.
  // force=true : user confirmed they want another token.
  async function connectToFyers(force = false) {
    setConnecting(true);
    setConfirmNew(null);
    try {
      const res = await fetch(`${BACKEND}/api/auth/url${force ? "?force=true" : ""}`);
      const data = await res.json();
      if (res.status === 409 && data.alreadyAuthenticated) {
        setConfirmNew(data.tokenInfo || {});
        return;
      }
      if (data.url) {
        // CHANGED 2026-08-13: was window.location.href (full-tab nav, for the
        // auto-redirect-back flow). Now opens in a new tab instead — keeps
        // /admin open in this tab so the manual-paste box below is still
        // right there when you copy the auth_code. If/when the auto-redirect
        // (PUBLIC_BACKEND_URL) is wired up, Fyers will bounce that NEW tab
        // back to /admin?auth=success — just hit "Refresh" here afterward,
        // or close that tab and refresh this one.
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

  function logoutAdmin() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem("tgg_admin_token");
    setVerified(false);
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

  async function submitManualCode(e) {
    e.preventDefault();
    const code = extractAuthCode(manualCode);
    if (!code) return;
    setManualSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch(`${BACKEND}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
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

  // ── PIN gate ───────────────────────────────────────────────────────────────
  if (!verified) {
    return (
      <div className="admin-page admin-gate">
        <form className="admin-card" onSubmit={submitPin}>
          <h1>Admin</h1>
          <p className="admin-sub">Enter the admin PIN to manage the Fyers connection.</p>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            className="admin-input"
          />
          {pinError && <div className="admin-error">{pinError}</div>}
          <button type="submit" className="admin-btn" disabled={pinLoading || !pin}>
            {pinLoading ? "Checking…" : "Unlock"}
          </button>
          <button type="button" className="admin-link" onClick={() => navigate("/")}>
            ← Back to app
          </button>
        </form>
      </div>
    );
  }

  // ── Main admin panel ─────────────────────────────────────────────────────
  return (
    <div className="admin-page">
      <div className="admin-card admin-card-wide">
        <div className="admin-header">
          <h1>Fyers Connection</h1>
          <div className="admin-header-actions">
            <button className="admin-link" onClick={() => navigate("/")}>← App</button>
            <button className="admin-link" onClick={logoutAdmin}>Lock</button>
          </div>
        </div>

        {banner && (
          <div className={`admin-banner admin-banner-${banner.type}`}>
            {banner.msg}
            <button className="admin-banner-close" onClick={() => setBanner(null)}>×</button>
          </div>
        )}

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
            ? "A token has already been generated and is valid. Tick data and the tick stream should be flowing normally."
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
              {left <= 0 && <div style={{ color: "#e5484d" }}>Token expired — chart data from Fyers and live ticks will stop until you reconnect.</div>}
              {soon && <div style={{ color: "#f5a524" }}>Token expires within the hour. Reconnect before it lapses to avoid a gap in live data.</div>}
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
          {connecting ? "Opening Fyers…" : status?.authenticated ? "Generate new token" : "Connect to Fyers"}
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

        <div className="admin-note">
          <strong>Note:</strong> this button only auto-returns you here if{" "}
          <code>PUBLIC_BACKEND_URL</code> and <code>FRONTEND_URL</code> are set in the
          backend's <code>.env</code>, and <code>PUBLIC_BACKEND_URL/api/auth/callback</code> is
          registered as the Redirect URL in the Fyers API Dashboard. Otherwise you'll land on
          Fyers' generic redirect page and need to copy the <code>auth_code</code> manually.
        </div>
      </div>
    </div>
  );
}