import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { AppState } from './app-state.js';
import { GroupManager } from './group-manager.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// --- Mocks ---

vi.mock('./db.js', () => ({
  addThreadMember: vi.fn(),
  countBotTriggers: vi.fn(() => 0),
  getAllChats: vi.fn(() => []),
  getAllRegisteredGroupsMulti: vi.fn(() => new Map()),
  getThreadMembers: vi.fn(() => []),
  recordBotTrigger: vi.fn(),
  setRegisteredGroup: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/test/${folder}`),
}));

vi.mock('./jid.js', async () => {
  const actual =
    await vi.importActual<typeof import('./jid.js')>('./jid.js');
  return {
    ...actual,
    getGroupFolder: vi.fn(actual.getGroupFolder),
    getParentJid: vi.fn(actual.getParentJid),
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import mocked functions for assertions
import {
  addThreadMember,
  countBotTriggers,
  getThreadMembers,
  recordBotTrigger,
} from './db.js';
import { getGroupFolder, getParentJid } from './jid.js';

// --- Test fixtures ---

function makeGroup(overrides: Partial<RegisteredGroup> & { folder: string; name: string }): RegisteredGroup {
  return {
    trigger: `@${overrides.name}`,
    added_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Multi-group channel setup: growth/Ryan is director, 3 members
const CHANNEL_JID = 'slack:C_ALL_DIRECTORS';

const growthRyan = makeGroup({
  name: 'Growth Directors',
  folder: 'growth',
  channelRole: 'director',
  botUserId: 'U0ANF23DY4T',
  assistantName: 'Ryan',
});

const strategySherlock = makeGroup({
  name: 'Strategy',
  folder: 'strategy',
  channelRole: 'member',
  botUserId: 'U0AEMLMHLTZ',
  assistantName: 'Sherlock',
});

const operationsTom = makeGroup({
  name: 'Operations',
  folder: 'operations',
  channelRole: 'member',
  botUserId: 'U0AN5V7U6Q7',
  assistantName: 'Tom',
});

const backOfficeAlfred = makeGroup({
  name: 'Back Office',
  folder: 'back-office',
  channelRole: 'member',
  botUserId: 'U0ANMF3NSF4',
  assistantName: 'Alfred',
});

const allChannelGroups = [growthRyan, strategySherlock, operationsTom, backOfficeAlfred];

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: CHANNEL_JID,
    sender: 'U_HUMAN',
    sender_name: 'Human',
    content: 'hello everyone',
    timestamp: '2026-03-29T12:00:00.000Z',
    ...overrides,
  };
}

function createMultiGroupState(): AppState {
  const groupsByJid = new Map<string, RegisteredGroup[]>();
  groupsByJid.set(CHANNEL_JID, allChannelGroups);

  const groupsByFolder = new Map<string, { jid: string; group: RegisteredGroup }>();
  for (const g of allChannelGroups) {
    groupsByFolder.set(g.folder, { jid: CHANNEL_JID, group: g });
  }

  const groupsByBotUserId = new Map<string, RegisteredGroup>();
  for (const g of allChannelGroups) {
    if (g.botUserId) groupsByBotUserId.set(g.botUserId, g);
  }

  const registeredGroups: Record<string, RegisteredGroup> = {
    [CHANNEL_JID]: growthRyan, // director wins
  };

  return {
    groupsByJid,
    groupsByFolder,
    groupsByBotUserId,
    registeredGroups,
  } as unknown as AppState;
}

// --- Tests ---

describe('GroupManager', () => {
  let state: AppState;
  let gm: GroupManager;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createMultiGroupState();
    gm = new GroupManager(state);
  });

  // =============================================
  // resolveTargetGroups — Root messages
  // =============================================

  describe('resolveTargetGroups — root messages (no threadTs)', () => {
    it('1. no @mention → director only', () => {
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, makeMsg());
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('growth');
    });

    it('2. @mention of member (Sherlock) → only Sherlock, NOT director', () => {
      const msg = makeMsg({ content: 'Hey <@U0AEMLMHLTZ> can you check this?' });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('strategy');
    });

    it('3. @mention of director (Ryan) → only Ryan', () => {
      const msg = makeMsg({ content: '<@U0ANF23DY4T> what do you think?' });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('growth');
    });

    it('4. @mention of multiple agents → both mentioned, no director auto-add', () => {
      const msg = makeMsg({ content: '<@U0AEMLMHLTZ> and <@U0AN5V7U6Q7> coordinate on this' });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      const folders = targets.map((t) => t.folder).sort();
      expect(folders).toEqual(['operations', 'strategy']);
    });
  });

  // =============================================
  // resolveTargetGroups — Thread replies
  // =============================================

  describe('resolveTargetGroups — thread replies', () => {
    const THREAD_TS = '1711700000.000100';

    it('5. human reply, no @mention, no existing members → director auto-joins', () => {
      vi.mocked(getThreadMembers).mockReturnValue([]);
      const targets = gm.resolveTargetGroups(CHANNEL_JID, THREAD_TS, makeMsg());
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('growth');
      expect(addThreadMember).toHaveBeenCalledWith(CHANNEL_JID, THREAD_TS, 'growth');
    });

    it('6. human reply with @mention of member → mentioned member only (director skipped when explicit mentions exist)', () => {
      vi.mocked(getThreadMembers).mockReturnValue([]);
      const msg = makeMsg({ content: '<@U0AEMLMHLTZ> thoughts?' });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, THREAD_TS, msg);
      const folders = targets.map((t) => t.folder);
      // Mentioned member is added
      expect(folders).toContain('strategy');
      // Director is NOT added because there are explicit mentions and director is not mentioned
      expect(folders).not.toContain('growth');
      expect(addThreadMember).toHaveBeenCalledWith(CHANNEL_JID, THREAD_TS, 'strategy');
    });

    it('7. human reply with existing thread members → all existing members get the message', () => {
      vi.mocked(getThreadMembers).mockReturnValue(['strategy', 'operations']);
      const targets = gm.resolveTargetGroups(CHANNEL_JID, THREAD_TS, makeMsg());
      const folders = targets.map((t) => t.folder).sort();
      // Existing members + director auto-joins (no mentions)
      expect(folders).toContain('strategy');
      expect(folders).toContain('operations');
      expect(folders).toContain('growth');
    });

    it('8. bot reply with @mention → only mentioned agent, not sender, not director', () => {
      vi.mocked(getThreadMembers).mockReturnValue(['strategy', 'growth']);
      const msg = makeMsg({
        content: '<@U0AN5V7U6Q7> can you handle the ops side?',
        is_bot_message: true,
        sender: 'U0AEMLMHLTZ', // Sherlock is sending
        sender_name: 'Sherlock',
      });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, THREAD_TS, msg);
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('operations');
      expect(recordBotTrigger).toHaveBeenCalledWith(CHANNEL_JID, THREAD_TS, 'operations');
    });

    it('9. bot message rate limiting — 4th trigger in 5 min is skipped', () => {
      vi.mocked(getThreadMembers).mockReturnValue([]);
      vi.mocked(countBotTriggers).mockReturnValue(3); // already at limit

      const msg = makeMsg({
        content: '<@U0AN5V7U6Q7> do this',
        is_bot_message: true,
        sender: 'U0AEMLMHLTZ',
        sender_name: 'Sherlock',
      });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, THREAD_TS, msg);
      expect(targets).toHaveLength(0);
      expect(recordBotTrigger).not.toHaveBeenCalled();
    });
  });

  // =============================================
  // parseMentions
  // =============================================

  describe('parseMentions', () => {
    it('10. native Slack mention <@U_BOT_ID> is detected', () => {
      const mentioned = gm.parseMentions('<@U0AEMLMHLTZ> check this', allChannelGroups);
      expect(mentioned).toEqual(['strategy']);
    });

    it('11. text-based @Name mention is detected', () => {
      // Create a group without botUserId to test text fallback
      const techGroup = makeGroup({
        name: 'Tech',
        folder: 'tech',
        assistantName: 'Darwin',
      });
      const mentioned = gm.parseMentions('Hey @Darwin can you look?', [techGroup]);
      expect(mentioned).toEqual(['tech']);
    });

    it('12. mention inside code block is ignored', () => {
      const content = 'Here is some code:\n```\n<@U0AEMLMHLTZ> is referenced here\n```\nThat is all.';
      const mentioned = gm.parseMentions(content, allChannelGroups);
      expect(mentioned).toEqual([]);
    });

    it('mention inside inline code is ignored', () => {
      const content = 'Run `<@U0AEMLMHLTZ>` to test';
      const mentioned = gm.parseMentions(content, allChannelGroups);
      expect(mentioned).toEqual([]);
    });

    it('multiple mentions detected', () => {
      const content = '<@U0AEMLMHLTZ> and <@U0AN5V7U6Q7> please coordinate';
      const mentioned = gm.parseMentions(content, allChannelGroups);
      expect(mentioned).toEqual(['strategy', 'operations']);
    });
  });

  // =============================================
  // resolveGroup
  // =============================================

  describe('resolveGroup', () => {
    it('13. direct JID match returns group', () => {
      const group = gm.resolveGroup(CHANNEL_JID);
      expect(group).toBe(growthRyan);
    });

    it('14. parent JID fallback returns parent group', () => {
      // synthetic thread JID — parent is the channel
      const threadJid = `${CHANNEL_JID}:t:1711700000.000100`;
      const group = gm.resolveGroup(threadJid);
      expect(group).toBe(growthRyan);
    });

    it('15. main group fallback when no match', () => {
      const mainGroup = makeGroup({
        name: 'Main',
        folder: 'main',
        isMain: true,
      });
      state.registeredGroups['slack:C_MAIN'] = mainGroup;

      const group = gm.resolveGroup('slack:C_TOTALLY_UNKNOWN');
      expect(group).toBe(mainGroup);
    });

    it('16. group-qualified JID extracts folder from :g: suffix', () => {
      const qualifiedJid = `${CHANNEL_JID}:g:operations`;
      const group = gm.resolveGroup(qualifiedJid);
      expect(group).toBe(operationsTom);
    });
  });

  // =============================================
  // isMultiGroupChannel
  // =============================================

  describe('isMultiGroupChannel', () => {
    it('17. single registration → false', () => {
      const singleJid = 'slack:C_SINGLE';
      state.groupsByJid.set(singleJid, [growthRyan]);
      expect(gm.isMultiGroupChannel(singleJid)).toBe(false);
    });

    it('18. multiple registrations → true', () => {
      expect(gm.isMultiGroupChannel(CHANNEL_JID)).toBe(true);
    });

    it('unknown channel → false', () => {
      expect(gm.isMultiGroupChannel('slack:C_NONEXISTENT')).toBe(false);
    });
  });

  // =============================================
  // resolveSenderFolder
  // =============================================

  describe('resolveSenderFolder', () => {
    it('resolves by bot user ID', () => {
      const msg = makeMsg({ sender: 'U0AEMLMHLTZ', sender_name: 'Sherlock' });
      expect(gm.resolveSenderFolder(msg)).toBe('strategy');
    });

    it('falls back to sender_name match', () => {
      const msg = makeMsg({ sender: 'U_UNKNOWN', sender_name: 'Tom' });
      expect(gm.resolveSenderFolder(msg)).toBe('operations');
    });

    it('returns null for unknown sender', () => {
      const msg = makeMsg({ sender: 'U_UNKNOWN', sender_name: 'Nobody' });
      expect(gm.resolveSenderFolder(msg)).toBeNull();
    });
  });

  // =============================================
  // getMainGroup
  // =============================================

  describe('getMainGroup', () => {
    it('returns the main group', () => {
      const mainGroup = makeGroup({ name: 'Main', folder: 'main', isMain: true });
      state.registeredGroups['slack:C_MAIN'] = mainGroup;
      const result = gm.getMainGroup();
      expect(result).toEqual({ jid: 'slack:C_MAIN', group: mainGroup });
    });

    it('returns null when no main group exists', () => {
      // None of the fixture groups have isMain=true
      expect(gm.getMainGroup()).toBeNull();
    });
  });

  // =============================================
  // resolveTargetGroups — single-group channel
  // =============================================

  describe('resolveTargetGroups — single-group channel', () => {
    it('always returns that single group', () => {
      const singleJid = 'slack:C_SINGLE';
      const singleGroup = makeGroup({ name: 'Solo', folder: 'solo', channelRole: 'director' });
      state.registeredGroups[singleJid] = singleGroup;
      state.groupsByJid.set(singleJid, [singleGroup]);

      const targets = gm.resolveTargetGroups(singleJid, undefined, makeMsg({ chat_jid: singleJid }));
      expect(targets).toEqual([singleGroup]);
    });

    it('returns empty array for unknown channel with no main group', () => {
      // Remove all registered groups to ensure no fallback
      state.registeredGroups = {};
      const targets = gm.resolveTargetGroups('slack:C_GHOST', undefined, makeMsg());
      expect(targets).toEqual([]);
    });
  });

  // =============================================
  // resolveTargetGroups — bot root messages
  // =============================================

  describe('resolveTargetGroups — bot root messages', () => {
    it('bot root with @mention targets only mentioned (not sender)', () => {
      const msg = makeMsg({
        content: '<@U0AN5V7U6Q7> handle this',
        is_bot_message: true,
        sender: 'U0AEMLMHLTZ', // Sherlock
        sender_name: 'Sherlock',
      });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      expect(targets).toHaveLength(1);
      expect(targets[0].folder).toBe('operations');
    });

    it('bot root with no @mention targets nobody', () => {
      const msg = makeMsg({
        content: 'Just an update for everyone',
        is_bot_message: true,
        sender: 'U0AEMLMHLTZ',
        sender_name: 'Sherlock',
      });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      expect(targets).toHaveLength(0);
    });

    it('bot root self-mention is filtered out', () => {
      const msg = makeMsg({
        content: '<@U0AEMLMHLTZ> remind me', // mentioning self
        is_bot_message: true,
        sender: 'U0AEMLMHLTZ',
        sender_name: 'Sherlock',
      });
      const targets = gm.resolveTargetGroups(CHANNEL_JID, undefined, msg);
      expect(targets).toHaveLength(0);
    });
  });
});
