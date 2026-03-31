/**
 * JID utilities for Slack channel and thread JIDs.
 *
 * Two JID forms:
 *   Channel JID:  slack:{channelId}           (e.g., slack:C0AN59XN8B1)
 *   Thread JID:   slack:{channelId}:t:{ts}    (e.g., slack:C0AN59XN8B1:t:1234567.890)
 *
 * The `:t:` infix is unambiguous — Slack channel IDs never contain colons.
 *
 * Group identity (which agent handles a channel) is NOT encoded in JIDs.
 * It is passed as a separate `groupFolder` parameter through the system.
 */

const THREAD_JID_REGEX = /^(slack:[^:]+):t:(.+)$/;

/**
 * Parse a Slack JID to extract the channel ID and optional thread timestamp.
 */
export function parseSlackJid(jid: string): {
  channelId: string;
  threadTs?: string;
} {
  const stripped = jid.replace(/^slack:/, '');
  const threadMatch = stripped.match(/^(.+?):t:(.+)$/);
  if (threadMatch) {
    return { channelId: threadMatch[1], threadTs: threadMatch[2] };
  }
  return { channelId: stripped };
}

/** Build a synthetic thread JID from a channel JID and thread timestamp. */
export function buildThreadJid(channelJid: string, threadTs: string): string {
  if (channelJid.includes(':t:')) {
    throw new Error(
      `buildThreadJid: input already contains :t: — got "${channelJid}"`,
    );
  }
  return `${channelJid}:t:${threadTs}`;
}

/**
 * Extract the parent channel JID from a synthetic thread JID.
 * Strips `:t:` suffix to get the plain channel JID.
 * Returns null if already a plain channel JID.
 */
export function getParentJid(jid: string): string | null {
  const match = jid.match(THREAD_JID_REGEX);
  return match ? match[1] : null;
}

/** Check if a JID is a synthetic thread JID. */
export function isSyntheticThreadJid(jid: string): boolean {
  return THREAD_JID_REGEX.test(jid);
}
