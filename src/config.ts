import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'ONECLI_API_KEY',
  'ONECLI_URL',
]);

/**
 * Resolve a config value from process.env > .env file > hardcoded default.
 * Returns both the resolved value and its source for startup logging.
 */
function resolve(
  key: string,
  fallback: string,
): { value: string; source: string } {
  if (process.env[key]) return { value: process.env[key]!, source: 'env' };
  if (envConfig[key]) return { value: envConfig[key], source: '.env' };
  return { value: fallback, source: 'default' };
}

const assistantName = resolve('ASSISTANT_NAME', 'Andy');
const containerImage = resolve('CONTAINER_IMAGE', 'nanoclaw-agent:latest');
const containerTimeout = resolve('CONTAINER_TIMEOUT', '300000');
const containerMaxOutput = resolve('CONTAINER_MAX_OUTPUT_SIZE', '10485760');
const idleTimeout = resolve('IDLE_TIMEOUT', '300000');
const maxConcurrent = resolve('MAX_CONCURRENT_CONTAINERS', '10');

export const ASSISTANT_NAME = assistantName.value;
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE = containerImage.value;
export const CONTAINER_TIMEOUT = parseInt(containerTimeout.value, 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(containerMaxOutput.value, 10); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);

// OneCLI Agent Vault feature flag — both must be set or NanoClaw uses the
// legacy credential-proxy.ts path. Read from envConfig (NOT process.env) so
// the secret never enters the inheritable environment of spawned child
// processes; see the docstring on readEnvFile in env.ts.
// Spec: tech-spec-aios-onecli-agent-vault.md §6.
export const ONECLI_URL = (envConfig.ONECLI_URL || '').trim();
// Strip non-alphanumeric chars defensively — terminal-pasted values can carry
// control bytes (e.g. ESC) that mangle the resulting Authorization header.
export const ONECLI_API_KEY = (envConfig.ONECLI_API_KEY || '').replace(
  /[^a-zA-Z0-9_-]/g,
  '',
);
export const ONECLI_CLIENT_TIMEOUT_MS = 5000;
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(idleTimeout.value, 10); // 5min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(maxConcurrent.value, 10) || 10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled jobs (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Log resolved config at startup so misconfiguration is immediately visible.
// ONECLI_API_KEY is reported by structural shape only (presence + length, never value)
// so the daily journalctl review can confirm the credential layer flag without
// surfacing the secret. The "credential layer" log line in index.ts says which
// branch ran; this line says whether the env vars looked plausible.
logger.info(
  {
    ASSISTANT_NAME: `${assistantName.value} (${assistantName.source})`,
    CONTAINER_IMAGE: `${containerImage.value} (${containerImage.source})`,
    CONTAINER_TIMEOUT: `${containerTimeout.value} (${containerTimeout.source})`,
    CONTAINER_MAX_OUTPUT_SIZE: `${containerMaxOutput.value} (${containerMaxOutput.source})`,
    IDLE_TIMEOUT: `${idleTimeout.value} (${idleTimeout.source})`,
    MAX_CONCURRENT_CONTAINERS: `${maxConcurrent.value} (${maxConcurrent.source})`,
    ONECLI_URL: ONECLI_URL || '(unset)',
    ONECLI_API_KEY: ONECLI_API_KEY
      ? `(set, length=${ONECLI_API_KEY.length})`
      : '(unset)',
  },
  'Config loaded',
);
