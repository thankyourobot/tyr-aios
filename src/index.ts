import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeRecentActivitySnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllRegisteredGroupsMulti,
  getAllSessions,
  getAllTasks,
  getMessageById,
  getMessagesSince,
  getMessagesSinceIncludingBots,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getThreadSession,
  setThreadSession,
  storeResponseUuid,
  getThreadResponseUuids,
  getThreadMembers,
  addThreadMember,
  recordBotTrigger,
  countBotTriggers,
  cleanupOldThreadData,
  getGroupByFolder,
  getJidsForFolder,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';
import {
  buildThreadJid,
  buildGroupJid,
  getParentJid,
  getBaseJid,
  getGroupFolder,
  isSyntheticThreadJid,
  parseSlackJid,
} from './jid.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  FileAttachment,
  NewMessage,
  RegisteredGroup,
  SendMessageOpts,
} from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Multi-agent index maps
let groupsByJid: Map<string, RegisteredGroup[]> = new Map();
let groupsByFolder: Map<string, { jid: string; group: RegisteredGroup }> =
  new Map();
let groupsByBotUserId: Map<string, RegisteredGroup> = new Map();

const channels: Channel[] = [];
const queue = new GroupQueue();

// Track messages that got a "busy" reaction so we can remove it when processing starts
const pendingBusyReactions = new Map<
  string,
  Array<{ jid: string; messageTs: string }>
>();
const BUSY_EMOJI = 'hourglass_flowing_sand';

/**
 * Canonical cursor key for lastAgentTimestamp.
 * Thread messages: synthetic JID (matches how messages are stored in DB).
 * Root messages: base JID as-is.
 */
function getCursorKey(baseJid: string, threadTs?: string | null): string {
  return threadTs ? buildThreadJid(baseJid, threadTs) : baseJid;
}

// Per-thread toggle overrides (ephemeral — resets on restart)
const threadToggles = new Map<
  string,
  { verbose: boolean; thinking: boolean }
>();

function getToggleState(
  jid: string,
  threadTs?: string,
): { verbose: boolean; thinking: boolean } {
  // Synthetic JID already encodes the thread
  if (isSyntheticThreadJid(jid)) {
    const override = threadToggles.get(jid);
    if (override) return override;
  } else if (threadTs) {
    const key = `${jid}:${threadTs}`;
    const override = threadToggles.get(key);
    if (override) return override;
  }
  // Fall back to group defaults
  const group = resolveGroup(jid);
  return {
    verbose: group?.verboseDefault === true,
    thinking: group?.thinkingDefault === true,
  };
}

// Read bot token and filebrowser URL from .env for file downloads
let slackBotToken: string | undefined;
let filebrowserBaseUrl: string | undefined;

function loadEnvVars(): void {
  try {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'FILEBROWSER_BASE_URL']);
    slackBotToken = env.SLACK_BOT_TOKEN;
    filebrowserBaseUrl = env.FILEBROWSER_BASE_URL;
  } catch {
    // Non-fatal — file downloads and filebrowser links won't work
  }
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/**
 * Download Slack file attachments to the group's uploads directory.
 * Returns prompt annotations for the downloaded files.
 */
async function downloadFiles(
  files: FileAttachment[],
  groupFolder: string,
): Promise<string> {
  if (!slackBotToken || files.length === 0) return '';

  const uploadsDir = path.join(resolveGroupFolderPath(groupFolder), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const annotations: string[] = [];
  for (const file of files) {
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${timestamp}-${file.name}`;
    const filePath = path.join(uploadsDir, filename);

    try {
      const response = await fetch(file.url, {
        headers: { Authorization: `Bearer ${slackBotToken}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      const sizeKB = Math.round(file.size / 1024);
      const hint = file.mimetype.startsWith('image/')
        ? ' \u2014 use Read tool to view'
        : '';
      annotations.push(
        `- /workspace/group/uploads/${filename} (${file.mimetype}, ${sizeKB}KB)${hint}`,
      );
      logger.info(
        { file: filename, size: file.size },
        'Downloaded Slack file attachment',
      );
    } catch (err) {
      logger.warn({ file: file.name, err }, 'Failed to download Slack file');
      annotations.push(
        `- [File download failed: ${file.name} \u2014 ${err instanceof Error ? err.message : String(err)}]`,
      );
    }
  }

  return annotations.length > 0
    ? `\n[Files attached to this message]\n${annotations.join('\n')}\n`
    : '';
}

/**
 * Check if a message is a toggle/stop command.
 * Returns true if the message was consumed (should not be stored or forwarded).
 */
async function handleCommand(
  chatJid: string,
  msg: NewMessage,
  channel: Channel,
): Promise<boolean> {
  const text = msg.content.trim();
  const group = resolveGroup(chatJid);

  // /stop command — stops container for the thread where *stop was sent
  if (text === '*stop') {
    const stopped = await queue.stopGroup(chatJid, msg.threadTs);
    const displayOpts: SendMessageOpts = {
      displayName: group?.displayName,
      displayEmoji: group?.displayEmoji,
      displayIconUrl: group?.displayIconUrl,
      threadTs: msg.threadTs,
    };
    if (stopped) {
      await channel.sendMessage(
        chatJid,
        `Stopped ${group?.name || 'agent'}`,
        displayOpts,
      );
    } else {
      await channel.sendMessage(
        chatJid,
        'No active agent to stop',
        displayOpts,
      );
    }
    return true;
  }

  // /verbose and /thinking toggle commands
  const verboseMatch = text.match(/^\*verbose(?:\s+(on|off))?$/);
  const thinkingMatch = text.match(/^\*thinking(?:\s+(on|off))?$/);

  if (verboseMatch || thinkingMatch) {
    const isVerbose = !!verboseMatch;
    const mode = isVerbose ? 'verbose' : 'thinking';
    const arg = (verboseMatch || thinkingMatch)![1]; // 'on', 'off', or undefined (toggle)

    const inThread = !!msg.threadTs;
    const toggleKey = inThread ? `${chatJid}:${msg.threadTs}` : null;

    let newValue: boolean;

    if (inThread && toggleKey) {
      // Per-thread override
      const current =
        threadToggles.get(toggleKey) || getToggleState(chatJid, msg.threadTs);
      if (arg === 'on') newValue = true;
      else if (arg === 'off') newValue = false;
      else newValue = isVerbose ? !current.verbose : !current.thinking;

      const updated = { ...current };
      if (isVerbose) updated.verbose = newValue;
      else updated.thinking = newValue;
      threadToggles.set(toggleKey, updated);
    } else {
      // Global default toggle
      if (!group) return false;
      const currentDefault = isVerbose
        ? group.verboseDefault === true
        : group.thinkingDefault === true;
      if (arg === 'on') newValue = true;
      else if (arg === 'off') newValue = false;
      else newValue = !currentDefault;

      if (isVerbose) group.verboseDefault = newValue;
      else group.thinkingDefault = newValue;
      // Persist to DB
      setRegisteredGroup(chatJid, group);
    }

    const scope = inThread
      ? 'this thread'
      : `${group?.name || 'group'} (default)`;
    const stateStr = newValue ? 'ON' : 'OFF';
    await channel.sendMessage(
      chatJid,
      `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode: ${stateStr} for ${scope}`,
      {
        displayName: group?.displayName,
        displayEmoji: group?.displayEmoji,
        threadTs: msg.threadTs,
      },
    );
    return true;
  }

  // *rewind command — trigger rewind flow via channel
  if (text === '*rewind') {
    if (!msg.threadTs) {
      await channel.sendMessage(
        chatJid,
        'Rewind works in threads \u2014 start a conversation first.',
        {
          displayName: group?.displayName,
          displayEmoji: group?.displayEmoji,
        },
      );
      return true;
    }

    const uuids = getThreadResponseUuids(group?.folder || '', msg.threadTs);
    if (uuids.length === 0) {
      await channel.sendMessage(
        chatJid,
        'No rewind points available \u2014 this thread predates rewind tracking.',
        {
          displayName: group?.displayName,
          displayEmoji: group?.displayEmoji,
          threadTs: msg.threadTs,
        },
      );
      return true;
    }

    // Post ephemeral with button — the channel handles this
    if (channel.postRewindButton) {
      await channel.postRewindButton(
        chatJid,
        msg.sender,
        msg.threadTs,
        group?.folder || '',
      );
    }
    return true;
  }

  // /who command — list agents in the current channel
  if (text === '*who') {
    const channelJid = getParentJid(chatJid) || chatJid;
    const channelGroups = groupsByJid.get(channelJid);
    const displayOpts: SendMessageOpts = {
      displayName: group?.displayName,
      displayEmoji: group?.displayEmoji,
      displayIconUrl: group?.displayIconUrl,
      threadTs: msg.threadTs,
    };
    if (!channelGroups || channelGroups.length <= 1) {
      const name =
        group?.assistantName || group?.displayName || group?.name || 'Unknown';
      await channel.sendMessage(
        chatJid,
        `Agents in this channel:\n  ${name} (director)`,
        displayOpts,
      );
    } else {
      const lines = channelGroups.map((g) => {
        const name = g.assistantName || g.displayName || g.name;
        const role = g.channelRole || 'director';
        return `  ${name} (${role})`;
      });
      await channel.sendMessage(
        chatJid,
        `Agents in this channel:\n${lines.join('\n')}`,
        displayOpts,
      );
    }
    return true;
  }

  return false;
}

/**
 * Find the main group (isMain=true) from registered groups.
 * DM messages are processed under the main group's config.
 */
function getMainGroup(): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.isMain) return { jid, group };
  }
  return null;
}

/**
 * Resolve a group from a JID, handling synthetic thread JIDs and group-qualified JIDs.
 * Tries group folder from :g: suffix, then direct lookup, then parent channel JID, then main group fallback.
 */
function resolveGroup(chatJid: string): RegisteredGroup | null {
  // Group-qualified JID: extract folder directly
  const gf = getGroupFolder(chatJid);
  if (gf) {
    const entry = groupsByFolder.get(gf);
    return entry?.group ?? null;
  }
  let group = registeredGroups[chatJid];
  if (group) return group;
  const parentJid = getParentJid(chatJid);
  if (parentJid) group = registeredGroups[parentJid];
  if (group) return group;
  const main = getMainGroup();
  return main?.group ?? null;
}

/**
 * Rebuild the multi-agent index maps from the database.
 * Called on startup and after group registration changes.
 */
function rebuildGroupIndexes(): void {
  groupsByJid.clear();
  groupsByFolder.clear();
  groupsByBotUserId.clear();
  const allGroups = getAllRegisteredGroupsMulti();
  for (const [jid, groups] of allGroups) {
    groupsByJid.set(jid, groups);
    for (const g of groups) {
      // Only store primary registration per folder — first one wins (directors before members)
      if (!groupsByFolder.has(g.folder)) {
        groupsByFolder.set(g.folder, { jid, group: g });
      }
      if (g.botUserId) {
        groupsByBotUserId.set(g.botUserId, g);
      }
    }
    // registeredGroups: pick director, fallback to first
    const director =
      groups.find((g) => g.channelRole === 'director') || groups[0];
    registeredGroups[jid] = director;
  }
}

// --- Multi-agent @mention dispatch ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse @mentions from message text.
 * For directors with own Slack apps: check for native <@U_BOT_ID> mentions.
 * For technicians/fallback: check for text-based @Name mentions.
 */
function parseMentions(
  content: string,
  channelGroups: RegisteredGroup[],
): string[] {
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
function resolveSenderFolder(msg: NewMessage): string | null {
  // Check sender against known agent bot user IDs
  if (msg.sender) {
    const group = groupsByBotUserId.get(msg.sender);
    if (group) return group.folder;
  }
  // Fallback: match sender_name against known agents
  if (msg.sender_name) {
    for (const [folder, entry] of groupsByFolder) {
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
function resolveTargetGroups(
  channelJid: string,
  threadTs: string | undefined,
  msg: NewMessage,
): RegisteredGroup[] {
  const channelGroups = groupsByJid.get(channelJid);

  // Single-group channel: existing behavior (always that group)
  if (!channelGroups || channelGroups.length <= 1) {
    const group = resolveGroup(channelJid);
    return group ? [group] : [];
  }

  // Multi-group channel: dispatch based on mentions and membership
  const targets: RegisteredGroup[] = [];
  const isBotMsg = msg.is_bot_message === true;

  // Parse @mentions from message text
  const mentionedFolders = parseMentions(msg.content, channelGroups);

  // Determine sender's folder (for bot messages, to prevent self-triggering)
  const senderFolder = isBotMsg ? resolveSenderFolder(msg) : null;

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

/**
 * Check if a JID is a multi-group channel (more than 1 group registered).
 */
function isMultiGroupChannel(channelJid: string): boolean {
  const groups = groupsByJid.get(channelJid);
  return !!groups && groups.length > 1;
}

/**
 * Dispatch a human message to target groups in a multi-group channel.
 */
function dispatchMessage(chatJid: string, msg: NewMessage): void {
  const channelJid = getParentJid(chatJid) || chatJid;
  const { threadTs } = parseSlackJid(chatJid);

  if (!isMultiGroupChannel(channelJid)) {
    // Single-group: route using base channel JID + threadTs for consistent queue keying
    if (isSyntheticThreadJid(chatJid)) {
      const formatted = formatMessages([msg], TIMEZONE);
      if (!queue.sendMessage(channelJid, threadTs, formatted)) {
        queue.enqueueMessageCheck(channelJid, threadTs);
      } else {
        lastAgentTimestamp[getCursorKey(channelJid, threadTs)] = msg.timestamp;
        saveState();
      }
    }
    return;
  }

  // Multi-group channel: dispatch to target groups
  const targets = resolveTargetGroups(
    channelJid,
    threadTs || msg.threadTs,
    msg,
  );
  for (const group of targets) {
    const baseJid = threadTs
      ? buildThreadJid(`slack:${parseSlackJid(channelJid).channelId}`, threadTs)
      : channelJid;
    const groupJid = buildGroupJid(baseJid, group.folder);
    const formatted = formatMessages([msg], TIMEZONE, true);
    if (!queue.sendMessage(groupJid, threadTs || msg.threadTs, formatted)) {
      queue.enqueueMessageCheck(groupJid, threadTs || msg.threadTs);
    } else {
      lastAgentTimestamp[getCursorKey(groupJid, threadTs || msg.threadTs)] =
        msg.timestamp;
      saveState();
    }
  }
}

/**
 * Dispatch a bot message that contains @mentions to target agents.
 */
function dispatchBotMessage(chatJid: string, msg: NewMessage): void {
  const channelJid = getParentJid(chatJid) || chatJid;
  const { threadTs } = parseSlackJid(chatJid);

  if (!isMultiGroupChannel(channelJid)) return;

  const targets = resolveTargetGroups(
    channelJid,
    threadTs || msg.threadTs,
    msg,
  );
  if (targets.length === 0) return;

  for (const group of targets) {
    const baseJid = threadTs
      ? buildThreadJid(`slack:${parseSlackJid(channelJid).channelId}`, threadTs)
      : channelJid;
    const groupJid = buildGroupJid(baseJid, group.folder);
    queue.enqueueMessageCheck(groupJid, threadTs || msg.threadTs);
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  rebuildGroupIndexes();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
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

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  rebuildGroupIndexes();

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
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  threadTs?: string,
): Promise<boolean> {
  // Handle group-qualified JIDs from multi-agent dispatch
  const groupFolder = getGroupFolder(chatJid);
  const baseJid = getBaseJid(chatJid);

  let group: RegisteredGroup | null;
  if (groupFolder) {
    // Prefer channel-specific registration (has correct settings for this channel)
    const channelJid = getParentJid(baseJid) || baseJid;
    const channelGroups = groupsByJid.get(channelJid);
    const match = channelGroups?.find((g) => g.folder === groupFolder);
    group = match ?? groupsByFolder.get(groupFolder)?.group ?? null;
  } else {
    group = resolveGroup(chatJid);
  }
  if (!group) return true;

  // Remove any "busy" reactions now that we're processing this group's messages
  const busyKey = `${chatJid}::${threadTs || '__root__'}`;
  const busyReactions = pendingBusyReactions.get(busyKey);
  if (busyReactions?.length) {
    const channel_ = findChannel(channels, baseJid);
    for (const { jid, messageTs } of busyReactions) {
      channel_
        ?.removeReaction?.(jid, messageTs, BUSY_EMOJI)
        ?.catch((err) =>
          logger.debug({ chatJid, err }, 'Failed to remove busy reaction'),
        );
    }
    pendingBusyReactions.delete(busyKey);
  }

  const channel = findChannel(channels, baseJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Thread messages are stored under synthetic JIDs (e.g., slack:C123:t:171110...).
  // Use the synthetic JID for retrieval when processing a specific thread.
  const fetchJid = threadTs ? buildThreadJid(baseJid, threadTs) : baseJid;
  const cursorKey = getCursorKey(baseJid, threadTs);
  const sinceTimestamp =
    lastAgentTimestamp[cursorKey] || lastAgentTimestamp[baseJid] || '';
  // Multi-group dispatch: include bot messages so agent sees full cross-agent conversation
  const missedMessages = groupFolder
    ? getMessagesSinceIncludingBots(fetchJid, sinceTimestamp)
    : getMessagesSince(fetchJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Group messages by thread for thread-aware session routing
  const messagesByThread = new Map<string | undefined, NewMessage[]>();
  for (const msg of missedMessages) {
    const tts = msg.threadTs; // undefined = channel root
    const bucket = messagesByThread.get(tts);
    if (bucket) bucket.push(msg);
    else messagesByThread.set(tts, [msg]);
  }

  // Default to threading: reply in existing thread, or start a new thread on the triggering message
  const lastMsg = missedMessages[missedMessages.length - 1];
  const lastThreadTs = lastMsg.threadTs || lastMsg.id;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Download file attachments from messages
  const allFiles = missedMessages.flatMap((m) => m.files || []);
  const fileAnnotation = await downloadFiles(allFiles, group.folder);

  // Include thread parent message for context when replying in a thread
  let threadParentContext = '';
  if (lastThreadTs && missedMessages.some((m) => m.threadTs)) {
    const parentMsg = getMessageById(
      getParentJid(chatJid) || chatJid,
      lastThreadTs,
    );
    if (parentMsg) {
      threadParentContext = `<thread-parent>
${formatMessages([parentMsg], TIMEZONE)}
</thread-parent>
`;
    }
  }

  const prompt =
    threadParentContext +
    formatMessages(missedMessages, TIMEZONE, !!groupFolder) +
    fileAnnotation;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[cursorKey] || '';
  lastAgentTimestamp[cursorKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      folder: group.folder,
      messageCount: missedMessages.length,
    },
    'Processing messages',
  );

  // For multi-group channels: ensure this agent is a thread member so follow-ups route correctly
  if (groupFolder && lastThreadTs) {
    const channelJid = getParentJid(baseJid) || baseJid;
    addThreadMember(channelJid, lastThreadTs, groupFolder);
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid, lastThreadTs);
    }, IDLE_TIMEOUT);
  };

  // Suppress typing for thread members who aren't explicitly mentioned in the triggering message
  const triggeringMsg = missedMessages[missedMessages.length - 1];
  const isMentioned =
    !groupFolder ||
    !triggeringMsg ||
    (group.botUserId &&
      triggeringMsg.content.includes(`<@${group.botUserId}>`)) ||
    (group.assistantName &&
      new RegExp(`(?:^|\\s)@${escapeRegex(group.assistantName)}\\b`, 'i').test(
        triggeringMsg.content,
      ));
  // Use synthetic thread JID for typing indicator so it matches latestMessageContext
  const typingJid = groupFolder ? baseJid : threadTs ? fetchJid : chatJid;
  if (isMentioned) {
    await channel.setTyping?.(typingJid, true, group.botToken);
  }
  let hadError = false;
  let outputSentToUser = false;

  // Get toggle state for this thread
  const toggleState = getToggleState(chatJid, lastThreadTs);

  // Thread routing is now handled by composite queue keys — no need to set active thread

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result

      // Route verbose/thinking output to dedicated methods
      if (result.type === 'verbose' && result.result) {
        channel
          .sendVerboseMessage?.(chatJid, result.result, 'verbose', {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            botToken: group.botToken,
            threadTs: lastThreadTs,
          })
          ?.catch((err) => logger.warn({ err }, 'Verbose message failed'));
        return;
      }
      if (result.type === 'thinking' && result.result) {
        channel
          .sendVerboseMessage?.(chatJid, result.result, 'thinking', {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            botToken: group.botToken,
            threadTs: lastThreadTs,
          })
          ?.catch((err) => logger.warn({ err }, 'Thinking message failed'));
        return;
      }

      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        let text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        // Agent can wrap output in <channel>...</channel> to post top-level instead of threading
        const hasChannelTags = /<channel>/.test(text);
        const useThreadTs = hasChannelTags ? undefined : lastThreadTs;
        if (hasChannelTags) text = text.replace(/<\/?channel>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text, {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            displayIconUrl: group.displayIconUrl,
            botToken: group.botToken,
            threadTs: useThreadTs,
            onPosted: (postedSlackTs: string) => {
              if (result.lastAssistantUuid && lastThreadTs) {
                storeResponseUuid(
                  group.folder,
                  lastThreadTs,
                  postedSlackTs,
                  result.lastAssistantUuid,
                );
              }
            },
          });
          outputSentToUser = true;
          // Clear typing indicator after sending output (don't wait for container exit)
          channel
            .setTyping?.(typingJid, false, group.botToken)
            ?.catch(() => {});
        }

        // Context window display (when verbose mode is enabled and agent actually responded)
        if (
          outputSentToUser &&
          result.contextUsage &&
          result.contextUsage.contextWindow > 0 &&
          getToggleState(chatJid, lastThreadTs).verbose
        ) {
          const cu = result.contextUsage;
          const totalUsed =
            cu.inputTokens + cu.cacheCreationTokens + cu.cacheReadTokens;
          const pct = Math.round((totalUsed / cu.contextWindow) * 100);
          const modelSuffix = result.model ? ` \u2014 ${result.model}` : '';
          const contextLine = `_Context: ${formatTokens(totalUsed)}/${formatTokens(cu.contextWindow)} (${pct}%)${modelSuffix}_`;
          await channel.sendMessage(chatJid, contextLine, {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            displayIconUrl: group.displayIconUrl,
            botToken: group.botToken,
            threadTs: useThreadTs,
          });
        }

        // Compaction notification (only when agent actually responded)
        if (outputSentToUser && result.compaction) {
          let compactLine: string;
          if (result.contextUsage && result.contextUsage.contextWindow > 0) {
            const postTokens =
              result.contextUsage.inputTokens +
              result.contextUsage.cacheCreationTokens +
              result.contextUsage.cacheReadTokens;
            const cw = result.contextUsage.contextWindow;
            const pct = Math.round((postTokens / cw) * 100);
            compactLine = `_Compacted: ${formatTokens(result.compaction.preTokens)} \u2192 ${formatTokens(postTokens)}/${formatTokens(cw)} (${pct}%)_`;
          } else {
            compactLine = `_Compacted from ${formatTokens(result.compaction.preTokens)} tokens_`;
          }
          await channel.sendMessage(chatJid, compactLine, {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            displayIconUrl: group.displayIconUrl,
            botToken: group.botToken,
            threadTs: useThreadTs,
          });
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid, lastThreadTs);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    toggleState,
    lastThreadTs !== lastMsg.id ? lastThreadTs : undefined,
  );

  if (isMentioned) await channel.setTyping?.(typingJid, false, group.botToken);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[cursorKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  toggleState?: { verbose: boolean; thinking: boolean },
  threadTs?: string,
  rewindOpts?: { sourceSessionId: string; resumeSessionAt: string },
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Thread-aware session routing
  const threadSessionId = threadTs
    ? getThreadSession(group.folder, threadTs)
    : undefined;
  const isNewThread = !!threadTs && !threadSessionId;
  const parentSessionId = sessions[group.folder];
  // For rewind: use the source session with fork, not the current thread session
  const sessionId = rewindOpts
    ? rewindOpts.sourceSessionId
    : threadSessionId || parentSessionId;
  const shouldFork = rewindOpts ? true : isNewThread;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write recent activity snapshot for heartbeat awareness
  const lookbackMinutes = 30;
  const sinceTimestamp = new Date(
    Date.now() - lookbackMinutes * 60 * 1000,
  ).toISOString();
  const agentJids = getJidsForFolder(group.folder);
  const activityChannels = agentJids.map(({ jid, name, channelRole }) => {
    const msgs = getMessagesSinceIncludingBots(jid, sinceTimestamp, 50);
    return {
      jid,
      name,
      role: channelRole,
      messages: msgs.map((m) => ({
        sender_name: m.sender_name || 'Unknown',
        content:
          m.content && m.content.length > 200
            ? m.content.slice(0, 200) + '...'
            : m.content || '',
        timestamp: m.timestamp,
        is_bot: !!m.is_bot_message,
        thread_ts: m.threadTs || null,
      })),
    };
  });
  const activeGroups = queue
    .getActiveGroups()
    .filter((g) => g.groupFolder !== group.folder);
  const activeContainers = activeGroups.map((g) => {
    const gInfo = getGroupByFolder(g.groupFolder);
    return {
      group_folder: g.groupFolder,
      agent_name: gInfo?.assistantName || gInfo?.name || g.groupFolder,
    };
  });
  writeRecentActivitySnapshot(
    group.folder,
    activityChannels,
    activeContainers,
    lookbackMinutes,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (threadTs && (isNewThread || rewindOpts)) {
            // New thread fork or rewind — store thread session
            setThreadSession(
              group.folder,
              threadTs,
              output.newSessionId,
              rewindOpts?.sourceSessionId || parentSessionId,
            );
          } else if (!threadTs) {
            // Channel root — update as before
            sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
          }
        }
        await onOutput(output);
      }
    : undefined;

  // Use toggle state passed from caller (with thread context), fall back to group default
  const effectiveToggle = toggleState || getToggleState(chatJid);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: group.assistantName || ASSISTANT_NAME,
        verbose: effectiveToggle.verbose,
        thinking: effectiveToggle.thinking,
        maxThinkingTokens: effectiveToggle.thinking ? 10000 : undefined,
        filebrowserBaseUrl: filebrowserBaseUrl || undefined,
        threadTs,
        forkFromSession: shouldFork,
        resumeSessionAt: rewindOpts?.resumeSessionAt,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          threadTs,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (threadTs && (isNewThread || rewindOpts)) {
        setThreadSession(
          group.folder,
          threadTs,
          output.newSessionId,
          rewindOpts?.sourceSessionId || parentSessionId,
        );
      } else if (!threadTs) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function rewindSession(params: {
  groupFolder: string;
  chatJid: string;
  sourceThreadTs: string;
  newThreadTs: string;
  sdkUuid: string;
}): Promise<void> {
  const { groupFolder, chatJid, sourceThreadTs, newThreadTs, sdkUuid } = params;

  // Get source session (thread session or channel root)
  const sourceSessionId =
    getThreadSession(groupFolder, sourceThreadTs) || sessions[groupFolder];
  if (!sourceSessionId) {
    logger.error(
      { groupFolder, sourceThreadTs },
      'No source session found for rewind',
    );
    return;
  }

  const group = Object.values(registeredGroups).find(
    (g) => g.folder === groupFolder,
  );
  if (!group) {
    logger.error({ groupFolder }, 'No group found for rewind');
    return;
  }

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.error({ chatJid }, 'No channel found for rewind');
    return;
  }

  try {
    logger.info(
      { groupFolder, sourceThreadTs, newThreadTs, sdkUuid },
      'Starting rewind',
    );

    // Use synthetic JID for the new thread so follow-up messages route correctly
    const syntheticJid = buildThreadJid(chatJid, newThreadTs);

    // Run agent with fork parameters — the container will fork the session
    const result = await runAgent(
      group,
      '[Session forked from previous thread. Continue from where we left off.]',
      syntheticJid,
      async (output) => {
        if (output.result) {
          const text = output.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            await channel.sendMessage(syntheticJid, text, {
              displayName: group.displayName,
              displayEmoji: group.displayEmoji,
              displayIconUrl: group.displayIconUrl,
              botToken: group.botToken,
              threadTs: newThreadTs,
            });
          }
        }
      },
      getToggleState(syntheticJid, newThreadTs),
      newThreadTs,
      { sourceSessionId, resumeSessionAt: sdkUuid },
    );

    logger.info({ groupFolder, newThreadTs, result }, 'Rewind completed');
  } catch (err) {
    logger.error(
      { err, groupFolder, sourceThreadTs },
      'Failed to rewind session',
    );
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      // Include DM JIDs so getNewMessages picks up direct messages
      const registeredJids = Object.keys(registeredGroups);
      const allChats = getAllChats();
      const dmJids = allChats
        .filter(
          (c) =>
            !c.is_group &&
            c.jid !== '__group_sync__' &&
            !registeredGroups[c.jid] &&
            !isSyntheticThreadJid(c.jid) &&
            !getGroupFolder(c.jid),
        )
        .map((c) => c.jid);
      const jids = [...registeredJids, ...dmJids];
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          // Multi-group channel: dispatch via resolveTargetGroups
          if (isMultiGroupChannel(chatJid)) {
            const lastGroupMsg = groupMessages[groupMessages.length - 1];
            const targets = resolveTargetGroups(
              chatJid,
              lastGroupMsg.threadTs,
              lastGroupMsg,
            );
            for (const target of targets) {
              const groupJid = buildGroupJid(chatJid, target.folder);
              queue.enqueueMessageCheck(groupJid);
            }
            continue;
          }

          let group = registeredGroups[chatJid];
          const isDm = !group;

          if (!group) {
            const main = getMainGroup();
            if (!main) continue;
            group = main.group;
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[getCursorKey(chatJid)] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Download file attachments before formatting (needed for both IPC and new container paths)
          const pipeFiles = messagesToSend.flatMap((m) => m.files || []);
          const pipeFileAnnotation = await downloadFiles(
            pipeFiles,
            group.folder,
          );
          const formatted =
            formatMessages(messagesToSend, TIMEZONE) + pipeFileAnnotation;

          // Per-thread parallel dispatch: try to pipe to existing container for this thread,
          // otherwise enqueue independently. No more thread-mismatch container killing.
          const msgThread =
            messagesToSend[messagesToSend.length - 1].threadTs || null;

          // Try to pipe to an existing container for this specific thread (or root)
          if (!isDm && queue.sendMessage(chatJid, msgThread, formatted)) {
            logger.debug(
              {
                chatJid,
                threadTs: msgThread || '__root__',
                count: messagesToSend.length,
              },
              'Piped messages to active thread container',
            );
            lastAgentTimestamp[getCursorKey(chatJid, msgThread)] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator — use synthetic thread JID for thread context lookup
            const typingPipeJid = msgThread
              ? buildThreadJid(getBaseJid(chatJid), msgThread)
              : chatJid;
            channel
              .setTyping?.(typingPipeJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container for this thread — enqueue for a new one.
            // With parallel threads, this doesn't kill sibling thread containers.

            // If the message will be queued (concurrency limit or same-thread active),
            // add a "busy" reaction so the user knows the agent received it
            if (queue.wouldQueue(chatJid, msgThread)) {
              const lastMsg = messagesToSend[messagesToSend.length - 1];
              const baseJidForReaction = getBaseJid(chatJid);
              channel
                .addReaction?.(baseJidForReaction, lastMsg.id, BUSY_EMOJI)
                ?.catch((err) =>
                  logger.debug({ chatJid, err }, 'Failed to add busy reaction'),
                );
              // Track for removal when processing starts (keyed by composite for thread isolation)
              const busyReactionKey = `${chatJid}::${msgThread || '__root__'}`;
              const existing = pendingBusyReactions.get(busyReactionKey) || [];
              existing.push({
                jid: baseJidForReaction,
                messageTs: lastMsg.id,
              });
              pendingBusyReactions.set(busyReactionKey, existing);
            }

            queue.enqueueMessageCheck(chatJid, msgThread);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Multi-group channels: dispatch via resolveTargetGroups to avoid
    // routing all pending messages to just the director/first group
    if (isMultiGroupChannel(chatJid)) {
      const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        const lastMsg = pending[pending.length - 1];
        const targets = resolveTargetGroups(chatJid, lastMsg.threadTs, lastMsg);
        for (const target of targets) {
          const groupJid = buildGroupJid(chatJid, target.folder);
          logger.info(
            {
              group: target.name,
              folder: target.folder,
              pendingCount: pending.length,
            },
            'Recovery: found unprocessed multi-group messages',
          );
          queue.enqueueMessageCheck(groupJid);
        }
      }
      continue;
    }

    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

  // Recover DMs and synthetic thread JIDs: check lastAgentTimestamp entries that are not registered groups
  const mainGroup = getMainGroup();
  if (mainGroup) {
    for (const [chatJid, cursor] of Object.entries(lastAgentTimestamp)) {
      if (registeredGroups[chatJid]) continue;
      // Skip group-qualified JIDs — they're handled by the multi-group recovery above
      if (getGroupFolder(chatJid)) continue;
      const pending = getMessagesSince(chatJid, cursor, ASSISTANT_NAME);
      if (pending.length > 0) {
        const label = isSyntheticThreadJid(chatJid) ? 'thread' : 'DM';
        logger.info(
          { chatJid, pendingCount: pending.length },
          `Recovery: found unprocessed ${label} messages`,
        );
        // Use consistent keying: base JID + threadTs (not synthetic JID)
        if (isSyntheticThreadJid(chatJid)) {
          const { threadTs: recoveryThreadTs } = parseSlackJid(chatJid);
          const baseRecoveryJid = getParentJid(chatJid) || chatJid;
          queue.enqueueMessageCheck(baseRecoveryJid, recoveryThreadTs);
        } else {
          queue.enqueueMessageCheck(chatJid);
        }
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  loadEnvVars();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && resolveGroup(chatJid)) {
        const cfg = loadSenderAllowlist();
        const allowlistJid = getParentJid(chatJid) || chatJid;
        if (
          shouldDropMessage(allowlistJid, cfg) &&
          !isSenderAllowed(allowlistJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Intercept toggle/stop commands before storing
      if (!msg.is_from_me && !msg.is_bot_message) {
        const channel = findChannel(channels, chatJid);
        if (channel) {
          handleCommand(chatJid, msg, channel)
            .then((consumed) => {
              if (!consumed) {
                storeMessage(msg);
                // Multi-group dispatch for human messages
                const channelJid = getParentJid(chatJid) || chatJid;
                if (
                  isMultiGroupChannel(channelJid) &&
                  isSyntheticThreadJid(chatJid)
                ) {
                  // Thread messages in multi-group channels: dispatch from realtime path
                  // (polling loop won't see them since they're stored under synthetic JID)
                  dispatchMessage(chatJid, msg);
                } else if (
                  !isMultiGroupChannel(channelJid) &&
                  isSyntheticThreadJid(chatJid)
                ) {
                  // Single-group: IPC pipe with thread-aware routing (use base JID for consistent queue keys)
                  const formatted = formatMessages([msg], TIMEZONE);
                  const { threadTs: evtThreadTs } = parseSlackJid(chatJid);
                  if (!queue.sendMessage(channelJid, evtThreadTs, formatted)) {
                    queue.enqueueMessageCheck(channelJid, evtThreadTs);
                  } else {
                    lastAgentTimestamp[getCursorKey(channelJid, evtThreadTs)] =
                      msg.timestamp;
                    saveState();
                  }
                }
              }
            })
            .catch((err) => {
              logger.warn(
                { chatJid, err },
                'Command handler error, storing message',
              );
              storeMessage(msg);
            });
          return;
        }
      }

      // Bot message: store and check for @mentions to trigger cross-agent communication
      if (msg.is_bot_message && !msg.is_from_me) {
        storeMessage(msg);
        // Only dispatch bot messages from realtime path for threads (channel-root
        // messages are handled by the polling loop to avoid double-dispatch)
        if (isSyntheticThreadJid(chatJid)) {
          dispatchBotMessage(chatJid, msg);
        }
        return;
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    resolveBotSenderName: (
      botId: string,
      username?: string,
      userId?: string,
    ): string | undefined => {
      // Look up bot user ID (U-prefix) against known agent bot user IDs
      if (userId) {
        const group = groupsByBotUserId.get(userId);
        if (group) return group.assistantName || group.displayName;
      }
      // Try bot_id (B-prefix) — less reliable but covers edge cases
      if (botId) {
        const group = groupsByBotUserId.get(botId);
        if (group) return group.assistantName || group.displayName;
      }
      // Fallback: try username (for technicians sharing an app)
      if (username) {
        for (const [, entry] of groupsByFolder) {
          const name = entry.group.assistantName || entry.group.displayName;
          if (name && name.toLowerCase() === username.toLowerCase())
            return name;
        }
      }
      return undefined;
    },
    onRewind: rewindSession,
    onSlashCommand: async (params: {
      command: string;
      text: string;
      channelId: string;
      userId: string;
      threadTs?: string;
      triggerId: string;
    }): Promise<string | null> => {
      const channelJid = `slack:${params.channelId}`;
      const group = resolveGroup(channelJid);

      switch (params.command) {
        case 'stop': {
          const stopped = await queue.stopGroup(channelJid, params.threadTs);
          return stopped
            ? `Stopped ${group?.name || 'agent'}`
            : 'No active agent to stop';
        }

        case 'verbose':
        case 'thinking': {
          const isVerbose = params.command === 'verbose';
          const arg = params.text.trim().toLowerCase();
          const inThread = !!params.threadTs;
          const toggleKey = inThread
            ? `${channelJid}:${params.threadTs}`
            : null;

          let newValue: boolean;
          if (inThread && toggleKey) {
            const current =
              threadToggles.get(toggleKey) ||
              getToggleState(channelJid, params.threadTs);
            if (arg === 'on') newValue = true;
            else if (arg === 'off') newValue = false;
            else newValue = isVerbose ? !current.verbose : !current.thinking;
            const updated = { ...current };
            if (isVerbose) updated.verbose = newValue;
            else updated.thinking = newValue;
            threadToggles.set(toggleKey, updated);
          } else {
            if (!group) return 'No group found for this channel';
            const currentDefault = isVerbose
              ? group.verboseDefault === true
              : group.thinkingDefault === true;
            if (arg === 'on') newValue = true;
            else if (arg === 'off') newValue = false;
            else newValue = !currentDefault;
            if (isVerbose) group.verboseDefault = newValue;
            else group.thinkingDefault = newValue;
            setRegisteredGroup(channelJid, group);
          }

          const scope = inThread
            ? 'this thread'
            : `${group?.name || 'group'} (default)`;
          const mode = params.command;
          return `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode: ${newValue ? 'ON' : 'OFF'} for ${scope}`;
        }

        case 'rewind': {
          if (!params.threadTs) {
            return 'Rewind works in threads — start a conversation first.';
          }
          const channel = findChannel(channels, channelJid);
          if (channel?.postRewindButton) {
            await channel.postRewindButton(
              channelJid,
              params.userId,
              params.threadTs,
              group?.folder || '',
            );
          }
          return null; // rewind button handles the response
        }

        case 'agents': {
          const chJid = channelJid;
          const channelGroups = groupsByJid.get(chJid);
          if (!channelGroups || channelGroups.length <= 1) {
            const name =
              group?.assistantName ||
              group?.displayName ||
              group?.name ||
              'Unknown';
            return `Agents in this channel:\n  ${name} (director)`;
          }
          const lines = channelGroups.map((g) => {
            const name = g.assistantName || g.displayName || g.name;
            const role = g.channelRole || 'director';
            return `  ${name} (${role})`;
          });
          return `Agents in this channel:\n${lines.join('\n')}`;
        }

        default:
          return `Unknown command: ${params.command}`;
      }
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, null, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    isGroupInChannel: (chatJid: string, groupFolder: string): boolean => {
      const channelJid = getParentJid(chatJid) || chatJid;
      const groups = groupsByJid.get(channelJid);
      return !!groups?.some((g) => g.folder === groupFolder);
    },
    addReaction: async (jid: string, messageTs: string, emoji: string) => {
      const channel = findChannel(channels, jid);
      if (channel?.addReaction) {
        await channel.addReaction(jid, messageTs, emoji);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Daily cleanup of old thread membership data (every 24 hours)
  setInterval(
    () => {
      try {
        cleanupOldThreadData(30);
      } catch (err) {
        logger.warn({ err }, 'Thread data cleanup error');
      }
    },
    24 * 60 * 60 * 1000,
  );
  // Run once at startup
  cleanupOldThreadData(30);

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
