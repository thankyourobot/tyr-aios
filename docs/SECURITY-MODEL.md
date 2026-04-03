# TYR AI OS Security Model

Nine dimensions of security for AI agent infrastructure. This is the mental model that governs all security decisions in the TYR AI OS.

## 1. Identity

SSH keys, tokens, OAuth credentials — anything that proves "I am allowed to be here."

- Minimize copies (fewer places to steal from)
- Encrypt at rest (passphrase-protected keys, encrypted vaults)
- Detect usage (know when identity is used — SSH login notifications, API usage monitoring)
- Prefer ephemeral credentials over long-lived tokens

**Our key identities:** SSH key to VM, Anthropic OAuth token, Slack bot tokens, GitHub deploy key.

## 2. Secrets

API keys, environment variables, database credentials — anything that grants access to a specific resource.

- Encrypt everywhere (at rest, never in plaintext environment variables beyond the owning process)
- Never expose to untrusted code (the credential proxy pattern — containers get placeholders, proxy injects real credentials)
- Rotate on a schedule and immediately after any suspected compromise

**Our implementation:** `.env` file (chmod 600), credential proxy on host, `.env` shadowed with `/dev/null` in containers, secrets never in `process.env` (read into plain object instead).

## 3. Supply Chain

Dependencies, packages, build tools — code you voluntarily install that could be compromised.

- Treat all dependencies as untrusted until proven otherwise
- Block install-time code execution (`ignore-scripts=true` in `.npmrc`)
- Pin versions via lockfiles; use `npm ci` not `npm install`
- Pin critical transitive deps via `overrides` in `package.json`
- Never run `npm install` in production deploys (deploy via `git pull && npm run build`)
- Consider a release gate (e.g., 7-day delay before adopting new versions)
- Keep the dependency surface small

**Key insight from axios incident (2026-03-31):** Lockfile discipline is the last line of defense. Without `package-lock.json`, a floating range would have resolved to the malicious version. The attack window was only 3 hours — automated, not targeted.

## 4. Input

Messages, webhooks, email, calendar events — any data from external humans or systems. Also includes **indirect injection via tool outputs**: files agents read, web pages agents browse, command output containing attacker-controlled content.

- Assume all input is adversarial by default
- Sanitize before including in agent prompts (XML entity escaping for direct messages)
- The container sandbox is the primary defense against prompt injection — escaping is defense-in-depth
- Tool outputs (file reads, web browsing, bash output) are as dangerous as direct messages — they arrive through "trusted" channels but contain untrusted content
- When adding new input channels (email, calendar, webhooks), they MUST pass through the same sanitization path

**Our implementation:** `escapeXml()` in `router.ts` for all message content, sender names, timestamps, and IDs. Container isolation as primary boundary.

## 5. Containment

Container isolation, filesystem restrictions, process separation — limiting the blast radius when something is compromised.

- Ephemeral containers (`--rm`) — fresh environment per invocation, malware can't persist
- Non-root execution (uid 1000 inside containers)
- Drop all Linux capabilities (`--cap-drop=ALL`)
- Prevent privilege escalation (`--security-opt=no-new-privileges:true`)
- Mount security with blocked patterns (`.ssh`, `.env`, credentials, private keys)
- Per-group filesystem isolation (groups can't see each other's sessions or IPC)
- IPC authorization gates (non-main groups limited to their own scope)

**Principle:** Rather than relying on application-level permission checks, limit the attack surface by controlling what's mounted.

## 6. Exfiltration

Network egress controls — making it hard to get data out even if a compromise occurs.

- Containers currently have unrestricted outbound network access (needed for web browsing, git, package installs)
- Port-level egress filtering (allow 443/22/53, block everything else) catches commodity malware but not targeted attacks on port 443
- The real exfiltration defense is containment — agents can only exfiltrate what they can see, and mount security limits what they can see

**Gap:** This is the weakest dimension. Full egress lockdown isn't viable because agents need internet access. Defense here is primarily through other dimensions (containment, secrets).

## 7. Backups

Data durability and recovery — encrypted, tested, isolated from primary access paths.

- Continuous SQLite replication (Litestream to Backblaze B2)
- Daily encrypted backups (restic to Backblaze B2)
- Automated VM snapshots (Hetzner)
- Backups must be encrypted at rest
- Backup credentials must not be accessible from agent containers
- DR test script exists: `/opt/dr-test.sh`

## 8. Observability

Audit trails, logging, alerting — knowing what happened and when.

- SSH login notifications (alert on every login — if you didn't SSH in, it's an intrusion)
- Credential proxy request logging (which agents made which API calls)
- Container stdin/stdout persistence (what did the agent do during its run)
- File integrity monitoring for critical paths (`.env`, `authorized_keys`, `sshd_config`)

**Principle:** Prevention assumes you've thought of everything. Detection is the safety net for when prevention fails. The Mercor breach demonstrated that zero detection means attackers move freely.

**Current gap:** No SSH login notifications, no credential proxy logging, no file integrity monitoring. This dimension is largely unimplemented.

## 9. Least Privilege

The orchestrator itself shouldn't be omnipotent — limit what the host process can do.

- NanoClaw should not run as root (currently does)
- Docker socket access = root equivalent — mitigate with rootless Docker
- Systemd hardening directives (`NoNewPrivileges`, `ProtectSystem`, `ProtectHome`)
- The main agent (Robot) has RW access to NanoClaw source via project root mount — this is mounted read-only to prevent self-modification

**Docker socket problem:** Anyone with Docker socket access can run `docker run --privileged -v /:/host` and own the entire machine. Rootless Docker solves this — the daemon runs as an unprivileged user, so socket access cannot escalate to host root. This is the recommended mitigation.

---

## How These Dimensions Interact

The security model is defense-in-depth. Each dimension compensates for failures in others:

- If **supply chain** fails (compromised dependency) → **containment** limits what it can access, **least privilege** limits host-level damage, **exfiltration** controls limit data theft, **observability** detects anomalies
- If **input** fails (prompt injection succeeds) → **containment** sandboxes the agent, **secrets** are hidden behind the credential proxy, **identity** credentials are not in the container
- If **identity** fails (SSH key stolen) → **observability** alerts on the login, damage is limited to what that identity can reach

No single dimension is sufficient. The system is secure when all nine work together.
