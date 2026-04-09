import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLeafSummary, createCondensedSummary, LCM_CONDENSE_THRESHOLD } from './lcm-summarize.js';

let savedApiKey: string | undefined;
let savedOauthToken: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  if (savedOauthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
  else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe('LCM_CONDENSE_THRESHOLD', () => {
  it('equals 8', () => {
    expect(LCM_CONDENSE_THRESHOLD).toBe(8);
  });
});

describe('createLeafSummary', () => {
  it('returns null when no API credentials available', async () => {
    const messages = [{ role: 'user' as const, content: 'Hello world' }];
    const result = await createLeafSummary(messages, ['msg1'], 1, 1);
    expect(result).toBeNull();
  });
});

describe('createCondensedSummary', () => {
  const makeSummary = (id: string, depth: number, min: number, max: number) => ({
    id,
    content: `Summary content for ${id}`,
    min_sequence: min,
    max_sequence: max,
    depth,
  });

  it('returns null when no API credentials available', async () => {
    const summaries = [makeSummary('s1', 0, 1, 5), makeSummary('s2', 0, 6, 10)];
    const result = await createCondensedSummary(summaries);
    expect(result).toBeNull();
  });
});
