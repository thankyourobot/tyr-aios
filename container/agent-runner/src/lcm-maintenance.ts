/**
 * LCM Maintenance: conversation pruning and integrity checking.
 */

import {
  getLcmDb,
  getSummariesForConversation,
  getContextItems,
  getSummaryById,
  getMessagesForSummary,
  getChildSummaries,
  type LcmSummary,
} from './lcm-store.js';
import fs from 'fs';

// --- Pruning ---

export interface PruneResult {
  conversationsDeleted: number;
  messagesDeleted: number;
  summariesDeleted: number;
  contextItemsDeleted: number;
  partsDeleted: number;
  filesDeleted: number;
  fileBytesFreed: number;
}

/**
 * Delete all LCM data for conversations with no messages newer than the cutoff.
 * Pass dryRun=true to preview without deleting.
 */
export function pruneConversations(
  beforeDate: Date,
  dryRun = true,
): PruneResult & { dryRun: boolean } {
  const database = getLcmDb();
  const cutoff = beforeDate.toISOString();

  // Find conversations where ALL messages are older than the cutoff
  const staleConversations = database.prepare(`
    SELECT conversation_id, COUNT(*) as msg_count, MAX(created_at) as newest
    FROM lcm_messages
    GROUP BY conversation_id
    HAVING MAX(created_at) < ?
  `).all(cutoff) as Array<{ conversation_id: string; msg_count: number; newest: string }>;

  if (staleConversations.length === 0) {
    return { conversationsDeleted: 0, messagesDeleted: 0, summariesDeleted: 0, contextItemsDeleted: 0, partsDeleted: 0, filesDeleted: 0, fileBytesFreed: 0, dryRun };
  }

  const convIds = staleConversations.map(c => c.conversation_id);

  if (dryRun) {
    // Count what would be deleted
    let totalMessages = 0;
    let totalSummaries = 0;
    let totalContextItems = 0;
    let totalParts = 0;
    let totalFiles = 0;
    let totalFileBytes = 0;

    for (const convId of convIds) {
      const placeholders = '?';
      totalMessages += (database.prepare(`SELECT COUNT(*) as c FROM lcm_messages WHERE conversation_id = ${placeholders}`).get(convId) as { c: number }).c;
      totalSummaries += (database.prepare(`SELECT COUNT(*) as c FROM lcm_summaries WHERE conversation_id = ${placeholders}`).get(convId) as { c: number }).c;
      totalContextItems += (database.prepare(`SELECT COUNT(*) as c FROM lcm_context_items WHERE conversation_id = ${placeholders}`).get(convId) as { c: number }).c;

      const msgIds = database.prepare(`SELECT id FROM lcm_messages WHERE conversation_id = ?`).all(convId) as Array<{ id: string }>;
      for (const { id } of msgIds) {
        totalParts += (database.prepare('SELECT COUNT(*) as c FROM lcm_message_parts WHERE message_id = ?').get(id) as { c: number }).c;
      }

      const files = database.prepare(`SELECT storage_uri, byte_size FROM lcm_large_files WHERE conversation_id = ?`).all(convId) as Array<{ storage_uri: string; byte_size: number | null }>;
      totalFiles += files.length;
      totalFileBytes += files.reduce((sum, f) => sum + (f.byte_size ?? 0), 0);
    }

    return { conversationsDeleted: convIds.length, messagesDeleted: totalMessages, summariesDeleted: totalSummaries, contextItemsDeleted: totalContextItems, partsDeleted: totalParts, filesDeleted: totalFiles, fileBytesFreed: totalFileBytes, dryRun };
  }

  // Actually delete
  const result: PruneResult = { conversationsDeleted: 0, messagesDeleted: 0, summariesDeleted: 0, contextItemsDeleted: 0, partsDeleted: 0, filesDeleted: 0, fileBytesFreed: 0 };

  database.transaction(() => {
    for (const convId of convIds) {
      // Delete large files from disk
      const files = database.prepare('SELECT storage_uri, byte_size FROM lcm_large_files WHERE conversation_id = ?').all(convId) as Array<{ storage_uri: string; byte_size: number | null }>;
      for (const f of files) {
        try { fs.unlinkSync(f.storage_uri); } catch { /* file may already be gone */ }
        result.fileBytesFreed += f.byte_size ?? 0;
      }
      result.filesDeleted += files.length;

      // Delete message parts (need message IDs first)
      const msgIds = database.prepare('SELECT id FROM lcm_messages WHERE conversation_id = ?').all(convId) as Array<{ id: string }>;
      for (const { id } of msgIds) {
        result.partsDeleted += database.prepare('DELETE FROM lcm_message_parts WHERE message_id = ?').run(id).changes;
      }

      // Delete junction table entries
      const sumIds = database.prepare('SELECT id FROM lcm_summaries WHERE conversation_id = ?').all(convId) as Array<{ id: string }>;
      for (const { id } of sumIds) {
        database.prepare('DELETE FROM lcm_summary_messages WHERE summary_id = ?').run(id);
        database.prepare('DELETE FROM lcm_summary_parents WHERE summary_id = ?').run(id);
      }

      // Delete core tables
      result.messagesDeleted += database.prepare('DELETE FROM lcm_messages WHERE conversation_id = ?').run(convId).changes;
      result.summariesDeleted += database.prepare('DELETE FROM lcm_summaries WHERE conversation_id = ?').run(convId).changes;
      result.contextItemsDeleted += database.prepare('DELETE FROM lcm_context_items WHERE conversation_id = ?').run(convId).changes;
      database.prepare('DELETE FROM lcm_large_files WHERE conversation_id = ?').run(convId);
      database.prepare('DELETE FROM lcm_bootstrap_state WHERE conversation_id = ?').run(convId);
      result.conversationsDeleted++;
    }
  })();

  return { ...result, dryRun: false };
}

// --- Integrity Checking ---

export interface IntegrityFinding {
  check: string;
  severity: 'error' | 'warning';
  message: string;
  details?: string;
}

/**
 * Run integrity checks on the LCM database for a specific conversation.
 * Returns a list of findings. Empty list means healthy.
 */
export function checkIntegrity(conversationId: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const database = getLcmDb();

  // 1. Context items contiguous ordinals
  const contextItems = getContextItems(conversationId);
  for (let i = 0; i < contextItems.length; i++) {
    if (contextItems[i].ordinal !== i) {
      findings.push({
        check: 'context_items_contiguous',
        severity: 'error',
        message: `Ordinal gap: expected ${i}, got ${contextItems[i].ordinal}`,
        details: `item_type=${contextItems[i].item_type}, message_id=${contextItems[i].message_id}, summary_id=${contextItems[i].summary_id}`,
      });
      break; // One finding is enough to flag the issue
    }
  }

  // 2. Context items reference valid records
  for (const item of contextItems) {
    if (item.item_type === 'message' && item.message_id) {
      const exists = database.prepare('SELECT 1 FROM lcm_messages WHERE id = ?').get(item.message_id);
      if (!exists) {
        findings.push({
          check: 'context_items_valid_refs',
          severity: 'error',
          message: `Context item references missing message: ${item.message_id}`,
          details: `ordinal=${item.ordinal}`,
        });
      }
    }
    if (item.item_type === 'summary' && item.summary_id) {
      const exists = database.prepare('SELECT 1 FROM lcm_summaries WHERE id = ?').get(item.summary_id);
      if (!exists) {
        findings.push({
          check: 'context_items_valid_refs',
          severity: 'error',
          message: `Context item references missing summary: ${item.summary_id}`,
          details: `ordinal=${item.ordinal}`,
        });
      }
    }
  }

  // 3. Leaf summaries have message lineage (via junction table)
  const leafSummaries = getSummariesForConversation(conversationId, { depth: 0 });
  for (const leaf of leafSummaries) {
    const messages = getMessagesForSummary(leaf.id);
    if (messages.length === 0 && leaf.min_sequence !== null) {
      // Check if we at least have a sequence range to fall back on
      const rangeCount = database.prepare(
        'SELECT COUNT(*) as c FROM lcm_messages WHERE conversation_id = ? AND sequence >= ? AND sequence <= ?',
      ).get(conversationId, leaf.min_sequence, leaf.max_sequence) as { c: number };
      if (rangeCount.c === 0) {
        findings.push({
          check: 'summaries_have_lineage',
          severity: 'warning',
          message: `Leaf summary ${leaf.id} has no linked messages and no messages in sequence range ${leaf.min_sequence}-${leaf.max_sequence}`,
        });
      }
    }
  }

  // 4. Condensed summaries have child lineage (via junction table)
  const condensedSummaries = getSummariesForConversation(conversationId).filter(s => s.depth > 0);
  for (const cs of condensedSummaries) {
    const children = getChildSummaries(cs.id);
    if (children.length === 0) {
      findings.push({
        check: 'summaries_have_lineage',
        severity: 'warning',
        message: `Condensed summary ${cs.id} (depth ${cs.depth}) has no child summaries linked`,
      });
    }
  }

  // 5. No orphan summaries (summaries not in context window and not children of another summary)
  const contextSummaryIds = new Set(contextItems.filter(i => i.summary_id).map(i => i.summary_id!));
  const childSummaryIds = new Set<string>();
  for (const s of [...leafSummaries, ...condensedSummaries]) {
    const children = getChildSummaries(s.id);
    for (const c of children) {
      childSummaryIds.add(c.id);
    }
  }
  for (const s of [...leafSummaries, ...condensedSummaries]) {
    if (!contextSummaryIds.has(s.id) && !childSummaryIds.has(s.id)) {
      findings.push({
        check: 'no_orphan_summaries',
        severity: 'warning',
        message: `Summary ${s.id} (depth ${s.depth}) is not in context window and not a child of another summary`,
      });
    }
  }

  // 6. Message sequence contiguous
  const seqRows = database.prepare(
    'SELECT sequence FROM lcm_messages WHERE conversation_id = ? ORDER BY sequence',
  ).all(conversationId) as Array<{ sequence: number }>;
  for (let i = 1; i < seqRows.length; i++) {
    if (seqRows[i].sequence !== seqRows[i - 1].sequence + 1) {
      findings.push({
        check: 'message_seq_contiguous',
        severity: 'warning',
        message: `Message sequence gap: ${seqRows[i - 1].sequence} -> ${seqRows[i].sequence}`,
      });
      break;
    }
  }

  // 7. No duplicate context refs (same message or summary appearing twice)
  const seenMsgIds = new Set<string>();
  const seenSumIds = new Set<string>();
  for (const item of contextItems) {
    if (item.message_id) {
      if (seenMsgIds.has(item.message_id)) {
        findings.push({
          check: 'no_duplicate_context_refs',
          severity: 'error',
          message: `Duplicate message in context window: ${item.message_id}`,
          details: `ordinal=${item.ordinal}`,
        });
      }
      seenMsgIds.add(item.message_id);
    }
    if (item.summary_id) {
      if (seenSumIds.has(item.summary_id)) {
        findings.push({
          check: 'no_duplicate_context_refs',
          severity: 'error',
          message: `Duplicate summary in context window: ${item.summary_id}`,
          details: `ordinal=${item.ordinal}`,
        });
      }
      seenSumIds.add(item.summary_id);
    }
  }

  return findings;
}

/**
 * Run integrity checks on ALL conversations in the database.
 */
export function checkAllIntegrity(): Map<string, IntegrityFinding[]> {
  const database = getLcmDb();
  const conversations = database.prepare(
    'SELECT DISTINCT conversation_id FROM lcm_messages',
  ).all() as Array<{ conversation_id: string }>;

  const results = new Map<string, IntegrityFinding[]>();
  for (const { conversation_id } of conversations) {
    const findings = checkIntegrity(conversation_id);
    if (findings.length > 0) {
      results.set(conversation_id, findings);
    }
  }
  return results;
}
