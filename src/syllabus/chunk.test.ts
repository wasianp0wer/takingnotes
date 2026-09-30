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
    expect(second.startsWith(tail) || second.includes(tail)).toBe(true);
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
