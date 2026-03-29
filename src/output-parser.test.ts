import { describe, it, expect, vi } from 'vitest';
import {
  createParseState,
  parseStreamingChunk,
  parseLegacyOutput,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from './output-parser.js';

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

function wrapOutput(obj: object): string {
  return `${OUTPUT_START_MARKER}${JSON.stringify(obj)}${OUTPUT_END_MARKER}`;
}

describe('output-parser', () => {
  describe('parseStreamingChunk', () => {
    it('parses a single complete marker pair', () => {
      const state = createParseState();
      const output = { status: 'success', result: 'hello', newSessionId: 'sess1' };
      const results = parseStreamingChunk(state, wrapOutput(output));

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
      expect(results[0].result).toBe('hello');
      expect(state.newSessionId).toBe('sess1');
      expect(state.hadStreamingOutput).toBe(true);
    });

    it('parses multiple marker pairs in one chunk', () => {
      const state = createParseState();
      const out1 = { status: 'success', result: 'first', type: 'verbose' };
      const out2 = { status: 'success', result: 'second', type: 'result' };
      const chunk = wrapOutput(out1) + wrapOutput(out2);

      const results = parseStreamingChunk(state, chunk);

      expect(results).toHaveLength(2);
      expect(results[0].result).toBe('first');
      expect(results[1].result).toBe('second');
    });

    it('handles split marker across chunks', () => {
      const state = createParseState();
      const json = JSON.stringify({ status: 'success', result: 'split' });
      const full = `${OUTPUT_START_MARKER}${json}${OUTPUT_END_MARKER}`;

      // Split in the middle of the JSON
      const mid = Math.floor(full.length / 2);
      const chunk1 = full.slice(0, mid);
      const chunk2 = full.slice(mid);

      const results1 = parseStreamingChunk(state, chunk1);
      expect(results1).toHaveLength(0); // Incomplete pair

      const results2 = parseStreamingChunk(state, chunk2);
      expect(results2).toHaveLength(1);
      expect(results2[0].result).toBe('split');
    });

    it('handles malformed JSON between markers', () => {
      const state = createParseState();
      const chunk = `${OUTPUT_START_MARKER}not json${OUTPUT_END_MARKER}`;

      const results = parseStreamingChunk(state, chunk, 'test-group');

      expect(results).toHaveLength(0);
      expect(state.hadStreamingOutput).toBe(false);
    });

    it('preserves buffer state across calls', () => {
      const state = createParseState();

      // First chunk: complete output + start of another
      const out1 = { status: 'success', result: 'one' };
      const partial = `${OUTPUT_START_MARKER}{"status":"success"`;
      const chunk1 = wrapOutput(out1) + partial;

      const results1 = parseStreamingChunk(state, chunk1);
      expect(results1).toHaveLength(1);
      expect(results1[0].result).toBe('one');

      // Second chunk: rest of the partial
      const chunk2 = `,"result":"two"}${OUTPUT_END_MARKER}`;
      const results2 = parseStreamingChunk(state, chunk2);
      expect(results2).toHaveLength(1);
      expect(results2[0].result).toBe('two');
    });

    it('tracks newSessionId from any output', () => {
      const state = createParseState();
      const out1 = { status: 'success', result: null };
      const out2 = { status: 'success', result: 'done', newSessionId: 'abc123' };

      parseStreamingChunk(state, wrapOutput(out1));
      expect(state.newSessionId).toBeUndefined();

      parseStreamingChunk(state, wrapOutput(out2));
      expect(state.newSessionId).toBe('abc123');
    });
  });

  describe('parseLegacyOutput', () => {
    it('parses output between markers', () => {
      const output = { status: 'success', result: 'legacy result' };
      const stdout = `Some log output\n${wrapOutput(output)}\nMore logs`;

      const parsed = parseLegacyOutput(stdout);

      expect(parsed.status).toBe('success');
      expect(parsed.result).toBe('legacy result');
    });

    it('falls back to last line when no markers present', () => {
      const output = { status: 'success', result: 'fallback' };
      const stdout = `Log line 1\nLog line 2\n${JSON.stringify(output)}`;

      const parsed = parseLegacyOutput(stdout);

      expect(parsed.status).toBe('success');
      expect(parsed.result).toBe('fallback');
    });

    it('throws on empty stdout', () => {
      expect(() => parseLegacyOutput('')).toThrow();
    });

    it('throws on non-JSON content', () => {
      expect(() => parseLegacyOutput('just some text')).toThrow();
    });
  });
});
