// src/generate.js
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { fyersModel } = require("fyers-api-v3");

const client_id = process.env.APP_ID;
const secret_key = process.env.ST_KEY;
const redirect_uri = "https://YOUR-APP.railway.app/api/auth/callback";
const response_type = "code";
const state = "sample_state";
const grant_type = "authorization_code";

const fyers = new fyersModel({ path: "", enableLogging: false });

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function authenticate() {
  if (!client_id || !secret_key) {
    console.error("❌ APP_ID or ST_KEY missing in .env");
    process.exit(1);
  }

  console.log("\n" + "═".repeat(55));
  console.log("  Fyers Authentication");
  console.log("═".repeat(55));

  const authUrl = fyers.generateAuthCode({
    client_id,
    redirect_uri,
    response_type,
    state,
  });

  console.log("\n📌 STEP 1 — Open this URL in your browser:\n");
  console.log("  " + authUrl);
  console.log("\n📌 STEP 2 — After login, you'll be redirected to:");
  console.log("  https://trade.fyers.in/api-login/redirect-uri/index.html");
  console.log("  The page shows your authorization_code — click Copy.");
  console.log("\n📌 STEP 3 — Paste the authorization_code below\n");

  const auth_code = await prompt("▶  Paste auth_code here: ");

  if (!auth_code || auth_code.length < 10) {
    console.error("❌ Invalid auth_code entered. Try again.");
    process.exit(1);
  }

  console.log("\n⏳ Generating access token...");

  let response;
  try {
    response = await fyers.generate_access_token({
      client_id,
      secret_key,
      auth_code,
      grant_type,
    });
  } catch (err) {
    console.error("❌ Token generation failed:", err.message);
    process.exit(1);
  }

  if (response.s !== "ok") {
    console.error("❌ Fyers error:", JSON.stringify(response, null, 2));
    process.exit(1);
  }

  const { access_token, refresh_token } = response;

  const rootDir = path.resolve(__dirname, "..");
  fs.writeFileSync(path.join(rootDir, "fyers_access_token.txt"), access_token);
  if (refresh_token) {
    fs.writeFileSync(path.join(rootDir, "fyers_refresh_token.txt"), refresh_token);
  }

  // Also save to .fyers_token for server.js compatibility
  fs.writeFileSync(path.join(rootDir, ".fyers_token"), access_token);

  console.log("\n✅ Token saved successfully!");
  console.log("═".repeat(55));
  console.log("\n🚀 Now run:   npm start");
  console.log("🚀 Frontend:  cd ../frontend && npm start");
  console.log("═".repeat(55) + "\n");
}

function getStoredTokens() {
  const rootDir = path.resolve(__dirname, "..");
  const refreshTokenPath = path.join(rootDir, "fyers_refresh_token.txt");
  const accessTokenPath = path.join(rootDir, "fyers_access_token.txt");
  return {
    refresh_token: fs.existsSync(refreshTokenPath) ? fs.readFileSync(refreshTokenPath, "utf8").trim() : null,
    access_token: fs.existsSync(accessTokenPath) ? fs.readFileSync(accessTokenPath, "utf8").trim() : null,
  };
}

if (require.main === module) {
  authenticate().catch((err) => {
    console.error("💥 Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { authenticate, getStoredTokens };
