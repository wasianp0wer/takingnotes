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
  };
}

function corpusOf(notes: SearchNote[]): SearchCorpus {
  return { notes, recordings: [], recordingOwner: new Map() };
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

  it('makes zero generator calls for an empty corpus', async () => {
    const corpus = corpusOf([]);
    const gen = createFakeTextGenerator();
    const result = await runSmartSearch('anything', corpus, { generator: gen, model: 'm' });
    expect(gen.calls.length).toBe(0);
    expect(result).toEqual({ strong: [], moderate: [], weak: [], unsummarizedCount: 0 });
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

  it('propagates a screen-call rejection (an unreachable host) rather than swallowing it', async () => {
    const corpus = corpusOf([makeSearchNote('a', 's')]);
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://localhost:11434: fetch failed');
    await expect(runSmartSearch('q', corpus, { generator: gen, model: 'm' })).rejects.toThrow(
      /Could not reach Ollama/,
    );
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
