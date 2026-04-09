import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

function ensureIpcDir(groupFolder: string): string {
  const dir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJobsSnapshot(
  groupFolder: string,
  isMain: boolean,
  jobs: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = ensureIpcDir(groupFolder);

  // Main sees all jobs, others only see their own
  const filteredJobs = isMain
    ? jobs
    : jobs.filter((j) => j.groupFolder === groupFolder);

  const jobsFile = path.join(groupIpcDir, 'current_jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(filteredJobs, null, 2));
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = ensureIpcDir(groupFolder);

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Write recent activity snapshot for the container to read.
 * Gives agents awareness of recent channel activity and active containers.
 */
export function writeRecentActivitySnapshot(
  groupFolder: string,
  channels: Array<{
    jid: string;
    name: string;
    role: string;
    messages: Array<{
      sender_name: string;
      content: string;
      timestamp: string;
      is_bot: boolean;
      thread_ts: string | null;
    }>;
  }>,
  activeContainers: Array<{ group_folder: string; agent_name: string }>,
  lookbackMinutes: number,
): void {
  const groupIpcDir = ensureIpcDir(groupFolder);

  const activityFile = path.join(groupIpcDir, 'recent_activity.json');
  fs.writeFileSync(
    activityFile,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        lookback_minutes: lookbackMinutes,
        channels,
        active_containers: activeContainers,
      },
      null,
      2,
    ),
  );
}
