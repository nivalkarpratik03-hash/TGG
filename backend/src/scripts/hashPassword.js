#!/usr/bin/env node
/**
 * Creates one admin account entry for ADMIN_USERS in backend/.env
 *
 *   node backend/src/scripts/hashPassword.js
 *
 * Prompts for a username and password (typing is hidden), then prints
 *   username:scrypt$<salt>$<hash>
 * Add that to ADMIN_USERS. Several admins are comma-separated:
 *   ADMIN_USERS=alice:scrypt$...,bob:scrypt$...
 * The plain password is never stored or printed.
 */
const readline = require("readline");
const { hashPassword } = require("../middleware/security");

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer); });
  });
}

(async () => {
  const username = (await ask("Admin username (letters/digits/._-): ", false)).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) { console.error("Username must be 3-32 chars: a-z 0-9 . _ -"); process.exit(1); }
  const pw = await ask("Password (min 10 chars): ", true);
  if (pw.length < 10) { console.error("Password must be at least 10 characters."); process.exit(1); }
  const pw2 = await ask("Confirm password: ", true);
  if (pw !== pw2) { console.error("Passwords do not match."); process.exit(1); }
  console.log("\nAdd this to ADMIN_USERS in backend/.env (comma-separate multiple admins):\n");
  console.log(`${username}:${hashPassword(pw)}\n`);
})();