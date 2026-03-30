import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Direct imports for migrateJsonState (re-exports don't create local bindings)
import { setRouterState, setSession } from './stores/session-store.js';
import { setRegisteredGroup } from './stores/group-store.js';

let db: Database.Database;

/** Access the shared database instance. Used by store modules. */
export function getDb(): Database.Database {
  return db;
}

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
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_group ON scheduled_tasks(group_folder);

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
    CREATE INDEX IF NOT EXISTS idx_registered_groups_folder ON registered_groups(folder);
  `);

  // Helper: run an idempotent migration, surfacing unexpected errors
  const migrate = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !msg.includes('duplicate column') &&
        !msg.includes('already exists')
      ) {
        logger.warn({ error: msg }, `Migration error: ${label}`);
        throw err;
      }
    }
  };

  migrate('scheduled_tasks.context_mode', () => {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  });

  migrate('messages.is_bot_message', () => {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  });

  migrate('messages.thread_ts', () => {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_ts TEXT`);
  });

  migrate('messages.files', () => {
    database.exec(`ALTER TABLE messages ADD COLUMN files TEXT`);
  });

  migrate('registered_groups.is_main', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  });

  migrate('registered_groups.display_name', () => {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN display_name TEXT`);
  });
  migrate('registered_groups.display_emoji', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN display_emoji TEXT`,
    );
  });
  migrate('registered_groups.assistant_name', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN assistant_name TEXT`,
    );
  });

  migrate('registered_groups.verbose_default', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN verbose_default INTEGER DEFAULT 0`,
    );
  });
  migrate('registered_groups.thinking_default', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN thinking_default INTEGER DEFAULT 0`,
    );
  });
  migrate('registered_groups.display_icon_url', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN display_icon_url TEXT`,
    );
  });

  migrate('registered_groups.channel_role', () => {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN channel_role TEXT DEFAULT 'director'`,
    );
  });
  migrate('registered_groups.bot_user_id', () => {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN bot_user_id TEXT`);
  });
  migrate('registered_groups.bot_token', () => {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN bot_token TEXT`);
  });

  // Migrate registered_groups to composite PK (jid, folder) if still using single PK.
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

  migrate('chats.channel/is_group', () => {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
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
  });
}

/**
 * Migrate registered_groups from single PK (jid) to composite PK (jid, folder).
 * This enables multiple groups per channel for multi-agent @mention routing.
 */
function migrateRegisteredGroupsPK(database: Database.Database): void {
  const tableInfo = database
    .prepare(`PRAGMA table_info(registered_groups)`)
    .all() as Array<{
    name: string;
    pk: number;
  }>;
  const pkColumns = tableInfo.filter((c) => c.pk > 0);
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
               COALESCE(channel_role, 'director'), bot_user_id, bot_token
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

// Re-export all store functions for backward compatibility
export * from './stores/chat-store.js';
export * from './stores/task-store.js';
export * from './stores/group-store.js';
export * from './stores/session-store.js';
