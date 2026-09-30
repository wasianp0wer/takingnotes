import { GAP_CHUNK_CHARS, GAP_CHUNK_OVERLAP } from '@/gaps/constants';

export interface ChunkOptions {
  budget?: number;
  overlap?: number;
}

/** The last whitespace at or before `limit`, or -1 when there is none. */
function lastBreakBefore(text: string, limit: number): number {
  for (let i = limit; i > 0; i -= 1) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

/**
 * Splits speech into overlapping chunks for summarization (J5). Each chunk is at
 * most `budget` characters and, where the text allows, ends on a whitespace
 * boundary so a chunk never stops mid-word. The next chunk starts roughly
 * `overlap` characters earlier, so a sentence straddling a cut is summarized
 * whole at least once.
 *
 * Deliberately character-based rather than sentence-based: a Whisper transcript
 * has unreliable punctuation, and the budget that matters is the model's context,
 * which is measured in characters.
 */
export function chunkSpeech(text: string, opts: ChunkOptions = {}): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const rawBudget = opts.budget ?? GAP_CHUNK_CHARS;
  const budget = rawBudget > 0 ? rawBudget : GAP_CHUNK_CHARS;
  if (trimmed.length <= budget) return [trimmed];

  // An overlap at or above the budget would never advance; clamped rather than
  // rejected, because it is a tuning value and a stall is unrecoverable.
  const overlap = Math.max(0, Math.min(opts.overlap ?? GAP_CHUNK_OVERLAP, budget - 1));

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const hardEnd = Math.min(start + budget, trimmed.length);
    let end = hardEnd;
    if (hardEnd < trimmed.length) {
      const brk = lastBreakBefore(trimmed, hardEnd);
      // Only honour a break that leaves a chunk worth sending; a long unbroken
      // run (a URL, a word-less transcript) is cut at the budget instead.
      if (brk > start) end = brk;
    }
    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= trimmed.length) break;

    let next = end - overlap;
    if (next > start) {
      const brk = lastBreakBefore(trimmed, next);
      if (brk > start) next = brk + 1;
    }
    // The start must always move forward, whatever the boundary search found.
    start = next > start ? next : end;
  }
  return chunks;
}
