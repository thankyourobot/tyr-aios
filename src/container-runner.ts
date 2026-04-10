/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_API_KEY,
  ONECLI_CLIENT_TIMEOUT_MS,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { createParseState, parseStreamingChunk } from './output-parser.js';
import { ContainerInput, ContainerOutput, RegisteredGroup } from './types.js';

// Re-export ContainerInput/ContainerOutput so callers can pull them from this module
// without also importing from ./types.js. Used by 24 callers across the codebase.
export type { ContainerInput, ContainerOutput } from './types.js';

// OneCLI Agent Vault singleton. index.ts main() validates ONECLI_API_KEY/
// ONECLI_URL at startup and throws if missing, so this constructor never
// runs in production with empty values.
const onecli = new OneCLI({
  apiKey: ONECLI_API_KEY,
  url: ONECLI_URL,
  timeout: ONECLI_CLIENT_TIMEOUT_MS,
});

// Env var keys whose values must never appear in logs or on-disk container logs.
// The OneCLI SDK injects these as `-e KEY=VALUE` args — the values contain
// per-agent proxy tokens or OAuth credentials that are valid until rotated.
const REDACTED_ENV_KEYS = new Set([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

/** Redact sensitive `-e KEY=VALUE` entries from a docker args array for safe logging. */
function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, i) => {
    // `-e KEY=VALUE` can appear as a single arg or as two args (`-e`, `KEY=VALUE`).
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      if (REDACTED_ENV_KEYS.has(key)) return `${key}=[REDACTED]`;
    }
    // Also catch the two-arg form: previous arg is `-e`
    if (i > 0 && args[i - 1] === '-e') {
      const eqIdx2 = arg.indexOf('=');
      if (eqIdx2 > 0) {
        const key = arg.slice(0, eqIdx2);
        if (REDACTED_ENV_KEYS.has(key)) return `${key}=[REDACTED]`;
      }
    }
    return arg;
  });
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-write so Robot can modify NanoClaw source.
    // .env is shadowed below to protect secrets. Changes take effect on restart.

    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Global skills directory — writable so main can deploy/update skills
    // that get synced to all groups on container launch.
    // This overlays the read-only project root mount on this specific subpath.
    const containerSkillsDir = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(containerSkillsDir)) {
      mounts.push({
        hostPath: containerSkillsDir,
        containerPath: '/workspace/project/container/skills',
        readonly: false,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  // Containers run as uid 1000 (agent:docker), so each subdir must be
  // chowned after creation since the host runs as root.
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  for (const subdir of ['messages', 'commands', 'input']) {
    const dir = path.join(groupIpcDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.chownSync(dir, 1000, 1000);
    } catch {
      /* ignore chown failures (e.g., dev environment) */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  // Always sync agent-runner source to pick up deploys.
  // Per-group customization is overwritten — deploy wins.
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  group: RegisteredGroup,
  mounts: VolumeMount[],
  containerName: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Security hardening: drop all Linux capabilities and prevent privilege escalation.
  // Agent containers run as uid 1000 and never need kernel capabilities.
  args.push('--cap-drop=ALL');
  args.push('--security-opt=no-new-privileges:true');

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // 1M context is handled by the [1m] model suffix in agent-runner.
  // Do NOT set ANTHROPIC_BETAS here — it overrides Claude Code's internal
  // beta headers and breaks WebSearch.
  args.push('-e', 'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m]');

  // Runtime-specific args for host gateway resolution.
  // Must be added BEFORE applyContainerConfig so we can pass addHostMapping: false
  // and avoid the SDK adding a duplicate --add-host.
  args.push(...hostGatewayArgs());

  // SDK pushes -e/-v flags for HTTPS_PROXY, CA cert, and OAuth token onto args.
  const applied = await onecli.applyContainerConfig(args, {
    agent: group.folder,
    addHostMapping: false, // already added via hostGatewayArgs() above
    combineCaBundle: true, // covers Python/curl/Go via SSL_CERT_FILE
  });
  if (!applied) {
    logger.error(
      { group: group.name, folder: group.folder },
      'OneCLI gateway unreachable — failing container spawn',
    );
    throw new Error('OneCLI gateway unreachable');
  }
  logger.info(
    { group: group.name, folder: group.folder },
    'OneCLI gateway config applied',
  );

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);

  // Per-thread IPC input overlay: each thread gets its own input directory
  // mounted over /workspace/ipc/input/ so the agent-runner reads only its thread's input.
  const threadKey = input.threadTs || '__root__';
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const threadInputDir = path.join(groupIpcDir, 'input', threadKey);
  fs.mkdirSync(threadInputDir, { recursive: true });
  // Ensure container user (uid 1000) can read/write/unlink files in this directory.
  // The host runs as root, so mkdirSync creates root-owned dirs; chown to container user.
  try {
    fs.chownSync(threadInputDir, 1000, 1000);
  } catch {
    /* ignore on non-Linux */
  }
  mounts.push({
    hostPath: threadInputDir,
    containerPath: '/workspace/ipc/input',
    readonly: false,
  });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const threadSuffix = input.threadTs
    ? `-t${input.threadTs.replace('.', '').slice(-8)}`
    : '-root';
  const containerName = `nanoclaw-${safeName}${threadSuffix}-${Date.now()}`;
  const containerArgs = await buildContainerArgs(group, mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: redactArgs(containerArgs).join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    const parseState = createParseState();
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      const results = parseStreamingChunk(parseState, chunk, group.name);
      for (const parsed of results) {
        hadStreamingOutput = true;
        // Activity detected — reset the hard timeout
        resetTimeout();
        // Call onOutput for all markers (including null results)
        // so idle timers start even for "silent" query completions.
        outputChain = outputChain.then(() => onOutput(parsed));
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId: parseState.newSessionId,
              sessionReset: parseState.sessionReset,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        const redactedInput = {
          ...input,
          prompt: `[REDACTED: ${input.prompt.length} chars]`,
        };
        logLines.push(
          `=== Input ===`,
          JSON.stringify(redactedInput, null, 2),
          ``,
          `=== Container Args ===`,
          redactArgs(containerArgs).join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderrTail: stderr.slice(-200),
            stdoutLength: stdout.length,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Wait for output chain to settle, then return completion marker
      outputChain.then(() => {
        logger.info(
          {
            group: group.name,
            duration,
            newSessionId: parseState.newSessionId,
          },
          'Container completed (streaming mode)',
        );
        resolve({
          status: 'success',
          result: null,
          newSessionId: parseState.newSessionId,
          sessionReset: parseState.sessionReset,
        });
      });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

// Re-export snapshot functions from their new home
export {
  writeJobsSnapshot,
  writeGroupsSnapshot,
  writeRecentActivitySnapshot,
  type AvailableGroup,
} from './snapshot-writer.js';
