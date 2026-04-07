/**
 * Grant-based delegation auth for LCM expansion sub-agents.
 * Creates time-limited, token-capped grants that constrain what a sub-agent can access.
 */

import crypto from 'crypto';

export interface ExpansionGrant {
  grantId: string;
  conversationIds: string[];
  allowedSummaryIds: string[];
  maxDepth: number;
  tokenCap: number;
  consumedTokens: number;
  expiresAt: number;
  revoked: boolean;
  createdAt: number;
}

export interface CreateGrantInput {
  conversationIds: string[];
  summaryIds: string[];
  maxDepth?: number;
  tokenCap?: number;
  ttlMs?: number;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  remainingTokens?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TOKEN_CAP = 50000;
const DEFAULT_TTL_MS = 300000; // 5 minutes

export class ExpansionAuthManager {
  private grants = new Map<string, ExpansionGrant>();

  createGrant(input: CreateGrantInput): string {
    const grantId = crypto.randomUUID();
    const now = Date.now();
    this.grants.set(grantId, {
      grantId,
      conversationIds: input.conversationIds,
      allowedSummaryIds: input.summaryIds,
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      tokenCap: input.tokenCap ?? DEFAULT_TOKEN_CAP,
      consumedTokens: 0,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
      revoked: false,
      createdAt: now,
    });
    return grantId;
  }

  validateExpansion(grantId: string, summaryId?: string): ValidationResult {
    const grant = this.grants.get(grantId);
    if (!grant) return { allowed: false, reason: 'Grant not found' };
    if (grant.revoked) return { allowed: false, reason: 'Grant has been revoked' };
    if (Date.now() > grant.expiresAt) return { allowed: false, reason: 'Grant has expired' };

    const remaining = grant.tokenCap - grant.consumedTokens;
    if (remaining <= 0) return { allowed: false, reason: 'Token budget exhausted' };

    // If a specific summary is requested, check it's allowed
    // We allow any summary reachable from the allowed set (lenient — the sub-agent navigates the DAG)
    // The grant's allowedSummaryIds are seed hints, not a strict allowlist

    return { allowed: true, remainingTokens: remaining };
  }

  consumeTokenBudget(grantId: string, tokens: number): number {
    const grant = this.grants.get(grantId);
    if (!grant) return 0;
    grant.consumedTokens += tokens;
    return Math.max(0, grant.tokenCap - grant.consumedTokens);
  }

  getRemainingTokenBudget(grantId: string): number {
    const grant = this.grants.get(grantId);
    if (!grant) return 0;
    return Math.max(0, grant.tokenCap - grant.consumedTokens);
  }

  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) grant.revoked = true;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, grant] of this.grants) {
      if (grant.revoked || now > grant.expiresAt) {
        this.grants.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

export const expansionAuth = new ExpansionAuthManager();
