/**
 * BM25-lite relevance scoring for LCM context assembly.
 * Scores items by keyword overlap with the current prompt.
 */

/**
 * Tokenize text into lowercase alphanumeric tokens (min length 2).
 */
export function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
}

/**
 * Score how relevant an item's text is to a prompt using normalized term frequency.
 * Higher scores mean stronger keyword overlap.
 */
export function scoreRelevance(itemText: string, prompt: string): number {
  const promptTerms = tokenizeText(prompt);
  if (promptTerms.length === 0) return 0;

  const itemTerms = tokenizeText(itemText);
  if (itemTerms.length === 0) return 0;

  // Build term frequency map for the item
  const freq = new Map<string, number>();
  for (const term of itemTerms) {
    freq.set(term, (freq.get(term) ?? 0) + 1);
  }

  // Score: sum of normalized TF for unique prompt terms found in item
  const seen = new Set<string>();
  let score = 0;
  for (const term of promptTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const tf = freq.get(term) ?? 0;
    if (tf > 0) {
      score += tf / itemTerms.length;
    }
  }

  return score;
}
