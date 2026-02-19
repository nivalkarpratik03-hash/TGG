const readline = require('readline');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// Replace these values with your actual API credentials
const client_id = process.env.APP_ID;
const secret_key = process.env.ST_KEY;
const redirect_uri = "https://trade.fyers.in/api-login/redirect-uri/index.html";
const response_type = "code";
const state = "sample_state";
const grant_type = "authorization_code";

function generateAuthUrl() {
  const params = new URLSearchParams({
    client_id,
    redirect_uri,
    response_type,
    state,
  });
  return `https://api-t2.fyers.in/api/v3/generate-authcode?${params.toString()}`;
}

function generateToken(auth_code) {
  return new Promise((resolve, reject) => {
    const appIdHash = crypto
      .createHash('sha256')
      .update(`${client_id}:${secret_key}`)
      .digest('hex');

    const body = JSON.stringify({
      grant_type,
      appIdHash,
      code: auth_code,
    });

    const options = {
      hostname: 'api-t2.fyers.in',
      path: '/api/v3/validate-authcode',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function authenticate() {
  const authUrl = generateAuthUrl();
  console.log("Auth URL:", authUrl);
  console.log("Open the above URL in your browser to get the auth code.");

  const auth_code = await prompt("Enter Auth Code: ");

  const response = await generateToken(auth_code.trim());

  const { access_token, refresh_token } = response;

  if (!access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(response)}`);
  }

  console.log("Access Token:", access_token);
  console.log("Refresh Token:", refresh_token);

  fs.writeFileSync("fyers_client_id.txt", client_id);
  fs.writeFileSync("fyers_access_token.txt", access_token);
  fs.writeFileSync("fyers_refresh_token.txt", refresh_token);

  console.log("Tokens saved to files.");

  return { client_id, access_token, refresh_token };
}

function getStoredTokens() {
  return {
    client_id: fs.readFileSync("fyers_client_id.txt", "utf8"),
    access_token: fs.readFileSync("fyers_access_token.txt", "utf8"),
    refresh_token: fs.readFileSync("fyers_refresh_token.txt", "utf8"),
  };
}

module.exports = {
  authenticate,
  generateAuthUrl,
  generateToken,
  getStoredTokens,
};