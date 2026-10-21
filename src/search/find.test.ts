import { describe, expect, it } from 'vitest';

import type { SearchCorpus, SearchNote, SearchPage } from '@/search/corpus';
import {
  collectFindCandidates,
  findInCorpus,
  hitsFromMatches,
  snippetAround,
} from '@/search/find';
import { firstMatches } from '@/search/matcher';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

/** A `SearchNote` with fix round 3's `audioText`/`primaryRecordingId` defaulted - Find does not read either. */
function makeSearchNote(note: NoteRecord, pages: SearchPage[] = []): SearchNote {
  return { note, pages, audioText: '', primaryRecordingId: null };
}

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

const EMPTY: SearchCorpus = {
  notes: [],
  recordings: [],
  recordingOwner: new Map(),
  partialTranscriptCount: 0,
};

describe('findInCorpus', () => {
  it('matches a note title, case-insensitively', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'Thermodynamics' }))],
    };
    const hits = findInCorpus(corpus, 'THERMO');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'note-title', noteId: 'n1', noteTitle: 'Thermodynamics' });
  });

  it('finds a note by its summary, and skips a null summary without throwing', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'n1', summary: 'Covers recursion and base cases.' })),
        makeSearchNote(makeNote({ id: 'n2', summary: null })),
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
        makeSearchNote(makeNote({ id: 'n1' }), [
          { pageId: 'p0', pageIndex: 0, isTyped: false, text: 'ink mentions osmosis' },
          { pageId: 'p1', pageIndex: 1, isTyped: true, text: 'typed mentions osmosis too' },
        ]),
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
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'Lecture' }))],
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
    partialTranscriptCount: 0,
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
    partialTranscriptCount: 0,
    };
    const hits = findInCorpus(corpus, 'gravity');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'audio-segment', noteId: null, noteTitle: null });
  });

  it('returns one hit per matching page, not one per note', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'n1' }), [
          { pageId: 'p0', pageIndex: 0, isTyped: false, text: 'first mentions gravity' },
          { pageId: 'p1', pageIndex: 1, isTyped: false, text: 'second mentions gravity too' },
        ]),
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
    partialTranscriptCount: 0,
    };
    expect(findInCorpus(corpus, 'gravity')).toHaveLength(1);
  });

  it('returns [] for a blank or whitespace-only query', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'Anything' }))],
    };
    expect(findInCorpus(corpus, '')).toEqual([]);
    expect(findInCorpus(corpus, '   ')).toEqual([]);
  });

  // Fix round 3, I4: a one-character query against a real library matches
  // too broadly to be useful, and on a semester-sized corpus is exactly
  // the "tens of thousands of segments" case named in review.
  it('returns [] for a query shorter than MIN_QUERY_LENGTH, even a non-blank one', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'Anything' }))],
    };
    expect(findInCorpus(corpus, 'a')).toEqual([]);
    expect(findInCorpus(corpus, ' a ')).toEqual([]);
  });

  it('matches once the query reaches MIN_QUERY_LENGTH', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'An' }))],
    };
    expect(findInCorpus(corpus, 'an')).toHaveLength(1);
  });

  // Fix round 3, I4: attributing an audio-segment hit to its owning note's
  // title must still pick the *right* note's title out of several, not
  // just "some" title - the fix hoisted this lookup into a map built once
  // rather than re-scanning `corpus.notes` per matching segment, and this
  // pins that the hoisting didn't lose the per-recording attribution.
  it('attributes an audio hit to the right note\'s title when the corpus has several notes', () => {
    const corpus: SearchCorpus = {
      notes: [
        makeSearchNote(makeNote({ id: 'n1', title: 'Wrong Note' })),
        makeSearchNote(makeNote({ id: 'n2', title: 'Right Note' })),
      ],
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
      recordingOwner: new Map([['r1', 'n2']]),
    partialTranscriptCount: 0,
    };
    const hits = findInCorpus(corpus, 'gravity');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ noteId: 'n2', noteTitle: 'Right Note' });
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

describe('Find and the corpus agree about which transcripts are real', () => {
  it('does not return segments from a failed transcript', () => {
    // ⚑ `corpus.ts` excludes a failed transcript from smart search as "a
    // stale attempt's leftovers". Find read the same row with no status gate
    // at all, so the two paths disagreed - and the ungated one was the one
    // with no warning attached.
    const recording = {
      id: 'r1',
      title: 'Lecture',
      transcript: {
        status: 'failed',
        error: 'boom',
        segments: [{ startMs: 0, endMs: 500, text: 'mitochondria' }],
        text: 'mitochondria',
      },
    } as unknown as RecordingRecord;
    const corpus: SearchCorpus = {
      notes: [],
      recordings: [recording],
      recordingOwner: new Map(),
      partialTranscriptCount: 1,
    };

    expect(findInCorpus(corpus, 'mitochondria')).toEqual([]);
  });

  it('still returns segments from a running transcript', () => {
    const recording = {
      id: 'r1',
      title: 'Lecture',
      transcript: {
        status: 'running',
        error: null,
        segments: [{ startMs: 0, endMs: 500, text: 'mitochondria' }],
        text: 'mitochondria',
      },
    } as unknown as RecordingRecord;
    const corpus: SearchCorpus = {
      notes: [],
      recordings: [recording],
      recordingOwner: new Map(),
      partialTranscriptCount: 1,
    };

    expect(findInCorpus(corpus, 'mitochondria')).toHaveLength(1);
  });
});

const recordingWith = (id: string, startedAt: number, text: string): RecordingRecord =>
  makeRecording({
    id,
    startedAt,
    transcript: {
      status: 'done',
      error: null,
      model: 'm',
      language: 'en',
      updatedAt: 0,
      segments: [{ startMs: 0, endMs: 500, text }],
      text,
    },
  });

describe('FindOptions', () => {
  it('regex: true finds page text and the snippet contains the matched word', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'n1' }), [
          { pageId: 'p1', pageIndex: 0, text: 'The Reconstruction era followed.', isTyped: true },
        ]),
      ],
    };
    const hits = findInCorpus(corpus, 'reconstr\\w+', { regex: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'page-text' });
    expect(hits[0].snippet).toContain('Reconstruction');
  });

  it('an invalid or unsafe regex returns [] without throwing', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'n1', title: 'aaaa' }))],
    };
    expect(findInCorpus(corpus, '[', { regex: true })).toEqual([]);
    expect(findInCorpus(corpus, '(a+)+$', { regex: true })).toEqual([]);
  });

  it('from/to exclude a note outside the range; an orphan audio hit is dated by recording.startedAt', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'old', title: 'topic old', startedAt: 100 })),
        makeSearchNote(makeNote({ id: 'new', title: 'topic new', startedAt: 500 })),
      ],
      recordings: [recordingWith('r-in', 500, 'topic spoken'), recordingWith('r-out', 100, 'topic spoken')],
    };
    const hits = findInCorpus(corpus, 'topic', { from: 400, to: 600 });
    expect(hits.map((h) => h.noteId ?? h.recordingId)).toEqual(['new', 'r-in']);
    // inclusive bounds
    expect(findInCorpus(corpus, 'topic', { from: 500, to: 500 })).toHaveLength(2);
  });

  it('tags excludes a note without the tag and every hit whose noteId is null', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'a', title: 'topic a', tags: ['hist'] })),
        makeSearchNote(makeNote({ id: 'b', title: 'topic b', tags: ['math'] })),
      ],
      recordings: [recordingWith('orphan', 0, 'topic spoken')],
    };
    const hits = findInCorpus(corpus, 'topic', { tags: ['hist'] });
    expect(hits.map((h) => h.noteId)).toEqual(['a']);
  });

  it('tagMode and decides between any and every tag', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [
        makeSearchNote(makeNote({ id: 'a', title: 'topic a', tags: ['hist'] })),
        makeSearchNote(makeNote({ id: 'b', title: 'topic b', tags: ['hist', 'math'] })),
      ],
    };
    expect(findInCorpus(corpus, 'topic', { tags: ['hist', 'math'] })).toHaveLength(2);
    expect(findInCorpus(corpus, 'topic', { tags: ['hist', 'math'], tagMode: 'and' }).map((h) => h.noteId)).toEqual(['b']);
  });

  it("sources: ['audio-segment'] returns only audio hits", () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'a', title: 'topic a' }))],
      recordings: [recordingWith('r1', 0, 'topic spoken')],
    };
    const hits = findInCorpus(corpus, 'topic', { sources: ['audio-segment'] });
    expect(hits.map((h) => h.source)).toEqual(['audio-segment']);
  });

  it('regex mode has no minimum length', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'a', title: 'xylophone' }))],
    };
    expect(findInCorpus(corpus, 'x', { regex: true })).toHaveLength(1);
    expect(findInCorpus(corpus, 'x')).toEqual([]);
  });

  it('no options behaves exactly as before', () => {
    const corpus: SearchCorpus = {
      ...EMPTY,
      notes: [makeSearchNote(makeNote({ id: 'a', title: 'topic a', summary: 'a topic' }))],
      recordings: [recordingWith('r1', 0, 'topic spoken')],
    };
    expect(findInCorpus(corpus, 'topic')).toEqual(findInCorpus(corpus, 'topic', {}));
    expect(findInCorpus(corpus, 'topic').length).toBe(3);
  });
});

describe('collectFindCandidates + hitsFromMatches', () => {
  const corpus: SearchCorpus = {
    ...EMPTY,
    notes: [
      makeSearchNote(
        makeNote({ id: 'a', title: 'topic a', summary: 'a topic', tags: ['hist'], startedAt: 500 }),
        [{ pageId: 'p1', pageIndex: 0, text: 'page about the topic', isTyped: false }],
      ),
      makeSearchNote(makeNote({ id: 'b', title: 'topic b', startedAt: 100 })),
    ],
    recordings: [recordingWith('r1', 500, 'topic spoken')],
  };

  /** What the advanced search does with the runner's answer, with the matching done in-thread. */
  function viaCandidates(pattern: string, options: Parameters<typeof findInCorpus>[2] = {}) {
    const candidates = collectFindCandidates(corpus, options);
    const r = firstMatches(pattern, candidates.map((c) => c.text));
    if (!r.ok) throw new Error(r.error);
    return hitsFromMatches(candidates, r.matches);
  }

  it('builds exactly the hits findInCorpus builds, in the same order', () => {
    expect(viaCandidates('top\\w+')).toEqual(findInCorpus(corpus, 'top\\w+', { regex: true }));
    expect(viaCandidates('top\\w+').length).toBe(5);
  });

  it('applies the date, tag and source filters before matching', () => {
    for (const options of [
      { from: 400 },
      { tags: ['hist'] },
      { sources: ['page-text', 'audio-segment'] as const },
    ]) {
      const opts = { ...options, sources: options.sources ? [...options.sources] : undefined };
      expect(viaCandidates('topic', opts)).toEqual(
        findInCorpus(corpus, 'topic', { ...opts, regex: true }),
      );
    }
    const kept = collectFindCandidates(corpus, { from: 400 });
    expect(kept.map((c) => c.hit.noteId ?? c.hit.recordingId)).toEqual(['a', 'a', 'a', 'r1']);
  });

  it('each hit carries its match range within the snippet, after the ellipsis and trimming', () => {
    const text = `${'filler '.repeat(20)}  The Reconstruction era`;
    const index = text.indexOf('Reconstruction');
    const candidates = [{ text, hit: { source: 'note-title' as const, noteId: 'n', noteTitle: 't' } }];
    const [hit] = hitsFromMatches(candidates, [{ index, length: 14 }]);
    expect(hit.snippet.startsWith('…')).toBe(true);
    const { start, length } = hit.highlight!;
    expect(hit.snippet.slice(start, start + length)).toBe('Reconstruction');

    // A match that spans trimmed whitespace is clamped to the visible text.
    const [edge] = hitsFromMatches([{ ...candidates[0], text: '   abc' }], [{ index: 0, length: 6 }]);
    expect(edge.snippet).toBe('abc');
    expect(edge.highlight).toEqual({ start: 0, length: 3 });
    // Trimmed leading whitespace shifts the range left.
    const [shifted] = hitsFromMatches([{ ...candidates[0], text: '   abc' }], [{ index: 4, length: 2 }]);
    expect(shifted.highlight).toEqual({ start: 1, length: 2 });
  });

  it('a null match is no hit', () => {
    const candidates = collectFindCandidates(corpus);
    expect(hitsFromMatches(candidates, candidates.map(() => null))).toEqual([]);
  });
});
