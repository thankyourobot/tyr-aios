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

const LARGE_CONTENT_THRESHOLD = 25000; // ~6K tokens — externalize for summarization

/**
 * Strip base64 data URLs and replace with placeholder.
 */
function stripBinaryPayloads(text: string): string {
  return text.replace(/data:[a-zA-Z]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/g,
    (match) => {
      const mimeMatch = match.match(/^data:([^;]+)/);
      const mime = mimeMatch ? mimeMatch[1] : 'unknown';
      const sizeKB = Math.round(match.length * 0.75 / 1024);
      return `[binary content: ${mime}, ~${sizeKB}KB]`;
    });
}

/**
 * Generate a structural summary for large tool results.
 * Used instead of the full content when feeding to the summarizer.
 */
function summarizeLargeContent(text: string): string {
  const lines = text.split('\n');
  const lineCount = lines.length;
  const charCount = text.length;
  const tokenEstimate = Math.ceil(charCount / 4);

  // Detect content type and extract structure
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // JSON — show top-level keys/shape
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return `[Large JSON array: ${parsed.length} items, ~${tokenEstimate} tokens. First item keys: ${Object.keys(parsed[0] || {}).slice(0, 10).join(', ')}]`;
      }
      return `[Large JSON object: ${Object.keys(parsed).length} keys (${Object.keys(parsed).slice(0, 15).join(', ')}), ~${tokenEstimate} tokens]`;
    } catch { /* not valid JSON, fall through */ }
  }

  // Code — show imports and top-level definitions
  const imports = lines.filter(l => /^(import |from |require\(|#include|using )/.test(l.trim())).slice(0, 10);
  const defs = lines.filter(l => /^(export |function |class |interface |type |const |def |async function )/.test(l.trim())).slice(0, 15);
  if (imports.length > 0 || defs.length > 0) {
    const parts = [`[Large code file: ${lineCount} lines, ~${tokenEstimate} tokens]`];
    if (imports.length > 0) parts.push(`Imports: ${imports.map(l => l.trim()).join('; ')}`);
    if (defs.length > 0) parts.push(`Definitions: ${defs.map(l => l.trim().slice(0, 80)).join('; ')}`);
    return parts.join('\n');
  }

  // CSV/TSV — show headers and row count
  if (lines.length > 5 && (lines[0].includes(',') || lines[0].includes('\t'))) {
    return `[Large tabular data: ${lineCount} rows, ~${tokenEstimate} tokens. Headers: ${lines[0].slice(0, 200)}]`;
  }

  // Generic — show first and last few lines
  const first3 = lines.slice(0, 3).join('\n');
  const last2 = lineCount > 10 ? lines.slice(-2).join('\n') : '';
  return `[Large content: ${lineCount} lines, ~${tokenEstimate} tokens]\n${first3}${last2 ? '\n...\n' + last2 : ''}`;
}

/**
 * Extract human-readable text from a ParsedMessage's content.
 * Handles both plain text and JSON-serialized content blocks.
 * Used by the summarizer to get text for LLM summarization.
 * Large tool results are replaced with structural summaries.
 * Binary payloads (base64 data URLs) are stripped.
 */
export function extractText(message: ParsedMessage): string {
  // Try to parse as JSON (structured blocks)
  try {
    const blocks = JSON.parse(message.content);
    if (!Array.isArray(blocks)) return stripBinaryPayloads(message.content);

    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        parts.push(stripBinaryPayloads(block.text));
      } else if (block.type === 'tool_use') {
        const inputStr = JSON.stringify(block.input).slice(0, 200);
        parts.push(`[Tool: ${block.name}(${inputStr})]`);
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        // Large results get structural summaries instead of truncated content
        if (resultText.length > LARGE_CONTENT_THRESHOLD) {
          parts.push(summarizeLargeContent(resultText));
        } else {
          parts.push(`[Tool result: ${stripBinaryPayloads(resultText).slice(0, 500)}]`);
        }
      } else if (block.type === 'thinking' && block.thinking) {
        parts.push(`[Thinking: ${block.thinking.slice(0, 300)}]`);
      }
    }
    return parts.join('\n');
  } catch {
    // Plain text content — strip binary payloads
    return stripBinaryPayloads(message.content);
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

  // Format as XML blocks with metadata
  const blocks = selected.map(s =>
    `<lcm_summary id="${s.id}" depth="${s.depth}" tokens="${s.token_estimate}" created="${s.created_at}">\n${s.content}\n</lcm_summary>`
  );

  // Dynamic header based on compaction depth
  const maxDepth = Math.max(...selected.map(s => s.depth));
  const condensedCount = selected.filter(s => s.depth > 0).length;

  let header = `## Conversation History (LCM Summaries)

The following are summaries of previous conversation segments. They are ordered chronologically. You can use lcm_grep to search, lcm_describe to inspect, and lcm_expand to drill into specific details.`;

  if (maxDepth >= 2 || condensedCount >= 2) {
    header += `

IMPORTANT: These summaries compress significant conversation detail through multiple levels of condensation. Before asserting specific facts, names, numbers, or decisions from these summaries, use lcm_expand to verify the details against the original messages. Summaries may omit nuance or context that matters.`;
  }

  return `${header}

${blocks.join('\n\n')}`;
}
