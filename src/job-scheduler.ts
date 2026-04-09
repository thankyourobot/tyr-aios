import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { ContainerOutput } from './types.js';
import { writeJobsSnapshot } from './snapshot-writer.js';
import {
  getAllJobs,
  getDueJobs,
  getJobById,
  logJobRun,
  updateJob,
  updateJobAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const MAX_CATCHUP_ITERATIONS = 1000;
import { RegisteredGroup, ScheduledJob } from './types.js';

/**
 * Compute the next run time for a recurring job, anchored to the
 * job's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based jobs.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(job: ScheduledJob): string | null {
  if (job.schedule_type === 'once') return null;

  const now = Date.now();

  if (job.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(job.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (job.schedule_type === 'interval') {
    const ms = parseInt(job.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { jobId: job.id, value: job.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(job.next_run!).getTime() + ms;
    let iterations = 0;
    while (next <= now) {
      next += ms;
      if (++iterations >= MAX_CATCHUP_ITERATIONS) {
        logger.warn(
          { jobId: job.id, iterations, intervalMs: ms },
          'Catch-up loop exceeded max iterations, snapping to now',
        );
        next = now + ms;
        break;
      }
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runJob(
  job: ScheduledJob,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(job.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateJob(job.id, { status: 'paused' });
    logger.error(
      { jobId: job.id, groupFolder: job.group_folder, error },
      'Job has invalid group folder',
    );
    logJobRun({
      job_id: job.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { jobId: job.id, group: job.group_folder },
    'Running scheduled job',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === job.group_folder,
  );

  if (!group) {
    logger.error(
      { jobId: job.id, groupFolder: job.group_folder },
      'Group not found for job',
    );
    logJobRun({
      job_id: job.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${job.group_folder}`,
    });
    return;
  }

  // Update jobs snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const jobs = getAllJobs();
  writeJobsSnapshot(
    job.group_folder,
    isMain,
    jobs.map((j) => ({
      id: j.id,
      groupFolder: j.group_folder,
      prompt: j.prompt,
      schedule_type: j.schedule_type,
      schedule_value: j.schedule_value,
      status: j.status,
      next_run: j.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    job.context_mode === 'group' ? sessions[job.group_folder] : undefined;

  // After the job produces a result, close the container promptly.
  // Jobs are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const JOB_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ jobId: job.id }, 'Closing job container after result');
      deps.queue.closeStdin(job.chat_jid, null, job.group_folder);
    }, JOB_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: job.prompt,
        sessionId,
        groupFolder: job.group_folder,
        chatJid: job.chat_jid,
        isMain,
        isScheduledJob: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(job.chat_jid, proc, containerName, job.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(job.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(job.chat_jid, null, job.group_folder);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only jobs)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { jobId: job.id, durationMs: Date.now() - startTime },
      'Job completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: job.id, error }, 'Job failed');
  }

  const durationMs = Date.now() - startTime;

  logJobRun({
    job_id: job.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(job);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateJobAfterRun(job.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueJobs = getDueJobs();
      if (dueJobs.length > 0) {
        logger.info({ count: dueJobs.length }, 'Found due jobs');
      }

      for (const job of dueJobs) {
        // Re-check job status in case it was paused/cancelled
        const currentJob = getJobById(job.id);
        if (!currentJob || currentJob.status !== 'active') {
          continue;
        }

        deps.queue.enqueueJob(
          currentJob.chat_jid,
          currentJob.id,
          () => runJob(currentJob, deps),
          currentJob.group_folder,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
