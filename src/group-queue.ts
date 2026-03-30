import { ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const MAX_IDLE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Composite queue key: chatJid + threadTs.
 * Enables per-thread parallel container execution.
 * Channel-root messages and scheduled tasks use '__root__' sentinel.
 */
function queueKey(chatJid: string, threadTs?: string | null): string {
  return `${chatJid}::${threadTs || '__root__'}`;
}

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  threadKey: string; // threadTs or '__root__'
  chatJid: string; // original chatJid (for drain resolution)
  retryCount: number;
  lastActivity: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingSlots: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, threadTs?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(chatJid: string, threadTs?: string | null): GroupState {
    const key = queueKey(chatJid, threadTs);
    let state = this.groups.get(key);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        threadKey: threadTs || '__root__',
        chatJid,
        retryCount: 0,
        lastActivity: Date.now(),
      };
      this.groups.set(key, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, threadTs?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  /**
   * Check if a group has any active container (across all threads).
   */
  isActive(groupJid: string): boolean {
    for (const [key, state] of this.groups) {
      if (key.startsWith(groupJid + '::') && state.active) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if enqueueing would actually block (hit concurrency limit or
   * same-thread container active). Used by busy reaction logic.
   */
  wouldQueue(groupJid: string, threadTs?: string | null): boolean {
    const state = this.groups.get(queueKey(groupJid, threadTs));
    if (state?.active) return true;
    return this.activeCount >= MAX_CONCURRENT_CONTAINERS;
  }

  enqueueMessageCheck(groupJid: string, threadTs?: string | null): void {
    if (this.shuttingDown) return;

    const key = queueKey(groupJid, threadTs);
    const state = this.getGroup(groupJid, threadTs);
    state.lastActivity = Date.now();

    if (state.active) {
      state.pendingMessages = true;
      logger.debug(
        { groupJid, threadTs: threadTs || '__root__' },
        'Container active for thread, message queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingSlots.includes(key)) {
        this.waitingSlots.push(key);
      }
      logger.debug(
        {
          groupJid,
          threadTs: threadTs || '__root__',
          activeCount: this.activeCount,
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, threadTs, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    // Tasks always run on the __root__ slot
    const key = queueKey(groupJid, null);
    const state = this.getGroup(groupJid, null);
    state.lastActivity = Date.now();

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid, null);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingSlots.includes(key)) {
        this.waitingSlots.push(key);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(key, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    threadTs: string | null | undefined,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid, threadTs);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending on this slot, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string, threadTs?: string | null): void {
    const state = this.getGroup(groupJid, threadTs);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, threadTs);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Routes to thread-specific IPC input directory.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    threadTs: string | null | undefined,
    text: string,
  ): boolean {
    const state = this.getGroup(groupJid, threadTs);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const threadKey = threadTs || '__root__';
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      state.groupFolder,
      'input',
      threadKey,
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, threadTs?: string | null): void {
    const state = this.getGroup(groupJid, threadTs);
    if (!state.active || !state.groupFolder) return;

    const threadKey = threadTs || '__root__';
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      state.groupFolder,
      'input',
      threadKey,
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Stop the active container for a specific thread slot.
   * Returns true if a container was stopped, false if nothing was running.
   */
  async stopGroup(
    groupJid: string,
    threadTs?: string | null,
  ): Promise<boolean> {
    const key = queueKey(groupJid, threadTs);
    const state = this.groups.get(key);
    if (!state || !state.active) return false;

    if (state.containerName) {
      try {
        await new Promise<void>((resolve, reject) => {
          exec(
            stopContainer(state.containerName!),
            { timeout: 15000 },
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        });
      } catch (err) {
        // Fallback to process kill
        if (state.process && !state.process.killed) {
          state.process.kill('SIGKILL');
        }
      }
    } else if (state.process && !state.process.killed) {
      state.process.kill('SIGKILL');
    }

    state.active = false;
    state.process = null;
    state.containerName = null;
    state.groupFolder = null;
    state.idleWaiting = false;
    // Do NOT clear pendingMessages or pendingTasks — preserve the queue
    this.activeCount--;
    this.drainWaiting();

    return true;
  }

  /**
   * Get which group folders currently have active containers.
   * Used by recent activity snapshot to show agents what else is running.
   */
  getActiveGroups(): Array<{
    groupFolder: string;
    isTaskContainer: boolean;
  }> {
    const seen = new Set<string>();
    const result: Array<{
      groupFolder: string;
      isTaskContainer: boolean;
    }> = [];
    for (const [_key, state] of this.groups) {
      if (state.active && state.groupFolder && !seen.has(state.groupFolder)) {
        seen.add(state.groupFolder);
        result.push({
          groupFolder: state.groupFolder,
          isTaskContainer: state.isTaskContainer,
        });
      }
    }
    return result;
  }

  private async runForGroup(
    chatJid: string,
    threadTs: string | null | undefined,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const key = queueKey(chatJid, threadTs);
    const state = this.getGroup(chatJid, threadTs);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.lastActivity = Date.now();
    this.activeCount++;

    logger.debug(
      {
        chatJid,
        threadTs: threadTs || '__root__',
        reason,
        activeCount: this.activeCount,
      },
      'Starting container for thread',
    );

    try {
      if (this.processMessagesFn) {
        const effectiveThreadTs =
          !threadTs || threadTs === '__root__' ? undefined : threadTs;
        const success = await this.processMessagesFn(
          chatJid,
          effectiveThreadTs,
        );
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(chatJid, threadTs, state);
        }
      }
    } catch (err) {
      logger.error(
        { chatJid, threadTs: threadTs || '__root__', err },
        'Error processing messages for thread',
      );
      this.scheduleRetry(chatJid, threadTs, state);
    } finally {
      this.cleanupThreadIpc(state.groupFolder, threadTs);
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(key);
    }
  }

  /**
   * Clean up thread-specific IPC input directory after container exits.
   * Removes the _close sentinel and the directory if empty.
   */
  private cleanupThreadIpc(
    groupFolder: string | null,
    threadTs: string | null | undefined,
  ): void {
    if (!groupFolder) return;
    const threadKey = threadTs || '__root__';
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      groupFolder,
      'input',
      threadKey,
    );
    try {
      // Remove _close sentinel and any leftover input files
      const files = fs.readdirSync(inputDir);
      for (const file of files) {
        fs.unlinkSync(path.join(inputDir, file));
      }
      fs.rmdirSync(inputDir);
    } catch {
      // Directory may not exist or already cleaned — ignore
    }
  }

  private async runTask(key: string, task: QueuedTask): Promise<void> {
    const state = this.groups.get(key);
    if (!state) return;
    state.active = true;
    state.lastActivity = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { key, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ key, taskId: task.id, err }, 'Error running task');
    } finally {
      this.cleanupThreadIpc(
        state.groupFolder,
        state.threadKey === '__root__' ? null : state.threadKey,
      );
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(key);
    }
  }

  private scheduleRetry(
    chatJid: string,
    threadTs: string | null | undefined,
    state: GroupState,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { chatJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { chatJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatJid, threadTs);
      }
    }, delayMs);
  }

  private drainGroup(key: string): void {
    if (this.shuttingDown) return;

    const state = this.groups.get(key);
    if (!state) return;

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(key, task).catch((err) =>
        logger.error(
          { key, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      const threadTs = state.threadKey === '__root__' ? null : state.threadKey;
      this.runForGroup(state.chatJid, threadTs, 'drain').catch((err) =>
        logger.error({ key, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }

    // Evict idle slots with no pending work to prevent unbounded Map growth.
    // Don't evict if a retry is scheduled (retryCount > 0) — the retry callback needs the state.
    if (state.retryCount === 0) {
      this.groups.delete(key);
    } else if (
      Date.now() - state.lastActivity > MAX_IDLE_AGE_MS &&
      state.pendingTasks.length === 0 &&
      !state.pendingMessages
    ) {
      logger.info({ key, ageMs: Date.now() - state.lastActivity }, 'Evicting stale queue entry');
      this.groups.delete(key);
    }

    // Check if other slots are waiting
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingSlots.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingSlots.shift()!;
      const state = this.groups.get(nextKey);
      if (!state) continue;

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextKey, task).catch((err) =>
          logger.error(
            { key: nextKey, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        const threadTs =
          state.threadKey === '__root__' ? null : state.threadKey;
        this.runForGroup(state.chatJid, threadTs, 'drain').catch((err) =>
          logger.error(
            { key: nextKey, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this slot
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    const activeContainers: string[] = [];
    for (const [_key, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
