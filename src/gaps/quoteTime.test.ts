import { describe, expect, it } from 'vitest';

import {
  citedBullet,
  findQuoteInBullets,
  findQuoteInSegments,
  normalizeForMatch,
} from '@/gaps/quoteTime';

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

  it('matches whole words only', () => {
    const words = [
      { startMs: 0, endMs: 1000, text: 'ATPase is an enzyme.' },
      { startMs: 1000, endMs: 2000, text: 'Off to a good start.' },
    ];
    expect(findQuoteInSegments(words, 'ATP')).toBeNull();
    expect(findQuoteInSegments(words, 'art')).toBeNull();
    expect(findQuoteInSegments(words, 'enzyme off')).toEqual({ startMs: 0, endMs: 2000 });
  });

  it('skips a partial-word hit for a later whole-word one', () => {
    const words = [
      { startMs: 0, endMs: 1000, text: 'ATPase first.' },
      { startMs: 1000, endMs: 2000, text: 'Then ATP itself.' },
    ];
    expect(findQuoteInSegments(words, 'ATP')).toEqual({ startMs: 1000, endMs: 2000 });
  });

  it('spans the pieces of a quote the model joined with an ellipsis', () => {
    expect(findQuoteInSegments(segments, 'Hello there, the Krebs... makes ATP next topic')).toEqual({
      startMs: 0,
      endMs: 4000,
    });
  });

  it('spans the sentences of a quote that are each found, skipping one that was not said', () => {
    expect(findQuoteInSegments(segments, 'The Krebs cycle. Something nobody said here.')).toEqual({
      startMs: 1000,
      endMs: 2500,
    });
  });

  it('does not place a quote by a fragment too short to be evidence', () => {
    expect(findQuoteInSegments(segments, 'Nobody said this at all. Next topic.')).toBeNull();
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

  it('matches whole words only', () => {
    const words = [
      { startMs: 0, endMs: 1000, text: 'ATPase is an enzyme' },
      { startMs: 1000, endMs: 2000, text: 'a good start' },
      { startMs: 2000, endMs: 3000, text: 'cells make ATP' },
    ];
    expect(findQuoteInBullets(words, 'ATP')).toEqual({ startMs: 2000, endMs: 3000 });
    expect(findQuoteInBullets(words, 'art')).toBeNull();
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

describe('findQuoteInBullets across bullets', () => {
  const bullets = [
    { text: '- Mitochondria make ATP', startMs: 0, endMs: 10_000 },
    { text: '- Krebs cycle runs in matrix', startMs: 20_000, endMs: 30_000 },
  ];

  it('spans every bullet a multi-sentence quote was copied from', () => {
    expect(
      findQuoteInBullets(bullets, 'Mitochondria make ATP. Krebs cycle runs in matrix.'),
    ).toEqual({ startMs: 0, endMs: 30_000 });
  });

  it('spans the bullets either side of an ellipsis', () => {
    expect(findQuoteInBullets(bullets, 'Mitochondria make ATP ... runs in matrix')).toEqual({
      startMs: 0,
      endMs: 30_000,
    });
  });
});

describe('citedBullet', () => {
  const lines = new Map([
    [1, { startMs: 0, endMs: 4_000 }],
    [2, { startMs: 5_000, endMs: 9_000 }],
    [3, { startMs: 10_000, endMs: 14_000 }],
  ]);
  const chunk = { startMs: 0, endMs: 14_000 };

  it('takes the span of the one line a bullet cites and strips the mark', () => {
    expect(citedBullet('- Entropy rises [2]', lines, chunk)).toEqual({
      text: '- Entropy rises',
      startMs: 5_000,
      endMs: 9_000,
    });
  });

  it('spans several cited lines, written as a list, a range or separate marks', () => {
    const want = { text: '- Point', startMs: 5_000, endMs: 14_000 };
    expect(citedBullet('- Point [2, 3]', lines, chunk)).toEqual(want);
    expect(citedBullet('- Point [2-3]', lines, chunk)).toEqual(want);
    expect(citedBullet('- Point [2][3]', lines, chunk)).toEqual(want);
    expect(citedBullet('- Point (lines 2, 3)', lines, chunk)).toEqual({
      text: '- Point (lines 2, 3)',
      ...chunk,
    });
  });

  it('keeps the chunk span when a bullet cites nothing or only unknown lines', () => {
    expect(citedBullet('- Point', lines, chunk)).toEqual({ text: '- Point', ...chunk });
    expect(citedBullet('- Point [9]', lines, chunk)).toEqual({ text: '- Point', ...chunk });
  });

  it('leaves a bracket that is not a citation in the text', () => {
    expect(citedBullet('- The array [a, b] is sorted [3]', lines, chunk)).toEqual({
      text: '- The array [a, b] is sorted',
      startMs: 10_000,
      endMs: 14_000,
    });
  });
});
