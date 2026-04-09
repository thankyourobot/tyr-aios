# TYR AI OS

**Repository:** `thankyourobot/tyr-aios`
**Product:** TYR AI Operating System — multi-agent operator plane for business orchestration.

## Identity & Relationship to NanoClaw

TYR AI OS is a **sibling project** of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), not a downstream fork. We share a common ancestor and about half our code but we are permanently diverged by design. Fork management is owned by the strategy agent (Sherlock), not the repo. The policy and living triage log live in his workspace:

- `groups/strategy/projects/upstream-policy.md` — sibling-project policy and workflow
- `groups/strategy/projects/upstream-watch.md` — current triage state (last-synced sha, ports, declines, watchlist)

Do NOT run the `/update-nanoclaw` skill — it is deprecated under the sibling-project model. Changes to `src/` or `container/` files that touch the sandbox, credential, or shared primitives layer should be coordinated with Sherlock per his upstream policy.

## Quick Context

- **Deployment:** single VM (Hetzner Cloud CX33, Nuremberg), rootful Docker, NanoClaw runs as root
- **Channels:** Slack only (WhatsApp/Telegram/Discord/Gmail upstream adapters are present but unused)
- **Agents:** 4 directors — Sherlock (strategy), Tom (operations), Ryan (growth), Alfred (back-office) — each with their own Slack app / bot user
- **Orchestration model:** per-group queues, per-thread container isolation, `#all-directors` multi-group routing, inter-agent Slack @mentions, assignment system (`assignments.db`), plan-mode PreToolUse hooks
- **Memory model:** per-group `.claude/` directories, LCM conversation summaries with lineage and integrity checker
- **Type safety:** branded types for `JID`, `BotUserId`, `AgentToken`
- **Container hardening:** `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, Opus 4.6 with 1M context pinning, prompt redaction in logs, audit logging

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation, startup bootstrap |
| `src/channels/slack.ts` | Slack adapter with TYR multi-group / multi-bot additions |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Config: trigger patterns, paths, intervals, constants |
| `src/container-runner.ts` | Spawns agent containers with mounts, env, security flags |
| `src/container-runtime.ts` | Container runtime abstraction (host gateway detection, bind host, orphan cleanup) |
| `src/credential-proxy.ts` | Anthropic credential injection proxy (to be replaced by OneCLI — see spec) |
| `src/task-scheduler.ts` | Scheduled tasks and recurring assignments |
| `src/db.ts` | SQLite operations (registered groups, assignments, messages) |
| `src/jid.ts` | JID branded type and parsing |
| `groups/{folder}/CLAUDE.md` | Per-group agent context (isolated) |
| `groups/global/CLAUDE.md` | Shared agent context (read-only for non-main agents) |
| `container/skills/*.md` | Container-mounted skill references available to all agents |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/debug` | Container issues, logs, troubleshooting (use the `aios-troubleshoot` skill from the local machine, not via agents) |
| `/setup` | First-time install on a new VM (rarely used — we have one production VM) |
| `/customize` | Adding channels, integrations, changing behavior |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/update-nanoclaw` | **DEPRECATED** — do not use. See `docs/UPSTREAM-POLICY.md` |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev              # Run with hot reload (local development)
npm run build            # Compile TypeScript
./container/build.sh     # Rebuild agent container image
npx tsc --noEmit         # Type check without emitting
npm test                 # Run test suite (vitest)
```

## Deployment

**Production VM:** Hetzner Cloud CX33 at `46.225.209.157` (Nuremberg `nbg1`).

```bash
# SSH (passphrase cached in 1Password / Keychain)
ssh tyr-aios

# Service management on the VM (systemd, runs as root)
systemctl status nanoclaw
systemctl restart nanoclaw
journalctl -u nanoclaw -n 100 --no-pager
```

**Deployment flow:** see the `aios-troubleshoot` skill for the canonical runbook. Short version:

1. Make changes locally, verify with `npx tsc --noEmit && npm test`
2. Commit and push to `thankyourobot/tyr-aios`
3. SSH to VM, `cd /opt/nanoclaw && git fetch origin && git reset --hard origin/<branch>`
4. `chown -R agent:docker src/ container/ groups/` (SSH runs as root, files need agent ownership)
5. `systemctl restart nanoclaw` or `touch /opt/nanoclaw/data/restart-requested`

## Architecture Documents

- [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md) — 10-dimension security framework
- [`docs/SECURITY-HARDENING-BRIEF.md`](docs/SECURITY-HARDENING-BRIEF.md) — security roadmap with Agent Traps analysis, read/write separation design
- [`docs/SECURITY.md`](docs/SECURITY.md) — current architecture: container isolation, credential proxy, mount security
- [`docs/INCIDENT-RESPONSE.md`](docs/INCIDENT-RESPONSE.md) — credential rotation and incident runbooks
- `groups/strategy/projects/upstream-policy.md` — sibling-project model and fork management policy (owned by strategy/Sherlock)
- `groups/strategy/projects/upstream-watch.md` — current triage state (owned by strategy/Sherlock)

Tech specs for in-flight work live in the `tyr-builder` repo at `_bmad-output/implementation-artifacts/tech-spec-aios-*.md`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```
