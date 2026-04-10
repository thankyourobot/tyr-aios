# Incident Response Runbook

If a compromise is suspected, rotate credentials in this order. Each step includes verification.

## 1. Anthropic OAuth Token (highest impact)

All agent API access flows through this token via the OneCLI Agent Vault. Rotation happens in the vault, not in `/opt/nanoclaw/.env` (the OAuth token is no longer stored there post-OneCLI cutover).

```bash
# 1. Revoke compromised token + generate new one at console.anthropic.com.

# 2. Update the vault. The dashboard is bound to 127.0.0.1 on the VM, so
#    SSH-tunnel from your laptop to reach it:
ssh -L 10254:127.0.0.1:10254 tyr-aios

#    Then in a local browser open http://127.0.0.1:10254
#    → Secrets → anthropic-primary → Edit value → paste new token → Save.
#    The new value is re-encrypted at rest with SECRET_ENCRYPTION_KEY.

# 3. Restart NanoClaw so newly spawned agent containers pick up the new token
#    via the OneCLI SDK (in-flight containers keep the old token until they exit):
ssh tyr-aios "systemctl restart nanoclaw"

# 4. Verify:
ssh tyr-aios "journalctl -u nanoclaw -n 50 --no-pager | grep -i 'OneCLI gateway'"
#    Should show "OneCLI gateway config applied" on each agent spawn.
# Then send a test message to any agent in Slack — should get a response.
```

## 2. Slack Bot Tokens (4 agents)

Each agent has its own Slack app. Rotate via api.slack.com → each app → OAuth & Permissions → Rotate Token.

```bash
# For each agent (Sherlock, Tom, Ryan, Alfred):
# 1. Rotate token at api.slack.com
# 2. Update on VM:
ssh tyr-aios
nano /opt/nanoclaw/.env          # Replace SLACK_BOT_TOKEN and per-agent tokens
# Also update SLACK_APP_TOKEN if rotating the socket mode token
systemctl restart nanoclaw

# 3. Verify:
journalctl -u nanoclaw -n 10 --no-pager   # Should show "Connected to Slack"
```

## 3. GitHub Deploy Key

```bash
# 1. Generate new key:
ssh-keygen -t ed25519 -f /tmp/deploy-key -N ""

# 2. Add public key at github.com → thankyourobot/tyr-aios → Settings → Deploy keys
# 3. Remove the old deploy key from GitHub

# 4. Update on VM:
ssh tyr-aios
# Replace /root/.ssh/deploy-key with new private key
# Or if using 1Password SSH agent, update the vault entry

# 5. Verify:
ssh tyr-aios "cd /opt/nanoclaw && git fetch origin"   # Should succeed
```

## 4. SSH Key to VM

```bash
# 1. Generate new key (or rotate in 1Password vault)
# 2. Add new public key to VM authorized_keys BEFORE removing old one:
ssh tyr-aios "cat >> /root/.ssh/authorized_keys" < ~/.ssh/new_key.pub

# 3. Test new key works:
ssh -i ~/.ssh/new_key root@46.225.209.157 "echo ok"

# 4. Remove old key from authorized_keys:
ssh tyr-aios "nano /root/.ssh/authorized_keys"   # Remove the old key line

# 5. Update local SSH config (~/.ssh/config) to point to new key
```

## 5. Post-Rotation Investigation

After rotating credentials, investigate the compromise:

```bash
# Check for unauthorized database modifications:
ssh tyr-aios "sqlite3 /opt/nanoclaw/store/messages.db 'SELECT * FROM registered_groups'"

# Check git history on VM for unexpected commits:
ssh tyr-aios "cd /opt/nanoclaw && git log --oneline -20"

# Check for modified critical files:
ssh tyr-aios "cd /opt/nanoclaw && git diff HEAD"
ssh tyr-aios "stat /opt/nanoclaw/.env"
ssh tyr-aios "stat /root/.ssh/authorized_keys"

# Rebuild container image from clean source:
ssh tyr-aios "cd /opt/nanoclaw && git fetch origin && git reset --hard origin/main && ./container/build.sh && systemctl restart nanoclaw"

# Review NanoClaw source for modifications (especially security-critical files):
ssh tyr-aios "cd /opt/nanoclaw && git diff origin/main -- src/container-runner.ts src/mount-security.ts src/config.ts src/index.ts"
```

## 6. Post-Incident Review

- Document what happened, when, and how it was detected
- Identify the attack vector and whether it's been closed
- Review whether alerting (SSH notifications, health checks) caught it
- Update this runbook with any new procedures
