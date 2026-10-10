import { describe, expect, it } from 'vitest';

import { batchScreenCandidates } from '@/search/screenBatch';
import type { ScreenCandidate } from '@/search/prompts';

function candidate(index: number, textLength: number): ScreenCandidate {
  return { index, title: `Note ${index}`, text: 'x'.repeat(textLength) };
}

describe('batchScreenCandidates', () => {
  it('puts every candidate in one batch when the total is well under budget', () => {
    const candidates = [candidate(1, 10), candidate(2, 10), candidate(3, 10)];
    const batches = batchScreenCandidates(candidates, 1000);
    expect(batches).toEqual([candidates]);
  });

  it('returns [] for an empty candidate list', () => {
    expect(batchScreenCandidates([], 1000)).toEqual([]);
  });

  it('splits into multiple batches once the running total would exceed the budget', () => {
    // Each candidate (title "Note N" ~6-7 chars + 90 chars of text) is
    // roughly 97 chars; a budget of 200 should fit two per batch.
    const candidates = [candidate(1, 90), candidate(2, 90), candidate(3, 90), candidate(4, 90)];
    const batches = batchScreenCandidates(candidates, 200);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const total = batch.reduce((sum, c) => sum + c.title.length + c.text.length, 0);
      expect(total).toBeLessThanOrEqual(200);
    }
  });

  it('never splits one candidate across two batches', () => {
    const candidates = [candidate(1, 90), candidate(2, 90), candidate(3, 90)];
    const batches = batchScreenCandidates(candidates, 150);
    const seen = new Set<number>();
    for (const batch of batches) {
      for (const c of batch) {
        expect(seen.has(c.index)).toBe(false);
        seen.add(c.index);
      }
    }
    expect(seen.size).toBe(candidates.length);
  });

  it('covers every candidate exactly once, across all batches, preserving order', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i + 1, 50));
    const batches = batchScreenCandidates(candidates, 180);
    const flattened = batches.flat();
    expect(flattened.map((c) => c.index)).toEqual(candidates.map((c) => c.index));
  });

  it("counts the title's own length toward the budget, not just the text", () => {
    // Two candidates with a 95-char title each and minimal text: the title
    // alone is what pushes the pair over a 150-char budget.
    const longTitle = 'T'.repeat(95);
    const candidates: ScreenCandidate[] = [
      { index: 1, title: longTitle, text: 'x' },
      { index: 2, title: longTitle, text: 'x' },
    ];
    const batches = batchScreenCandidates(candidates, 150);
    expect(batches).toHaveLength(2);
  });

  it('still gives a single oversized candidate its own batch rather than dropping it', () => {
    const huge = candidate(1, 5000);
    const small = candidate(2, 10);
    const batches = batchScreenCandidates([huge, small], 200);
    expect(batches.flat().map((c) => c.index)).toEqual([1, 2]);
    expect(batches[0]).toEqual([huge]);
  });

  it('defaults to SCREEN_BATCH_CHAR_BUDGET when no budget is given, and falls back to it for a non-positive one', () => {
    const many = Array.from({ length: 200 }, (_, i) => candidate(i + 1, 50));
    const defaulted = batchScreenCandidates(many);
    const explicit = batchScreenCandidates(many, 6000);
    expect(defaulted).toEqual(explicit);
    expect(batchScreenCandidates(many, 0)).toEqual(explicit);
    expect(batchScreenCandidates(many, -5)).toEqual(explicit);
  });
});
