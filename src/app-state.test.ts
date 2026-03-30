import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppState } from './app-state.js';
import type { RegisteredGroup } from './types.js';

vi.mock('./db.js', () => ({
  getRouterState: vi.fn(),
  setRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    FILEBROWSER_BASE_URL: 'https://fb.example.com',
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

import {
  getRouterState,
  setRouterState,
  getAllSessions,
  getAllRegisteredGroups,
} from './db.js';
import { readEnvFile } from './env.js';

describe('AppState', () => {
  let state: AppState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = new AppState();
  });

  describe('getCursorKey', () => {
    it('returns baseJid when no threadTs', () => {
      expect(state.getCursorKey('slack:C123')).toBe('slack:C123');
    });

    it('returns baseJid when threadTs is null', () => {
      expect(state.getCursorKey('slack:C123', null)).toBe('slack:C123');
    });

    it('returns synthetic thread JID when threadTs is provided', () => {
      expect(state.getCursorKey('slack:C123', '1711100000.000')).toBe(
        'slack:C123:t:1711100000.000',
      );
    });
  });

  describe('getToggleState', () => {
    it('returns defaults when no resolver set', () => {
      const result = state.getToggleState('slack:C123');
      expect(result).toEqual({ verbose: false, thinking: false, planMode: false });
    });

    it('returns group defaults from resolver', () => {
      state.setGroupResolver(() => ({
        name: 'strategy',
        folder: 'strategy',
        trigger: '@Sherlock',
        added_at: '2026-01-01',
        verboseDefault: true,
        thinkingDefault: false,
      }));
      const result = state.getToggleState('slack:C123');
      expect(result).toEqual({ verbose: true, thinking: false, planMode: false });
    });

    it('returns thread override when set via threadToggles (synthetic JID)', () => {
      state.threadToggles.set('slack:C123:t:111.000', {
        verbose: true,
        thinking: true,
        planMode: false,
      });
      const result = state.getToggleState('slack:C123:t:111.000');
      expect(result).toEqual({ verbose: true, thinking: true, planMode: false });
    });

    it('returns thread override when set via JID + threadTs', () => {
      state.threadToggles.set('slack:C123:111.000', {
        verbose: false,
        thinking: true,
        planMode: false,
      });
      const result = state.getToggleState('slack:C123', '111.000');
      expect(result).toEqual({ verbose: false, thinking: true, planMode: false });
    });

    it('returns per-agent plan mode from agent-specific key', () => {
      state.threadToggles.set('slack:C123:111.000:strategy', {
        verbose: false,
        thinking: false,
        planMode: true,
      });
      const result = state.getToggleState('slack:C123', '111.000', 'strategy');
      expect(result.planMode).toBe(true);
    });
  });

  describe('loadState / saveState', () => {
    it('loads state from database', () => {
      vi.mocked(getRouterState).mockImplementation((key: string) => {
        if (key === 'last_timestamp') return '2026-03-01T00:00:00Z';
        if (key === 'last_agent_timestamp')
          return JSON.stringify({ 'slack:C123': '2026-03-01T00:00:00Z' });
        return undefined;
      });
      vi.mocked(getAllSessions).mockReturnValue({ strategy: 'sess-abc' });
      vi.mocked(getAllRegisteredGroups).mockReturnValue({
        'slack:C123': { name: 'strategy', folder: 'strategy', trigger: '@Sherlock', added_at: '2026-01-01' } satisfies Partial<RegisteredGroup> as RegisteredGroup,
      });

      state.loadState();

      expect(state.lastTimestamp).toBe('2026-03-01T00:00:00Z');
      expect(state.lastAgentTimestamp).toEqual({
        'slack:C123': '2026-03-01T00:00:00Z',
      });
      expect(state.sessions).toEqual({ strategy: 'sess-abc' });
      expect(state.registeredGroups).toHaveProperty('slack:C123');
    });

    it('handles corrupted last_agent_timestamp gracefully', () => {
      vi.mocked(getRouterState).mockImplementation((key: string) => {
        if (key === 'last_agent_timestamp') return 'NOT_VALID_JSON';
        return undefined;
      });

      state.loadState();

      expect(state.lastAgentTimestamp).toEqual({});
    });

    it('saves state to database', () => {
      state.lastTimestamp = '2026-03-02T00:00:00Z';
      state.lastAgentTimestamp = { 'slack:C456': '2026-03-02T00:00:00Z' };

      state.saveState();

      expect(setRouterState).toHaveBeenCalledWith(
        'last_timestamp',
        '2026-03-02T00:00:00Z',
      );
      expect(setRouterState).toHaveBeenCalledWith(
        'last_agent_timestamp',
        JSON.stringify({ 'slack:C456': '2026-03-02T00:00:00Z' }),
      );
    });
  });

  describe('loadEnvVars', () => {
    it('loads Slack bot token and filebrowser URL from env file', () => {
      state.loadEnvVars();

      expect(readEnvFile).toHaveBeenCalledWith([
        'SLACK_BOT_TOKEN',
        'FILEBROWSER_BASE_URL',
      ]);
      expect(state.slackBotToken).toBe('xoxb-test-token');
      expect(state.filebrowserBaseUrl).toBe('https://fb.example.com');
    });

    it('handles missing env file gracefully', () => {
      vi.mocked(readEnvFile).mockImplementation(() => {
        throw new Error('File not found');
      });

      state.loadEnvVars();

      expect(state.slackBotToken).toBeUndefined();
      expect(state.filebrowserBaseUrl).toBeUndefined();
    });
  });

  describe('formatTokens', () => {
    it('returns raw number for < 1000', () => {
      expect(state.formatTokens(500)).toBe('500');
    });

    it('returns "1k" for 1000', () => {
      expect(state.formatTokens(1000)).toBe('1k');
    });

    it('returns "10k" for 10000', () => {
      expect(state.formatTokens(10000)).toBe('10k');
    });

    it('rounds to nearest k', () => {
      expect(state.formatTokens(1500)).toBe('2k');
      expect(state.formatTokens(128000)).toBe('128k');
    });
  });
});
