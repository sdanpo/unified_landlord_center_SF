#!/bin/bash
# Monitor Railway logs and ERPNext webhook requests in real time.
# Reads credentials from .env in the repo root.
# Usage: ./scripts/monitor-railway.sh [interval_seconds]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN not set — add it to .env}"
: "${RAILWAY_DEPLOYMENT_ID:?RAILWAY_DEPLOYMENT_ID not set — add it to .env}"
: "${ERPNEXT_BASE_URL:?ERPNEXT_BASE_URL not set}"
: "${ERPNEXT_API_KEY:?ERPNEXT_API_KEY not set}"
: "${ERPNEXT_API_SECRET:?ERPNEXT_API_SECRET not set}"

INTERVAL="${1:-10}"
LAST_LOG_COUNT=0
LAST_WEBHOOK_TS=""

echo "=== Railway + ERPNext Monitor ==="
echo "Polling every ${INTERVAL}s. Ctrl+C to stop."
echo ""

while true; do
  # --- Railway deployment logs ---
  LOG_DATA=$(curl -s -X POST "https://backboard.railway.app/graphql/v2" \
    -H "Authorization: Bearer $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ deploymentLogs(deploymentId: \\\"$RAILWAY_DEPLOYMENT_ID\\\") { timestamp message } }\"}")

  LOG_COUNT=$(echo "$LOG_DATA" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(len(d.get('data',{}).get('deploymentLogs',[])))" 2>/dev/null)

  if [ -n "$LOG_COUNT" ] && [ "$LOG_COUNT" -gt "$LAST_LOG_COUNT" ] 2>/dev/null && [ "$LAST_LOG_COUNT" -gt 0 ]; then
    SKIP="$LAST_LOG_COUNT"
    echo "--- New Railway logs ($(date -u +%H:%M:%SZ)) ---"
    echo "$LOG_DATA" | python3 -c "
import json, sys
data = json.load(sys.stdin)
logs = data.get('data', {}).get('deploymentLogs', [])
for l in logs[${SKIP}:]:
    ts = l.get('timestamp', '')[:19]
    print(f'{ts} | {l.get(\"message\", \"\")}')
" 2>/dev/null
  fi
  LAST_LOG_COUNT="${LOG_COUNT:-$LAST_LOG_COUNT}"

  # --- ERPNext Webhook Request Log ---
  WEBHOOK_DATA=$(curl -s \
    "${ERPNEXT_BASE_URL%/}/api/resource/Webhook%20Request%20Log?fields=%5B%22name%22%2C%22creation%22%2C%22webhook%22%2C%22response%22%5D&order_by=creation%20desc&limit=5" \
    -u "${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}" 2>/dev/null)

  LATEST_TS=$(echo "$WEBHOOK_DATA" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['creation'] if d.get('data') else '')" 2>/dev/null)

  if [ -n "$LATEST_TS" ] && [ "$LATEST_TS" != "$LAST_WEBHOOK_TS" ] && [ -n "$LAST_WEBHOOK_TS" ]; then
    PREV="$LAST_WEBHOOK_TS"
    echo "--- New ERPNext webhook logs ($(date -u +%H:%M:%SZ)) ---"
    echo "$WEBHOOK_DATA" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('data', []):
    if r['creation'] > '${PREV}':
        print(f'{r[\"creation\"][:19]} | {r.get(\"webhook\",\"\")} | {r.get(\"response\",\"\")[:80]}')
" 2>/dev/null
  fi
  LAST_WEBHOOK_TS="${LATEST_TS:-$LAST_WEBHOOK_TS}"

  sleep "$INTERVAL"
done
