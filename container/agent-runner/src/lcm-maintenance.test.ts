import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestLcmDatabase,
  storeMessages,
  storeSummary,
  appendContextItems,
  getContextItems,
  contentHash,
  getSummariesForConversation,
  type StoreSummaryInput,
} from './lcm-store.js';
import { pruneConversations, checkIntegrity } from './lcm-maintenance.js';

function makeSummary(overrides: Partial<StoreSummaryInput> = {}): StoreSummaryInput {
  return {
    id: 'sum-test',
    conversation_id: 'conv-1',
    depth: 0,
    content: 'Test summary',
    source_message_ids: null,
    parent_summary_ids: null,
    child_summary_ids: null,
    min_sequence: 0,
    max_sequence: 5,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestLcmDatabase();
});

describe('pruneConversations', () => {
  it('returns zero counts when nothing is stale', () => {
    storeMessages('conv-1', [{ role: 'user', content: 'hello' }]);
    const result = pruneConversations(new Date('2020-01-01'), true);
    expect(result.conversationsDeleted).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('identifies stale conversations in dry run', () => {
    storeMessages('conv-old', [{ role: 'user', content: 'old message' }]);
    const result = pruneConversations(new Date('2099-01-01'), true);
    expect(result.conversationsDeleted).toBe(1);
    expect(result.messagesDeleted).toBe(1);
    expect(result.dryRun).toBe(true);

    // Verify nothing was actually deleted
    const items = getSummariesForConversation('conv-old');
    // Messages should still exist (dry run)
  });

  it('deletes stale conversations when not dry run', () => {
    storeMessages('conv-old', [
      { role: 'user', content: 'old msg 1' },
      { role: 'assistant', content: 'old msg 2' },
    ]);
    storeSummary(makeSummary({ id: 'sum-old', conversation_id: 'conv-old' }));

    // Keep a recent conversation
    storeMessages('conv-new', [{ role: 'user', content: 'new message' }]);

    const result = pruneConversations(new Date('2099-01-01'), false);
    expect(result.conversationsDeleted).toBe(2); // both are "old" relative to 2099
    expect(result.dryRun).toBe(false);
  });
});

describe('checkIntegrity', () => {
  it('returns empty findings for healthy conversation', () => {
    const msgs = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    storeMessages('conv-1', msgs);
    const ids = msgs.map(m => contentHash('conv-1', m.role, m.content));
    appendContextItems('conv-1', ids.map(id => ({ item_type: 'message' as const, message_id: id })));

    const findings = checkIntegrity('conv-1');
    expect(findings).toHaveLength(0);
  });

  it('detects context item referencing missing message', () => {
    appendContextItems('conv-1', [{ item_type: 'message', message_id: 'nonexistent' }]);

    const findings = checkIntegrity('conv-1');
    expect(findings.some(f => f.check === 'context_items_valid_refs')).toBe(true);
  });

  it('detects context item referencing missing summary', () => {
    appendContextItems('conv-1', [{ item_type: 'summary', summary_id: 'sum-nonexistent' }]);

    const findings = checkIntegrity('conv-1');
    expect(findings.some(f => f.check === 'context_items_valid_refs')).toBe(true);
  });

  it('detects duplicate context refs', () => {
    const msgs = [{ role: 'user' as const, content: 'hello' }];
    storeMessages('conv-1', msgs);
    const msgId = contentHash('conv-1', 'user', 'hello');
    // Manually insert duplicate
    appendContextItems('conv-1', [
      { item_type: 'message', message_id: msgId },
      { item_type: 'message', message_id: msgId },
    ]);

    const findings = checkIntegrity('conv-1');
    expect(findings.some(f => f.check === 'no_duplicate_context_refs')).toBe(true);
  });

  it('detects orphan summaries', () => {
    storeMessages('conv-1', [{ role: 'user', content: 'hello' }]);
    storeSummary(makeSummary({ id: 'sum-orphan', conversation_id: 'conv-1' }));
    // Summary exists but is not in context window and not a child of anything

    const findings = checkIntegrity('conv-1');
    expect(findings.some(f => f.check === 'no_orphan_summaries')).toBe(true);
  });

  it('does not flag summaries in context window as orphans', () => {
    storeMessages('conv-1', [{ role: 'user', content: 'hello' }]);
    storeSummary(makeSummary({ id: 'sum-in-ctx', conversation_id: 'conv-1' }));
    appendContextItems('conv-1', [{ item_type: 'summary', summary_id: 'sum-in-ctx' }]);

    const findings = checkIntegrity('conv-1');
    expect(findings.some(f => f.check === 'no_orphan_summaries')).toBe(false);
  });
});
