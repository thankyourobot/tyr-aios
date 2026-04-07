import { describe, it, expect } from 'vitest';
import { repairToolPairing } from './lcm-transcript-repair.js';

describe('repairToolPairing', () => {
  it('returns messages unchanged when no orphans', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: JSON.stringify([{ type: 'text', text: 'hi' }]) },
    ];
    expect(repairToolPairing(messages)).toEqual(messages);
  });

  it('injects synthetic result for orphaned tool_use', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: JSON.stringify([
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/x' } },
        ]),
      },
    ];
    const repaired = repairToolPairing(messages);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toEqual(messages[0]);

    const syntheticBlocks = JSON.parse(repaired[1].content);
    expect(syntheticBlocks).toHaveLength(1);
    expect(syntheticBlocks[0].type).toBe('tool_result');
    expect(syntheticBlocks[0].tool_use_id).toBe('tu_1');
    expect(syntheticBlocks[0].content).toContain('compacted');
  });

  it('removes orphaned tool_result blocks', () => {
    const messages = [
      {
        role: 'user' as const,
        content: JSON.stringify([
          { type: 'tool_result', tool_use_id: 'tu_nonexistent', content: 'data' },
          { type: 'tool_result', tool_use_id: 'tu_exists', content: 'data' },
        ]),
      },
      {
        role: 'assistant' as const,
        content: JSON.stringify([
          { type: 'tool_use', id: 'tu_exists', name: 'Bash', input: {} },
        ]),
      },
    ];
    const repaired = repairToolPairing(messages);
    // The user message should only have the matching result
    const blocks = JSON.parse(repaired[0].content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool_use_id).toBe('tu_exists');
  });

  it('handles paired tool calls correctly', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: JSON.stringify([
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
        ]),
      },
      {
        role: 'user' as const,
        content: JSON.stringify([
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
        ]),
      },
    ];
    expect(repairToolPairing(messages)).toEqual(messages);
  });

  it('handles plain text messages gracefully', () => {
    const messages = [
      { role: 'user' as const, content: 'plain text' },
      { role: 'assistant' as const, content: 'also plain' },
    ];
    expect(repairToolPairing(messages)).toEqual(messages);
  });
});
