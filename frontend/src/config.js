/**
 * config.js — single source of truth for the backend URL.
 *
 * Auto-detects from the browser's current hostname so it works for:
 *   localhost:3000        → http://localhost:9004
 *   192.168.1.68:3000     → http://192.168.1.68:9004  (any LAN device)
 *
 * To override (e.g. production), set REACT_APP_BACKEND_URL in frontend/.env
 */
export const BACKEND =
  process.env.REACT_APP_BACKEND_URL ||
  `${window.location.protocol}//${window.location.hostname}:9011`;