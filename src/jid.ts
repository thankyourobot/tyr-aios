/**
 * JID utilities for synthetic thread JIDs and group-qualified JIDs.
 *
 * Synthetic JID format:        slack:{channelId}:t:{threadTs}
 * Group-qualified JID format:  slack:{channelId}[:t:{threadTs}]:g:{groupFolder}
 * Channel JID format:          slack:{channelId}
 *
 * The `:t:` and `:g:` infixes are unambiguous — Slack channel IDs never contain colons.
 * `:g:` is always the last segment when present.
 */

const THREAD_JID_REGEX = /^(slack:[^:]+):t:(.+)$/;
const GROUP_JID_REGEX = /^(.+?):g:(.+)$/;

/**
 * Parse a Slack JID to extract the channel ID, optional thread timestamp, and optional group folder.
 * Works with channel JIDs, synthetic thread JIDs, and group-qualified JIDs.
 */
export function parseSlackJid(jid: string): {
  channelId: string;
  threadTs?: string;
  groupFolder?: string;
} {
  // Strip :g: suffix first
  let remaining = jid;
  let groupFolder: string | undefined;
  const groupMatch = remaining.match(GROUP_JID_REGEX);
  if (groupMatch) {
    remaining = groupMatch[1];
    groupFolder = groupMatch[2];
  }
  const stripped = remaining.replace(/^slack:/, '');
  const threadMatch = stripped.match(/^(.+?):t:(.+)$/);
  if (threadMatch) {
    return { channelId: threadMatch[1], threadTs: threadMatch[2], groupFolder };
  }
  return { channelId: stripped, groupFolder };
}

/** Build a synthetic thread JID from a channel JID and thread timestamp. */
export function buildThreadJid(channelJid: string, threadTs: string): string {
  if (channelJid.includes(':t:')) {
    throw new Error(
      `buildThreadJid: input already contains :t: — got "${channelJid}"`,
    );
  }
  if (channelJid.includes(':g:')) {
    throw new Error(
      `buildThreadJid: input contains :g: — strip group first. Got "${channelJid}"`,
    );
  }
  return `${channelJid}:t:${threadTs}`;
}

/** Build a group-qualified JID by appending :g:{groupFolder} to a base JID. */
export function buildGroupJid(baseJid: string, groupFolder: string): string {
  if (baseJid.includes(':g:')) {
    throw new Error(
      `buildGroupJid: input already contains :g: — got "${baseJid}"`,
    );
  }
  return `${baseJid}:g:${groupFolder}`;
}

/** Extract the group folder from a group-qualified JID. Returns null if not group-qualified. */
export function getGroupFolder(jid: string): string | null {
  const match = jid.match(GROUP_JID_REGEX);
  return match ? match[2] : null;
}

/** Strip the :g: suffix from a JID, returning the base JID. */
export function getBaseJid(jid: string): string {
  const match = jid.match(GROUP_JID_REGEX);
  return match ? match[1] : jid;
}

/**
 * Extract the parent channel JID from a synthetic thread JID or group-qualified JID.
 * Strips both :g: and :t: suffixes to get the channel JID.
 * Returns null if already a plain channel JID.
 */
export function getParentJid(jid: string): string | null {
  const base = getBaseJid(jid);
  const match = base.match(THREAD_JID_REGEX);
  return match ? match[1] : jid !== base ? base : null;
}

/** Check if a JID is a synthetic thread JID (ignoring :g: suffix). */
export function isSyntheticThreadJid(jid: string): boolean {
  const base = getBaseJid(jid);
  return THREAD_JID_REGEX.test(base);
}
