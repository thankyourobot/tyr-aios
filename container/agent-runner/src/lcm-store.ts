/**
 * LCM (Lossless Context Management) Store
 * SQLite database for persisting messages, summary DAG nodes,
 * context window items, message parts, bootstrap state, and large files.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// --- Types ---

export interface LcmMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  token_estimate: number;
  sequence: number;
  created_at: string;
}

export interface LcmSummary {
  id: string;
  conversation_id: string;
  depth: number;
  content: string;
  token_estimate: number;
  source_message_ids: string | null;
  parent_summary_ids: string | null;
  child_summary_ids: string | null;
  min_sequence: number | null;
  max_sequence: number | null;
  created_at: string;
  // Phase 2 additions
  kind: string | null;
  earliest_at: string | null;
  latest_at: string | null;
  descendant_count: number;
  descendant_token_count: number;
  source_message_token_count: number;
}

export interface LcmContextItem {
  conversation_id: string;
  ordinal: number;
  item_type: 'message' | 'summary';
  message_id: string | null;
  summary_id: string | null;
  created_at: string;
}

export interface LcmMessagePart {
  part_id: string;
  message_id: string;
  part_type: 'text' | 'reasoning' | 'tool' | 'file' | 'compaction';
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
}

export interface LcmBootstrapState {
  conversation_id: string;
  session_file_path: string;
  last_seen_size: number;
  last_seen_mtime_ms: number;
  last_processed_offset: number;
  last_processed_entry_hash: string | null;
  updated_at: string;
}

export interface LcmLargeFile {
  file_id: string;
  conversation_id: string;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
}

// --- Schema ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lcm_messages (
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lcm_messages_conversation ON lcm_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS lcm_summaries (
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  source_message_ids TEXT,
  parent_summary_ids TEXT,
  child_summary_ids TEXT,
  min_sequence INTEGER,
  max_sequence INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lcm_summaries_conversation ON lcm_summaries(conversation_id, depth);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS lcm_messages_fts USING fts5(
  content, content=lcm_messages, content_rowid=rowid
);
CREATE VIRTUAL TABLE IF NOT EXISTS lcm_summaries_fts USING fts5(
  content, content=lcm_summaries, content_rowid=rowid
);
`;

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS lcm_messages_ai AFTER INSERT ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_messages_ad AFTER DELETE ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(lcm_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_messages_au AFTER UPDATE ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(lcm_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO lcm_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS lcm_summaries_ai AFTER INSERT ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_summaries_ad AFTER DELETE ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(lcm_summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_summaries_au AFTER UPDATE ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(lcm_summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO lcm_summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

// --- Migration framework ---

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v0 → v1: Richer summary metadata
  (db) => {
    const addCol = (col: string, type: string) => {
      try { db.exec(`ALTER TABLE lcm_summaries ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
    };
    addCol('kind', 'TEXT');
    addCol('earliest_at', 'TEXT');
    addCol('latest_at', 'TEXT');
    addCol('descendant_count', 'INTEGER DEFAULT 0');
    addCol('descendant_token_count', 'INTEGER DEFAULT 0');
    addCol('source_message_token_count', 'INTEGER DEFAULT 0');
  },

  // v1 → v2: Context items table
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_context_items (
        conversation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
        message_id TEXT,
        summary_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (conversation_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_lcm_context_items_conv ON lcm_context_items(conversation_id, ordinal);
    `);
  },

  // v2 → v3: Message parts table
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_message_parts (
        part_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        part_type TEXT NOT NULL CHECK (part_type IN ('text', 'reasoning', 'tool', 'file', 'compaction')),
        ordinal INTEGER NOT NULL,
        text_content TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        metadata TEXT,
        UNIQUE (message_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_lcm_message_parts_msg ON lcm_message_parts(message_id);
    `);
  },

  // v3 → v4: Bootstrap state table
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_bootstrap_state (
        conversation_id TEXT PRIMARY KEY,
        session_file_path TEXT NOT NULL,
        last_seen_size INTEGER NOT NULL,
        last_seen_mtime_ms INTEGER NOT NULL,
        last_processed_offset INTEGER NOT NULL,
        last_processed_entry_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },

  // v4 → v5: Large files table
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_large_files (
        file_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        byte_size INTEGER,
        storage_uri TEXT NOT NULL,
        exploration_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },

  // v5 → v6: Junction tables for summary lineage (replaces JSON arrays)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_summary_messages (
        summary_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lcm_summary_messages_msg ON lcm_summary_messages(message_id);

      CREATE TABLE IF NOT EXISTS lcm_summary_parents (
        summary_id TEXT NOT NULL,
        parent_summary_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lcm_summary_parents_parent ON lcm_summary_parents(parent_summary_id);
    `);

    // Backfill from existing JSON arrays
    const summaries = db.prepare('SELECT id, source_message_ids, child_summary_ids FROM lcm_summaries').all() as Array<{
      id: string; source_message_ids: string | null; child_summary_ids: string | null;
    }>;
    const insertMsg = db.prepare('INSERT OR IGNORE INTO lcm_summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)');
    const insertParent = db.prepare('INSERT OR IGNORE INTO lcm_summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)');

    const backfill = db.transaction(() => {
      for (const s of summaries) {
        if (s.source_message_ids) {
          try {
            const ids: string[] = JSON.parse(s.source_message_ids);
            for (let i = 0; i < ids.length; i++) {
              insertMsg.run(s.id, ids[i], i);
            }
          } catch { /* malformed JSON, skip */ }
        }
        if (s.child_summary_ids) {
          try {
            const ids: string[] = JSON.parse(s.child_summary_ids);
            for (let i = 0; i < ids.length; i++) {
              insertParent.run(s.id, ids[i], i);
            }
          } catch { /* malformed JSON, skip */ }
        }
      }
    });
    backfill();
  },
];

function runMigrations(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS lcm_schema_version (version INTEGER NOT NULL)`);
  const row = database.prepare('SELECT version FROM lcm_schema_version LIMIT 1').get() as { version: number } | undefined;
  let currentVersion = row?.version ?? 0;

  if (!row) {
    database.prepare('INSERT INTO lcm_schema_version (version) VALUES (?)').run(0);
  }

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i](database);
    database.prepare('UPDATE lcm_schema_version SET version = ?').run(i + 1);
  }
}

// --- Database ---

let db: Database.Database | null = null;
let dbInitialized = false;

export function initLcmDatabase(dbPath: string): Database.Database | null {
  if (process.env.LCM_ENABLED === 'false') return null;
  if (dbInitialized && db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(TRIGGERS_SQL);

  // Legacy migration: rename session_id to conversation_id if needed
  try {
    db.exec(`ALTER TABLE lcm_messages RENAME COLUMN session_id TO conversation_id`);
    db.exec(`ALTER TABLE lcm_summaries RENAME COLUMN session_id TO conversation_id`);
  } catch {
    /* columns already renamed or don't exist */
  }

  runMigrations(db);
  dbInitialized = true;
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory LCM database. */
export function _initTestLcmDatabase(): void {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(TRIGGERS_SQL);
  runMigrations(db);
  dbInitialized = true;
}

export function getLcmDb(): Database.Database {
  if (!db) throw new Error('LCM database not initialized. Call initLcmDatabase() first.');
  return db;
}

// --- Helpers ---

export function contentHash(conversationId: string, role: string, content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${conversationId}:${role}:${content}`);
  return hash.digest('hex').slice(0, 16);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Message store ---

export function storeMessages(
  conversationId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  startSequence: number = 0,
): number {
  const database = getLcmDb();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO lcm_messages (id, conversation_id, role, content, token_estimate, sequence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedCount = 0;
  const insertMany = database.transaction((msgs: typeof messages) => {
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const seq = startSequence + i;
      const id = contentHash(conversationId, msg.role, msg.content);
      const result = stmt.run(id, conversationId, msg.role, msg.content, estimateTokens(msg.content), seq, new Date().toISOString());
      if (result.changes > 0) insertedCount++;
    }
  });

  insertMany(messages);
  return insertedCount;
}

// --- Summary store ---

export interface StoreSummaryInput {
  id: string;
  conversation_id: string;
  depth: number;
  content: string;
  source_message_ids: string | null;
  parent_summary_ids: string | null;
  child_summary_ids: string | null;
  min_sequence: number | null;
  max_sequence: number | null;
  created_at: string;
  kind?: string | null;
  earliest_at?: string | null;
  latest_at?: string | null;
  descendant_count?: number;
  descendant_token_count?: number;
  source_message_token_count?: number;
}

export function storeSummary(summary: StoreSummaryInput): void {
  const database = getLcmDb();
  const tokenEstimate = estimateTokens(summary.content);
  const kind = summary.kind ?? (summary.depth === 0 ? 'leaf' : 'condensed');

  database.transaction(() => {
    database.prepare(`
      INSERT OR IGNORE INTO lcm_summaries (
        id, conversation_id, depth, content, token_estimate,
        source_message_ids, parent_summary_ids, child_summary_ids,
        min_sequence, max_sequence, created_at,
        kind, earliest_at, latest_at,
        descendant_count, descendant_token_count, source_message_token_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.id,
      summary.conversation_id,
      summary.depth,
      summary.content,
      tokenEstimate,
      summary.source_message_ids,
      summary.parent_summary_ids,
      summary.child_summary_ids,
      summary.min_sequence,
      summary.max_sequence,
      summary.created_at,
      kind,
      summary.earliest_at ?? null,
      summary.latest_at ?? null,
      summary.descendant_count ?? 0,
      summary.descendant_token_count ?? 0,
      summary.source_message_token_count ?? 0,
    );

    // Write to junction tables (source of truth for lineage queries)
    if (summary.source_message_ids) {
      try {
        const ids: string[] = JSON.parse(summary.source_message_ids);
        const stmt = database.prepare('INSERT OR IGNORE INTO lcm_summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)');
        for (let i = 0; i < ids.length; i++) {
          stmt.run(summary.id, ids[i], i);
        }
      } catch { /* malformed JSON */ }
    }
    if (summary.child_summary_ids) {
      try {
        const ids: string[] = JSON.parse(summary.child_summary_ids);
        const stmt = database.prepare('INSERT OR IGNORE INTO lcm_summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)');
        for (let i = 0; i < ids.length; i++) {
          stmt.run(summary.id, ids[i], i);
        }
      } catch { /* malformed JSON */ }
    }
  })();
}

export function getSummariesForConversation(
  conversationId: string,
  opts?: { depth?: number; minSequence?: number; maxSequence?: number },
): LcmSummary[] {
  const database = getLcmDb();
  let sql = 'SELECT * FROM lcm_summaries WHERE conversation_id = ?';
  const params: unknown[] = [conversationId];

  if (opts?.depth !== undefined) {
    sql += ' AND depth = ?';
    params.push(opts.depth);
  }
  if (opts?.minSequence !== undefined) {
    sql += ' AND max_sequence >= ?';
    params.push(opts.minSequence);
  }
  if (opts?.maxSequence !== undefined) {
    sql += ' AND min_sequence <= ?';
    params.push(opts.maxSequence);
  }

  sql += ' ORDER BY min_sequence ASC';
  return database.prepare(sql).all(...params) as LcmSummary[];
}

export function getSummaryById(id: string): LcmSummary | undefined {
  const database = getLcmDb();
  return database.prepare('SELECT * FROM lcm_summaries WHERE id = ?').get(id) as LcmSummary | undefined;
}

export function getMessagesForSummary(summaryId: string): LcmMessage[] {
  const database = getLcmDb();
  return database.prepare(`
    SELECT m.* FROM lcm_messages m
    JOIN lcm_summary_messages sm ON sm.message_id = m.id
    WHERE sm.summary_id = ?
    ORDER BY sm.ordinal
  `).all(summaryId) as LcmMessage[];
}

export function getMessagesBySequenceRange(conversationId: string, minSeq: number, maxSeq: number): LcmMessage[] {
  const database = getLcmDb();
  return database.prepare(
    'SELECT * FROM lcm_messages WHERE conversation_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence',
  ).all(conversationId, minSeq, maxSeq) as LcmMessage[];
}

export function getMaxSequence(conversationId: string): number {
  const database = getLcmDb();
  const row = database.prepare('SELECT MAX(sequence) as max_seq FROM lcm_messages WHERE conversation_id = ?').get(conversationId) as { max_seq: number | null } | undefined;
  return row?.max_seq ?? -1;
}

// --- FTS ---

export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

export function searchMessages(queryStr: string, limit: number = 20): Array<LcmMessage & { rank: number }> {
  const database = getLcmDb();
  return database.prepare(`
    SELECT m.*, fts.rank
    FROM lcm_messages_fts fts
    JOIN lcm_messages m ON m.rowid = fts.rowid
    WHERE lcm_messages_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(sanitizeFtsQuery(queryStr), limit) as Array<LcmMessage & { rank: number }>;
}

export function searchSummaries(queryStr: string, limit: number = 20): Array<LcmSummary & { rank: number }> {
  const database = getLcmDb();
  return database.prepare(`
    SELECT s.*, fts.rank
    FROM lcm_summaries_fts fts
    JOIN lcm_summaries s ON s.rowid = fts.rowid
    WHERE lcm_summaries_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(sanitizeFtsQuery(queryStr), limit) as Array<LcmSummary & { rank: number }>;
}

export function getChildSummaries(summaryId: string): LcmSummary[] {
  const database = getLcmDb();
  return database.prepare(`
    SELECT s.* FROM lcm_summaries s
    JOIN lcm_summary_parents sp ON sp.parent_summary_id = s.id
    WHERE sp.summary_id = ?
    ORDER BY sp.ordinal
  `).all(summaryId) as LcmSummary[];
}

/**
 * Find all summaries that cover a given message (reverse lookup).
 */
export function getSummariesForMessage(messageId: string): LcmSummary[] {
  const database = getLcmDb();
  return database.prepare(`
    SELECT s.* FROM lcm_summaries s
    JOIN lcm_summary_messages sm ON sm.summary_id = s.id
    WHERE sm.message_id = ?
    ORDER BY s.min_sequence
  `).all(messageId) as LcmSummary[];
}

/**
 * Get IDs of all leaf summaries that are covered by condensed summaries.
 */
export function getCoveredLeafIds(conversationId: string): Set<string> {
  const database = getLcmDb();
  const rows = database.prepare(`
    SELECT DISTINCT sp.parent_summary_id as id
    FROM lcm_summary_parents sp
    JOIN lcm_summaries s ON s.id = sp.summary_id
    WHERE s.conversation_id = ?
  `).all(conversationId) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

/**
 * Find all parent summaries that condensed a given child summary (reverse lookup).
 */
export function getParentSummaries(childSummaryId: string): LcmSummary[] {
  const database = getLcmDb();
  return database.prepare(`
    SELECT s.* FROM lcm_summaries s
    JOIN lcm_summary_parents sp ON sp.summary_id = s.id
    WHERE sp.parent_summary_id = ?
    ORDER BY s.min_sequence
  `).all(childSummaryId) as LcmSummary[];
}

// --- Context items ---

export function appendContextItems(
  conversationId: string,
  items: Array<{ item_type: 'message' | 'summary'; message_id?: string; summary_id?: string }>,
): void {
  const database = getLcmDb();
  const maxRow = database.prepare(
    'SELECT MAX(ordinal) as max_ord FROM lcm_context_items WHERE conversation_id = ?',
  ).get(conversationId) as { max_ord: number | null } | undefined;
  let nextOrdinal = (maxRow?.max_ord ?? -1) + 1;

  const stmt = database.prepare(`
    INSERT INTO lcm_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction(() => {
    for (const item of items) {
      stmt.run(conversationId, nextOrdinal++, item.item_type, item.message_id ?? null, item.summary_id ?? null);
    }
  });
  insertMany();
}

/**
 * Replace context items for the given message IDs with a single summary item.
 * Looks up items by message_id (not ordinal) to avoid number-space mismatches.
 */
export function replaceContextItemsWithSummary(
  conversationId: string,
  messageIds: string[],
  summaryId: string,
): void {
  if (messageIds.length === 0) return;
  const database = getLcmDb();
  database.transaction(() => {
    const placeholders = messageIds.map(() => '?').join(',');
    const range = database.prepare(
      `SELECT MIN(ordinal) as min_ord, MAX(ordinal) as max_ord
       FROM lcm_context_items
       WHERE conversation_id = ? AND message_id IN (${placeholders})`,
    ).get(conversationId, ...messageIds) as { min_ord: number | null; max_ord: number | null };

    if (range.min_ord === null) return;

    database.prepare(
      'DELETE FROM lcm_context_items WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ?',
    ).run(conversationId, range.min_ord, range.max_ord);

    database.prepare(
      'INSERT INTO lcm_context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)',
    ).run(conversationId, range.min_ord, 'summary', summaryId);

    // Recompact ordinals to be contiguous
    const items = database.prepare(
      'SELECT rowid FROM lcm_context_items WHERE conversation_id = ? ORDER BY ordinal',
    ).all(conversationId) as Array<{ rowid: number }>;
    const reindex = database.prepare('UPDATE lcm_context_items SET ordinal = ? WHERE rowid = ?');
    for (let i = 0; i < items.length; i++) {
      reindex.run(i, items[i].rowid);
    }
  })();
}

/**
 * Replace context items for the given child summary IDs with a single condensed summary item.
 */
export function replaceContextSummariesWithCondensed(
  conversationId: string,
  childSummaryIds: string[],
  condensedSummaryId: string,
): void {
  if (childSummaryIds.length === 0) return;
  const database = getLcmDb();
  database.transaction(() => {
    const placeholders = childSummaryIds.map(() => '?').join(',');
    const range = database.prepare(
      `SELECT MIN(ordinal) as min_ord, MAX(ordinal) as max_ord
       FROM lcm_context_items
       WHERE conversation_id = ? AND summary_id IN (${placeholders})`,
    ).get(conversationId, ...childSummaryIds) as { min_ord: number | null; max_ord: number | null };

    if (range.min_ord === null) return;

    database.prepare(
      'DELETE FROM lcm_context_items WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ?',
    ).run(conversationId, range.min_ord, range.max_ord);

    database.prepare(
      'INSERT INTO lcm_context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)',
    ).run(conversationId, range.min_ord, 'summary', condensedSummaryId);

    const items = database.prepare(
      'SELECT rowid FROM lcm_context_items WHERE conversation_id = ? ORDER BY ordinal',
    ).all(conversationId) as Array<{ rowid: number }>;
    const reindex = database.prepare('UPDATE lcm_context_items SET ordinal = ? WHERE rowid = ?');
    for (let i = 0; i < items.length; i++) {
      reindex.run(i, items[i].rowid);
    }
  })();
}

export function getContextItems(conversationId: string): LcmContextItem[] {
  const database = getLcmDb();
  return database.prepare(
    'SELECT * FROM lcm_context_items WHERE conversation_id = ? ORDER BY ordinal',
  ).all(conversationId) as LcmContextItem[];
}

// --- Message parts ---

export function storeMessageParts(parts: LcmMessagePart[]): void {
  if (parts.length === 0) return;
  const database = getLcmDb();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO lcm_message_parts (part_id, message_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction(() => {
    for (const part of parts) {
      stmt.run(
        part.part_id, part.message_id, part.part_type, part.ordinal,
        part.text_content, part.tool_call_id, part.tool_name,
        part.tool_input, part.tool_output, part.metadata,
      );
    }
  });
  insertMany();
}

export function getMessageParts(messageId: string): LcmMessagePart[] {
  const database = getLcmDb();
  return database.prepare(
    'SELECT * FROM lcm_message_parts WHERE message_id = ? ORDER BY ordinal',
  ).all(messageId) as LcmMessagePart[];
}

export function searchMessageParts(
  partType: string,
  query: string,
  limit: number = 20,
): Array<LcmMessagePart & { conversation_id: string; role: string; sequence: number }> {
  const database = getLcmDb();
  const likePattern = `%${query}%`;
  return database.prepare(`
    SELECT p.*, m.conversation_id, m.role, m.sequence
    FROM lcm_message_parts p
    JOIN lcm_messages m ON m.id = p.message_id
    WHERE p.part_type = ?
      AND (p.text_content LIKE ? OR p.tool_name LIKE ? OR p.tool_output LIKE ?)
    ORDER BY m.sequence DESC
    LIMIT ?
  `).all(partType, likePattern, likePattern, likePattern, limit) as Array<LcmMessagePart & { conversation_id: string; role: string; sequence: number }>;
}

// --- Bootstrap state ---

export function getBootstrapState(conversationId: string): LcmBootstrapState | undefined {
  const database = getLcmDb();
  return database.prepare(
    'SELECT * FROM lcm_bootstrap_state WHERE conversation_id = ?',
  ).get(conversationId) as LcmBootstrapState | undefined;
}

export function upsertBootstrapState(state: LcmBootstrapState): void {
  const database = getLcmDb();
  database.prepare(`
    INSERT OR REPLACE INTO lcm_bootstrap_state (conversation_id, session_file_path, last_seen_size, last_seen_mtime_ms, last_processed_offset, last_processed_entry_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.conversation_id, state.session_file_path, state.last_seen_size,
    state.last_seen_mtime_ms, state.last_processed_offset,
    state.last_processed_entry_hash, state.updated_at ?? new Date().toISOString(),
  );
}

// --- Large files ---

export function storeLargeFile(file: LcmLargeFile): void {
  const database = getLcmDb();
  database.prepare(`
    INSERT OR IGNORE INTO lcm_large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file.file_id, file.conversation_id, file.file_name, file.mime_type,
    file.byte_size, file.storage_uri, file.exploration_summary,
    file.created_at ?? new Date().toISOString(),
  );
}

export function getLargeFile(fileId: string): LcmLargeFile | undefined {
  const database = getLcmDb();
  return database.prepare('SELECT * FROM lcm_large_files WHERE file_id = ?').get(fileId) as LcmLargeFile | undefined;
}

// --- Subtree manifest ---

export interface SubtreeNode {
  id: string;
  depth: number;
  kind: string | null;
  token_estimate: number;
  descendant_count: number;
  descendant_token_count: number;
  children: SubtreeNode[];
}

export function getSubtreeManifest(summaryId: string, visited = new Set<string>()): SubtreeNode | null {
  if (visited.has(summaryId)) return null; // Cycle guard
  visited.add(summaryId);

  const summary = getSummaryById(summaryId);
  if (!summary) return null;

  const children = getChildSummaries(summaryId);
  const childNodes = children.map(c => getSubtreeManifest(c.id, visited)).filter((n): n is SubtreeNode => n !== null);

  return {
    id: summary.id,
    depth: summary.depth,
    kind: summary.kind,
    token_estimate: summary.token_estimate,
    descendant_count: summary.descendant_count ?? 0,
    descendant_token_count: summary.descendant_token_count ?? 0,
    children: childNodes,
  };
}
