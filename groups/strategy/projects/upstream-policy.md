# Upstream Policy

> **Draft — pending Sherlock's review and incorporation.**
> Jeremiah authored this draft on 2026-04-08 during a security/OneCLI migration session. It is in your workspace (`projects/`) for you to review, relocate if appropriate, and incorporate into TYR AI OS's strategic practice. See the matching assignment in `assignments.db` for scope, acceptance criteria, and references.

**Status:** Draft (pending review)
**Drafted:** 2026-04-08
**Owner:** strategy/Sherlock
**Companion doc:** [upstream-watch.md](upstream-watch.md) (living triage log — also in draft)

## Summary

**TYR AI OS is a sibling project of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), not a downstream fork.** We share a common ancestor and roughly half our code, but we are permanently diverged by design. We selectively track specific upstream changes (security fixes, targeted features that fit our architecture) via a lightweight triage workflow; we do not attempt to stay aligned on commit count or architectural direction.

This document codifies how we think about the upstream relationship, what we track, how we decide to port or decline changes, and the long-term work that would make this model cheaper to maintain.

## Product definition: TYR AI OS vs NanoClaw

| | TYR AI OS | Upstream NanoClaw |
|---|---|---|
| **Primary use case** | Multi-agent operator plane for business orchestration | Single-user personal assistant across messaging channels |
| **Agent model** | 4 named directors (Sherlock, Tom, Ryan, Alfred) with distinct scopes, identities, and per-agent credentials | Single agent per install, personal-assistant context |
| **Deployment** | Rootful Docker on a production VPS (Hetzner Cloud CX33), NanoClaw runs as root | Laptop/Mac Mini, typically single-user |
| **Channel focus** | Slack with multi-group / multi-bot support | Multi-channel (WhatsApp, Telegram, Discord, Slack, Gmail) with equal focus |
| **Message coordination** | Per-thread container isolation, per-group queues, #all-directors multi-group routing, LCM summaries | Single-thread message handling |
| **Agent orchestration** | Director/member hierarchy, inter-agent Slack @mentions, assignment system, plan-mode approvals | Single agent, direct message response |
| **Credential model** | Per-agent scoping with future per-client scoping for operator plane | Single credential scope |
| **Type system** | Branded types (JID, BotUserId, AgentToken) for compile-time safety | Standard TypeScript primitives |
| **Future direction** | Multi-client operator plane (TYR manages client VMs via agents, not humans via SSH) | `v2` branch: single-user host core + session manager + sweep architecture |

These are not "NanoClaw plus features" — they are different product choices. Trying to maintain alignment with upstream would force us to adopt architectural decisions (single-user, channel-adapter-focused) that conflict with our product definition.

## The sibling-project model

### Core commitment

**We treat ourselves as a distinct product that happens to share an ancestor with upstream.** We do not measure our health by "commits behind upstream." We measure it by:

1. Whether we have the security posture we need
2. Whether our agents behave correctly for our multi-agent orchestration model
3. Whether we can sustainably incorporate upstream improvements we care about without a painful merge cycle

### What we track

Not all upstream work is relevant. Files are classified into three tiers:

#### Tier 1: Actively tracked (triage all commits weekly)

Files where upstream changes are likely to matter to us — security primitives, shared sandbox code, dependency updates:

- `src/container-runtime.ts`, `src/container-runner.ts` — sandbox and spawn logic
- `src/mount-security.ts` — mount validation (command injection surface)
- `src/ipc.ts`, `src/ipc-auth.test.ts` — IPC hardening
- `src/credential-proxy.ts` (until we decommission) — credential injection primitives
- `src/db.ts` — shared SQLite primitives
- `package.json`, `package-lock.json` — dependency CVE patches
- `container/Dockerfile` — image security baselines
- `.npmrc` — supply chain hardening

Triage action: every commit reviewed, security fixes ported within 1 week of upstream shipping them.

#### Tier 2: Passively watched (summary review, decision pending)

Files where upstream changes may or may not apply, depending on context:

- `src/config.ts` — structural changes need review
- `src/index.ts` — startup/bootstrap logic
- `src/channels/slack.ts` — Slack adapter work may conflict with our multi-group additions but occasional fixes are worth porting
- `container/agent-runner/src/*` — the in-container Claude runtime
- `setup/*` — setup helpers (we have our own but upstream's patterns are useful reference)

Triage action: commits reviewed at a summary level. Ports considered case-by-case. No SLA on speed.

#### Tier 3: Explicitly ignored

Files and zones that don't serve our product:

- `src/channels/whatsapp.ts`, `telegram.ts`, `discord.ts`, `gmail.ts` — channels we don't use; upstream PRs specific to these are skipped
- `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` — upstream personas don't apply to our director model
- `.claude/skills/setup/*` — we have our own setup flow, `/update-nanoclaw` is deprecated (see below)
- `v2/` branch — upstream's v2 architecture is heading toward single-user host-core + session-manager + sweep; not our direction
- Apple Container support — not our platform
- `README.md`, `CHANGELOG.md`, general documentation — upstream's narrative doesn't apply
- Upstream skill branches (`skill/compact`, `skill/voice-transcription`, etc.) — if we want a skill, we fork the code into our own `.claude/skills/` directory rather than merging the skill branch

Triage action: no review needed. Commits touching only these paths are skipped in the triage report.

### Triage cadence

**Weekly.** The triage workflow is:

```bash
# 1. Fetch upstream
cd /Users/jeremiah/dev-tyr/tyr-aios
git fetch upstream

# 2. Walk new commits since last sync
git log <last-sync-sha>..upstream/main --oneline

# 3. For each commit, categorize:
#    - Touches Tier 1 file + security/fix keyword → PORT (priority)
#    - Touches Tier 1 file + feature → REVIEW for port
#    - Touches only Tier 2 files → SUMMARY NOTE, decide later
#    - Touches only Tier 3 files → SKIP
#    - Mixed → read commit body, decide per-commit

# 4. Update UPSTREAM-WATCH.md with:
#    - New last-sync-sha
#    - Port actions taken (with our commit shas)
#    - Declined items with reasons
#    - Items added to watchlist
```

This is automatable and should eventually run as a weekly agent task (owned by Tom / operations). See **Backlog** below.

### Port workflow

When we decide to port an upstream commit:

1. Read the upstream commit fully (not just the title) — understand what it fixes and why
2. Try `git cherry-pick -x <upstream-sha>` first. The `-x` flag adds "cherry picked from commit <sha>" to the message, creating a traceable link.
3. If cherry-pick conflicts are in files we've diverged on, resolve manually. Keep our architecture, apply upstream's fix pattern.
4. If conflicts are fundamental (upstream's approach incompatible with our code), write a manual port that captures the fix intent and reference the upstream commit in the message body. Example message:

   ```
   Port upstream a4fd4f2: stopContainer command injection fix

   Upstream validated container names against /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
   before passing to exec. We apply the same validation but keep our async
   exec-via-spawn pattern.

   Ref: https://github.com/qwibitai/nanoclaw/commit/a4fd4f2
   ```

5. Add an entry to `UPSTREAM-WATCH.md` under "Recent ports" with our commit sha.

### Decline workflow

When we decide NOT to port an upstream commit or cluster:

1. Add an entry to `UPSTREAM-WATCH.md` under "Declined to port" with a one-line reason. Example:
   ```
   - upstream e936961 (feat: replace credential proxy with OneCLI) — implementing our own targeted OneCLI integration; see tech-spec-aios-onecli-agent-vault.md
   ```
2. If the decline represents a durable architectural choice (not a one-off), note it in **this policy document** under "Explicitly ignored" so future triagers don't re-consider the same class of work.

A decline is NOT a failure — it's an explicit architectural decision. The declined list is valuable because it prevents future reviewers from re-triaging the same commits.

### Deprecation of `/update-nanoclaw` skill

The existing `/update-nanoclaw` skill (referenced in `CLAUDE.md`) is designed for the "downstream fork catching up on upstream" model. Under the sibling-project model, this skill is **deprecated**. We do not run it.

Reason: `/update-nanoclaw` assumes the goal is to reduce divergence from upstream. Our goal is different — we selectively port specific changes while maintaining permanent divergence. The bulk-merge approach the skill uses would introduce changes we explicitly do not want (logger replacement, config restructuring, v2 architectural drift).

Action: leave the skill in place for reference but do not invoke it. Document in this policy. Consider removing the skill from the default skill list in a future cleanup.

## Backlog: making triage lighter over time

The current sibling-project model works but is moderately expensive — ~30-60 minutes per week of human or agent attention to triage upstream changes. We can reduce this cost by reshaping our own code to minimize surface area in the Tier 1 (actively tracked) zone.

### Long-term direction

The goal: **reduce the intersection between "files we've diverged on" and "files upstream changes frequently."**

Concrete backlog items (each would materially lower the weekly triage cost):

1. **Abstract the sandbox primitives layer.**
   Extract a clean interface for "spawn a container with these mounts and env vars" (our `buildContainerArgs` / `runContainerAgent`) so that our multi-agent orchestration logic lives above it. The sandbox layer itself could then be kept closer to upstream (fewer divergences), while our orchestration layer is unambiguously ours. Upstream's `container-runner.ts` changes could be ported to our sandbox layer more mechanically without touching orchestration.

2. **Extract Slack multi-group logic into a dedicated module.**
   Currently `src/channels/slack.ts` mixes our multi-group/multi-bot additions with upstream's base Slack adapter. Splitting into `src/channels/slack.ts` (base, closer to upstream) + `src/channels/slack-multigroup.ts` (ours, isolated) would reduce conflicts when upstream ships Slack fixes.

3. **Extract LCM as an optional layer.**
   LCM lives inline in `message-processor.ts` and `container/agent-runner/src/*`. If it were a clean opt-in hook (e.g., `lcm.maybeSummarize(threadContext)`), the core message processing could stay closer to upstream.

4. **Make plan-mode hooks a pluggable middleware.**
   Similar to LCM — plan mode is currently a fork of the PreToolUse logic. A middleware architecture would let us swap it in without touching the core hook dispatch.

5. **Branded types as a separate compile-time layer.**
   Our branded types (JID, BotUserId, AgentToken) conflict with upstream's primitive strings in most files. If we could generate runtime-compatible types from a single source (e.g., a `types.branded.ts` file that re-exports branded versions of everything), we might be able to isolate the ceremony to the edge of the codebase.

6. **Security hardening as a single diff.**
   Our `--cap-drop=ALL` and `--security-opt=no-new-privileges:true` additions are scattered through the container spawn logic. Collecting them into a named helper (`applySecurityHardening(args)`) makes both our code clearer AND future upstream conflicts more obvious.

7. **Eliminate `credential-proxy.ts` after OneCLI migration.**
   Once OneCLI is in place and stable, delete `credential-proxy.ts` entirely. This removes ~140 lines from our Tier 1 tracked surface. After deletion, the credential layer is upstream code (the `@onecli-sh/sdk`) rather than our own, so we don't track it for upstream changes at all.

### Rough priority order

1. #7 (delete credential-proxy after OneCLI) — natural side effect of the OneCLI migration
2. #6 (security hardening helper) — small, immediate triage benefit
3. #1 (sandbox primitives abstraction) — largest triage benefit, largest implementation cost
4. #2 (Slack multi-group extraction) — medium cost, medium benefit
5. #3, #4 (LCM + plan mode pluggable) — lower priority, larger refactors
6. #5 (branded types edge isolation) — lowest priority, most ambitious

None of these are scheduled work. They're backlog items to consider when the weekly triage burden becomes painful enough to justify the investment.

## Tooling and references

### Current state (manual)

- `git fetch upstream && git log HEAD..upstream/main --oneline` — see what's new
- `git log HEAD..upstream/main --name-only --pretty=format: | sort | uniq -c | sort -rn` — most-touched files in new commits
- `git show -- <file>` — per-file inspection of a commit
- This document (`UPSTREAM-POLICY.md`) — the policy
- `UPSTREAM-WATCH.md` — the living triage log

### Future state (automated)

A `weekly-upstream-triage` agent task that:

1. Fetches upstream
2. Walks commits since the last-sync sha stored in `UPSTREAM-WATCH.md`
3. For each commit, categorizes by tier using file path matching
4. Flags Tier 1 security fixes for immediate port consideration
5. Drafts a triage report to `#aios-alerts` with PORT / REVIEW / SKIP recommendations
6. Can optionally draft a PR description for simple cherry-picks

Owner: Tom (operations director). Natural fit because the operator plane includes fork maintenance.

See the TYR builder backlog for tracking this task's implementation.

## Related documents

- [upstream-watch.md](upstream-watch.md) — the living triage state (last-synced sha, recent ports, declined list, watchlist). Same directory.
- `docs/SECURITY-MODEL.md` (repo root, not in this workspace) — 10-dimension security framework that drives many of our triage decisions
- `docs/SECURITY-HARDENING-BRIEF.md` (repo root) — full security roadmap
- `docs/INCIDENT-RESPONSE.md` (repo root) — credential rotation and incident runbooks
- `_bmad-output/implementation-artifacts/tech-spec-aios-onecli-agent-vault.md` (in the `tyr-builder` repo on Jeremiah's local machine) — OneCLI integration spec, designed under the sibling-project model (we write our own code; upstream is a reference, not a source)

**Note:** The `docs/` files above live in the repo root, outside this workspace. You won't see them in `/workspace/group/` or `/workspace/global/`. If you need to read them, ask Jeremiah to share or mount them — or ask @Robot (main group agent) to fetch their content via the repo read mount.
