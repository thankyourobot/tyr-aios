import { describe, it, expect } from 'vitest';
import { tokenizeText, scoreRelevance } from './lcm-relevance.js';

describe('tokenizeText', () => {
  it('splits on non-alphanumeric characters', () => {
    expect(tokenizeText('hello world')).toEqual(['hello', 'world']);
  });

  it('lowercases tokens', () => {
    expect(tokenizeText('Hello WORLD')).toEqual(['hello', 'world']);
  });

  it('filters single-character tokens', () => {
    expect(tokenizeText('a b cd ef')).toEqual(['cd', 'ef']);
  });

  it('handles empty string', () => {
    expect(tokenizeText('')).toEqual([]);
  });

  it('handles punctuation and special chars', () => {
    expect(tokenizeText('file.ts: function foo()')).toEqual(['file', 'ts', 'function', 'foo']);
  });
});

describe('scoreRelevance', () => {
  it('returns 0 for empty prompt', () => {
    expect(scoreRelevance('some text', '')).toBe(0);
  });

  it('returns 0 for empty item', () => {
    expect(scoreRelevance('', 'search terms')).toBe(0);
  });

  it('returns 0 when no terms match', () => {
    expect(scoreRelevance('the cat sat on the mat', 'database migration')).toBe(0);
  });

  it('returns positive score for matching terms', () => {
    const score = scoreRelevance('database migration script updated', 'database migration');
    expect(score).toBeGreaterThan(0);
  });

  it('scores higher for more matching terms', () => {
    const scoreHigh = scoreRelevance('database migration script', 'database migration');
    const scoreLow = scoreRelevance('database connection pool', 'database migration');
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  it('does not double-count repeated prompt terms', () => {
    const score1 = scoreRelevance('database setup', 'database');
    const score2 = scoreRelevance('database setup', 'database database database');
    expect(score1).toBe(score2);
  });
});
