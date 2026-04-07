import { describe, it, expect, beforeEach } from 'vitest';
import { runLcmSubAgent, _executeTool } from './lcm-subagent.js';
import { _initTestLcmDatabase, storeMessages, storeSummary, type StoreSummaryInput } from './lcm-store.js';

function makeSummary(overrides: Partial<StoreSummaryInput> = {}): StoreSummaryInput {
  return {
    id: 'sum-test',
    conversation_id: 'conv-1',
    depth: 0,
    content: 'Test summary about database migrations and auth changes',
    source_message_ids: null,
    parent_summary_ids: null,
    child_summary_ids: null,
    min_sequence: 0,
    max_sequence: 5,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('sub-agent tool execution', () => {
  beforeEach(() => {
    _initTestLcmDatabase();
    storeMessages('conv-1', [
      { role: 'user', content: 'Please update the database schema for auth' },
      { role: 'assistant', content: 'I will update the migration files for the auth tables.' },
      { role: 'user', content: 'Also add the session token storage' },
      { role: 'assistant', content: 'Done. The session tokens are now stored in the sessions table.' },
    ]);
    storeSummary(makeSummary({
      id: 'sum-leaf-1',
      depth: 0,
      content: 'Database schema updated for auth. Session token storage added to sessions table.',
      source_message_ids: null,
      min_sequence: 0,
      max_sequence: 3,
    }));
    storeSummary(makeSummary({
      id: 'sum-leaf-2',
      depth: 0,
      content: 'Additional API endpoints created for token refresh.',
      min_sequence: 4,
      max_sequence: 7,
    }));
    storeSummary(makeSummary({
      id: 'sum-condensed',
      depth: 1,
      content: 'Auth system fully implemented with database, sessions, and API.',
      child_summary_ids: JSON.stringify(['sum-leaf-1', 'sum-leaf-2']),
      min_sequence: 0,
      max_sequence: 7,
    }));
  });

  describe('lcm_grep', () => {
    it('returns results for matching query', () => {
      const result = _executeTool('lcm_grep', { query: 'database', scope: 'both' });
      expect(result).toContain('database');
      expect(result).not.toBe('No results for "database"');
    });

    it('returns no-results message for non-matching query', () => {
      const result = _executeTool('lcm_grep', { query: 'xyznonexistent' });
      expect(result).toContain('No results');
    });

    it('respects scope=summaries', () => {
      const result = _executeTool('lcm_grep', { query: 'auth', scope: 'summaries' });
      expect(result).toContain('[summary]');
      expect(result).not.toContain('[message]');
    });

    it('respects scope=messages', () => {
      const result = _executeTool('lcm_grep', { query: 'database', scope: 'messages' });
      expect(result).toContain('[message]');
    });
  });

  describe('lcm_describe', () => {
    it('returns metadata for existing summary', () => {
      const result = _executeTool('lcm_describe', { id: 'sum-leaf-1' });
      expect(result).toContain('sum-leaf-1');
      expect(result).toContain('Depth: 0');
      expect(result).toContain('Content preview:');
    });

    it('returns error for missing summary', () => {
      const result = _executeTool('lcm_describe', { id: 'sum-nonexistent' });
      expect(result).toContain('not found');
    });

    it('shows subtree for condensed summaries', () => {
      const result = _executeTool('lcm_describe', { id: 'sum-condensed' });
      expect(result).toContain('Subtree:');
      expect(result).toContain('sum-leaf-1');
      expect(result).toContain('sum-leaf-2');
    });
  });

  describe('lcm_read_source', () => {
    it('returns source messages for leaf summary', () => {
      // Store with explicit source_message_ids linking
      storeSummary(makeSummary({
        id: 'sum-with-sources',
        depth: 0,
        content: 'Summary with sources',
        source_message_ids: null, // No explicit links, will fall back to sequence range
        min_sequence: 0,
        max_sequence: 3,
      }));
      const result = _executeTool('lcm_read_source', { id: 'sum-with-sources' });
      expect(result).toContain('database schema');
    });

    it('returns child summaries for condensed summary', () => {
      const result = _executeTool('lcm_read_source', { id: 'sum-condensed' });
      expect(result).toContain('sum-leaf-1');
      expect(result).toContain('sum-leaf-2');
      expect(result).toContain('Database schema updated');
    });

    it('returns error for missing summary', () => {
      const result = _executeTool('lcm_read_source', { id: 'sum-gone' });
      expect(result).toContain('not found');
    });
  });

  describe('executeTool dispatcher', () => {
    it('returns error for unknown tool', () => {
      const result = _executeTool('unknown_tool', {});
      expect(result).toContain('Unknown tool');
    });
  });
});

describe('runLcmSubAgent', () => {
  it('returns null without API credentials', async () => {
    const result = await runLcmSubAgent({ query: 'test' });
    expect(result).toBeNull();
  });
});
