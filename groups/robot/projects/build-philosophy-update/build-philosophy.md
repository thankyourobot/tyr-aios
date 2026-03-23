# Build Philosophy

How TYR builds things. Read this to understand the principles, then apply judgment.

## Core Loop

Every build follows the same fundamental cycle, scaled to complexity:

1. **Understand** — What's being built? What does the spec say? What exists already?
2. **Research** — Read the codebase, check conventions, understand the context you're building into
3. **Spec** — For medium+ builds, create a workpaper: problem, approach, decisions, acceptance criteria
4. **Review the spec** — Adversarial review the spec before building. A bad spec wastes more time than a bad implementation.
5. **Build** — Write the thing
6. **Review the build** — Adversarial review the deliverables. Self-check for simple builds.
7. **Resolve** — Fix what matters, skip noise, document decisions

This is a loop, not a waterfall. Steps overlap. Research continues during building. Review may send you back to step 1. For simple builds, steps 3-4 are skipped entirely. The agent navigates this using judgment.

## Adaptive Autonomy

Not every build needs the same ceremony. The agent assesses complexity at the start and scales its process accordingly.

**Low complexity** — Well-understood edges and scope of problem and solution; easy to verify and revert. Just build it. No workpaper, no elicitation, self-check only.

**Medium complexity** — Edges or scope of problem or solution not fully understood; creating or editing a foundational pattern; blast radius of several files or more. Focused questions if anything is ambiguous. Workpaper required. Adversarial review on spec and deliverables.

**High complexity** — Low understanding of problem or solution; solution has many interconnected parts; blast radius of many files. Full elicitation to draw out domain knowledge. Detailed workpaper as source of truth. Adversarial review on spec and deliverables with full resolution.

**Signals that raise complexity:** multiple components, system-level scope, uncertainty about approach, multi-layer impact, domain knowledge required from the user, broad propagation scope — patterns that will replicate across many agents, organizations, or contexts.

**Signals that lower complexity:** single file focus, clear precedent/pattern to follow, confident specific instructions, "just fix" / "simple" / "quick" language.

The agent makes this judgment at the start. It can be wrong — if a "simple" build reveals hidden complexity, escalate. If a "complex" build turns out straightforward, de-escalate.

## Collaborative vs. Autonomous Mode

Builds happen in one of two modes, determined by context:

**Collaborative (human present):** Elicit knowledge through targeted questions. Draft based on answers and codebase evidence. Review together. The builder structures what the user already knows — it doesn't invent from assumptions. When actively collaborating, check in on the human's read of complexity before proceeding — misalignment here is expensive.

**Autonomous (no human present):** Resolve all ambiguity proactively. Make judgment calls and document them in the workpaper. Push forward until genuinely blocked by a human-only step, then stop and request help clearly. The workpaper becomes the audit trail of decisions made.

## Planning, Not Checklists

At the start of any medium+ build, the agent plans its approach:

- What are the deliverables?
- What context do I need to gather?
- Where are the decision points that need human input (if collaborative)?
- What are the checkpoints where I should pause and verify (if any)?
- What are the safety boundaries for this specific build?

This plan is lightweight — a mental model, not a document. For high-complexity builds, it becomes part of the workpaper. The key principle: the agent plans its own stops based on what's being built, rather than following a fixed checklist.

## Workpapers & Persistence

Agent context is ephemeral — containers are destroyed after each execution, and long builds may span multiple context windows. Without intentional persistence, knowledge gets lost.

**Workpapers are required for all medium+ builds.** A workpaper is the source of truth — it captures the problem, approach, decisions made, acceptance criteria, and current status. It's what lets a future context (or a different agent) pick up where the last one left off.

- **Structure:** Use the tech spec template in `templates/` as a starting point
- **Where it lives:** `/workspace/group/projects/` during the build
- **Definition of done:** The workpaper's own acceptance criteria are met and adversarial review is resolved
- **Status tracking:** Keep the workpaper's status current. If the build spans multiple sessions, the workpaper is how the next session knows what's done and what's left.

**For simple builds:** No workpaper needed, but always check — does anything else need updating as a result of this change? A CLAUDE.md boundary, a skill reference file, a skill description? Building the thing is not the same as being done. Documentation is part of delivery.

**Persistence planning:** At the start of any build that might span multiple context windows, think about what needs to survive:
- The workpaper (primary mechanism — always update before ending a session)
- Skill reference files (domain knowledge produced during the build)
- CLAUDE.md updates (if the agent's identity or boundaries changed)
- Memory tool entries (for cross-session continuity)

The workpaper defines its own finish line. The build philosophy doesn't prescribe a universal definition of done — each build is different.

## Adversarial Review

For medium+ complexity builds, adversarial review happens at **two points**:

1. **Review the spec** (before building) — Catches design problems, missing requirements, bad assumptions. This is arguably more important than reviewing the build, because a flawed spec wastes everything downstream.
2. **Review the deliverables** (after building) — Catches implementation problems, convention violations, missed acceptance criteria.

The review should:
- Evaluate the artifact with fresh eyes — assume nothing about the builder's intent
- Look for real problems, not style preferences
- Classify findings by severity
- Resolve by fixing what's important, acknowledging what's deferred, and skipping noise

Adversarial reviews are input, not gospel. Evaluate the findings — ask what's reasonable, fix what matters, and move on. The adversarial review reference file has the full protocol.

The principle here is: review catches what building misses, and reviewing the spec early saves more time than reviewing the code late.

## Documentation Design Principles

All documentation produced during builds — reference files, operation files, CLAUDE.md files, workpapers — must follow these principles:

**Principles over specifications.** Document intent, guidelines, conventions, and architectural concepts. Do not document specific commands, queries, config values, or implementation details that the agent can discover by reading source or inspecting the system.

**No stale statistics.** Do not hardcode values that change: VM specs, counts, polling intervals, port numbers, concurrency limits, timezone values, current rosters. If a value is configurable or will drift, either omit it or point to where the agent can look it up.

**Point to locations, not contents.** When the agent needs current state, point to the database table, config file, or source file where that state lives. Do not enumerate the current contents — they will go stale.

**Audience awareness.** Consider where the document will be read. Files inside a skill are read by agents inside containers — host-level paths and commands may not be accessible. Write from the reader's perspective.

**Start simple.** Document what IS, not what might be. Layer complexity over time as the system grows.

**Trust the agent.** Define the system's architecture, conventions, and boundaries. The agent will reason about how to work within them. No step-by-step recipes. The right level of detail: enough to reason from, not enough to copy-paste from.

## Safety as a Design Concern

Safety boundaries are not global rules — they're a design property of the thing being built. When building a skill or agent, one of the default considerations is: "what are this build's safety boundaries?"

Examples of safety questions to consider during design:
- What should this agent/skill NOT be able to do?
- What actions are irreversible and need confirmation?
- What data could be corrupted or lost?
- What crosses an isolation boundary?

The answers are specific to each build and belong in the deliverable (CLAUDE.md boundaries section, skill operation guardrails), not in a global checklist.
