import { describe, expect, it } from 'vitest';

import {
  dropReviewed,
  GAP_MAX_POINTS,
  GAP_TEXT_MAX,
  normalizeGapText,
  validateGapPoints,
} from '@/gaps/validate';
import type { GapStatus, GapSuggestionRecord } from '@/storage/types';

function suggestion(text: string, status: GapStatus): GapSuggestionRecord {
  return {
    id: `gap-${text}-${status}`,
    noteId: 'note-1',
    pageId: 'page-1',
    recordingId: 'rec-1',
    fromMs: 0,
    toMs: 1,
    text,
    kind: 'claim',
    sourceQuote: 'said it',
    status,
    model: 'gemma4:12b',
    promptVersion: 'gap-compare-gemma-v1',
    summarized: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('validateGapPoints', () => {
  it('keeps a clean array', () => {
    const points = validateGapPoints([
      { text: 'A', kind: 'claim', sourceQuote: 'a' },
      { text: 'B', kind: 'definition', sourceQuote: 'b' },
      { text: 'C', kind: 'name-or-date', sourceQuote: 'c' },
    ]);
    expect(points).toEqual([
      { text: 'A', kind: 'claim', sourceQuote: 'a' },
      { text: 'B', kind: 'definition', sourceQuote: 'b' },
      { text: 'C', kind: 'name-or-date', sourceQuote: 'c' },
    ]);
  });

  it('unwraps the usual wrapper objects', () => {
    const row = [{ text: 'A', kind: 'claim', sourceQuote: 'a' }];
    expect(validateGapPoints({ points: row })).toHaveLength(1);
    expect(validateGapPoints({ gaps: row })).toHaveLength(1);
    expect(validateGapPoints({ missing: row })).toHaveLength(1);
  });

  it('drops bad rows rather than casting them', () => {
    const points = validateGapPoints([
      null,
      'a string',
      42,
      { kind: 'claim' },
      { text: '   ', kind: 'claim' },
      { text: 7, kind: 'claim' },
      { text: 'kept', kind: 'claim', sourceQuote: 'q' },
    ]);
    expect(points).toEqual([{ text: 'kept', kind: 'claim', sourceQuote: 'q' }]);
  });

  it('accepts every valid kind and falls back to other', () => {
    const kinds = ['claim', 'definition', 'name-or-date', 'example', 'argument-step', 'other'];
    const points = validateGapPoints(
      kinds.map((kind, i) => ({ text: `t${i}`, kind, sourceQuote: 'q' })),
    );
    expect(points.map((p) => p.kind)).toEqual(kinds);
    expect(validateGapPoints([{ text: 'x', kind: 'nonsense', sourceQuote: 'q' }])[0].kind).toBe(
      'other',
    );
    expect(validateGapPoints([{ text: 'y', sourceQuote: 'q' }])[0].kind).toBe('other');
  });

  it('coerces a missing or non-string quote to empty', () => {
    expect(validateGapPoints([{ text: 'x', kind: 'claim' }])[0].sourceQuote).toBe('');
    expect(validateGapPoints([{ text: 'x', kind: 'claim', sourceQuote: 9 }])[0].sourceQuote).toBe('');
  });

  it('trims and caps text and quote', () => {
    const long = 'z'.repeat(GAP_TEXT_MAX + 500);
    const [point] = validateGapPoints([
      { text: `  padded  `, kind: 'claim', sourceQuote: `  ${long}  ` },
    ]);
    expect(point.text).toBe('padded');
    expect(point.sourceQuote.length).toBe(GAP_TEXT_MAX);
  });

  it('throws on a value that is not an array or a wrapper', () => {
    expect(() => validateGapPoints('nope')).toThrow();
    expect(() => validateGapPoints(42)).toThrow();
    expect(() => validateGapPoints(null)).toThrow();
    expect(() => validateGapPoints({ answer: 'no gaps' })).toThrow();
  });

  it('accepts an empty array: the model found nothing', () => {
    expect(validateGapPoints([])).toEqual([]);
  });

  it('collapses duplicates within one response', () => {
    const points = validateGapPoints([
      { text: 'The Treaty was 1919.', kind: 'name-or-date', sourceQuote: 'a' },
      { text: 'the treaty was 1919', kind: 'claim', sourceQuote: 'b' },
    ]);
    expect(points).toHaveLength(1);
  });

  it('caps a very long response', () => {
    const rows = Array.from({ length: GAP_MAX_POINTS + 20 }, (_, i) => ({
      text: `point ${i}`,
      kind: 'claim',
      sourceQuote: 'q',
    }));
    expect(validateGapPoints(rows)).toHaveLength(GAP_MAX_POINTS);
  });
});

describe('normalizeGapText', () => {
  it('ignores case, surrounding punctuation and runs of whitespace', () => {
    expect(normalizeGapText('  The  Treaty\nwas 1919. ')).toBe(normalizeGapText('the treaty was 1919'));
  });
});

describe('dropReviewed', () => {
  const points = [
    { text: 'Accepted already', kind: 'claim' as const, sourceQuote: 'a' },
    { text: 'rejected already!', kind: 'claim' as const, sourceQuote: 'b' },
    { text: 'Still proposed', kind: 'claim' as const, sourceQuote: 'c' },
    { text: 'Brand new', kind: 'claim' as const, sourceQuote: 'd' },
  ];

  it('removes points already accepted or rejected and keeps the rest', () => {
    const kept = dropReviewed(points, [
      suggestion('accepted already', 'accepted'),
      suggestion('Rejected already', 'rejected'),
      suggestion('Still proposed', 'proposed'),
    ]);
    expect(kept.map((p) => p.text)).toEqual(['Still proposed', 'Brand new']);
  });

  it('keeps everything when nothing was reviewed', () => {
    expect(dropReviewed(points, [])).toHaveLength(4);
  });
});
