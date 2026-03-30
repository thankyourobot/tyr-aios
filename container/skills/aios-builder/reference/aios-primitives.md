# AI OS Primitives

Reference for TYR's AI Operating System architecture. Read this to understand how the system works before building anything.

## System Overview

TYR's AI OS is a multi-agent system running on a single VM. NanoClaw is the runtime — a lightweight TypeScript orchestrator built on the Claude Agent SDK. Each agent execution runs in an ephemeral Docker container with isolated filesystem mounts. Agents communicate with humans via Slack and with each other via a shared SQLite task database.

## Groups

A **group** is the core organizational unit. One group = one agent identity. Groups are registered in SQLite and map Slack channels to isolated workspaces.

- Multiple Slack channels can map to the same group folder
- The **main group** is the catchall — DMs and unregistered channels route here
- Each group has a display name, emoji, trigger pattern, and assistant name
- Group registration data lives in `store/messages.db` → `registered_groups` table
- Registration script: `setup/index.ts`

## Container Model

Every agent invocation spawns an ephemeral Docker container. Containers are:
- **Isolated** — each sees only its group's workspace via bind mounts
- **Ephemeral** — destroyed after the agent finishes responding
- **Concurrent** — bounded by `MAX_CONCURRENT_CONTAINERS` in `.env`
- **Authenticated** — API credentials provided via credential proxy, never exposed as env vars

The agent runs Claude Agent SDK `query()` with `permissionMode: bypassPermissions`.

Mount logic, allowed tools, and SDK settings are defined in the NanoClaw source.

## File System

### Host Layout (`/opt/nanoclaw/`)

```
/opt/nanoclaw/
├── src/                        # NanoClaw runtime source
├── store/messages.db           # Core DB: messages, groups, sessions, scheduled tasks
├── groups/                     # Per-group workspaces
│   ├── global/CLAUDE.md        # Shared context (mounted read-only to non-main groups)
│   └── {folder}/               # One directory per group
├── data/
│   ├── sessions/{folder}/      # Per-group Claude Code session state (.claude/)
│   ├── shared/                 # Shared databases accessible to all groups
│   ├── ipc/{folder}/           # Per-group IPC directories
│   └── env/env                 # Credentials synced for container access
└── container/
    ├── skills/                 # Global skills (synced to all groups on container launch)
    └── agent-runner/           # In-container agent runner source
```

### Per-Group Workspace (inside container)

```
/workspace/group/
├── CLAUDE.md          # Agent identity + instructions (always in context)
├── .claude/skills/    # Group-local skills (project-level discovery)
├── projects/          # Active workpapers, in-progress builds
├── memory/            # Persistent agent memory (Claude memory tool)
├── database/          # Agent-local SQLite databases
└── logs/              # Container execution logs
```

### Container Mounts

| Host Path | Container Path | Mode | Purpose |
|---|---|---|---|
| `groups/{folder}/` | `/workspace/group/` | rw | Agent's isolated workspace |
| `groups/global/` | `/workspace/global/` | ro | Shared organizational context |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude/` | rw | Claude Code config + skills |
| `data/ipc/{folder}/` | `/workspace/ipc/` | rw | Inter-process communication |
| Allowlisted paths | `/workspace/extra/{name}/` | per-config | Shared resources |
| `container/agent-runner/src/` → session copy | `/app/src/` | rw | Agent runner source |

Main group also gets the NanoClaw project root mounted at `/workspace/project/` (read-only).

**Write boundaries:** Non-main agents can only write to their own workspace, IPC directory, and allowlisted shared paths. They cannot write to the host, other groups' workspaces, or `container/skills/`. To deploy anything outside their workspace (e.g., a global skill), non-main agents create a task in the shared `assignments.db` for the main group agent to review and execute.

Additional mounts beyond the defaults are controlled by the mount allowlist config on the host.

## Skills

### Global Skills

Located at `container/skills/{skill-name}/`. NanoClaw's container runner copies these to each group's `.claude/skills/` on every container launch. Claude Code discovers them natively via `settingSources`.

Global skill deployment requires host-level write access — only the main group agent can do this. Non-main agents build in their workspace and coordinate deployment via the shared task database. Once files are in `container/skills/`, the skill propagates to all agents on their next invocation.

### Group-Local Skills

An agent can have skills in `/home/node/.claude/skills/` (backed by `data/sessions/{folder}/.claude/skills/`). These are only visible to that agent.

### Skill Structure

A skill requires `SKILL.md` with `name` and `description` in YAML frontmatter. Claude Code displays skills based on their description and invokes them via the Skill tool. See existing skills in `container/skills/` for reference.

## Communication

### Human ↔ Agent: Slack

Messages flow: Slack event → JID lookup (`slack:{channel_id}`) → registered group resolution (unregistered JIDs fall through to main group) → message stored → message loop picks up → container spawned for group → agent output sent back to Slack.

- **Threading:** Replies go in-thread by default. Agents can post top-level by wrapping output in `<channel>` tags.
- **Silent mode:** Agents wrap reasoning in `<internal>` tags to stay silent (tags stripped, empty output = no Slack message).
- **Trigger-free:** Agents see every message in their channels and decide when to respond.
- **Bot messages with @mentions:** Bot messages that @mention another agent trigger processing for that agent. Bot messages without @mentions are stored but not processed. This enables directed agent-to-agent communication while preventing loops.

### Agent ↔ Agent: @Mention Routing

Agents communicate via Slack @mentions. Director agents have their own Slack apps with dedicated bot user IDs, enabling native `<@U_BOT_ID>` mentions with autocomplete.

**How it works:**
1. Agent A posts a message containing `@AgentB` (or `<@U_AGENT_B_BOT_ID>`)
2. NanoClaw's dispatch layer detects the @mention and routes the message to Agent B
3. Agent B processes the message and responds in the thread
4. Agent A sees the response but does NOT re-process (no @mention = no trigger for bot messages)

**Thread membership:** Once an agent is @mentioned in a thread, they receive all future human messages in that thread. Bot messages only trigger processing for explicitly @mentioned agents (prevents loops).

**Channel roles:** Agents can be `director` (default responder) or `member` (requires @mention). Multiple agents can share a channel.

### Shared Task Database

The shared `assignments.db` remains available for asynchronous coordination when immediate attention isn't needed.

### Emoji Reactions

Agents can react to messages with emoji via IPC:
```json
{ "type": "reaction", "chatJid": "slack:CHANNEL_ID", "messageTs": "MESSAGE_TS", "emoji": "eyes" }
```
Write to `/workspace/ipc/messages/`. Prefer reactions over "Got it" text responses.

### MCP Tools

Agents have access to NanoClaw MCP tools. Two categories:

**Host IPC tools** — bridge the container isolation boundary, communicating with the NanoClaw host process for actions the container can't do directly:
- `send_message` — Post a Slack message
- `schedule_task` / `list_tasks` / `pause_task` / `resume_task` / `cancel_task` / `update_task` — Manage scheduled tasks
- `register_group` — Register a new group (main only)
- `get_recent_activity` — Recent message activity snapshot

**Assignment tools** — direct sqlite3 access to the shared assignments database (no host involvement needed):
- `list_assignments` — List assignments (filtered by agent for non-main, all for main)
- `create_assignment` — Create with required fields (title, agent_id, description, acceptance_criteria)
- `update_assignment` — Update status, title, blocked_by, or meta
- `complete_assignment` — Mark assignment as done

**Scope:** Agents can send messages and reactions to channels where they are registered. The main group can send to any channel. Assignment tools are available to all agents.

### IPC

Filesystem-based message passing at `/workspace/ipc/`. Used for piping follow-up Slack messages into running containers (e.g., the human sends another message while the agent is still processing).

## Scheduling

NanoClaw's task scheduler polls `scheduled_tasks` in `store/messages.db` for due tasks.

- **Schedule types:** `cron` (cron expression), `interval` (milliseconds), `one-shot` (ISO datetime)
- **Targeting:** Each task specifies a `group_folder` (which agent runs it) and `chat_jid` (where output is sent)
- **Context modes:** `isolated` (fresh container) or `group` (persistent session)
- **Self-scheduling:** Agents can create tasks via the `schedule_task` MCP tool

Timezone is configured at the system level on the host.

## Databases

### Conventions

- **WAL mode** for databases accessed by multiple containers
- **Agent-local databases** go in `/workspace/group/database/`
- **Shared databases** go in `data/shared/` (host) → `/workspace/extra/shared/` (container)
- **Task IDs** use ULIDs (sortable, no coordination needed)
- **Backups:** Litestream continuously replicates SQLite databases to B2

### Core Databases

| Database | Location | Purpose |
|---|---|---|
| `messages.db` | `store/` | Messages, groups, sessions, scheduled tasks (NanoClaw internal) |
| `assignments.db` | `data/shared/` | Cross-agent task coordination |

The shared `assignments.db` is the coordination mechanism between agents. Inspect its schema directly. Available inside containers at `/workspace/extra/shared/assignments.db`.

## State & Persistence

| What | Persists? | Mechanism |
|---|---|---|
| Agent workspace (`/workspace/group/`) | Yes | Host directory, survives container death |
| Claude Code session state (`.claude/`) | Yes | `data/sessions/{folder}/` on host |
| Agent memory | Yes | Workspace `memory/` dir via memory tool |
| Shared databases | Yes | Host `data/shared/`, Litestream → B2 |
| NanoClaw core state | Yes | Host `store/`, Litestream → B2 |
| Container filesystem | No | Ephemeral, destroyed after execution |

## Key Conventions

- **File ownership:** Containers run as uid 1000. All group and data directories must be owned by `1000:1000`.
- **Config-as-code:** NanoClaw is fork-and-modify. Customization happens in source code, not config files.
- **CLAUDE.md as identity:** Each group's `CLAUDE.md` defines who the agent is, what it handles, and what it doesn't. Keep it concise.
- **Global CLAUDE.md:** `groups/global/CLAUDE.md` is shared context mounted read-only to all non-main groups. Organizational conventions live here.
- **Credentials:** Never exposed to containers as env vars. Managed on the host, served via credential proxy.
