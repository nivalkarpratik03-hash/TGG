/**
 * utils/adminAuth.js (NEW)
 *
 * Installed once from index.js. After the user verifies the admin PIN on /admin the
 * backend returns a signed, expiring token (stored in sessionStorage). This module
 * transparently attaches it as `Authorization: Bearer <token>` to every NON-GET
 * request that goes to the TGG backend — for both window.fetch and axios — so the
 * Scanner, Paper-Trading and Admin pages keep working without per-call changes.
 * If the backend answers 401 the user is told once to log in on /admin.
 */
import axios from "axios";
import { BACKEND } from "../config";

export const ADMIN_TOKEN_KEY = "tgg_admin_token";

export const getAdminToken = () => {
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY); } catch { return null; }
};

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  setTimeout(() => { warned = false; }, 30_000);
  // eslint-disable-next-line no-alert
  window.alert("Admin login required for this action. Open /admin, enter your PIN, then try again.");
}

const isBackendUrl = (url) => typeof url === "string" && (url.startsWith(BACKEND) || url.startsWith("/api/"));
const isWrite = (method) => !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());

export function installAdminAuth() {
  if (window.__tggAdminAuthInstalled) return;
  window.__tggAdminAuthInstalled = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input && input.url;
    const method = init.method || (typeof input !== "string" && input && input.method) || "GET";
    if (isBackendUrl(url) && isWrite(method)) {
      const token = getAdminToken();
      if (token) {
        const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
        if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
        init = { ...init, headers };
      }
    }
    const res = await origFetch(input, init);
    if (res.status === 401 && isBackendUrl(url) && isWrite(method)) warnOnce();
    return res;
  };

  axios.interceptors.request.use((cfg) => {
    const token = getAdminToken();
    if (token && isWrite(cfg.method) && isBackendUrl(cfg.url)) {
      cfg.headers = cfg.headers || {};
      if (!cfg.headers.Authorization) cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });
  axios.interceptors.response.use((r) => r, (err) => {
    if (err && err.response && err.response.status === 401 && isWrite(err.config && err.config.method)) warnOnce();
    return Promise.reject(err);
  });
}