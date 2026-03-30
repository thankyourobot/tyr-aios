import { getDb } from '../db.js';

export function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(key, value);
}

export function getSession(groupFolder: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
    )
    .run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

export function getThreadSession(
  groupFolder: string,
  threadTs: string,
): string | undefined {
  const row = getDb()
    .prepare(
      'SELECT session_id FROM thread_sessions WHERE group_folder = ? AND thread_ts = ?',
    )
    .get(groupFolder, threadTs) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setThreadSession(
  groupFolder: string,
  threadTs: string,
  sessionId: string,
  parentSessionId?: string,
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO thread_sessions (group_folder, thread_ts, session_id, parent_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      groupFolder,
      threadTs,
      sessionId,
      parentSessionId ?? null,
      new Date().toISOString(),
    );
}

export function getAllThreadSessions(
  groupFolder: string,
): Record<string, string> {
  const rows = getDb()
    .prepare(
      'SELECT thread_ts, session_id FROM thread_sessions WHERE group_folder = ?',
    )
    .all(groupFolder) as Array<{ thread_ts: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.thread_ts] = row.session_id;
  }
  return result;
}

export function storeResponseUuid(
  groupFolder: string,
  threadTs: string,
  slackTs: string,
  sdkUuid: string,
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO response_uuids (group_folder, thread_ts, slack_ts, sdk_uuid, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(groupFolder, threadTs, slackTs, sdkUuid, new Date().toISOString());
}

export function getResponseUuid(
  groupFolder: string,
  threadTs: string,
  slackTs: string,
): string | undefined {
  const row = getDb()
    .prepare(
      'SELECT sdk_uuid FROM response_uuids WHERE group_folder = ? AND thread_ts = ? AND slack_ts = ?',
    )
    .get(groupFolder, threadTs, slackTs) as { sdk_uuid: string } | undefined;
  return row?.sdk_uuid;
}

export function getThreadResponseUuids(
  groupFolder: string,
  threadTs: string,
): Array<{ slackTs: string; sdkUuid: string }> {
  const rows = getDb()
    .prepare(
      'SELECT slack_ts, sdk_uuid FROM response_uuids WHERE group_folder = ? AND thread_ts = ? ORDER BY created_at',
    )
    .all(groupFolder, threadTs) as Array<{
    slack_ts: string;
    sdk_uuid: string;
  }>;
  return rows.map((r) => ({ slackTs: r.slack_ts, sdkUuid: r.sdk_uuid }));
}
