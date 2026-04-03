import { getDb } from '../db.js';
import type { ChannelJid } from '../jid.js';
import { RegisteredGroup } from '../types.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';

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
  jid: ChannelJid,
): (RegisteredGroup & { jid: string }) | undefined {
  // With composite PK, a jid may have multiple rows — return the director (or first)
  const rows = getDb()
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

export function setRegisteredGroup(
  jid: ChannelJid,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, folder, name, trigger_pattern, added_at, container_config, requires_trigger, is_main, display_name, display_emoji, display_icon_url, assistant_name, verbose_default, thinking_default, channel_role, bot_user_id, bot_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  const rows = getDb()
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
  const rows = getDb()
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
  const row = getDb()
    .prepare('SELECT * FROM registered_groups WHERE folder = ? LIMIT 1')
    .get(folder) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return rowToRegisteredGroup(row);
}

/**
 * Get all JIDs registered to a given folder (supports multi-channel agents).
 */
export function getJidsForFolder(folder: string): Array<{
  jid: string;
  name: string;
  channelRole: string;
  assistantName: string | null;
}> {
  const rows = getDb()
    .prepare(
      'SELECT jid, name, channel_role, assistant_name FROM registered_groups WHERE folder = ?',
    )
    .all(folder) as Array<{
    jid: string;
    name: string;
    channel_role: string;
    assistant_name: string | null;
  }>;
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    channelRole: r.channel_role,
    assistantName: r.assistant_name,
  }));
}

// --- Thread membership for multi-agent @mention routing ---

export function getThreadMembers(
  channelJid: ChannelJid,
  threadTs: string,
): string[] {
  const rows = getDb()
    .prepare(
      'SELECT group_folder FROM thread_members WHERE channel_jid = ? AND thread_ts = ?',
    )
    .all(channelJid, threadTs) as Array<{ group_folder: string }>;
  return rows.map((r) => r.group_folder);
}

export function addThreadMember(
  channelJid: ChannelJid,
  threadTs: string,
  groupFolder: string,
): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO thread_members (channel_jid, thread_ts, group_folder, joined_at) VALUES (?, ?, ?, ?)',
    )
    .run(channelJid, threadTs, groupFolder, new Date().toISOString());
}

export function isThreadMember(
  channelJid: ChannelJid,
  threadTs: string,
  groupFolder: string,
): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM thread_members WHERE channel_jid = ? AND thread_ts = ? AND group_folder = ?',
    )
    .get(channelJid, threadTs, groupFolder);
  return !!row;
}

/** Record a bot-triggered processing event for rate limiting. */
export function recordBotTrigger(
  channelJid: ChannelJid,
  threadTs: string,
  groupFolder: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO thread_bot_triggers (channel_jid, thread_ts, group_folder, triggered_at) VALUES (?, ?, ?, ?)',
    )
    .run(channelJid, threadTs, groupFolder, new Date().toISOString());
}

/** Count bot-triggered processing events in a time window for rate limiting. */
export function countBotTriggers(
  channelJid: ChannelJid,
  threadTs: string,
  groupFolder: string,
  sinceMinutes: number,
): number {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) as cnt FROM thread_bot_triggers WHERE channel_jid = ? AND thread_ts = ? AND group_folder = ? AND triggered_at > ?',
    )
    .get(channelJid, threadTs, groupFolder, since) as { cnt: number };
  return row.cnt;
}

/** Cleanup old thread membership and bot trigger data. */
export function cleanupOldThreadData(maxAgeDays: number = 30): void {
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const membersDeleted = getDb()
    .prepare('DELETE FROM thread_members WHERE joined_at < ?')
    .run(cutoff);
  const triggersDeleted = getDb()
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
