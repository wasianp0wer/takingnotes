import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGapPageMarkdown,
  formatOffset,
  quoteRange,
  submitGapReview,
} from '@/gaps/gapPage';
import { subscribePagesChanged } from '@/notes/pageChanges';
import { createGap, getGap } from '@/storage/gaps';
import type { CreateGapInput } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, listPages } from '@/storage/pages';
import { createRecording } from '@/storage/recordings';
import type { GapSuggestionRecord, RecordingRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

function rec(over: Partial<RecordingRecord> = {}): RecordingRecord {
  return {
    id: 'r1',
    sessionId: null,
    noteId: null,
    title: 'Lecture 4',
    startedAt: 1_000_000,
    endedAt: null,
    durationMs: 0,
    mimeType: 'audio/webm',
    byteLength: 0,
    transcript: null,
    ...over,
  };
}

function gap(over: Partial<GapSuggestionRecord> = {}): GapSuggestionRecord {
  return {
    id: 'g',
    noteId: 'n',
    pageId: 'p',
    recordingId: 'r1',
    fromMs: 1_000_000,
    toMs: 1_060_000,
    text: 'Point.',
    kind: 'missing',
    sourceQuote: 'quote',
    status: 'proposed',
    model: 'm',
    promptVersion: 'v',
    summarized: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as GapSuggestionRecord;
}

describe('formatOffset', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_600_000)).toBe('1:00:00');
    expect(formatOffset(3_725_000)).toBe('1:02:05');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatOffset(-5000)).toBe('0:00');
  });
});

describe('quoteRange', () => {
  it('uses the quote offsets when present', () => {
    expect(quoteRange(gap({ quoteStartMs: 5000, quoteEndMs: 9000 }), rec())).toEqual({
      startMs: 5000,
      endMs: 9000,
    });
  });

  it('falls back to the page window relative to the recording, clamped to 0', () => {
    expect(quoteRange(gap({ fromMs: 1_010_000, toMs: 1_030_000 }), rec())).toEqual({
      startMs: 10_000,
      endMs: 30_000,
    });
    expect(quoteRange(gap({ fromMs: 900_000, toMs: 950_000 }), rec())).toEqual({
      startMs: 0,
      endMs: 0,
    });
  });
});

describe('buildGapPageMarkdown', () => {
  it('orders by quote start and formats exactly', () => {
    const recording = rec();
    const second = gap({
      id: 'b',
      text: 'Second point.',
      sourceQuote: 'second quote',
      quoteStartMs: 750_000,
      quoteEndMs: 768_000,
    });
    const first = gap({
      id: 'a',
      text: 'First point.',
      sourceQuote: 'first quote',
      quoteStartMs: 5000,
      quoteEndMs: 9000,
    });
    expect(
      buildGapPageMarkdown([
        { gap: second, recording },
        { gap: first, recording },
      ]),
    ).toBe(
      [
        '## From the recording',
        '',
        '- **First point.**',
        '  > first quote',
        '  — Lecture 4, 0:05–0:09',
        '',
        '- **Second point.**',
        '  > second quote',
        '  — Lecture 4, 12:30–12:48',
      ].join('\n'),
    );
  });

  it('orders by recording startedAt first', () => {
    const early = rec({ id: 'r1', title: 'Early', startedAt: 1000 });
    const late = rec({ id: 'r2', title: 'Late', startedAt: 2000 });
    const md = buildGapPageMarkdown([
      { gap: gap({ text: 'L', quoteStartMs: 0, quoteEndMs: 1000 }), recording: late },
      { gap: gap({ text: 'E', quoteStartMs: 90_000, quoteEndMs: 91_000 }), recording: early },
    ]);
    expect(md.indexOf('Early')).toBeLessThan(md.indexOf('Late'));
  });
});

describe('submitGapReview', () => {
  async function seed() {
    const note = await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 1,
      source: 'ink',
      strokes: [],
    });
    const recording = await createRecording(
      { title: 'Lecture 4', durationMs: 1000, startedAt: 1_000_000, endedAt: 1_001_000 },
      new Blob([], { type: 'audio/webm' }),
    );
    const base: Omit<CreateGapInput, 'text'> = {
      noteId: note.id,
      pageId: page.id,
      recordingId: recording.id,
      fromMs: 1_000_000,
      toMs: 1_060_000,
      kind: 'missing',
      sourceQuote: 'q',
      model: 'm',
      promptVersion: 'v',
    };
    const g1 = await createGap({ ...base, text: 'Accepted point', quoteStartMs: 1000, quoteEndMs: 2000 });
    const g2 = await createGap({ ...base, text: 'Rejected point' });
    const g3 = await createGap({ ...base, text: 'Undecided point' });
    return { note, g1, g2, g3 };
  }

  it('updates statuses, appends a typed page and notifies', async () => {
    const { note, g1, g2, g3 } = await seed();
    const listener = vi.fn();
    const off = subscribePagesChanged(listener);
    const result = await submitGapReview(
      note.id,
      new Map([
        [g1.id, 'accepted'],
        [g2.id, 'rejected'],
      ]),
    );
    off();
    expect((await getGap(g1.id))?.status).toBe('accepted');
    expect((await getGap(g2.id))?.status).toBe('rejected');
    expect((await getGap(g3.id))?.status).toBe('proposed');
    const pages = await listPages(note.id);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.pageIndex).toBe(1);
    expect(pages[1]?.source).toBe('typed');
    expect(pages[1]?.text).toContain('Accepted point');
    expect(pages[1]?.text).not.toContain('Rejected point');
    expect(result?.id).toBe(pages[1]?.id);
    expect(listener).toHaveBeenCalledWith(note.id);
  });

  it('creates no page when nothing is accepted', async () => {
    const { note, g2 } = await seed();
    const listener = vi.fn();
    const off = subscribePagesChanged(listener);
    const result = await submitGapReview(note.id, new Map([[g2.id, 'rejected']]));
    off();
    expect(result).toBeNull();
    expect((await getGap(g2.id))?.status).toBe('rejected');
    expect(await listPages(note.id)).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
