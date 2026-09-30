import { describe, expect, it } from 'vitest';

import { GAP_LEAD_MS, GAP_TRAIL_MS } from '@/gaps/constants';
import { segmentsInWindow, speechTextOf, speechWindowForPage } from '@/gaps/window';
import type {
  AudioTranscriptRecord,
  PageRecord,
  PageStroke,
  RecordingRecord,
  TranscriptSegment,
} from '@/storage/types';

function stroke(startedAt: number | undefined, endedAt: number | undefined, ts: Array<number | undefined> = []): PageStroke {
  return {
    points: ts.map((t) => ({ x: 0.5, y: 0.5, pressure: 1, ...(t === undefined ? {} : { t }) })),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page-1',
    noteId: 'note-1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [stroke(10_000, 12_000, [10_000, 12_000])],
    pointCount: 2,
    capturedAt: 10_000,
    render: null,
    transcript: null,
    finalizedAt: 20_000,
    ...overrides,
  };
}

function recording(segments: TranscriptSegment[] | null, startedAt = 1_000): RecordingRecord {
  const transcript: AudioTranscriptRecord | null =
    segments === null
      ? null
      : {
          text: segments.map((s) => s.text).join(' '),
          segments,
          model: 'Xenova/whisper-base.en',
          language: 'en',
          status: 'done',
          error: null,
          updatedAt: 0,
        };
  return {
    id: 'rec-1',
    sessionId: 'session-1',
    noteId: 'note-1',
    title: 'Recording',
    startedAt,
    endedAt: startedAt + 600_000,
    durationMs: 600_000,
    mimeType: 'audio/webm',
    byteLength: 10,
    transcript,
  };
}

describe('speechWindowForPage', () => {
  it('spans the first stroke to finalizedAt, widened by the default margins', () => {
    expect(speechWindowForPage(page())).toEqual({
      fromMs: 10_000 - GAP_LEAD_MS,
      toMs: 20_000 + GAP_TRAIL_MS,
    });
  });

  it('honours custom margins, including zero', () => {
    expect(speechWindowForPage(page(), { leadMs: 1_000, trailMs: 2_000 })).toEqual({
      fromMs: 9_000,
      toMs: 22_000,
    });
    expect(speechWindowForPage(page(), { leadMs: 0, trailMs: 0 })).toEqual({
      fromMs: 10_000,
      toMs: 20_000,
    });
  });

  it('falls back to point times when strokes carry no startedAt/endedAt', () => {
    const p = page({ strokes: [stroke(undefined, undefined, [5_000, 7_000])], finalizedAt: null });
    expect(speechWindowForPage(p, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 5_000, toMs: 7_000 });
  });

  it('ends at the last stroke when finalizedAt is null or absent', () => {
    const open = page({ finalizedAt: null });
    expect(speechWindowForPage(open, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 10_000, toMs: 12_000 });
    const legacy = page();
    delete legacy.finalizedAt;
    expect(speechWindowForPage(legacy, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 10_000, toMs: 12_000 });
  });

  it('is null when there is nothing timestamped to align against', () => {
    expect(speechWindowForPage(page({ strokes: [] }))).toBeNull();
    expect(speechWindowForPage(page({ strokes: [stroke(undefined, undefined, [])] }))).toBeNull();
    expect(
      speechWindowForPage(page({ strokes: [stroke(undefined, undefined, [undefined, undefined])] })),
    ).toBeNull();
  });

  it('is null when the stroke timestamps are not finite numbers', () => {
    // A NaN that survives into the window makes every segment comparison false,
    // so the page reads as "the recording said nothing here" instead of "there
    // is nothing to align against".
    const p = page({ strokes: [stroke(Number.NaN, Number.NaN, [undefined])] });
    expect(speechWindowForPage(p)).toBeNull();
    expect(speechWindowForPage(page({ strokes: [stroke(Infinity, Number.NaN)] }))).toBeNull();
  });

  it('uses the one timestamp a stroke carries when the other is missing', () => {
    const onlyStart = page({ strokes: [stroke(8_000, undefined)], finalizedAt: null });
    expect(speechWindowForPage(onlyStart, { leadMs: 0, trailMs: 0 })).toEqual({
      fromMs: 8_000,
      toMs: 8_000,
    });
    const onlyEnd = page({ strokes: [stroke(undefined, 9_000)], finalizedAt: null });
    expect(speechWindowForPage(onlyEnd, { leadMs: 0, trailMs: 0 })).toEqual({
      fromMs: 9_000,
      toMs: 9_000,
    });
  });

  it('takes the min and max across strokes stored out of order', () => {
    const p = page({
      strokes: [stroke(30_000, 31_000, [30_000]), stroke(4_000, 5_000, [4_000])],
      finalizedAt: null,
    });
    expect(speechWindowForPage(p, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 4_000, toMs: 31_000 });
  });
});

describe('segmentsInWindow', () => {
  const segs: TranscriptSegment[] = [
    { startMs: 0, endMs: 1_000, text: 'before' },
    { startMs: 4_000, endMs: 6_000, text: 'straddles the start' },
    { startMs: 7_000, endMs: 8_000, text: 'inside' },
    { startMs: 9_000, endMs: 12_000, text: 'straddles the end' },
    { startMs: 20_000, endMs: 21_000, text: 'after' },
  ];

  // startedAt 1000: window 6000..11000 absolute is 5000..10000 in offsets.
  it('keeps every overlapping segment and nothing else', () => {
    const kept = segmentsInWindow(recording(segs), 6_000, 11_000).map((s) => s.text);
    expect(kept).toEqual(['straddles the start', 'inside', 'straddles the end']);
  });

  it('keeps a segment that spans the whole window', () => {
    const spanning: TranscriptSegment[] = [{ startMs: 0, endMs: 100_000, text: 'all of it' }];
    expect(segmentsInWindow(recording(spanning), 6_000, 11_000)).toHaveLength(1);
  });

  it('includes a segment touching either boundary and excludes one a millisecond outside', () => {
    const touching: TranscriptSegment[] = [
      { startMs: 0, endMs: 5_000, text: 'ends at fromMs' },
      { startMs: 10_000, endMs: 30_000, text: 'starts at toMs' },
      { startMs: 0, endMs: 4_999, text: 'ends just before' },
      { startMs: 10_001, endMs: 30_000, text: 'starts just after' },
    ];
    const kept = segmentsInWindow(recording(touching), 6_000, 11_000).map((s) => s.text);
    expect(kept).toEqual(['ends at fromMs', 'starts at toMs']);
  });

  it('is empty when the recording has no transcript or no segments', () => {
    expect(segmentsInWindow(recording(null), 0, 1_000_000)).toEqual([]);
    expect(segmentsInWindow(recording([]), 0, 1_000_000)).toEqual([]);
  });

  it('returns segments in startMs order even when stored out of order', () => {
    const unordered: TranscriptSegment[] = [
      { startMs: 8_000, endMs: 9_000, text: 'second' },
      { startMs: 6_000, endMs: 7_000, text: 'first' },
    ];
    expect(segmentsInWindow(recording(unordered), 0, 1_000_000).map((s) => s.text)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('speechTextOf', () => {
  it('joins the text with single spaces, dropping the empty ones', () => {
    expect(
      speechTextOf([
        { startMs: 0, endMs: 1, text: ' one ' },
        { startMs: 1, endMs: 2, text: '   ' },
        { startMs: 2, endMs: 3, text: 'two' },
        { startMs: 3, endMs: 4, text: '' },
      ]),
    ).toBe('one two');
  });

  it('is empty for no segments', () => {
    expect(speechTextOf([])).toBe('');
  });
});
