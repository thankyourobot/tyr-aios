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

// --- Branded types ---

export type ChannelJid = string & { readonly __brand: 'ChannelJid' };
export type ThreadJid = string & { readonly __brand: 'ThreadJid' };
export type AnyJid = ChannelJid | ThreadJid;

// --- Constructors ---

/** Brand a raw string as a ChannelJid. Throws if it contains `:t:`. */
export function channelJid(raw: string): ChannelJid {
  if (raw.includes(':t:')) {
    throw new Error(`channelJid: input contains :t: — got "${raw}"`);
  }
  return raw as ChannelJid;
}

/** Brand a raw string as a ThreadJid. Throws if it does not contain `:t:`. */
export function threadJid(raw: string): ThreadJid {
  if (!raw.includes(':t:')) {
    throw new Error(`threadJid: input does not contain :t: — got "${raw}"`);
  }
  return raw as ThreadJid;
}

// --- Utilities ---

// Matches any JID with :t: thread separator (format-agnostic, not Slack-specific)
const THREAD_JID_REGEX = /^(.+?):t:(.+)$/;

/**
 * Parse a Slack JID to extract the channel ID and optional thread timestamp.
 */
export function parseSlackJid(jid: AnyJid): {
  channelId: string;
  threadTs?: string;
} {
  const stripped = (jid as string).replace(/^slack:/, '');
  const threadMatch = stripped.match(/^(.+?):t:(.+)$/);
  if (threadMatch) {
    return { channelId: threadMatch[1], threadTs: threadMatch[2] };
  }
  return { channelId: stripped };
}

/** Build a synthetic thread JID from a channel JID and thread timestamp. */
export function buildThreadJid(
  cJid: ChannelJid,
  threadTs: string,
): ThreadJid {
  return `${cJid}:t:${threadTs}` as ThreadJid;
}

/**
 * Extract the parent channel JID from a synthetic thread JID.
 * Strips `:t:` suffix to get the plain channel JID.
 * Returns null if already a plain channel JID.
 */
export function getParentJid(jid: AnyJid): ChannelJid | null {
  const match = (jid as string).match(THREAD_JID_REGEX);
  return match ? (match[1] as ChannelJid) : null;
}

/** Type guard: check if a JID is a synthetic thread JID. */
export function isSyntheticThreadJid(jid: string): jid is ThreadJid {
  return THREAD_JID_REGEX.test(jid);
}
