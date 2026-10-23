import { describe, expect, it } from 'vitest';

import { chunkSegments, chunkSpeech } from '@/gaps/chunk';
import { GAP_CHUNK_CHARS, GAP_CHUNK_OVERLAP } from '@/gaps/constants';
import { speechTextOf } from '@/gaps/window';

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
    for (const chunk of chunkSpeech(speech(400), {
      budget: 200,
      overlap: 40,
    })) {
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

describe('chunkSegments', () => {
  const seg = (i: number, len = 100) => ({
    startMs: i * 1000,
    endMs: (i + 1) * 1000,
    text: String(i % 10).repeat(len),
  });

  it('returns one chunk spanning all segments when they fit the budget', () => {
    const segments = [seg(0, 20), seg(1, 20), seg(2, 20)];
    expect(chunkSegments(segments, { budget: 500, overlap: 50 })).toEqual([
      { startMs: 0, endMs: 3000, text: speechTextOf(segments) },
    ]);
  });

  it('packs whole segments with overlap and keeps their times', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i));
    const chunks = chunkSegments(segments, { budget: 350, overlap: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(350);
    chunks.forEach((chunk, n) => {
      const inside = segments.filter((s) => s.startMs >= chunk.startMs && s.endMs <= chunk.endMs);
      expect(chunk.text).toBe(speechTextOf(inside));
      if (n > 0) {
        const prev = chunks[n - 1];
        expect(chunk.startMs).toBeLessThan(prev.endMs);
        expect(chunk.startMs).toBeGreaterThan(prev.startMs);
      }
    });
    expect(chunks[0].startMs).toBe(0);
    expect(chunks.at(-1)?.endMs).toBe(10000);
  });

  it('splits one oversized segment into pieces that keep its span', () => {
    const chunks = chunkSegments([{ startMs: 5000, endMs: 9000, text: 'word '.repeat(200) }], {
      budget: 300,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
      expect(chunk.startMs).toBe(5000);
      expect(chunk.endMs).toBe(9000);
    }
  });

  it('skips empty segments and returns [] for no input', () => {
    expect(chunkSegments([])).toEqual([]);
    expect(
      chunkSegments([
        { startMs: 0, endMs: 1, text: '' },
        { startMs: 1, endMs: 2, text: '  ' },
      ]),
    ).toEqual([]);
  });
});
