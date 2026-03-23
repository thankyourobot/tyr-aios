# Addition to agent-patterns.md

Add this section after "Five Qualities of a Good Agent":

---

## Standard Heartbeat

Every agent has a standard heartbeat: a scheduled task that fires every 30 minutes and runs a lightweight check.

**What it does:**
1. Reads `HEARTBEAT.md` from the agent's workspace for any agent-specific context
2. Checks open tasks assigned to the agent in `tasks.db`
3. Checks any external data sources relevant to those tasks
4. Pushes forward what it can
5. Stays silent if nothing is actionable

**Convention:** Silent by default. The agent says nothing unless it is taking action. If it acts, it describes briefly what it did.

**Setup:** Robot creates the heartbeat scheduled task during the agent build via the `schedule_task` MCP tool:
- Schedule: `*/30 * * * *` (cron, every 30 minutes)
- Context mode: `isolated`
- Prompt: `"Run your heartbeat: read /workspace/group/HEARTBEAT.md and follow the instructions."`
- Target: agent's primary channel

**Customization:** Each agent has a `HEARTBEAT.md` at `/workspace/group/HEARTBEAT.md`. The global template lives at `/workspace/global/HEARTBEAT.md`. Per-agent files extend the global template with domain-specific instructions or external data sources.
