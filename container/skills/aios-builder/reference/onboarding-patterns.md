# Onboarding Patterns

How agents get operational — and stay that way.

## Two Distinct Modes

**Onboarding** and **session orientation** are different things and should not be conflated.

**Onboarding** is explicitly triggered — by a human, a task, or a significant change in the agent's scope or directive. It's a deliberate process with a defined outcome: the agent has a confirmed prime directive, functional tools, an initialized workspace, and a clear picture of what's in front of it. Because it's explicit, it's stable — agents don't re-onboard spontaneously or on every launch.

**Session orientation** is lightweight and automatic — a quick check at the start of any session to pick up where things left off. It's not onboarding; it's just situational awareness.

## Onboarding: Core Principles

**1. Explicit trigger only.**
Onboarding runs when invoked — by a human, a deployment task, or a directive change. It does not run automatically on every launch. This keeps it stable and prevents agents from re-initializing themselves or creating duplicate artifacts in normal operation.

**2. Establish the prime directive first.**
The most important outcome of onboarding is a confirmed, internalized prime directive. Everything else — skills, rhythms, workspace setup — flows from it. An agent that completes onboarding without clarity on its prime directive is not fully onboarded.

**3. Push forward autonomously; surface blockers clearly.**
An agent should resolve as much of its own onboarding as possible. Judgment calls should be made and documented. Stop for human input only when genuinely blocked — missing credentials, unresolvable scope ambiguity, decisions that require human authority. When blocked, be specific: what's the blocker, what's needed, what's already done.

**4. Onboarding is idempotent.**
Running onboarding twice should produce the same result as running it once. Check before creating — don't duplicate tasks, files, or messages. The system should tolerate re-onboarding gracefully.

**5. Self-contained by default.**
A well-built agent should be able to onboard from scratch with no human hand-holding. If it can't, that's a signal the documentation or skill structure is incomplete — not that the human needs to fill the gap.

**6. Minimal footprint.**
Onboarding should leave no trace unless something was actually accomplished. No "I'm online!" announcements, no placeholder tasks, no status pings for their own sake. The agent's presence is demonstrated through action, not declaration.

## Onboarding Steps

**1. Load identity**
Read CLAUDE.md (local + global). Confirm prime directive, domain, channels, and boundaries. If the prime directive is unclear or missing, resolve it before proceeding — this is a blocker.

**2. Load context**
Read reference files for active domains. Check `projects/` for in-flight work. Get a complete picture of what the agent is responsible for.

**3. Verify tools**
Confirm skills are loaded and integrations are functional. Initialize databases, config, or workspace structure if missing.

**4. Check the queue**
Query open tasks assigned to this agent. Review any external data sources that impact those tasks. If there's something actionable, push it forward. If not, stay silent.

**5. Confirm readiness**
The agent is onboarded when: prime directive is clear, tools are functional, workspace is initialized, and the task queue has been reviewed.

## Session Orientation (Not Onboarding)

Every session should begin with a lightweight orientation — not a full onboarding:

1. **Check the queue** — Query open tasks. Review relevant external data.
2. **Act or stand down** — Push forward what's actionable. Stay silent if there's nothing to do.

That's it. Re-read reference files only when working in an unfamiliar area or when something in the domain has changed.

## What Good Onboarding Produces

A well-onboarded agent:
- Has a confirmed, internalized prime directive
- Has functional tools and an initialized workspace
- Has reviewed its open task queue and knows what's in front of it
- Is ready to work autonomously without further prompting
- Has stayed silent if there was nothing to act on

## What Bad Onboarding Looks Like

- Agent onboards itself repeatedly without being asked
- Agent announces itself without doing anything
- Agent asks for instructions it could have found in its own files
- Agent creates tasks or artifacts it already created in a previous session
- Agent is active but disconnected from its actual task queue
- Agent waits for human confirmation before taking any step
- Agent completes setup without establishing a clear prime directive
