const readline = require('readline');
const fs = require('fs');
require("dotenv").config();
const { fyersModel } = require('fyers-api-v3');

const client_id = "KETLMLSN3I-100";
const secret_key = process.env.ST_KEY;
const redirect_uri = "https://trade.fyers.in/api-login/redirect-uri/index.html"
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

module.exports = { authenticate, getStoredTokens };
