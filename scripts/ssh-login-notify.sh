#!/bin/bash
# SSH login notification — fires on PAM session open
if [ "$PAM_TYPE" != "open_session" ]; then
  exit 0
fi

SLACK_CHANNEL="C0ARA28T6UV"
SLACK_BOT_TOKEN=$(grep "^SLACK_BOT_TOKEN=" /opt/nanoclaw/.env | cut -d= -f2)
HOSTNAME=$(hostname)
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S %Z")

# Known IP lookup
case "$PAM_RHOST" in
  209.205.188.215) SOURCE="Jeremiah (home)" ;;
  *) SOURCE="UNKNOWN — $PAM_RHOST" ;;
esac

TEXT=":old_key: SSH login on \`${HOSTNAME}\`\nUser: \`${PAM_USER}\` from ${SOURCE}\nTime: ${TIMESTAMP}"

curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"${SLACK_CHANNEL}\", \"text\": \"${TEXT}\"}" \
  > /dev/null 2>&1 &

exit 0
