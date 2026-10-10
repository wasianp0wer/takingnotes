import { GAP_DIRECT_CHAR_BUDGET } from '@/gaps/constants';
import type { ScreenCandidate } from '@/search/prompts';

/**
 * Fix round 3, I2: the project's own established ceiling for one
 * un-chunked prompt (`src/gaps/constants.ts`'s `GAP_DIRECT_CHAR_BUDGET`,
 * above which gaps' own `chunk.ts` chunks rather than sending it whole).
 * Past this, Ollama truncates the *front* of a prompt - where the system
 * prompt and the query line live - so a model either answers in prose
 * (the validator throws: mystifying, but honest) or answers a plausible
 * array keyed only to whatever candidates survived truncation, silently
 * dropping every note that was screened off the front. That is K46's
 * worst outcome by a second route, on exactly the library the spec's own
 * success criterion names ("found again three weeks later").
 */
export const SCREEN_BATCH_CHAR_BUDGET = GAP_DIRECT_CHAR_BUDGET;

/**
 * Splits candidates into batches whose combined `title` + `text` length
 * stays within the budget, in order, never splitting one candidate across
 * two batches - unlike `gaps/chunk.ts`'s continuous speech, a candidate is
 * a complete, atomic record with nothing to overlap. A single candidate
 * whose own text alone exceeds the budget still gets its own (over-budget)
 * batch rather than being dropped - one oversized note degrading alone is
 * better than it vanishing.
 */
export function batchScreenCandidates(
  candidates: readonly ScreenCandidate[],
  budget: number = SCREEN_BATCH_CHAR_BUDGET,
): ScreenCandidate[][] {
  const effectiveBudget = budget > 0 ? budget : SCREEN_BATCH_CHAR_BUDGET;
  const batches: ScreenCandidate[][] = [];
  let current: ScreenCandidate[] = [];
  let currentChars = 0;

  for (const candidate of candidates) {
    const size = candidate.title.length + candidate.text.length;
    if (current.length > 0 && currentChars + size > effectiveBudget) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(candidate);
    currentChars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
