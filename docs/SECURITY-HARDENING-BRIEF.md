# Security Hardening Brief — For Strategy Director (Sherlock)

Assignment: `01KMHGYSHQFSDE8K4GY2TFM1AX`
Date: 2026-04-03
Author: Jeremiah + Claude (pair session)

This brief captures all decisions, findings, and remaining work from a deep security review session. It supersedes the notes in the original assignment meta and supplements the existing analysis at `projects/tyr-aios-security-hardening.md` (Sherlock's prior work).

---

## Context

Jeremiah conducted a full security review of the TYR AI OS with Claude, covering:
- The NanoClaw codebase (container isolation, credential proxy, mount security, IPC authorization)
- The VM configuration (SSH, Docker, firewall, systemd)
- The local development machine (SSH keys, npm supply chain)
- Sherlock's existing security hardening analysis and supply chain briefings
- The secops skill from GitHub (Ciaran-Hughes/pointify — safe, just an osv-scanner policy doc)

## Security Mental Model

A 9-dimension security model was developed and documented at `docs/SECURITY-MODEL.md` in the NanoClaw repo. This is the authoritative mental model for all security decisions. The nine dimensions are:

1. **Identity** — SSH keys, tokens; minimize copies, encrypt at rest, detect usage
2. **Secrets** — API keys, env vars; encrypt everywhere, never expose to untrusted code
3. **Supply chain** — dependencies; treat as untrusted, block install-time execution
4. **Input** — messages + tool outputs; assume adversarial, sanitize and sandbox
5. **Containment** — containers; limit blast radius of any compromise
6. **Exfiltration** — network egress; make it hard to get data out
7. **Backups** — encrypted, tested, isolated
8. **Observability** — audit trails, alerting, detection
9. **Least privilege** — the orchestrator itself shouldn't be omnipotent

## What Was Done (2026-04-03)

### Previously completed (2026-04-02)
- SSH key passphrases set with macOS Keychain caching
- `ignore-scripts=true` added to `~/.npmrc`
- Claude OAuth token removed from `/etc/environment`

### Completed after session (2026-04-06)
- **1Password SSH agent** — all local SSH keys moved to 1Password vault. Keys never touch disk. SSH auth gated by Touch ID. This was item 1.4 (critical priority) from Sherlock's hardening analysis.

### Completed in this session
- **`--cap-drop=ALL` and `--security-opt=no-new-privileges:true`** added to all agent containers (`container-runner.ts`). Deployed and live on VM. Zero performance impact.
- **Pre-commit hook fixed** — was running `prettier --write src/**/*.ts` (all files) on every commit, leaving unstaged formatting changes. Replaced with `lint-staged` that only formats staged files. Root cause of recurring dirty working tree on main.
- **`openclaw_default` Docker network removed** — stale artifact from decommissioned OpenClaw.
- **Codebase formatting committed** — 15 files had accumulated formatting drift from the broken pre-commit hook.

## Decisions Made (Not Yet Implemented)

### 1. Rootless Docker (HIGH PRIORITY)

**Decision:** Migrate from rootful Docker to rootless Docker on the VM.

**Why:** Docker socket access is root-equivalent. Anyone (or any compromised code) that can talk to `/var/run/docker.sock` can run `docker run --privileged -v /:/host` and own the entire machine. Rootless Docker solves this fundamentally — the daemon runs as an unprivileged user, so socket access cannot escalate to host root.

**VM readiness (verified):**
- Kernel 6.8 (native overlayfs in user namespaces — no fuse-overlayfs needed)
- cgroup v2 ✅
- `uidmap` configured (`agent:100000:65536` in `/etc/subuid` and `/etc/subgid`)
- `slirp4netns` installed
- `dockerd-rootless-setuptool.sh` installed
- `agent` user (uid 1000) exists, in `docker` group

**Critical implementation detail — credential proxy networking:**
Rootless Docker does not have a `docker0` bridge interface. NanoClaw's credential proxy currently binds to the `docker0` bridge IP so only containers can reach it. With rootless Docker, `host.docker.internal` resolves to the slirp4netns gateway (typically `10.0.2.2`), not `172.17.0.1`. The proxy binding logic in `src/container-runtime.ts` must be updated, and this must be tested before cutover.

**Migration steps:**
1. Set up rootless Docker for `agent` user alongside existing rootful Docker (they coexist)
2. Enable linger: `loginctl enable-linger agent`
3. Build the container image under rootless Docker
4. Test credential proxy reachability from a rootless container
5. Test full agent flow (Slack message → container → Claude API → response)
6. Switch NanoClaw's systemd unit to `User=agent` with `DOCKER_HOST=unix:///run/user/1000/docker.sock`
7. Chown `/opt/nanoclaw` to `agent:agent`
8. Clean up rootful Docker images (currently 30 dangling images, ~47GB)
9. Keep rootful Docker installed as rollback path

**Blast radius if it goes wrong:** All agents stop working. Rollback is switching the systemd unit back to `User=root` and removing `DOCKER_HOST`. Estimated rollback time: 2 minutes.

**No new security risks introduced.** slirp4netns runs unprivileged (bug = unprivileged escape, not root escape). Rootless socket accessible to uid 1000 but neutered (can't escalate). Image store owned by unprivileged user (same tampering risk as today since NanoClaw is root).

### 2. SSH Login Notifications (MEDIUM PRIORITY)

**Decision:** Add PAM hook that sends Slack notification on every SSH login.

**Why:** If the SSH key is compromised despite the passphrase, this is the only detection mechanism. No false positive risk (Jeremiah knows when he SSHes in). Trivially simple, zero maintenance.

**Implementation:** 5-line shell script curling a Slack incoming webhook, installed as `session optional pam_exec.so` in `/etc/pam.d/sshd`. Webhook URL stored in `/etc/nanoclaw/slack-webhook-url` (root-only). `session optional` means a failure in the hook does not block SSH login.

### 3. NanoClaw as Non-Root Service User

**Decision:** Run NanoClaw as uid 1000 (`agent` user) instead of root.

**Why:** If the Node.js process is compromised (most likely via a supply chain attack on an npm dependency), running as root gives the attacker full system access — read `/etc/shadow`, write to `/root/.ssh/authorized_keys`, modify systemd units, persist across reboots. Running as uid 1000, the attacker is limited to NanoClaw's own files and Docker socket access.

**Note:** This is partially addressed by rootless Docker (which also requires switching to a non-root user). These should be done together.

**Tradeoff — uid 1000 vs a separate uid:**
- uid 1000 (same as containers): simpler, no chown complexity, but container escape lands with same uid as NanoClaw
- Separate uid (e.g., 2000): container escape can't immediately read NanoClaw's files, but needs chown/ACL mechanisms for container-writable directories
- Decision: uid 1000 is pragmatic. Container escape is already catastrophic (Docker socket access), and the second uid escalation is trivial for a sophisticated attacker. The real mitigation is rootless Docker (which neuters the socket).

## What Was Evaluated and Deferred

### Container `--read-only` rootfs
**Why deferred:** Containers are already ephemeral (`--rm`). Malware can't persist across invocations regardless. The `--read-only` flag would require mapping out every writable path (tmpfs mounts) for Claude Code CLI, chromium, npm/npx, git — significant testing effort for marginal security gain.

### Container memory/PID limits
**Why deferred:** `--memory=4g` is dangerous on an 8GB VM with MAX_CONCURRENT_CONTAINERS=3 (3×4GB > 8GB → OOM killer). `--pids-limit=256` is safe but low priority. Can revisit if the VM is upgraded.

### Egress filtering
**Why deferred:** Containers need real internet access (web browsing, git, package installs). Strict lockdown (containers only reach credential proxy) breaks core agent functionality. Port-level filtering (allow 443/22/53) catches only commodity malware. The cost/benefit ratio is unfavorable for the current architecture.

### Security heartbeat module / file integrity monitoring
**Why deferred:** Over-engineering risk for a single-operator system. Alert fatigue is real — who responds at 3am? Agents monitoring their own security is fox-guarding-the-henhouse. Revisit when the system has multiple operators or is running client workloads.

### Custom seccomp profile
**Why deferred:** Docker's default seccomp profile already blocks dangerous syscalls. Custom profiles are maintenance burden for near-zero marginal gain over the default.

### Credential rotation automation
**Why deferred:** OAuth tokens expire naturally. SSH keys are passphrase-protected. Manual rotation with a documented runbook is sufficient at current scale. Worth automating when there are more credentials to manage.

## Incident Response Runbook (To Be Created)

If a compromise is suspected, rotate in this order:
1. Anthropic OAuth token (highest impact — controls all agent API access)
2. All Slack bot tokens (4 agents, each has its own app)
3. GitHub deploy key
4. SSH key to VM (generate new key, update `authorized_keys`)
5. Review assignments.db and messages.db for unauthorized modifications
6. Check git log on VM for unexpected commits
7. Rebuild container image from clean Dockerfile
8. Review NanoClaw source for modifications (especially `credential-proxy.ts`, `mount-security.ts`, `container-runner.ts`)

## Supply Chain Posture (Already Strong)

Verified defenses:
- `package-lock.json` committed and used with `npm ci` ✅
- `ignore-scripts=true` in `~/.npmrc` and `.npmrc` in repo ✅
- Small dependency surface (7 direct deps) ✅
- Override pinning for risky transitive deps (`axios: 1.13.6`) ✅
- Production deploys never run `npm install` ✅
- Weekly `npm audit` via host cron → `#aios-alerts` ✅ (added 2026-04-07)

Policies:
- **7-day release gate** — do not adopt new dependency versions within 7 days of release. Use `npm outdated` to check, but delay updates. The axios attack had a 3-hour window; a 7-day gate would have avoided it entirely.

Recommended additions:
- **Dependency tree monitoring** — alert when transitive dependencies change. Would have caught axios adding `plain-crypto-js` as a new dependency.

## Log Scrubbing & Sensitive Data in Logs (Audit: 2026-04-06)

### What's clean
- **Credential proxy** (`src/credential-proxy.ts`) — does not log headers or API keys
- **Slack tokens** — never logged, kept in closures
- **`.env` contents** — `readEnvFile()` does not log what it reads
- **Console output** — only static error messages, no variable data

### What leaks

**Container error logs (HIGH)** — `src/container-runner.ts` lines 514-535. When a container exits non-zero, the full `ContainerInput` (including the complete user prompt) plus all stderr/stdout is written to `groups/{groupName}/logs/container-{timestamp}.log`. If a user shared a password or API key with an agent and the container errors, it's on disk indefinitely.

**Agent output logged (MEDIUM)** — `src/message-processor.ts` line 335. First 200 chars of every agent response logged via pino (`logger.info`). Goes to journalctl.

**Recent activity snapshot (MEDIUM)** — `src/agent-executor.ts` lines 134-160 / `src/snapshot-writer.ts`. First 200 chars of recent messages written to `recent_activity.json` in IPC dirs. By design (agents need context), but persists on disk.

**Task result summaries (LOW)** — `src/task-scheduler.ts` line 245. First 200 chars stored in SQLite `scheduled_tasks` table.

### What doesn't exist yet
- No log rotation policy — journalctl and container log files grow unbounded
- No redaction filters — no pino filter strips common secret patterns
- No retention policy — container error logs are never cleaned up

### Recommended fixes

1. **Container error logs** — redact the `prompt` field from `ContainerInput` before writing to disk. Log metadata (group, threadTs, exit code, duration) but not message content. This is the highest-priority fix.
2. **Journalctl retention** — set `MaxRetentionSec=30d` and `SystemMaxUse=500M` in `/etc/systemd/journald.conf` on the VM.
3. **Container log file cleanup** — cron job or NanoClaw lifecycle hook to delete container logs older than 30 days from `groups/*/logs/`.
4. **Pino redaction** — pino supports `redact` paths in its config. Add redaction for fields like `prompt`, `content` in structured log objects.
5. **Agent output logging** — evaluate if logging first 200 chars of agent output is necessary. Consider removing or making it debug-level only.

## Reference Documents

- `docs/SECURITY.md` — existing security architecture doc (container isolation, mount security, credential proxy, IPC authorization)
- `docs/SECURITY-MODEL.md` — 9-dimension security mental model (new, created this session)
- `projects/tyr-aios-security-hardening.md` — Sherlock's detailed hardening analysis with prioritized recommendations (on VM, in strategy session)
- `projects/supply-chain-security-briefing-axios.md` — Axios npm supply chain incident report (on VM, in strategy session)
- GitHub secops skill (`Ciaran-Hughes/pointify/.claude/skills/secops/SKILL.md`) — osv-scanner dependency scanning policy. Safe to reference as a pattern for dependency scanning, but not a complete security skill.

## For Sherlock: When You Pick This Up

1. Read `docs/SECURITY-MODEL.md` first — this is the governing framework.
2. Read this brief for context on what's done and what's decided.
3. Your existing hardening analysis (`projects/tyr-aios-security-hardening.md`) is excellent and still valid — this brief captures decisions made on top of it.
4. The rootless Docker migration and SSH login notifications are Jeremiah's to implement (requires SSH to VM). Your role is the autonomous security system design referenced in the original assignment: recurring checks, dependency monitoring, anomaly detection.
5. Do NOT implement security changes autonomously without Jeremiah's approval. Security changes have high blast radius. Propose, don't execute.
