/**
 * frontend/src/utils/backendSocket.js
 *
 * P3 #16 — BacktestPage.js, ScannerPage.js, and StrategiesPage.js each
 * called `io(BACKEND, { transports: ["websocket"] })` independently. This
 * is NOT the same thing useSocket.js does (that hook manages chart
 * candle/symbol/resolution state — unrelated to these pages' backtest- and
 * scanner-progress events), so those three pages intentionally keep their
 * own useEffect/event-handling logic. What's consolidated here is just the
 * actual duplicated part: the connection itself, so a future change to
 * these options (e.g. adding a polling fallback, reconnection tuning) only
 * needs to happen in one place instead of three.
 */
import { io } from "socket.io-client";
import { BACKEND } from "../config";

export function createBackendSocket() {
  return io(BACKEND, { transports: ["websocket"] });
}
