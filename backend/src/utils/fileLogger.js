/**
 * backend/src/utils/fileLogger.js
 *
 * Mirrors EVERY console.log/warn/error line to a full, timestamped log file
 * on disk (backend/logs/run-<timestamp>.log), IN ADDITION to printing to
 * the terminal exactly as before. Nothing about terminal output changes or
 * gets filtered — this is a second destination, not a replacement. It
 * captures at whatever verbosity is currently active (see verboseLog.js's
 * VERBOSE_LOGS flag) — if VERBOSE_LOGS=true, the file gets the full
 * per-symbol trace too, not just the summary lines.
 *
 * WHY: terminal scrollback truncates and copy-pasting a long session by
 * hand is slow and error-prone (lines get dropped/merged). This gives you
 * one real file per run you can just attach and share — nothing to
 * remember to turn on, it starts the instant the process boots.
 *
 * MUST be require()'d FIRST — before any other module that might
 * console.log on import (e.g. core/state.js's "[DB] Database module
 * loaded" line) — otherwise those early lines won't get captured. See the
 * very first line of server.js.
 *
 * Keeps the newest KEEP_RUNS log files and deletes older ones on every
 * boot, so this can't grow disk usage unbounded over time.
 */

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "..", "logs");
const KEEP_RUNS = 10;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Prune old run logs on boot, keep only the newest KEEP_RUNS.
try {
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("run-") && f.endsWith(".log"))
    .map((f) => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(KEEP_RUNS).forEach(({ f }) => fs.unlinkSync(path.join(LOG_DIR, f)));
} catch (e) {
  // Pruning failing is never worth blocking startup over.
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `run-${stamp}.log`);
const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function safeStringify(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function formatLine(args) {
  const line = args.map(safeStringify).join(" ");
  return `[${new Date().toISOString()}] ${line}\n`;
}

["log", "warn", "error"].forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args); // terminal output unchanged
    try {
      stream.write(formatLine(args));
    } catch (e) {
      // Never let file logging take down the app.
    }
  };
});

console.log(`[FileLogger] Full run log being written to: ${LOG_FILE}`);

module.exports = { LOG_FILE, LOG_DIR };
