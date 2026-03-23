# Workpaper: Standard Heartbeat System

**Status:** Complete — pending host deployment (tasks 01KMBF96DDV4J6B8B8ZMBGHB83, 01KMBF96DEAWETD4A4V8C614MT, 01KMBF96DEAWETD4A4V8C614MV, 01KMBF96DEAWETD4A4V8C614MW)
**Complexity:** Medium (well-understood scope, foundational pattern, propagates across all agents)
**Date:** 2026-03-16

---

## Problem

Agents can go dormant between human-triggered sessions even when there is open work in front of them. There is no mechanism to nudge an agent back into action autonomously. The heartbeat solves this.

## Intent

A lightweight, recurring pulse that tells each agent: *check if there's anything to push forward, and do it. If not, stay silent.*

It is not a monitoring system or a reporting system. It is a task pulse.

## Decisions Locked

- **Cadence:** 30 minutes, configurable per-agent. Default 24/7 (no active hours restriction to start — can add later).
- **Context mode:** Isolated session with minimal context — only HEARTBEAT.md + agent identity. No full session replay.
- **Output convention:** Silent by default. Speak only when actioning something.
- **HEARTBEAT.md:** Global template that each agent can customize. Lives in each agent's workspace root at `/workspace/group/HEARTBEAT.md`.
- **Setup:** Agent creates its own heartbeat during onboarding via `schedule_task` MCP tool.

## Core Behavior

On each heartbeat invocation, the agent:
1. Reads HEARTBEAT.md for any agent-specific context/instructions
2. Checks open tasks in `tasks.db` assigned to it
3. Checks any external data sources relevant to those tasks (as defined per-agent)
4. Pushes forward what it can
5. Stays silent if nothing to act on

## Deliverables

1. **Global HEARTBEAT.md template** — at `groups/global/HEARTBEAT.md`, mounted read-only as `/workspace/global/HEARTBEAT.md`
2. **Per-agent HEARTBEAT.md** — at `groups/{folder}/HEARTBEAT.md`, lives at `/workspace/group/HEARTBEAT.md`. Customizes or extends global template.
3. **agent-patterns.md update** — Document heartbeat as a standard component of every agent, including setup instructions
4. **onboarding-patterns.md update** — Add heartbeat setup to first-launch checklist (step 4: Rhythms)
5. **SKILL.md registry update** — Add reference entry for heartbeat patterns

## Open Questions

- [ ] Should HEARTBEAT.md be automatically included in the isolated session's context, or does the agent explicitly read it? (Likely: agent reads it explicitly on invocation)
- [ ] What is the `chat_jid` for the scheduled heartbeat task — primary channel, or configurable? Need to confirm convention.
- [ ] Should there be a standard cron expression documented (e.g. `*/30 * * * *`) or interval-based (`1800000` ms)?

## Acceptance Criteria

- [ ] Global HEARTBEAT.md template exists and is mounted to all agents
- [ ] agent-patterns.md documents heartbeat as standard with setup instructions
- [ ] onboarding-patterns.md references heartbeat setup in first-launch flow
- [ ] Convention is clear enough that a new agent can set up its own heartbeat without additional guidance
