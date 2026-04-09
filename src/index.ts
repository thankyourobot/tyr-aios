import fs from 'fs';
import path from 'path';
import { OneCLI } from '@onecli-sh/sdk';
import {
  ASSISTANT_NAME,
  ONECLI_API_KEY,
  ONECLI_CLIENT_TIMEOUT_MS,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { getAllRegisteredGroups } from './stores/group-store.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './snapshot-writer.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  getThreadMembers,
  getThreadResponseUuids,
  getThreadSession,
  setPendingFork,
  addThreadMember,
  cleanupOldThreadData,
} from './db.js';
import { AgentExecutor } from './agent-executor.js';
import { AppState, BUSY_EMOJI } from './app-state.js';
import { GroupManager, cleanupOldContainerLogs } from './group-manager.js';
import { MessageProcessor } from './message-processor.js';
import {
  buildThreadJid,
  channelJid,
  getParentJid,
  isSyntheticThreadJid,
  parseSlackJid,
  type AnyJid,
  type ChannelJid,
} from './jid.js';
import { startIpcWatcher } from './ipc.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './job-scheduler.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  SendMessageOpts,
} from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const state = new AppState();
const groupManager = new GroupManager(state);
const agentExecutor = new AgentExecutor(state, groupManager);
const messageProcessor = new MessageProcessor(state, groupManager);
messageProcessor.setAgentExecutor(agentExecutor);
messageProcessor.setSaveFn(() => saveState());
state.setGroupResolver((jid) => groupManager.resolveGroup(jid));

/**
 * Check if a message is a toggle/stop command.
 * Returns true if the message was consumed (should not be stored or forwarded).
 */
async function handleCommand(
  chatJid: AnyJid,
  msg: NewMessage,
  channel: Channel,
): Promise<boolean> {
  // Strip leading @mentions so commands work with "@Agent *plan ..." syntax
  const text = msg.content.trim().replace(/^(<@[A-Z0-9]+>\s*)+/, '');
  const group = resolveGroupForCommand(chatJid, msg.threadTs);

  // /stop command — stops container for the thread where *stop was sent
  if (text === '*stop') {
    if (!group) {
      await channel.sendMessage(chatJid, 'No agent running', {
        threadTs: msg.threadTs,
      });
      return true;
    }
    const chJid = getParentJid(chatJid) ?? (chatJid as ChannelJid);
    const stopped = await state.queue.stopGroup(
      chJid,
      msg.threadTs,
      group.folder,
    );
    const displayOpts: SendMessageOpts = {
      displayName: group.displayName,
      displayEmoji: group.displayEmoji,
      displayIconUrl: group.displayIconUrl,
      threadTs: msg.threadTs,
    };
    await channel.sendMessage(
      chatJid,
      stopped ? 'Stopped' : 'No agent running',
      displayOpts,
    );
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
    const tKey = inThread ? state.toggleKey(chatJid, msg.threadTs) : null;

    let newValue: boolean;

    if (inThread && tKey) {
      // Per-thread override
      const current =
        state.threadToggles.get(tKey) ||
        state.getToggleState(chatJid, msg.threadTs);
      if (arg === 'on') newValue = true;
      else if (arg === 'off') newValue = false;
      else newValue = isVerbose ? !current.verbose : !current.thinking;

      const updated = { ...current };
      if (isVerbose) updated.verbose = newValue;
      else updated.thinking = newValue;
      state.threadToggles.set(tKey, updated);
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
      setRegisteredGroup(
        getParentJid(chatJid) ?? (chatJid as ChannelJid),
        group,
      );
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
        displayIconUrl: group?.displayIconUrl,
        threadTs: msg.threadTs,
      },
    );
    return true;
  }

  // *plan command — enter plan mode, optionally with inline prompt
  // *plan = enable plan mode (confirmation only)
  // *plan off = disable plan mode
  // *plan <prompt> = enable plan mode + forward prompt to agent
  const planMatch = text.match(/^\*plan(?:\s+(off)|\s+(.+))?$/s);
  if (planMatch) {
    const isOff = planMatch[1] === 'off';
    const inlinePrompt = planMatch[2]; // trailing text after *plan
    const inThread = !!msg.threadTs;
    const newValue = !isOff;

    // Set the toggle — toggleKey normalizes JID so SET/GET always match
    if (inThread) {
      const tKey = state.toggleKey(chatJid, msg.threadTs, group?.folder);
      const current = state.getToggleState(
        chatJid,
        msg.threadTs,
        group?.folder,
      );
      state.threadToggles.set(tKey, { ...current, planMode: newValue });
      logger.info(
        {
          toggleKey: tKey,
          planMode: newValue,
          threadTs: msg.threadTs,
          folder: group?.folder,
        },
        'Plan mode toggle SET',
      );
    } else {
      if (!group) return false;
      group.planModeDefault = newValue;
      setRegisteredGroup(
        getParentJid(chatJid) ?? (chatJid as ChannelJid),
        group,
      );
    }

    // *plan <prompt>: keep full message (agent sees *plan intent), let it flow through
    if (inlinePrompt && newValue) {
      return false; // Don't consume — message flows to agent processing with *plan prefix intact
    }

    // Bare *plan or *plan off: send confirmation, consume message
    const scope = inThread
      ? 'this thread'
      : `${group?.name || 'group'} (default)`;
    const stateStr = newValue ? 'ON' : 'OFF';
    await channel.sendMessage(chatJid, `Plan mode: ${stateStr} for ${scope}`, {
      displayName: group?.displayName,
      displayEmoji: group?.displayEmoji,
      displayIconUrl: group?.displayIconUrl,
      threadTs: msg.threadTs,
    });
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

    if (!group) return true; // No group resolved — nothing to rewind

    const uuids = getThreadResponseUuids(group.folder, msg.threadTs);
    if (uuids.length === 0) {
      await channel.sendMessage(
        chatJid,
        'No rewind points available \u2014 this thread predates rewind tracking.',
        {
          displayName: group.displayName,
          displayEmoji: group.displayEmoji,
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
        group.folder,
        {
          displayName: group.displayName,
          displayEmoji: group.displayEmoji,
          displayIconUrl: group.displayIconUrl,
          botToken: group.botToken,
        },
      );
    }
    return true;
  }

  // *compact command — trigger on-demand LCM compaction
  if (text === '*compact') {
    if (!group) return true;
    const threadKey = msg.threadTs || '__root__';
    const ipcDir = resolveGroupIpcPath(group.folder);
    const signalPath = path.join(ipcDir, 'input', threadKey, '_lcm_compact');
    try {
      fs.mkdirSync(path.dirname(signalPath), { recursive: true });
      fs.writeFileSync(
        signalPath,
        JSON.stringify({ timestamp: new Date().toISOString() }),
      );
      await channel.sendMessage(
        chatJid,
        'Compacting memory... session has reset with summaries preserved. Please send a message to continue.',
        {
          displayName: group.displayName,
          displayEmoji: group.displayEmoji,
          displayIconUrl: group.displayIconUrl,
          threadTs: msg.threadTs,
        },
      );
    } catch (err) {
      logger.error({ err }, '*compact failed');
    }
    return true;
  }

  // /who command — list agents in the current channel
  if (text === '*who') {
    const chJid = getParentJid(chatJid) ?? (chatJid as ChannelJid);
    const channelGroups = state.groupsByJid.get(chJid);
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

// Delegators for group management (thin wrappers around GroupManager)
function resolveGroup(chatJid: AnyJid): RegisteredGroup | null {
  return groupManager.resolveGroup(chatJid);
}

/**
 * Resolve the correct group for a command in multi-agent threads.
 * Uses thread membership to identify which agent is active in the thread,
 * falling back to the default resolveGroup for single-agent channels.
 */
function resolveGroupForCommand(
  chatJid: AnyJid,
  threadTs?: string,
): RegisteredGroup | null {
  const group = resolveGroup(chatJid);
  const chJid = getParentJid(chatJid) ?? (chatJid as ChannelJid);
  if (threadTs && groupManager.isMultiGroupChannel(chJid)) {
    const members = getThreadMembers(chJid, threadTs);
    if (members.length > 0) {
      const channelGroups = state.groupsByJid.get(chJid);
      const memberGroup = channelGroups?.find((g) =>
        members.includes(g.folder),
      );
      if (memberGroup) return memberGroup;
    }
  }
  return group;
}

function isMultiGroupChannel(cJid: ChannelJid): boolean {
  return groupManager.isMultiGroupChannel(cJid);
}

function loadState(): void {
  state.loadState();
  groupManager.rebuildGroupIndexes();
}

function saveState(): void {
  state.saveState();
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  groupManager.registerGroup(jid as ChannelJid, group);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./snapshot-writer.js').AvailableGroup[] {
  return groupManager.getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.registeredGroups = groups;
}

async function processGroupMessages(
  chatJid: ChannelJid,
  threadTs?: string,
  groupFolder?: string,
): Promise<boolean> {
  return messageProcessor.processGroupMessages(chatJid, threadTs, groupFolder);
}

async function startMessageLoop(): Promise<void> {
  if (state.messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  state.messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      // Include DM JIDs so getNewMessages picks up direct messages
      const registeredJids = Object.keys(state.registeredGroups);
      const allChats = getAllChats();
      const dmJids = allChats
        .filter(
          (c) =>
            !c.is_group &&
            c.jid !== '__group_sync__' &&
            !state.registeredGroups[c.jid] &&
            !isSyntheticThreadJid(c.jid),
        )
        .map((c) => c.jid);
      const jids = [...registeredJids, ...dmJids];
      const { messages, newTimestamp } = getNewMessages(
        jids,
        state.lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        state.lastTimestamp = newTimestamp;
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

        for (const [chatJidRaw, groupMessages] of messagesByGroup) {
          const chatJid = chatJidRaw as AnyJid;
          const baseJid = getParentJid(chatJid) ?? (chatJid as ChannelJid);

          // Multi-group channel: dispatch via resolveTargetGroups
          if (isMultiGroupChannel(baseJid)) {
            const lastGroupMsg = groupMessages[groupMessages.length - 1];
            const targets = groupManager.resolveTargetGroups(
              baseJid,
              lastGroupMsg.threadTs,
              lastGroupMsg,
            );
            if (
              targets.length === 0 &&
              !lastGroupMsg.threadTs &&
              !lastGroupMsg.is_bot_message
            ) {
              // No agents targeted in a multi-group channel — send a hint
              const channelGroups = state.groupsByJid.get(baseJid);
              if (channelGroups && channelGroups.length > 1) {
                const names = channelGroups
                  .map((g) => g.assistantName || g.displayName || g.name)
                  .join(', ');
                const channel = findChannel(state.channels, chatJid);
                channel?.sendMessage(
                  chatJid,
                  `This is a multi-agent channel — @mention an agent to start a conversation: ${names}`,
                  { threadTs: lastGroupMsg.id },
                );
              }
            }
            for (const target of targets) {
              state.queue.enqueueMessageCheck(
                baseJid,
                lastGroupMsg.threadTs,
                target.folder,
              );
            }
            continue;
          }

          let group = state.registeredGroups[chatJid];
          const isDm = !group;

          if (!group) {
            const main = groupManager.getMainGroup();
            if (!main) continue;
            group = main.group;
          }

          const channel = findChannel(state.channels, chatJid);
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

          // Pull all messages since state.lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            state.lastAgentTimestamp[state.getCursorKey(baseJid)] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Download file attachments before formatting (needed for both IPC and new container paths)
          const pipeFiles = messagesToSend.flatMap((m) => m.files || []);
          const pipeFileAnnotation = await agentExecutor.downloadFiles(
            pipeFiles,
            group.folder,
          );
          const formatted =
            formatMessages(messagesToSend, TIMEZONE) + pipeFileAnnotation;

          // Per-thread parallel dispatch: try to pipe to existing container for this thread,
          // otherwise enqueue independently. No more thread-mismatch container killing.
          const msgThread =
            messagesToSend[messagesToSend.length - 1].threadTs || null;

          // Try to pipe to an existing container for this specific thread.
          // Root messages (msgThread=null) are never piped — each root message
          // is an independent conversation that gets its own container + thread.
          if (
            !isDm &&
            msgThread !== null &&
            state.queue.sendMessage(baseJid, msgThread, formatted, group.folder)
          ) {
            logger.debug(
              {
                chatJid,
                threadTs: msgThread || '__root__',
                count: messagesToSend.length,
              },
              'Piped messages to active thread container',
            );
            state.lastAgentTimestamp[state.getCursorKey(baseJid, msgThread)] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator — use synthetic thread JID for thread context lookup
            const typingPipeJid = msgThread
              ? buildThreadJid(baseJid, msgThread)
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
            if (state.queue.wouldQueue(baseJid, msgThread, group.folder)) {
              const lastMsg = messagesToSend[messagesToSend.length - 1];
              channel
                .addReaction?.(chatJid, lastMsg.id, BUSY_EMOJI)
                ?.catch((err) =>
                  logger.debug({ chatJid, err }, 'Failed to add busy reaction'),
                );
              // Track for removal when processing starts (keyed by composite for thread isolation)
              const busyReactionKey = `${chatJid}::${msgThread || '__root__'}`;
              const existing =
                state.pendingBusyReactions.get(busyReactionKey) || [];
              existing.push({
                jid: chatJid,
                messageTs: lastMsg.id,
              });
              state.pendingBusyReactions.set(busyReactionKey, existing);
            }

            state.queue.enqueueMessageCheck(baseJid, msgThread, group.folder);
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
 * Handles crash between advancing state.lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJidRaw, group] of Object.entries(state.registeredGroups)) {
    const chatJid = chatJidRaw as ChannelJid; // registered group keys are always channel JIDs
    // Multi-group channels: dispatch via resolveTargetGroups to avoid
    // routing all pending messages to just the director/first group
    if (isMultiGroupChannel(chatJid)) {
      const sinceTimestamp = state.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        const lastMsg = pending[pending.length - 1];
        const targets = groupManager.resolveTargetGroups(
          chatJid,
          lastMsg.threadTs,
          lastMsg,
        );
        for (const target of targets) {
          logger.info(
            {
              group: target.name,
              folder: target.folder,
              pendingCount: pending.length,
            },
            'Recovery: found unprocessed multi-group messages',
          );
          state.queue.enqueueMessageCheck(
            chatJid,
            lastMsg.threadTs,
            target.folder,
          );
        }
      }
      continue;
    }

    const sinceTimestamp = state.lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      state.queue.enqueueMessageCheck(chatJid, undefined, group.folder);
    }
  }

  // Recover DMs and synthetic thread JIDs: check state.lastAgentTimestamp entries that are not registered groups
  const mainGroup = groupManager.getMainGroup();
  if (mainGroup) {
    for (const [chatJidRaw, cursor] of Object.entries(
      state.lastAgentTimestamp,
    )) {
      if (state.registeredGroups[chatJidRaw]) continue;
      const chatJid = chatJidRaw as AnyJid;
      const pending = getMessagesSince(chatJid, cursor, ASSISTANT_NAME);
      if (pending.length > 0) {
        const label = isSyntheticThreadJid(chatJidRaw) ? 'thread' : 'DM';
        logger.info(
          { chatJid, pendingCount: pending.length },
          `Recovery: found unprocessed ${label} messages`,
        );
        // Use consistent keying: base JID + threadTs (not synthetic JID)
        if (isSyntheticThreadJid(chatJidRaw)) {
          const { threadTs: recoveryThreadTs } = parseSlackJid(chatJid);
          const baseRecoveryJid =
            getParentJid(chatJid) ?? (chatJid as ChannelJid);
          state.queue.enqueueMessageCheck(
            baseRecoveryJid,
            recoveryThreadTs,
            mainGroup.group.folder,
          );
        } else {
          state.queue.enqueueMessageCheck(
            chatJid as ChannelJid,
            undefined,
            mainGroup.group.folder,
          );
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
  state.loadEnvVars();

  if (!ONECLI_API_KEY || !ONECLI_URL) {
    throw new Error(
      'ONECLI_URL and ONECLI_API_KEY must both be set in /opt/nanoclaw/.env',
    );
  }
  logger.info({ url: ONECLI_URL }, 'Credential layer: OneCLI Agent Vault');
  const onecli = new OneCLI({
    apiKey: ONECLI_API_KEY,
    url: ONECLI_URL,
    timeout: ONECLI_CLIENT_TIMEOUT_MS,
  });

  // Retry covers boot races (onecli.service is oneshot, so "active" != "ready")
  // and transient flake. Backoff: immediate, 500ms, 1500ms.
  const ensureAgentWithRetry = async (
    folder: string,
  ): ReturnType<typeof onecli.ensureAgent> => {
    const delays = [0, 500, 1500];
    let lastErr: unknown;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
      try {
        return await onecli.ensureAgent({
          name: folder,
          identifier: folder,
        });
      } catch (err) {
        lastErr = err;
        logger.warn(
          { err, folder, attempt: attempt + 1 },
          'ensureAgent attempt failed, will retry',
        );
      }
    }
    throw lastErr;
  };

  // Idempotently ensure each registered group folder maps to an OneCLI agent.
  const groups = getAllRegisteredGroups();
  const uniqueFolders = [
    ...new Set(Object.values(groups).map((g) => g.folder)),
  ];
  for (const folder of uniqueFolders) {
    try {
      const res = await ensureAgentWithRetry(folder);
      logger.info(
        { folder, created: res.created },
        res.created ? 'Created OneCLI agent' : 'OneCLI agent already exists',
      );
    } catch (err) {
      logger.error(
        { err, folder },
        'Failed to ensure OneCLI agent after 3 attempts — startup aborting',
      );
      throw err;
    }
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await state.queue.shutdown(10000);
    for (const ch of state.channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: AnyJid, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && resolveGroup(chatJid)) {
        const cfg = loadSenderAllowlist();
        const allowlistJid = getParentJid(chatJid) ?? chatJid;
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
        const channel = findChannel(state.channels, chatJid);
        if (channel) {
          handleCommand(chatJid, msg, channel)
            .then(async (consumed) => {
              if (!consumed) {
                storeMessage(msg);
                // Multi-group dispatch for human messages
                const chJid = getParentJid(chatJid) ?? (chatJid as ChannelJid);
                if (
                  isMultiGroupChannel(chJid) &&
                  isSyntheticThreadJid(chatJid)
                ) {
                  // Thread messages in multi-group channels: dispatch from realtime path
                  // (polling loop won't see them since they're stored under synthetic JID)
                  messageProcessor.dispatchMessage(chatJid, msg);
                } else if (
                  !isMultiGroupChannel(chJid) &&
                  isSyntheticThreadJid(chatJid)
                ) {
                  // Single-group: IPC pipe with thread-aware routing
                  const pipeGroup = resolveGroup(chJid);
                  if (!pipeGroup) return; // No group — message stored, polling loop handles it
                  const pipeFiles = msg.files || [];
                  const pipeFileAnnotation = await agentExecutor.downloadFiles(
                    pipeFiles,
                    pipeGroup.folder,
                  );
                  const formatted =
                    formatMessages([msg], TIMEZONE) + pipeFileAnnotation;
                  const { threadTs: evtThreadTs } = parseSlackJid(chatJid);
                  if (
                    !state.queue.sendMessage(
                      chJid,
                      evtThreadTs,
                      formatted,
                      pipeGroup.folder,
                    )
                  ) {
                    state.queue.enqueueMessageCheck(
                      chJid,
                      evtThreadTs,
                      pipeGroup.folder,
                    );
                  } else {
                    state.lastAgentTimestamp[
                      state.getCursorKey(chJid, evtThreadTs)
                    ] = msg.timestamp;
                    saveState();
                    if (evtThreadTs) {
                      const typingJid = buildThreadJid(chJid, evtThreadTs);
                      channel
                        .setTyping?.(typingJid, true, pipeGroup.botToken)
                        ?.catch(() => {});
                    }
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
          messageProcessor.dispatchBotMessage(chatJid, msg);
        }
        return;
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: ChannelJid,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
    resolveBotSenderName: (
      botId: string,
      username?: string,
      userId?: string,
    ): string | undefined => {
      // Look up bot user ID (U-prefix) against known agent bot user IDs
      if (userId) {
        const group = state.groupsByBotUserId.get(userId);
        if (group) return group.assistantName || group.displayName;
      }
      // Try bot_id (B-prefix) — less reliable but covers edge cases
      if (botId) {
        const group = state.groupsByBotUserId.get(botId);
        if (group) return group.assistantName || group.displayName;
      }
      // Fallback: try username (for technicians sharing an app)
      if (username) {
        for (const [, entry] of state.groupsByFolder) {
          const name = entry.group.assistantName || entry.group.displayName;
          if (name && name.toLowerCase() === username.toLowerCase())
            return name;
        }
      }
      return undefined;
    },
    onRewind: (p: {
      groupFolder: string;
      chatJid: string;
      sourceThreadTs: string;
      newThreadTs: string;
      sdkUuid: string;
    }) => {
      // Lazy fork: store fork params for when the user sends their first message.
      // No container is spawned — the agent doesn't know a fork happened.
      const sourceSessionId =
        getThreadSession(p.groupFolder, p.sourceThreadTs) ||
        state.sessions[p.groupFolder];
      if (!sourceSessionId) {
        logger.warn(
          { groupFolder: p.groupFolder, sourceThreadTs: p.sourceThreadTs },
          'No source session found for rewind, skipping fork setup',
        );
        return;
      }
      setPendingFork(p.groupFolder, p.newThreadTs, sourceSessionId, p.sdkUuid);
      // Register thread membership so multi-agent routing works for follow-ups
      const rewindChJid =
        getParentJid(p.chatJid as AnyJid) ?? (p.chatJid as ChannelJid);
      addThreadMember(rewindChJid, p.newThreadTs, p.groupFolder);
      logger.info(
        { groupFolder: p.groupFolder, newThreadTs: p.newThreadTs },
        'Rewind: stored pending fork and registered thread member',
      );
    },
    onPlanApprove: async (params: {
      chatJid: string;
      threadTs: string;
      groupFolder: string;
    }) => {
      // Toggle plan mode OFF for this thread+agent
      const approveJid = params.chatJid as AnyJid;
      const planKey = state.toggleKey(
        approveJid,
        params.threadTs,
        params.groupFolder,
      );
      const current = state.getToggleState(
        approveJid,
        params.threadTs,
        params.groupFolder,
      );
      state.threadToggles.set(planKey, { ...current, planMode: false });

      // Store synthetic approval message and enqueue for processing
      // (container is likely already exited from idle timeout)
      const approveBaseJid =
        getParentJid(approveJid) ?? (approveJid as ChannelJid);
      storeMessage({
        id: Date.now().toString(),
        chat_jid: buildThreadJid(approveBaseJid, params.threadTs),
        sender: 'user',
        sender_name: 'User',
        content: 'Approved. Execute the plan now.',
        timestamp: new Date().toISOString(),
        threadTs: params.threadTs,
      });
      state.queue.enqueueMessageCheck(
        approveBaseJid,
        params.threadTs,
        params.groupFolder,
      );
    },
    getPendingQuestions: (questionId: string) =>
      state.pendingQuestions.get(questionId),
    onAskUserAnswer: async (params: {
      chatJid: string;
      threadTs: string;
      groupFolder: string;
      answer: string;
    }) => {
      const answerJid = params.chatJid as AnyJid;
      const answerBaseJid =
        getParentJid(answerJid) ?? (answerJid as ChannelJid);

      // Post the answer visibly in Slack thread (neutral attribution)
      const channel = findChannel(state.channels, answerBaseJid);
      const group = Object.values(state.registeredGroups).find(
        (g) => g.folder === params.groupFolder,
      );
      if (channel && group) {
        const quoted = params.answer.replace(/\n/g, '\n> ');
        await channel.sendMessage(
          answerBaseJid,
          `_User answered:_\n> ${quoted}`,
          {
            botToken: group.botToken,
            threadTs: params.threadTs,
          },
        );
      }

      // Always store for thread history
      storeMessage({
        id: Date.now().toString(),
        chat_jid: buildThreadJid(answerBaseJid, params.threadTs),
        sender: 'user',
        sender_name: 'User',
        content: params.answer,
        timestamp: new Date().toISOString(),
        threadTs: params.threadTs,
      });

      // Pipe answer to active container via IPC, or enqueue if container exited
      const piped = state.queue.sendMessage(
        answerBaseJid,
        params.threadTs || null,
        params.answer,
        params.groupFolder,
      );
      if (!piped) {
        state.queue.enqueueMessageCheck(
          answerBaseJid,
          params.threadTs,
          params.groupFolder,
        );
      }
    },
    onSlashCommand: async (params: {
      command: string;
      text: string;
      channelId: string;
      userId: string;
      threadTs?: string;
      triggerId: string;
    }): Promise<string | null> => {
      const slashJid = channelJid(`slack:${params.channelId}`);
      const group = resolveGroupForCommand(slashJid, params.threadTs);

      switch (params.command) {
        case 'stop': {
          if (!group) return 'No agent running';
          const stopped = await state.queue.stopGroup(
            slashJid,
            params.threadTs,
            group.folder,
          );
          return stopped ? 'Stopped' : 'No agent running';
        }

        case 'verbose':
        case 'thinking': {
          const isVerbose = params.command === 'verbose';
          const arg = params.text.trim().toLowerCase();
          const inThread = !!params.threadTs;
          const tKey = inThread
            ? state.toggleKey(slashJid, params.threadTs)
            : null;

          let newValue: boolean;
          if (inThread && tKey) {
            const current =
              state.threadToggles.get(tKey) ||
              state.getToggleState(slashJid, params.threadTs);
            if (arg === 'on') newValue = true;
            else if (arg === 'off') newValue = false;
            else newValue = isVerbose ? !current.verbose : !current.thinking;
            const updated = { ...current };
            if (isVerbose) updated.verbose = newValue;
            else updated.thinking = newValue;
            state.threadToggles.set(tKey, updated);
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
            setRegisteredGroup(slashJid, group);
          }

          const scope = inThread
            ? 'this thread'
            : `${group?.name || 'group'} (default)`;
          const mode = params.command;
          return `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode: ${newValue ? 'ON' : 'OFF'} for ${scope}`;
        }

        case 'plan': {
          const arg = params.text.trim().toLowerCase();
          const inThread = !!params.threadTs;
          const newValue = arg !== 'off'; // bare /plan = on, /plan off = cancel

          if (inThread) {
            const tKey = state.toggleKey(
              slashJid,
              params.threadTs,
              group?.folder,
            );
            const current = state.getToggleState(
              slashJid,
              params.threadTs,
              group?.folder,
            );
            state.threadToggles.set(tKey, {
              ...current,
              planMode: newValue,
            });
          } else {
            if (!group) return 'No group found for this channel';
            group.planModeDefault = newValue;
            setRegisteredGroup(slashJid, group);
          }

          const scope = inThread
            ? 'this thread'
            : `${group?.name || 'group'} (default)`;
          return `Plan mode: ${newValue ? 'ON' : 'OFF'} for ${scope}`;
        }

        case 'rewind': {
          if (!params.threadTs) {
            return 'Rewind works in threads — start a conversation first.';
          }
          if (!group) return 'No agent found for this channel.';
          const channel = findChannel(state.channels, slashJid);
          if (channel?.postRewindButton) {
            await channel.postRewindButton(
              slashJid,
              params.userId,
              params.threadTs,
              group.folder,
            );
          }
          return null; // rewind button handles the response
        }

        case 'agents': {
          const channelGroups = state.groupsByJid.get(slashJid);
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
  // Factories return null when credentials are missing, so unconfigured state.channels are skipped.
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
    state.channels.push(channel);
    await channel.connect();
  }
  if (state.channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
    queue: state.queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      state.queue.registerProcess(
        groupJid as ChannelJid,
        null,
        proc,
        containerName,
        groupFolder,
      ),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(state.channels, jid as AnyJid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid as AnyJid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, opts) => {
      const channel = findChannel(state.channels, jid as AnyJid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid as AnyJid, text, opts);
    },
    registeredGroups: () => state.registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        state.channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    isGroupInChannel: (chatJid: string, groupFolder: string): boolean => {
      const ipcChJid =
        getParentJid(chatJid as AnyJid) ?? (chatJid as ChannelJid);
      const groups = state.groupsByJid.get(ipcChJid);
      return !!groups?.some((g) => g.folder === groupFolder);
    },
    addReaction: async (jid: string, messageTs: string, emoji: string) => {
      const channel = findChannel(state.channels, jid as AnyJid);
      if (channel?.addReaction) {
        await channel.addReaction(jid as AnyJid, messageTs, emoji);
      }
    },
    onPlanReady: async (
      chatJid: string,
      groupFolder: string,
      plan: string,
      threadTs?: string,
    ) => {
      const channel = findChannel(state.channels, chatJid as AnyJid);
      if (!channel) {
        logger.warn({ chatJid }, 'No channel for plan_ready IPC');
        return;
      }
      // Find the group by folder
      const group = Object.values(state.registeredGroups).find(
        (g) => g.folder === groupFolder,
      );
      if (!group) {
        logger.warn({ groupFolder }, 'No group for plan_ready IPC');
        return;
      }
      const baseJid =
        getParentJid(chatJid as AnyJid) ?? (chatJid as ChannelJid);

      // Send plan text
      await channel.sendMessage(chatJid as AnyJid, plan, {
        displayName: group.displayName,
        displayEmoji: group.displayEmoji,
        displayIconUrl: group.displayIconUrl,
        botToken: group.botToken,
        threadTs,
      });

      // Send Approve button
      if (channel.sendBlocks) {
        await channel.sendBlocks(
          chatJid as AnyJid,
          [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '_Reply to revise the plan_',
              },
            },
            {
              type: 'actions',
              block_id: `plan_${Date.now()}`,
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Approve' },
                  style: 'primary',
                  action_id: 'plan_approve',
                  value: JSON.stringify({
                    chatJid: baseJid,
                    threadTs: threadTs || '',
                    groupFolder,
                  }),
                },
              ],
            },
          ],
          'Plan ready — Approve or reply to revise',
          {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            displayIconUrl: group.displayIconUrl,
            botToken: group.botToken,
            threadTs,
          },
        );
      }
      logger.info({ chatJid, groupFolder, threadTs }, 'Plan posted from IPC');
    },
    onAskUser: async (
      chatJid: string,
      groupFolder: string,
      questions: unknown[],
      threadTs?: string,
    ) => {
      const channel = findChannel(state.channels, chatJid as AnyJid);
      if (!channel) {
        logger.warn({ chatJid }, 'No channel for ask_user IPC');
        return;
      }
      const group = Object.values(state.registeredGroups).find(
        (g) => g.folder === groupFolder,
      );
      if (!group) {
        logger.warn({ groupFolder }, 'No group for ask_user IPC');
        return;
      }

      const baseJid =
        getParentJid(chatJid as AnyJid) ?? (chatJid as ChannelJid);
      const typedQuestions = questions as Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>;

      // Store questions in memory map (Slack button value has 2000 char limit)
      const questionId = `aq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      state.pendingQuestions.set(questionId, typedQuestions);
      // Auto-cleanup after 30 min
      setTimeout(
        () => state.pendingQuestions.delete(questionId),
        30 * 60 * 1000,
      );

      // Show questions as text + single "Answer" button that opens a modal
      const questionText = typedQuestions
        .map((q, i) => {
          let text = q.header
            ? `*${q.header}:* ${q.question}`
            : `*${i + 1}.* ${q.question}`;
          if (q.options?.length) {
            text +=
              '\n' +
              q.options
                .map(
                  (o) =>
                    `  • ${o.label}${o.description ? ` — ${o.description}` : ''}`,
                )
                .join('\n');
          }
          return text;
        })
        .join('\n\n');

      const blocks: Record<string, unknown>[] = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: questionText },
        },
        {
          type: 'actions',
          block_id: `ask_modal_${Date.now()}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Answer' },
              style: 'primary',
              action_id: 'ask_user_open_modal',
              value: JSON.stringify({
                questionId,
                chatJid: baseJid,
                threadTs: threadTs || '',
                groupFolder,
              }),
            },
          ],
        },
      ];

      if (channel.sendBlocks) {
        await channel.sendBlocks(
          chatJid as AnyJid,
          blocks,
          'Agent has questions — click Answer to respond',
          {
            displayName: group.displayName,
            displayEmoji: group.displayEmoji,
            displayIconUrl: group.displayIconUrl,
            botToken: group.botToken,
            threadTs,
          },
        );
      }
      logger.info(
        { chatJid, groupFolder, threadTs },
        'Questions posted from IPC',
      );
    },
  });
  state.queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Daily cleanup (every 24 hours)
  setInterval(
    () => {
      try {
        cleanupOldThreadData(30);
      } catch (err) {
        logger.warn({ err }, 'Thread data cleanup error');
      }
      try {
        cleanupOldContainerLogs(30);
      } catch (err) {
        logger.warn({ err }, 'Container log cleanup error');
      }
    },
    24 * 60 * 60 * 1000,
  );
  // Run once at startup
  cleanupOldThreadData(30);
  cleanupOldContainerLogs(30);

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
