# Update to build-agent.md — Part 3: Rhythms and Heartbeats

Replace the current Part 3 with:

---

### 3. Set Up the Heartbeat

Every agent gets a standard heartbeat. Robot creates it as part of the build — the new agent should not have to configure its own heartbeat.

**Create the heartbeat scheduled task** via `schedule_task` MCP tool:
- Schedule type: `cron`
- Schedule value: `*/30 * * * *`
- Context mode: `isolated`
- Prompt: `"Run your heartbeat: read /workspace/group/HEARTBEAT.md and follow the instructions."`
- Target: agent's primary channel JID

**Create the agent's HEARTBEAT.md** at `groups/{folder}/HEARTBEAT.md`. Start from the global template and customize with any domain-specific external data sources the agent should check.

**Domain-specific rhythms:** Beyond the standard heartbeat, does this agent need any precise schedules? (e.g., a daily summary at 9am, a weekly report on Fridays). If so, create additional scheduled tasks via `schedule_task`. Document these in the agent's CLAUDE.md or a relevant reference file.

**Deliverable:** Standard heartbeat running. HEARTBEAT.md created. Any domain-specific schedules created and documented.
