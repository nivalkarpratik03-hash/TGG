/**
 * backend/src/fyers/accounts.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two Fyers accounts side by side, each with its own app, token file and login.
 *
 *   Account 1 = "Charts"   - the existing account. Everything is delegated to
 *               fyers/client.js unchanged (APP_ID, ST_KEY, fyers_access_token.txt),
 *               so charts / tick stream / gap-fill keep working exactly as before.
 *   Account 2 = "Recorder" - the second Fyers account used only for recording
 *               live snapshots (50-level depth etc.). It never touches account 1's
 *               token and never restarts the chart tick stream.
 *
 * ENV (account 2 is optional - if APP_ID_2 is not set the card shows "Not configured")
 *   NICKNAME_1      label for account 1 on the Admin page (default "Account 1")
 *   APP_ID_2        Fyers app id of the second account's API app (e.g. XXXXXXX-100)
 *   ST_KEY_2        secret key of that app
 *   NICKNAME_2      label for account 2 (default "Account 2")
 *   REDIRECT_URI_2  optional. If set it is used exactly as written (e.g. Fyers' generic page
 *                   https://trade.fyers.in/api-login/redirect-uri/index.html -> copy the auth_code
 *                   and paste it on the Admin card). If not set and PUBLIC_BACKEND_URL is set, the
 *                   redirect is PUBLIC_BACKEND_URL/api/auth/callback/2 (automatic return).
 *                   Whatever is used must equal the Redirect URL registered in account 2's Fyers app.
 *
 * Token files live in FYERS_TOKEN_DIR (or backend/), account 2 = fyers_access_token_2.txt.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { fyersModel } = require("fyers-api-v3");
const client = require("./client");

const ROOT = process.env.FYERS_TOKEN_DIR
  ? path.resolve(process.env.FYERS_TOKEN_DIR)
  : path.resolve(__dirname, "../..");

const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");

function rejectAfter(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`[Fyers] ${label} timed out after ${ms}ms`)), ms));
}

/** Issued / expiry info for a raw token string, WITHOUT exposing the token. Same rules as client.getTokenInfo(). */
function tokenInfoFor(token, file) {
  if (!token) return { exists: false };
  const nowSec = Math.floor(Date.now() / 1000);
  let issuedSec = null, expSec = null, source = "estimated";
  try {
    const part = token.split(".")[1];
    if (part) {
      const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
      if (typeof payload.exp === "number") { expSec = payload.exp; source = "jwt"; }
      if (typeof payload.iat === "number") issuedSec = payload.iat;
    }
  } catch { /* estimate below */ }
  if (issuedSec == null) {
    try { issuedSec = Math.floor(fs.statSync(file).mtimeMs / 1000); } catch { issuedSec = nowSec; }
  }
  if (expSec == null) {
    const t = issuedSec + 19800;
    let cand = Math.floor(t / 86400) * 86400 + 6 * 3600;   // next 06:00 IST
    if (cand <= t) cand += 86400;
    expSec = cand - 19800;
  }
  return {
    exists: true, source,
    issuedAt: new Date(issuedSec * 1000).toISOString(),
    expiresAt: new Date(expSec * 1000).toISOString(),
    secondsLeft: Math.max(0, expSec - nowSec),
    expired: expSec <= nowSec,
  };
}

/** A self-contained Fyers account (own app id, secret, token file, redirect). Used for account 2. */
function makeAccount({ id, role, appIdEnv, secretEnv, nicknameEnv, redirectEnv, tokenFileName, callbackPath }) {
  const tokenFile = path.join(ROOT, tokenFileName);
  const appId = () => clean(process.env[appIdEnv]);
  const secretKey = () => clean(process.env[secretEnv]);

  // Priority: REDIRECT_URI_2 (used exactly as written, e.g. Fyers' generic page for copy-paste)
  //        -> PUBLIC_BACKEND_URL + /api/auth/callback/2 (automatic return)
  //        -> Fyers' generic page.
  function redirectUri() {
    const manual = clean(process.env[redirectEnv]);
    if (manual) return manual;
    const pub = clean(process.env.PUBLIC_BACKEND_URL);
    if (pub) return `${pub.replace(/\/$/, "")}${callbackPath}`;
    return "https://trade.fyers.in/api-login/redirect-uri/index.html";
  }

  function loadToken() {
    try { return fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() || null : null; } catch { return null; }
  }

  function saveToken(token) {
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const tmp = tokenFile + ".tmp";
    fs.writeFileSync(tmp, String(token).trim(), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, tokenFile);
  }

  function getClient() {
    const token = loadToken();
    if (!token) throw new Error(`No access token for ${nickname()}. Log in on the Admin page.`);
    if (!appId()) throw new Error(`${appIdEnv} missing in .env`);
    const f = new fyersModel({ path: "", enableLogging: false });
    f.setAppId(appId());
    f.setRedirectUrl(redirectUri());
    f.setAccessToken(token);
    return f;
  }

  const nickname = () => clean(process.env[nicknameEnv]) || `Account ${id}`;

  // validateToken is cached for 60s so the Admin page polling never hammers Fyers.
  let cache = { at: 0, token: null, ok: false };
  async function validateToken() {
    const token = loadToken();
    if (!token || !appId()) return false;
    if (cache.token === token && Date.now() - cache.at < 60000) return cache.ok;
    let ok = false;
    try {
      const res = await Promise.race([getClient().get_profile(), rejectAfter(8000, `validateToken(acc ${id})`)]);
      ok = !!(res && res.s === "ok");
    } catch (err) {
      console.warn(`[Fyers acc ${id}] validateToken failed:`, err.message);
    }
    cache = { at: Date.now(), token, ok };
    return ok;
  }

  function getAuthURL() {
    if (!appId()) throw new Error(`${appIdEnv} not set in .env`);
    const f = new fyersModel({ path: "", enableLogging: false });
    return f.generateAuthCode({ client_id: appId(), redirect_uri: redirectUri(), response_type: "code", state: `acc${id}` });
  }

  async function generateToken(authCode) {
    if (!appId() || !secretKey()) throw new Error(`${appIdEnv} / ${secretEnv} missing in .env`);
    const f = new fyersModel({ path: "", enableLogging: false });
    const response = await f.generate_access_token({ client_id: appId(), secret_key: secretKey(), auth_code: authCode, grant_type: "authorization_code" });
    if (response.s !== "ok") throw new Error("Token exchange failed: " + JSON.stringify(response));
    saveToken(response.access_token);
    cache = { at: 0, token: null, ok: false };
    return response.access_token;
  }

  return {
    id, role, nickname,
    configured: () => !!(appId() && secretKey()),
    redirectUri, loadToken, getClient, validateToken, getAuthURL, generateToken,
    getTokenInfo: () => tokenInfoFor(loadToken(), tokenFile),
    tokenFile,
    bustCache: () => { cache = { at: 0, token: null, ok: false }; },
    isPrimary: false,
  };
}

// Account 1 delegates to the existing client.js so nothing about the chart account changes.
const account1 = {
  id: 1, role: "Charts",
  nickname: () => clean(process.env.NICKNAME_1) || "Account 1",
  configured: () => !!(clean(process.env.APP_ID) && clean(process.env.ST_KEY)),
  redirectUri: client.getRedirectUri,
  loadToken: client.loadToken,
  validateToken: client.validateToken,      // server.js passes state.validateToken (cached) to the router for acc 1
  getAuthURL: client.getAuthURL,
  generateToken: client.generateToken,
  getTokenInfo: client.getTokenInfo,
  bustCache: () => {},
  isPrimary: true,
};

const account2 = makeAccount({
  id: 2, role: "Recorder",
  appIdEnv: "APP_ID_2", secretEnv: "ST_KEY_2", nicknameEnv: "NICKNAME_2", redirectEnv: "REDIRECT_URI_2",
  tokenFileName: "fyers_access_token_2.txt", callbackPath: "/api/auth/callback/2",
});

const ACCOUNTS = { 1: account1, 2: account2 };

/** Account by id ("1"/"2"/1/2/undefined). Missing or unknown = account 1 so old callers keep working. Returns null for a bad id. */
function getAccount(id) {
  if (id === undefined || id === null || id === "") return account1;
  return ACCOUNTS[String(id).replace(/^acc/, "")] || null;
}

/** Short public description of every account (no secrets, no tokens). */
function listAccounts() {
  return Object.values(ACCOUNTS).map((a) => ({ id: a.id, role: a.role, nickname: a.nickname(), configured: a.configured() }));
}
module.exports = { getAccount, listAccounts, account1, account2, tokenInfoFor };
