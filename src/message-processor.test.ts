import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from './message-processor.js';
import type { AppState } from './app-state.js';
import type { GroupManager } from './group-manager.js';
import type { AgentExecutor } from './agent-executor.js';
import { RegisteredGroup, NewMessage } from './types.js';

// Track which JID getMessagesSince is called with
let capturedFetchJid: string | undefined;

vi.mock('./db.js', () => ({
  getMessagesSince: vi.fn((jid: string) => {
    capturedFetchJid = jid;
    return [];
  }),
  getMessagesSinceIncludingBots: vi.fn((jid: string) => {
    capturedFetchJid = jid;
    return [];
  }),
  getMessageById: vi.fn(),
  addThreadMember: vi.fn(),
  storeResponseUuid: vi.fn(),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Sherlock',
  IDLE_TIMEOUT: 300000,
  TIMEZONE: 'America/Chicago',
  TRIGGER_PATTERN: /^@\w+/,
}));

vi.mock('./router.js', () => ({
  findChannel: vi.fn(() => ({
    sendMessage: vi.fn(),
    setTyping: vi.fn(),
    removeReaction: vi.fn(),
    ownsJid: () => true,
    name: 'slack',
  })),
  formatMessages: vi.fn(() => 'formatted'),
}));

vi.mock('./sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({})),
  isTriggerAllowed: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeGroup(
  folder: string,
  overrides?: Partial<RegisteredGroup>,
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: `@${folder}`,
    added_at: '2026-01-01',
    isMain: false,
    channelRole: 'member',
    requiresTrigger: false,
    ...overrides,
  };
}

function makeMockState(): AppState {
  return {
    lastTimestamp: '',
    sessions: {},
    registeredGroups: {},
    lastAgentTimestamp: {},
    messageLoopRunning: false,
    groupsByJid: new Map(),
    groupsByFolder: new Map(),
    groupsByBotUserId: new Map(),
    channels: [],
    queue: {
      sendMessage: vi.fn(() => false),
      enqueueMessageCheck: vi.fn(),
      notifyIdle: vi.fn(),
      closeStdin: vi.fn(),
    } as any,
    pendingBusyReactions: new Map(),
    threadToggles: new Map(),
    getCursorKey: vi.fn((jid, ts) => (ts ? `${jid}:t:${ts}` : jid)),
    getToggleState: vi.fn(() => ({ verbose: false, thinking: false })),
    formatTokens: vi.fn((n) => `${n}`),
    saveState: vi.fn(),
    loadState: vi.fn(),
    loadEnvVars: vi.fn(),
    setGroupResolver: vi.fn(),
  } as any;
}

describe('MessageProcessor', () => {
  let processor: MessageProcessor;
  let state: AppState;
  let groupManager: GroupManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetchJid = undefined;

    state = makeMockState();
    groupManager = {
      resolveGroup: vi.fn(() => makeGroup('strategy')),
      isMultiGroupChannel: vi.fn(() => false),
      resolveTargetGroups: vi.fn(() => []),
      parseMentions: vi.fn(() => []),
      getMainGroup: vi.fn(),
      rebuildGroupIndexes: vi.fn(),
      registerGroup: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      resolveSenderFolder: vi.fn(),
    } as any;

    processor = new MessageProcessor(state, groupManager);
    processor.setSaveFn(() => {});
    processor.setAgentExecutor({
      runAgent: vi.fn(async () => 'success'),
      downloadFiles: vi.fn(async () => ''),
      rewindSession: vi.fn(),
    } as any);
  });

  describe('processGroupMessages — fetchJid construction', () => {
    it('uses correct fetchJid for group-qualified thread JID (no double :t:)', async () => {
      // This is the bug: when called with "slack:CH:t:TS:g:folder" and threadTs "TS",
      // baseJid = getBaseJid(...) = "slack:CH:t:TS" (still has :t:)
      // fetchJid = buildThreadJid(baseJid, threadTs) = "slack:CH:t:TS:t:TS" (DOUBLE!)
      // It should be: "slack:CH:t:TS"

      const growth = makeGroup('growth', {
        channelRole: 'director',
        requiresTrigger: false,
      });
      state.groupsByFolder.set('growth', {
        jid: 'slack:C0AN59XN8B1',
        group: growth,
      });
      state.groupsByJid.set('slack:C0AN59XN8B1', [growth]);
      state.registeredGroups['slack:C0AN59XN8B1'] = growth;

      // Call with a group-qualified thread JID (as multi-group dispatch would)
      await processor.processGroupMessages(
        'slack:C0AN59XN8B1:t:1234567.890:g:growth',
        '1234567.890',
      );

      // The fetchJid used for getMessagesSince should be the thread JID WITHOUT doubling
      expect(capturedFetchJid).toBe('slack:C0AN59XN8B1:t:1234567.890');
      // NOT "slack:C0AN59XN8B1:t:1234567.890:t:1234567.890"
    });

    it('uses correct fetchJid for plain channel JID (no thread)', async () => {
      const strategy = makeGroup('strategy', {
        isMain: true,
        requiresTrigger: false,
      });
      state.registeredGroups['slack:C0AL6C8U21L'] = strategy;

      await processor.processGroupMessages('slack:C0AL6C8U21L');

      expect(capturedFetchJid).toBe('slack:C0AL6C8U21L');
    });

    it('uses correct fetchJid for plain channel JID with threadTs param', async () => {
      const strategy = makeGroup('strategy', {
        isMain: true,
        requiresTrigger: false,
      });
      state.registeredGroups['slack:C0AL6C8U21L'] = strategy;

      await processor.processGroupMessages('slack:C0AL6C8U21L', '9999999.000');

      expect(capturedFetchJid).toBe('slack:C0AL6C8U21L:t:9999999.000');
    });
  });
});
