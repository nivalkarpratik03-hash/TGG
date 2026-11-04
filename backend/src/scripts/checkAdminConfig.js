#!/usr/bin/env node
/**
 * Checks backend/.env for admin-login problems WITHOUT printing any secret.
 *
 *   node src/scripts/checkAdminConfig.js              (run inside the backend folder)
 *   node src/scripts/checkAdminConfig.js --test-login (also tries a username + password you type)
 *
 * Typical findings: ADMIN_USERS pasted without the username, the hash split over two
 * lines, quotes/spaces around the value, a truncated hash, missing ADMIN_SESSION_SECRET.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dotenv = require("dotenv");

const envPath = path.resolve(__dirname, "../../.env");
const ok = (m) => console.log("  [ OK ] " + m);
const bad = (m) => { problems++; console.log("  [FAIL] " + m); };
const warn = (m) => console.log("  [warn] " + m);
let problems = 0;

if (!fs.existsSync(envPath)) { console.log(`No .env found at ${envPath}\nCreate it from .env.example first.`); process.exit(1); }
const raw = fs.readFileSync(envPath, "utf8");
console.log(`Checking ${envPath}\n`);

// 1. Lines that are not KEY=value (usually a value that got split over two lines when copied from a terminal)
console.log("File layout");
let orphan = 0;
raw.split(/\r?\n/).forEach((line, i) => {
  const t = line.trim();
  if (!t || t.startsWith("#")) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) {
    orphan++; bad(`line ${i + 1} is not KEY=value (${t.length} chars) - a value was probably split across lines. Join it onto the line above.`);
  }
});
if (!orphan) ok("every non-comment line is KEY=value");

const env = dotenv.parse(raw);
const get = (k) => (env[k] === undefined ? "" : String(env[k]));

console.log("\nSettings");
const nodeEnv = get("NODE_ENV");
nodeEnv === "production" ? ok("NODE_ENV=production") : warn(`NODE_ENV is "${nodeEnv || "(not set)"}" - fine on your own PC, set to production on the server`);
const secret = get("ADMIN_SESSION_SECRET");
secret.length >= 32 ? ok(`ADMIN_SESSION_SECRET is set (${secret.length} characters)`) : bad(`ADMIN_SESSION_SECRET is ${secret ? "too short (" + secret.length + " chars, need 32+)" : "missing"}`);

console.log("\nADMIN_USERS");
const users = get("ADMIN_USERS");
if (!users.trim()) {
  get("PIN") ? warn("ADMIN_USERS is empty - the page will use the single PIN instead") : bad("ADMIN_USERS and PIN are both empty - nobody can log in");
} else {
  if (/^["'].*["']$/.test(raw.match(/^\s*ADMIN_USERS\s*=\s*(.*)$/m)?.[1]?.trim() || "")) warn("value is wrapped in quotes - normally harmless, but remove them to be safe");
  const entries = users.split(",");
  let valid = 0;
  entries.forEach((entry, n) => {
    const label = `entry ${n + 1}`;
    const i = entry.indexOf(":");
    if (i < 1) { bad(`${label}: no "username:" in front - you must paste the WHOLE line printed by hashPassword.js, e.g. alice:scrypt$...`); return; }
    const name = entry.slice(0, i).trim();
    const hash = entry.slice(i + 1).trim();
    if (!hash.startsWith("scrypt$")) { bad(`${label} (${name}): after the colon it must start with scrypt$ - this one does not`); return; }
    const [, salt, h] = hash.split("$");
    if (!/^[0-9a-f]{32}$/.test(salt || "")) { bad(`${label} (${name}): salt part is wrong/cut off (${(salt || "").length} chars, expected 32)`); return; }
    if (!/^[0-9a-f]{128}$/.test(h || "")) { bad(`${label} (${name}): hash part is wrong/cut off (${(h || "").length} chars, expected 128) - the line was probably truncated or split`); return; }
    if (/\s/.test(hash)) { bad(`${label} (${name}): contains spaces or line breaks`); return; }
    valid++; ok(`${label}: username "${name.toLowerCase()}" has a well-formed password hash`);
  });
  if (!valid) bad("no usable admin account - the server will refuse to start in production and every login will fail");
}

async function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a); });
  });
}

(async () => {
  if (process.argv.includes("--test-login") && get("ADMIN_USERS").trim()) {
    process.env.ADMIN_USERS = get("ADMIN_USERS");
    const { checkCredentials } = require("../middleware/security");
    console.log("\nLogin test (nothing is stored or printed)");
    const u = await ask("  Username: ", false);
    const p = await ask("  Password: ", true);
    const who = checkCredentials(u, p);
    who ? ok(`login would SUCCEED as "${who}"`) : bad("login would FAIL - wrong username or password for the hash in .env (re-create it with hashPassword.js if you forgot the password)");
  }
  console.log(problems ? `\n${problems} problem(s) found. Fix them, save .env, then restart the backend (.env is only read at start).` : "\nAll checks passed. Restart the backend if you changed .env.");
  process.exit(problems ? 1 : 0);
})();