#!/bin/bash
set -euo pipefail

source /root/.restic-env

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting backup..."

# Agent workspaces, global skills, session state, credentials, operational data
# Operational scripts (dr-test.sh, dr-health-check.sh, backup-daily.sh, etc.)
# live in tyr-aios/scripts/ in git — no need to back them up here.
restic backup \
  /opt/nanoclaw/groups/ \
  /opt/nanoclaw/container/skills/ \
  /opt/nanoclaw/data/sessions/ \
  /opt/nanoclaw/.env \
  /opt/filebrowser/filebrowser.db \
  /etc/litestream.yml \
  /opt/onecli/ \
  /opt/nanoclaw/data/onecli-backups/ \
  --exclude "node_modules" \
  --exclude "*.log" \
  --tag daily

# Prune old snapshots: 7 daily, 4 weekly, 12 monthly
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Backup complete."
