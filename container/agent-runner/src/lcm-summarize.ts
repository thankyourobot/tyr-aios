/**
 * LCM Summarization Logic
 * Aligned with original Lossless-Claw (Martian-Engineering/lossless-claw) design.
 * Leaf summaries from raw messages, condensation of leaf summaries.
 * Returns null when API is unavailable — no deterministic fallbacks.
 */

import crypto from 'crypto';
import { extractTextForSummary } from './lcm-helpers.js';
import { summarizationBreaker } from './lcm-circuit-breaker.js';

// --- Configuration ---

const LCM_SUMMARY_MODEL = process.env.LCM_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const LCM_SUMMARIZE_TIMEOUT_MS = parseInt(process.env.LCM_SUMMARIZE_TIMEOUT_MS || '30000', 10);
const LCM_CONDENSE_THRESHOLD = parseInt(process.env.LCM_CONDENSE_THRESHOLD || '8', 10);
const MAX_CONDENSE_DEPTH = 3;
const DEFAULT_LEAF_TARGET_TOKENS = 2400;
const DEFAULT_CONDENSED_TARGET_TOKENS = 2000;
const LCM_SUMMARY_MAX_OVERAGE_FACTOR = parseInt(process.env.LCM_SUMMARY_MAX_OVERAGE_FACTOR || '3', 10);

export { LCM_CONDENSE_THRESHOLD };

// --- Types ---

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SummaryResult {
  id: string;
  content: string;
  sourceMessageIds: string[];
  minSequence: number;
  maxSequence: number;
}

export interface CondensedResult {
  id: string;
  content: string;
  childSummaryIds: string[];
  minSequence: number;
  maxSequence: number;
  depth: number;
}

// --- System prompt (matches original Lossless-Claw) ---

const LCM_SYSTEM_PROMPT =
  'You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only.';

// --- Token targeting (matches original) ---

function resolveTargetTokens(inputTokens: number, isCondensed: boolean): number {
  if (isCondensed) {
    return Math.max(512, DEFAULT_CONDENSED_TARGET_TOKENS);
  }
  return Math.max(192, Math.min(DEFAULT_LEAF_TARGET_TOKENS, Math.floor(inputTokens * 0.35)));
}

// --- API ---

function hasApiCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Cap summary text that exceeds the overage threshold.
 * Truncates to approximately targetTokens worth of characters and appends a marker.
 */
function capSummaryOverage(text: string, targetTokens: number): string {
  const estimatedTokens = Math.ceil(text.length / 4);
  const maxTokens = targetTokens * LCM_SUMMARY_MAX_OVERAGE_FACTOR;
  if (estimatedTokens <= maxTokens) return text;

  const maxChars = maxTokens * 4;
  const truncated = text.slice(0, maxChars);
  // Try to truncate at a sentence boundary
  const lastPeriod = truncated.lastIndexOf('. ');
  const cutPoint = lastPeriod > maxChars * 0.7 ? lastPeriod + 1 : maxChars;
  return truncated.slice(0, cutPoint) + '\n\n[Summary truncated — exceeded token budget]';
}

const BREAKER_KEY = LCM_SUMMARY_MODEL;

async function callAnthropicAPI(userContent: string, maxTokens: number = 2048): Promise<string | null> {
  if (!hasApiCredentials()) {
    console.error('[lcm-summarize] No API credentials available, skipping API call');
    return null;
  }

  // Circuit breaker check
  if (summarizationBreaker.isOpen(BREAKER_KEY)) {
    console.error(`[lcm-summarize] Circuit breaker open for ${BREAKER_KEY}, skipping API call`);
    return null;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  } else {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';
    headers['Authorization'] = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LCM_SUMMARIZE_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LCM_SUMMARY_MODEL,
        max_tokens: maxTokens,
        system: LCM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[lcm-summarize] API error: ${response.status} ${response.statusText}`);
      // Record auth failures for circuit breaker
      if (response.status === 401 || response.status === 403) {
        summarizationBreaker.recordFailure(BREAKER_KEY);
      }
      return null;
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const textParts = data.content?.filter(c => c.type === 'text').map(c => c.text);
    const result = textParts?.join('') || null;

    if (result) {
      summarizationBreaker.recordSuccess(BREAKER_KEY);
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[lcm-summarize] API call timed out after ${LCM_SUMMARIZE_TIMEOUT_MS}ms`);
    } else {
      console.error(`[lcm-summarize] API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function generateSummaryId(): string {
  return `sum_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --- Prompt builders (aligned with original Lossless-Claw) ---

function buildLeafPrompt(text: string, targetTokens: number, previousSummary?: string): string {
  const previousContext = previousSummary?.trim() || '(none)';

  return [
    'You summarize a SEGMENT of an agent conversation for future model turns.',
    'Treat this as incremental memory compaction input, not a full-conversation summary.',
    '',
    'Normal summary policy:',
    '- Preserve key decisions, rationale, constraints, and active tasks.',
    '- Keep essential technical details needed to continue work safely.',
    '- Remove obvious repetition and conversational filler.',
    '- Routine scheduled check-ins with no actions taken may be compressed to a single line noting the check occurred.',
    '',
    'Output requirements:',
    '- Plain text only.',
    '- No preamble, headings, or markdown formatting.',
    '- Keep it concise while preserving required details.',
    '- Track file operations (created, modified, deleted, renamed) with file paths and current status.',
    '- If no file operations appear, include exactly: "Files: none".',
    '- End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
    `- Target length: about ${targetTokens} tokens or less.`,
    '',
    `<previous_context>\n${previousContext}\n</previous_context>`,
    '',
    `<conversation_segment>\n${text}\n</conversation_segment>`,
  ].join('\n');
}

function buildD1Prompt(text: string, targetTokens: number, previousSummary?: string): string {
  const previousContext = previousSummary?.trim();
  const previousContextBlock = previousContext
    ? [
        'It already has this preceding summary as context. Do not repeat information',
        'that appears there unchanged. Focus on what is new, changed, or resolved:',
        '',
        `<previous_context>\n${previousContext}\n</previous_context>`,
      ].join('\n')
    : 'Focus on what matters for continuation:';

  return [
    'You are compacting leaf-level conversation summaries into a single condensed memory node.',
    'You are preparing context for a fresh model instance that will continue this conversation.',
    '',
    previousContextBlock,
    '',
    'Preserve:',
    '- Decisions made and their rationale when rationale matters going forward.',
    '- Earlier decisions that were superseded, and what replaced them.',
    '- Completed tasks/topics with outcomes.',
    '- In-progress items with current state and what remains.',
    '- Blockers, open questions, and unresolved tensions.',
    '- Specific references (names, paths, URLs, identifiers) needed for continuation.',
    '',
    'Drop low-value detail:',
    '- Context that has not changed from previous_context.',
    '- Intermediate dead ends where the conclusion is already known.',
    '- Transient states that are already resolved.',
    '- Tool-internal mechanics and process scaffolding.',
    '',
    'Use plain text. No mandatory structure.',
    'Include a timeline with timestamps (hour or half-hour) for significant events.',
    'Present information chronologically and mark superseded decisions.',
    'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
    `Target length: about ${targetTokens} tokens.`,
    '',
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join('\n');
}

function buildD2Prompt(text: string, targetTokens: number): string {
  return [
    'You are condensing multiple session-level summaries into a higher-level memory node.',
    'A future model should understand trajectory, not per-session minutiae.',
    '',
    'Preserve:',
    '- Decisions still in effect and their rationale.',
    '- Decisions that evolved: what changed and why.',
    '- Completed work with outcomes.',
    '- Active constraints, limitations, and known issues.',
    '- Current state of in-progress work.',
    '',
    'Drop:',
    '- Session-local operational detail and process mechanics.',
    '- Identifiers that are no longer relevant.',
    '- Intermediate states superseded by later outcomes.',
    '',
    'Use plain text. Brief headers are fine if useful.',
    'Include a timeline with dates and approximate time of day for key milestones.',
    'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
    `Target length: about ${targetTokens} tokens.`,
    '',
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join('\n');
}

function buildD3PlusPrompt(text: string, targetTokens: number): string {
  return [
    'You are creating a high-level memory node from multiple phase-level summaries.',
    'This may persist for the rest of the conversation. Keep only durable context.',
    '',
    'Preserve:',
    '- Key decisions and rationale.',
    '- What was accomplished and current state.',
    '- Active constraints and hard limitations.',
    '- Important relationships between people, systems, or concepts.',
    '- Durable lessons learned.',
    '',
    'Drop:',
    '- Operational and process detail.',
    '- Method details unless the method itself was the decision.',
    '- Specific references unless essential for continuation.',
    '',
    'Use plain text. Be concise.',
    'Include a brief timeline with dates (or date ranges) for major milestones.',
    'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
    `Target length: about ${targetTokens} tokens.`,
    '',
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join('\n');
}

// --- Public API ---

/**
 * Create a leaf summary (depth 0) from raw messages.
 * Extracts only plain text from messages (strips tool_use/tool_result).
 */
export async function createLeafSummary(
  messages: ParsedMessage[],
  messageIds: string[],
  minSequence: number,
  maxSequence: number,
  previousSummary?: string,
): Promise<SummaryResult | null> {
  const id = generateSummaryId();

  // Extract only text content — tool_use/tool_result blocks are stripped
  const transcript = messages
    .map(m => extractTextForSummary(m))
    .filter(text => text.length > 0)
    .join('\n\n');

  if (transcript.trim().length === 0) {
    // All messages were tool-only — nothing to summarize
    return null;
  }

  const inputTokens = Math.ceil(transcript.length / 4);
  const targetTokens = resolveTargetTokens(inputTokens, false);
  const prompt = buildLeafPrompt(transcript, targetTokens, previousSummary);

  const apiResult = await callAnthropicAPI(prompt);
  if (!apiResult) return null;

  const content = capSummaryOverage(apiResult, targetTokens);
  return { id, content, sourceMessageIds: messageIds, minSequence, maxSequence };
}

/**
 * Create a condensed summary (depth 1+) from existing summaries.
 * D1 uses previousSummary for continuity. D2+ do not (self-contained).
 */
export async function createCondensedSummary(
  summaries: Array<{ id: string; content: string; min_sequence: number | null; max_sequence: number | null; depth: number }>,
  previousSummary?: string,
): Promise<CondensedResult | null> {
  const id = generateSummaryId();
  const maxChildDepth = Math.max(...summaries.map(s => s.depth));
  const newDepth = Math.min(maxChildDepth + 1, MAX_CONDENSE_DEPTH);

  const text = summaries
    .map((s, i) => `--- Summary ${i + 1} ---\n${s.content}`)
    .join('\n\n');

  const inputTokens = Math.ceil(text.length / 4);
  const targetTokens = resolveTargetTokens(inputTokens, true);

  let prompt: string;
  if (newDepth <= 1) {
    prompt = buildD1Prompt(text, targetTokens, previousSummary);
  } else if (newDepth === 2) {
    // D2+ do not use previousSummary (self-contained, per original design)
    prompt = buildD2Prompt(text, targetTokens);
  } else {
    prompt = buildD3PlusPrompt(text, targetTokens);
  }

  const apiResult = await callAnthropicAPI(prompt);
  if (!apiResult) return null;

  const content = capSummaryOverage(apiResult, targetTokens);
  return {
    id,
    content,
    childSummaryIds: summaries.map(s => s.id),
    minSequence: Math.min(...summaries.map(s => s.min_sequence ?? Infinity)),
    maxSequence: Math.max(...summaries.map(s => s.max_sequence ?? -Infinity)),
    depth: newDepth,
  };
}
