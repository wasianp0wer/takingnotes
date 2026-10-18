import { describe, expect, it } from 'vitest';

import type { SearchCorpus, SearchNote } from '@/search/corpus';
import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { runSmartSearch } from '@/search/smartSearch';
import type { NoteRecord } from '@/storage/types';

function makeSearchNote(
  id: string,
  summary: string | null,
  pages: { pageIndex: number; text: string }[] = [],
  titleOverride?: string,
  audio: { text?: string; primaryRecordingId?: string | null } = {},
): SearchNote {
  const note: NoteRecord = {
    id,
    title: titleOverride ?? `Note ${id}`,
    status: 'complete',
    deviceId: 'd1',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 0,
    endedAt: 1,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId: null,
  };
  return {
    note,
    pages: pages.map((p) => ({ pageId: `${id}-${p.pageIndex}`, pageIndex: p.pageIndex, isTyped: false, text: p.text })),
    audioText: audio.text ?? '',
    primaryRecordingId: audio.primaryRecordingId ?? null,
  };
}

function corpusOf(notes: SearchNote[]): SearchCorpus {
  return { notes, recordings: [], recordingOwner: new Map(), partialTranscriptCount: 0 };
}

describe('runSmartSearch', () => {
  it('screens a note with a summary on that summary', async () => {
    const corpus = corpusOf([makeSearchNote('a', 'a short summary about recursion')]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"recursion"}']);
    await runSmartSearch('recursion', corpus, { generator: gen, model: 'gemma4:12b' });
    expect(gen.calls[0].prompt).toContain('a short summary about recursion');
  });

  it("screens a summary-less note on its title and page text instead (K46)", async () => {
    const corpus = corpusOf([
      makeSearchNote('a', null, [{ pageIndex: 0, text: 'recursion and base cases' }], 'Lecture 3'),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"recursion and base cases"}']);
    await runSmartSearch('recursion', corpus, { generator: gen, model: 'gemma4:12b' });
    expect(gen.calls[0].prompt).toContain('Lecture 3');
    expect(gen.calls[0].prompt).toContain('recursion and base cases');
  });

  it('counts exactly the summary === null notes, independent of what the screen returns', async () => {
    const corpus = corpusOf([
      makeSearchNote('a', null),
      makeSearchNote('b', 'has a summary'),
      makeSearchNote('c', null),
    ]);
    const gen = createFakeTextGenerator(['[]']);
    const result = await runSmartSearch('anything', corpus, { generator: gen, model: 'm' });
    expect(result.unsummarizedCount).toBe(2);
  });

  it('counts the same even when nothing is found', async () => {
    const corpus = corpusOf([makeSearchNote('a', null)]);
    const gen = createFakeTextGenerator(['[]']);
    const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
    expect(result.unsummarizedCount).toBe(1);
    expect(result.strong).toEqual([]);
    expect(result.moderate).toEqual([]);
    expect(result.weak).toEqual([]);
  });

  // Fix round 3, C1: smart search must read a note's recording transcript
  // too - the whole reason it exists is the query that shares no words
  // with the note, and a lecture spoken at length but barely written down
  // is the canonical case Find cannot help with either.
  it("feeds a note's recording transcript into the screen stage alongside its summary (C1)", async () => {
    const corpus = corpusOf([
      makeSearchNote('a', 'a short summary', [], undefined, { text: 'mentions entropy at length' }),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"entropy"}']);
    await runSmartSearch('entropy', corpus, { generator: gen, model: 'm' });
    expect(gen.calls[0].prompt).toContain('a short summary');
    expect(gen.calls[0].prompt).toContain('mentions entropy at length');
  });

  it("feeds a note's recording transcript into the K46 fallback when it has no summary and no page text (C1)", async () => {
    const corpus = corpusOf([
      makeSearchNote('a', null, [], 'Lecture 9', { text: 'mentions entropy at length' }),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"entropy"}']);
    await runSmartSearch('entropy', corpus, { generator: gen, model: 'm' });
    expect(gen.calls[0].prompt).toContain('Lecture 9');
    expect(gen.calls[0].prompt).toContain('mentions entropy at length');
  });

  it('feeds the full recording transcript (not just the screening gist) into the band stage', async () => {
    const corpus = corpusOf([
      makeSearchNote('a', 'short summary', [], undefined, {
        text: 'the full lecture transcript about entropy in detail',
      }),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"entropy"}']);
    await runSmartSearch('entropy', corpus, { generator: gen, model: 'm' });
    const bandPrompt = gen.calls[1].prompt;
    expect(bandPrompt).toContain('the full lecture transcript about entropy in detail');
  });

  it("a hit for a note with no page text offers its recording as the Open target instead of a page (C1's band-granularity ruling)", async () => {
    const corpus = corpusOf([
      makeSearchNote('a', null, [], 'Lecture 9', { text: 'entropy', primaryRecordingId: 'rec-1' }),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"entropy"}']);
    const result = await runSmartSearch('entropy', corpus, { generator: gen, model: 'm' });
    expect(result.strong[0].recordingId).toBe('rec-1');
  });

  it('a hit for a note that has page text keeps pointing at the note, even when it also has a recording', async () => {
    const corpus = corpusOf([
      makeSearchNote('a', null, [{ pageIndex: 0, text: 'some page text' }], 'Lecture 9', {
        text: 'entropy',
        primaryRecordingId: 'rec-1',
      }),
    ]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"entropy"}']);
    const result = await runSmartSearch('entropy', corpus, { generator: gen, model: 'm' });
    expect(result.strong[0].recordingId).toBeUndefined();
  });

  it('a hit for a note with no page text and no recording either has no recordingId (nothing honest to offer)', async () => {
    const corpus = corpusOf([makeSearchNote('a', 'a summary with no page text or recording')]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"r"}']);
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong[0].recordingId).toBeUndefined();
  });

  // Fix round 3, I1: the honest subset of unsummarizedCount with literally
  // nothing but a title - K46's fallback message must not claim these were
  // "screened by title and page text" when there was no page text either.
  describe('titleOnlyCount (I1)', () => {
    it('counts a summary-less note with no page text and no recording text', async () => {
      const corpus = corpusOf([makeSearchNote('a', null)]);
      const gen = createFakeTextGenerator(['[]']);
      const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
      expect(result.titleOnlyCount).toBe(1);
    });

    it('does not count a summary-less note that has page text', async () => {
      const corpus = corpusOf([
        makeSearchNote('a', null, [{ pageIndex: 0, text: 'something' }]),
      ]);
      const gen = createFakeTextGenerator(['[]']);
      const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
      expect(result.titleOnlyCount).toBe(0);
    });

    it('does not count a summary-less note that has only recording text', async () => {
      const corpus = corpusOf([makeSearchNote('a', null, [], undefined, { text: 'something' })]);
      const gen = createFakeTextGenerator(['[]']);
      const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
      expect(result.titleOnlyCount).toBe(0);
    });

    it('does not count a note that has a summary, however empty its page text and recording', async () => {
      const corpus = corpusOf([makeSearchNote('a', 'has a summary')]);
      const gen = createFakeTextGenerator(['[]']);
      const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
      expect(result.titleOnlyCount).toBe(0);
      expect(result.unsummarizedCount).toBe(0);
    });

    it('is always <= unsummarizedCount, and both are independent of what the screen stage returns', async () => {
      const corpus = corpusOf([
        makeSearchNote('a', null),
        makeSearchNote('b', null, [{ pageIndex: 0, text: 'has page text' }]),
        makeSearchNote('c', 'has a summary'),
      ]);
      const gen = createFakeTextGenerator(['[]']);
      const result = await runSmartSearch('x', corpus, { generator: gen, model: 'm' });
      expect(result.unsummarizedCount).toBe(2);
      expect(result.titleOnlyCount).toBe(1);
    });
  });

  it('makes zero generator calls for an empty corpus', async () => {
    const corpus = corpusOf([]);
    const gen = createFakeTextGenerator();
    const result = await runSmartSearch('anything', corpus, { generator: gen, model: 'm' });
    expect(gen.calls.length).toBe(0);
    expect(result).toEqual({
      strong: [],
      moderate: [],
      weak: [],
      unsummarizedCount: 0,
      titleOnlyCount: 0,
      uncheckedCount: 0,
    });
  });

  it('makes zero generator calls for a blank query', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's')]);
    const gen = createFakeTextGenerator();
    await runSmartSearch('   ', corpus, { generator: gen, model: 'm' });
    expect(gen.calls.length).toBe(0);
  });

  it('only the screened candidates get a band call', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2'), makeSearchNote('c', 's3')]);
    const gen = createFakeTextGenerator(['[2]', '{"band":"weak","reason":"r"}']);
    await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    // One screen call plus exactly one band call (for note b, index 2).
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[1].prompt).toContain('Note b');
  });

  it("excludes a candidate banded 'none' from every section", async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1')]);
    const gen = createFakeTextGenerator(['[1]', '{"band":"none","reason":"not related"}']);
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toEqual([]);
    expect(result.moderate).toEqual([]);
    expect(result.weak).toEqual([]);
  });

  it('places a hit into the matching band section', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator([
      '[1, 2]',
      '{"band":"strong","reason":"r1"}',
      '{"band":"weak","reason":"r2"}',
    ]);
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toHaveLength(1);
    expect(result.strong[0]).toMatchObject({ noteId: 'a', band: 'strong', reason: 'r1' });
    expect(result.weak).toHaveLength(1);
    expect(result.weak[0]).toMatchObject({ noteId: 'b', band: 'weak', reason: 'r2' });
  });

  it("fix round 3, I2: a failed screen batch is caught and counted into uncheckedCount, not thrown - 'the screen stage' is no longer one atomic call", async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://localhost:11434: fetch failed');
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toEqual([]);
    expect(result.moderate).toEqual([]);
    expect(result.weak).toEqual([]);
    // Both candidates were in the one (unbatched, small) screen call that
    // failed, so both count as unchecked.
    expect(result.uncheckedCount).toBe(2);
  });

  it('one failed screen batch does not stop a later batch in the same run from being screened and banded', async () => {
    // Seven notes, each with a full 1000-char summary (SCREEN_TEXT_MAX),
    // force two screen batches against the real SCREEN_BATCH_CHAR_BUDGET
    // (6000): 7 * ~1000+title > 6000.
    const notes = Array.from({ length: 7 }, (_, i) =>
      makeSearchNote(String(i + 1), 'x'.repeat(1000)),
    );
    const corpus = corpusOf(notes);
    const gen = createFakeTextGenerator();
    let screenCalls = 0;
    gen.onGenerate = (call) => {
      if (!call.json) return;
      const isScreenCall = call.prompt.includes('NOTES:');
      if (!isScreenCall) return; // a band call
      screenCalls++;
      if (screenCalls === 1) throw new Error('first batch unreachable');
    };
    gen.replies = ['[7]', '{"band":"strong","reason":"r"}'];

    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    // Batch 1 (notes 1-5, the first screen call) fails and all five count
    // as unchecked; batch 2 (notes 6-7) still ran, chose note 7, and it
    // was successfully banded.
    expect(result.uncheckedCount).toBe(5);
    expect(result.strong).toHaveLength(1);
    expect(result.strong[0].noteId).toBe('7');
  });

  it("drops only the candidate whose band call rejects; the other's result still comes back", async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator(['[1, 2]']);
    gen.replies.push('{"band":"strong","reason":"r1"}', '{"band":"strong","reason":"r2"}');
    let jsonCalls = 0;
    gen.onGenerate = (call) => {
      if (call.json) {
        jsonCalls++;
        // jsonCalls 1 = screen, 2 = band for note a, 3 = band for note b.
        if (jsonCalls === 2) throw new Error('boom');
      }
    };
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toHaveLength(1);
    expect(result.strong[0].noteId).toBe('b');
    // Fix round 1, Finding 2: the failed candidate is counted, not folded
    // into an indistinguishable "no match".
    expect(result.uncheckedCount).toBe(1);
  });

  it('a run where some band calls fail reports both the hits it got and the count it could not check', async () => {
    const corpus = corpusOf([
      makeSearchNote('a', 's1'),
      makeSearchNote('b', 's2'),
      makeSearchNote('c', 's3'),
    ]);
    const gen = createFakeTextGenerator(['[1, 2, 3]']);
    gen.replies.push(
      '{"band":"strong","reason":"r1"}',
      '{"band":"weak","reason":"r3"}',
    );
    let jsonCalls = 0;
    gen.onGenerate = (call) => {
      if (call.json) {
        jsonCalls++;
        // 1 = screen, 2 = band for a, 3 = band for b (fails), 4 = band for c.
        if (jsonCalls === 3) throw new Error('boom');
      }
    };
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toHaveLength(1);
    expect(result.weak).toHaveLength(1);
    expect(result.uncheckedCount).toBe(1);
  });

  it('a run where every band call fails reports zero hits and a non-zero uncheckedCount, not an indistinguishable empty result', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator(['[1, 2]']);
    gen.onGenerate = (call) => {
      if (call.json && gen.calls.length > 1) throw new Error('every band call fails');
    };
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toEqual([]);
    expect(result.moderate).toEqual([]);
    expect(result.weak).toEqual([]);
    // The two chosen candidates both failed to be checked at all - this
    // must not read the same as "both were checked and neither matched".
    expect(result.uncheckedCount).toBe(2);
  });

  it('runs band calls serially, never overlapping', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator(['[1, 2]', '{"band":"weak","reason":"r"}', '{"band":"weak","reason":"r"}']);
    let inFlight = 0;
    let overlapped = false;
    gen.onGenerate = async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight--;
    };
    await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(overlapped).toBe(false);
  });

  it('an already-aborted signal aborts before the screen call', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's')]);
    const gen = createFakeTextGenerator();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSmartSearch('q', corpus, { generator: gen, model: 'm' }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(gen.calls.length).toBe(0);
  });

  it('an abort arriving between band calls stops the loop and rethrows', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's1'), makeSearchNote('b', 's2')]);
    const gen = createFakeTextGenerator(['[1, 2]', '{"band":"weak","reason":"r"}', '{"band":"weak","reason":"r"}']);
    const controller = new AbortController();
    let jsonCalls = 0;
    gen.onGenerate = (call) => {
      if (call.json) {
        jsonCalls++;
        if (jsonCalls === 2) controller.abort();
      }
    };
    await expect(
      runSmartSearch('q', corpus, { generator: gen, model: 'm' }, { signal: controller.signal }),
    ).rejects.toThrow();
    // Only the screen call and the first band call happened - the second
    // candidate's band call never ran.
    expect(gen.calls.length).toBe(2);
  });
});
