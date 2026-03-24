---
name: aios-builder
description: "Build agents and skills for AI OS instances. Use when creating a new agent, building a new skill, modifying an existing agent or skill, or when asked to build, scaffold, or design any AI OS component."
---

# AI OS Builder

Build agents and skills for any AI OS instance — internal or client. This skill encodes how we build things — the philosophy, patterns, and conventions that make builds consistent and durable across organizations.

## Activation

When this skill is invoked:

1. Determine what's being built — agent, skill, or modification to an existing one
2. Assess complexity (see `reference/build-philosophy.md` for the adaptive autonomy model)
3. Load the appropriate operation
4. Follow the build philosophy: understand → research → spec → review → build → review → resolve

## Operations

Load on demand — only when the agent needs to perform that operation.

| Operation | File | Use When |
|-----------|------|----------|
| Build Agent | `operations/build-agent.md` | Creating a new agent, modifying an existing agent's identity/scope/rhythms, or onboarding an agent |
| Build Skill | `operations/build-skill.md` | Creating a new skill, modifying an existing skill's operations/references/scripts, or designing a skill structure |

## Reference

Load on demand — when the agent needs specific guidance during work.

| Reference | File | Precondition |
|-----------|------|-------------|
| Build Philosophy | `reference/build-philosophy.md` | Before starting any build — core loop, adaptive autonomy, workpaper standards, documentation principles |
| AI OS Primitives | `reference/aios-primitives.md` | Before building anything that touches the OS — groups, mounts, scheduling, communication, databases |
| Agent Patterns | `reference/agent-patterns.md` | Before building or modifying an agent — what makes a good agent, CLAUDE.md conventions |
| Skill Patterns | `reference/skill-patterns.md` | Before building or modifying a skill — structure, registries, deployment, multi-tenant |
| Database Patterns | `reference/database-patterns.md` | Before designing a database — schema conventions, initialization, location |
| Adversarial Review | `reference/adversarial-review.md` | Before running an adversarial review — reviewer protocol, invocation, resolution |
| Multi-Tenant Example | `reference/multi-tenant-example.md` | Before building a multi-tenant skill — annotated case study of the three-tier pattern |
| Onboarding Patterns | `reference/onboarding-patterns.md` | Before designing an agent's onboarding path or first-launch behavior |
| Gap Analysis | `reference/gap-analysis.md` | When building a director agent or designing its onboarding — how agents map their domain and stay proactive |

## Templates

| Template | File | Use When |
|----------|------|----------|
| Tech Spec | `templates/tech-spec-template.md` | Creating a workpaper for a medium+ complexity build |
