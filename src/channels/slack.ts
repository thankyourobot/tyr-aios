import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  updateChatName,
  getThreadResponseUuids,
  getResponseUuid,
  getMessagesSince,
  getThreadSession,
  getThreadMessages,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { buildThreadJid, parseSlackJid } from '../jid.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  FileAttachment,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Resolve a bot user ID to the agent's display name. Used for multi-agent sender identification. */
  resolveBotSenderName?: (
    botId: string,
    username?: string,
    userId?: string,
  ) => string | undefined;
  onRewind?: (params: {
    groupFolder: string;
    chatJid: string;
    sourceThreadTs: string;
    newThreadTs: string;
    sdkUuid: string;
  }) => Promise<void>;
  /** Handle slash commands. Returns the response text (shown ephemerally). */
  onSlashCommand?: (params: {
    command: string;
    text: string;
    channelId: string;
    userId: string;
    threadTs?: string;
    triggerId: string;
  }) => Promise<string | null>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private botId: string | undefined; // bot_id from auth.test (for distinguishing our bot from other agent bots)
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    opts?: SendMessageOpts;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private agentClients = new Map<string, WebClient>(); // per-agent bot token → WebClient

  // Track latest message context per JID for typing indicator
  private latestMessageContext = new Map<
    string,
    { channel: string; threadTs?: string; messageTs: string }
  >();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Rewind button action handler
    this.app.action('rewind_open_modal', async ({ ack, body, client }) => {
      await ack();
      try {
        const action = (body as any).actions[0];
        const { threadTs, groupFolder, channelId } = JSON.parse(action.value);
        const triggerId = (body as any).trigger_id;

        // Get assistant messages with UUID mappings for the picker
        const uuids = getThreadResponseUuids(groupFolder, threadTs);
        if (uuids.length === 0) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: (body as any).user.id,
            text: 'No rewind points available.',
          });
          return;
        }

        // Build options from USER messages — each represents "fork before I sent this"
        const jid = `slack:${channelId}`;
        const threadMsgs = getThreadMessages(jid, threadTs);
        const userMsgs = threadMsgs.filter((m) => !m.is_bot_message);

        // For each user message, find the assistant UUID that came just before it
        const options = userMsgs
          .map((msg) => {
            // Find the last UUID where slackTs < this user message's id
            let precedingUuid: (typeof uuids)[0] | null = null;
            for (let i = uuids.length - 1; i >= 0; i--) {
              if (uuids[i].slackTs < msg.id) {
                precedingUuid = uuids[i];
                break;
              }
            }
            if (!precedingUuid) return null; // No assistant response before this — can't fork
            const content = msg.content.slice(0, 75);
            return {
              text: {
                type: 'plain_text' as const,
                text: content.length >= 75 ? content + '...' : content,
              },
              value: precedingUuid.slackTs,
            };
          })
          .filter((o): o is NonNullable<typeof o> => o !== null)
          .reverse()
          .slice(0, 10); // Most recent first, limit 10

        await client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'rewind_modal',
            title: { type: 'plain_text', text: 'Rewind conversation' },
            submit: { type: 'plain_text', text: 'Rewind' },
            close: { type: 'plain_text', text: 'Cancel' },
            private_metadata: JSON.stringify({
              channelId,
              threadTs,
              groupFolder,
            }),
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'Select a point to rewind to. A new thread will be created with context up to that message.',
                },
              },
              {
                type: 'input',
                block_id: 'rewind_point',
                label: { type: 'plain_text', text: 'Rewind to' },
                element: {
                  type: 'radio_buttons',
                  action_id: 'selected_message',
                  initial_option: options[0],
                  options,
                },
              },
            ],
          } as any,
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to open rewind modal');
      }
    });

    // Rewind modal submission handler
    this.app.view('rewind_modal', async ({ ack, body, view, client }) => {
      await ack();
      try {
        const { channelId, threadTs, groupFolder } = JSON.parse(
          view.private_metadata,
        );
        const selectedSlackTs =
          view.state.values.rewind_point.selected_message.selected_option
            ?.value;
        if (!selectedSlackTs) {
          logger.warn({}, 'No message selected in rewind modal');
          return;
        }

        // Look up SDK UUID
        const sdkUuid = getResponseUuid(groupFolder, threadTs, selectedSlackTs);
        if (!sdkUuid) {
          logger.warn(
            { groupFolder, threadTs, selectedSlackTs },
            'No SDK UUID found for rewind point',
          );
          return;
        }

        // Find the user message AFTER the fork point (the message the user chose to fork before)
        const jid = `slack:${channelId}`;
        const threadMsgs = getThreadMessages(jid, threadTs);
        let msgPreview = '';
        for (const m of threadMsgs) {
          if (!m.is_bot_message && m.id > selectedSlackTs) {
            msgPreview = m.content.slice(0, 100);
            break;
          }
        }

        // Create source thread link
        const threadLink = `https://thankyourobot.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;

        // Fetch the assistant's response at the fork point from Slack API
        const msgLink = `https://thankyourobot.slack.com/archives/${channelId}/p${selectedSlackTs.replace('.', '')}?thread_ts=${threadTs}&cid=${channelId}`;
        let agentResponseText = '';
        try {
          const replies = await client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            latest: String(parseFloat(selectedSlackTs) + 0.001),
            oldest: String(parseFloat(selectedSlackTs) - 0.001),
            inclusive: true,
            limit: 1,
          });
          const agentMsg = replies.messages?.find(
            (m) => m.ts === selectedSlackTs,
          );
          if (agentMsg?.text) {
            agentResponseText = agentMsg.text;
          }
        } catch (err) {
          logger.warn(
            { err },
            'Failed to fetch agent response for rewind context',
          );
        }

        // Post a new top-level message to create the rewind thread
        const group = this.opts.registeredGroups()[jid];
        const rootText = msgPreview
          ? `Rewound from <${threadLink}|source thread>. Forked before: \"${msgPreview}\"`
          : `Rewound from <${threadLink}|source thread>.`;
        const postResult = await client.chat.postMessage({
          channel: channelId,
          text: rootText,
          ...(group?.displayName ? { username: group.displayName } : {}),
          ...(group?.displayIconUrl
            ? { icon_url: group.displayIconUrl }
            : group?.displayEmoji
              ? { icon_emoji: `:${group.displayEmoji}:` }
              : {}),
        });

        const newThreadTs = postResult.ts;
        if (!newThreadTs) {
          logger.warn('Failed to get ts from rewind thread creation');
          return;
        }

        // Post the agent's last response as the first reply in the new thread with a link
        if (agentResponseText) {
          const contextText =
            agentResponseText.length > 500
              ? agentResponseText.slice(0, 500) + '...'
              : agentResponseText;
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: newThreadTs,
            text: `<${msgLink}|Last response before fork>:\n\n${contextText}`,
            ...(group?.displayName ? { username: group.displayName } : {}),
            ...(group?.displayIconUrl
              ? { icon_url: group.displayIconUrl }
              : group?.displayEmoji
                ? { icon_emoji: `:${group.displayEmoji}:` }
                : {}),
          });
        }

        // Trigger the rewind via callback
        if (this.opts.onRewind) {
          await this.opts.onRewind({
            groupFolder,
            chatJid: jid,
            sourceThreadTs: threadTs,
            newThreadTs,
            sdkUuid,
          });
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to process rewind submission');
      }
    });

    // --- Slash command handlers ---
    const slashCommands = ['stop', 'verbose', 'thinking', 'rewind', 'agents'];
    for (const cmd of slashCommands) {
      this.app.command(`/${cmd}`, async ({ command, ack }) => {
        await ack();
        if (!this.opts.onSlashCommand) return;
        try {
          const response = await this.opts.onSlashCommand({
            command: cmd,
            text: command.text || '',
            channelId: command.channel_id,
            userId: command.user_id,
            threadTs: (command as any).thread_ts || undefined,
            triggerId: command.trigger_id,
          });
          if (response) {
            // Post ephemeral response (only the user sees it)
            await this.app.client.chat.postEphemeral({
              channel: command.channel_id,
              user: command.user_id,
              text: response,
              ...((command as any).thread_ts
                ? { thread_ts: (command as any).thread_ts }
                : {}),
            });
          }
        } catch (err) {
          logger.warn({ cmd, err }, 'Slash command handler error');
        }
      });
    }

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      // Allow messages with files but no text
      if (!msg.text && !(event as { files?: unknown[] }).files?.length) return;

      // Capture thread_ts for thread reply support
      const threadTs = (event as { thread_ts?: string }).thread_ts || undefined;

      const channelJid = `slack:${msg.channel}`;
      const targetJid = threadTs
        ? buildThreadJid(channelJid, threadTs)
        : channelJid;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery (use channel JID, not synthetic)
      this.opts.onChatMetadata(
        channelJid,
        timestamp,
        undefined,
        'slack',
        isGroup,
      );

      // Check if this JID is registered; if not, we'll let the message loop
      // handle it via main group fallback. Don't reroute — keep original JID
      // so replies go back to the correct channel (critical for DMs).
      const groups = this.opts.registeredGroups();
      if (!groups[channelJid]) {
        const hasMain = Object.values(groups).some((g) => g.isMain);
        if (!hasMain) return; // No main group configured, drop message
      }

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      // is_from_me: only true for THIS app's bot, not other agent bots
      const isFromMe =
        msg.user === this.botUserId ||
        (!!msg.bot_id && msg.bot_id === this.botId);

      let senderName: string;
      if (isBotMessage) {
        // Multi-agent: identify which agent sent this bot message
        // Pass bot_id (B-prefix), user (U-prefix bot user ID), and username override
        const resolvedName = this.opts.resolveBotSenderName?.(
          msg.bot_id || '',
          (msg as any).username,
          msg.user,
        );
        senderName = resolvedName || ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      // content is now guaranteed to be a string (empty if file-only message)
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Extract file attachments from Slack event
      const eventFiles = (
        event as {
          files?: Array<{
            id: string;
            name: string;
            mimetype: string;
            size: number;
            url_private_download: string;
          }>;
        }
      ).files;
      const files: FileAttachment[] | undefined = eventFiles?.map((f) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        url: f.url_private_download,
      }));

      // If no text but files attached, hint the agent about the shared files
      if (!content && files && files.length > 0) {
        const names = files.map((f) => f.name).join(', ');
        content = `[shared: ${names}]`;
      }

      this.opts.onMessage(targetJid, {
        id: msg.ts,
        chat_jid: targetJid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content: content || '',
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isBotMessage,
        threadTs,
        files,
      });

      // Track message context for typing indicator
      if (!isBotMessage && this.connected) {
        this.latestMessageContext.set(targetJid, {
          channel: msg.channel,
          threadTs: threadTs || msg.ts,
          messageTs: msg.ts,
        });
      }
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string;
      logger.info(
        { botUserId: this.botUserId, botId: this.botId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const { channelId } = parseSlackJid(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, opts });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Use per-agent bot token if provided, otherwise default app client
      const client = this.getClient(opts?.botToken);
      const postOpts: Record<string, string> = {};
      // Only use username/icon overrides when posting via the default client
      // (per-agent clients post as their own bot identity natively)
      if (!opts?.botToken) {
        if (opts?.displayName) postOpts.username = opts.displayName;
        if (opts?.displayIconUrl) postOpts.icon_url = opts.displayIconUrl;
        else if (opts?.displayEmoji)
          postOpts.icon_emoji = `:${opts.displayEmoji}:`;
      }
      if (opts?.threadTs) postOpts.thread_ts = opts.threadTs;

      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        const postResult = await client.chat.postMessage({
          channel: channelId,
          text,
          ...postOpts,
        });
        if (opts?.onPosted && postResult.ts) {
          opts.onPosted(postResult.ts);
        }
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...postOpts,
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, opts });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendVerboseMessage(
    jid: string,
    text: string,
    type: 'verbose' | 'thinking',
    opts?: SendMessageOpts,
  ): Promise<void> {
    const { channelId } = parseSlackJid(jid);
    const prefix = type === 'thinking' ? '💭 ' : '';
    const blocks = [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${prefix}${text}` }],
      },
    ];
    const fallback = `${prefix}${text}`;
    try {
      const client = this.getClient(opts?.botToken);
      const postOpts: Record<string, string> = {};
      if (!opts?.botToken) {
        if (opts?.displayName) postOpts.username = opts.displayName;
        if (opts?.displayIconUrl) postOpts.icon_url = opts.displayIconUrl;
        else if (opts?.displayEmoji)
          postOpts.icon_emoji = `:${opts.displayEmoji}:`;
      }
      if (opts?.threadTs) postOpts.thread_ts = opts.threadTs;

      await client.chat.postMessage({
        channel: channelId,
        text: fallback,
        blocks: blocks as any,
        ...postOpts,
      });
    } catch (err) {
      logger.warn({ jid, type, err }, 'Failed to send verbose message');
    }
  }

  async sendBlocks(
    jid: string,
    blocks: unknown[],
    fallbackText: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const { channelId } = parseSlackJid(jid);
    try {
      const postOpts: Record<string, string> = {};
      if (opts?.displayName) postOpts.username = opts.displayName;
      if (opts?.displayIconUrl) postOpts.icon_url = opts.displayIconUrl;
      else if (opts?.displayEmoji)
        postOpts.icon_emoji = `:${opts.displayEmoji}:`;
      if (opts?.threadTs) postOpts.thread_ts = opts.threadTs;

      await this.app.client.chat.postMessage({
        channel: channelId,
        text: fallbackText,
        blocks: blocks as any,
        ...postOpts,
      });
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send blocks message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async postRewindButton(
    jid: string,
    userId: string,
    threadTs: string,
    groupFolder: string,
  ): Promise<void> {
    const { channelId } = parseSlackJid(jid);
    try {
      await this.app.client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: 'Select a rewind point',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Rewind conversation* \u2014 select a point to fork from:',
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Choose rewind point' },
              action_id: 'rewind_open_modal',
              value: JSON.stringify({ threadTs, groupFolder, channelId }),
            },
          },
        ] as any,
      });
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to post rewind button');
    }
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    botToken?: string,
  ): Promise<void> {
    const ctx = this.latestMessageContext.get(jid);
    if (!ctx) return;

    try {
      // Use per-agent token if provided, otherwise default app client
      const client = this.getClient(botToken);
      if (isTyping) {
        await client.apiCall('assistant.threads.setStatus', {
          channel_id: ctx.channel,
          thread_ts: ctx.threadTs,
          status: 'is thinking...',
        });
      } else {
        await client.apiCall('assistant.threads.setStatus', {
          channel_id: ctx.channel,
          thread_ts: ctx.threadTs,
          status: '',
        });
      }
    } catch (err) {
      logger.debug({ jid, isTyping, err }, 'Typing indicator failed');
    }
  }

  async addReaction(
    jid: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    const { channelId } = parseSlackJid(jid);
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: emoji.replace(/:/g, ''),
      });
      logger.debug({ jid, messageTs, emoji }, 'Reaction added');
    } catch (err) {
      logger.warn({ jid, messageTs, emoji, err }, 'Failed to add reaction');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  /** Get a WebClient for a per-agent bot token, or fall back to the default app client. */
  private getClient(botToken?: string): WebClient {
    if (!botToken) return this.app.client;
    let client = this.agentClients.get(botToken);
    if (!client) {
      client = new WebClient(botToken);
      this.agentClients.set(botToken, client);
    }
    return client;
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const { channelId } = parseSlackJid(item.jid);
        const postOpts: Record<string, string> = {};
        if (item.opts?.displayName) postOpts.username = item.opts.displayName;
        if (item.opts?.displayIconUrl)
          postOpts.icon_url = item.opts.displayIconUrl;
        else if (item.opts?.displayEmoji)
          postOpts.icon_emoji = `:${item.opts.displayEmoji}:`;
        if (item.opts?.threadTs) postOpts.thread_ts = item.opts.threadTs;
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...postOpts,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
