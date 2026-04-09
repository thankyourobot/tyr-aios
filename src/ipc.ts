import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createJob, deleteJob, getJobById, updateJob } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { channelJid } from './jid.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcSendMessageOpts {
  threadTs?: string;
  botToken?: string;
  displayName?: string;
  displayEmoji?: string;
  displayIconUrl?: string;
}

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    opts?: IpcSendMessageOpts,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  /** Check if a group is registered in a channel (for multi-group authorization). */
  isGroupInChannel?: (chatJid: string, groupFolder: string) => boolean;
  /** Add emoji reaction to a message. */
  addReaction?: (
    jid: string,
    messageTs: string,
    emoji: string,
  ) => Promise<void>;
  /** Handle plan_ready IPC from plan mode hook. */
  onPlanReady?: (
    chatJid: string,
    groupFolder: string,
    plan: string,
    threadTs?: string,
  ) => Promise<void>;
  /** Handle ask_user IPC from plan mode hook. */
  onAskUser?: (
    chatJid: string,
    groupFolder: string,
    questions: unknown[],
    threadTs?: string,
  ) => Promise<void>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const commandsDir = path.join(ipcBaseDir, sourceGroup, 'commands');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const isChannelMember =
                  deps.isGroupInChannel?.(data.chatJid, sourceGroup) ?? false;
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup) ||
                  isChannelMember
                ) {
                  // Resolve sender identity from the source group's registration
                  const senderGroup = Object.values(registeredGroups).find(
                    (g) => g.folder === sourceGroup,
                  );
                  await deps.sendMessage(data.chatJid, data.text, {
                    threadTs: data.threadTs,
                    botToken: senderGroup?.botToken,
                    displayName: senderGroup?.displayName,
                    displayEmoji: senderGroup?.displayEmoji,
                    displayIconUrl: senderGroup?.displayIconUrl,
                  });
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      threadTs: data.threadTs,
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              // Handle plan_ready from plan mode hook
              if (data.type === 'plan_ready' && data.chatJid && data.plan) {
                const isAuthorized =
                  isMain ||
                  deps.isGroupInChannel?.(data.chatJid, sourceGroup) ||
                  registeredGroups[data.chatJid]?.folder === sourceGroup;
                if (isAuthorized && deps.onPlanReady) {
                  await deps.onPlanReady(
                    data.chatJid,
                    sourceGroup,
                    data.plan,
                    data.threadTs,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC plan_ready handled',
                  );
                } else if (!isAuthorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized plan_ready attempt blocked',
                  );
                }
              }
              // Handle ask_user from plan mode hook
              if (data.type === 'ask_user' && data.chatJid && data.questions) {
                const isAuthorized =
                  isMain ||
                  deps.isGroupInChannel?.(data.chatJid, sourceGroup) ||
                  registeredGroups[data.chatJid]?.folder === sourceGroup;
                if (isAuthorized && deps.onAskUser) {
                  await deps.onAskUser(
                    data.chatJid,
                    sourceGroup,
                    data.questions as unknown[],
                    data.threadTs,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC ask_user handled',
                  );
                } else if (!isAuthorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized ask_user attempt blocked',
                  );
                }
              }
              // Handle emoji reaction IPC action
              if (
                data.type === 'reaction' &&
                data.chatJid &&
                data.messageTs &&
                data.emoji
              ) {
                const isChannelMember =
                  deps.isGroupInChannel?.(data.chatJid, sourceGroup) ?? false;
                if (isMain || isChannelMember) {
                  if (deps.addReaction) {
                    await deps.addReaction(
                      data.chatJid,
                      data.messageTs,
                      data.emoji,
                    );
                    logger.info(
                      { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
                      'IPC reaction added',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process commands from this group's IPC directory
      try {
        if (fs.existsSync(commandsDir)) {
          const commandFiles = fs
            .readdirSync(commandsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of commandFiles) {
            const filePath = path.join(commandsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processJobIpc for authorization
              await processJobIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC command',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC commands directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processJobIpc(
  data: {
    type: string;
    jobId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_job':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = channelJid(data.targetJid as string);
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule job: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_job attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const jobId =
          data.jobId ||
          `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createJob({
          id: jobId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { jobId, sourceGroup, targetFolder, contextMode },
          'Job created via IPC',
        );
      }
      break;

    case 'pause_job':
      if (data.jobId) {
        const job = getJobById(data.jobId);
        if (job && (isMain || job.group_folder === sourceGroup)) {
          updateJob(data.jobId, { status: 'paused' });
          logger.info({ jobId: data.jobId, sourceGroup }, 'Job paused via IPC');
        } else {
          logger.warn(
            { jobId: data.jobId, sourceGroup },
            'Unauthorized job pause attempt',
          );
        }
      }
      break;

    case 'resume_job':
      if (data.jobId) {
        const job = getJobById(data.jobId);
        if (job && (isMain || job.group_folder === sourceGroup)) {
          updateJob(data.jobId, { status: 'active' });
          logger.info(
            { jobId: data.jobId, sourceGroup },
            'Job resumed via IPC',
          );
        } else {
          logger.warn(
            { jobId: data.jobId, sourceGroup },
            'Unauthorized job resume attempt',
          );
        }
      }
      break;

    case 'cancel_job':
      if (data.jobId) {
        const job = getJobById(data.jobId);
        if (job && (isMain || job.group_folder === sourceGroup)) {
          deleteJob(data.jobId);
          logger.info(
            { jobId: data.jobId, sourceGroup },
            'Job cancelled via IPC',
          );
        } else {
          logger.warn(
            { jobId: data.jobId, sourceGroup },
            'Unauthorized job cancel attempt',
          );
        }
      }
      break;

    case 'update_job':
      if (data.jobId) {
        const job = getJobById(data.jobId);
        if (!job) {
          logger.warn(
            { jobId: data.jobId, sourceGroup },
            'Job not found for update',
          );
          break;
        }
        if (!isMain && job.group_folder !== sourceGroup) {
          logger.warn(
            { jobId: data.jobId, sourceGroup },
            'Unauthorized job update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateJob>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedJob = {
            ...job,
            ...updates,
          };
          if (updatedJob.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedJob.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { jobId: data.jobId, value: updatedJob.schedule_value },
                'Invalid cron in job update',
              );
              break;
            }
          } else if (updatedJob.schedule_type === 'interval') {
            const ms = parseInt(updatedJob.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateJob(data.jobId, updates);
        logger.info(
          { jobId: data.jobId, sourceGroup, updates },
          'Job updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC command type');
  }
}
