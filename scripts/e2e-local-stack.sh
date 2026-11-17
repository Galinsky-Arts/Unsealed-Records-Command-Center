#!/usr/bin/env bash
# Start the engine (from ENGINE_DIR) and the built Command Center against DATABASE_URL, then run the E2E journey.
# All keys and passwords are generated for this run only and never written to disk.
set -euo pipefail
: "${ENGINE_DIR:?path to a Music-Operations-Engine checkout}" "${DATABASE_URL:?PostgreSQL URL for the engine}"
gen(){ node -e "console.log(require('crypto').randomBytes(30).toString('base64url'))"; }
ADMIN_KEY=$(gen); READ_KEY=$(gen); CONSOLE_KEY=$(gen); ADMIN_PASSWORD=$(gen); SESSION_SECRET=$(gen)
(cd "$ENGINE_DIR" && PORT=4100 DATABASE_URL="$DATABASE_URL" ENGINE_API_KEY="$ADMIN_KEY" ENGINE_CONSOLE_KEY="$CONSOLE_KEY" \
  ENGINE_CREDENTIALS="[{\"id\":\"command-center\",\"key\":\"$READ_KEY\",\"labels\":[\"*\"],\"permissions\":[\"read\"]}]" \
  WORKER_ENABLED=1 WORKER_INTERVAL_MS=2000 node src/server.js > /tmp/e2e-engine.log 2>&1) & ENGINE_PID=$!
PORT=3100 ENGINE_URL=http://127.0.0.1:4100 ENGINE_API_KEY="$READ_KEY" ENGINE_WRITE_API_KEY="$CONSOLE_KEY" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  SESSION_SECRET="$SESSION_SECRET" APP_ORIGIN=http://127.0.0.1:3100 node scripts/start-production.mjs > /tmp/e2e-urc.log 2>&1 & URC_PID=$!
trap 'kill $ENGINE_PID $URC_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:4100/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3100/healthz >/dev/null 2>&1 && break; sleep 1; done
sleep 2; grep -h "Engine probe" /tmp/e2e-urc.log || true
E2E_BASE_URL=http://127.0.0.1:3100 E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" node scripts/e2e-journey.mjs
