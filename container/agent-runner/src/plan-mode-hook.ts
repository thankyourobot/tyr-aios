/**
 * PreToolUse hook — intercepts ExitPlanMode and AskUserQuestion.
 *
 * These native tools fail in headless CLI mode (permission-denied).
 * This hook captures the data, writes it to IPC for the host to route
 * to Slack, writes _close sentinel to deterministically stop the CLI,
 * and returns deny.
 *
 * The user responds in Slack, and a new container resumes the session
 * with the user's response as a follow-up message.
 */

import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');

const chatJid = process.env.NANOCLAW_CHAT_JID || '';
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER || '';
const replyThreadTs = process.env.NANOCLAW_REPLY_THREAD_TS || '';

interface HookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  session_id?: string;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function readPlanFile(): string {
  // Claude Code writes the plan to .claude/plans/<name>.md
  const plansDir = '/home/node/.claude/plans';
  try {
    if (!fs.existsSync(plansDir)) return '';
    const files = fs.readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(plansDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return '';
    return fs.readFileSync(path.join(plansDir, files[0].name), 'utf-8');
  } catch {
    return '';
  }
}

function denyAndStop(reason: string): void {
  // No _close sentinel — let the container idle so plan mode state is preserved.
  // The agent-runner will poll for IPC input when the user responds.
  // Container timeout (15 min) is the safety net if the user never answers.

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

async function main() {
  // Read hook input from stdin
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    // Not valid JSON — pass through (exit 0 with no output)
    process.exit(0);
  }

  if (input.tool_name === 'ExitPlanMode') {
    const plan = readPlanFile();

    writeIpcFile(MESSAGES_DIR, {
      type: 'plan_ready',
      plan: plan || '(No plan file found — the agent may have described the plan in conversation instead.)',
      chatJid,
      groupFolder,
      threadTs: replyThreadTs || undefined,
      timestamp: new Date().toISOString(),
    });

    denyAndStop(
      'Your plan has been submitted for user approval via Slack. Your session will be resumed when the user responds.',
    );
  }

  if (input.tool_name === 'AskUserQuestion') {
    const questions = input.tool_input.questions || [];

    writeIpcFile(MESSAGES_DIR, {
      type: 'ask_user',
      questions,
      chatJid,
      groupFolder,
      threadTs: replyThreadTs || undefined,
      timestamp: new Date().toISOString(),
    });

    denyAndStop(
      'Your questions have been forwarded to the user via Slack. Your session will be resumed when the user responds.',
    );
  }

  // Not a matched tool — pass through
  process.exit(0);
}

main();
