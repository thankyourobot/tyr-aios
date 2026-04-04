import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import type { AppState } from './app-state.js';
import { runContainerAgent } from './container-runner.js';
import { ContainerOutput } from './types.js';
import {
  getAllTasks,
  getGroupByFolder,
  getJidsForFolder,
  getMessagesSinceIncludingBots,
  getThreadSession,
  setSession,
  setThreadSession,
  deleteSession,
  deleteThreadSession,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import type { GroupManager } from './group-manager.js';
import { buildThreadJid, channelJid, type ChannelJid } from './jid.js';
import { logger } from './logger.js';
import { findChannel } from './router.js';
import {
  writeGroupsSnapshot,
  writeRecentActivitySnapshot,
  writeTasksSnapshot,
} from './snapshot-writer.js';
import { FileAttachment, RegisteredGroup } from './types.js';

export class AgentExecutor {
  constructor(
    private state: AppState,
    private groupManager: GroupManager,
  ) {}

  async downloadFiles(
    files: FileAttachment[],
    groupFolder: string,
  ): Promise<string> {
    if (!this.state.slackBotToken || files.length === 0) return '';

    const uploadsDir = path.join(
      resolveGroupFolderPath(groupFolder),
      'uploads',
    );
    fs.mkdirSync(uploadsDir, { recursive: true });

    const annotations: string[] = [];
    for (const file of files) {
      const timestamp = Math.floor(Date.now() / 1000);
      const filename = `${timestamp}-${file.name}`;
      const filePath = path.join(uploadsDir, filename);

      try {
        const response = await fetch(file.url, {
          headers: { Authorization: `Bearer ${this.state.slackBotToken}` },
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

  async runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: ChannelJid,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    toggleState?: { verbose: boolean; thinking: boolean; planMode: boolean },
    threadTs?: string,
    rewindOpts?: { sourceSessionId: string; resumeSessionAt: string },
    replyThreadTs?: string,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    // Thread-aware session routing
    const threadSessionId = threadTs
      ? getThreadSession(group.folder, threadTs)
      : undefined;
    const isNewThread = !!threadTs && !threadSessionId;
    const parentSessionId = this.state.sessions[group.folder];
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
    const availableGroups = this.groupManager.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.state.registeredGroups)),
    );

    // Write recent activity snapshot for heartbeat awareness
    const lookbackMinutes = 30;
    const sinceTimestamp = new Date(
      Date.now() - lookbackMinutes * 60 * 1000,
    ).toISOString();
    const agentJids = getJidsForFolder(group.folder);
    const activityChannels = agentJids.map(({ jid, name, channelRole }) => {
      const msgs = getMessagesSinceIncludingBots(
        channelJid(jid),
        sinceTimestamp,
        50,
      );
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
    const activeGroups = this.state.queue
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
          if (output.sessionReset) {
            // LCM compaction: clear session so next container starts fresh
            if (threadTs) {
              deleteThreadSession(group.folder, threadTs);
            } else {
              delete this.state.sessions[group.folder];
              deleteSession(group.folder);
            }
            logger.info({ group: group.folder, threadTs }, 'Session reset (LCM compaction)');
          } else if (output.newSessionId) {
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
              this.state.sessions[group.folder] = output.newSessionId;
              setSession(group.folder, output.newSessionId);
            }
          }
          await onOutput(output);
        }
      : undefined;

    // Use toggle state passed from caller (with thread context), fall back to group default
    const effectiveToggle = toggleState || this.state.getToggleState(chatJid);
    if (effectiveToggle.planMode) {
      logger.info(
        { chatJid, planMode: true },
        'ContainerInput will have planMode=true',
      );
    }

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
          planMode: effectiveToggle.planMode,
          maxThinkingTokens: effectiveToggle.thinking ? 10000 : undefined,
          filebrowserBaseUrl: this.state.filebrowserBaseUrl || undefined,
          threadTs,
          replyThreadTs,
          forkFromSession: shouldFork,
          resumeSessionAt: rewindOpts?.resumeSessionAt,
        },
        (proc, containerName) =>
          this.state.queue.registerProcess(
            chatJid,
            threadTs,
            proc,
            containerName,
            group.folder,
          ),
        wrappedOnOutput,
      );

      if (output.sessionReset) {
        if (threadTs) {
          deleteThreadSession(group.folder, threadTs);
        } else {
          delete this.state.sessions[group.folder];
          deleteSession(group.folder);
        }
      } else if (output.newSessionId) {
        if (threadTs && (isNewThread || rewindOpts)) {
          setThreadSession(
            group.folder,
            threadTs,
            output.newSessionId,
            rewindOpts?.sourceSessionId || parentSessionId,
          );
        } else if (!threadTs) {
          this.state.sessions[group.folder] = output.newSessionId;
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

  async rewindSession(params: {
    groupFolder: string;
    chatJid: ChannelJid;
    sourceThreadTs: string;
    newThreadTs: string;
    sdkUuid: string;
  }): Promise<void> {
    const { groupFolder, chatJid, sourceThreadTs, newThreadTs, sdkUuid } =
      params;

    // Get source session (thread session or channel root)
    const sourceSessionId =
      getThreadSession(groupFolder, sourceThreadTs) ||
      this.state.sessions[groupFolder];
    if (!sourceSessionId) {
      logger.error(
        { groupFolder, sourceThreadTs },
        'No source session found for rewind',
      );
      return;
    }

    const group = Object.values(this.state.registeredGroups).find(
      (g) => g.folder === groupFolder,
    );
    if (!group) {
      logger.error({ groupFolder }, 'No group found for rewind');
      return;
    }

    const channel = findChannel(this.state.channels, chatJid);
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
      const result = await this.runAgent(
        group,
        '[Session forked from previous thread. Continue from where we left off.]',
        chatJid,
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
        this.state.getToggleState(syntheticJid, newThreadTs),
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
}
