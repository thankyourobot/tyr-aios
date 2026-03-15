# Skill Patterns

What makes a good skill and the conventions for building one.

## What a Skill Is

A skill is a self-contained capability package. It gives an agent the knowledge, tools, and procedures to handle a coherent domain of work. Everything the skill needs — operations, reference knowledge, scripts, templates — ships inside its directory.

A skill is NOT orchestration logic, retry handling, or workflow enforcement. The agent reasons across the skill's contents and decides how to use them. The skill provides the what and why; the agent handles the how.

## Scoping a Skill

**One skill = one coherent domain.** If operations share context, domain knowledge, and a common purpose, they belong in the same skill. If they don't, they're separate skills.

Signals that something is **one skill:**
- Operations reference the same domain knowledge
- They share scripts, adapters, or database schemas
- A user would describe them as part of the same job

Signals that something should be **separate skills:**
- Operations have no shared context
- Different domain expertise required
- Different agents would use them independently
- Would require a wholly different database schema

Keep skills focused. An agent should have 7-10 skills maximum — beyond that, context gets clouded and the agent starts using the wrong tools.

## Skill Structure

### Minimal (single-file)

```
{skill-name}/
└── SKILL.md              # Description, activation, inline guidance
```

Sufficient for simple skills that are primarily instructions or decision frameworks with no operations or reference files.

### Standard (registry pattern)

```
{skill-name}/
├── SKILL.md              # Entry point: activation, operations registry, reference registry
├── operations/           # Intent-driven operation files (loaded on demand)
│   ├── {operation-a}.md
│   └── {operation-b}.md
├── reference/            # Domain knowledge and conventions (loaded on demand)
│   ├── {topic-a}.md
│   └── {topic-b}.md
├── scripts/              # Atomic scripts with JSON stdout (if needed)
├── templates/            # Workpaper or output templates (if needed)
└── assets/               # Static assets (if needed)
```

The registry pattern is the default for skills with multiple operations. SKILL.md is the entry point — it has two registries:

**Operations registry:** Maps intents to operation files with "Use When" triggers.

**Reference registry:** Maps knowledge files to precondition triggers — "load this before doing that for the first time."

Operations and references are loaded on demand, not upfront. This keeps the agent's context clean.

## SKILL.md Conventions

### Frontmatter (required)

```yaml
---
name: skill-name
description: "Concise description of what this skill does and when to use it."
---
```

The `description` field is how Claude Code decides when to suggest the skill. Write it like a search query answer — what problem does this skill solve? Include concrete trigger phrases.

### Activation

What happens when the skill is invoked. Load config, check state, present context, ask what to work on. Keep it focused on getting the agent oriented.

### Operations Registry

| Operation | File | Use When |
|-----------|------|----------|
| Do Thing A | `operations/do-thing-a.md` | Intent-based trigger description |

### Reference Registry

| Reference | File | Precondition |
|-----------|------|-------------|
| Topic Knowledge | `reference/topic.md` | Before doing X for the first time |

## Operations Conventions

Operations are intent-driven — they describe what the agent should accomplish, the conventions to follow, and the relevant context. They do NOT enforce rigid step sequences.

An operation file should cover:
- **Intent** — What is this operation trying to accomplish?
- **Execution modes** — How does this work collaboratively vs. autonomously?
- **Conventions** — Naming, output formats, patterns specific to this operation
- **References** — Which reference files are relevant

## Scripts Conventions

Scripts are atomic — one script does one thing. Claude orchestrates across scripts; scripts rarely orchestrate themselves.

- **Output:** Structured JSON to stdout. Progress/logging to stderr.
- **Errors:** Fail loudly. No swallowed exceptions. No defensive over-engineering.
- **No retry logic** — Claude decides recovery.
- **No monolithic workflows** — Break into atomic operations.
- **Check `--help`** before invocation — the reference registry is for discovery, not invocation syntax.

## Deployment

### Global Skills (all agents)

Deployed to `container/skills/{skill-name}/` on the host. NanoClaw copies to each group's `.claude/skills/` on every container launch. Requires host-level access (main group only).

### Group-Local Skills

Deployed to a group's `.claude/skills/` directory. Only visible to that agent. Any agent can create local skills in its own workspace.

### Promotion

The default path: build and test locally → when proven, promote to global. Non-main agents build in their workspace and create a task for the main group to deploy globally.

## Multi-Tenant Skills

Some skills serve multiple clients or contexts with the same core logic but different configuration, conventions, and local adaptations. These use a **three-tier architecture:**

```
Core (versioned, updatable)          → Global skill installation
  Operations, reference, scripts, templates — shared across all tenants
      ↓
Firm/Org (per-organization)          → Separate global skill or config directory
  Organization-specific conventions, guidelines, context registry, shared adapters
      ↓
Local (per-client/project)           → Project-level config and content
  Client-specific config, content, local adapters, overrides
```

**Resolution order:** Local → Firm → Core → error. First match wins. Client config overrides firm defaults. Firm defaults override core.

**When to use multi-tenant:** When the same skill will be used across multiple clients/projects with different conventions, content, or adapters. Client delivery skills are natural fits. Internal skills used by a single organization don't need this pattern.

**Key design decisions:**
- Firm layer is optional — solo deployments skip it
- Each tier has its own context registry (maps files to precondition triggers)
- Local adapters override firm adapters override core adapters
- Config resolution must be explicit and traceable (no implicit merging)

See `reference/multi-tenant-example.md` for an annotated case study of this pattern in production.

## Setup and Configuration

If a skill requires setup — database initialization, external integrations, config files, credential setup — that process must be designed and documented within the skill itself. The agent should be able to get the skill operational without outside guidance.

**Options:**
- **Auto-initialize on activation** — Skill checks prerequisites and bootstraps what's missing. Works for simple setup (create a database, write a default config).
- **Onboarding operation** — For complex setup, include a dedicated operation that walks through the full initialization. This is the pattern for multi-tenant skills where client/firm onboarding involves multiple steps.

Configuration paths, database locations, and environment variables should be resolved during activation and documented in SKILL.md.

## Databases

Databases turn skills into mini-applications with structured, queryable state. Not every skill needs one, but when structured data is involved, they're a major capability unlock.

See `reference/database-patterns.md` for full conventions: schema design, naming, initialization, location, and backup patterns.

## Self-Containment

A skill must be fully self-contained. No external dependencies, no cross-repo includes, no references to files outside the skill directory (except config paths and database locations defined at activation). If the skill needs domain knowledge, it ships as a reference file inside the skill. If it needs a procedure, it ships as an operation.
