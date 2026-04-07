/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, HookCallback, PreCompactHookInput } from './claude-backend.js';
import { fileURLToPath } from 'url';
import {
  getConversationId,
  shouldProactivelyCompact,
  shouldSummarize,
  parseTranscript,
  assembleLcmContext,
  setDetectedContextWindow,
  decomposeMessage,
  LCM_LEAF_CHUNK_TOKENS,
} from './lcm-helpers.js';
import {
  initLcmDatabase,
  storeMessages,
  storeSummary,
  getSummariesForConversation,
  getMaxSequence,
  contentHash,
  appendContextItems,
  replaceContextItemsWithSummary,
  replaceContextSummariesWithCondensed,
  storeMessageParts,
  getBootstrapState,
  upsertBootstrapState,
  storeLargeFile,
} from './lcm-store.js';
import {
  createLeafSummary,
  createCondensedSummary,
  LCM_CONDENSE_THRESHOLD,
} from './lcm-summarize.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  verbose?: boolean;
  thinking?: boolean;
  planMode?: boolean;
  maxThinkingTokens?: number;
  filebrowserBaseUrl?: string;
  threadTs?: string;
  replyThreadTs?: string;
  forkFromSession?: boolean;
  resumeSessionAt?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  type?: 'result' | 'verbose' | 'thinking';
  newSessionId?: string;
  lastAssistantUuid?: string;
  contextUsage?: {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    contextWindow: number;
  };
  model?: string;
  compaction?: {
    preTokens: number;
    trigger: 'manual' | 'auto';
  };
  sessionReset?: boolean;
  error?: string;
  schemaVersion?: number;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

const STDIN_TIMEOUT_MS = 60_000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      reject(new Error(`stdin read timed out after ${STDIN_TIMEOUT_MS}ms`));
    }, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify({ ...output, schemaVersion: 1 }));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
        try { fs.unlinkSync(filePath); } catch { /* ignore permission errors — host wrote as root */ }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */

/**
 * Format a tool use summary for verbose output.
 */
function formatToolUseSummary(
  toolName: string,
  input: Record<string, unknown>,
  filebrowserBaseUrl?: string,
  groupFolder?: string,
): string {
  let summary: string;
  const filePath = (input.file_path || input.path || '') as string;

  switch (toolName) {
    case 'Read':
      summary = `\ud83d\udd27 Read: ${filePath}`;
      break;
    case 'Write':
      summary = `\ud83d\udd27 Write: ${filePath}`;
      break;
    case 'Edit':
      summary = `\ud83d\udd27 Edit: ${filePath}`;
      break;
    case 'Bash':
      summary = `\ud83d\udd27 Bash: ${String(input.command || '').slice(0, 200)}`;
      break;
    case 'Grep':
      summary = `\ud83d\udd27 Grep: ${input.pattern || ''}`;
      break;
    case 'Glob':
      summary = `\ud83d\udd27 Glob: ${input.pattern || ''}`;
      break;
    default:
      summary = `\ud83d\udd27 ${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }

  // Add FileBrowser link if available
  if (filebrowserBaseUrl && filePath) {
    let fbPath: string | null = null;
    if (groupFolder && filePath.startsWith(`/workspace/group/`)) {
      fbPath = `agent-workspaces/${groupFolder}/${filePath.replace(`/workspace/group/`, ``)}`;
    } else if (filePath.startsWith(`/workspace/project/container/skills/`)) {
      fbPath = `global-skills/${filePath.replace(`/workspace/project/container/skills/`, ``)}`;
    } else if (filePath.startsWith(`/home/node/.claude/skills/`)) {
      fbPath = `global-skills/${filePath.replace(`/home/node/.claude/skills/`, ``)}`;
    }
    if (fbPath) {
      summary += ` — <${filebrowserBaseUrl}/files/${fbPath}|view>`;
    }
  }
  return summary;
}

// --- LCM ---

const LCM_DB_PATH = '/home/node/.claude/lcm.db';
const LCM_FRESHNESS_WINDOW = parseInt(process.env.LCM_FRESHNESS_WINDOW || '32', 10);

const LCM_TRANSCRIPT_DIR = '/home/node/.claude/projects/-workspace-group';

/**
 * Get the transcript JSONL path for a specific session ID.
 * The Claude CLI names transcripts as {sessionId}.jsonl.
 */
function getTranscriptPath(sessionId: string): string | null {
  const filePath = path.join(LCM_TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  if (fs.existsSync(filePath)) return filePath;
  return null;
}

/**
 * Persist messages to LCM and create summaries if token threshold crossed.
 * Called after every query (always-persist) and from PreCompact hook (belt & suspenders).
 * All errors are non-fatal.
 */
async function persistToLcm(conversationId: string, sessionId: string | undefined, assistantName?: string): Promise<void> {
  log(`persistToLcm called (conversationId=${conversationId}, sessionId=${sessionId || 'none'}, LCM_ENABLED=${process.env.LCM_ENABLED ?? 'unset'})`);
  if (process.env.LCM_ENABLED === 'false') return;
  if (!sessionId) { log('No session ID, skipping'); return; }

  try {
    const db = initLcmDatabase(LCM_DB_PATH);
    if (!db) { log('initLcmDatabase returned null'); return; }

    const transcriptPath = getTranscriptPath(sessionId);
    if (!transcriptPath) {
      log(`No transcript found for session ${sessionId}`);
      return;
    }
    log(`Found transcript: ${transcriptPath}`);

    // Bootstrap tracking: skip re-reading unchanged files
    const fileStat = fs.statSync(transcriptPath);
    const bootstrapState = getBootstrapState(conversationId);
    if (bootstrapState
      && bootstrapState.session_file_path === transcriptPath
      && bootstrapState.last_seen_size === fileStat.size
      && bootstrapState.last_seen_mtime_ms === Math.floor(fileStat.mtimeMs)) {
      log('Bootstrap: transcript unchanged since last persist, skipping');
      return;
    }

    // Read transcript (full read for now; incremental append-only optimization is future work)
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    log(`Parsed ${messages.length} messages from transcript (${content.length} bytes)`);
    if (messages.length === 0) return;

    // Large file interception: externalize content blocks > 100K chars before storing
    const LCM_FILES_DIR = '/home/node/.claude/lcm-files';
    for (const msg of messages) {
      if (msg.content.length <= 100000) continue;
      try {
        const blocks = JSON.parse(msg.content);
        if (!Array.isArray(blocks)) continue;
        let modified = false;
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          let blockContent: string | null = null;
          if (block.type === 'tool_result') {
            blockContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            blockContent = block.text;
          } else if (block.type === 'tool_use' && block.input) {
            const inputStr = JSON.stringify(block.input);
            if (inputStr.length > 100000) blockContent = inputStr;
          }
          if (blockContent && blockContent.length > 100000) {
            const fileId = `file_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
            fs.mkdirSync(LCM_FILES_DIR, { recursive: true });
            const storagePath = path.join(LCM_FILES_DIR, fileId);
            fs.writeFileSync(storagePath, blockContent);
            storeLargeFile({
              file_id: fileId,
              conversation_id: conversationId,
              file_name: null,
              mime_type: null,
              byte_size: blockContent.length,
              storage_uri: storagePath,
              exploration_summary: null,
              created_at: new Date().toISOString(),
            });
            blocks[i] = { ...block, content: `[large content externalized: file_id=${fileId}, ${blockContent.length} bytes]` };
            modified = true;
          }
        }
        if (modified) {
          msg.content = JSON.stringify(blocks);
        }
      } catch { /* not JSON, skip */ }
    }

    const currentMaxSeq = getMaxSequence(conversationId);
    const startSequence = currentMaxSeq + 1;
    const newlyInserted = storeMessages(conversationId, messages, startSequence);
    log(`Stored ${newlyInserted}/${messages.length} messages (dedup)`);

    // Store message parts for newly inserted messages
    if (newlyInserted > 0) {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgId = contentHash(conversationId, msg.role, msg.content);
        const parts = decomposeMessage(msgId, msg.content);
        if (parts.length > 0) storeMessageParts(parts);
      }

      // Append context items for new messages
      const newItems = messages.map((msg, i) => ({
        item_type: 'message' as const,
        message_id: contentHash(conversationId, msg.role, msg.content),
      }));
      appendContextItems(conversationId, newItems);
    }

    if (newlyInserted === 0) {
      // Still update bootstrap state even if all messages were deduped
      upsertBootstrapState({
        conversation_id: conversationId,
        session_file_path: transcriptPath,
        last_seen_size: fileStat.size,
        last_seen_mtime_ms: Math.floor(fileStat.mtimeMs),
        last_processed_offset: fileStat.size,
        last_processed_entry_hash: null,
        updated_at: new Date().toISOString(),
      });
      return;
    }

    // Check if we should create a leaf summary (token-based threshold)
    if (!shouldSummarize(conversationId)) return;

    // Find unsummarized messages to summarize
    const allSummaries = getSummariesForConversation(conversationId);
    const maxSummarizedSeq = allSummaries.length > 0
      ? Math.max(...allSummaries.map(s => s.max_sequence ?? -1))
      : -1;

    // Get the most recent summary content for previous-context continuity
    const sortedSummaries = [...allSummaries].sort((a, b) => (b.max_sequence ?? 0) - (a.max_sequence ?? 0));
    const previousSummary = sortedSummaries[0]?.content;

    // Get unsummarized messages, leaving freshness window intact
    const allUnsummarized = messages.filter((_, i) => {
      const seq = startSequence + i;
      return seq > maxSummarizedSeq;
    });
    const toSummarize = allUnsummarized.slice(0, Math.max(0, allUnsummarized.length - LCM_FRESHNESS_WINDOW));

    if (toSummarize.length === 0) return;

    // Incremental chunked compaction: create one leaf per ~LCM_LEAF_CHUNK_TOKENS chunk
    const MIN_CHUNK_MESSAGES = 10;
    let chunkStart = 0;
    let lastPrevSummary = previousSummary;

    while (chunkStart < toSummarize.length) {
      // Build a chunk: accumulate until token threshold AND minimum message count
      let chunkEnd = chunkStart;
      let chunkTokens = 0;
      while (chunkEnd < toSummarize.length) {
        chunkTokens += Math.ceil(toSummarize[chunkEnd].content.length / 4);
        chunkEnd++;
        // Stop when we've hit the token threshold AND have enough messages
        if (chunkTokens >= LCM_LEAF_CHUNK_TOKENS && (chunkEnd - chunkStart) >= MIN_CHUNK_MESSAGES) break;
      }

      const chunk = toSummarize.slice(chunkStart, chunkEnd);
      const minSeq = maxSummarizedSeq + 1 + chunkStart;
      const maxSeq = minSeq + chunk.length - 1;
      const messageIds = chunk.map(msg => contentHash(conversationId, msg.role, msg.content));

      log(`LCM: Creating leaf summary for messages ${minSeq}-${maxSeq} (${chunk.length} msgs, ~${chunkTokens} tokens)`);
      const leafResult = await createLeafSummary(chunk, messageIds, minSeq, maxSeq, lastPrevSummary);
      if (!leafResult) {
        log('LCM: Summarization API unavailable — skipping remaining chunks, will retry next persist');
        break;
      }
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

      // Replace message context items with summary item
      replaceContextItemsWithSummary(conversationId, messageIds, leafResult.id);

      // Use this summary as previous context for the next chunk
      lastPrevSummary = leafResult.content;
      chunkStart = chunkEnd;
    }

    // Check condensation threshold
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
      const latestCondensed = condensedSummaries.sort((a, b) => (b.max_sequence ?? 0) - (a.max_sequence ?? 0))[0];
      log(`LCM: Condensing ${toCondense.length} leaf summaries`);
      const condensedResult = await createCondensedSummary(toCondense, latestCondensed?.content);
      if (!condensedResult) {
        log('LCM: Condensation API unavailable — skipping, will retry next persist');
        return;
      }
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

      // Replace child summary context items with condensed summary item
      replaceContextSummariesWithCondensed(
        conversationId,
        condensedResult.childSummaryIds,
        condensedResult.id,
      );
    }

    // Update bootstrap state last — after all operations succeeded
    upsertBootstrapState({
      conversation_id: conversationId,
      session_file_path: transcriptPath,
      last_seen_size: fileStat.size,
      last_seen_mtime_ms: Math.floor(fileStat.mtimeMs),
      last_processed_offset: fileStat.size,
      last_processed_entry_hash: null,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    log(`persist error (non-fatal): ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  conversationId: string,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; lastInputTokens?: number }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Append plan mode instructions to system prompt
  if (containerInput.planMode) {
    const planInstructions = [
      '',
      'IMPORTANT: You are in plan mode. Call the EnterPlanMode tool immediately before doing anything else.',
      'Explore the codebase, design your approach. Use AskUserQuestion if you need to clarify requirements.',
      'When your plan is complete, call ExitPlanMode to present it for user approval.',
      'Do NOT execute the plan — wait for user approval.',
    ].join('\n');
    globalClaudeMd = (globalClaudeMd || '') + planInstructions;
  }

  // LCM: Inject summary context only when starting a fresh session (post-compaction).
  // Resuming an existing session already has its context; injecting again would duplicate.
  let lcmContext: string | null = null;
  if (!sessionId && !containerInput.planMode && process.env.LCM_ENABLED !== 'false') {
    try {
      const convId = getConversationId(containerInput);
      lcmContext = assembleLcmContext(convId, LCM_DB_PATH, containerInput.prompt);
      if (lcmContext) log(`LCM: Assembled summary context (${lcmContext.length} chars)`);
    } catch (err) {
      log(`LCM context assembly error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Combine system prompt parts
  const systemPromptAppend = [globalClaudeMd, lcmContext].filter(Boolean).join('\n\n') || undefined;

  // Track context usage from assistant messages
  let lastContextUsage: ContainerOutput['contextUsage'] | undefined;
  let lastCompaction: ContainerOutput['compaction'] | undefined;

  // Track seen tool_use IDs to deduplicate (includePartialMessages yields intermediate snapshots)
  const seenToolUseIds = new Set<string>();
  let thinkingBuffer = '';
  let thinkingBlockIndex: number | null = null;

  for await (const message of query({
    prompt: stream,
    options: {
      ...(containerInput.thinking ? { maxThinkingTokens: containerInput.maxThinkingTokens || 10000 } : {}),
      ...(containerInput.thinking ? { includePartialMessages: true } : {}),
      cwd: '/workspace/group',
      model: 'claude-opus-4-6[1m]',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: containerInput.resumeSessionAt || resumeAt,
      ...(containerInput.forkFromSession ? { forkSession: true } : {}),
      systemPrompt: systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
        'memory_20250818',
        'mcp__nanoclaw__*'
      ],
      planMode: containerInput.planMode,
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            ...(containerInput.replyThreadTs ? { NANOCLAW_REPLY_THREAD_TS: containerInput.replyThreadTs } : {}),
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Capture context usage from non-sidechain assistant messages
      const msgObj = message as { message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }; parent_tool_use_id?: string | null };
      if (!msgObj.parent_tool_use_id && msgObj.message?.usage) {
        const u = msgObj.message.usage;
        lastContextUsage = {
          inputTokens: u.input_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          contextWindow: 0,
        };
      }
    }

    // Verbose mode: emit tool_use summaries
    if (message.type === 'assistant' && containerInput.verbose) {
      const assistantContent = (message as { message?: { content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content;
      if (Array.isArray(assistantContent)) {
        for (const block of assistantContent) {
          if (block.type === 'tool_use' && block.id && !seenToolUseIds.has(block.id)) {
            seenToolUseIds.add(block.id);
            const summary = formatToolUseSummary(
              block.name || 'unknown',
              (block.input || {}) as Record<string, unknown>,
              containerInput.filebrowserBaseUrl,
              containerInput.groupFolder,
            );
            writeOutput({ status: 'success', result: summary, type: 'verbose' });
          }
        }
      }
    }

    // Tool failure capture: detect error results in UserMessage
    if (message.type === 'user' && containerInput.verbose) {
      const userContent = (message as { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> } }).message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'tool_result' && block.is_error) {
            const errorText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            // Rewrite hook deny messages to be informational instead of alarming
            if (errorText.includes('forwarded to the user via Slack') || errorText.includes('submitted for user approval via Slack')) {
              writeOutput({ status: 'success', result: `\u2709\uFE0F ${errorText.slice(0, 300)}`, type: 'verbose' });
            } else {
              writeOutput({ status: 'success', result: `\u274c Tool failed: ${errorText.slice(0, 300)}`, type: 'verbose' });
            }
          }
        }
      }
    }

    // Thinking mode: capture from raw stream events
    if ((message as { type: string }).type === 'stream_event' && containerInput.thinking) {
      const streamEvent = (message as { event: { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; thinking?: string } } }).event;
      if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'thinking') {
        thinkingBuffer = '';
        thinkingBlockIndex = streamEvent.index ?? null;
      }
      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'thinking_delta') {
        thinkingBuffer += streamEvent.delta.thinking || '';
      }
      if (streamEvent.type === 'content_block_stop' && streamEvent.index === thinkingBlockIndex && thinkingBuffer.length > 0) {
        writeOutput({ status: 'success', result: thinkingBuffer, type: 'thinking' });
        thinkingBuffer = '';
        thinkingBlockIndex = null;
      }
    }

    // Detect compaction events
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const compactMsg = message as { compact_metadata?: { pre_tokens?: number; trigger?: string } };
      if (compactMsg.compact_metadata) {
        lastCompaction = {
          preTokens: compactMsg.compact_metadata.pre_tokens || 0,
          trigger: (compactMsg.compact_metadata.trigger as 'manual' | 'auto') || 'auto',
        };
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      // Extract contextWindow from modelUsage
      const modelUsage = (message as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage;
      if (modelUsage && lastContextUsage) {
        const firstModel = Object.values(modelUsage)[0];
        if (firstModel?.contextWindow) {
          lastContextUsage.contextWindow = firstModel.contextWindow;
          setDetectedContextWindow(firstModel.contextWindow);
        }
      }
      const modelName = modelUsage ? Object.keys(modelUsage)[0] : undefined;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        lastAssistantUuid,
        model: modelName,
        contextUsage: lastContextUsage,
        compaction: lastCompaction,
      });
      // Reset compaction after emitting (one-shot)
      lastCompaction = undefined;

      // LCM: Persist messages immediately after each result
      await persistToLcm(conversationId, newSessionId, containerInput.assistantName);

      // LCM: Check for compact signal or proactive compaction threshold
      const lcmCompactSignal = path.join(IPC_INPUT_DIR, '_lcm_compact');
      const onDemandCompact = fs.existsSync(lcmCompactSignal);
      if (onDemandCompact) {
        try { fs.unlinkSync(lcmCompactSignal); } catch { /* ignore */ }
      }
      if (onDemandCompact || shouldProactivelyCompact(lastContextUsage?.inputTokens)) {
        log(`LCM: ${onDemandCompact ? 'On-demand' : 'Proactive'} compaction — resetting session, exiting container`);
        writeOutput({ status: 'success', result: null, sessionReset: true });
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
      }
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, lastInputTokens: lastContextUsage?.inputTokens };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  // Pass assistant name to standalone precompact hook via env var
  if (containerInput.assistantName) {
    sdkEnv.NANOCLAW_ASSISTANT_NAME = containerInput.assistantName;
  }

  // Pass context to hooks (plan-mode-hook.ts, precompact-hook.ts)
  sdkEnv.NANOCLAW_CHAT_JID = containerInput.chatJid;
  sdkEnv.NANOCLAW_GROUP_FOLDER = containerInput.groupFolder;
  if (containerInput.replyThreadTs) {
    sdkEnv.NANOCLAW_REPLY_THREAD_TS = containerInput.replyThreadTs;
  }
  if (containerInput.threadTs) sdkEnv.NANOCLAW_THREAD_TS = containerInput.threadTs;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // LCM: Check for compact signal at startup (written by *compact before this container launched)
  const lcmCompactAtStartup = path.join(IPC_INPUT_DIR, '_lcm_compact');
  if (fs.existsSync(lcmCompactAtStartup)) {
    try { fs.unlinkSync(lcmCompactAtStartup); } catch { /* ignore */ }
    log('LCM: Compact signal found at startup — clearing session for fresh start');
    writeOutput({ status: 'success', result: null, sessionReset: true });
    sessionId = undefined;
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.planMode) {
    prompt += `\n\n[PLAN MODE — You MUST call the EnterPlanMode tool as your very first action. Do NOT respond to the user yet. Call EnterPlanMode first, then explore the codebase and design your approach. Use AskUserQuestion if you need to clarify requirements. When your plan is complete, call ExitPlanMode to present it for approval. Do NOT execute — wait for user approval.]`;
  }
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  const conversationId = getConversationId(containerInput);

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, conversationId, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query (or LCM compaction triggered), exit.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
