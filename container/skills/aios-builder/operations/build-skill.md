# Build Skill

Build a new skill or modify an existing one.

## Intent

Produce a self-contained, discoverable skill: a clear SKILL.md entry point, intent-driven operations, on-demand reference files, and atomic scripts where needed. The skill should work on first invocation with no external dependencies.

## Building a Skill

### 1. Define the Domain and Description

What coherent domain does this skill cover? What problem does it solve? The description determines when Claude Code suggests the skill — write it like a search query answer with concrete trigger phrases.

Decide: is this a single-file skill (instructions/framework only) or a registry-pattern skill (operations + references)?

**Deliverable:** Skill name and description. Structure decision (minimal vs. standard).

### 2. Design the Registry

For registry-pattern skills: what operations does the agent need? What reference knowledge supports those operations?

**Operations:** Map intents to files. Each operation should be a coherent unit of work the agent might be asked to do. Use "Use When" triggers so the agent knows which operation matches the current request.

**References:** Map knowledge to preconditions. Reference files are loaded on demand — only when the agent needs that knowledge for what it's currently doing.

**Deliverable:** Operations registry table and reference registry table for SKILL.md.

### 3. Build the Files

Follow the build philosophy — assess complexity per file and scale ceremony accordingly. General creation order:

1. Directory structure
2. SKILL.md (entry point, registries, activation)
3. Operation files (intent, conventions, modes)
4. Reference files (domain knowledge, patterns, guidelines)
5. Scripts (if needed — atomic, JSON stdout, fail loudly)
6. Templates (if needed — workpapers, output scaffolding)

Each file should be self-contained and follow the documentation design principles.

### 4. Test

- Verify SKILL.md has valid frontmatter (name + description)
- Invoke the skill manually — does activation orient the agent correctly?
- Try semantic triggers — does the description match how a user would ask for this?
- If scripts exist: run each with `--help`, verify JSON output contract
- Review: does the skill make sense as a coherent whole?

## Scripts vs. Markdown

**Use scripts** for: external APIs, database operations, file format processing, credential-dependent operations, anything that needs structured JSON output.

**Use pure markdown** for: decision frameworks, conventions, step-by-step guidance, domain knowledge, architectural patterns.

The default is markdown. Only add scripts when the agent can't accomplish the task with its built-in tools (Bash, Read, Write, etc.).

## Database Considerations

Does this skill need structured, queryable state? If so, design the database early — it shapes operations, scripts, and the activation flow.

Key decisions:
- **Purpose:** System of record, staging layer, or cache?
- **Schema:** What's the minimal set of tables? Where can JSON fields prevent sprawl?
- **Initialization:** Auto-create on activation, or part of an onboarding operation?
- **Schema reference:** Include `reference/database-schema.md` (or `schema.sql`) for query reference and initialization

See `reference/database-patterns.md` for full conventions.

## Setup and Configuration

If the skill requires setup beyond "invoke and go" — database creation, credential configuration, external integrations, initial data import — design the setup path as part of the skill.

- Simple setup: auto-initialize during activation (check prerequisites, bootstrap what's missing)
- Complex setup: include an onboarding operation that walks through initialization
- Multi-tenant setup: onboarding per firm and per client, with config resolution documented

The skill should be self-bootstrapping. An agent invoking it for the first time should be guided through setup, not left to figure it out.

## Multi-Tenant Considerations

If the skill will serve multiple clients or contexts, design the three-tier architecture upfront: core (shared logic) → firm/org (per-organization conventions) → local (per-client config and adapters).

See `reference/skill-patterns.md` for the full multi-tenant pattern.

## Execution

This operation follows the build philosophy — assess complexity, create a workpaper if medium+, and scale ceremony accordingly.

**Collaborative mode:** Elicit the domain, operations, and knowledge structure from the human. Draft SKILL.md and registries together. The builder helps the user decompose their domain into operations and reference files.

**Autonomous mode:** If the skill's purpose is clear from context, make judgment calls and document decisions in the workpaper. Stop only when genuinely human-blocked.

## Infrastructure

Deploying a global skill requires host-level access for writing to `container/skills/` and setting ownership (uid 1000). Non-main agents build in their workspace and create a task for the main group to deploy.

Local skills can be deployed by any agent to its own `.claude/skills/` directory.

## References

- `reference/skill-patterns.md` — What defines a good skill, structure conventions, multi-tenant pattern
- `reference/database-patterns.md` — Database design, schema conventions, initialization patterns
- `reference/aios-primitives.md` — System architecture, skill discovery, deployment paths
- `reference/build-philosophy.md` — Core build loop, adaptive autonomy, workpaper standards
- `reference/adversarial-review.md` — Review protocol for medium+ builds
