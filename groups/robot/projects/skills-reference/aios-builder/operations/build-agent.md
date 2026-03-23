# Build Agent

Build a new agent or modify an existing one.

## Intent

Produce a fully operational agent: a defined directive, scoped skills, foundational rhythms, and a self-onboarding path that gets the agent from zero to functional with minimal hand-holding.

## Four Parts of an Agent Build

### 1. Define the Directive and Outcome

What is this agent's prime directive? What outcome is it optimizing for? This is the single most important decision — everything else flows from it.

The directive should be narrow enough to be evaluable (pass/fail) and specific enough to filter which skills, channels, and actions belong.

**Deliverable:** CLAUDE.md with clear identity, prime directive, domain, channels, and boundaries.

### 2. Scope the Tools and Skills

Given the directive, what skills does this agent need? What tools should it have access to? What integrations make sense?

Stay disciplined — only include what directly serves the agent's goals. If a skill doesn't obviously support the prime directive, it doesn't belong. Aim for 7-10 skills maximum.

**Deliverable:** Skills installed or identified for installation, with reference files for relevant domain knowledge.

### 3. Outline the Rhythms and Heartbeats

How does this agent stay present? What scheduled tasks should it run? What proactive check-ins make sense for its domain?

A good agent has a heartbeat — predictable, autonomous activity that keeps it engaged with its domain without being asked. Not every agent needs one immediately, but consider what rhythms would make this agent feel like a real team member.

**Deliverable:** Scheduled tasks created (if applicable). Heartbeat patterns documented in CLAUDE.md or relevant skill files.

### 4. Self-Onboarding

What does this agent need to become fully operational? How much of that process can it drive itself?

Design the onboarding as a path the agent can largely follow autonomously: read these files, familiarize with this domain, set up these databases, verify these integrations. The less human hand-holding required, the better.

**Deliverable:** Onboarding path documented. Agent has run through it (or is ready to on first invocation).

## Execution

This operation follows the build philosophy — assess complexity, create a workpaper if medium+, and scale ceremony accordingly.

**Collaborative mode:** Elicit the directive and domain knowledge from the human. Draft the CLAUDE.md together. Review skills and rhythms. The builder structures what the human already knows about this agent's role.

**Autonomous mode:** If the agent's purpose is clear from context (e.g., a task in tasks.db says "create a security monitoring agent"), make judgment calls and document decisions in the workpaper. Stop only when genuinely human-blocked.

## Infrastructure

Building an agent requires host-level access for:
- Creating the group directory under `groups/`
- Registering the group in the database
- Setting up the workspace structure (.claude/skills/, projects/, memory/, database/)
- Creating scheduled tasks for heartbeats
- Setting file ownership (uid 1000)

Non-main agents cannot do this directly. If a non-main agent is building a new agent, it produces the deliverables in its workspace and creates a task for the main group to handle deployment.

## References

- `reference/agent-patterns.md` — What defines a good agent, CLAUDE.md conventions
- `reference/aios-primitives.md` — System architecture, groups, mounts, scheduling
- `reference/build-philosophy.md` — Core build loop, adaptive autonomy, workpaper standards
- `reference/adversarial-review.md` — Review protocol for medium+ builds
