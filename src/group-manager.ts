import fs from 'fs';
import path from 'path';

import type { AppState } from './app-state.js';
import {
  addThreadMember,
  countBotTriggers,
  getAllChats,
  getAllRegisteredGroupsMulti,
  getThreadMembers,
  recordBotTrigger,
  setRegisteredGroup,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { getParentJid } from './jid.js';
import { logger } from './logger.js';
import type { AvailableGroup } from './snapshot-writer.js';
import { NewMessage, RegisteredGroup } from './types.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class GroupManager {
  constructor(private state: AppState) {}

  /**
   * Find the main group (isMain=true) from registered groups.
   * DM messages are processed under the main group's config.
   */
  getMainGroup(): { jid: string; group: RegisteredGroup } | null {
    for (const [jid, group] of Object.entries(this.state.registeredGroups)) {
      if (group.isMain) return { jid, group };
    }
    return null;
  }

  /**
   * Resolve a group from a JID.
   * Tries direct lookup, then parent channel JID (for thread JIDs), then main group fallback.
   */
  resolveGroup(chatJid: string): RegisteredGroup | null {
    let group = this.state.registeredGroups[chatJid];
    if (group) return group;
    const parentJid = getParentJid(chatJid);
    if (parentJid) group = this.state.registeredGroups[parentJid];
    if (group) return group;
    const main = this.getMainGroup();
    return main?.group ?? null;
  }

  /**
   * Rebuild the multi-agent index maps from the database.
   * Called on startup and after group registration changes.
   */
  rebuildGroupIndexes(): void {
    this.state.groupsByJid.clear();
    this.state.groupsByFolder.clear();
    this.state.groupsByBotUserId.clear();
    const allGroups = getAllRegisteredGroupsMulti();
    for (const [jid, groups] of allGroups) {
      this.state.groupsByJid.set(jid, groups);
      for (const g of groups) {
        // Only store primary registration per folder — first one wins (directors before members)
        if (!this.state.groupsByFolder.has(g.folder)) {
          this.state.groupsByFolder.set(g.folder, { jid, group: g });
        }
        if (g.botUserId) {
          this.state.groupsByBotUserId.set(g.botUserId, g);
        }
      }
      // state.registeredGroups: pick director, fallback to first
      const director =
        groups.find((g) => g.channelRole === 'director') || groups[0];
      this.state.registeredGroups[jid] = director;
    }
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Rejecting group registration with invalid folder',
      );
      return;
    }

    this.state.registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    this.rebuildGroupIndexes();

    // Create group folder
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  /**
   * Get available groups list for the agent.
   * Returns groups ordered by most recent activity.
   */
  getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.state.registeredGroups));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  /**
   * Check if a JID is a multi-group channel (more than 1 group registered).
   */
  isMultiGroupChannel(channelJid: string): boolean {
    const groups = this.state.groupsByJid.get(channelJid);
    return !!groups && groups.length > 1;
  }

  /**
   * Parse @mentions from message text.
   * For directors with own Slack apps: check for native <@U_BOT_ID> mentions.
   * For technicians/fallback: check for text-based @Name mentions.
   */
  parseMentions(content: string, channelGroups: RegisteredGroup[]): string[] {
    const mentioned: string[] = [];
    // Strip code blocks to avoid false positives
    const stripped = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '');

    for (const group of channelGroups) {
      // Director with own app: check for native Slack mention <@U_BOT_ID>
      if (group.botUserId) {
        if (stripped.includes(`<@${group.botUserId}>`)) {
          mentioned.push(group.folder);
          continue;
        }
      }
      // Fallback: text-based @Name mention (for technicians or legacy)
      const name = group.assistantName || group.displayName;
      if (!name) continue;
      const pattern = new RegExp(`(?:^|\\s)@${escapeRegex(name)}\\b`, 'i');
      if (pattern.test(stripped)) {
        mentioned.push(group.folder);
      }
    }
    return mentioned;
  }

  /**
   * Identify which agent sent a bot message.
   * Uses bot_id lookup against known agent bot user IDs, falls back to sender_name.
   */
  resolveSenderFolder(msg: NewMessage): string | null {
    // Check sender against known agent bot user IDs
    if (msg.sender) {
      const group = this.state.groupsByBotUserId.get(msg.sender);
      if (group) return group.folder;
    }
    // Fallback: match sender_name against known agents
    if (msg.sender_name) {
      for (const [folder, entry] of this.state.groupsByFolder) {
        const name = entry.group.assistantName || entry.group.displayName;
        if (name && name.toLowerCase() === msg.sender_name.toLowerCase()) {
          return folder;
        }
      }
    }
    return null;
  }

  /**
   * Determine which groups should process a message in a multi-group channel.
   * Handles @mention dispatch, thread membership, director defaults, and anti-loop.
   */
  resolveTargetGroups(
    channelJid: string,
    threadTs: string | undefined,
    msg: NewMessage,
  ): RegisteredGroup[] {
    const channelGroups = this.state.groupsByJid.get(channelJid);

    // Single-group channel: existing behavior (always that group)
    if (!channelGroups || channelGroups.length <= 1) {
      const group = this.resolveGroup(channelJid);
      return group ? [group] : [];
    }

    // Multi-group channel: dispatch based on mentions and membership
    const targets: RegisteredGroup[] = [];
    const isBotMsg = msg.is_bot_message === true;

    // Parse @mentions from message text
    const mentionedFolders = this.parseMentions(msg.content, channelGroups);

    // Determine sender's folder (for bot messages, to prevent self-triggering)
    const senderFolder = isBotMsg ? this.resolveSenderFolder(msg) : null;

    if (threadTs) {
      // Thread message: check membership + mentions
      const members = getThreadMembers(channelJid, threadTs);

      if (isBotMsg) {
        // Bot message: ONLY explicitly @mentioned agents (that aren't the sender)
        for (const folder of mentionedFolders) {
          if (folder !== senderFolder) {
            const group = channelGroups.find((g) => g.folder === folder);
            if (group) {
              // Rate limit: max 3 bot-triggered invocations per 5 minutes per thread
              if (countBotTriggers(channelJid, threadTs, folder, 5) >= 3) {
                logger.warn(
                  { channelJid, threadTs, folder },
                  'Bot trigger rate limit reached, skipping',
                );
                continue;
              }
              addThreadMember(channelJid, threadTs, folder);
              recordBotTrigger(channelJid, threadTs, folder);
              targets.push(group);
            }
          }
        }
      } else {
        // Human message: all thread members + newly @mentioned + directors (selective)
        for (const folder of members) {
          const group = channelGroups.find((g) => g.folder === folder);
          if (group) targets.push(group);
        }
        // Add newly mentioned agents that aren't already members
        for (const folder of mentionedFolders) {
          if (!members.includes(folder)) {
            addThreadMember(channelJid, threadTs, folder);
            const group = channelGroups.find((g) => g.folder === folder);
            if (group) targets.push(group);
          }
        }
        // Directors: auto-join only if no @mentions, or if they're @mentioned
        for (const group of channelGroups) {
          if (
            group.channelRole === 'director' &&
            !members.includes(group.folder)
          ) {
            const directorMentioned = mentionedFolders.includes(group.folder);
            const noMentionsAtAll = mentionedFolders.length === 0;
            if (directorMentioned || noMentionsAtAll) {
              addThreadMember(channelJid, threadTs, group.folder);
              if (!targets.find((t) => t.folder === group.folder)) {
                targets.push(group);
              }
            }
          }
        }
      }
    } else {
      // Channel-root message (new thread)
      if (isBotMsg) {
        // Bot message at root: only @mentioned agents (not the sender)
        for (const folder of mentionedFolders) {
          if (folder !== senderFolder) {
            const group = channelGroups.find((g) => g.folder === folder);
            if (group) targets.push(group);
          }
        }
      } else {
        // Human message at root: directors (unless message exclusively targets others) + @mentioned
        const hasExplicitMentions = mentionedFolders.length > 0;
        for (const group of channelGroups) {
          if (group.channelRole === 'director') {
            const directorMentioned = mentionedFolders.includes(group.folder);
            if (!hasExplicitMentions || directorMentioned) {
              targets.push(group);
            }
          }
        }
        // Add explicitly @mentioned non-directors
        for (const folder of mentionedFolders) {
          const group = channelGroups.find((g) => g.folder === folder);
          if (group && !targets.find((t) => t.folder === folder)) {
            targets.push(group);
          }
        }
      }
    }

    return targets;
  }
}
