import { getDb } from '../db.js';
import type { AnyJid, ChannelJid } from '../jid.js';
import { buildThreadJid } from '../jid.js';
import { NewMessage } from '../types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: ChannelJid,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    getDb()
      .prepare(
        `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
      )
      .run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    getDb()
      .prepare(
        `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
      )
      .run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: ChannelJid, name: string): void {
  getDb()
    .prepare(
      `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
    )
    .run(chatJid, name, new Date().toISOString());
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return getDb()
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
  const row = getDb()
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
    )
    .run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  // Ensure chat exists for synthetic thread JIDs (FK constraint)
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    )
    .run(msg.chat_jid, msg.chat_jid, msg.timestamp);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_ts, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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

  const rows = getDb()
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as (Omit<
    NewMessage,
    'chat_jid'
  > & { chat_jid: string; files?: string })[];

  let newTimestamp = lastTimestamp;
  const messages: NewMessage[] = rows.map((row) => {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    return {
      ...row,
      chat_jid: row.chat_jid as AnyJid,
      files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
    };
  });

  return { messages, newTimestamp };
}

export function getMessageById(
  chatJid: ChannelJid,
  messageId: string,
): NewMessage | undefined {
  const row = getDb()
    .prepare(
      'SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_ts AS threadTs, files FROM messages WHERE chat_jid = ? AND id = ?',
    )
    .get(chatJid, messageId) as
    | (Omit<NewMessage, 'chat_jid'> & { chat_jid: string; files?: string })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    chat_jid: row.chat_jid as AnyJid,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  };
}

export function getMessagesSince(
  chatJid: AnyJid,
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
  const rows = getDb()
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as (Omit<
    NewMessage,
    'chat_jid'
  > & { chat_jid: string; files?: string })[];
  return rows.map((row) => ({
    ...row,
    chat_jid: row.chat_jid as AnyJid,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  }));
}

export function getThreadMessages(
  chatJid: ChannelJid,
  threadTs: string,
): Array<{
  id: string;
  content: string;
  sender_name: string;
  is_bot_message: number;
  timestamp: string;
}> {
  // Thread messages are stored under two chat_jid formats: the channel JID and
  // the synthetic thread JID (see jid.ts buildThreadJid). Both formats appear
  // in production for thread-scoped messages — Slack thread messages and
  // system-generated approval/answer messages use the synthetic form. Match either.
  const syntheticJid = buildThreadJid(chatJid, threadTs);
  return getDb()
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

/**
 * Get messages since a timestamp, INCLUDING bot messages (for multi-agent context).
 * Used when an agent needs to see other agents' messages in the conversation.
 */
export function getMessagesSinceIncludingBots(
  chatJid: AnyJid,
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
  const rows = getDb()
    .prepare(sql)
    .all(chatJid, sinceTimestamp, limit) as (Omit<NewMessage, 'chat_jid'> & {
    chat_jid: string;
    files?: string;
  })[];
  return rows.map((row) => ({
    ...row,
    chat_jid: row.chat_jid as AnyJid,
    files: typeof row.files === 'string' ? JSON.parse(row.files) : undefined,
  }));
}
