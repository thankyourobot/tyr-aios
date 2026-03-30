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

  describe('processGroupMessages — dispatch flow', () => {
    it('returns true (no container) when no messages found', async () => {
      const result = await processor.processGroupMessages('slack:C0AL6C8U21L');
      expect(result).toBe(true);
    });

    it('calls agentExecutor.runAgent when messages exist', async () => {
      const { getMessagesSince } = await import('./db.js');
      vi.mocked(getMessagesSince).mockReturnValueOnce([
        {
          id: 'msg-1',
          chat_jid: 'slack:C0AL6C8U21L',
          sender: 'U123',
          sender_name: 'Jeremiah',
          content: '@Sherlock hello',
          timestamp: '2026-03-30T10:00:00Z',
          is_from_me: false,
        },
      ] as any);

      const mockRunAgent = vi.fn(async () => 'success' as const);
      processor.setAgentExecutor({
        runAgent: mockRunAgent,
        downloadFiles: vi.fn(async () => ''),
        rewindSession: vi.fn(),
      } as any);

      const result = await processor.processGroupMessages('slack:C0AL6C8U21L');

      expect(result).toBe(true);
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ folder: 'strategy' }),
        expect.any(String),
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({ verbose: false }),
        undefined,
      );
    });

    it('rolls back cursor on agent error (no output sent)', async () => {
      const { getMessagesSince } = await import('./db.js');
      vi.mocked(getMessagesSince).mockReturnValueOnce([
        {
          id: 'msg-2',
          chat_jid: 'slack:C0AL6C8U21L',
          sender: 'U123',
          sender_name: 'Jeremiah',
          content: '@Sherlock fail',
          timestamp: '2026-03-30T10:00:00Z',
          is_from_me: false,
        },
      ] as any);

      state.lastAgentTimestamp['slack:C0AL6C8U21L'] = 'old-cursor';

      const mockRunAgent = vi.fn(async () => 'error' as const);
      processor.setAgentExecutor({
        runAgent: mockRunAgent,
        downloadFiles: vi.fn(async () => ''),
        rewindSession: vi.fn(),
      } as any);
      const saveFn = vi.fn();
      processor.setSaveFn(saveFn);

      const result = await processor.processGroupMessages('slack:C0AL6C8U21L');

      expect(result).toBe(false);
      // Cursor should be rolled back
      expect(state.lastAgentTimestamp['slack:C0AL6C8U21L']).toBe('old-cursor');
    });
  });

  describe('dispatchMessage', () => {
    it('pipes message via IPC for single-group thread', () => {
      const msg: NewMessage = {
        id: 'msg-3',
        chat_jid: 'slack:C123:t:111.000',
        sender: 'U456',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-30T11:00:00Z',
        is_from_me: false,
      };
      (state.queue.sendMessage as any).mockReturnValue(true);

      processor.dispatchMessage('slack:C123:t:111.000', msg);

      expect(state.queue.sendMessage).toHaveBeenCalledWith(
        'slack:C123',
        '111.000',
        'formatted',
      );
    });

    it('enqueues when IPC pipe not available', () => {
      const msg: NewMessage = {
        id: 'msg-4',
        chat_jid: 'slack:C123:t:111.000',
        sender: 'U456',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-30T11:00:00Z',
        is_from_me: false,
      };
      (state.queue.sendMessage as any).mockReturnValue(false);

      processor.dispatchMessage('slack:C123:t:111.000', msg);

      expect(state.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'slack:C123',
        '111.000',
      );
    });
  });

  describe('dispatchBotMessage', () => {
    it('does nothing for single-group channels', () => {
      vi.mocked(groupManager.isMultiGroupChannel as any).mockReturnValue(false);

      processor.dispatchBotMessage('slack:C123', {
        id: 'bot-1',
        chat_jid: 'slack:C123',
        sender: 'UBOT',
        sender_name: 'Bot',
        content: '<@U999> hello',
        timestamp: '2026-03-30T12:00:00Z',
        is_from_me: false,
        is_bot_message: true,
      } as any);

      expect(state.queue.enqueueMessageCheck).not.toHaveBeenCalled();
    });

    it('dispatches to target groups in multi-group channel', () => {
      vi.mocked(groupManager.isMultiGroupChannel as any).mockReturnValue(true);
      vi.mocked(groupManager.resolveTargetGroups as any).mockReturnValue([
        makeGroup('growth'),
      ]);

      processor.dispatchBotMessage('slack:C123', {
        id: 'bot-2',
        chat_jid: 'slack:C123',
        sender: 'UBOT',
        sender_name: 'Bot',
        content: '<@UGROWTH> check this',
        timestamp: '2026-03-30T12:00:00Z',
        is_from_me: false,
        is_bot_message: true,
      } as any);

      expect(state.queue.enqueueMessageCheck).toHaveBeenCalled();
    });
  });
});
