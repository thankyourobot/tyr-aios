import type { AnyJid, ChannelJid } from './jid.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  displayName?: string; // Per-group display name in Slack (e.g., "Builder")
  displayEmoji?: string; // Per-group emoji in Slack (e.g., "hammer_and_wrench")
  displayIconUrl?: string; // Per-group portrait URL (takes precedence over displayEmoji when set)
  assistantName?: string; // Per-group assistant name for container (e.g., "Builder")
  verboseDefault?: boolean;
  thinkingDefault?: boolean;
  planModeDefault?: boolean;
  channelRole?: 'director' | 'member'; // Default: 'director'
  botUserId?: string; // Slack bot user ID (for directors with own app)
  botToken?: string; // Per-agent Slack bot token (for posting as this agent)
}

export interface FileAttachment {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface NewMessage {
  id: string;
  chat_jid: AnyJid;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  threadTs?: string; // Slack thread timestamp for thread reply support
  files?: FileAttachment[];
}

export interface SendMessageOpts {
  displayName?: string;
  displayEmoji?: string;
  displayIconUrl?: string; // Portrait URL (takes precedence over displayEmoji when set)
  threadTs?: string;
  onPosted?: (slackTs: string) => void;
  botToken?: string; // Per-agent bot token — post as this agent's Slack app instead of the default
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: ChannelJid;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: AnyJid, text: string, opts?: SendMessageOpts): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: AnyJid): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: AnyJid, isTyping: boolean, botToken?: string): Promise<void>;
  sendVerboseMessage?(
    jid: AnyJid,
    text: string,
    type: 'verbose' | 'thinking',
    opts?: SendMessageOpts,
  ): Promise<void>;
  sendBlocks?(
    jid: AnyJid,
    blocks: unknown[],
    fallbackText: string,
    opts?: SendMessageOpts,
  ): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: add emoji reaction to a message
  addReaction?(jid: AnyJid, messageTs: string, emoji: string): Promise<void>;
  // Optional: remove emoji reaction from a message
  removeReaction?(jid: AnyJid, messageTs: string, emoji: string): Promise<void>;
  // Optional: post rewind button for *rewind command
  postRewindButton?(
    jid: AnyJid,
    userId: string,
    threadTs: string,
    groupFolder: string,
    displayOpts?: {
      displayName?: string;
      displayEmoji?: string;
      displayIconUrl?: string;
      botToken?: string;
    },
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: AnyJid, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: ChannelJid,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

// --- Container I/O types ---

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: AnyJid;
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

export interface ContainerOutput {
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
  schemaVersion?: number;
}
