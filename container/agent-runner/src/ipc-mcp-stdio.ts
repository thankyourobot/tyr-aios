/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { ulid } from 'ulid';
import {
  initLcmDatabase,
  searchMessages,
  searchSummaries,
  getSummaryById,
  getMessagesForSummary,
  getChildSummaries,
  getMessagesBySequenceRange,
} from './lcm-store.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const replyThreadTs = process.env.NANOCLAW_REPLY_THREAD_TS || '';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. In plan mode, prefer AskUserQuestion for questions that need structured answers.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      threadTs: replyThreadTs || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'get_recent_activity',
  'Get recent message activity across your channels. Shows messages from the last N minutes and which agents are currently running. Use during heartbeats to understand what is in flight before acting.',
  {
    lookback_minutes: z
      .number()
      .optional()
      .describe(
        'Filter to last N minutes (default: 30). Filters the pre-generated snapshot client-side.',
      ),
  },
  async (args) => {
    const activityFile = path.join(IPC_DIR, 'recent_activity.json');
    if (!fs.existsSync(activityFile)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No recent activity data available.',
          },
        ],
      };
    }

    try {
      const data = JSON.parse(fs.readFileSync(activityFile, 'utf-8'));
      const lookback = args.lookback_minutes || data.lookback_minutes || 30;
      const cutoff = new Date(
        Date.now() - lookback * 60 * 1000,
      ).toISOString();

      const channels = data.channels
        .map((ch: any) => ({
          ...ch,
          messages: ch.messages.filter(
            (m: any) => m.timestamp >= cutoff,
          ),
        }))
        .filter((ch: any) => ch.messages.length > 0);

      if (
        channels.length === 0 &&
        !data.active_containers?.length
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No activity in the last ${lookback} minutes.`,
            },
          ],
        };
      }

      let output = `Activity snapshot (last ${lookback} min, generated ${data.generated_at}):\n\n`;
      for (const ch of channels) {
        output += `## ${ch.name} (${ch.role})\n`;
        for (const msg of ch.messages) {
          const botTag = msg.is_bot ? ' [bot]' : '';
          const thread = msg.thread_ts ? ' (thread)' : '';
          output += `  ${msg.timestamp} ${msg.sender_name}${botTag}${thread}: ${msg.content}\n`;
        }
        output += '\n';
      }
      if (data.active_containers?.length) {
        output += '## Currently Running Agents\n';
        for (const ac of data.active_containers) {
          output += `  - ${ac.agent_name} (${ac.group_folder})\n`;
        }
      }
      return {
        content: [{ type: 'text' as const, text: output }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading activity: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// --- Assignment Tools (direct sqlite3 access — no IPC needed) ---

const ASSIGNMENTS_DB = '/workspace/extra/shared/assignments.db';

function execSqlite(dbPath: string, sql: string): string {
  try {
    return execSync(`sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() || '';
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`sqlite3 error: ${msg}`);
  }
}

function ensureAssignmentsSchema(dbPath: string): void {
  const schema = `
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
  `;
  execSync(`sqlite3 "${dbPath}" "${schema.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    timeout: 10000,
  });
}

server.tool(
  'list_assignments',
  'List assignments from the shared assignments database. Non-main agents see only their own assignments; main agent sees all.',
  {
    status: z.enum(['open', 'active', 'blocked', 'done']).optional().describe('Filter by status. Omit to see open, active, and blocked.'),
  },
  async (args) => {
    try {
      ensureAssignmentsSchema(ASSIGNMENTS_DB);
      const statusFilter = args.status
        ? `status = '${args.status}'`
        : "status IN ('open', 'active', 'blocked')";
      const agentFilter = isMain ? '' : `agent_id = '${groupFolder}' AND`;
      const sql = `SELECT id, title, agent_id, status, blocked_by, json_extract(meta, '$.description') as description, json_extract(meta, '$.acceptance_criteria') as acceptance_criteria, json_extract(meta, '$.priority') as priority FROM assignments WHERE ${agentFilter} ${statusFilter} ORDER BY created`;
      const result = execSqlite(ASSIGNMENTS_DB, sql);
      if (!result || result === '[]') {
        return { content: [{ type: 'text' as const, text: 'No assignments found.' }] };
      }
      const rows = JSON.parse(result);
      const formatted = rows.map((r: any) => {
        let line = `[${r.id}] ${r.title} (${r.status})`;
        if (r.agent_id && isMain) line += ` — agent: ${r.agent_id}`;
        if (r.priority) line += ` [${r.priority}]`;
        if (r.blocked_by) line += `\n  Blocked by: ${r.blocked_by}`;
        if (r.description) line += `\n  Description: ${r.description}`;
        if (r.acceptance_criteria) line += `\n  Acceptance criteria: ${r.acceptance_criteria}`;
        return line;
      }).join('\n\n');
      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'create_assignment',
  'Create a new assignment in the shared assignments database. Requires title, agent_id, description, and acceptance_criteria.',
  {
    title: z.string().describe('Short title for the assignment'),
    agent_id: z.string().describe('Agent folder name to assign to (e.g., "strategy", "operations")'),
    description: z.string().describe('WHY this needs doing — background context and motivation'),
    acceptance_criteria: z.string().describe('How to verify the work is done correctly'),
    priority: z.enum(['highest', 'high', 'medium', 'low']).optional().describe('Relative urgency'),
    constraints: z.string().optional().describe('What NOT to do, scope limits'),
    references: z.string().optional().describe('File paths, specs, conversation context'),
    blocked_by: z.string().optional().describe('Freetext note of what blocks this (assignment IDs, descriptions, etc.)'),
  },
  async (args) => {
    try {
      ensureAssignmentsSchema(ASSIGNMENTS_DB);

      // Validate agent exists
      const agentCheck = execSqlite(ASSIGNMENTS_DB, `SELECT id FROM agents WHERE id = '${args.agent_id}' OR folder = '${args.agent_id}'`);
      if (!agentCheck || agentCheck === '[]') {
        return {
          content: [{ type: 'text' as const, text: `Agent "${args.agent_id}" not found in agents table. Register it first.` }],
          isError: true,
        };
      }

      const id = ulid();
      const meta: Record<string, string | undefined> = {
        description: args.description,
        acceptance_criteria: args.acceptance_criteria,
        source: groupFolder,
        priority: args.priority,
        constraints: args.constraints,
        references: args.references,
      };
      // Remove undefined values
      Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);

      const metaJson = JSON.stringify(meta).replace(/'/g, "''");
      const status = args.blocked_by ? 'blocked' : 'open';
      const blockedBy = args.blocked_by ? args.blocked_by.replace(/'/g, "''") : '';
      const titleEsc = args.title.replace(/'/g, "''");

      const sql = `INSERT INTO assignments (id, title, agent_id, status, blocked_by, meta) VALUES ('${id}', '${titleEsc}', '${args.agent_id}', '${status}', ${blockedBy ? `'${blockedBy}'` : 'NULL'}, '${metaJson}')`;
      execSqlite(ASSIGNMENTS_DB, sql);

      return { content: [{ type: 'text' as const, text: `Assignment created: ${id} — "${args.title}" (${status})` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'update_assignment',
  'Update an existing assignment. Only provided fields are changed.',
  {
    id: z.string().describe('Assignment ID to update'),
    status: z.enum(['open', 'active', 'blocked', 'done']).optional().describe('New status'),
    title: z.string().optional().describe('New title'),
    blocked_by: z.string().optional().describe('Freetext blocker note (set empty string to clear)'),
    meta: z.string().optional().describe('Full meta JSON to replace existing meta'),
  },
  async (args) => {
    try {
      ensureAssignmentsSchema(ASSIGNMENTS_DB);

      const sets: string[] = ["updated = datetime('now')"];
      if (args.status !== undefined) sets.push(`status = '${args.status}'`);
      if (args.title !== undefined) sets.push(`title = '${args.title.replace(/'/g, "''")}'`);
      if (args.blocked_by !== undefined) {
        sets.push(args.blocked_by === '' ? 'blocked_by = NULL' : `blocked_by = '${args.blocked_by.replace(/'/g, "''")}'`);
      }
      if (args.meta !== undefined) sets.push(`meta = '${args.meta.replace(/'/g, "''")}'`);

      const sql = `UPDATE assignments SET ${sets.join(', ')} WHERE id = '${args.id}'`;
      execSqlite(ASSIGNMENTS_DB, sql);

      // Verify it existed
      const check = execSqlite(ASSIGNMENTS_DB, `SELECT id, title, status FROM assignments WHERE id = '${args.id}'`);
      if (!check || check === '[]') {
        return {
          content: [{ type: 'text' as const, text: `Assignment "${args.id}" not found.` }],
          isError: true,
        };
      }

      const row = JSON.parse(check)[0];
      return { content: [{ type: 'text' as const, text: `Updated: [${row.id}] "${row.title}" — status: ${row.status}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'complete_assignment',
  'Mark an assignment as done.',
  {
    id: z.string().describe('Assignment ID to complete'),
  },
  async (args) => {
    try {
      ensureAssignmentsSchema(ASSIGNMENTS_DB);

      // Verify it exists
      const check = execSqlite(ASSIGNMENTS_DB, `SELECT id, title, status FROM assignments WHERE id = '${args.id}'`);
      if (!check || check === '[]') {
        return {
          content: [{ type: 'text' as const, text: `Assignment "${args.id}" not found.` }],
          isError: true,
        };
      }

      execSqlite(ASSIGNMENTS_DB, `UPDATE assignments SET status = 'done', updated = datetime('now') WHERE id = '${args.id}'`);

      const row = JSON.parse(check)[0];
      return { content: [{ type: 'text' as const, text: `Completed: [${row.id}] "${row.title}"` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- LCM Memory Tools ---

const LCM_DB_PATH = '/home/node/.claude/lcm.db';

function ensureLcmDb(): boolean {
  try {
    if (!fs.existsSync(LCM_DB_PATH)) return false;
    const db = initLcmDatabase(LCM_DB_PATH);
    return db !== null;
  } catch {
    return false;
  }
}

server.tool(
  'lcm_grep',
  'Search compacted conversation history using full-text search. Returns matching messages and/or summaries from previous conversation segments. Use this to find specific topics, decisions, or details from earlier in the conversation.',
  {
    query: z.string().describe('Search query (supports FTS5 syntax: AND, OR, NOT, "exact phrase")'),
    scope: z.enum(['messages', 'summaries', 'both']).default('both').describe('Search scope'),
    limit: z.number().default(10).describe('Maximum results to return'),
  },
  async (args) => {
    if (!ensureLcmDb()) {
      return { content: [{ type: 'text' as const, text: 'No LCM history available yet.' }] };
    }

    const results: string[] = [];

    if (args.scope === 'messages' || args.scope === 'both') {
      const msgs = searchMessages(args.query, args.limit);
      for (const m of msgs) {
        const snippet = m.content.slice(0, 300) + (m.content.length > 300 ? '...' : '');
        results.push(`[message] role=${m.role} seq=${m.sequence} conv=${m.conversation_id}\n${snippet}`);
      }
    }

    if (args.scope === 'summaries' || args.scope === 'both') {
      const sums = searchSummaries(args.query, args.limit);
      for (const s of sums) {
        const snippet = s.content.slice(0, 300) + (s.content.length > 300 ? '...' : '');
        results.push(`[summary] id=${s.id} depth=${s.depth} seq=${s.min_sequence}-${s.max_sequence}\n${snippet}`);
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No results for "${args.query}".` }] };
    }

    return { content: [{ type: 'text' as const, text: results.join('\n\n---\n\n') }] };
  },
);

server.tool(
  'lcm_describe',
  'Inspect a specific LCM summary node. Returns metadata including depth, token count, relationships, and a content preview.',
  {
    id: z.string().describe('Summary ID (starts with "sum_")'),
  },
  async (args) => {
    if (!ensureLcmDb()) {
      return { content: [{ type: 'text' as const, text: 'No LCM history available yet.' }] };
    }

    const summary = getSummaryById(args.id);
    if (!summary) {
      return { content: [{ type: 'text' as const, text: `Summary "${args.id}" not found.` }], isError: true };
    }

    const sourceCount = summary.source_message_ids ? JSON.parse(summary.source_message_ids).length : 0;
    const childCount = summary.child_summary_ids ? JSON.parse(summary.child_summary_ids).length : 0;
    const preview = summary.content.slice(0, 500) + (summary.content.length > 500 ? '...' : '');

    const info = [
      `ID: ${summary.id}`,
      `Depth: ${summary.depth} (${summary.depth === 0 ? 'leaf — summarizes raw messages' : 'condensed — summarizes other summaries'})`,
      `Conversation: ${summary.conversation_id}`,
      `Tokens: ~${summary.token_estimate}`,
      `Sequence range: ${summary.min_sequence}-${summary.max_sequence}`,
      `Created: ${summary.created_at}`,
      `Source messages: ${sourceCount}`,
      `Child summaries: ${childCount}`,
      summary.child_summary_ids ? `Child IDs: ${summary.child_summary_ids}` : null,
      '',
      `Content preview:\n${preview}`,
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text' as const, text: info }] };
  },
);

server.tool(
  'lcm_expand',
  'Drill into a summary to recover details. For leaf summaries (depth 0), returns the original messages. For condensed summaries (depth 1+), returns child summaries. Use this when a summary mentions something you need more detail on.',
  {
    id: z.string().describe('Summary ID to expand'),
    levels: z.number().default(1).describe('DAG levels to traverse (1 = immediate children only)'),
    include_messages: z.boolean().default(true).describe('For leaf summaries, include original raw messages'),
  },
  async (args) => {
    if (!ensureLcmDb()) {
      return { content: [{ type: 'text' as const, text: 'No LCM history available yet.' }] };
    }

    const summary = getSummaryById(args.id);
    if (!summary) {
      return { content: [{ type: 'text' as const, text: `Summary "${args.id}" not found.` }], isError: true };
    }

    const TOKEN_CAP = 50000;
    let totalChars = 0;
    const output: string[] = [];

    if (summary.depth === 0 && args.include_messages) {
      // Leaf summary — return source messages
      const msgs = getMessagesForSummary(summary.id);
      if (msgs.length > 0) {
        output.push(`## Original messages for ${summary.id} (${msgs.length} messages)`);
        for (const m of msgs) {
          if (totalChars > TOKEN_CAP * 4) {
            output.push('[... truncated — token cap reached]');
            break;
          }
          output.push(`[${m.role}] (seq ${m.sequence}):\n${m.content}`);
          totalChars += m.content.length;
        }
      } else if (summary.min_sequence !== null && summary.max_sequence !== null) {
        // Fallback: get by sequence range
        const rangeMsgs = getMessagesBySequenceRange(summary.conversation_id, summary.min_sequence, summary.max_sequence);
        output.push(`## Messages by sequence range ${summary.min_sequence}-${summary.max_sequence} (${rangeMsgs.length} messages)`);
        for (const m of rangeMsgs) {
          if (totalChars > TOKEN_CAP * 4) {
            output.push('[... truncated — token cap reached]');
            break;
          }
          output.push(`[${m.role}] (seq ${m.sequence}):\n${m.content}`);
          totalChars += m.content.length;
        }
      }
    } else if (summary.depth > 0) {
      // Condensed summary — return child summaries
      const expandLevel = (parentId: string, depth: number) => {
        if (depth > args.levels) return;
        const children = getChildSummaries(parentId);
        for (const child of children) {
          if (totalChars > TOKEN_CAP * 4) {
            output.push('[... truncated — token cap reached]');
            return;
          }
          output.push(`## ${child.id} (depth ${child.depth}, seq ${child.min_sequence}-${child.max_sequence})`);
          output.push(child.content);
          totalChars += child.content.length;

          if (depth < args.levels) {
            expandLevel(child.id, depth + 1);
          }
        }
      };

      output.push(`## Expanding ${summary.id} (depth ${summary.depth})`);
      expandLevel(summary.id, 1);
    }

    if (output.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No content to expand.' }] };
    }

    return { content: [{ type: 'text' as const, text: output.join('\n\n') }] };
  },
);

server.tool(
  'lcm_compact',
  'Force compaction of the current conversation. Persists all messages to LCM, creates summaries, and signals a session reset. Use when you want to start fresh but preserve memory of the conversation so far.',
  {},
  async () => {
    // Signal the agent-runner main loop to trigger compaction
    const signalPath = '/workspace/ipc/input/_lcm_compact';
    try {
      fs.writeFileSync(signalPath, JSON.stringify({ timestamp: new Date().toISOString() }));
      return { content: [{ type: 'text' as const, text: 'Compaction requested. Session will reset after current query completes, with LCM summaries injected into the new session.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to signal compaction: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
