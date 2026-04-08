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
    const result = pruneConversations(new Date('2020-01-01'));
    expect(result.conversationsDeleted).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('identifies stale conversations in dry run', () => {
    storeMessages('conv-old', [{ role: 'user', content: 'old message' }]);
    storeMessages('conv-new', [{ role: 'user', content: 'keeps safety floor happy' }]);
    const result = pruneConversations(new Date('2099-01-01'), { dryRun: true, force: true });
    expect(result.conversationsDeleted).toBe(2);
    expect(result.dryRun).toBe(true);
  });

  it('refuses to delete when safety floor would wipe everything', () => {
    storeMessages('conv-only', [{ role: 'user', content: 'only conversation' }]);
    const result = pruneConversations(new Date('2099-01-01'), { dryRun: false });
    expect(result.conversationsDeleted).toBe(0);
    expect(result.aborted).toBeDefined();
    expect(result.aborted).toContain('minRetained');
  });

  it('refuses when more than maxDeleteFraction would be removed', () => {
    // 3 stale out of 4 total = 75% deletion, exceeds default 0.5.
    // Need to stub MAX(created_at) for the "fresh" conversation to be after cutoff.
    // Since storeMessages uses new Date() (now), any cutoff in the past passes the stale filter for all.
    // So we use a cutoff in the future to mark everything as stale, then add one "fresh" message with
    // a cutoff that leaves one conversation unstale.
    storeMessages('conv-1', [{ role: 'user', content: 'msg 1' }]);
    storeMessages('conv-2', [{ role: 'user', content: 'msg 2' }]);
    storeMessages('conv-3', [{ role: 'user', content: 'msg 3' }]);
    storeMessages('conv-4', [{ role: 'user', content: 'msg 4' }]);
    // 4 total. Default maxDeleteFraction=0.5 → max 2 can be deleted.
    // But all 4 are "stale" relative to 2099, so 100% > 50%.
    // We need a safety floor that doesn't also trip minRetained.
    // With minRetained=1, 3 stale out of 4 means remaining=1, OK for minRetained.
    // But 3/4 = 75% > 50%, so maxDeleteFraction should trip.
    // Problem: all 4 are stale. Let's use a forcibly-low minRetained so minRetained doesn't fire.
    const result = pruneConversations(new Date('2099-01-01'), { dryRun: false, minRetainedConversations: 0 });
    expect(result.conversationsDeleted).toBe(0);
    expect(result.aborted).toBeDefined();
    expect(result.aborted).toContain('maxDeleteFraction');
  });

  it('deletes stale conversations when force=true', () => {
    storeMessages('conv-old', [
      { role: 'user', content: 'old msg 1' },
      { role: 'assistant', content: 'old msg 2' },
    ]);
    storeSummary(makeSummary({ id: 'sum-old', conversation_id: 'conv-old' }));
    storeMessages('conv-new', [{ role: 'user', content: 'new message' }]);

    const result = pruneConversations(new Date('2099-01-01'), { dryRun: false, force: true });
    expect(result.conversationsDeleted).toBe(2);
    expect(result.dryRun).toBe(false);
    expect(result.aborted).toBeUndefined();
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
