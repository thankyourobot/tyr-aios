import { describe, it, expect, beforeEach } from 'vitest';
import { ExpansionAuthManager } from './lcm-expansion-auth.js';

describe('ExpansionAuthManager', () => {
  let auth: ExpansionAuthManager;

  beforeEach(() => {
    auth = new ExpansionAuthManager();
  });

  it('creates grants and validates them', () => {
    const grantId = auth.createGrant({
      conversationIds: ['conv1'],
      summaryIds: ['sum_abc'],
    });
    const result = auth.validateExpansion(grantId);
    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(50000);
  });

  it('rejects unknown grant IDs', () => {
    const result = auth.validateExpansion('nonexistent');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('rejects revoked grants', () => {
    const grantId = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [] });
    auth.revokeGrant(grantId);
    const result = auth.validateExpansion(grantId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('rejects expired grants', async () => {
    const grantId = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [], ttlMs: 1 });
    await new Promise(r => setTimeout(r, 10));
    const result = auth.validateExpansion(grantId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('tracks token budget consumption', () => {
    const grantId = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [], tokenCap: 100 });
    expect(auth.getRemainingTokenBudget(grantId)).toBe(100);

    auth.consumeTokenBudget(grantId, 60);
    expect(auth.getRemainingTokenBudget(grantId)).toBe(40);

    auth.consumeTokenBudget(grantId, 50);
    expect(auth.getRemainingTokenBudget(grantId)).toBe(0);
  });

  it('rejects when budget exhausted', () => {
    const grantId = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [], tokenCap: 10 });
    auth.consumeTokenBudget(grantId, 10);
    const result = auth.validateExpansion(grantId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('budget');
  });

  it('cleans up expired and revoked grants', () => {
    const g1 = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [], ttlMs: 1 });
    const g2 = auth.createGrant({ conversationIds: ['conv1'], summaryIds: [] });
    auth.revokeGrant(g2);

    // Wait for g1 to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const removed = auth.cleanup();
    expect(removed).toBe(2);
  });
});
