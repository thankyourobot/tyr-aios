# Workpaper: Onboarding Patterns Reference File

**Status:** In progress — spec phase
**Complexity:** Medium
**Date:** 2026-03-23
**Authoritative source:** Conversation with Jeremiah, Mar 16 + Mar 23 2026

---

## Problem

Agents need a clear, authoritative pattern for how they get from deployed to fully operational. The current `onboarding-patterns.md` exists but was not produced through the proper spec→build process. This workpaper drives a proper build using our conversation as the source of truth.

## Scope

**In scope:**
- `container/skills/aios-builder/reference/onboarding-patterns.md` — full rewrite
- `container/skills/aios-builder/operations/build-agent.md` — update Part 4 (Self-Onboarding) to reference the new patterns and document the mechanical trigger

**Out of scope:**
- Changes to `agent-patterns.md`, `aios-primitives.md`, or global CLAUDE.md
- The onboarding operation file (Part 4 of build-agent.md is sufficient for now)

---

## Key Decisions (from conversation)

### Trigger
- Robot (building agent) creates an onboarding task in `tasks.db` assigned to the new agent at build time
- The agent's standard heartbeat picks it up on first invocation
- Onboarding is **explicitly triggered only** — not automatic on every launch

### Re-onboarding
Not a concept. Onboarding is a one-time task. Future integration needs get new tasks from the chain of command.

### The Five Pillars (Jeremiah's employee analogy)

**1. Chain of Command**
Who does this agent report to? Where do they go for help when stuck?
- Escalation path must be clear before anything else
- For TYR: Robot → Jeremiah. Generic: document in CLAUDE.md or onboarding task.

**2. Clarity**
Does the agent know what it's here to accomplish?
- Prime directive confirmed and internalized
- Definition of done or success metric identified
- If missing: specific path to get clarity (don't guess, don't stall — ask the right person)

**3. Access**
What tools and resources are needed?
- Inventory what's needed vs. what's already provisioned
- For anything not yet accessible: identify owner, expected timeline, and what to do in the meantime
- Output: either a fully operational toolkit or a tracked dependencies list

**4. Rhythms**
Standard heartbeat is set up by Robot at build time — agent doesn't need to do this.
- Identify any domain-specific rhythms beyond the standard heartbeat
- Create custom scheduled tasks via `schedule_task` MCP if needed

**5. Workspace Orientation**
- Review `projects/` for in-flight work
- Review `memory/` for prior context
- Confirm databases initialized if applicable

### Autonomy Principles (Jeremiah)
- **Proactive by default** — solve problems within reason before reaching out
- **Surface blockers clearly** — when you do reach out: what's needed, from whom, what's already done
- **Patient, not passive** — keep moving on everything else while waiting; check back at reasonable cadence
- **Break it down further** — if blocked externally, find smaller pieces to advance independently
- **Document judgment calls** — decisions made during onboarding should be recorded

### Minimal Footprint
- No "I'm online!" announcements
- No placeholder tasks or status pings
- Presence demonstrated through action, not declaration

### Session Orientation (separate concept)
Not onboarding. Happens automatically at the start of every session:
1. Check the queue — open tasks + relevant external data
2. Act or stand down

---

### Completion
When agent believes onboarding is complete → checks in with chain of command: "I believe my onboarding is complete. Is there anything else that would help me get fully integrated?" Chain of command confirms → agent closes the onboarding task. This is the only outbound signal, and it's purposeful (confirmation loop), not ceremonial.

### Minimal Footprint (updated)
Valid principle but doesn't suppress the completion check-in. No noise for its own sake — no unprompted announcements, no placeholder tasks. The completion check-in is required and serves a real purpose.

---

## Acceptance Criteria

- [ ] `onboarding-patterns.md` captures all five pillars from Jeremiah's employee analogy
- [ ] Mechanical trigger (task in tasks.db, picked up by heartbeat) is documented
- [ ] Completion check-in with chain of command is documented
- [ ] Session orientation is clearly distinguished from onboarding
- [ ] Autonomy principles are documented
- [ ] No re-onboarding concept
- [ ] Spec adversarially reviewed
- [ ] build-agent.md Part 4 updated to reference onboarding-patterns.md and document Robot's build-time responsibilities
- [ ] Deliverables adversarially reviewed
