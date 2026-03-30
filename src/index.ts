import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
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
import { writeGroupsSnapshot } from './snapshot-writer.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  getThreadResponseUuids,
  cleanupOldThreadData,
} from './db.js';
import { AgentExecutor } from './agent-executor.js';
import { AppState, BUSY_EMOJI } from './app-state.js';
import { GroupManager } from './group-manager.js';
import { MessageProcessor } from './message-processor.js';
import {
  buildThreadJid,
  buildGroupJid,
  getParentJid,
  getBaseJid,
  getGroupFolder,
  isSyntheticThreadJid,
  parseSlackJid,
} from './jid.js';
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
  chatJid: string,
  msg: NewMessage,
  channel: Channel,
): Promise<boolean> {
  const text = msg.content.trim();
  const group = resolveGroup(chatJid);

  // /stop command — stops container for the thread where *stop was sent
  if (text === '*stop') {
    const stopped = await state.queue.stopGroup(chatJid, msg.threadTs);
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
        state.threadToggles.get(toggleKey) ||
        state.getToggleState(chatJid, msg.threadTs);
      if (arg === 'on') newValue = true;
      else if (arg === 'off') newValue = false;
      else newValue = isVerbose ? !current.verbose : !current.thinking;

      const updated = { ...current };
      if (isVerbose) updated.verbose = newValue;
      else updated.thinking = newValue;
      state.threadToggles.set(toggleKey, updated);
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

    // Set the toggle
    if (inThread) {
      const toggleKey = `${chatJid}:${msg.threadTs}:${group?.folder || ''}`;
      const current = state.getToggleState(
        chatJid,
        msg.threadTs,
        group?.folder,
      );
      state.threadToggles.set(toggleKey, { ...current, planMode: newValue });
      logger.info(
        { toggleKey, planMode: newValue, chatJid, threadTs: msg.threadTs, folder: group?.folder },
        'Plan mode toggle SET',
      );
    } else {
      if (!group) return false;
      group.planModeDefault = newValue;
      setRegisteredGroup(chatJid, group);
    }

    // *plan <prompt>: strip prefix, let message flow through to agent
    if (inlinePrompt && newValue) {
      msg.content = inlinePrompt;
      return false; // Don't consume — message flows to agent processing
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
    const channelGroups = state.groupsByJid.get(channelJid);
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
function resolveGroup(chatJid: string): RegisteredGroup | null {
  return groupManager.resolveGroup(chatJid);
}

function isMultiGroupChannel(channelJid: string): boolean {
  return groupManager.isMultiGroupChannel(channelJid);
}

function loadState(): void {
  state.loadState();
  groupManager.rebuildGroupIndexes();
}

function saveState(): void {
  state.saveState();
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  groupManager.registerGroup(jid, group);
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
  chatJid: string,
  threadTs?: string,
): Promise<boolean> {
  return messageProcessor.processGroupMessages(chatJid, threadTs);
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
            !isSyntheticThreadJid(c.jid) &&
            !getGroupFolder(c.jid),
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

        for (const [chatJid, groupMessages] of messagesByGroup) {
          // Multi-group channel: dispatch via resolveTargetGroups
          if (isMultiGroupChannel(chatJid)) {
            const lastGroupMsg = groupMessages[groupMessages.length - 1];
            const targets = groupManager.resolveTargetGroups(
              chatJid,
              lastGroupMsg.threadTs,
              lastGroupMsg,
            );
            if (
              targets.length === 0 &&
              !lastGroupMsg.threadTs &&
              !lastGroupMsg.is_bot_message
            ) {
              // No agents targeted in a multi-group channel — send a hint
              const channelGroups = state.groupsByJid.get(chatJid);
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
              const groupJid = buildGroupJid(chatJid, target.folder);
              state.queue.enqueueMessageCheck(groupJid);
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
            state.lastAgentTimestamp[state.getCursorKey(chatJid)] || '',
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

          // Try to pipe to an existing container for this specific thread (or root)
          if (!isDm && state.queue.sendMessage(chatJid, msgThread, formatted)) {
            logger.debug(
              {
                chatJid,
                threadTs: msgThread || '__root__',
                count: messagesToSend.length,
              },
              'Piped messages to active thread container',
            );
            state.lastAgentTimestamp[state.getCursorKey(chatJid, msgThread)] =
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
            if (state.queue.wouldQueue(chatJid, msgThread)) {
              const lastMsg = messagesToSend[messagesToSend.length - 1];
              const baseJidForReaction = getBaseJid(chatJid);
              channel
                .addReaction?.(baseJidForReaction, lastMsg.id, BUSY_EMOJI)
                ?.catch((err) =>
                  logger.debug({ chatJid, err }, 'Failed to add busy reaction'),
                );
              // Track for removal when processing starts (keyed by composite for thread isolation)
              const busyReactionKey = `${chatJid}::${msgThread || '__root__'}`;
              const existing =
                state.pendingBusyReactions.get(busyReactionKey) || [];
              existing.push({
                jid: baseJidForReaction,
                messageTs: lastMsg.id,
              });
              state.pendingBusyReactions.set(busyReactionKey, existing);
            }

            state.queue.enqueueMessageCheck(chatJid, msgThread);
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
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
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
          const groupJid = buildGroupJid(chatJid, target.folder);
          logger.info(
            {
              group: target.name,
              folder: target.folder,
              pendingCount: pending.length,
            },
            'Recovery: found unprocessed multi-group messages',
          );
          state.queue.enqueueMessageCheck(groupJid);
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
      state.queue.enqueueMessageCheck(chatJid);
    }
  }

  // Recover DMs and synthetic thread JIDs: check state.lastAgentTimestamp entries that are not registered groups
  const mainGroup = groupManager.getMainGroup();
  if (mainGroup) {
    for (const [chatJid, cursor] of Object.entries(state.lastAgentTimestamp)) {
      if (state.registeredGroups[chatJid]) continue;
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
          state.queue.enqueueMessageCheck(baseRecoveryJid, recoveryThreadTs);
        } else {
          state.queue.enqueueMessageCheck(chatJid);
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

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await state.queue.shutdown(10000);
    for (const ch of state.channels) await ch.disconnect();
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
        const channel = findChannel(state.channels, chatJid);
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
                  messageProcessor.dispatchMessage(chatJid, msg);
                } else if (
                  !isMultiGroupChannel(channelJid) &&
                  isSyntheticThreadJid(chatJid)
                ) {
                  // Single-group: IPC pipe with thread-aware routing (use base JID for consistent state.queue keys)
                  const formatted = formatMessages([msg], TIMEZONE);
                  const { threadTs: evtThreadTs } = parseSlackJid(chatJid);
                  if (
                    !state.queue.sendMessage(channelJid, evtThreadTs, formatted)
                  ) {
                    state.queue.enqueueMessageCheck(channelJid, evtThreadTs);
                  } else {
                    state.lastAgentTimestamp[
                      state.getCursorKey(channelJid, evtThreadTs)
                    ] = msg.timestamp;
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
          messageProcessor.dispatchBotMessage(chatJid, msg);
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
    }) => agentExecutor.rewindSession(p),
    onPlanApprove: async (params: {
      chatJid: string;
      threadTs: string;
      groupFolder: string;
    }) => {
      // Toggle plan mode OFF for this thread+agent
      const planKey = `${params.chatJid}:${params.threadTs}:${params.groupFolder}`;
      const current = state.getToggleState(
        params.chatJid,
        params.threadTs,
        params.groupFolder,
      );
      state.threadToggles.set(planKey, { ...current, planMode: false });

      // Store synthetic approval message and enqueue for processing
      // (container is likely already exited from idle timeout)
      const baseJid = getParentJid(params.chatJid) || params.chatJid;
      storeMessage({
        id: Date.now().toString(),
        chat_jid: buildThreadJid(baseJid, params.threadTs),
        sender: 'user',
        sender_name: 'User',
        content: 'Approved. Execute the plan now.',
        timestamp: new Date().toISOString(),
        threadTs: params.threadTs,
      });
      state.queue.enqueueMessageCheck(baseJid, params.threadTs);
    },
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
          const stopped = await state.queue.stopGroup(
            channelJid,
            params.threadTs,
          );
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
              state.threadToggles.get(toggleKey) ||
              state.getToggleState(channelJid, params.threadTs);
            if (arg === 'on') newValue = true;
            else if (arg === 'off') newValue = false;
            else newValue = isVerbose ? !current.verbose : !current.thinking;
            const updated = { ...current };
            if (isVerbose) updated.verbose = newValue;
            else updated.thinking = newValue;
            state.threadToggles.set(toggleKey, updated);
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

        case 'plan': {
          const arg = params.text.trim().toLowerCase();
          const inThread = !!params.threadTs;
          const newValue = arg !== 'off'; // bare /plan = on, /plan off = cancel

          if (inThread) {
            const toggleKey = `${channelJid}:${params.threadTs}:${group?.folder || ''}`;
            const current = state.getToggleState(
              channelJid,
              params.threadTs,
              group?.folder,
            );
            state.threadToggles.set(toggleKey, {
              ...current,
              planMode: newValue,
            });
          } else {
            if (!group) return 'No group found for this channel';
            group.planModeDefault = newValue;
            setRegisteredGroup(channelJid, group);
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
          const channel = findChannel(state.channels, channelJid);
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
          const channelGroups = state.groupsByJid.get(chJid);
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
        groupJid,
        null,
        proc,
        containerName,
        groupFolder,
      ),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(state.channels, jid);
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
      const channel = findChannel(state.channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
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
      const channelJid = getParentJid(chatJid) || chatJid;
      const groups = state.groupsByJid.get(channelJid);
      return !!groups?.some((g) => g.folder === groupFolder);
    },
    addReaction: async (jid: string, messageTs: string, emoji: string) => {
      const channel = findChannel(state.channels, jid);
      if (channel?.addReaction) {
        await channel.addReaction(jid, messageTs, emoji);
      }
    },
  });
  state.queue.setProcessMessagesFn(processGroupMessages);
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
