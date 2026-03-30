import { ContainerOutput } from './types.js';
import { logger } from './logger.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ParseState {
  buffer: string;
  newSessionId?: string;
  hadStreamingOutput: boolean;
}

export function createParseState(): ParseState {
  return {
    buffer: '',
    hadStreamingOutput: false,
  };
}

/**
 * Process a stdout chunk, extracting any complete OUTPUT_START/END pairs.
 * Mutates state.buffer to retain incomplete data for next call.
 * Returns parsed ContainerOutput objects found in this chunk.
 */
export function parseStreamingChunk(
  parseState: ParseState,
  chunk: string,
  groupName?: string,
): ContainerOutput[] {
  const results: ContainerOutput[] = [];
  parseState.buffer += chunk;

  let startIdx: number;
  while ((startIdx = parseState.buffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = parseState.buffer.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break; // Incomplete pair, wait for more data

    const jsonStr = parseState.buffer
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    parseState.buffer = parseState.buffer.slice(
      endIdx + OUTPUT_END_MARKER.length,
    );

    try {
      const parsed: ContainerOutput = JSON.parse(jsonStr);
      if (parsed.newSessionId) {
        parseState.newSessionId = parsed.newSessionId;
      }
      parseState.hadStreamingOutput = true;
      results.push(parsed);
    } catch (err) {
      logger.warn(
        { group: groupName, error: err },
        'Failed to parse streamed output chunk',
      );
    }
  }

  return results;
}

/**
 * Parse the final stdout for legacy (non-streaming) output.
 * Looks for the last OUTPUT_START/END marker pair, falls back to last line.
 */
export function parseLegacyOutput(stdout: string): ContainerOutput {
  // Extract JSON between sentinel markers for robust parsing
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    // Fallback: last non-empty line (backwards compatibility)
    const lines = stdout.trim().split('\n');
    jsonLine = lines[lines.length - 1];
  }

  return JSON.parse(jsonLine);
}
