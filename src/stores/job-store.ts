import { getDb } from '../db.js';
import type { ChannelJid } from '../jid.js';
import { ScheduledJob, JobRunLog } from '../types.js';

/** DB rows have chat_jid as string; cast to ChannelJid at boundary. */
type ScheduledJobRow = Omit<ScheduledJob, 'chat_jid'> & {
  chat_jid: string;
};
function castJob(row: ScheduledJobRow): ScheduledJob {
  return { ...row, chat_jid: row.chat_jid as ChannelJid };
}

export function createJob(
  job: Omit<ScheduledJob, 'last_run' | 'last_result'>,
): void {
  getDb()
    .prepare(
      `
    INSERT INTO scheduled_jobs (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      job.id,
      job.group_folder,
      job.chat_jid,
      job.prompt,
      job.schedule_type,
      job.schedule_value,
      job.context_mode || 'isolated',
      job.next_run,
      job.status,
      job.created_at,
    );
}

export function getJobById(id: string): ScheduledJob | undefined {
  const row = getDb()
    .prepare('SELECT * FROM scheduled_jobs WHERE id = ?')
    .get(id) as ScheduledJobRow | undefined;
  return row ? castJob(row) : undefined;
}

export function getJobsForGroup(groupFolder: string): ScheduledJob[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM scheduled_jobs WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledJobRow[];
  return rows.map(castJob);
}

export function getAllJobs(): ScheduledJob[] {
  const rows = getDb()
    .prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC')
    .all() as ScheduledJobRow[];
  return rows.map(castJob);
}

export function updateJob(
  id: string,
  updates: Partial<
    Pick<
      ScheduledJob,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  getDb()
    .prepare(`UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteJob(id: string): void {
  getDb().prepare('DELETE FROM job_run_logs WHERE job_id = ?').run(id);
  getDb().prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
}

export function getDueJobs(): ScheduledJob[] {
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(
      `
    SELECT * FROM scheduled_jobs
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledJobRow[];
  return rows.map(castJob);
}

export function updateJobAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    UPDATE scheduled_jobs
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
    )
    .run(nextRun, now, lastResult, nextRun, id);
}

export function logJobRun(log: JobRunLog): void {
  getDb()
    .prepare(
      `
    INSERT INTO job_run_logs (job_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      log.job_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    );
}
