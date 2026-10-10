import { describe, expect, it } from 'vitest';

import type { SearchCorpus } from '@/search/corpus';
import { findInCorpus, snippetAround } from '@/search/find';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

function makeNote(overrides: Partial<NoteRecord> & { id: string }): NoteRecord {
  return {
    title: 'Untitled',
    status: 'complete',
    deviceId: 'd1',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 0,
    endedAt: 1,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId: null,
    ...overrides,
  };
}

function makeRecording(overrides: Partial<RecordingRecord> & { id: string }): RecordingRecord {
  return {
    sessionId: null,
    noteId: null,
    title: 'Recording',
    startedAt: 0,
    endedAt: 1,
    durationMs: 1000,
    mimeType: 'audio/webm',
    byteLength: 10,
    transcript: null,
    ...overrides,
  };
}

const EMPTY: SearchCorpus = { notes: [], recordings: [], recordingOwner: new Map() };

describe('findInCorpus', () => {
  it('matches a note title, case-insensitively', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [{ note: makeNote({ id: 'n1', title: 'Thermodynamics' }), pages: [] }],
    };
    const hits = findInCorpus(corpus, 'THERMO');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'note-title', noteId: 'n1', noteTitle: 'Thermodynamics' });
  });

  it('finds a note by its summary, and skips a null summary without throwing', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        { note: makeNote({ id: 'n1', summary: 'Covers recursion and base cases.' }), pages: [] },
        { note: makeNote({ id: 'n2', summary: null }), pages: [] },
      ],
    };
    const hits = findInCorpus(corpus, 'recursion');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'note-summary', noteId: 'n1' });
  });

  it('matches page text for an ink page and a typed page, with isTyped set correctly', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        {
          note: makeNote({ id: 'n1' }),
          pages: [
            { pageId: 'p0', pageIndex: 0, isTyped: false, text: 'ink mentions osmosis' },
            { pageId: 'p1', pageIndex: 1, isTyped: true, text: 'typed mentions osmosis too' },
          ],
        },
      ],
    };
    const hits = findInCorpus(corpus, 'osmosis');
    expect(hits).toHaveLength(2);
    const ink = hits.find((h) => h.pageIndex === 0)!;
    const typed = hits.find((h) => h.pageIndex === 1)!;
    expect(ink).toMatchObject({ source: 'page-text', isTyped: false });
    expect(typed).toMatchObject({ source: 'page-text', isTyped: true });
  });

  it('matches an audio transcript segment and attributes it to the owning note', () => {
    const corpus: SearchCorpus = {
      notes: [{ note: makeNote({ id: 'n1', title: 'Lecture' }), pages: [] }],
      recordings: [
        makeRecording({
          id: 'r1',
          title: 'Recording 1',
          transcript: {
            text: 'full text',
            segments: [
              { startMs: 0, endMs: 1000, text: 'no match here' },
              { startMs: 1000, endMs: 2000, text: 'mentions entropy clearly' },
            ],
            model: 'whisper',
            language: 'en',
            status: 'done',
            error: null,
            updatedAt: 1,
          },
        }),
      ],
      recordingOwner: new Map([['r1', 'n1']]),
    };
    const hits = findInCorpus(corpus, 'entropy');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: 'audio-segment',
      noteId: 'n1',
      noteTitle: 'Lecture',
      recordingId: 'r1',
      recordingTitle: 'Recording 1',
      startMs: 1000,
    });
  });

  it('still produces an audio hit for a standalone recording with no owning note', () => {
    const corpus: SearchCorpus = {
      notes: [],
      recordings: [
        makeRecording({
          id: 'r1',
          transcript: {
            text: 'x',
            segments: [{ startMs: 0, endMs: 1000, text: 'mentions gravity' }],
            model: 'whisper',
            language: 'en',
            status: 'done',
            error: null,
            updatedAt: 1,
          },
        }),
      ],
      recordingOwner: new Map(),
    };
    const hits = findInCorpus(corpus, 'gravity');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'audio-segment', noteId: null, noteTitle: null });
  });

  it('returns one hit per matching page, not one per note', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        {
          note: makeNote({ id: 'n1' }),
          pages: [
            { pageId: 'p0', pageIndex: 0, isTyped: false, text: 'first mentions gravity' },
            { pageId: 'p1', pageIndex: 1, isTyped: false, text: 'second mentions gravity too' },
          ],
        },
      ],
    };
    expect(findInCorpus(corpus, 'gravity')).toHaveLength(2);
  });

  it('returns one hit per matching segment, not one per recording', () => {
    const corpus: SearchCorpus = {
      notes: [],
      recordings: [
        makeRecording({
          id: 'r1',
          transcript: {
            text: 'x',
            segments: [
              { startMs: 0, endMs: 1000, text: 'mentions gravity' },
              { startMs: 1000, endMs: 2000, text: 'no match' },
            ],
            model: 'whisper',
            language: 'en',
            status: 'done',
            error: null,
            updatedAt: 1,
          },
        }),
      ],
      recordingOwner: new Map(),
    };
    expect(findInCorpus(corpus, 'gravity')).toHaveLength(1);
  });

  it('returns [] for a blank or whitespace-only query', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [{ note: makeNote({ id: 'n1', title: 'Anything' }), pages: [] }],
    };
    expect(findInCorpus(corpus, '')).toEqual([]);
    expect(findInCorpus(corpus, '   ')).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('returns the text verbatim when shorter than the radius', () => {
    expect(snippetAround('short text', 'short')).toBe('short text');
  });

  it('truncates with ellipses on both sides when the match is in the middle of long text', () => {
    const text = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    const snippet = snippetAround(text, 'needle', 10);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('needle');
  });
});
