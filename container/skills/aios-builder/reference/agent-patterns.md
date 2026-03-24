# Agent Patterns

What defines a good agent and the conventions for building one.

## What an Agent Is

An agent is like a great employee — narrow, purposeful, and dependable. It owns a function or initiative within the organization and optimizes toward a specific outcome.

Agents map to **departments/functions** (strategy, growth, finance) or **key initiatives** (internal security, client delivery, infrastructure). Each agent has a clear reason to exist and a measurable way to evaluate whether it's doing its job.

## Five Qualities of a Good Agent

**1. Specific goals.** The agent has a prime directive — an embedded intent it's always optimizing toward. This intent filters every decision about what skills to use, what actions to take, and what to ignore. An agent without clear goals becomes a chatbot.

**2. Consistent personality and heartbeat.** The agent has a rhythm — it checks in proactively, reaches out at predictable times, and maintains a consistent character. Heartbeats (scheduled tasks) are how agents stay present without being asked.

**3. Hyper-relevant skills.** When goals are narrow, it's obvious which skills belong and which don't. If a skill doesn't serve the agent's core goals, it shouldn't be added. Aim for 7-10 skills per agent maximum — beyond that, context gets clouded, the wrong tools get used, and personality gets muddled.

**4. Reviewability.** A good agent can be evaluated clearly — pass or fail. Narrow goals make this possible. Vague, general agents are hard to audit. Narrow agents are easy to cut or keep.

**5. Autonomous loops.** Narrow agents can run simple, repeatable loops without constant supervision. The more focused the agent, the more predictable and autonomous it becomes.

## CLAUDE.md Principles

The CLAUDE.md is the agent's identity — a high-level employee directive. It should be concise, focused on the prime directive, and point to deeper context rather than trying to contain it.

**Less is more.** LLMs follow ~150-200 instructions reliably. Every instruction competes for attention. A 60-line CLAUDE.md that nails the prime directive beats a 500-line one that tries to cover everything.

**Progressive disclosure.** Don't cram everything into CLAUDE.md. Domain knowledge lives in skill reference files, procedures live in skill operations, and active work lives in `projects/`. Let the agent load context when it needs it, not all upfront.

**Prime directive first.** The agent's core purpose and what it's optimizing toward should be immediately clear. Everything else is supporting context.

**What belongs in CLAUDE.md:**
- Identity (who am I, what's my name)
- Prime directive (what outcome am I optimizing for)
- Domain scope (what I handle)
- Channels (where I operate)
- Boundaries (what I don't handle, and where to route it)
- Pointers to deeper context (skills, projects/)

**What does NOT belong in CLAUDE.md:**
- Detailed procedures (those are skills)
- Domain knowledge dumps (those go in skill reference files)
- Code style rules (use linting tools)

**Can be minimal.** A CLAUDE.md can even be near-blank if the agent's context comes from skills. The directive just needs to be clear.

## Global vs. Local CLAUDE.md

**Global** (`groups/global/CLAUDE.md`) — Shared conventions that apply to ALL agents: organizational context, communication norms (threading, silent mode, response judgment), workspace structure, shared resource locations. This is the company handbook.

**Local** (`groups/{folder}/CLAUDE.md`) — Agent-specific identity: prime directive, domain, channels, boundaries. This is the job description.

The boundary is simple: if it applies to every agent, it's global. If it's specific to one agent's role, it's local.

## Agent as Organizational Unit

Each agent maps to exactly one group in NanoClaw. The group provides:
- Isolated workspace (files, databases, memory)
- Channel binding (Slack channels routed to this agent)
- Display identity (name, emoji, portrait in Slack)
- Per-agent Slack app with dedicated bot user ID (for directors)
- Container isolation (each execution is sandboxed)

Multiple channels can route to the same agent. The agent's workspace is shared across all its channels.

## Multi-Agent Channels

A channel can have multiple agents registered with different roles:

**Director** (`channel_role = 'director'`) — The default responder. Processes human messages with no @mentions, or messages that @mention them specifically. Skips messages that exclusively target other agents. A channel typically has one director.

**Member** (`channel_role = 'member'`) — Requires an @mention to enter a thread. Once mentioned, the agent joins the thread and receives all future human messages in it.

This maps to how humans work in Slack: there's usually one person "on point" for a channel (the director), and others get pulled in when needed.

**Thread membership:** The `thread_members` table tracks which agents have been pulled into which threads. Membership is acquired by @mention, and persists for the life of the thread. Agents don't need to be re-mentioned after joining.

**Anti-loop:** Bot messages only trigger processing for agents explicitly @mentioned in that specific message. Being a thread member is not sufficient for bot messages — this prevents infinite agent-to-agent chains. The `thread_bot_triggers` table provides rate limiting as a safety net.

Current channel registrations and roles: `SELECT jid, folder, channel_role, bot_user_id FROM registered_groups ORDER BY jid`.

## Director vs. Technician Agents

**Directors** get their own Slack app with a dedicated bot user ID. This enables native `<@U_BOT_ID>` mentions with Slack autocomplete and trivial sender identification.

**Technicians** are specialist sub-agents that share their director's Slack app. They post with `username`/`icon_emoji` overrides and are mentioned via text-based `@TechName` parsing. Technician names should be longer and more distinctive to avoid false positives.
