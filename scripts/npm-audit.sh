#!/bin/bash
# Weekly npm audit check — posts results to #aios-alerts
SLACK_CHANNEL="C0ARA28T6UV"
SLACK_BOT_TOKEN=$(grep "^SLACK_BOT_TOKEN=" /opt/nanoclaw/.env | cut -d= -f2)

cd /opt/nanoclaw || exit 1

OUTPUT=$(npm audit --omit=dev 2>&1)
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  TEXT=":white_check_mark: *npm audit clean* — no known vulnerabilities in production dependencies"
else
  # Truncate to avoid Slack message limits
  TRUNCATED=$(echo "$OUTPUT" | head -50)
  TEXT=":warning: *npm audit found vulnerabilities*\n\`\`\`\n${TRUNCATED}\n\`\`\`"
fi

TMPFILE=$(mktemp)
echo -e "$TEXT" > "$TMPFILE"
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
