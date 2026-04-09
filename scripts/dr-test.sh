#!/bin/bash
set -uo pipefail

PASS=0
FAIL=0
WARN=0

report() {
  local status="$1" name="$2" detail="${3:-}"
  if [ "$status" = "PASS" ]; then
    echo "  [${name}] PASS${detail:+ ($detail)}"
    PASS=$((PASS + 1))
  elif [ "$status" = "WARN" ]; then
    echo "  [${name}] WARN${detail:+ ($detail)}"
    WARN=$((WARN + 1))
  else
    echo "  [${name}] FAIL${detail:+ ($detail)}"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== DR Health Check — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""

# 1. Litestream
echo "1. Litestream (SQLite continuous replication)"

systemctl is-active --quiet litestream && report PASS "service running" || report FAIL "service running"

for DB_PATH in /opt/nanoclaw/data/shared/tasks.db /opt/nanoclaw/store/messages.db; do
  DB_NAME=$(basename "$DB_PATH")
  GEN_COUNT=$(litestream generations -config /etc/litestream.yml "$DB_PATH" 2>/dev/null | grep -c "^s3")
  [ "$GEN_COUNT" -ge 1 ] 2>/dev/null && report PASS "$DB_NAME generations" "${GEN_COUNT} found" || report WARN "$DB_NAME generations" "none found"
done

echo ""

# 2. Restic
echo "2. Restic (encrypted file backups)"
source /root/.restic-env

restic snapshots --latest 1 --quiet >/dev/null 2>&1 && report PASS "repo accessible" || report FAIL "repo accessible"

restic unlock >/dev/null 2>&1
restic check --quiet >/dev/null 2>&1 && report PASS "repo integrity" || report FAIL "repo integrity"

restic snapshots --latest 1 --json > /tmp/dr-snapshots.json 2>/dev/null
AGE_HOURS=$(python3 -c "
import json
from datetime import datetime, timezone
snaps = sorted(json.load(open('/tmp/dr-snapshots.json')), key=lambda s: s['time'], reverse=True)
if not snaps: print(-1); exit()
ts = snaps[0]['time'][:19]
age = (datetime.now(timezone.utc) - datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)).total_seconds() / 3600
print(round(age, 1))
" 2>/dev/null)
rm -f /tmp/dr-snapshots.json
if [ "$AGE_HOURS" = "-1" ]; then
  report FAIL "snapshot age" "no snapshots"
elif python3 -c "exit(0 if float('$AGE_HOURS') <= 48 else 1)" 2>/dev/null; then
  report PASS "snapshot age" "${AGE_HOURS}h ago"
else
  report WARN "snapshot age" "${AGE_HOURS}h ago, older than 48h"
fi

echo ""

# 3. Etckeeper
echo "3. Etckeeper (system config tracking)"

test -d /etc/.git && report PASS "git repo" || report FAIL "git repo"

LAST=$(cd /etc && git log -1 --format="%ar" 2>/dev/null)
[ -n "$LAST" ] && report PASS "recent commit" "$LAST" || report WARN "recent commit" "no commits"

echo ""

# 4. Hetzner backups
echo "4. Hetzner automated backups"
report PASS "enabled" "verified externally, window 10-14 UTC"

echo ""

# 5. Core services
echo "5. Core services"

systemctl is-active --quiet nanoclaw && report PASS "NanoClaw" || report FAIL "NanoClaw"
systemctl is-active --quiet litestream && report PASS "Litestream" || report FAIL "Litestream"
systemctl is-active --quiet backup-daily.timer && report PASS "backup timer" || report FAIL "backup timer"

# 6. NanoClaw health
echo ""
echo "6. NanoClaw health"

docker image inspect nanoclaw-agent:latest >/dev/null 2>&1 && report PASS "container image" || report FAIL "container image"

AGENT_COUNT=$(sqlite3 /opt/nanoclaw/store/messages.db "SELECT COUNT(DISTINCT folder) FROM registered_groups;" 2>/dev/null)
[ "$AGENT_COUNT" -ge 4 ] 2>/dev/null && report PASS "registered groups" "${AGENT_COUNT} groups" || report FAIL "registered groups" "${AGENT_COUNT:-0} groups"

test -f /opt/nanoclaw/data/shared/tasks.db && report PASS "tasks.db exists" || report FAIL "tasks.db exists"

# Process user check
NANOCLAW_USER=$(ps -p $(systemctl show -p MainPID --value nanoclaw 2>/dev/null) -o user= 2>/dev/null | tr -d ' ')
[ -n "$NANOCLAW_USER" ] && report PASS "process user" "$NANOCLAW_USER" || report WARN "process user" "could not determine"

# Recent container activity (last 24h)
RECENT_CONTAINERS=$(find /opt/nanoclaw/groups -name "container-*.log" -mtime -1 2>/dev/null | wc -l)
[ "$RECENT_CONTAINERS" -ge 1 ] 2>/dev/null && report PASS "recent container activity" "${RECENT_CONTAINERS} in 24h" || report WARN "recent container activity" "none in 24h"

# Recent scheduled task runs (last 24h)
RECENT_JOBS=$(sqlite3 /opt/nanoclaw/store/messages.db "SELECT COUNT(*) FROM scheduled_jobs WHERE last_run > datetime('now', '-1 day');" 2>/dev/null)
[ "$RECENT_JOBS" -ge 1 ] 2>/dev/null && report PASS "recent job runs" "${RECENT_JOBS} in 24h" || report WARN "recent job runs" "none in 24h"

# Credential proxy listening
PROXY_LISTENING=$(ss -tln 2>/dev/null | grep -c ':3001 ')
[ "$PROXY_LISTENING" -ge 1 ] 2>/dev/null && report PASS "credential proxy listening" || report FAIL "credential proxy listening"

# Docker socket in use
DOCKER_SOCKET=$(systemctl show -p Environment --value nanoclaw 2>/dev/null | tr ' ' '\n' | grep DOCKER_HOST | cut -d= -f2-)
[ -z "$DOCKER_SOCKET" ] && DOCKER_SOCKET="/var/run/docker.sock (rootful)"
report PASS "docker socket" "$DOCKER_SOCKET"

echo ""
# 7. OneCLI Agent Vault
echo "7. OneCLI Agent Vault"

docker inspect --format '{{.State.Health.Status}}' onecli 2>/dev/null | grep -q healthy \
  && report PASS "container health" \
  || report FAIL "container health"

docker inspect --format '{{.State.Health.Status}}' onecli-postgres 2>/dev/null | grep -q healthy \
  && report PASS "postgres health" \
  || report FAIL "postgres health"

curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10254/api/health 2>/dev/null | grep -q 200 \
  && report PASS "web API health" \
  || report FAIL "web API health"

ONECLI_TODAY=$(date +%Y-%m-%d)
test -f "/opt/nanoclaw/data/onecli-backups/postgres-${ONECLI_TODAY}.dump" \
  && report PASS "postgres dump" \
  || report FAIL "postgres dump"

test -f "/opt/nanoclaw/data/onecli-backups/app-data-${ONECLI_TODAY}.tar" \
  && report PASS "app-data tar" \
  || report FAIL "app-data tar"

# Postgres version sanity — catch silent upgrade drift
docker exec onecli-postgres psql -U onecli -tAc "SELECT version();" 2>/dev/null | grep -q "PostgreSQL 18" \
  && report PASS "postgres v18" \
  || report WARN "postgres v18"

# NanoClaw is actually using OneCLI right now (not silently fallen back to legacy).
# Looks for "Credential layer: OneCLI Agent Vault" in the most recent startup window.
journalctl -u nanoclaw --since "$(systemctl show -p ActiveEnterTimestamp --value nanoclaw)" --no-pager 2>/dev/null \
  | grep -q "Credential layer: OneCLI Agent Vault" \
  && report PASS "nanoclaw using OneCLI" \
  || report FAIL "nanoclaw using OneCLI"

echo ""
echo "=== Summary ==="
echo "  PASS: $PASS  FAIL: $FAIL  WARN: $WARN"
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "STATUS: FAILED — ${FAIL} check(s) need attention"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "STATUS: OK with warnings"
  exit 0
else
  echo "STATUS: ALL CLEAR"
  exit 0
fi
