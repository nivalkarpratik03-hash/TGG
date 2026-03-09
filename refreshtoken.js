const readline = require('readline');
const fs = require('fs');
require("dotenv").config();
const { fyersModel } = require('fyers-api-v3');

const client_id = "KETLMLSN3I-100";
const secret_key = process.env.ST_KEY;
const redirect_uri = "https://trade.fyers.in/api-login/redirect-uri/index.html";
const response_type = "code";
const state = "sample_state";
const grant_type = "authorization_code";

const fyers = new fyersModel({
  path: "",
  enableLogging: false
});

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function authenticate() {
  // Step 1: Generate the auth URL (equivalent to session.generate_authcode())
  const authUrl = fyers.generateAuthCode({
    client_id,
    redirect_uri,
    response_type,
    state,
  });

  console.log("Auth URL:", authUrl);
  console.log("Open the above URL in your browser and copy the auth_code from the redirect.");

  // Step 2: Get auth code from user
  const auth_code = await prompt("Enter Auth Code: ");

  // Step 3: Exchange auth code for tokens (equivalent to session.set_token() + session.generate_token())
  const response = await fyers.generate_access_token({
    client_id,
    secret_key,
    auth_code: auth_code.trim(),
    grant_type,
  });

  if (response.s !== 'ok') {
    throw new Error(`Failed to get access token: ${JSON.stringify(response)}`);
  }

  const { access_token, refresh_token } = response;

  console.log("Access Token:", access_token);
  console.log("Refresh Token:", refresh_token);

  fs.writeFileSync("fyers_client_id.txt", client_id);
  fs.writeFileSync("fyers_access_token.txt", access_token);
  fs.writeFileSync("fyers_refresh_token.txt", refresh_token);

  console.log("Tokens saved to files.");

  fyers.setAccessToken(access_token);

  return { client_id, access_token, refresh_token };
}

function getStoredTokens() {
  return {
    client_id: fs.readFileSync("fyers_client_id.txt", "utf8"),
    access_token: fs.readFileSync("fyers_access_token.txt", "utf8"),
    refresh_token: fs.readFileSync("fyers_refresh_token.txt", "utf8"),
  };
}
authenticate()
module.exports = { authenticate, getStoredTokens };




// /**
//  * Fyers Full Auth Flow
//  * Run ONCE to get refresh + access token
//  * Usage: node fyersAuth.js
//  */

// const axios = require("axios");
// const crypto = require("crypto");
// const fs = require("fs");
// const readline = require("readline");

// // ─── YOUR CREDENTIALS ─────────────────────────────────────
// // app_id = KETLMLSN3I-100
// // app_secret = W90SPVLTRD
// const CLIENT_ID = "WKM8OG4534-100";
// const SECRET_KEY = "E72KYW8KR3";
// const REDIRECT_URI = "https://trade.fyers.in/api-login/redirect-uri/index.html";
// // ──────────────────────────────────────────────────────────

// const appIdHash = crypto
//   .createHash("sha256")
//   .update(`${CLIENT_ID}:${SECRET_KEY}`)
//   .digest("hex");

// const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// const ask = (q) => new Promise((res) => rl.question(q, res));

// (async () => {
//   // STEP 1: Print auth URL
//   const authUrl =
//     `https://api-t1.fyers.in/api/v3/generate-authcode` +
//     `?client_id=${CLIENT_ID}` +
//     `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
//     `&response_type=code` +
//     `&state=sample_state`;

//   console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
//   console.log("STEP 1: Open this URL in your browser:\n");
//   console.log(authUrl);
//   console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
//   console.log("STEP 2: Login → after redirect, copy the");
//   console.log("        'auth_code' value from the URL");
//   console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

//   const authCode = (await ask("Paste auth_code here: ")).trim();
//   rl.close();

//   // STEP 2: Exchange auth code for tokens
//   try {
//     const res = await axios.post(
//       "https://api-t1.fyers.in/api/v3/validate-authcode",
//       { grant_type: "authorization_code", appIdHash, code: authCode },
//       { headers: { "Content-Type": "application/json" } }
//     );

//     const { access_token, refresh_token } = res.data;

//     if (!access_token) {
//       console.error("❌ Failed:", res.data);
//       return;
//     }

//     // Save all files
//     fs.writeFileSync("fyers_client_id.txt", CLIENT_ID);
//     fs.writeFileSync("fyers_access_token.txt", access_token);
//     fs.writeFileSync("fyers_refresh_token.txt", refresh_token || "");

//     console.log("\n✅ All tokens saved!");
//     console.log("📄 fyers_client_id.txt");
//     console.log("📄 fyers_access_token.txt");
//     console.log("📄 fyers_refresh_token.txt");
//     console.log("\n🔑 Access Token :", access_token);
//     console.log("🔄 Refresh Token:", refresh_token);
//     console.log("\n👉 Now run: node index.js");

//   } catch (err) {
//     console.error("❌ Error:", err.response?.data || err.message);
//   }
// })();