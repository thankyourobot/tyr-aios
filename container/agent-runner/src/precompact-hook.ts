/**
 * Standalone PreCompact hook script for Claude Code CLI.
 *
 * Called by Claude Code before context compaction.
 * Reads hook input JSON from stdin, archives the transcript to
 * /workspace/group/conversations/, and outputs a response to stdout.
 *
 * Exit codes:
 *   0 — success, compaction proceeds
 *   2 — blocking error, compaction is prevented
 */

import fs from 'fs';
import path from 'path';
import { parseTranscript as lcmParseTranscript, getConversationId, shouldSummarize } from './lcm-helpers.js';
import { initLcmDatabase, storeMessages, storeSummary, getSummariesForConversation, getMaxSequence, contentHash } from './lcm-store.js';
import { createLeafSummary, createCondensedSummary, LCM_CONDENSE_THRESHOLD } from './lcm-summarize.js';

export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  trigger: string;
  custom_instructions: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

export function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch {
    // ignore
  }

  return null;
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(now: Date = new Date()): string {
  return `conversation-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // skip malformed lines
    }
  }

  return messages;
}

export function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function archiveTranscript(input: PreCompactInput, assistantName?: string): void {
  const { transcript_path: transcriptPath, session_id: sessionId } = input;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return;
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const messages = parseTranscript(content);

  if (messages.length === 0) {
    log('No messages to archive');
    return;
  }

  const summary = getSessionSummary(sessionId, transcriptPath);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName();

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-${name}.md`;
  const filePath = path.join(conversationsDir, filename);

  const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
  fs.writeFileSync(filePath, markdown);

  log(`Archived conversation to ${filePath}`);
}

function log(message: string): void {
  console.error(`[precompact-hook] ${message}`);
}

async function main(): Promise<void> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk.toString());
  }
  const rawInput = chunks.join('');

  let input: PreCompactInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    log('Failed to parse stdin JSON');
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME;

  try {
    archiveTranscript(input, assistantName);
  } catch (err) {
    log(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(JSON.stringify({ continue: false }));
    process.exit(2);
  }

  // LCM: Persist messages and create summaries (non-fatal — archive already succeeded)
  if (process.env.LCM_ENABLED !== 'false') {
    try {
      const LCM_DB_PATH = '/home/node/.claude/lcm.db';
      const LCM_FRESHNESS_WINDOW = parseInt(process.env.LCM_FRESHNESS_WINDOW || '32', 10);

      const groupFolder = process.env.NANOCLAW_GROUP_FOLDER;
      const chatJid = process.env.NANOCLAW_CHAT_JID;
      const threadTs = process.env.NANOCLAW_THREAD_TS;
      if (!groupFolder || !chatJid) {
        log('LCM: Missing NANOCLAW_GROUP_FOLDER or NANOCLAW_CHAT_JID env vars, skipping');
      } else {
        const db = initLcmDatabase(LCM_DB_PATH);
        if (db) {
          const conversationId = getConversationId({ groupFolder, chatJid, threadTs });
          const content = fs.readFileSync(input.transcript_path, 'utf-8');
          const messages = lcmParseTranscript(content);

          if (messages.length > 0) {
            const currentMaxSeq = getMaxSequence(conversationId);
            const startSequence = currentMaxSeq + 1;
            const newlyInserted = storeMessages(conversationId, messages, startSequence);
            log(`LCM: Stored ${newlyInserted}/${messages.length} messages (dedup)`);

            if (newlyInserted > 0 && shouldSummarize(conversationId)) {
              const summaries = getSummariesForConversation(conversationId);
              const maxSummarizedSeq = summaries.length > 0
                ? Math.max(...summaries.map(s => s.max_sequence ?? -1))
                : -1;

              const toSummarize = messages.filter((_, i) => {
                const seq = startSequence + i;
                return seq > maxSummarizedSeq;
              }).slice(0, Math.max(0, messages.length - LCM_FRESHNESS_WINDOW));

              if (toSummarize.length > 0) {
                const minSeq = maxSummarizedSeq + 1;
                const maxSeq = minSeq + toSummarize.length - 1;
                const messageIds = toSummarize.map(msg => contentHash(conversationId, msg.role, msg.content));

                log(`LCM: Creating leaf summary for messages ${minSeq}-${maxSeq}`);
                const leafResult = await createLeafSummary(toSummarize, messageIds, minSeq, maxSeq);
                storeSummary({
                  id: leafResult.id,
                  conversation_id: conversationId,
                  depth: 0,
                  content: leafResult.content,
                  source_message_ids: JSON.stringify(leafResult.sourceMessageIds),
                  parent_summary_ids: null,
                  child_summary_ids: null,
                  min_sequence: leafResult.minSequence,
                  max_sequence: leafResult.maxSequence,
                  created_at: new Date().toISOString(),
                });

                // Check condensation
                const leafSummaries = getSummariesForConversation(conversationId, { depth: 0 });
                const condensedSummaries = getSummariesForConversation(conversationId).filter(s => s.depth > 0);
                const coveredLeafIds = new Set<string>();
                for (const cs of condensedSummaries) {
                  if (cs.child_summary_ids) {
                    for (const childId of JSON.parse(cs.child_summary_ids) as string[]) {
                      coveredLeafIds.add(childId);
                    }
                  }
                }
                const uncoveredLeaves = leafSummaries.filter(s => !coveredLeafIds.has(s.id));

                if (uncoveredLeaves.length >= LCM_CONDENSE_THRESHOLD) {
                  const toCondense = uncoveredLeaves.slice(0, LCM_CONDENSE_THRESHOLD);
                  log(`LCM: Condensing ${toCondense.length} leaf summaries`);
                  const condensedResult = await createCondensedSummary(toCondense);
                  storeSummary({
                    id: condensedResult.id,
                    conversation_id: conversationId,
                    depth: condensedResult.depth,
                    content: condensedResult.content,
                    source_message_ids: null,
                    parent_summary_ids: null,
                    child_summary_ids: JSON.stringify(condensedResult.childSummaryIds),
                    min_sequence: condensedResult.minSequence,
                    max_sequence: condensedResult.maxSequence,
                    created_at: new Date().toISOString(),
                  });
                }
              }
            }
          }
        }
      }
    } catch (lcmErr) {
      log(`LCM error (non-fatal): ${lcmErr instanceof Error ? lcmErr.message : String(lcmErr)}`);
    }
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

// Only run main when executed directly (not imported for tests)
const isDirectRun = process.argv[1]?.endsWith('precompact-hook.js');
if (isDirectRun) {
  main();
}
