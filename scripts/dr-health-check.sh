#!/bin/bash
# Wrapper: runs DR health check and posts results to #aios-alerts
SLACK_CHANNEL="C0ARA28T6UV"
SLACK_BOT_TOKEN=$(grep "^SLACK_BOT_TOKEN=" /opt/nanoclaw/.env | cut -d= -f2)

# Run the DR test script
OUTPUT=$(/opt/nanoclaw/scripts/dr-test.sh 2>&1)

# Add disk and Docker checks
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d " %")
DANGLING=$(docker images -f dangling=true -q 2>/dev/null | wc -l)
LOG_COUNT=$(find /opt/nanoclaw/groups -name "container-*.log" 2>/dev/null | wc -l)

EXTRA=""
EXTRA="${EXTRA}\n8. Resource checks"
if [ "$DISK_PCT" -gt 80 ] 2>/dev/null; then
  EXTRA="${EXTRA}\n  [Disk usage] WARN (${DISK_PCT}% used)"
else
  EXTRA="${EXTRA}\n  [Disk usage] PASS (${DISK_PCT}% used)"
fi
EXTRA="${EXTRA}\n  [Dangling images] ${DANGLING}"
EXTRA="${EXTRA}\n  [Container logs] ${LOG_COUNT} files"

FULL_OUTPUT="${OUTPUT}$(echo -e "${EXTRA}")"

# Post to Slack (use a temp file to handle special chars)
TMPFILE=$(mktemp)
echo -e "\`\`\`\n${FULL_OUTPUT}\n\`\`\`" > "$TMPFILE"
PAYLOAD=$(python3 -c "
import json, sys
text = open('$TMPFILE').read()
print(json.dumps({'channel': '$SLACK_CHANNEL', 'text': text}))
")
rm -f "$TMPFILE"

curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1
