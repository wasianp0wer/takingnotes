import { describe, expect, it } from 'vitest';

import {
  chunkSyllabusText,
  SYLLABUS_CHUNK_CHARS,
  SYLLABUS_CHUNK_OVERLAP,
  SYLLABUS_DIRECT_CHAR_BUDGET,
} from '@/syllabus/chunk';

const lines = (n: number, width = 60): string =>
  Array.from({ length: n }, (_, i) => `Assignment ${i} due Oct ${(i % 28) + 1}`.padEnd(width, '.'))
    .join('\n');

describe('chunkSyllabusText', () => {
  it('keeps text inside the direct budget as one chunk, unchanged', () => {
    const text = lines(10);
    expect(text.length).toBeLessThan(SYLLABUS_DIRECT_CHAR_BUDGET);
    expect(chunkSyllabusText(text)).toEqual([text]);
  });

  it('splits longer text into chunks within the chunk budget', () => {
    const text = lines(400);
    const chunks = chunkSyllabusText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYLLABUS_CHUNK_CHARS + SYLLABUS_CHUNK_OVERLAP);
      expect(chunk.trim()).not.toBe('');
    }
  });

  it('loses no content: the chunks walk the text forward and reach its end', () => {
    const text = lines(400);
    const chunks = chunkSyllabusText(text);

    // Every chunk is a real slice of the text, each starts no later than the
    // previous one ended (so nothing between them is skipped), and the last
    // chunk reaches the end.
    let covered = 0;
    for (const chunk of chunks) {
      const at = text.indexOf(chunk);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, at + chunk.length);
    }
    expect(covered).toBe(text.length);
  });

  it('overlaps consecutive chunks so an item on a boundary is seen whole', () => {
    const text = lines(400);
    const [first, second] = chunkSyllabusText(text);
    const tail = first.slice(-40);
    expect(second.includes(tail)).toBe(true);
  });

  // Regression: when a chunk's end snapped forward to a line start, stepping
  // back by the overlap and then searching FORWARD for the next line start
  // used to land back on that same newline, collapsing the overlap to zero at
  // every boundary - invisible on short lines (many newlines within one
  // overlap's width), but total on lines longer than the overlap, which is
  // the common case for prose paragraphs (fix round 1, Important 4).
  it('overlaps consecutive chunks by a real amount even when lines are longer than the overlap', () => {
    const text = lines(20, 800);
    const chunks = chunkSyllabusText(text);
    expect(chunks.length).toBeGreaterThan(1);

    const [first, second] = chunks;
    const secondStart = text.indexOf(second);
    expect(secondStart).toBeGreaterThanOrEqual(0);
    const overlapChars = first.length - secondStart;
    // A real minimum, not just "at least one shared character": the old
    // forward search produced an overlap of ~0 in exactly this shape.
    expect(overlapChars).toBeGreaterThanOrEqual(SYLLABUS_CHUNK_OVERLAP / 2);
  });

  // Regression (fix round 2, Important): with a zero effective overlap, the
  // next chunk's start could land one past `end` when the text has a `\n`
  // exactly there (a blank line right after a line-boundary snap), silently
  // dropping that character. Exercised both ways a zero effective overlap
  // arises: an explicit `overlap: 0`, and `chunkChars: 1`, which clamps the
  // overlap to `floor(1 / 2) = 0` regardless of what was asked for. Both
  // fixtures and their expected output below were hand-traced against the
  // algorithm; the pre-fix code produces a *different*, shorter-covering
  // array for each (silently dropping the blank line's second newline).
  it('covers every character when the effective overlap is zero (explicit overlap: 0)', () => {
    // Indices: 0-3 "AAAA", 4 "\n", 5 "\n" (blank line), 6-9 "BBBB", 10 "\n", 11-14 "CCCC".
    // Hand-traced against the algorithm (and checked against the running
    // implementation): the pre-fix code instead produces
    // ["AAAA\n", "BBBB\n", "CCCC"], silently dropping the blank line's second
    // newline at index 5. Exact equality, not a generic indexOf coverage
    // walk, because "CCCC" contains a repeated "CC" - the same reason the
    // single-long-line test below does not use a coverage walk either.
    const text = 'AAAA\n\nBBBB\nCCCC';
    const chunks = chunkSyllabusText(text, { budget: 1, chunkChars: 4, overlap: 0 });
    expect(chunks).toEqual(['AAAA\n', '\nBBB', 'B\nCC', 'CC']);
  });

  it('covers every character when chunkChars: 1 clamps the overlap to zero', () => {
    // Indices: 0 "A", 1 "\n", 2 "\n" (blank line), 3 "B". With chunkChars: 1
    // the recovered span is never more than the blank line's own newline, so
    // this also exercises that a middle chunk of pure whitespace is kept
    // rather than silently dropped by the empty-chunk trim (which would
    // reopen the same gap one character over).
    const text = 'A\n\nB';
    const chunks = chunkSyllabusText(text, { budget: 1, chunkChars: 1, overlap: 300 });
    expect(chunks).toEqual(['A\n', '\n', 'B']);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a newline boundary, so a deadline row is not cut in half', () => {
    const chunks = chunkSyllabusText(lines(400));
    // Every chunk after the first starts at the beginning of a line.
    for (const chunk of chunks.slice(1)) expect(chunk.startsWith('Assignment')).toBe(true);
  });

  it('handles one line longer than the budget without producing empty chunks', () => {
    const chunks = chunkSyllabusText('x'.repeat(10_000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
    expect(chunks.join('').length).toBeGreaterThanOrEqual(10_000);
  });

  it('returns nothing for text with no content', () => {
    expect(chunkSyllabusText('')).toEqual([]);
    expect(chunkSyllabusText('   \n\n  ')).toEqual([]);
  });
});
