#!/bin/bash
# NanoClaw restart watcher — monitors for restart signal file
# Robot writes /opt/nanoclaw/data/restart-requested to trigger a restart

SIGNAL_FILE="/opt/nanoclaw/data/restart-requested"
LOG_TAG="nanoclaw-restart-watcher"

while true; do
  if [ -f "$SIGNAL_FILE" ]; then
    REASON=$(cat "$SIGNAL_FILE" 2>/dev/null || echo "no reason given")
    logger -t "$LOG_TAG" "Restart requested: $REASON"
    rm -f "$SIGNAL_FILE"
    # Wait for the requesting container to finish its response
    sleep 5
    systemctl restart nanoclaw
    logger -t "$LOG_TAG" "NanoClaw restarted successfully"
  fi
  sleep 2
done
