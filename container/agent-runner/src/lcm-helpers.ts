/**
 * LCM helper functions extracted for testability.
 * index.ts imports from this module; tests can import directly without triggering main().
 */

import crypto from 'crypto';
import {
  initLcmDatabase,
  getSummariesForConversation,
  getMaxSequence,
  getLcmDb,
  type LcmMessage,
  type LcmMessagePart,
} from './lcm-store.js';
import { scoreRelevance } from './lcm-relevance.js';

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

const LCM_FRESHNESS_WINDOW = parseInt(process.env.LCM_FRESHNESS_WINDOW || '32', 10);

/**
 * Get the token count for messages eligible for summarization —
 * unsummarized messages MINUS the freshness window (most recent N messages).
 */
export function getSummarizableTokenCount(conversationId: string): number {
  const database = getLcmDb();
  const summaries = getSummariesForConversation(conversationId);
  const maxSummarizedSeq = summaries.length > 0
    ? Math.max(...summaries.map(s => s.max_sequence ?? -1))
    : -1;

  // Count unsummarized messages
  const countRow = database.prepare(
    'SELECT COUNT(*) as cnt FROM lcm_messages WHERE conversation_id = ? AND sequence > ?',
  ).get(conversationId, maxSummarizedSeq) as { cnt: number };

  const eligibleCount = Math.max(0, countRow.cnt - LCM_FRESHNESS_WINDOW);
  if (eligibleCount === 0) return 0;

  // Sum tokens for only the eligible messages (oldest unsummarized, excluding freshness window)
  const row = database.prepare(
    'SELECT COALESCE(SUM(token_estimate), 0) as total FROM (SELECT token_estimate FROM lcm_messages WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?)',
  ).get(conversationId, maxSummarizedSeq, eligibleCount) as { total: number };

  return row.total;
}

/**
 * Returns true when summarizable tokens (outside freshness window) exceed the threshold.
 */
export function shouldSummarize(conversationId: string): boolean {
  const summarizable = getSummarizableTokenCount(conversationId);
  return summarizable >= LCM_LEAF_CHUNK_TOKENS;
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
 * Extract ONLY plain text from a message, stripping all tool_use/tool_result/thinking blocks.
 * Matches the original Lossless-Claw behavior: tool content is filtered out before summarization.
 * Used by the summarizer to get clean conversational text.
 */
export function extractTextForSummary(message: ParsedMessage): string {
  // Try to parse as JSON (structured blocks)
  try {
    const blocks = JSON.parse(message.content);
    if (!Array.isArray(blocks)) return stripBinaryPayloads(message.content);

    // Only extract text blocks — skip tool_use, tool_result, thinking entirely
    const textParts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(stripBinaryPayloads(block.text));
      }
    }
    return textParts.join('\n');
  } catch {
    return stripBinaryPayloads(message.content);
  }
}

/**
 * Extract human-readable text from a ParsedMessage's content.
 * Includes tool_use/tool_result annotations for display contexts (lcm_expand, lcm_grep).
 * NOT used for summarization — use extractTextForSummary instead.
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

// --- Message decomposition ---

/**
 * Decompose a message's content into typed parts for structured storage and querying.
 */
export function decomposeMessage(messageId: string, content: string): LcmMessagePart[] {
  const parts: LcmMessagePart[] = [];

  try {
    const blocks = JSON.parse(content);
    if (!Array.isArray(blocks)) {
      // Plain text content
      parts.push({
        part_id: crypto.createHash('sha256').update(`${messageId}:0`).digest('hex').slice(0, 16),
        message_id: messageId,
        part_type: 'text',
        ordinal: 0,
        text_content: content,
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_output: null,
        metadata: null,
      });
      return parts;
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const partId = crypto.createHash('sha256').update(`${messageId}:${i}`).digest('hex').slice(0, 16);
      const base = {
        part_id: partId,
        message_id: messageId,
        ordinal: i,
        text_content: null as string | null,
        tool_call_id: null as string | null,
        tool_name: null as string | null,
        tool_input: null as string | null,
        tool_output: null as string | null,
        metadata: null as string | null,
      };

      if (block.type === 'text') {
        parts.push({ ...base, part_type: 'text', text_content: block.text ?? null });
      } else if (block.type === 'tool_use') {
        parts.push({
          ...base,
          part_type: 'tool',
          tool_call_id: block.id ?? null,
          tool_name: block.name ?? null,
          tool_input: block.input ? JSON.stringify(block.input) : null,
        });
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        parts.push({
          ...base,
          part_type: 'tool',
          tool_call_id: block.tool_use_id ?? null,
          tool_output: resultText,
        });
      } else if (block.type === 'thinking') {
        parts.push({ ...base, part_type: 'reasoning', text_content: block.thinking ?? null });
      }
    }
  } catch {
    // Plain text content (not JSON)
    parts.push({
      part_id: crypto.createHash('sha256').update(`${messageId}:0`).digest('hex').slice(0, 16),
      message_id: messageId,
      part_type: 'text',
      ordinal: 0,
      text_content: content,
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      metadata: null,
    });
  }

  return parts;
}

// --- Recall Policy ---

const RECALL_POLICY_PROMPT = `
## Lossless Recall Policy

The lossless context management (LCM) system is active. These summaries are compressed context from earlier in the conversation.

**Conflict handling:** If newer evidence conflicts with an older summary, prefer the newer evidence. Do not trust a stale summary over fresher contradictory information.

**Contradictions/uncertainty:** If facts seem contradictory or uncertain, verify with LCM recall tools before answering instead of trusting the summary at face value.

**Tool escalation (use in this order):**
1. \`lcm_grep\` — search by keyword across messages and summaries (fast, cheap)
2. \`lcm_describe\` — inspect a specific summary node's metadata and subtree (no API call)
3. \`lcm_expand\` — deep recall on a specific summary: navigates the DAG to answer a focused question (~15s)
4. \`lcm_expand_query\` — exploratory recall: searches for relevant summaries and expands them to answer a question (~30s)

**When to expand:** Before asserting exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries. If a summary includes an "Expand for details about:" footer, use it as a cue.

**Usage examples:**
- \`lcm_grep({ query: "database migration", scope: "both" })\`
- \`lcm_describe({ id: "sum_abc123" })\`
- \`lcm_expand({ id: "sum_abc123", query: "What config changes were made?" })\`
- \`lcm_expand_query({ query: "auth middleware", prompt: "What strategy was decided for session tokens?" })\`
`.trim();

/**
 * Assemble LCM summary context for injection into system prompt.
 * Returns formatted XML summary blocks, or null if no summaries are available.
 */
export function assembleLcmContext(conversationId: string, dbPath: string, prompt?: string): string | null {
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

  // Fit within budget — use relevance scoring when prompt is available and not all items fit
  const budgetTokens = Math.floor(LCM_SUMMARY_BUDGET_PCT / 100 * getContextWindowTokens());
  const totalTokens = sorted.reduce((sum, s) => sum + (s.token_estimate || Math.ceil(s.content.length / 4)), 0);
  let remainingBudget = budgetTokens;
  const selected: typeof sorted = [];

  if (prompt && totalTokens > budgetTokens) {
    // Score within priority tiers: condensed first (preserves DAG hierarchy), then uncovered leaves
    const tiers = [
      condensed.sort((a, b) => b.depth - a.depth || (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
      uncoveredLeaves.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
    ];

    for (const tier of tiers) {
      const scored = tier.map(s => ({
        summary: s,
        tokens: s.token_estimate || Math.ceil(s.content.length / 4),
        score: scoreRelevance(s.content, prompt),
      }));
      scored.sort((a, b) => b.score - a.score);

      for (const item of scored) {
        if (item.tokens > remainingBudget) continue;
        selected.push(item.summary);
        remainingBudget -= item.tokens;
      }
    }
  } else {
    // Chronological selection (default — all fit or no prompt)
    for (const summary of sorted) {
      const tokens = summary.token_estimate || Math.ceil(summary.content.length / 4);
      if (tokens > remainingBudget) continue;
      selected.push(summary);
      remainingBudget -= tokens;
    }
  }

  if (selected.length === 0) return null;

  // Sort selected by sequence for chronological presentation
  selected.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0));

  // Format as XML blocks with rich metadata
  const blocks = selected.map(s => {
    const kind = s.kind ?? (s.depth === 0 ? 'leaf' : 'condensed');
    const attrs = [
      `id="${s.id}"`,
      `kind="${kind}"`,
      `depth="${s.depth}"`,
      s.descendant_count ? `descendant_count="${s.descendant_count}"` : null,
      s.earliest_at ? `earliest_at="${s.earliest_at}"` : null,
      s.latest_at ? `latest_at="${s.latest_at}"` : null,
    ].filter(Boolean).join(' ');

    // Add parent references for condensed summaries
    let parentsBlock = '';
    if (s.depth > 0 && s.child_summary_ids) {
      try {
        const childIds = JSON.parse(s.child_summary_ids) as string[];
        if (childIds.length > 0) {
          const refs = childIds.map(id => `    <summary_ref id="${id}" />`).join('\n');
          parentsBlock = `\n  <parents>\n${refs}\n  </parents>`;
        }
      } catch { /* ignore parse errors */ }
    }

    return `<summary ${attrs}>${parentsBlock}\n  <content>\n${s.content}\n  </content>\n</summary>`;
  });

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

${blocks.join('\n\n')}

${RECALL_POLICY_PROMPT}`;
}
