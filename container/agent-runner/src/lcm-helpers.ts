/**
 * LCM helper functions extracted for testability.
 * index.ts imports from this module; tests can import directly without triggering main().
 */

import {
  initLcmDatabase,
  getSummariesForConversation,
  getMaxSequence,
  getLcmDb,
  type LcmMessage,
} from './lcm-store.js';

// --- Types ---

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

// --- Configuration ---

const LCM_CONTEXT_WINDOW_FALLBACK = parseInt(process.env.LCM_CONTEXT_WINDOW_TOKENS || '1000000', 10);
let detectedContextWindow: number | null = null;

export function getContextWindowTokens(): number {
  return detectedContextWindow ?? LCM_CONTEXT_WINDOW_FALLBACK;
}

export function setDetectedContextWindow(value: number): void {
  detectedContextWindow = value;
}

export function getDetectedContextWindow(): number | null {
  return detectedContextWindow;
}

/** @internal - for tests only */
export function _resetDetectedContextWindow(): void {
  detectedContextWindow = null;
}

const LCM_PROACTIVE_COMPACTION_THRESHOLD = parseInt(process.env.LCM_PROACTIVE_COMPACTION_THRESHOLD || '75', 10);
const LCM_SUMMARY_BUDGET_PCT = parseInt(process.env.LCM_SUMMARY_BUDGET_PCT || '25', 10);
const LCM_LEAF_CHUNK_TOKENS = parseInt(process.env.LCM_LEAF_CHUNK_TOKENS || '20000', 10);

export { LCM_LEAF_CHUNK_TOKENS };

// --- Pure functions ---

export function getConversationId(input: { groupFolder: string; chatJid: string; threadTs?: string }): string {
  const base = `${input.groupFolder}:${input.chatJid}`;
  return input.threadTs ? `${base}:${input.threadTs}` : base;
}

export function shouldProactivelyCompact(lastInputTokens?: number): boolean {
  if (!lastInputTokens) return false;
  if (LCM_PROACTIVE_COMPACTION_THRESHOLD <= 0 || LCM_PROACTIVE_COMPACTION_THRESHOLD >= 100) return false;
  const contextWindow = getContextWindowTokens();
  const usagePct = (lastInputTokens / contextWindow) * 100;
  return usagePct >= LCM_PROACTIVE_COMPACTION_THRESHOLD;
}

/**
 * Get the total token count for messages not yet covered by any summary.
 * A message is "unsummarized" if its sequence is above the max_sequence of all summaries.
 */
export function getUnsummarizedTokenCount(conversationId: string): number {
  const database = getLcmDb();
  const summaries = getSummariesForConversation(conversationId);
  const maxSummarizedSeq = summaries.length > 0
    ? Math.max(...summaries.map(s => s.max_sequence ?? -1))
    : -1;

  const row = database.prepare(
    'SELECT COALESCE(SUM(token_estimate), 0) as total FROM lcm_messages WHERE conversation_id = ? AND sequence > ?',
  ).get(conversationId, maxSummarizedSeq) as { total: number };

  return row.total;
}

/**
 * Returns true when unsummarized tokens exceed the leaf chunk threshold.
 */
export function shouldSummarize(conversationId: string): boolean {
  const unsummarized = getUnsummarizedTokenCount(conversationId);
  return unsummarized >= LCM_LEAF_CHUNK_TOKENS;
}

/**
 * Extract human-readable text from a ParsedMessage's content.
 * Handles both plain text and JSON-serialized content blocks.
 * Used by the summarizer to get text for LLM summarization.
 */
export function extractText(message: ParsedMessage): string {
  // Try to parse as JSON (structured blocks)
  try {
    const blocks = JSON.parse(message.content);
    if (!Array.isArray(blocks)) return message.content;

    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        parts.push(`[Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`);
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content.slice(0, 500)
          : JSON.stringify(block.content).slice(0, 500);
        parts.push(`[Tool result: ${resultText}]`);
      } else if (block.type === 'thinking' && block.thinking) {
        parts.push(`[Thinking: ${block.thinking.slice(0, 300)}]`);
      }
    }
    return parts.join('\n');
  } catch {
    // Plain text content
    return message.content;
  }
}

/**
 * Parse transcript JSONL into messages.
 * Stores ALL content verbatim (lossless) — user prompts, assistant text,
 * tool_use, tool_result, thinking blocks. Content is serialized as JSON
 * for structured blocks or plain text for simple string content.
 */
export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        // User content is either a plain string (prompt) or array of blocks (tool_results)
        const msgContent = entry.message.content;
        if (typeof msgContent === 'string') {
          if (msgContent) messages.push({ role: 'user', content: msgContent });
        } else if (Array.isArray(msgContent)) {
          // Serialize tool_result blocks as JSON — lossless
          const serialized = JSON.stringify(msgContent);
          messages.push({ role: 'user', content: serialized });
        }
      } else if (entry.type === 'assistant' && entry.message?.content) {
        // Assistant content is always an array of blocks (text, tool_use, thinking)
        const blocks = entry.message.content;
        if (Array.isArray(blocks) && blocks.length > 0) {
          // Serialize all blocks as JSON — lossless
          const serialized = JSON.stringify(blocks);
          messages.push({ role: 'assistant', content: serialized });
        }
      }
    } catch {
    }
  }

  return messages;
}

/**
 * Assemble LCM summary context for injection into system prompt.
 * Returns formatted XML summary blocks, or null if no summaries are available.
 */
export function assembleLcmContext(conversationId: string, dbPath: string): string | null {
  try {
    initLcmDatabase(dbPath);
  } catch {
    return null;
  }

  const allSummaries = getSummariesForConversation(conversationId);
  if (allSummaries.length === 0) return null;

  // Build set of leaf IDs covered by condensed summaries
  const coveredLeafIds = new Set<string>();
  const condensed = allSummaries.filter(s => s.depth > 0);
  for (const cs of condensed) {
    if (cs.child_summary_ids) {
      for (const childId of JSON.parse(cs.child_summary_ids) as string[]) {
        coveredLeafIds.add(childId);
      }
    }
  }

  // Prioritize: condensed (high depth) first, then uncovered leaves
  const uncoveredLeaves = allSummaries.filter(s => s.depth === 0 && !coveredLeafIds.has(s.id));
  const sorted = [
    ...condensed.sort((a, b) => b.depth - a.depth || (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
    ...uncoveredLeaves.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
  ];

  // Fit within budget
  const budgetTokens = Math.floor(LCM_SUMMARY_BUDGET_PCT / 100 * getContextWindowTokens());
  let remainingBudget = budgetTokens;
  const selected: typeof sorted = [];

  for (const summary of sorted) {
    const tokens = summary.token_estimate || Math.ceil(summary.content.length / 4);
    if (tokens > remainingBudget) continue;
    selected.push(summary);
    remainingBudget -= tokens;
  }

  if (selected.length === 0) return null;

  // Sort selected by sequence for chronological presentation
  selected.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0));

  // Format as XML blocks
  const blocks = selected.map(s =>
    `<lcm_summary id="${s.id}" depth="${s.depth}" tokens="${s.token_estimate}" created="${s.created_at}">\n${s.content}\n</lcm_summary>`
  );

  return `## Conversation History (LCM Summaries)

The following are summaries of previous conversation segments that were compacted from this session's history. They are ordered chronologically. You can use the lcm_grep, lcm_describe, and lcm_expand MCP tools to search and drill into specific details.

${blocks.join('\n\n')}`;
}
