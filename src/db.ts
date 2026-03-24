import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  SendMessageOpts,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      thread_ts TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_sessions (
      group_folder TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, thread_ts)
    );
    CREATE TABLE IF NOT EXISTS response_uuids (
      group_folder TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      slack_ts TEXT NOT NULL,
      sdk_uuid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, thread_ts, slack_ts)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      display_name TEXT,
      display_emoji TEXT,
      assistant_name TEXT
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add thread_ts column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_ts TEXT`);
  } catch {
    /* column already exists */
  }

  // Add files column if it doesn't exist (migration for file attachment support)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN files TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add display_name, display_emoji, assistant_name columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN display_name TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN display_emoji TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN assistant_name TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add verbose_default and thinking_default columns (migration for toggle system)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN verbose_default INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN thinking_default INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  // Add display_icon_url column for portrait photo support (migration)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN display_icon_url TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel_role and bot_user_id columns for multi-agent @mention routing
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN channel_role TEXT DEFAULT 'director'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN bot_user_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN bot_token TEXT`);
  } catch {
    /* column already exists */
  }

  // Migrate registered_groups to composite PK (jid, folder) if still using single PK.
  // Check by trying to insert a duplicate jid with different folder — if it fails, migrate.
  migrateRegisteredGroupsPK(database);

  // Create thread_members table for multi-agent thread participation tracking
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_members (
      channel_jid TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_jid, thread_ts, group_folder)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_members_thread
      ON thread_members(channel_jid, thread_ts);
  `);

  // Create thread_bot_triggers table for bot-triggered processing rate limiting
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_bot_triggers (
      channel_jid TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      triggered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bot_triggers
      ON thread_bot_triggers(channel_jid, thread_ts, group_folder);
  `);

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

/**
 * Migrate registered_groups from single PK (jid) to composite PK (jid, folder).
 * This enables multiple groups per channel for multi-agent @mention routing.
 */
function migrateRegisteredGroupsPK(database: Database.Database): void {
  // Check if migration is needed by inspecting the table schema
  const tableInfo = database
    .prepare(`PRAGMA table_info(registered_groups)`)
    .all() as Array<{
    name: string;
    pk: number;
  }>;
  const pkColumns = tableInfo.filter((c) => c.pk > 0);
  // If there's only one PK column (jid), we need to migrate
  if (pkColumns.length === 1 && pkColumns[0].name === 'jid') {
    logger.info('Migrating registered_groups to composite PK (jid, folder)...');
    database.exec(`
      CREATE TABLE registered_groups_new (
        jid TEXT NOT NULL,
        folder TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        display_name TEXT,
        display_emoji TEXT,
        display_icon_url TEXT,
        assistant_name TEXT,
        is_main INTEGER DEFAULT 0,
        verbose_default INTEGER DEFAULT 0,
        thinking_default INTEGER DEFAULT 0,
        channel_role TEXT DEFAULT 'director',
        bot_user_id TEXT,
        bot_token TEXT,
        PRIMARY KEY (jid, folder)
      );
      INSERT INTO registered_groups_new
        SELECT jid, folder, name, trigger_pattern, added_at, container_config,
               requires_trigger, display_name, display_emoji, display_icon_url,
               assistant_name, is_main, verbose_default, thinking_default,
               COALESCE(channel_role, 'director'), bot_user_id
        FROM registered_groups;
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_new RENAME TO registered_groups;
    `);
    logger.info('registered_groups migration complete');
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  // Ensure chat exists for synthetic thread JIDs (FK constraint)
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
  ).run(msg.chat_jid, msg.chat_jid, msg.timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_ts, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.threadTs ?? null,
    msg.files ? JSON.stringify(msg.files) : null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  threadTs?: string;
  files?: unknown[];
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_ts, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.threadTs ?? null,
    msg.files ? JSON.stringify(msg.files) : null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_ts AS threadTs, files
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as (NewMessage & {
    files?: string;
  })[];

  let newTimestamp = lastTimestamp;
  const messages = rows.map((row) => {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    return {
      ...row,
      files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
    };
  });

  return { messages, newTimestamp };
}

export function getMessageById(
  chatJid: string,
  messageId: string,
): NewMessage | undefined {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_ts AS threadTs, files FROM messages WHERE chat_jid = ? AND id = ?',
    )
    .get(chatJid, messageId) as (NewMessage & { files?: string }) | undefined;
  if (!row) return undefined;
  return {
    ...row,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_ts AS threadTs, files
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as (NewMessage & {
    files?: string;
  })[];
  return rows.map((row) => ({
    ...row,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  }));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

/** Raw row type from registered_groups table */
interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  display_name: string | null;
  display_emoji: string | null;
  display_icon_url: string | null;
  assistant_name: string | null;
  verbose_default: number | null;
  thinking_default: number | null;
  channel_role: string | null;
  bot_user_id: string | null;
  bot_token: string | null;
}

function rowToRegisteredGroup(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    displayName: row.display_name ?? undefined,
    displayEmoji: row.display_emoji ?? undefined,
    displayIconUrl: row.display_icon_url ?? undefined,
    assistantName: row.assistant_name ?? undefined,
    verboseDefault: row.verbose_default === 1 ? true : undefined,
    thinkingDefault: row.thinking_default === 1 ? true : undefined,
    channelRole: (row.channel_role as 'director' | 'member') ?? 'director',
    botUserId: row.bot_user_id ?? undefined,
    botToken: row.bot_token ?? undefined,
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  // With composite PK, a jid may have multiple rows — return the director (or first)
  const rows = db
    .prepare(
      'SELECT * FROM registered_groups WHERE jid = ? ORDER BY channel_role',
    )
    .all(jid) as RegisteredGroupRow[];
  if (rows.length === 0) return undefined;
  const row = rows.find((r) => r.channel_role === 'director') || rows[0];
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return rowToRegisteredGroup(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, folder, name, trigger_pattern, added_at, container_config, requires_trigger, is_main, display_name, display_emoji, display_icon_url, assistant_name, verbose_default, thinking_default, channel_role, bot_user_id, bot_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.folder,
    group.name,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.displayName ?? null,
    group.displayEmoji ?? null,
    group.displayIconUrl ?? null,
    group.assistantName ?? null,
    group.verboseDefault ? 1 : 0,
    group.thinkingDefault ? 1 : 0,
    group.channelRole ?? 'director',
    group.botUserId ?? null,
    group.botToken ?? null,
  );
}

/**
 * Get all registered groups. Backward-compatible: returns one group per JID (director preferred).
 */
export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups ORDER BY channel_role')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    // First row per JID wins (directors sort first due to ORDER BY)
    if (!result[row.jid]) {
      result[row.jid] = rowToRegisteredGroup(row);
    }
  }
  return result;
}

/**
 * Get all registered groups with multi-group support.
 * Returns all groups per JID, not just the director.
 */
export function getAllRegisteredGroupsMulti(): Map<
  string,
  (RegisteredGroup & { jid: string })[]
> {
  const rows = db
    .prepare('SELECT * FROM registered_groups ORDER BY channel_role')
    .all() as RegisteredGroupRow[];
  const result = new Map<string, (RegisteredGroup & { jid: string })[]>();
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    const group = rowToRegisteredGroup(row);
    const existing = result.get(row.jid);
    if (existing) {
      existing.push(group);
    } else {
      result.set(row.jid, [group]);
    }
  }
  return result;
}

/**
 * Get a specific group by its folder name.
 */
export function getGroupByFolder(
  folder: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE folder = ? LIMIT 1')
    .get(folder) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return rowToRegisteredGroup(row);
}

export function getThreadSession(
  groupFolder: string,
  threadTs: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM thread_sessions WHERE group_folder = ? AND thread_ts = ?',
    )
    .get(groupFolder, threadTs) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setThreadSession(
  groupFolder: string,
  threadTs: string,
  sessionId: string,
  parentSessionId?: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO thread_sessions (group_folder, thread_ts, session_id, parent_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    groupFolder,
    threadTs,
    sessionId,
    parentSessionId ?? null,
    new Date().toISOString(),
  );
}

export function getAllThreadSessions(
  groupFolder: string,
): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT thread_ts, session_id FROM thread_sessions WHERE group_folder = ?',
    )
    .all(groupFolder) as Array<{ thread_ts: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.thread_ts] = row.session_id;
  }
  return result;
}

export function storeResponseUuid(
  groupFolder: string,
  threadTs: string,
  slackTs: string,
  sdkUuid: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO response_uuids (group_folder, thread_ts, slack_ts, sdk_uuid, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(groupFolder, threadTs, slackTs, sdkUuid, new Date().toISOString());
}

export function getResponseUuid(
  groupFolder: string,
  threadTs: string,
  slackTs: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT sdk_uuid FROM response_uuids WHERE group_folder = ? AND thread_ts = ? AND slack_ts = ?',
    )
    .get(groupFolder, threadTs, slackTs) as { sdk_uuid: string } | undefined;
  return row?.sdk_uuid;
}

export function getThreadResponseUuids(
  groupFolder: string,
  threadTs: string,
): Array<{ slackTs: string; sdkUuid: string }> {
  const rows = db
    .prepare(
      'SELECT slack_ts, sdk_uuid FROM response_uuids WHERE group_folder = ? AND thread_ts = ? ORDER BY created_at',
    )
    .all(groupFolder, threadTs) as Array<{
    slack_ts: string;
    sdk_uuid: string;
  }>;
  return rows.map((r) => ({ slackTs: r.slack_ts, sdkUuid: r.sdk_uuid }));
}

export function getThreadMessages(
  chatJid: string,
  threadTs: string,
): Array<{
  id: string;
  content: string;
  sender_name: string;
  is_bot_message: number;
  timestamp: string;
}> {
  // Match both channel JID and synthetic thread JID for backward compatibility
  const syntheticJid = `${chatJid}:t:${threadTs}`;
  return db
    .prepare(
      `SELECT id, content, sender_name, is_bot_message, timestamp
      FROM messages
      WHERE (chat_jid = ? OR chat_jid = ?) AND thread_ts = ?
      ORDER BY timestamp`,
    )
    .all(chatJid, syntheticJid, threadTs) as Array<{
    id: string;
    content: string;
    sender_name: string;
    is_bot_message: number;
    timestamp: string;
  }>;
}

// --- Thread membership for multi-agent @mention routing ---

export function getThreadMembers(
  channelJid: string,
  threadTs: string,
): string[] {
  const rows = db
    .prepare(
      'SELECT group_folder FROM thread_members WHERE channel_jid = ? AND thread_ts = ?',
    )
    .all(channelJid, threadTs) as Array<{ group_folder: string }>;
  return rows.map((r) => r.group_folder);
}

export function addThreadMember(
  channelJid: string,
  threadTs: string,
  groupFolder: string,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO thread_members (channel_jid, thread_ts, group_folder, joined_at) VALUES (?, ?, ?, ?)',
  ).run(channelJid, threadTs, groupFolder, new Date().toISOString());
}

export function isThreadMember(
  channelJid: string,
  threadTs: string,
  groupFolder: string,
): boolean {
  const row = db
    .prepare(
      'SELECT 1 FROM thread_members WHERE channel_jid = ? AND thread_ts = ? AND group_folder = ?',
    )
    .get(channelJid, threadTs, groupFolder);
  return !!row;
}

/** Record a bot-triggered processing event for rate limiting. */
export function recordBotTrigger(
  channelJid: string,
  threadTs: string,
  groupFolder: string,
): void {
  db.prepare(
    'INSERT INTO thread_bot_triggers (channel_jid, thread_ts, group_folder, triggered_at) VALUES (?, ?, ?, ?)',
  ).run(channelJid, threadTs, groupFolder, new Date().toISOString());
}

/** Count bot-triggered processing events in a time window for rate limiting. */
export function countBotTriggers(
  channelJid: string,
  threadTs: string,
  groupFolder: string,
  sinceMinutes: number,
): number {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM thread_bot_triggers WHERE channel_jid = ? AND thread_ts = ? AND group_folder = ? AND triggered_at > ?',
    )
    .get(channelJid, threadTs, groupFolder, since) as { cnt: number };
  return row.cnt;
}

/**
 * Get messages since a timestamp, INCLUDING bot messages (for multi-agent context).
 * Used when an agent needs to see other agents' messages in the conversation.
 */
export function getMessagesSinceIncludingBots(
  chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             is_from_me, is_bot_message, thread_ts AS threadTs, files
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, limit) as (NewMessage & { files?: string })[];
  return rows.map((row) => ({
    ...row,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  }));
}

/** Cleanup old thread membership and bot trigger data. */
export function cleanupOldThreadData(maxAgeDays: number = 30): void {
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const membersDeleted = db
    .prepare('DELETE FROM thread_members WHERE joined_at < ?')
    .run(cutoff);
  const triggersDeleted = db
    .prepare('DELETE FROM thread_bot_triggers WHERE triggered_at < ?')
    .run(cutoff);
  if (membersDeleted.changes > 0 || triggersDeleted.changes > 0) {
    logger.info(
      {
        membersDeleted: membersDeleted.changes,
        triggersDeleted: triggersDeleted.changes,
      },
      'Cleaned up old thread data',
    );
  }
}

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
