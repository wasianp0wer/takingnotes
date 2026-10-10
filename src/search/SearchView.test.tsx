import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { SearchView } from '@/search/SearchView';
import type { SmartSearchDeps } from '@/search/smartSearch';
import { createNote } from '@/storage/notes';
import { createPage, setPageTranscript } from '@/storage/pages';
import { createRecording, finalizeRecording, setRecordingTranscript } from '@/storage/recordings';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.textContent?.trim() === text);
}

function buttonByText(text: string): HTMLButtonElement {
  const found = findButtonByText(text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

function queryInput(): HTMLInputElement {
  const found = container.querySelector('input');
  if (!found) throw new Error('no query input');
  return found;
}

async function type(value: string): Promise<void> {
  const el = queryInput();
  await act(async () => {
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  // Fix round 3, I4: Find now recomputes from a debounced query
  // (FIND_DEBOUNCE_MS = 150 in SearchView.tsx) - a real, generous margin
  // past that so every existing `type()` call site keeps seeing Find's
  // result without having to know about the debounce itself.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

function render(props: Parameters<typeof SearchView>[0] = {}) {
  act(() => {
    root.render(<SearchView {...props} />);
  });
}

describe('SearchView', () => {
  it('renders the empty-library message and no Smart search button when there is nothing to search', async () => {
    render();
    await settle();
    expect(container.textContent).toContain('Nothing to search yet');
    expect(findButtonByText('Smart search')).toBeUndefined();
  });

  it('finds a note by title live, with no explicit submit', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(container.textContent).toContain('Thermodynamics');
  });

  it('clears Find results when the query is cleared', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(container.textContent).toContain('Thermodynamics');
    await type('');
    expect(container.querySelectorAll('li').length).toBe(0);
  });

  it('Smart search is disabled for a blank query and enabled once a query is typed', async () => {
    await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    expect(buttonByText('Smart search').disabled).toBe(true);
    await type('x');
    expect(buttonByText('Smart search').disabled).toBe(false);
  });

  it('renders Strong/Moderate/Weak from a smart search run, excluding a none band', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"it matches"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('Strong');
    expect(container.textContent).toContain('it matches');
  });

  it("does not render a 'none' band candidate anywhere", async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"none","reason":"unrelated"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).not.toContain('unrelated');
  });

  it('reports a totally unreachable host as "could not be checked", not a thrown error - and stays interactive (fix round 3, I2)', async () => {
    // Fix round 3, I2 changed the screen stage's failure handling: a
    // failed screen batch is now caught and counted (like a band
    // failure), not thrown - so a totally unreachable host surfaces via
    // uncheckedCount rather than a destructive error paragraph. See
    // smartSearch.test.ts's own test of this at the function level.
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://x: fetch failed');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('1 note could not be checked');
    expect(container.textContent).not.toContain('Could not reach Ollama');
    await type('still works');
    expect(queryInput().value).toBe('still works');
  });

  it('shows the "screened by title and page text or recording" line for a note with no summary but some page text', async () => {
    const note = await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 1,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(page.id, {
      markdown: 'some page text',
      model: 'gemma4',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('1 note has no');
    expect(container.textContent).toContain('page text or recording content instead');
    expect(container.textContent).not.toContain('screened by title alone');
  });

  it('shows the "screened by title alone" line for a note with no summary, no page text and no recording (fix round 3, I1)', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('1 note has neither page text nor a recording');
    expect(container.textContent).toContain('screened by title alone');
    // Must not also claim it was screened by page text - it was not.
    expect(container.textContent).not.toContain('page text or recording content instead');
  });

  it('reports both the hits it got and the count it could not check when some band calls fail', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    await createNote({ title: 'B', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1, 2]', '{"band":"strong","reason":"it matches"}']);
    let jsonCalls = 0;
    gen.onGenerate = (call) => {
      if (call.json) {
        jsonCalls++;
        if (jsonCalls === 3) throw new Error('boom');
      }
    };
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('it matches');
    expect(container.textContent).toContain('1 note could not be checked');
  });

  it("does not read as 'no matches' when every band call fails", async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]']);
    gen.onGenerate = (call) => {
      if (call.json && gen.calls.length > 1) throw new Error('every band call fails');
    };
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('1 note could not be checked');
  });

  it("a Find hit's Open button calls onOpenNotes with the note id and page for a note hit", async () => {
    const note = await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    await createPage({ noteId: note.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    const page1 = await createPage({
      noteId: note.id,
      pageIndex: 1,
      devicePageNum: 2,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(page1.id, {
      markdown: 'a distinctive phrase',
      model: 'gemma4',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    const onOpenNotes = vi.fn();
    const onOpenRecordings = vi.fn();
    render({ onOpenNotes, onOpenRecordings });
    await settle();
    await type('distinctive phrase');
    await click(buttonByText('Open'));
    // Page 1 (pageIndex 1), not page 0 - the hit names the actual matching page.
    expect(onOpenNotes).toHaveBeenCalledExactlyOnceWith(note.id, 1);
    expect(onOpenRecordings).not.toHaveBeenCalled();
  });

  it("a Find hit's Open button defaults to page 0 for a note-title hit, which names no specific page", async () => {
    const note = await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    const onOpenNotes = vi.fn();
    render({ onOpenNotes });
    await settle();
    await type('unique');
    await click(buttonByText('Open'));
    expect(onOpenNotes).toHaveBeenCalledExactlyOnceWith(note.id, 0);
  });

  it('a second press while a smart search run is in flight does not start a second run', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    const button = buttonByText('Smart search');
    await act(async () => {
      // Both dispatched synchronously, back to back, before either click
      // handler's first await has a chance to let React re-render and
      // disable the button - the worst case the `running` state alone
      // cannot cover, which is exactly what `runningRef` guards against.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    // One screen call, not two: a second run never started.
    expect(gen.calls.length).toBe(1);
  });

  it("a Find hit's Open button calls onOpenRecordings, not onOpenNotes, for an audio-segment hit", async () => {
    const recording = await createRecording(
      { title: 'Lecture audio', durationMs: 1000 },
      new Blob(['a']),
    );
    await finalizeRecording(recording.id, new Blob(['a']), { endedAt: 2, durationMs: 1000 });
    await setRecordingTranscript(recording.id, {
      text: 'no match here. mentions a very distinctive keyword here',
      segments: [
        { startMs: 0, endMs: 1000, text: 'no match here' },
        { startMs: 5000, endMs: 6000, text: 'mentions a very distinctive keyword here' },
      ],
      model: 'whisper',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    const onOpenNotes = vi.fn();
    const onOpenRecordings = vi.fn();
    render({ onOpenNotes, onOpenRecordings });
    await settle();
    await type('distinctive');
    expect(container.textContent).toContain('Lecture audio');
    await click(buttonByText('Open'));
    // The matching segment's own startMs (5000), not the recording's first.
    expect(onOpenRecordings).toHaveBeenCalledExactlyOnceWith(recording.id, 5000);
    expect(onOpenNotes).not.toHaveBeenCalled();
  });

  it("a smart-search hit's Open button opens the recording, not the note, when the note has no page text (fix round 3, C1)", async () => {
    const note = await createNote({ title: 'Lecture with no writing', deviceId: 'd', pageBaseline: 0 });
    const recording = await createRecording(
      { title: 'Audio only', noteId: note.id, durationMs: 1000 },
      new Blob(['a']),
    );
    await finalizeRecording(recording.id, new Blob(['a']), { endedAt: 2, durationMs: 1000 });
    await setRecordingTranscript(recording.id, {
      text: 'mentions entropy at length',
      segments: [],
      model: 'whisper',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"mentions entropy at length"}']);
    const onOpenNotes = vi.fn();
    const onOpenRecordings = vi.fn();
    render({ smartSearchDeps: { generator: gen, model: 'm' }, onOpenNotes, onOpenRecordings });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('Lecture with no writing');

    const strongSection = [...container.querySelectorAll('div')].find((d) =>
      d.textContent?.startsWith('Strong'),
    )!;
    const openButton = [...strongSection.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Open',
    )!;
    await click(openButton);
    expect(onOpenRecordings).toHaveBeenCalledExactlyOnceWith(recording.id);
    expect(onOpenNotes).not.toHaveBeenCalled();
  });

  it('clears a stale smart-search result when the query changes (fix round 3, I6)', async () => {
    await createNote({ title: 'Entropy Lecture', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"about entropy"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('about entropy');

    await type('osmosis');
    expect(container.textContent).not.toContain('about entropy');
    expect(container.textContent).not.toContain('Strong');
  });

  it('clears a smart-search error when the query changes', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('boom');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('could not be checked');

    await type('osmosis');
    expect(container.textContent).not.toContain('could not be checked');
  });

  it('shows a loading state, with the Search landmark already present, before the corpus has resolved (fix round 3, I5)', () => {
    render();
    // Deliberately no `await settle()` - this checks the render that
    // happens *before* loadSearchCorpus() has had a chance to resolve.
    expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
    expect(container.textContent).toContain('Loading');
  });

  it('does not search below MIN_QUERY_LENGTH, even in the UI (fix round 3, I4)', async () => {
    await createNote({ title: 'Anything', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('a');
    expect(container.textContent).not.toContain('Anything');
  });

  it('debounces Find: a hit is not yet shown immediately after typing, only once the debounce elapses (fix round 3, I4)', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();

    const input = queryInput();
    await act(async () => {
      nativeInputValueSetter.call(input, 'thermo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(); // flushes microtasks, but not the 150ms debounce timer
    expect(container.textContent).not.toContain('Thermodynamics');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(container.textContent).toContain('Thermodynamics');
  });

  // The test above also passes if `hits` is computed straight from `query`
  // (undebounced), because the surrounding block is separately gated on
  // `debouncedQuery.trim() !== ''` - while that gate is still empty, no
  // hits can show regardless of what `hits` itself was computed from. This
  // test forces `debouncedQuery` to be *non-empty but stale* (a completed,
  // older debounce cycle) at the moment `query` changes again, which is
  // the only state in which the two possible implementations disagree.
  it("debounces Find's own recompute, not just the surrounding block's visibility", async () => {
    await createNote({ title: 'Thermo Lecture', deviceId: 'd', pageBaseline: 0 });
    await createNote({ title: 'Wave Lecture', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();

    await type('thermo'); // type()'s own wait lets this debounce cycle complete
    expect(container.textContent).toContain('Thermo Lecture');

    const input = queryInput();
    await act(async () => {
      nativeInputValueSetter.call(input, 'wave');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(); // debouncedQuery is still 'thermo' here - a stale, non-empty value
    expect(container.textContent).toContain('Thermo Lecture');
    expect(container.textContent).not.toContain('Wave Lecture');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(container.textContent).toContain('Wave Lecture');
    expect(container.textContent).not.toContain('Thermo Lecture');
  });

  it('caps rendered Find hits and states the true total (fix round 3, I4)', async () => {
    for (let i = 0; i < 60; i += 1) {
      await createNote({ title: `Match ${i}`, deviceId: 'd', pageBaseline: 0 });
    }
    render();
    await settle();
    await type('match');
    expect(container.querySelectorAll('li').length).toBeLessThanOrEqual(51); // 50 hits + the "showing" line
    expect(container.textContent).toContain('Showing first 50 of 60 matches.');
  });

  it("aborts an in-flight smart search when the view unmounts, rather than letting it keep making calls (fix round 3, M2)", async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    let capturedSignal: AbortSignal | undefined;
    let callCount = 0;
    const hangingGenerator: SmartSearchDeps['generator'] = {
      generate: async () => '',
      generateJson: async (_prompt, opts) => {
        callCount += 1;
        capturedSignal = opts.signal;
        // Never resolves within the test - the point is to catch the
        // run mid-flight, not to let it finish.
        return new Promise(() => {});
      },
    };
    render({ smartSearchDeps: { generator: hangingGenerator, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));

    expect(callCount).toBe(1);
    expect(capturedSignal?.aborted).toBe(false);

    act(() => root.unmount());
    expect(capturedSignal?.aborted).toBe(true);

    // A fresh root so afterEach's own unmount is a harmless no-op.
    root = createRoot(container);
  });
});
