import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentExecutor } from './agent-executor.js';
import type { AppState } from './app-state.js';
import type { GroupManager } from './group-manager.js';
import type { RegisteredGroup, ContainerOutput } from './types.js';

// --- Mocks ---

const mockRunContainerAgent = vi.fn();
vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: any[]) => mockRunContainerAgent(...args),
}));

vi.mock('./db.js', () => ({
  getAllTasks: vi.fn(() => []),
  getGroupByFolder: vi.fn(),
  getJidsForFolder: vi.fn(() => []),
  getMessagesSinceIncludingBots: vi.fn(() => []),
  getThreadSession: vi.fn(),
  setSession: vi.fn(),
  setThreadSession: vi.fn(),
}));

vi.mock('./snapshot-writer.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeRecentActivitySnapshot: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((f: string) => `/tmp/test/${f}`),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
}));

vi.mock('./router.js', () => ({
  findChannel: vi.fn(() => ({
    sendMessage: vi.fn(),
    ownsJid: () => true,
    name: 'slack',
  })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getThreadSession, setSession, setThreadSession } from './db.js';

// --- Helpers ---

function makeGroup(overrides?: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    name: 'strategy',
    folder: 'strategy',
    trigger: '@Sherlock',
    added_at: '2026-01-01',
    isMain: false,
    channelRole: 'director',
    ...overrides,
  };
}

function makeMockState(): AppState {
  return {
    lastTimestamp: '',
    sessions: { strategy: 'sess-root' },
    registeredGroups: {
      'slack:C123': makeGroup(),
    },
    lastAgentTimestamp: {},
    messageLoopRunning: false,
    groupsByJid: new Map(),
    groupsByFolder: new Map(),
    groupsByBotUserId: new Map(),
    channels: [{ name: 'slack', ownsJid: () => true }],
    queue: {
      registerProcess: vi.fn(),
      getActiveGroups: vi.fn(() => []),
    } as any,
    pendingBusyReactions: new Map(),
    threadToggles: new Map(),
    slackBotToken: 'xoxb-test',
    filebrowserBaseUrl: 'https://fb.test',
    getCursorKey: vi.fn((jid: string, ts?: string) =>
      ts ? `${jid}:t:${ts}` : jid,
    ),
    getToggleState: vi.fn(() => ({ verbose: false, thinking: false, planMode: false })),
    formatTokens: vi.fn((n: number) => `${n}`),
    saveState: vi.fn(),
    loadState: vi.fn(),
    loadEnvVars: vi.fn(),
    setGroupResolver: vi.fn(),
  } as any;
}

function makeMockGroupManager(): GroupManager {
  return {
    getAvailableGroups: vi.fn(() => []),
    resolveGroup: vi.fn(),
    isMultiGroupChannel: vi.fn(() => false),
    resolveTargetGroups: vi.fn(() => []),
    parseMentions: vi.fn(() => []),
    getMainGroup: vi.fn(),
    rebuildGroupIndexes: vi.fn(),
    registerGroup: vi.fn(),
    resolveSenderFolder: vi.fn(),
  } as any;
}

describe('AgentExecutor', () => {
  let executor: AgentExecutor;
  let state: AppState;
  let groupManager: GroupManager;

  beforeEach(() => {
    vi.clearAllMocks();
    state = makeMockState();
    groupManager = makeMockGroupManager();
    executor = new AgentExecutor(state, groupManager);
  });

  describe('downloadFiles', () => {
    it('returns empty string when no slackBotToken', async () => {
      state.slackBotToken = undefined;
      const result = await executor.downloadFiles(
        [{ id: 'F1', name: 'test.txt', url: 'https://example.com/file', size: 100, mimetype: 'text/plain' }],
        'strategy',
      );
      expect(result).toBe('');
    });

    it('returns empty string for empty files array', async () => {
      const result = await executor.downloadFiles([], 'strategy');
      expect(result).toBe('');
    });
  });

  describe('runAgent', () => {
    it('uses channel root session when no threadTs', async () => {
      const output: ContainerOutput = {
        status: 'success',
        result: 'done',
        newSessionId: 'sess-new',
      };
      mockRunContainerAgent.mockResolvedValue(output);

      const result = await executor.runAgent(
        makeGroup(),
        'hello',
        'slack:C123',
      );

      expect(result).toBe('success');
      expect(setSession).toHaveBeenCalledWith('strategy', 'sess-new');
      expect(state.sessions.strategy).toBe('sess-new');
    });

    it('forks session for new thread', async () => {
      vi.mocked(getThreadSession).mockReturnValue(undefined!);
      const output: ContainerOutput = {
        status: 'success',
        result: 'done',
        newSessionId: 'sess-thread-1',
      };
      mockRunContainerAgent.mockResolvedValue(output);

      await executor.runAgent(
        makeGroup(),
        'hello',
        'slack:C123',
        undefined,
        undefined,
        '111.000',
      );

      // Should call runContainerAgent with forkFromSession: true
      expect(mockRunContainerAgent).toHaveBeenCalled();
      const agentInput = mockRunContainerAgent.mock.calls[0][1];
      expect(agentInput.forkFromSession).toBe(true);
      expect(agentInput.sessionId).toBe('sess-root');

      expect(setThreadSession).toHaveBeenCalledWith(
        'strategy',
        '111.000',
        'sess-thread-1',
        'sess-root',
      );
    });

    it('reuses existing thread session', async () => {
      vi.mocked(getThreadSession).mockReturnValue('sess-existing-thread');
      const output: ContainerOutput = {
        status: 'success',
        result: null,
      };
      mockRunContainerAgent.mockResolvedValue(output);

      await executor.runAgent(
        makeGroup(),
        'follow-up',
        'slack:C123',
        undefined,
        undefined,
        '111.000',
      );

      const agentInput = mockRunContainerAgent.mock.calls[0][1];
      expect(agentInput.sessionId).toBe('sess-existing-thread');
      expect(agentInput.forkFromSession).toBe(false);
    });

    it('returns error on container failure', async () => {
      const output: ContainerOutput = {
        status: 'error',
        result: null,
        error: 'container crashed',
      };
      mockRunContainerAgent.mockResolvedValue(output);

      const result = await executor.runAgent(
        makeGroup(),
        'hello',
        'slack:C123',
      );

      expect(result).toBe('error');
    });

    it('returns error on exception', async () => {
      mockRunContainerAgent.mockRejectedValue(new Error('boom'));

      const result = await executor.runAgent(
        makeGroup(),
        'hello',
        'slack:C123',
      );

      expect(result).toBe('error');
    });
  });

  describe('rewindSession', () => {
    it('skips when no source session exists', async () => {
      vi.mocked(getThreadSession).mockReturnValue(undefined!);
      state.sessions = {};

      await executor.rewindSession({
        groupFolder: 'strategy',
        chatJid: 'slack:C123',
        sourceThreadTs: '111.000',
        newThreadTs: '222.000',
        sdkUuid: 'uuid-abc',
      });

      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('skips when group not found', async () => {
      vi.mocked(getThreadSession).mockReturnValue('sess-source');
      state.registeredGroups = {};

      await executor.rewindSession({
        groupFolder: 'nonexistent',
        chatJid: 'slack:C123',
        sourceThreadTs: '111.000',
        newThreadTs: '222.000',
        sdkUuid: 'uuid-abc',
      });

      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });
  });
});
