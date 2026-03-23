# Onboarding Patterns

How a new agent gets from deployed to fully operational — and the principles that govern that process.

## What Onboarding Is

Onboarding is the process by which a new agent orients itself, establishes its footing, and becomes a functioning member of the organization. Think of it like a new employee's first days: they need to know who they report to, what they're here to do, what tools they have, and how the office works.

Onboarding is not a one-time event that the building agent performs for the new agent. It is a process the new agent drives itself, initiated by a task created at build time.

## How It's Triggered

When a new agent is built, the building agent creates an onboarding task in `tasks.db` assigned to the new agent. The new agent's heartbeat picks it up on first invocation and works through it autonomously.

This design is intentional: the agent owns its own onboarding. It is not handed a script to follow — it is handed a starting point and expected to drive the rest.

## The Five Pillars

### 1. Chain of Command

Before anything else, the agent must know its place in the organization.

- Who does this agent report to?
- Who is the escalation path when stuck?
- Which other agents exist, what do they handle, and how do they coordinate?
- Where does inter-agent coordination happen? (Answer: `tasks.db`)

A new agent should never be left wondering who to ask when things are unclear. This is the first thing to establish.

### 2. Clarity

The agent must understand what it's here to accomplish — not just broadly, but operationally.

- What is the prime directive? What outcome is it optimizing for?
- What does success look like? Is there a definition of done or a metric?
- What is explicitly in scope, and what is out of scope?
- If any of the above is missing or ambiguous, how does the agent get clarity?

If clarity is missing at onboarding, the agent should surface this as a blocker rather than guessing. A false start built on a misunderstood directive wastes far more time than asking early.

### 3. Access

The agent needs its tools to work. Access failures that surface mid-task are expensive — better to surface them during onboarding.

- What skills, tools, and integrations are needed to accomplish the prime directive?
- Which are already provisioned and confirmed functional?
- Which require setup, credentials, or a dependency on another agent or human?
- For anything not yet accessible: who needs to do what, and how long should the agent wait before escalating?

The output of this pillar is either a fully operational toolkit or a clear dependencies list with owners and expected timelines.

### 4. Rhythms

Some agents have work that needs to happen on a schedule without being asked. Onboarding is the time to identify and initialize these.

- Does this agent have a standard heartbeat? (Check global conventions — a system-wide standard heartbeat pattern may apply.)
- Are there domain-specific rhythms beyond the standard? (e.g., weekly reports, daily syncs, monitoring intervals)
- For each rhythm: what is the cadence, what is the output, and where does it go?

Heartbeats are created via the `schedule_task` MCP tool. They transform a passive agent into a proactive one.

### 5. Workspace Orientation

Before diving into active work, the agent should understand its environment.

- What's in `projects/`? Are there in-flight workpapers to pick up?
- What's in `memory/`? Is there prior context to load?
- What databases exist in `database/`? Are they initialized?
- What channels is this agent bound to, and what is the expected tone and response behavior in each?

Orientation is not about reading everything — it's about knowing what exists and where to look when needed.

## Autonomy Principles

Onboarding should be largely self-driven. The agent is expected to:

**Solve problems proactively.** When encountering a blocker, the first response is to look for a way around it — simplify the request, find an alternative, decompose the problem further. Reach out only when the problem is genuinely outside the agent's ability to resolve.

**Reach out when help is needed.** Proactive problem-solving is not the same as suffering in silence. When something requires human input or another agent's action, surface it clearly and specifically: what is needed, from whom, and what the agent will do in the meantime.

**Be patient, not passive.** When waiting on a dependency, the agent should continue making progress on everything it can. It should check back at a reasonable cadence — not constantly, not never. If a dependency is taking unreasonably long, escalate one level.

**Break requests down further if blocked.** If an outside party is slow or unresponsive, the agent should ask: is there a smaller piece of this I can move forward independently? Can I prepare more so the external dependency takes less time when it arrives?

**Document decisions, not just actions.** When making judgment calls during onboarding, record them. Future context windows (and future builders) should be able to understand what was decided and why.

## Definition of Done

An agent has completed onboarding when:

1. **Chain of command is clear** — The agent knows who it reports to and how to escalate.
2. **Clarity is confirmed** — The prime directive is understood, and any ambiguities have been surfaced and resolved (or formally deferred).
3. **Access is resolved** — All required tools are operational, or a tracked dependencies list exists for anything not yet available.
4. **Rhythms are initialized** — Standard heartbeat is running; domain-specific schedules are created if applicable.
5. **Workspace is oriented** — The agent has reviewed what exists in its workspace and knows where active work lives.
6. **Signal sent** — The agent has posted a brief onboarding completion note to its primary channel, confirming it's live, operational, and ready.

The final signal is not ceremonial — it is a forcing function. An agent that can write a clear, accurate completion note has genuinely oriented itself. One that can't hasn't.
