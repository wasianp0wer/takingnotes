import { describe, expect, it } from 'vitest';

import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import {
  DEFAULT_WINDOW_MS,
  WINDOW_OVERLAP_MS,
  mergeWindowSegments,
  planWindows,
} from '@/audio/windows';

/** Samples for a recording of `minutes` minutes at the target rate. */
function samplesFor(ms: number): number {
  return (ms / 1000) * TARGET_SAMPLE_RATE;
}

describe('planWindows', () => {
  it('returns exactly one window for a recording shorter than a window', () => {
    // ⚑ The failure this guards: a 40-second voice memo planning to zero
    // windows would be written `done` with an empty transcript - silent data
    // loss, and indistinguishable from a recording of silence.
    const total = samplesFor(40_000);

    const windows = planWindows(total, 0);

    expect(windows).toHaveLength(1);
    expect(windows[0].startSample).toBe(0);
    expect(windows[0].endSample).toBe(total);
    expect(windows[0].startMs).toBe(0);
    expect(windows[0].endMs).toBe(40_000);
  });

  it('covers the whole recording with no gap between window boundaries', () => {
    const totalMs = 20 * 60_000;

    const windows = planWindows(samplesFor(totalMs), 0);

    expect(windows[0].startMs).toBe(0);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].startMs).toBe(windows[i - 1].endMs);
    }
    expect(windows.at(-1)!.endMs).toBe(totalMs);
  });

  it('starts at the cursor when resuming partway through', () => {
    const windows = planWindows(samplesFor(20 * 60_000), 600_000);

    expect(windows[0].startMs).toBe(600_000);
    expect(windows.at(-1)!.endMs).toBe(20 * 60_000);
  });

  it('reads back lead-in context before a resumed boundary', () => {
    // Whisper needs audio before the boundary to transcribe the first words
    // after it; `startSample` is therefore earlier than `startMs`.
    const [first] = planWindows(samplesFor(20 * 60_000), 600_000);

    expect(first.startSample).toBe(samplesFor(600_000 - WINDOW_OVERLAP_MS));
    expect(first.startMs).toBe(600_000);
  });

  it('has no lead-in to read for the first window of a recording', () => {
    const [first] = planWindows(samplesFor(20 * 60_000), 0);

    expect(first.startSample).toBe(0);
  });

  it('returns no windows when the cursor is at or past the end', () => {
    const total = samplesFor(60_000);

    expect(planWindows(total, 60_000)).toEqual([]);
    expect(planWindows(total, 99_000)).toEqual([]);
  });

  it('returns no windows for an empty recording', () => {
    expect(planWindows(0, 0)).toEqual([]);
  });

  it('splits a long recording into windows of the configured length', () => {
    const windows = planWindows(samplesFor(3 * DEFAULT_WINDOW_MS), 0);

    expect(windows).toHaveLength(3);
    expect(windows[1].startMs).toBe(DEFAULT_WINDOW_MS);
  });

  it('honours a caller-supplied window length', () => {
    const windows = planWindows(samplesFor(300), 0, 100);

    expect(windows.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
    ]);
  });
});

describe('mergeWindowSegments', () => {
  it('drops incoming segments that fall before the cursor', () => {
    // The lead-in is deliberately re-transcribed for context, so its words
    // come back a second time; the cursor is what tells them apart.
    const existing = [{ startMs: 0, endMs: 1000, text: 'one' }];
    const incoming = [
      { startMs: 996_000, endMs: 999_000, text: 'lead-in repeat' },
      { startMs: 1_000_500, endMs: 1_002_000, text: 'new' },
    ];

    expect(mergeWindowSegments(existing, incoming, 1_000_000)).toEqual([
      { startMs: 0, endMs: 1000, text: 'one' },
      { startMs: 1_000_500, endMs: 1_002_000, text: 'new' },
    ]);
  });

  it('keeps a segment that starts exactly on the cursor', () => {
    const merged = mergeWindowSegments([], [{ startMs: 1000, endMs: 2000, text: 'on it' }], 1000);

    expect(merged).toHaveLength(1);
  });

  it('keeps everything for the first window', () => {
    const incoming = [{ startMs: 0, endMs: 500, text: 'first' }];

    expect(mergeWindowSegments([], incoming, 0)).toEqual(incoming);
  });

  it('does not mutate the array it was given', () => {
    const existing = [{ startMs: 0, endMs: 1000, text: 'one' }];

    mergeWindowSegments(existing, [{ startMs: 2000, endMs: 3000, text: 'two' }], 2000);

    expect(existing).toHaveLength(1);
  });
});
