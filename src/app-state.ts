import {
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRouterState,
} from './db.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { buildThreadJid, isSyntheticThreadJid } from './jid.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';

export const BUSY_EMOJI = 'hourglass_flowing_sand';

export class AppState {
  lastTimestamp = '';
  sessions: Record<string, string> = {};
  registeredGroups: Record<string, RegisteredGroup> = {};
  lastAgentTimestamp: Record<string, string> = {};
  messageLoopRunning = false;

  // Multi-agent index maps
  groupsByJid = new Map<string, RegisteredGroup[]>();
  groupsByFolder = new Map<string, { jid: string; group: RegisteredGroup }>();
  groupsByBotUserId = new Map<string, RegisteredGroup>();

  channels: Channel[] = [];
  queue: GroupQueue;

  // Track messages that got a "busy" reaction so we can remove it when processing starts
  pendingBusyReactions = new Map<
    string,
    Array<{ jid: string; messageTs: string }>
  >();

  // Per-thread toggle overrides (ephemeral — resets on restart)
  threadToggles = new Map<string, { verbose: boolean; thinking: boolean }>();

  // Env vars for file downloads
  slackBotToken?: string;
  filebrowserBaseUrl?: string;

  // Late-bound group resolver (set after GroupManager is created)
  private resolveGroupFn?: (jid: string) => RegisteredGroup | null;

  constructor() {
    this.queue = new GroupQueue();
  }

  setGroupResolver(fn: (jid: string) => RegisteredGroup | null): void {
    this.resolveGroupFn = fn;
  }

  /**
   * Canonical cursor key for lastAgentTimestamp.
   * Thread messages: synthetic JID (matches how messages are stored in DB).
   * Root messages: base JID as-is.
   */
  getCursorKey(baseJid: string, threadTs?: string | null): string {
    return threadTs ? buildThreadJid(baseJid, threadTs) : baseJid;
  }

  getToggleState(
    jid: string,
    threadTs?: string,
  ): { verbose: boolean; thinking: boolean } {
    // Synthetic JID already encodes the thread
    if (isSyntheticThreadJid(jid)) {
      const override = this.threadToggles.get(jid);
      if (override) return override;
    } else if (threadTs) {
      const key = `${jid}:${threadTs}`;
      const override = this.threadToggles.get(key);
      if (override) return override;
    }
    // Fall back to group defaults
    const group = this.resolveGroupFn?.(jid) ?? null;
    return {
      verbose: group?.verboseDefault === true,
      thinking: group?.thinkingDefault === true,
    };
  }

  loadState(): void {
    this.lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'State loaded',
    );
  }

  saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  loadEnvVars(): void {
    try {
      const env = readEnvFile(['SLACK_BOT_TOKEN', 'FILEBROWSER_BASE_URL']);
      this.slackBotToken = env.SLACK_BOT_TOKEN;
      this.filebrowserBaseUrl = env.FILEBROWSER_BASE_URL;
    } catch {
      // Non-fatal — file downloads and filebrowser links won't work
    }
  }

  formatTokens(tokens: number): string {
    return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
  }
}
