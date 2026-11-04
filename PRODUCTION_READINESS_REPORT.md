# Production readiness report
## Fixed & verified (sandbox)
Migration runner (tracked, numbered-only) · CORS allowlist · admin-token gate on all writes · PIN lockout (5/15min) · rate-limit bypass removed · 500 sanitization · input validation (REST + sockets) · refresh throttle · helmet/HSTS · gzip · /ready · graceful shutdown · pool SSL/timeouts · token file 0600 + FYERS_TOKEN_DIR · backend package.json script paths.
## Verified results
Existing tests all pass; smoke 8/8; 300 sockets OK; 75k-request soak 0 errors; backend recovers after Postgres restart.
## Open / not tested
Fyers live flows (unreachable from sandbox) · orderflow runtime · Dockerfiles untested · real browser UI · boot blocks on Fyers token (design decision) · single-instance only · xlsx advisories (no npm fix; write-only use) · remaining react-scripts dev-tool advisories · orderflow has no auth (keep private) · memory trend needs long-run monitoring.
## Behaviour changes to know
Scanner trigger/stop/symbols, paper-trading writes and /api/auth/token require admin PIN login first (ADMIN_PROTECT_WRITES=false disables). Production refuses to boot without PIN (8+) and ADMIN_SESSION_SECRET (32+).

Kronos is intentionally not deployed; its strategy is disabled in strategyRegistry.js, so the backend has no dependency on it.