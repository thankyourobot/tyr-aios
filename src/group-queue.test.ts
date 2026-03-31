import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      null,
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing — pass groupFolder consistently to all queue calls
    queue.enqueueMessageCheck('group1@g.us', null, 'test-group');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      null,
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us', null, 'test-group');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn, 'test-group');

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      null,
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', null, 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      null,
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', null, 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // ========================================================
  // Parallel thread support
  // ========================================================

  describe('parallel thread support', () => {
    it('two threads enqueued simultaneously both run (activeCount is 2)', async () => {
      let activeCount = 0;
      let maxActive = 0;
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async (groupJid: string) => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        activeCount--;
        return true;
      });

      queue.setProcessMessagesFn(processMessages);

      // Enqueue two different threads in the same channel
      queue.enqueueMessageCheck('group1@g.us', 'thread-1');
      queue.enqueueMessageCheck('group1@g.us', 'thread-2');

      await vi.advanceTimersByTimeAsync(10);

      // Both should be running in parallel (2 slots, 2 threads)
      expect(maxActive).toBe(2);
      expect(activeCount).toBe(2);
      expect(processMessages).toHaveBeenCalledTimes(2);

      // Clean up
      completionCallbacks.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(10);
    });

    it('same-thread duplicate queues instead of starting new container', async () => {
      let activeCount = 0;
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async (groupJid: string) => {
        activeCount++;
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        activeCount--;
        return true;
      });

      queue.setProcessMessagesFn(processMessages);

      // Enqueue first message for thread-1
      queue.enqueueMessageCheck('group1@g.us', 'thread-1');
      await vi.advanceTimersByTimeAsync(10);

      expect(activeCount).toBe(1);
      expect(processMessages).toHaveBeenCalledTimes(1);

      // Enqueue second message for same thread — should queue, not start new container
      queue.enqueueMessageCheck('group1@g.us', 'thread-1');
      await vi.advanceTimersByTimeAsync(10);

      // Still only 1 active — second was queued as pending
      expect(activeCount).toBe(1);
      expect(processMessages).toHaveBeenCalledTimes(1);

      // Complete first — queued message should drain
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(2);

      // Complete the drain run
      completionCallbacks[1]();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('wouldQueue returns correct values per thread state', async () => {
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      queue.setProcessMessagesFn(processMessages);

      // Nothing active yet — should not queue
      expect(queue.wouldQueue('group1@g.us', 'thread-1')).toBe(false);
      expect(queue.wouldQueue('group1@g.us', 'thread-2')).toBe(false);

      // Start thread-1
      queue.enqueueMessageCheck('group1@g.us', 'thread-1');
      await vi.advanceTimersByTimeAsync(10);

      // thread-1 active → would queue; thread-2 not active but 1 slot used → still room
      expect(queue.wouldQueue('group1@g.us', 'thread-1')).toBe(true);
      expect(queue.wouldQueue('group1@g.us', 'thread-2')).toBe(false);

      // Fill second slot with thread-2
      queue.enqueueMessageCheck('group1@g.us', 'thread-2');
      await vi.advanceTimersByTimeAsync(10);

      // Both active, at concurrency limit — any new thread would queue
      expect(queue.wouldQueue('group1@g.us', 'thread-1')).toBe(true);
      expect(queue.wouldQueue('group1@g.us', 'thread-2')).toBe(true);
      expect(queue.wouldQueue('group1@g.us', 'thread-3')).toBe(true);

      // Clean up
      completionCallbacks.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(10);
    });

    it('queueKey composite key format: chatJid::threadTs or chatJid::__root__', async () => {
      const processedKeys: string[] = [];

      const processMessages = vi.fn(
        async (groupJid: string, threadTs?: string) => {
          // Record the arguments to verify routing
          processedKeys.push(`${groupJid}::${threadTs || '__root__'}`);
          return true;
        },
      );

      queue.setProcessMessagesFn(processMessages);

      // Enqueue with explicit thread
      queue.enqueueMessageCheck('group1@g.us', 'ts-123.456');
      await vi.advanceTimersByTimeAsync(10);

      // Enqueue with null thread (root)
      queue.enqueueMessageCheck('group1@g.us', null);
      await vi.advanceTimersByTimeAsync(10);

      // Both should have been dispatched (different keys)
      expect(processMessages).toHaveBeenCalledTimes(2);
      expect(processedKeys).toContain('group1@g.us::ts-123.456');
      expect(processedKeys).toContain('group1@g.us::__root__');

      // Verify isActive sees the group as active-ish (at least one thread ran)
      // After both completed synchronously, the slots should be cleaned up.
      // Let's verify they were treated as separate slots by checking they ran in parallel
    });

    it('thread slot eviction after drain decrements activeCount', async () => {
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      queue.setProcessMessagesFn(processMessages);

      // Fill both slots with two threads
      queue.enqueueMessageCheck('group1@g.us', 'thread-1');
      queue.enqueueMessageCheck('group1@g.us', 'thread-2');
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(2);

      // At capacity — third group would queue
      expect(queue.wouldQueue('group2@g.us')).toBe(true);

      // Enqueue a third that should wait
      queue.enqueueMessageCheck('group2@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Still only 2 calls — third is waiting
      expect(processMessages).toHaveBeenCalledTimes(2);

      // Complete thread-1 — activeCount should decrement, allowing group2 to start
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      // Third should now be running
      expect(processMessages).toHaveBeenCalledTimes(3);

      // Slot freed — wouldQueue for a brand new group should be false if thread-2 finishes too
      completionCallbacks[1](); // thread-2
      await vi.advanceTimersByTimeAsync(10);

      completionCallbacks[2](); // group2
      await vi.advanceTimersByTimeAsync(10);

      // All done — new enqueue should not queue
      expect(queue.wouldQueue('group3@g.us')).toBe(false);
    });
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing — pass groupFolder consistently
    queue.enqueueMessageCheck('group1@g.us', null, 'test-group');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      null,
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn, 'test-group');

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us', null, 'test-group');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
