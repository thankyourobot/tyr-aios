# Upstream Watch

> **Draft — pending Sherlock's review and incorporation.**
> Companion to [upstream-policy.md](upstream-policy.md). Also drafted by Jeremiah on 2026-04-08. See the matching assignment in `assignments.db` for how to incorporate this into your triage practice.

**Policy:** [upstream-policy.md](upstream-policy.md)
**Upstream:** https://github.com/qwibitai/nanoclaw

## Current sync state

- **Last synced upstream sha:** `934f063` (update deps) — fetched 2026-04-08
- **Merge base with upstream:** `7e9a698a`
- **Our commits ahead of upstream:** 202 (as of 2026-04-08)
- **Upstream commits ahead of us:** 399 (as of 2026-04-08)

We are not "behind" — we are a sibling project. The 399 number is the set we triage against, not a deficit.

## Initial triage (2026-04-08)

This is the first formal triage under the sibling-project policy. Only critical items are enumerated here — exhaustive commit-by-commit review is deferred to the weekly workflow once it's operational.

### To port (security — high priority)

Commits we intend to cherry-pick or manually port in the near term:

| Upstream sha | Title | Why | Target file(s) | Status |
|---|---|---|---|---|
| `a4fd4f2` | `fix(security): prevent command injection in stopContainer and mount path injection` | Our `container-runtime.ts::stopContainer()` is vulnerable: builds a shell command string from container name with no validation. Low exploitability but real. | `src/container-runtime.ts`, `src/container-runner.ts`, `src/mount-security.ts` | **Pending** |
| `c98205c` | `fix: prevent full message history from being sent to container agents` | Data leak risk — reduces amount of conversation context exposed to per-spawn containers. | `src/container-runner.ts` (likely) | **Pending** (verify applicability — our LCM layer may have already addressed this) |
| `0f01fe2` | `fix(env): prevent crash on single-character .env values` | Stability fix for `.env` parser. Relevant if we ever have single-char values (we don't today, but harmless to apply). | `src/env.ts` (or equivalent) | **Pending** (low priority) |
| `d675859` | `fix: Fix npm audit errors` | Dependency CVE patches. Need to verify our deps match upstream's fix set. | `package.json`, `package-lock.json` | **Pending** (check against our current `npm audit`) |

### To port (bug fixes — medium priority)

| Upstream sha | Title | Why | Status |
|---|---|---|---|
| `474346e` | `fix: recover from stale Claude Code session IDs instead of retrying infinitely` | Reliability — we may hit this failure mode under long-running agents. | **Watchlist** (verify we don't already handle this) |
| `001ee6e` | `fix: correct stale session regex and remove duplicate retry logic` | Follow-up to above. | **Watchlist** |

### Declined to port (architectural decisions)

These are commits or clusters we explicitly chose not to port. Each has a reason so future triagers don't re-consider them:

| Upstream ref | Title / cluster | Reason |
|---|---|---|
| `e936961` | `feat: replace credential proxy with OneCLI gateway for secret injection` | **Implementing our own targeted OneCLI integration** — see `_bmad-output/implementation-artifacts/tech-spec-aios-onecli-agent-vault.md` in the tyr-builder repo. We write our own code that fits our multi-agent architecture; upstream's is a reference. |
| `8b53a95` | `feat: add /init-onecli skill for OneCLI Agent Vault setup and credential migration` | Upstream's skill assumes single-user laptop deployment. Our setup is production VPS with agents-as-operators. We write our own Phase 1 runbook in the OneCLI spec. |
| `14247d0` | `skill: add /use-native-credential-proxy, remove dead proxy code` | Apple Container alternative. We run rootful Docker on Linux. Not relevant. |
| `2983946` | `fix: setup skill skips /use-native-credential-proxy for apple container` | Same reason — Apple Container specific. |
| `4f1b09f` | `fix: migrate x-integration host.ts from pino to built-in logger` | Upstream replaced pino with their own logger. We keep pino because our logger configuration (prompt redaction, audit patterns) depends on it. Logger replacement would cascade conflicts across our 202 commits. |
| Upstream logger replacement cluster (multiple commits) | `replace pino with built-in logger` class of changes | Same reason — we keep pino, we don't adopt the built-in logger. |
| `v2` branch (all commits: `03c4e3b`, `8535875`, `d7c68e0`, `18d0b6e`, `5a0098e`, ...) | `v2: host core, agent-runner, session manager, sweep` | Upstream's v2 is heading toward single-user host-core architecture. Not our direction. We remain on the v1 architecture adapted for multi-agent orchestration. |
| Upstream config restructuring cluster | `restructure config.ts` changes | Our config.ts has diverged significantly with our multi-group / branded-types / LCM / plan-mode additions. Accepting upstream's restructure would cascade conflicts. |
| WhatsApp / Telegram / Discord / Gmail channel fixes (all commits touching `src/channels/{whatsapp,telegram,discord,gmail}.ts`) | Various | We don't use these channels. Upstream channel-specific fixes are skipped wholesale. |
| `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md` upstream edits | Upstream persona changes | Upstream's agent persona is "personal assistant"; ours is "multi-director operator plane." Persona edits don't port. |
| `README.md`, `CHANGELOG.md`, general documentation | Various | Upstream's narrative documentation doesn't apply to our product definition. |
| Apple Container compatibility cluster (e.g., `#1103`) | `Apple Container: fix networking` | Not our platform. |

### Watchlist (observed, decision pending)

Upstream work we've noticed but haven't triaged in detail. Added here so we don't forget.

| Upstream ref | Title / area | Notes |
|---|---|---|
| `#458` | `Security: Add network restrictions to agent containers to prevent data exfiltration` | Open upstream issue. High severity. Related to our own "container egress filtering" roadmap item. Follow upstream's eventual fix rather than inventing our own. |
| `#1669` | `Does Credential Proxy implementation risk Anthropic account bans?` | Open upstream issue. Discussing whether OAuth reverse-proxying Anthropic violates their ToS. Not acting on this — we already do OAuth proxying via `credential-proxy.ts` and the risk is unchanged with OneCLI. Worth reading comments if Anthropic issues a statement. |
| `#1500` | `Security: proxy Gmail/Calendar OAuth tokens through credential proxy` | Open. Covers future per-agent OAuth credential scoping we want for Alfred (Gmail/Calendar integration). Not acting yet — revisit when Alfred's Gmail scope is designed. |
| Upstream v2 progress | multiple commits in `v2` branch | Watching the direction of upstream's v2 architecture in case any primitives are worth adopting. No ports planned. |

### Skipped (no action, no review needed)

Commits that touched only Tier 3 files per the policy:

- All commits touching only `src/channels/{whatsapp,telegram,discord,gmail}.ts`
- All commits touching only `README.md`, `CHANGELOG.md`, `repo-tokens/*`, general docs
- All commits touching only upstream's setup skill files
- All commits touching only `groups/{global,main}/CLAUDE.md`

Not enumerated here. Count only: approximately 150-200 of the 399 commits fall into this category (rough estimate based on file-touch distribution).

## Triage workflow

See [UPSTREAM-POLICY.md](UPSTREAM-POLICY.md) for the full workflow. Quick reference:

```bash
cd /opt/nanoclaw   # on VM, or ~/dev-tyr/tyr-aios locally
git fetch upstream
git log <last-sync-sha>..upstream/main --oneline

# For each commit, categorize against the Tier 1/2/3 file lists in UPSTREAM-POLICY.md
# Update this file with decisions
```

## Recent ports

(Empty — first port will happen after the OneCLI spec is locked and the policy is in place.)

Format for entries:

```
- <our-sha>  Port upstream <upstream-sha>: <title>  (YYYY-MM-DD)
```

## Change history

| Date | Change |
|---|---|
| 2026-04-08 | Initial triage under sibling-project policy. 399-commit backlog triaged at high level. OneCLI adoption declined in favor of targeted in-house spec. |
