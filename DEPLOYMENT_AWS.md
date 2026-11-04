# TGG — AWS deployment (single-instance, stateful)

**Why one instance:** candle caches, the single Fyers WebSocket, schedulers and the Fyers token file are in-memory / on local disk. Run exactly ONE backend; scale vertically. Tested: 300 concurrent sockets on one process.

## 0. Before anything
- Rotate: Fyers app secret, DB password, admin PIN (the original zip contained live values).
- Confirm your TradingView charting_library license covers public hosting.

## 1. Network
VPC, 2 public subnets (ALB), 2 private subnets (EC2, RDS). Security groups: ALB(443) -> backend(9003) -> RDS(5432). Orderflow(8002), if you deploy it: inbound from backend SG only. Kronos is not deployed. Egress: 443 to Fyers + DNS (UDP/TCP 53); allow UDP 123 for NTP (chrony; candle timestamps depend on a correct clock).

## 2. RDS
PostgreSQL 15/16, encrypted, Multi-AZ, automated backups, private. TimescaleDB NOT required (migrations are plain Postgres). Create an app user (not the master user).
Download the RDS CA bundle (global-bundle.pem) to the instance. Keep PG_POOL_MAX < RDS max_connections.

## 3. Secrets
Store backend/.env.example values in Secrets Manager / SSM. Generate: `openssl rand -base64 48` for ADMIN_SESSION_SECRET. PIN >= 8 chars.

## 4. EC2
Amazon Linux 2023 / Ubuntu 24.04, >= 2 vCPU / 4 GB. Attach an encrypted EBS volume at /data (FYERS_TOKEN_DIR=/data/fyers). Enable chrony. IAM role with read access to the secrets.

## 5. Deploy
```
git clone <repo> && cd tgg
npm ci
CI=false GENERATE_SOURCEMAP=false npm run build -w tgg-frontend
set -a; source /etc/tgg/env; set +a          # from Secrets Manager
node database/src/scripts/migrate.js          # exits non-zero on failure
```
systemd unit: `ExecStart=/usr/bin/node --max-old-space-size=1536 backend/src/server.js`, `Restart=always`, `User=tgg`, `EnvironmentFile=/etc/tgg/env`, `KillSignal=SIGTERM`, `TimeoutStopSec=20`. (Or build the provided Dockerfile — untested.)

## 6. ALB
HTTPS:443 with ACM cert, HTTP->HTTPS redirect, target group :9003, health check `/ready`, idle timeout 3600s (WebSockets), stickiness on. Set TRUST_PROXY_HOPS=1 (2 behind CloudFront).

## 7. Optional CloudFront
Cache /static/* and /api/symbols (compression at the edge saves backend CPU). Forward Authorization + Origin headers; do not cache /api/* otherwise or /socket.io.

## 8. Go-live checks (run on the instance)
```
scripts/smoke_test.sh https://your-domain
python3 scripts/network_check.py         # TCP/UDP; edit hosts for RDS / Fyers
```
Then open /admin, enter PIN, complete Fyers login (PUBLIC_BACKEND_URL must be registered as the Fyers redirect URL).

## 9. Operations
CloudWatch agent for logs + memory; alarms on ALB 5xx, /ready failures, RDS connections/CPU/storage. Fyers tokens expire daily: login each morning (see report: boot currently blocks on token).