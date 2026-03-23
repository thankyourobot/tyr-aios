# Database Patterns

When and how to use databases in skills. Databases are a major capability unlock — they turn skills into mini-applications with structured, queryable state.

## When to Use a Database

Use text files and spreadsheets for simplicity. Use a database when you need structured, queryable data — when you're filtering, joining, aggregating, or tracking state across multiple entities.

**Don't reach for a database** when a markdown file, CSV, or JSON file would suffice. The simplest persistence that works is the right choice.

## Database Types by Purpose

**System of record** — The database IS the source of truth. No external system to sync to. Examples: CRM contacts and interactions, internal task tracking, project metadata.

**Staging layer** — The database is a working area between external systems. Data flows in from sources (CSV, API), gets processed, then publishes to a system of record elsewhere. Examples: bookkeeping staging (source → ingest → SQLite → process → publish → QBO/Xero).

**Cache** — Temporary structured storage for performance or convenience. Rebuild from source if lost.

System of record is the most common pattern. Design for it by default unless the skill explicitly bridges external systems.

## Conventions

### One Database Per Skill

Each skill that needs a database gets its own, named `{skill-name}.db`. Related skills with overlapping domains but different schemas stay separated — this avoids migration conflicts and schema sprawl. Create scripts or operations for porting data between skills if needed.

### SQLite by Default

SQLite is the standard for local databases. It's embedded, zero-config, and available in every container.

### Minimal Schema

Keep schemas as simple as possible. Use the fewest tables and fields that are reasonable. Be generous with JSON fields (e.g., a `data` or `meta` column on tables) to store flexible attributes without schema changes. This prevents sprawl and limits future migrations.

A good schema reads like a data model summary — if you need more than a handful of tables, reconsider whether the skill's scope is right.

### WAL Mode

Enable WAL mode for any database that might be accessed by multiple processes or containers. Set it on database creation:

```sql
PRAGMA journal_mode=WAL;
```

### Schema Reference File

Every skill with a database should include a schema reference in its `reference/` directory. This serves two purposes:

1. **Query reference** — The agent reads it to understand the data model before writing queries
2. **Initialization** — The schema can be used to create the database on first run

Format is flexible — `schema.sql` (executable) or `database-schema.md` (documented with context and example queries). Choose based on whether the schema needs explanation beyond the DDL.

### Database Location

**Local by default:** `/workspace/group/database/{skill-name}.db`. Only the owning agent can access it.

**Shared only when multiple agents need access.** Shared databases go in `/workspace/extra/shared/` and require WAL mode. The mount allowlist on the host controls which shared paths are available.

### Backups

Databases on the host are covered by Litestream (continuous SQLite replication) and Restic (daily file backups). No special backup configuration needed per-skill — the infrastructure handles it.

## Setup and Initialization

Skills with databases need an initialization path — how does the database get created on first use?

Options:
- **Auto-initialize on activation** — Skill checks if the database exists; if not, creates it from the schema reference. Simple and reliable.
- **Onboarding operation** — For skills with complex setup (multi-tenant config, external integrations, initial data import), include an onboarding operation that handles database creation as part of a broader setup flow.

The initialization path should be documented in the skill's activation sequence or onboarding operation. The agent shouldn't need to figure out how to bootstrap the database from scratch.
