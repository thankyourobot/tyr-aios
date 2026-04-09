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

### 3. Set Up Rhythms and Heartbeats

Every agent gets a standard heartbeat — a cron job (`*/30 * * * *`) that fires every 30 minutes and drives the agent to check its task queue and push forward what it can.

**Robot's responsibilities at build time:**
- Create `groups/{folder}/HEARTBEAT.md` for the new agent — copy from `groups/global/HEARTBEAT.md` as the starting point and customize for the agent's domain if needed
- Create the standard heartbeat via `schedule_task` MCP tool (cron `*/30 * * * *`, isolated context, prompt: "Run your heartbeat: read /workspace/group/HEARTBEAT.md and follow the instructions.")

Beyond the standard heartbeat, consider whether this agent's domain requires additional rhythms (weekly reports, daily syncs, monitoring intervals). If so, document them — the agent will create these custom schedules during its own onboarding.

**Deliverable:** Standard heartbeat scheduled. Domain-specific rhythms identified and documented for the agent to initialize during onboarding.

### 4. Trigger Onboarding

The agent drives its own onboarding. Robot's job is to set up the conditions for it.

**Robot's responsibilities at build time:**
- Establish chain of command in the agent's CLAUDE.md (who it reports to, where to escalate)
- Create an onboarding task in `tasks.db` assigned to the new agent. The task should reference `reference/onboarding-patterns.md` and confirm the chain of command.
- That's it. The agent's heartbeat picks up the task and drives onboarding autonomously from there.

See `reference/onboarding-patterns.md` for the full onboarding pattern — what the agent works through, the five pillars, autonomy principles, and how onboarding completes.

**Deliverable:** Chain of command documented in CLAUDE.md. Onboarding task created in `tasks.db`.

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
- `reference/onboarding-patterns.md` — How agents self-onboard; what Robot sets up at build time
