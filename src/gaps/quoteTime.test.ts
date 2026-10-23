import { describe, expect, it } from 'vitest';

import { findQuoteInBullets, findQuoteInSegments, normalizeForMatch } from '@/gaps/quoteTime';

describe('normalizeForMatch', () => {
  it('lowercases, collapses non-alphanumeric runs and trims', () => {
    expect(normalizeForMatch('  The Krebs  cycle, ATP!')).toBe('the krebs cycle atp');
  });
});

describe('findQuoteInSegments', () => {
  const segments = [
    { startMs: 0, endMs: 1000, text: 'Hello there.' },
    { startMs: 1000, endMs: 2500, text: 'The Krebs cycle' },
    { startMs: 2500, endMs: 4000, text: 'makes ATP. Next topic.' },
  ];

  it('spans the segments a quote runs across', () => {
    expect(findQuoteInSegments(segments, 'krebs cycle makes ATP')).toEqual({
      startMs: 1000,
      endMs: 4000,
    });
  });

  it('finds a quote inside the first segment', () => {
    expect(findQuoteInSegments(segments, 'Hello there')).toEqual({
      startMs: 0,
      endMs: 1000,
    });
  });

  it('returns null when the quote was not said', () => {
    expect(findQuoteInSegments(segments, 'not said')).toBeNull();
  });

  it('returns null for an empty quote', () => {
    expect(findQuoteInSegments(segments, '')).toBeNull();
    expect(findQuoteInSegments(segments, ' ... ')).toBeNull();
  });

  it('ignores segments with empty text', () => {
    const withSilence = [
      { startMs: 0, endMs: 500, text: '' },
      { startMs: 500, endMs: 1000, text: 'alpha' },
      { startMs: 1000, endMs: 1500, text: '   ' },
      { startMs: 1500, endMs: 2000, text: 'beta' },
    ];
    expect(findQuoteInSegments(withSilence, 'alpha beta')).toEqual({
      startMs: 500,
      endMs: 2000,
    });
  });
});

describe('findQuoteInBullets', () => {
  const bullets = [
    { text: '- Mitochondria make ATP', startMs: 0, endMs: 60000 },
    { text: '- Krebs cycle runs in matrix', startMs: 50000, endMs: 120000 },
  ];

  it('returns the range of the bullet containing the quote', () => {
    expect(findQuoteInBullets(bullets, 'Krebs cycle runs in matrix')).toEqual({
      startMs: 50000,
      endMs: 120000,
    });
  });

  it('returns the first bullet when several match', () => {
    const twice = [
      { text: '- ATP is made', startMs: 0, endMs: 10 },
      { text: '- more on ATP is made', startMs: 20, endMs: 30 },
    ];
    expect(findQuoteInBullets(twice, 'ATP is made')).toEqual({
      startMs: 0,
      endMs: 10,
    });
  });

  it('returns null with no match', () => {
    expect(findQuoteInBullets(bullets, 'photosynthesis')).toBeNull();
  });

  it('ignores a leading dash on the quote or the bullet', () => {
    expect(findQuoteInBullets(bullets, '- Mitochondria make ATP')).toEqual({
      startMs: 0,
      endMs: 60000,
    });
  });
});
