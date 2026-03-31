import {
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRouterState,
} from './db.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import {
  buildThreadJid,
  getParentJid,
  isSyntheticThreadJid,
} from './jid.js';
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
  threadToggles = new Map<
    string,
    { verbose: boolean; thinking: boolean; planMode: boolean }
  >();

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

  /**
   * Canonical toggle key for threadToggles.
   * Always normalizes the JID to a plain channel JID first, so SET and GET
   * paths produce identical keys regardless of what JID form the caller has.
   *
   * Formats:
   *   Thread-level:    {channelJid}:{threadTs}
   *   Per-agent plan:  {channelJid}:{threadTs}:{groupFolder}
   *   Channel-level:   {channelJid}
   */
  toggleKey(
    jid: string,
    threadTs?: string,
    groupFolder?: string,
  ): string {
    // Always normalize to plain channel JID — strips :g: and :t:
    const base = getParentJid(jid) || jid;
    if (groupFolder && threadTs) return `${base}:${threadTs}:${groupFolder}`;
    if (threadTs) return `${base}:${threadTs}`;
    return base;
  }

  getToggleState(
    jid: string,
    threadTs?: string,
    groupFolder?: string,
  ): { verbose: boolean; thinking: boolean; planMode: boolean } {
    let override:
      | { verbose: boolean; thinking: boolean; planMode: boolean }
      | undefined;

    // Look up thread-level toggle using canonical key
    if (isSyntheticThreadJid(jid)) {
      // Extract threadTs from synthetic JID for canonical key
      const syntheticMatch = jid.match(/:t:(.+)$/);
      const extractedTs = syntheticMatch?.[1];
      if (extractedTs) {
        override = this.threadToggles.get(this.toggleKey(jid, extractedTs));
      }
    } else if (threadTs) {
      override = this.threadToggles.get(this.toggleKey(jid, threadTs));
    }

    // Fall back to group defaults for missing fields
    const group = this.resolveGroupFn?.(jid) ?? null;
    const defaults = {
      verbose: group?.verboseDefault === true,
      thinking: group?.thinkingDefault === true,
      planMode: group?.planModeDefault === true,
    };

    if (!override) {
      // Check for per-agent plan mode key (multi-agent threads)
      if (groupFolder && threadTs) {
        const planKey = this.toggleKey(jid, threadTs, groupFolder);
        const planOverride = this.threadToggles.get(planKey);
        if (planOverride) {
          return { ...defaults, planMode: planOverride.planMode };
        }
      }
      return defaults;
    }

    // Per-agent plan mode key overrides the thread-level planMode
    if (groupFolder && threadTs) {
      const planKey = this.toggleKey(jid, threadTs, groupFolder);
      const planOverride = this.threadToggles.get(planKey);
      if (planOverride) {
        return { ...override, planMode: planOverride.planMode };
      }
    }

    return override;
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
