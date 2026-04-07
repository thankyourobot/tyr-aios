/**
 * Tool call/result pairing repair for LCM context assembly.
 * Fixes orphaned tool calls/results that can cause API errors.
 */

import type { ParsedMessage } from './lcm-helpers.js';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
}

type ContentBlock = ToolUseBlock | ToolResultBlock | { type: string; [key: string]: unknown };

/**
 * Repair tool call/result pairing in a message sequence.
 * - Injects synthetic error results for orphaned tool_use blocks
 * - Removes orphaned tool_result blocks (no matching tool_use)
 * - Deduplicates tool_result blocks with same tool_use_id
 */
export function repairToolPairing(messages: ParsedMessage[]): ParsedMessage[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  // Collect all tool_result IDs from user messages
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    try {
      const blocks = JSON.parse(msg.content) as ContentBlock[];
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        if (block.type === 'tool_use' && 'id' in block) {
          toolUseIds.add((block as ToolUseBlock).id);
        } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
          toolResultIds.add((block as ToolResultBlock).tool_use_id);
        }
      }
    } catch {
      // Plain text message, skip
    }
  }

  // Find orphans
  const orphanedUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUseIds.add(id);
  }

  const orphanedResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResultIds.add(id);
  }

  // If nothing to fix, return as-is
  if (orphanedUseIds.size === 0 && orphanedResultIds.size === 0) return messages;

  const seenResultIds = new Set<string>();
  const repaired: ParsedMessage[] = [];

  for (const msg of messages) {
    try {
      const blocks = JSON.parse(msg.content) as ContentBlock[];
      if (!Array.isArray(blocks)) {
        repaired.push(msg);
        continue;
      }

      if (msg.role === 'assistant') {
        // Check if this assistant message has orphaned tool_use blocks
        const hasOrphanedUse = blocks.some(
          b => b.type === 'tool_use' && 'id' in b && orphanedUseIds.has((b as ToolUseBlock).id),
        );

        repaired.push(msg);

        // Inject synthetic results for orphaned tool_use blocks
        if (hasOrphanedUse) {
          const syntheticResults: ToolResultBlock[] = [];
          for (const block of blocks) {
            if (block.type === 'tool_use' && 'id' in block) {
              const useBlock = block as ToolUseBlock;
              if (orphanedUseIds.has(useBlock.id) && !seenResultIds.has(useBlock.id)) {
                syntheticResults.push({
                  type: 'tool_result',
                  tool_use_id: useBlock.id,
                  content: '[result unavailable — context was compacted]',
                });
                seenResultIds.add(useBlock.id);
              }
            }
          }
          if (syntheticResults.length > 0) {
            repaired.push({
              role: 'user',
              content: JSON.stringify(syntheticResults),
            });
          }
        }
      } else {
        // User message — filter out orphaned and duplicate results
        const filteredBlocks = blocks.filter(block => {
          if (block.type !== 'tool_result' || !('tool_use_id' in block)) return true;
          const resultBlock = block as ToolResultBlock;

          // Remove orphaned results
          if (orphanedResultIds.has(resultBlock.tool_use_id)) return false;

          // Deduplicate
          if (seenResultIds.has(resultBlock.tool_use_id)) return false;
          seenResultIds.add(resultBlock.tool_use_id);
          return true;
        });

        if (filteredBlocks.length > 0) {
          repaired.push({ role: 'user', content: JSON.stringify(filteredBlocks) });
        }
        // If all blocks were filtered, skip the message entirely
      }
    } catch {
      // Plain text, pass through
      repaired.push(msg);
    }
  }

  return repaired;
}
