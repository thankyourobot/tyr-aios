/**
 * LCM Summarization Logic
 * Leaf summaries from raw messages, condensation of leaf summaries,
 * and deterministic fallback when API is unavailable.
 */

import crypto from 'crypto';
import { extractText } from './lcm-helpers.js';

// --- Configuration ---

const LCM_SUMMARY_MODEL = process.env.LCM_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const LCM_SUMMARIZE_TIMEOUT_MS = parseInt(process.env.LCM_SUMMARIZE_TIMEOUT_MS || '15000', 10);
const LCM_CONDENSE_THRESHOLD = parseInt(process.env.LCM_CONDENSE_THRESHOLD || '8', 10);
const MAX_CONDENSE_DEPTH = 3;

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

// --- Deterministic fallback ---

// --- API-based summarization ---

function hasApiCredentials(): boolean {
  // In OAuth mode, containers have CLAUDE_CODE_OAUTH_TOKEN=placeholder
  // which the credential proxy replaces with the real token.
  // In API key mode, containers have ANTHROPIC_API_KEY=placeholder.
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function callAnthropicAPI(systemPrompt: string, userContent: string): Promise<string | null> {
  if (!hasApiCredentials()) {
    console.error('[lcm-summarize] No API credentials available, skipping API call');
    return null;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  // Build auth headers based on available credentials.
  // OAuth mode: use Authorization Bearer (proxy replaces placeholder with real token).
  // API key mode: use x-api-key (proxy replaces placeholder with real key).
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  } else {
    // OAuth mode — send Bearer placeholder through the credential proxy.
    // The oauth-2025-04-20 beta header tells Anthropic to accept OAuth tokens.
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
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[lcm-summarize] API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const textParts = data.content?.filter(c => c.type === 'text').map(c => c.text);
    return textParts?.join('') || null;
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

// --- Depth-aware prompt builders ---

const EXPAND_FOOTER_INSTRUCTION = `
End your summary with a line: "Expand for details about:" followed by 3-5 key topics that were compressed. This helps readers decide when to drill deeper.`;

function buildLeafPrompt(previousContext?: string): string {
  const prev = previousContext
    ? `\n\n<previous_context>\n${previousContext}\n</previous_context>\n\nDo not repeat information already captured in the previous context above.`
    : '';

  return `You are a conversation summarizer creating a leaf-level summary of a conversation segment. Preserve:
- Key decisions and conclusions
- Important facts, names, numbers, file paths
- Action items and commitments
- Technical details that may be referenced later
- Timeline with timestamps where available

Be factual and precise. Keep under 500 words.${prev}${EXPAND_FOOTER_INSTRUCTION}`;
}

function buildCondensedPrompt(depth: number, previousContext?: string): string {
  const prev = previousContext
    ? `\n\n<previous_context>\n${previousContext}\n</previous_context>\n\nDo not repeat information already captured in the previous context above.`
    : '';

  if (depth >= 3) {
    return `You are creating a high-level memory node from phase-level summaries. Keep ONLY durable context:
- Major project milestones and outcomes
- Architectural decisions that constrain future work
- Key relationships and commitments
- Drop ALL operational detail, per-session minutiae, and transient status

Timeline with dates or date ranges only. Under 300 words.${prev}${EXPAND_FOOTER_INSTRUCTION}`;
  }

  if (depth === 2) {
    return `You are condensing session-level summaries into a higher-level memory node. Focus on:
- Overall trajectory and progression across sessions
- Decisions and their rationale
- What changed vs what stayed the same
- Drop per-session operational detail — keep only what matters across sessions

Timeline with dates and approximate times. Under 350 words.${prev}${EXPAND_FOOTER_INSTRUCTION}`;
  }

  // depth === 1
  return `You are condensing leaf-level summaries into a single memory node. Focus on:
- Key decisions made and any decisions that were later superseded
- In-progress items and their current state
- Important facts and commitments
- Technical details that may be referenced later

Timeline with timestamps to the hour. Under 400 words.${prev}${EXPAND_FOOTER_INSTRUCTION}`;
}

// --- Public API ---

/**
 * Create a leaf summary (depth 0) from raw messages.
 * Pass previousSummary to avoid redundancy with the most recent prior summary.
 */
export async function createLeafSummary(
  messages: ParsedMessage[],
  messageIds: string[],
  minSequence: number,
  maxSequence: number,
  previousSummary?: string,
): Promise<SummaryResult | null> {
  const id = generateSummaryId();

  const transcript = messages
    .map(m => `[${m.role}]: ${extractText(m)}`)
    .join('\n\n');

  const apiResult = await callAnthropicAPI(buildLeafPrompt(previousSummary), transcript);
  if (!apiResult) return null;

  return { id, content: apiResult, sourceMessageIds: messageIds, minSequence, maxSequence };
}

/**
 * Create a condensed summary (depth 1+) from existing summaries.
 * Pass previousSummary to avoid redundancy.
 */
export async function createCondensedSummary(
  summaries: Array<{ id: string; content: string; min_sequence: number | null; max_sequence: number | null; depth: number }>,
  previousSummary?: string,
): Promise<CondensedResult | null> {
  const id = generateSummaryId();
  const maxChildDepth = Math.max(...summaries.map(s => s.depth));
  const newDepth = Math.min(maxChildDepth + 1, MAX_CONDENSE_DEPTH);

  const userContent = summaries
    .map((s, i) => `--- Summary ${i + 1} ---\n${s.content}`)
    .join('\n\n');

  const apiResult = await callAnthropicAPI(buildCondensedPrompt(newDepth, previousSummary), userContent);
  if (!apiResult) return null;

  return {
    id,
    content: apiResult,
    childSummaryIds: summaries.map(s => s.id),
    minSequence: Math.min(...summaries.map(s => s.min_sequence ?? Infinity)),
    maxSequence: Math.max(...summaries.map(s => s.max_sequence ?? -Infinity)),
    depth: newDepth,
  };
}
