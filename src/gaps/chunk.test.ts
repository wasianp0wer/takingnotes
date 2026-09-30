import { describe, expect, it } from 'vitest';

import { chunkSpeech } from '@/gaps/chunk';
import { GAP_CHUNK_CHARS, GAP_CHUNK_OVERLAP } from '@/gaps/constants';

/** `words` space-separated words, each 4 characters, so lengths are predictable. */
function speech(words: number): string {
  return Array.from({ length: words }, (_, i) => `w${String(i).padStart(3, '0')}`).join(' ');
}

describe('chunkSpeech', () => {
  it('returns one trimmed chunk when the text fits the budget', () => {
    expect(chunkSpeech('  a short sentence  ', { budget: 100, overlap: 10 })).toEqual([
      'a short sentence',
    ]);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkSpeech('', { budget: 100, overlap: 10 })).toEqual([]);
    expect(chunkSpeech('   \n  ', { budget: 100, overlap: 10 })).toEqual([]);
  });

  it('splits long text into chunks within the budget', () => {
    const chunks = chunkSpeech(speech(400), { budget: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('covers every word of the input and overlaps consecutive chunks', () => {
    const text = speech(400);
    const chunks = chunkSpeech(text, { budget: 200, overlap: 40 });
    for (const word of text.split(' ')) {
      expect(chunks.some((c) => c.includes(word))).toBe(true);
    }
    // Consecutive chunks share text: the tail of one starts inside the next.
    for (let i = 1; i < chunks.length; i += 1) {
      const tail = chunks[i - 1].slice(-20);
      expect(chunks[i].includes(tail)).toBe(true);
    }
  });

  it('breaks on whitespace, never mid-word', () => {
    for (const chunk of chunkSpeech(speech(400), { budget: 200, overlap: 40 })) {
      expect(chunk).toMatch(/^w\d{3}/);
      expect(chunk).toMatch(/w\d{3}$/);
    }
  });

  it('still terminates on a single word longer than the budget', () => {
    const chunks = chunkSpeech('x'.repeat(500), { budget: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toContain('x'.repeat(100));
  });

  it('clamps an overlap at or above the budget and still terminates', () => {
    const chunks = chunkSpeech(speech(200), { budget: 100, overlap: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('defaults to the P1 constants and ignores a non-positive budget', () => {
    const long = speech(3000);
    expect(long.length).toBeGreaterThan(GAP_CHUNK_CHARS);
    const defaults = chunkSpeech(long);
    for (const chunk of defaults) expect(chunk.length).toBeLessThanOrEqual(GAP_CHUNK_CHARS);
    expect(chunkSpeech(long, { budget: 0, overlap: GAP_CHUNK_OVERLAP })).toEqual(defaults);
  });
});
