/**
 * authRouter.js
 * 
 * Handles the full daily Fyers OAuth flow:
 *   GET  /auth              → serves the daily auth HTML page
 *   GET  /api/auth/status   → is the current token valid?
 *   GET  /api/auth/url      → returns the Fyers OAuth URL
 *   GET  /api/auth/callback → Fyers redirects here with ?auth_code=xxx
 *   GET  /api/auth/token-preview → returns masked token for UI display
 *   POST /api/auth/token    → legacy: manually post an auth_code
 */

const express = require("express");
const path = require("path");
const { getAuthURL, generateToken, validateToken, loadToken } = require("./fyers");

const router = express.Router();

// ── Serve the daily auth page ──────────────────────────────────────────────
router.get("/auth", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auth.html"));
});

// ── Auth status ────────────────────────────────────────────────────────────
router.get("/api/auth/status", async (req, res) => {
  try {
    const valid = await validateToken();
    res.json({
      authenticated: valid,
      authUrl: valid ? null : getAuthURL(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auth URL (for client to redirect user) ─────────────────────────────────
router.get("/api/auth/url", (req, res) => {
  try {
    res.json({ url: getAuthURL() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/callback
 * 
 * Fyers redirects here after the user logs in and enters their PIN.
 * URL will be: https://your-app.railway.app/api/auth/callback?auth_code=XXX&state=sample_state
 * 
 * We exchange the code for a token, save it, then redirect the user
 * back to /auth so they see the green "Token valid ✓" screen.
 */
router.get("/api/auth/callback", async (req, res) => {
  const { auth_code, authCode, code, s } = req.query;
  const finalCode = auth_code || authCode || code;

  if (!finalCode) {
    return res.status(400).send(`
      <html><body style="background:#0d0d0d;color:#ff5252;font-family:sans-serif;padding:40px">
        <h2>❌ No auth_code received</h2>
        <p>Fyers did not send an auth code. <a href="/auth" style="color:#00e676">Try again</a></p>
        <pre style="color:#888;margin-top:20px">${JSON.stringify(req.query, null, 2)}</pre>
      </body></html>
    `);
  }

  // Status from Fyers — "ok" means login succeeded
  if (s && s !== "ok") {
    return res.status(400).send(`
      <html><body style="background:#0d0d0d;color:#ff5252;font-family:sans-serif;padding:40px">
        <h2>❌ Fyers returned status: ${s}</h2>
        <p><a href="/auth" style="color:#00e676">Try again</a></p>
      </body></html>
    `);
  }

  try {
    await generateToken(finalCode);
    console.log("[Auth] Token generated and saved via OAuth callback ✓");

    // Kick the tick stream — works even though server.js has the reference
    // because Node module cache means same instance
    try {
      const { maybeStartTickStream } = require("./server");
      if (typeof maybeStartTickStream === "function") {
        maybeStartTickStream().catch(() => {});
      }
    } catch {}

    res.redirect("/auth?success=1");
  } catch (err) {
    console.error("[Auth] Token generation failed:", err.message);
    res.status(500).send(`
      <html><body style="background:#0d0d0d;color:#ff5252;font-family:sans-serif;padding:40px">
        <h2>❌ Token exchange failed</h2>
        <p>${err.message}</p>
        <p><a href="/auth" style="color:#00e676">Try again</a></p>
      </body></html>
    `);
  }
});

// ── Token preview (masked) for UI ──────────────────────────────────────────
router.get("/api/auth/token-preview", (req, res) => {
  const token = loadToken();
  if (!token) return res.json({ preview: null });
  // Show first 8 and last 4 chars only
  const preview =
    token.length > 16
      ? token.slice(0, 8) + "..." + token.slice(-4)
      : token.slice(0, 4) + "...";
  res.json({ preview });
});

// ── Legacy: POST auth_code directly ───────────────────────────────────────
router.post("/api/auth/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "auth_code required" });
  try {
    await generateToken(code);
    res.json({ success: true, message: "Token saved successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
