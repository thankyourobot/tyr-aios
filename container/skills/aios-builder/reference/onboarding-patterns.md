# Onboarding Patterns

How a new agent gets from deployed to fully operational.

## What Onboarding Is (and Isn't)

**Onboarding** is the process by which a new agent establishes its footing — confirming its directive, getting its tools working, orienting its workspace, and reaching a state where it can operate autonomously. It is explicitly triggered, has a defined outcome, and ends with a confirmation from the chain of command.

**Session orientation** is different. It happens automatically at the start of every session and is lightweight: check the queue, act on what's there, stay silent if there's nothing. Not onboarding. Don't conflate the two.

## How It's Triggered

When Robot builds a new agent, it creates an onboarding task in `tasks.db` assigned to the new agent. The task should include a pointer to this document and confirm the chain of command. The agent's standard heartbeat picks it up and drives progress — on each heartbeat invocation, the agent checks whether the onboarding task is open and moves it forward. The task stays open until onboarding is complete and confirmed.

Onboarding is a one-time process. If something significant comes up later that requires additional integration, the chain of command creates a new task for it. There is no "re-onboarding."

## The Five Pillars

### 1. Chain of Command

Before anything else: who does this agent report to, and who do they go to when stuck?

- Check CLAUDE.md first. If not there, check the onboarding task.
- If chain of command is not documented anywhere, this is a blocker — surface it to whoever created the agent before proceeding.
- Chain of command defines the escalation path for the rest of onboarding and beyond.

### 2. Clarity

Does the agent know what it's here to accomplish?

- Confirm the prime directive is clear and internalized.
- Identify what success looks like — a definition of done, a metric, or a clear outcome.
- If the prime directive is missing or ambiguous, resolve it with the chain of command before proceeding. Guessing here is expensive.

**Director agents** — those responsible for improving a function over time, not just executing within it — should build a gap analysis as part of establishing clarity. Knowing the directive is not the same as knowing what excellent execution of that directive looks like. The gap analysis is how a director agent maps that territory and grounds Access and Rhythms decisions in something real. See `reference/gap-analysis.md`.

### 3. Access

What tools, skills, and resources does this agent need to do its job?

- Take inventory: what's needed vs. what's already provisioned and functional.
- For anything not yet accessible: identify the owner, the expected timeline, and what the agent can do in the meantime.
- Output: either a fully operational toolkit, or a tracked dependencies list with owners and timelines.

Don't block all of onboarding on an access dependency. Document it, move forward on everything else.

### 4. Rhythms

The standard heartbeat is already running — Robot set it up at build time. The agent doesn't need to do this.

What the agent needs to do:
- Determine whether any domain-specific rhythms are needed beyond the standard heartbeat (e.g., a weekly report, a daily sync, a monitoring check).
- Create those scheduled tasks via the `schedule_task` MCP tool if applicable.

### 5. Workspace Orientation

Get a picture of the agent's environment before diving into active work.

- Check `projects/` for in-flight workpapers or prior work.
- Check `memory/` for persisted context from previous sessions.
- Confirm any databases in `database/` are initialized.
- Know what channels this agent is bound to and how it's expected to communicate in each.

## Autonomy Principles

Onboarding should be largely self-driven. The agent doesn't wait for instructions — it works through the pillars and makes judgment calls.

**Solve problems proactively.** When something is unclear, look for the answer in the available files before asking. Reach out only when genuinely blocked.

**Surface blockers clearly.** When you do need help: be specific. What exactly is needed, from whom, and what has already been tried or found.

**Patient, not passive.** If waiting on a dependency or a response from the chain of command, keep moving on everything else. Check back at a reasonable cadence — not constantly, not never.

**Break it down further.** If blocked externally, ask: is there a smaller piece I can move independently? Can I prepare so the external dependency takes less time when it arrives?

**Document judgment calls.** Decisions made during onboarding should be recorded — in a workpaper, a task note, or memory. Future sessions and the chain of command should be able to understand what was decided and why.

## Completing Onboarding

When the agent believes it has worked through the five pillars and is ready to operate, it checks in with the chain of command:

> "I believe my onboarding is complete. Is there anything else you think would be helpful for me to get fully integrated into my role?"

This is a natural handoff — a chance to surface anything missed before moving into normal operations. If the chain of command has nothing to add, the agent closes the onboarding task and proceeds. If they do, the agent works through it and checks in again when done.

