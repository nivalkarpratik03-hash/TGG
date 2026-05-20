/**
 * config.js — single source of truth for the backend URL.
 *
 * LOCAL dev:   frontend runs :3000, backend runs :9004 → use hostname:9004
 * RAILWAY:     frontend build is SERVED BY the backend (same origin, same port)
 *              → use window.location.origin (no port suffix needed)
 *
 * To force a URL: set REACT_APP_BACKEND_URL in frontend/.env
 */
const isProduction = process.env.NODE_ENV === "production";

export const BACKEND =
  process.env.REACT_APP_BACKEND_URL ||
  (isProduction
    ? window.location.origin                                          // Railway: same host
    : `${window.location.protocol}//${window.location.hostname}:9011` // Local dev: port 9004
  );