import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';

let db: Database.Database;

/**
 * Schema baseline marker. Bumped when the canonical CREATE TABLE statements
 * change in a way that diverges from on-disk DBs that pre-date the change.
 * Read with `PRAGMA user_version`. Verified at startup by assertSchemaIsCanonical.
 */
const SCHEMA_USER_VERSION = 2;

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
      files TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
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
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated'
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run);
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_status ON scheduled_jobs(status);

    CREATE TABLE IF NOT EXISTS job_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_run_logs ON job_run_logs(job_id, run_at);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_group ON scheduled_jobs(group_folder);

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
    -- Column order in this CREATE TABLE differs from on-disk DBs that grew via
    -- the historical ALTER TABLE chain (since deleted). For named INSERT/SELECT
    -- this is invisible — but DO NOT use positional INSERT INTO registered_groups
    -- VALUES (...) because dev and prod will silently disagree on which value
    -- maps to which column. Always use named column lists for this table.
    CREATE TABLE IF NOT EXISTS registered_groups (
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
    CREATE INDEX IF NOT EXISTS idx_registered_groups_folder ON registered_groups(folder);

    -- Multi-agent thread participation tracking. One row per (channel, thread, agent)
    -- so we can route follow-up messages to every agent that has joined a thread.
    CREATE TABLE IF NOT EXISTS thread_members (
      channel_jid TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_jid, thread_ts, group_folder)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_members_thread
      ON thread_members(channel_jid, thread_ts);

    -- Rate-limit log for bot-triggered processing. Used to prevent A→B→A loops
    -- between agents in the same thread.
    CREATE TABLE IF NOT EXISTS thread_bot_triggers (
      channel_jid TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      triggered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bot_triggers
      ON thread_bot_triggers(channel_jid, thread_ts, group_folder);
  `);
}

/**
 * Verify the on-disk schema matches what this code expects. Throws on mismatch
 * so we fail loud at startup rather than die with cryptic errors at query time.
 *
 * Checks:
 *   1. registered_groups uses composite (jid, folder) PK — single-column PK
 *      means an old DB never ran the historical migration this code no longer
 *      includes.
 *   2. PRAGMA user_version is at the expected baseline. On fresh DBs we set it;
 *      on existing DBs that predate the marker (user_version = 0) we set it
 *      after a structural check.
 */
function assertSchemaIsCanonical(database: Database.Database): void {
  const tableInfo = database
    .prepare(`PRAGMA table_info(registered_groups)`)
    .all() as Array<{ name: string; pk: number }>;
  const pkColumns = tableInfo
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
  const expectedPk = ['folder', 'jid'];
  if (
    pkColumns.length !== expectedPk.length ||
    pkColumns[0] !== expectedPk[0] ||
    pkColumns[1] !== expectedPk[1]
  ) {
    throw new Error(
      `registered_groups primary key mismatch: expected (jid, folder) composite, got (${pkColumns.join(
        ', ',
      )}). This DB predates the schema collapse — see git history for migrateRegisteredGroupsPK to upgrade it manually before starting.`,
    );
  }

  const currentVersion = (
    database.prepare(`PRAGMA user_version`).get() as { user_version: number }
  ).user_version;
  if (currentVersion !== 0 && currentVersion !== SCHEMA_USER_VERSION) {
    throw new Error(
      `Unexpected schema user_version ${currentVersion}, expected 0 or ${SCHEMA_USER_VERSION}. Refusing to start with an unknown DB version.`,
    );
  }
  if (currentVersion !== SCHEMA_USER_VERSION) {
    database.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);
  assertSchemaIsCanonical(db);
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
  assertSchemaIsCanonical(db);
}

// Re-export store functions through the unified db namespace
export * from './stores/chat-store.js';
export * from './stores/job-store.js';
export * from './stores/group-store.js';
export * from './stores/session-store.js';
