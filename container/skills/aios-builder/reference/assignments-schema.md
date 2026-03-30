# Assignments Database Schema

Schema reference for `/workspace/extra/shared/assignments.db` — the cross-agent work coordination database.

## DDL

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  created TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'open',
  blocked_by TEXT,
  meta TEXT DEFAULT '{}',
  created TEXT DEFAULT (datetime('now')),
  updated TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assignments_agent_status ON assignments(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);
```

## Status Lifecycle

| Status | Meaning |
|--------|---------|
| `open` | Ready to be worked — or needs readiness evaluation |
| `active` | Plan approved, work in progress |
| `blocked` | Not ready — check `blocked_by` or `meta` for reason |
| `done` | Complete |

**Expected flow:** `open` → (plan approved) → `active` → `done`

Agents evaluate readiness during heartbeats. An assignment should not move to `active` without a plan being approved first.

## Meta Fields

The `meta` column stores a JSON object. Required and optional fields:

### Required

| Field | Purpose | Example |
|-------|---------|---------|
| `description` | WHY this needs doing — background and motivation | `"We need domain research to inform the GTM strategy for Q2"` |
| `acceptance_criteria` | How to verify the work is done correctly | `"Research doc covers 5+ competitors with pricing, positioning, and differentiation"` |
| `source` | Who created this assignment | `"jeremiah"` or `"strategy"` |

### Optional

| Field | Purpose | Example |
|-------|---------|---------|
| `priority` | Relative urgency | `"highest"`, `"high"`, `"medium"`, `"low"` |
| `constraints` | What NOT to do, scope limits | `"Don't contact competitors directly. Desktop research only."` |
| `references` | File paths, specs, links | `["projects/gtm-research.md", "reference/market-analysis.md"]` |

## Blocking

`blocked_by` is an informal freetext field. Use it to describe what's blocking:
- Assignment IDs: `"01JQXYZ123"`
- Descriptions: `"Waiting on API key from Jeremiah"`
- Multiple blockers: `"01JQXYZ123, need Slack app created for growth agent"`

There is no automated cascade. Agents check blocker status during heartbeats and move assignments from `blocked` to `open` when blockers are resolved.

## Agents Table

The `agents` table registers which agents can receive assignments:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Agent identifier (matches folder name) |
| `name` | TEXT | Display name |
| `folder` | TEXT UNIQUE | Group folder name |

## Standard Queries

**List open assignments for an agent:**
```sql
SELECT id, title, status, blocked_by,
  json_extract(meta, '$.description') as description,
  json_extract(meta, '$.acceptance_criteria') as criteria,
  json_extract(meta, '$.priority') as priority
FROM assignments
WHERE agent_id = 'strategy' AND status IN ('open', 'active', 'blocked')
ORDER BY created;
```

**Create an assignment:**
```sql
INSERT INTO assignments (id, title, agent_id, status, blocked_by, meta)
VALUES (
  '01JQXYZ123',
  'Create domain research skill',
  'strategy',
  'open',
  NULL,
  '{"description": "...", "acceptance_criteria": "...", "source": "jeremiah"}'
);
```

**Update status:**
```sql
UPDATE assignments SET status = 'active', updated = datetime('now') WHERE id = '01JQXYZ123';
```

**Complete an assignment:**
```sql
UPDATE assignments SET status = 'done', updated = datetime('now') WHERE id = '01JQXYZ123';
```

**Check if a blocker is resolved:**
```sql
SELECT id, status FROM assignments WHERE id = '01JQXYZ123';
```
