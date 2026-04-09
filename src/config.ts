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

// OneCLI Agent Vault — Phase 2 feature flag.
// When BOTH are set, NanoClaw routes container credentials through OneCLI
// instead of starting credential-proxy.ts. Empty string = not configured = legacy path.
// See _bmad-output/implementation-artifacts/tech-spec-aios-onecli-agent-vault.md §6.
export const ONECLI_URL = process.env.ONECLI_URL || '';
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || '';
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

// Log resolved config at startup so misconfiguration is immediately visible
logger.info(
  {
    ASSISTANT_NAME: `${assistantName.value} (${assistantName.source})`,
    CONTAINER_IMAGE: `${containerImage.value} (${containerImage.source})`,
    CONTAINER_TIMEOUT: `${containerTimeout.value} (${containerTimeout.source})`,
    CONTAINER_MAX_OUTPUT_SIZE: `${containerMaxOutput.value} (${containerMaxOutput.source})`,
    IDLE_TIMEOUT: `${idleTimeout.value} (${idleTimeout.source})`,
    MAX_CONCURRENT_CONTAINERS: `${maxConcurrent.value} (${maxConcurrent.source})`,
  },
  'Config loaded',
);
