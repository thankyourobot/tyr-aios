/**
 * LCM sub-agent: in-process Haiku tool-use loop for DAG expansion.
 * Replaces the single-shot lcm_expand approach with iterative exploration.
 */

import {
  searchMessages,
  searchSummaries,
  getSummaryById,
  getMessagesForSummary,
  getChildSummaries,
  getSubtreeManifest,
  type LcmSummary,
} from './lcm-store.js';
import { extractText, type ParsedMessage } from './lcm-helpers.js';
import { expansionAuth } from './lcm-expansion-auth.js';

const LCM_SUBAGENT_MODEL = process.env.LCM_SUBAGENT_MODEL || process.env.LCM_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const LCM_SUBAGENT_TIMEOUT_MS = parseInt(process.env.LCM_SUBAGENT_TIMEOUT_MS || '30000', 10);
const LCM_SUBAGENT_MAX_ITERATIONS = parseInt(process.env.LCM_SUBAGENT_MAX_ITERATIONS || '5', 10);
const LCM_SUBAGENT_TOKEN_CAP = parseInt(process.env.LCM_SUBAGENT_TOKEN_CAP || '50000', 10);

// --- Internal tool schemas for Haiku ---

const TOOLS = [
  {
    name: 'lcm_grep',
    description: 'Search conversation history by keyword. Returns matching messages and summaries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search query' },
        scope: { type: 'string' as const, enum: ['messages', 'summaries', 'both'], description: 'Search scope' },
        limit: { type: 'number' as const, description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lcm_describe',
    description: 'Inspect a summary node — metadata, relationships, subtree manifest.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const, description: 'Summary ID (starts with sum_)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lcm_read_source',
    description: 'Read the raw source content for a summary. For leaves: original messages. For condensed: child summaries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const, description: 'Summary ID to read source of' },
      },
      required: ['id'],
    },
  },
];

// --- Internal tool execution ---

function executeGrepTool(args: { query: string; scope?: string; limit?: number }): string {
  const results: string[] = [];
  const scope = args.scope || 'both';
  const limit = args.limit || 10;

  if (scope === 'messages' || scope === 'both') {
    const msgs = searchMessages(args.query, limit);
    for (const m of msgs) {
      results.push(`[message] role=${m.role} seq=${m.sequence}\n${m.content.slice(0, 300)}`);
    }
  }
  if (scope === 'summaries' || scope === 'both') {
    const sums = searchSummaries(args.query, limit);
    for (const s of sums) {
      results.push(`[summary] id=${s.id} depth=${s.depth} seq=${s.min_sequence}-${s.max_sequence}\n${s.content.slice(0, 300)}`);
    }
  }

  return results.length > 0 ? results.join('\n\n---\n\n') : `No results for "${args.query}"`;
}

function executeDescribeTool(args: { id: string }): string {
  const summary = getSummaryById(args.id);
  if (!summary) return `Summary "${args.id}" not found.`;

  const sourceCount = getMessagesForSummary(args.id).length;
  const childCount = getChildSummaries(args.id).length;

  const lines = [
    `ID: ${summary.id}`,
    `Kind: ${summary.kind ?? (summary.depth === 0 ? 'leaf' : 'condensed')}`,
    `Depth: ${summary.depth}`,
    `Tokens: ~${summary.token_estimate}`,
    `Sequence range: ${summary.min_sequence}-${summary.max_sequence}`,
    `Source messages: ${sourceCount}`,
    `Child summaries: ${childCount}`,
  ];

  if (summary.descendant_count) {
    lines.push(`Descendants: ${summary.descendant_count} (~${summary.descendant_token_count} tokens)`);
  }

  // Subtree manifest
  const manifest = getSubtreeManifest(args.id);
  if (manifest && manifest.children.length > 0) {
    lines.push('', 'Subtree:');
    const formatNode = (node: typeof manifest, indent: number): void => {
      const prefix = '  '.repeat(indent);
      lines.push(`${prefix}[${node.id}] depth=${node.depth} tokens=${node.token_estimate}`);
      for (const child of node.children) {
        formatNode(child, indent + 1);
      }
    };
    for (const child of manifest.children) {
      formatNode(child, 1);
    }
  }

  lines.push('', `Content preview:\n${summary.content.slice(0, 500)}`);
  return lines.join('\n');
}

function executeReadSourceTool(args: { id: string }): string {
  const summary = getSummaryById(args.id);
  if (!summary) return `Summary "${args.id}" not found.`;

  if (summary.depth === 0) {
    // Leaf — read source messages via junction table
    const msgs = getMessagesForSummary(summary.id);
    if (msgs.length === 0) return 'No source messages found.';
    return msgs
      .map(m => `[${m.role}]: ${extractText({ role: m.role as 'user' | 'assistant', content: m.content })}`)
      .join('\n\n');
  } else {
    // Condensed — read child summaries
    const children = getChildSummaries(summary.id);
    if (children.length === 0) return 'No child summaries found.';
    return children
      .map(c => `--- Summary ${c.id} (depth ${c.depth}, seq ${c.min_sequence}-${c.max_sequence}) ---\n${c.content}`)
      .join('\n\n');
  }
}

/** @internal — exported for testing */
export function _executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'lcm_grep': return executeGrepTool(input as { query: string; scope?: string; limit?: number });
    case 'lcm_describe': return executeDescribeTool(input as { id: string });
    case 'lcm_read_source': return executeReadSourceTool(input as { id: string });
    default: return `Unknown tool: ${name}`;
  }
}

// --- API call ---

function getApiHeaders(): Record<string, string> {
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
  return headers;
}

function hasApiCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
}

// --- Sub-agent runner ---

export interface SubAgentResult {
  answer: string;
  citedIds: string[];
  iterations: number;
}

/**
 * Run an in-process Haiku sub-agent that iteratively explores the LCM DAG.
 * Used by lcm_expand and lcm_expand_query MCP tools.
 */
export async function runLcmSubAgent(opts: {
  query: string;
  seedSummaryIds?: string[];
  grantId?: string;
}): Promise<SubAgentResult | null> {
  if (!hasApiCredentials()) return null;

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  // Build seed context from summary IDs
  let seedContext = '';
  const citedIds = new Set<string>();
  if (opts.seedSummaryIds) {
    for (const id of opts.seedSummaryIds) {
      const summary = getSummaryById(id);
      if (summary) {
        seedContext += `\n\nSeed summary ${id} (depth ${summary.depth}):\n${summary.content}`;
        citedIds.add(id);
      }
    }
  }

  const systemPrompt = [
    'You are an LCM retrieval navigator. Your job is to answer a specific question by exploring conversation history.',
    'You have tools to search, inspect, and read from the conversation history DAG.',
    '',
    'Strategy:',
    '1. If seed summaries are provided, start by reading their source content.',
    '2. Use lcm_grep to find additional relevant summaries.',
    '3. Use lcm_describe to understand summary structure and costs.',
    '4. Use lcm_read_source to get detailed content from promising summaries.',
    '5. Synthesize your answer from retrieved evidence. Be precise and cite summary IDs.',
    '',
    'Keep your final answer concise and focused. Cite summary IDs used.',
  ].join('\n');

  const userMessage = seedContext
    ? `${opts.query}\n\nSeed context:${seedContext}`
    : opts.query;

  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;

  while (iterations < LCM_SUBAGENT_MAX_ITERATIONS) {
    iterations++;

    // Check grant budget if present
    if (opts.grantId) {
      const validation = expansionAuth.validateExpansion(opts.grantId);
      if (!validation.allowed) break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LCM_SUBAGENT_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          model: LCM_SUBAGENT_MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools: TOOLS,
          messages,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`[lcm-subagent] API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as {
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        stop_reason: string;
        usage?: { input_tokens?: number };
      };

      // Track token consumption
      if (opts.grantId && data.usage?.input_tokens) {
        expansionAuth.consumeTokenBudget(opts.grantId, data.usage.input_tokens);
      }

      // Check if response contains tool_use blocks
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const textBlocks = data.content.filter(b => b.type === 'text');

      if (toolUseBlocks.length === 0) {
        // Final text response
        const answer = textBlocks.map(b => b.text ?? '').join('');
        return { answer, citedIds: [...citedIds], iterations };
      }

      // Execute tools and build results
      messages.push({ role: 'assistant', content: data.content });

      const toolResults = toolUseBlocks.map(block => {
        const result = _executeTool(block.name!, block.input ?? {});

        // Track cited summary IDs from describe/read_source
        if ((block.name === 'lcm_describe' || block.name === 'lcm_read_source') && block.input?.id) {
          citedIds.add(block.input.id as string);
        }

        return {
          type: 'tool_result' as const,
          tool_use_id: block.id!,
          content: result.slice(0, 50000), // Cap individual tool results
        };
      });

      messages.push({ role: 'user', content: toolResults });
    } catch (err) {
      clearTimeout(timeout);
      console.error(`[lcm-subagent] Error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Max iterations reached — extract whatever text we have
  return {
    answer: '[Sub-agent reached iteration limit without a final answer]',
    citedIds: [...citedIds],
    iterations,
  };
}
