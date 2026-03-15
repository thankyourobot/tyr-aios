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
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';
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

const channels: Channel[] = [];
const queue = new GroupQueue();

// Per-thread toggle overrides (ephemeral — resets on restart)
const threadToggles = new Map<string, { verbose: boolean; thinking: boolean }>();

function getToggleState(
  jid: string,
  threadTs?: string,
): { verbose: boolean; thinking: boolean } {
  // Check per-thread override first
  if (threadTs) {
    const key = `${jid}:${threadTs}`;
    const override = threadToggles.get(key);
    if (override) return override;
  }
  // Fall back to group defaults
  const group = registeredGroups[jid];
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
      const hint = file.mimetype.startsWith('image/') ? ' \u2014 use Read tool to view' : '';
      annotations.push(
        `- /workspace/group/uploads/${filename} (${file.mimetype}, ${sizeKB}KB)${hint}`,
      );
      logger.info({ file: filename, size: file.size }, 'Downloaded Slack file attachment');
    } catch (err) {
      logger.warn({ file: file.name, err }, 'Failed to download Slack file');
      annotations.push(`- [File download failed: ${file.name} \u2014 ${err instanceof Error ? err.message : String(err)}]`);
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
  const group = registeredGroups[chatJid];

  // /stop command
  if (text === '*stop') {
    const stopped = await queue.stopGroup(chatJid);
    const displayOpts: SendMessageOpts = {
      displayName: group?.displayName,
      displayEmoji: group?.displayEmoji,
      threadTs: msg.threadTs,
    };
    if (stopped) {
      await channel.sendMessage(chatJid, `Stopped ${group?.name || 'agent'}`, displayOpts);
    } else {
      await channel.sendMessage(chatJid, 'No active agent to stop', displayOpts);
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
      const current = threadToggles.get(toggleKey) || getToggleState(chatJid, msg.threadTs);
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

    const scope = inThread ? 'this thread' : `${group?.name || 'group'} (default)`;
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
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) {
    // DM or unknown JID — route through main group's config
    const main = getMainGroup();
    if (!main) return true;
    group = main.group;
  }

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

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

  const prompt = formatMessages(missedMessages, TIMEZONE) + fileAnnotation;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Get toggle state for this thread
  const toggleState = getToggleState(chatJid, lastThreadTs);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result

    // Route verbose/thinking output to dedicated methods
    if (result.type === 'verbose' && result.result) {
      await channel.sendVerboseMessage?.(chatJid, result.result, 'verbose', {
        displayName: group.displayName,
        displayEmoji: group.displayEmoji,
        threadTs: lastThreadTs,
      });
      return;
    }
    if (result.type === 'thinking' && result.result) {
      await channel.sendVerboseMessage?.(chatJid, result.result, 'thinking', {
        displayName: group.displayName,
        displayEmoji: group.displayEmoji,
        threadTs: lastThreadTs,
      });
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
      const channelMatch = text.match(/^<channel>([\s\S]*)<\/channel>$/);
      const useThreadTs = channelMatch ? undefined : lastThreadTs;
      if (channelMatch) text = channelMatch[1].trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text, {
          displayName: group.displayName,
          displayEmoji: group.displayEmoji,
          threadTs: useThreadTs,
        });
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, toggleState);

  await channel.setTyping?.(chatJid, false);
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
    lastAgentTimestamp[chatJid] = previousCursor;
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
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

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

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
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
            !registeredGroups[c.jid],
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
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Download file attachments before formatting (needed for both IPC and new container paths)
          const pipeFiles = messagesToSend.flatMap((m) => m.files || []);
          const pipeFileAnnotation = await downloadFiles(pipeFiles, group.folder);
          const formatted = formatMessages(messagesToSend, TIMEZONE) + pipeFileAnnotation;

          // DMs skip IPC pipe to avoid cross-contamination with main group's container
          if (!isDm && queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
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

  // Recover DMs: check lastAgentTimestamp entries that are not registered groups
  const mainGroup = getMainGroup();
  if (mainGroup) {
    for (const [chatJid, cursor] of Object.entries(lastAgentTimestamp)) {
      if (registeredGroups[chatJid]) continue;
      const pending = getMessagesSince(chatJid, cursor, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          { chatJid, pendingCount: pending.length },
          'Recovery: found unprocessed DM messages',
        );
        queue.enqueueMessageCheck(chatJid);
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
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
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
          handleCommand(chatJid, msg, channel).then((consumed) => {
            if (!consumed) storeMessage(msg);
          }).catch((err) => {
            logger.warn({ chatJid, err }, 'Command handler error, storing message');
            storeMessage(msg);
          });
          return;
        }
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
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
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
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
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
