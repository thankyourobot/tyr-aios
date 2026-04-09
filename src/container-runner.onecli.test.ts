import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// OneCLI mode tests — verifies the SDK branch in buildContainerArgs.
// Lives in a separate file so we can mock ONECLI_* env vars to non-empty
// without disturbing the legacy-path tests in container-runner.test.ts.

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Hoisted state shared between vi.mock factories and the test bodies.
// Must be vi.hoisted() because vi.mock is hoisted to the top of the file
// and would otherwise reference uninitialized variables.
const hoisted = vi.hoisted(() => {
  return {
    mockApplyContainerConfig: vi.fn(),
    mockEnsureAgent: vi.fn(),
    spawnMock: vi.fn(),
    fakeProcRef: { current: null as unknown },
  };
});

// Config mock: ONECLI vars NON-empty so buildContainerArgs takes the OneCLI branch.
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_API_KEY: 'oc_test_key',
  ONECLI_CLIENT_TIMEOUT_MS: 5000,
  ONECLI_URL: 'http://onecli.test:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Stub @onecli-sh/sdk so we can control applyContainerConfig per test.
// Note: must use a class so `new OneCLI(...)` works as a constructor.
vi.mock('@onecli-sh/sdk', () => {
  class OneCLI {
    applyContainerConfig = hoisted.mockApplyContainerConfig;
    ensureAgent = hoisted.mockEnsureAgent;
  }
  return { OneCLI };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      chownSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: hoisted.spawnMock,
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { channelJid } from './jid.js';
import type { RegisteredGroup } from './types.js';

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

const testGroup: RegisteredGroup = {
  name: 'Strategy',
  folder: 'strategy',
  trigger: '@Sherlock',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'strategy',
  chatJid: channelJid('test@g.us'),
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner OneCLI branch', () => {
  let fakeProc: ReturnType<typeof createFakeProcess>;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    hoisted.fakeProcRef.current = fakeProc;
    hoisted.spawnMock.mockReset();
    hoisted.spawnMock.mockImplementation(() => fakeProc);
    hoisted.mockApplyContainerConfig.mockReset();
    hoisted.mockEnsureAgent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls applyContainerConfig with the agent identifier matching group.folder', async () => {
    hoisted.mockApplyContainerConfig.mockImplementation(
      async (args: string[]) => {
        // Simulate the SDK pushing -e flags onto the args array
        args.push(
          '-e',
          'HTTPS_PROXY=http://x:aoc_test@host.docker.internal:10255',
        );
        args.push('-e', 'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem');
        args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-fake');
        return true;
      },
    );

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Verify the SDK was called once with the correct agent identifier
    expect(hoisted.mockApplyContainerConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.mockApplyContainerConfig).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        agent: 'strategy',
        addHostMapping: false,
        combineCaBundle: true,
      }),
    );

    // Verify spawn was called with args that include OUR fork-specific additions
    // (cap-drop, Opus model pin) AND the SDK-injected HTTPS_PROXY, AND DO NOT
    // include the legacy ANTHROPIC_BASE_URL placeholder.
    expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = hoisted.spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--cap-drop=ALL');
    expect(spawnArgs).toContain('--security-opt=no-new-privileges:true');
    expect(spawnArgs).toContain(
      'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m]',
    );
    expect(spawnArgs.some((a) => a.startsWith('HTTPS_PROXY='))).toBe(true);
    expect(
      spawnArgs.some((a) => a.startsWith('CLAUDE_CODE_OAUTH_TOKEN=sk-')),
    ).toBe(true);
    // Legacy markers MUST NOT be present in OneCLI mode
    expect(spawnArgs.some((a) => a.startsWith('ANTHROPIC_BASE_URL='))).toBe(
      false,
    );
    expect(spawnArgs).not.toContain('ANTHROPIC_API_KEY=placeholder');
    expect(spawnArgs).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  });

  it('throws when applyContainerConfig returns false (gateway unreachable)', async () => {
    hoisted.mockApplyContainerConfig.mockResolvedValue(false);

    const onOutput = vi.fn(async () => {});
    await expect(
      runContainerAgent(testGroup, testInput, () => {}, onOutput),
    ).rejects.toThrow('OneCLI gateway unreachable');

    // spawn must NOT have been called — we abort before docker run
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it('propagates SDK exceptions and does not spawn (covers fetch failed / timeout)', async () => {
    // The SDK throws OneCLIError or OneCLIRequestError on fetch failures,
    // not just returning false. buildContainerArgs has no try/catch around
    // applyContainerConfig, so the rejection should propagate intact and
    // spawn should never be reached.
    const sdkErr = new Error('OneCLIError: fetch failed');
    hoisted.mockApplyContainerConfig.mockRejectedValue(sdkErr);

    const onOutput = vi.fn(async () => {});
    await expect(
      runContainerAgent(testGroup, testInput, () => {}, onOutput),
    ).rejects.toThrow('OneCLIError: fetch failed');

    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });
});
