/**
 * config.js — single source of truth for the backend URL.
 *
 * Auto-detects from the browser's current hostname so it works for:
 *   localhost:3000        → http://localhost:5280
 *   192.168.1.68:3000     → http://192.168.1.68:5280  (any LAN device)
 *
 * To override (e.g. production), set REACT_APP_BACKEND_URL in frontend/.env
 */
// FIX (2026-11-04): a PRODUCTION build is served by the backend itself
// (backend/src/server.js serves frontend/build), so the API and Socket.IO
// live on the exact same origin as the page — e.g. http://43.204.107.178:8000.
// The old default always pointed at port 5280, which only exists on a dev
// machine; on the server that sent REST + WebSocket traffic to a port nothing
// was listening on (or to a different, stale process). Dev (npm start on
// :3000) still talks to :5280 as before.
const DEV_BACKEND = `${window.location.protocol}//${window.location.hostname}:5280`;
export const BACKEND = (
  process.env.REACT_APP_BACKEND_URL ||
  (process.env.NODE_ENV === "production" ? window.location.origin : DEV_BACKEND)
).replace(/\/$/, "");