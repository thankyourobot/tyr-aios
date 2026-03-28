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
import { query, HookCallback, PreCompactHookInput } from './claude-backend.js';
import { fileURLToPath } from 'url';

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
  maxThinkingTokens?: number;
  filebrowserBaseUrl?: string;
  threadTs?: string;
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
  error?: string;
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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
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
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
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

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
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
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'memory_20250818',
        'mcp__nanoclaw__*'
      ],
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
            writeOutput({ status: 'success', result: `\u274c Tool failed: ${errorText.slice(0, 300)}`, type: 'verbose' });
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
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
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
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
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
