/**
 * Integration tests for the LCM persist flow.
 * Tests the sequence of operations that persistToLcm() performs,
 * using the exported store functions directly against an in-memory DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestLcmDatabase,
  storeMessages,
  storeSummary,
  getMaxSequence,
  getSummariesForConversation,
  contentHash,
  appendContextItems,
  replaceContextItemsWithSummary,
  replaceContextSummariesWithCondensed,
  getContextItems,
  storeMessageParts,
  getMessageParts,
  getBootstrapState,
  upsertBootstrapState,
  storeLargeFile,
  getLargeFile,
  type StoreSummaryInput,
} from './lcm-store.js';
import { parseTranscript, decomposeMessage } from './lcm-helpers.js';

beforeEach(() => {
  _initTestLcmDatabase();
});

// --- Helpers ---

function makeTranscriptLine(type: string, content: unknown): string {
  if (type === 'user' && typeof content === 'string') {
    return JSON.stringify({ type: 'user', message: { content } });
  }
  if (type === 'assistant' && Array.isArray(content)) {
    return JSON.stringify({ type: 'assistant', message: { content } });
  }
  return '';
}

function buildTranscript(turns: Array<{ role: 'user' | 'assistant'; content: string | object[] }>): string {
  return turns.map(t => {
    if (t.role === 'user') return makeTranscriptLine('user', t.content);
    return makeTranscriptLine('assistant', t.content);
  }).join('\n');
}

// --- Tests ---

describe('persist flow: message storage + parts + context items', () => {
  const convId = 'test:slack:chan1:thread1';

  it('stores messages, decomposes parts, and creates context items', () => {
    const transcript = buildTranscript([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Sure, let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ]},
    ]);

    const messages = parseTranscript(transcript);
    expect(messages).toHaveLength(4);

    // Store messages
    const startSeq = getMaxSequence(convId) + 1;
    const inserted = storeMessages(convId, messages, startSeq);
    expect(inserted).toBe(4);

    // Decompose and store parts
    for (const msg of messages) {
      const msgId = contentHash(convId, msg.role, msg.content);
      const parts = decomposeMessage(msgId, msg.content);
      storeMessageParts(parts);
    }

    // Check parts for the tool_use message
    const toolMsgId = contentHash(convId, 'assistant', messages[3].content);
    const toolParts = getMessageParts(toolMsgId);
    expect(toolParts.length).toBeGreaterThanOrEqual(2);
    expect(toolParts.some(p => p.part_type === 'text')).toBe(true);
    expect(toolParts.some(p => p.part_type === 'tool' && p.tool_name === 'Bash')).toBe(true);

    // Create context items
    const newItems = messages.map(msg => ({
      item_type: 'message' as const,
      message_id: contentHash(convId, msg.role, msg.content),
    }));
    appendContextItems(convId, newItems);

    const items = getContextItems(convId);
    expect(items).toHaveLength(4);
    expect(items.map(i => i.ordinal)).toEqual([0, 1, 2, 3]);
    expect(items.every(i => i.item_type === 'message')).toBe(true);
  });

  it('deduplicates on re-persist', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
    ];

    const inserted1 = storeMessages(convId, messages, 0);
    expect(inserted1).toBe(2);

    // Re-persist same content
    const inserted2 = storeMessages(convId, messages, 0);
    expect(inserted2).toBe(0);
  });
});

describe('persist flow: context item replacement', () => {
  const convId = 'test:slack:chan1:thread1';

  it('replaces message items with leaf summary and maintains contiguous ordinals', () => {
    // Simulate: 6 messages stored, then messages 0-3 summarized into a leaf
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i} content that is unique`,
    }));
    storeMessages(convId, messages, 0);

    const messageIds = messages.map(m => contentHash(convId, m.role, m.content));
    appendContextItems(convId, messageIds.map(id => ({ item_type: 'message' as const, message_id: id })));

    // Replace first 4 messages with a leaf summary
    replaceContextItemsWithSummary(convId, messageIds.slice(0, 4), 'sum-leaf-1');

    const items = getContextItems(convId);
    expect(items).toHaveLength(3); // sum-leaf-1, msg4, msg5
    expect(items[0].ordinal).toBe(0);
    expect(items[0].summary_id).toBe('sum-leaf-1');
    expect(items[1].ordinal).toBe(1);
    expect(items[1].message_id).toBe(messageIds[4]);
    expect(items[2].ordinal).toBe(2);
    expect(items[2].message_id).toBe(messageIds[5]);
  });

  it('survives multi-pass compaction: leaf then condensed', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Msg ${i} unique content here`,
    }));
    storeMessages(convId, messages, 0);
    const ids = messages.map(m => contentHash(convId, m.role, m.content));
    appendContextItems(convId, ids.map(id => ({ item_type: 'message' as const, message_id: id })));

    // Pass 1: Replace messages 0-9 with leaf-a
    replaceContextItemsWithSummary(convId, ids.slice(0, 10), 'leaf-a');
    let items = getContextItems(convId);
    expect(items).toHaveLength(11); // leaf-a + 10 remaining messages
    expect(items[0].summary_id).toBe('leaf-a');

    // Pass 2: Replace messages 10-19 with leaf-b
    replaceContextItemsWithSummary(convId, ids.slice(10, 20), 'leaf-b');
    items = getContextItems(convId);
    expect(items).toHaveLength(2); // leaf-a, leaf-b
    expect(items[0].summary_id).toBe('leaf-a');
    expect(items[1].summary_id).toBe('leaf-b');

    // Pass 3: Condense leaf-a + leaf-b into condensed-1
    replaceContextSummariesWithCondensed(convId, ['leaf-a', 'leaf-b'], 'condensed-1');
    items = getContextItems(convId);
    expect(items).toHaveLength(1);
    expect(items[0].summary_id).toBe('condensed-1');
    expect(items[0].ordinal).toBe(0);
  });

  it('handles interleaved new messages after compaction', () => {
    // First batch of messages
    const batch1 = [
      { role: 'user' as const, content: 'Batch 1 msg A' },
      { role: 'assistant' as const, content: 'Batch 1 msg B' },
    ];
    storeMessages(convId, batch1, 0);
    const ids1 = batch1.map(m => contentHash(convId, m.role, m.content));
    appendContextItems(convId, ids1.map(id => ({ item_type: 'message' as const, message_id: id })));

    // Compact batch 1 into summary
    replaceContextItemsWithSummary(convId, ids1, 'sum-batch1');

    // New messages arrive (different sequence numbers)
    const batch2 = [
      { role: 'user' as const, content: 'Batch 2 msg C' },
      { role: 'assistant' as const, content: 'Batch 2 msg D' },
    ];
    storeMessages(convId, batch2, 100); // sequence numbers way ahead
    const ids2 = batch2.map(m => contentHash(convId, m.role, m.content));
    appendContextItems(convId, ids2.map(id => ({ item_type: 'message' as const, message_id: id })));

    let items = getContextItems(convId);
    expect(items).toHaveLength(3); // sum-batch1, msg C, msg D
    expect(items[0].summary_id).toBe('sum-batch1');
    expect(items[1].message_id).toBe(ids2[0]);
    expect(items[2].message_id).toBe(ids2[1]);
    // Ordinals are contiguous regardless of message sequence numbers
    expect(items.map(i => i.ordinal)).toEqual([0, 1, 2]);

    // Compact batch 2
    replaceContextItemsWithSummary(convId, ids2, 'sum-batch2');
    items = getContextItems(convId);
    expect(items).toHaveLength(2);
    expect(items.map(i => i.ordinal)).toEqual([0, 1]);
    expect(items[0].summary_id).toBe('sum-batch1');
    expect(items[1].summary_id).toBe('sum-batch2');
  });
});

describe('persist flow: bootstrap tracking', () => {
  it('stores and retrieves bootstrap state', () => {
    expect(getBootstrapState('conv1')).toBeUndefined();

    upsertBootstrapState({
      conversation_id: 'conv1',
      session_file_path: '/tmp/test.jsonl',
      last_seen_size: 1000,
      last_seen_mtime_ms: 123456789,
      last_processed_offset: 1000,
      last_processed_entry_hash: null,
      updated_at: new Date().toISOString(),
    });

    const state = getBootstrapState('conv1');
    expect(state).toBeDefined();
    expect(state!.last_seen_size).toBe(1000);
    expect(state!.session_file_path).toBe('/tmp/test.jsonl');
  });

  it('upserts (updates existing) bootstrap state', () => {
    upsertBootstrapState({
      conversation_id: 'conv1',
      session_file_path: '/tmp/test.jsonl',
      last_seen_size: 1000,
      last_seen_mtime_ms: 100,
      last_processed_offset: 1000,
      last_processed_entry_hash: null,
      updated_at: new Date().toISOString(),
    });

    upsertBootstrapState({
      conversation_id: 'conv1',
      session_file_path: '/tmp/test.jsonl',
      last_seen_size: 2000,
      last_seen_mtime_ms: 200,
      last_processed_offset: 2000,
      last_processed_entry_hash: 'abc',
      updated_at: new Date().toISOString(),
    });

    const state = getBootstrapState('conv1');
    expect(state!.last_seen_size).toBe(2000);
    expect(state!.last_processed_entry_hash).toBe('abc');
  });
});

describe('persist flow: large file storage', () => {
  it('stores and retrieves large files', () => {
    storeLargeFile({
      file_id: 'file_abc123',
      conversation_id: 'conv1',
      file_name: 'bigdata.json',
      mime_type: 'application/json',
      byte_size: 500000,
      storage_uri: '/home/node/.claude/lcm-files/file_abc123',
      exploration_summary: null,
      created_at: new Date().toISOString(),
    });

    const file = getLargeFile('file_abc123');
    expect(file).toBeDefined();
    expect(file!.file_name).toBe('bigdata.json');
    expect(file!.byte_size).toBe(500000);
  });

  it('returns undefined for missing files', () => {
    expect(getLargeFile('file_nonexistent')).toBeUndefined();
  });
});
