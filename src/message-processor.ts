import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import type { AppState } from './app-state.js';
import { BUSY_EMOJI } from './app-state.js';
import type { AgentExecutor } from './agent-executor.js';
import { ContainerOutput } from './types.js';
import {
  addThreadMember,
  getMessageById,
  getMessagesSince,
  getMessagesSinceIncludingBots,
  storeResponseUuid,
} from './db.js';
import type { GroupManager } from './group-manager.js';
import {
  buildGroupJid,
  buildThreadJid,
  getBaseJid,
  getGroupFolder,
  getParentJid,
  isSyntheticThreadJid,
  parseSlackJid,
} from './jid.js';
import { logger } from './logger.js';
import { findChannel, formatMessages } from './router.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from './sender-allowlist.js';
import { NewMessage, RegisteredGroup, SendMessageOpts } from './types.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MessageProcessor {
  private agentExecutor!: AgentExecutor;
  private saveFn!: () => void;

  constructor(
    private state: AppState,
    private groupManager: GroupManager,
  ) {}

  setAgentExecutor(executor: AgentExecutor): void {
    this.agentExecutor = executor;
  }

  setSaveFn(fn: () => void): void {
    this.saveFn = fn;
  }

  /**
   * Process all pending messages for a group.
   * Called by the GroupQueue when it's this group's turn.
   */
  async processGroupMessages(
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
      const channelGroups = this.state.groupsByJid.get(channelJid);
      const match = channelGroups?.find((g) => g.folder === groupFolder);
      group =
        match ?? this.state.groupsByFolder.get(groupFolder)?.group ?? null;
    } else {
      group = this.groupManager.resolveGroup(chatJid);
    }
    if (!group) return true;

    // Remove any "busy" reactions now that we're processing this group's messages
    const busyKey = `${chatJid}::${threadTs || '__root__'}`;
    const busyReactions = this.state.pendingBusyReactions.get(busyKey);
    if (busyReactions?.length) {
      const channel_ = findChannel(this.state.channels, baseJid);
      for (const { jid, messageTs } of busyReactions) {
        channel_
          ?.removeReaction?.(jid, messageTs, BUSY_EMOJI)
          ?.catch((err) =>
            logger.debug({ chatJid, err }, 'Failed to remove busy reaction'),
          );
      }
      this.state.pendingBusyReactions.delete(busyKey);
    }

    const channel = findChannel(this.state.channels, baseJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    // Thread messages are stored under synthetic JIDs (e.g., slack:C123:t:171110...).
    // Use the synthetic JID for retrieval when processing a specific thread.
    const fetchJid = threadTs ? buildThreadJid(baseJid, threadTs) : baseJid;
    const cursorKey = this.state.getCursorKey(baseJid, threadTs);
    const sinceTimestamp =
      this.state.lastAgentTimestamp[cursorKey] ||
      this.state.lastAgentTimestamp[baseJid] ||
      '';
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
    const fileAnnotation = await this.agentExecutor.downloadFiles(
      allFiles,
      group.folder,
    );

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
    const previousCursor = this.state.lastAgentTimestamp[cursorKey] || '';
    this.state.lastAgentTimestamp[cursorKey] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveFn();

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
        this.state.queue.closeStdin(chatJid, lastThreadTs);
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
        new RegExp(
          `(?:^|\\s)@${escapeRegex(group.assistantName)}\\b`,
          'i',
        ).test(triggeringMsg.content));
    // Use synthetic thread JID for typing indicator so it matches latestMessageContext
    const typingJid = groupFolder
      ? baseJid
      : threadTs
        ? fetchJid
        : chatJid;
    if (isMentioned) {
      await channel.setTyping?.(typingJid, true, group.botToken);
    }
    let hadError = false;
    let outputSentToUser = false;

    // Get toggle state for this thread
    const toggleState = this.state.getToggleState(chatJid, lastThreadTs);

    const output = await this.agentExecutor.runAgent(
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
            ?.catch((err) =>
              logger.warn({ err }, 'Verbose message failed'),
            );
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
            ?.catch((err) =>
              logger.warn({ err }, 'Thinking message failed'),
            );
          return;
        }

        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          let text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          // Agent can wrap output in <channel>...</channel> to post top-level instead of threading
          const hasChannelTags = /<channel>/.test(text);
          const useThreadTs = hasChannelTags ? undefined : lastThreadTs;
          if (hasChannelTags)
            text = text.replace(/<\/?channel>/g, '').trim();
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
            this.state.getToggleState(chatJid, lastThreadTs).verbose
          ) {
            const cu = result.contextUsage;
            const totalUsed =
              cu.inputTokens + cu.cacheCreationTokens + cu.cacheReadTokens;
            const pct = Math.round(
              (totalUsed / cu.contextWindow) * 100,
            );
            const modelSuffix = result.model
              ? ` \u2014 ${result.model}`
              : '';
            const contextLine = `_Context: ${this.state.formatTokens(totalUsed)}/${this.state.formatTokens(cu.contextWindow)} (${pct}%)${modelSuffix}_`;
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
            if (
              result.contextUsage &&
              result.contextUsage.contextWindow > 0
            ) {
              const postTokens =
                result.contextUsage.inputTokens +
                result.contextUsage.cacheCreationTokens +
                result.contextUsage.cacheReadTokens;
              const cw = result.contextUsage.contextWindow;
              const pct = Math.round((postTokens / cw) * 100);
              compactLine = `_Compacted: ${this.state.formatTokens(result.compaction.preTokens)} \u2192 ${this.state.formatTokens(postTokens)}/${this.state.formatTokens(cw)} (${pct}%)_`;
            } else {
              compactLine = `_Compacted from ${this.state.formatTokens(result.compaction.preTokens)} tokens_`;
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
          this.state.queue.notifyIdle(chatJid, lastThreadTs);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
      toggleState,
      lastThreadTs !== lastMsg.id ? lastThreadTs : undefined,
    );

    if (isMentioned)
      await channel.setTyping?.(typingJid, false, group.botToken);
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
      this.state.lastAgentTimestamp[cursorKey] = previousCursor;
      this.saveFn();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  }

  /**
   * Dispatch a human message to target groups in a multi-group channel.
   */
  dispatchMessage(chatJid: string, msg: NewMessage): void {
    const channelJid = getParentJid(chatJid) || chatJid;
    const { threadTs } = parseSlackJid(chatJid);

    if (!this.groupManager.isMultiGroupChannel(channelJid)) {
      // Single-group: route using base channel JID + threadTs for consistent queue keying
      if (isSyntheticThreadJid(chatJid)) {
        const formatted = formatMessages([msg], TIMEZONE);
        if (!this.state.queue.sendMessage(channelJid, threadTs, formatted)) {
          this.state.queue.enqueueMessageCheck(channelJid, threadTs);
        } else {
          this.state.lastAgentTimestamp[
            this.state.getCursorKey(channelJid, threadTs)
          ] = msg.timestamp;
          this.saveFn();
        }
      }
      return;
    }

    // Multi-group channel: dispatch to target groups
    const targets = this.groupManager.resolveTargetGroups(
      channelJid,
      threadTs || msg.threadTs,
      msg,
    );
    for (const group of targets) {
      const baseJid = threadTs
        ? buildThreadJid(
            `slack:${parseSlackJid(channelJid).channelId}`,
            threadTs,
          )
        : channelJid;
      const groupJid = buildGroupJid(baseJid, group.folder);
      const formatted = formatMessages([msg], TIMEZONE, true);
      if (
        !this.state.queue.sendMessage(
          groupJid,
          threadTs || msg.threadTs,
          formatted,
        )
      ) {
        this.state.queue.enqueueMessageCheck(
          groupJid,
          threadTs || msg.threadTs,
        );
      } else {
        this.state.lastAgentTimestamp[
          this.state.getCursorKey(groupJid, threadTs || msg.threadTs)
        ] = msg.timestamp;
        this.saveFn();
      }
    }
  }

  /**
   * Dispatch a bot message that contains @mentions to target agents.
   */
  dispatchBotMessage(chatJid: string, msg: NewMessage): void {
    const channelJid = getParentJid(chatJid) || chatJid;
    const { threadTs } = parseSlackJid(chatJid);

    if (!this.groupManager.isMultiGroupChannel(channelJid)) return;

    const targets = this.groupManager.resolveTargetGroups(
      channelJid,
      threadTs || msg.threadTs,
      msg,
    );
    if (targets.length === 0) return;

    for (const group of targets) {
      const baseJid = threadTs
        ? buildThreadJid(
            `slack:${parseSlackJid(channelJid).channelId}`,
            threadTs,
          )
        : channelJid;
      const groupJid = buildGroupJid(baseJid, group.folder);
      this.state.queue.enqueueMessageCheck(
        groupJid,
        threadTs || msg.threadTs,
      );
    }
  }
}
