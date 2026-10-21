import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdvancedSearch } from '@/search/AdvancedSearch';
import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { firstMatches } from '@/search/matcher';
import { createRegexRunner, TIMEOUT_ERROR } from '@/search/regexRunner';
import type { RegexRunner, RegexRunResult } from '@/search/regexRunner';
import { SearchProvider } from '@/search/SearchContext';
import { createSearchStore, EMPTY_SEARCH_FILTERS } from '@/search/searchStore';
import type { SearchStore } from '@/search/searchStore';
import type { SmartSearchDeps } from '@/search/smartSearch';
import { SessionsUiProvider } from '@/sessions/SessionsUiContext';
import { createSessionsUiStore } from '@/sessions/sessionsUiStore';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';
import { createNote } from '@/storage/notes';
import { createPage, setPageTranscript } from '@/storage/pages';
import { createRecording, finalizeRecording, setRecordingTranscript } from '@/storage/recordings';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let search: SearchStore;
let sessions: SessionsUiStore;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  search = createSearchStore();
  search.openAdvanced();
  sessions = createSessionsUiStore(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Past FIND_DEBOUNCE_MS (150). */
async function waitForDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'));
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
  const found = document.body.querySelector<HTMLInputElement>('input[aria-label="Search query"]');
  if (!found) throw new Error('no query input');
  return found;
}

function byLabel<T extends HTMLElement>(label: string): T {
  const found = document.body.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`nothing labelled ${label}`);
  return found;
}

async function setInput(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function type(value: string): Promise<void> {
  await setInput(queryInput(), value);
  // Find recomputes from a debounced query (FIND_DEBOUNCE_MS = 150): a
  // generous margin past that so every call site sees Find's result.
  await waitForDebounce();
}

/** The overlay is a Radix Dialog, portalled to document.body: queries above read the page. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function render(props: Parameters<typeof AdvancedSearch>[0] = {}) {
  act(() => {
    root.render(
      <SessionsUiProvider store={sessions}>
        <SearchProvider store={search}>
          <AdvancedSearch {...props} />
        </SearchProvider>
      </SessionsUiProvider>,
    );
  });
}

/** The real runner, matching in-thread (the test runner has no Worker to give it). */
function inThreadRunner(): RegexRunner {
  return createRegexRunner({
    createExecutor: () => ({
      run: async (pattern, texts) => {
        const r = firstMatches(pattern, texts);
        if (!r.ok) throw new Error(r.error);
        return r.matches;
      },
      terminate: () => {},
    }),
  });
}

/** A runner whose runs resolve only when the test says so. */
function deferredRunner() {
  const calls: { pattern: string; texts: readonly string[]; resolve(r: RegexRunResult): void }[] = [];
  const runner: RegexRunner = {
    run: (pattern, texts) =>
      new Promise((resolve) => {
        calls.push({ pattern, texts, resolve });
      }),
    dispose: vi.fn(),
  };
  return { runner, calls };
}

async function seedPageText(title: string, text: string, startedAt?: number) {
  const note = await createNote({ title, deviceId: 'd', pageBaseline: 0, startedAt });
  const page = await createPage({
    noteId: note.id,
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [],
  });
  await setPageTranscript(page.id, {
    markdown: text,
    model: 'gemma4',
    promptVersion: 'gemma-v1',
    status: 'done',
    error: null,
    updatedAt: 1,
  });
  return note;
}

describe('AdvancedSearch', () => {
  it('renders nothing while advanced search is closed', async () => {
    search.closeAdvanced();
    render();
    await settle();
    expect(dialog()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('renders full screen over the app', async () => {
    render();
    await settle();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.getAttribute('aria-modal')).toBe('true');
    const classes = d!.className.split(/\s+/);
    expect(classes).toContain('fixed');
    expect(classes).toContain('inset-0');
    await click(buttonByText('Close'));
    expect(search.getState().advancedOpen).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('Escape closes the overlay', async () => {
    render();
    await settle();
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(search.getState().advancedOpen).toBe(false);
  });

  it('Escape closes the overlay while the corpus is still loading', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render();
    // Deliberately no settle: the corpus has not loaded, so there is no query input yet.
    expect(document.body.textContent).toContain('Loading');
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(search.getState().advancedOpen).toBe(false);
    opener.remove();
  });

  it('moves focus into the overlay, hides the app behind it, and returns focus to the opener on close', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    search.closeAdvanced();
    render();
    await settle();
    opener.focus();
    await act(async () => search.openAdvanced());
    await settle();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(queryInput());
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(opener.getAttribute('aria-hidden')).toBe('true');

    await click(buttonByText('Close'));
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(container.getAttribute('aria-hidden')).toBeNull();
    opener.remove();
  });

  it('renders the empty-library message and no Smart search button when there is nothing to search', async () => {
    render();
    await settle();
    expect(document.body.textContent).toContain('Nothing to search yet');
    expect(findButtonByText('Smart search')).toBeUndefined();
  });

  it('finds a note by title live, with no explicit submit', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(document.body.textContent).toContain('Thermodynamics');
    expect(document.body.querySelector('mark.bg-search-highlight')?.textContent).toBe('Thermo');
  });

  it('clears Find results when the query is cleared', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(document.body.textContent).toContain('Thermodynamics');
    await type('');
    expect(document.body.querySelectorAll('li').length).toBe(0);
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
    expect(document.body.textContent).toContain('Strong');
    expect(document.body.textContent).toContain('it matches');
  });

  it("does not render a 'none' band candidate anywhere", async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"none","reason":"unrelated"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).not.toContain('unrelated');
  });

  it('reports a totally unreachable host as "could not be checked", not a thrown error - and stays interactive (fix round 3, I2)', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://x: fetch failed');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('1 note could not be checked');
    expect(document.body.textContent).not.toContain('Could not reach Ollama');
    await type('still works');
    expect(queryInput().value).toBe('still works');
  });

  it('shows the "screened by title and page text or recording" line for a note with no summary but some page text', async () => {
    await seedPageText('A', 'some page text');
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('1 note has no');
    expect(document.body.textContent).toContain('page text or recording content instead');
    expect(document.body.textContent).not.toContain('screened by title alone');
  });

  it('shows the "screened by title alone" line for a note with no summary, no page text and no recording (fix round 3, I1)', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('1 note has neither page text nor a recording');
    expect(document.body.textContent).toContain('screened by title alone');
    expect(document.body.textContent).not.toContain('page text or recording content instead');
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
    expect(document.body.textContent).toContain('it matches');
    expect(document.body.textContent).toContain('1 note could not be checked');
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
    expect(document.body.textContent).toContain('1 note could not be checked');
  });

  it("a page-text Find hit's Open button opens that note at the matching page", async () => {
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
    const openNote = vi.spyOn(sessions, 'openNote');
    const openRecording = vi.spyOn(sessions, 'openRecording');
    render();
    await settle();
    await type('distinctive phrase');
    await click(buttonByText('Open'));
    // Page 1 (pageIndex 1), not page 0 - the hit names the actual matching page.
    expect(openNote).toHaveBeenCalledExactlyOnceWith(note.id, 1, 'transcription');
    expect(openRecording).not.toHaveBeenCalled();
  });

  it("a Find hit's Open button defaults to page 0 for a note-title hit, which names no specific page", async () => {
    const note = await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    const openNote = vi.spyOn(sessions, 'openNote');
    render();
    await settle();
    await type('unique');
    await click(buttonByText('Open'));
    expect(openNote).toHaveBeenCalledExactlyOnceWith(note.id, 0);
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
      // handler's first await lets React re-render and disable the button.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(gen.calls.length).toBe(1);
  });

  it("an audio-segment Find hit's Open button opens the recording at the matching segment", async () => {
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
    const openNote = vi.spyOn(sessions, 'openNote');
    const openRecording = vi.spyOn(sessions, 'openRecording');
    render();
    await settle();
    await type('distinctive');
    expect(document.body.textContent).toContain('Lecture audio');
    await click(buttonByText('Open'));
    // The matching segment's own startMs (5000), not the recording's first.
    expect(openRecording).toHaveBeenCalledExactlyOnceWith(recording.id, 5000, null);
    expect(openNote).not.toHaveBeenCalled();
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
    const openNote = vi.spyOn(sessions, 'openNote');
    const openRecording = vi.spyOn(sessions, 'openRecording');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('Lecture with no writing');

    const strongSection = [...document.body.querySelectorAll('div')].find((d) =>
      d.textContent?.startsWith('Strong'),
    )!;
    const openButton = [...strongSection.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Open',
    )!;
    await click(openButton);
    expect(openRecording).toHaveBeenCalledExactlyOnceWith(recording.id, undefined, note.id);
    expect(openNote).not.toHaveBeenCalled();
    expect(search.getState().advancedOpen).toBe(false);
  });

  it('labels a smart result with its own query once the query changes, rather than presenting it as the answer (fix round 3, I6)', async () => {
    await createNote({ title: 'Entropy Lecture', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"about entropy"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('about entropy');
    expect(document.body.textContent).not.toContain('Smart results for');

    await type('  entropy ');
    expect(document.body.textContent).not.toContain('Smart results for');

    await type('osmosis');
    expect(document.body.textContent).toContain('Smart results for "entropy"');
    expect(document.body.textContent).toContain('about entropy');
  });

  it('clears a smart-search error when the query changes', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    // Only an abort escapes runSmartSearch; any other failure is counted.
    gen.failWith = Object.assign(new Error('the run was stopped'), { name: 'AbortError' });
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('the run was stopped');

    await type('osmosis');
    expect(document.body.textContent).not.toContain('the run was stopped');
  });

  it('shows a loading state, inside the dialog, before the corpus has resolved (fix round 3, I5)', () => {
    render();
    // Deliberately no `await settle()`: the render before loadSearchCorpus() resolves.
    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain('Loading');
  });

  it('does not search below MIN_QUERY_LENGTH, even in the UI (fix round 3, I4)', async () => {
    await createNote({ title: 'Anything', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('a');
    expect(document.body.textContent).not.toContain('Anything');
  });

  it('debounces Find: a hit is not yet shown immediately after typing, only once the debounce elapses (fix round 3, I4)', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await setInput(queryInput(), 'thermo'); // flushes microtasks, not the 150ms timer
    expect(document.body.textContent).not.toContain('Thermodynamics');
    await waitForDebounce();
    expect(document.body.textContent).toContain('Thermodynamics');
  });

  // Forces the debounced query to be non-empty but stale when the query
  // changes again: the only state in which a debounced recompute and an
  // undebounced one disagree.
  it("debounces Find's own recompute, not just the surrounding block's visibility", async () => {
    await createNote({ title: 'Thermo Lecture', deviceId: 'd', pageBaseline: 0 });
    await createNote({ title: 'Wave Lecture', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(document.body.textContent).toContain('Thermo Lecture');

    await setInput(queryInput(), 'wave');
    expect(document.body.textContent).toContain('Thermo Lecture');
    expect(document.body.textContent).not.toContain('Wave Lecture');

    await waitForDebounce();
    expect(document.body.textContent).toContain('Wave Lecture');
    expect(document.body.textContent).not.toContain('Thermo Lecture');
  });

  it('caps rendered Find hits and states the true total (fix round 3, I4)', async () => {
    for (let i = 0; i < 60; i += 1) {
      await createNote({ title: `Match ${i}`, deviceId: 'd', pageBaseline: 0 });
    }
    render();
    await settle();
    await type('match');
    expect(document.body.querySelectorAll('li').length).toBeLessThanOrEqual(51); // 50 hits + the "showing" line
    expect(document.body.textContent).toContain('Showing first 50 of 60 matches.');
  });

  it('aborts an in-flight smart search when the overlay unmounts, rather than letting it keep making calls (fix round 3, M2)', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    let capturedSignal: AbortSignal | undefined;
    let callCount = 0;
    const hangingGenerator: SmartSearchDeps['generator'] = {
      generate: async () => '',
      generateJson: async (_prompt, opts) => {
        callCount += 1;
        capturedSignal = opts.signal;
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

  it('Find honours the regex switch', async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    render({ regexRunner: inThreadRunner() });
    await settle();
    await type('reconstr\\w+');
    expect(document.body.textContent).not.toContain('Reconstruction era');
    expect(document.body.textContent).toContain('No matches');

    await click(byLabel('Regex'));
    await settle();
    expect(search.getState().regex).toBe(true);
    expect(document.body.textContent).toContain('Reconstruction era');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    // Highlighted from the runner's match range, not by re-running the pattern.
    expect(document.body.querySelector('mark.bg-search-highlight')?.textContent).toBe('Reconstruction');
  });

  it('turning regex off drops its hits, so turning it back on shows none of them while the new run is pending', async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    const { runner, calls } = deferredRunner();
    search.setRegex(true);
    render({ regexRunner: runner });
    await settle();
    await type('reconstr\\w+');
    await act(async () => {
      calls[0].resolve({ ok: true, matches: [null, { index: 4, length: 14 }] });
    });
    await settle();
    expect(document.body.textContent).toContain('Reconstruction era');

    await click(byLabel('Regex'));
    expect(document.body.textContent).not.toContain('Reconstruction era');
    await click(byLabel('Regex'));
    expect(calls).toHaveLength(2);
    expect(document.body.textContent).toContain('Searching');
    expect(document.body.textContent).not.toContain('Reconstruction era');
  });

  it('Clear empties the query and drops the regex results', async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    const { runner, calls } = deferredRunner();
    search.setRegex(true);
    render({ regexRunner: runner });
    await settle();
    await type('reconstr\\w+');
    await act(async () => {
      calls[0].resolve({ ok: true, matches: [null, { index: 4, length: 14 }] });
    });
    await settle();
    expect(document.body.textContent).toContain('Reconstruction era');

    await click(buttonByText('Clear'));
    await waitForDebounce();
    expect(queryInput().value).toBe('');
    await click(byLabel('Regex'));
    await type('other');
    expect(calls).toHaveLength(2);
    expect(document.body.textContent).toContain('Searching');
    expect(document.body.textContent).not.toContain('Reconstruction era');
  });

  it('an invalid regex shows an inline error and keeps the previous results', async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    search.setRegex(true);
    render({ regexRunner: inThreadRunner() });
    await settle();
    await type('reconstr\\w+');
    expect(document.body.textContent).toContain('Reconstruction era');

    await type('reconstr[');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Invalid pattern');
    expect(document.body.textContent).toContain('Reconstruction era');
  });

  it('regex never runs on the main thread: Find sends the filtered texts to the runner and shows a pending state', async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    const { runner, calls } = deferredRunner();
    search.setRegex(true);
    render({ regexRunner: runner });
    await settle();
    await type('reconstr\\w+');
    expect(calls).toHaveLength(1);
    expect(calls[0].pattern).toBe('reconstr\\w+');
    expect(calls[0].texts).toEqual(['Lecture', 'The Reconstruction era followed.']);
    expect(document.body.textContent).toContain('Searching');
    expect(document.body.textContent).not.toContain('No matches');
    // Nothing is matched until the runner answers.
    expect(document.body.textContent).not.toContain('Reconstruction era');

    // The hits are the runner's: here it reports the title, not the page.
    await act(async () => {
      calls[0].resolve({ ok: true, matches: [{ index: 0, length: 7 }, null] });
    });
    await settle();
    expect(document.body.textContent).not.toContain('Searching');
    expect(document.body.textContent).toContain('Title — Lecture');
    expect(document.body.textContent).not.toContain('Reconstruction era');
  });

  it("a pattern that runs too long shows the runner's error and keeps the previous results", async () => {
    await seedPageText('Lecture', 'The Reconstruction era followed.');
    const { runner, calls } = deferredRunner();
    search.setRegex(true);
    render({ regexRunner: runner });
    await settle();
    await type('reconstr\\w+');
    await act(async () => {
      calls[0].resolve({ ok: true, matches: [null, { index: 4, length: 14 }] });
    });
    await settle();

    await type('slow');
    await act(async () => {
      calls[1].resolve({ ok: false, error: TIMEOUT_ERROR });
    });
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(TIMEOUT_ERROR);
    expect(document.body.textContent).toContain('Reconstruction era');
  });

  it('filters narrow Find', async () => {
    await seedPageText('Topic early', 'nothing here', new Date('2026-01-05T12:00:00').getTime());
    await seedPageText('Later', 'a topic page', new Date('2026-03-10T12:00:00').getTime());
    render();
    await settle();
    await type('topic');
    expect(document.body.textContent).toContain('Topic early');
    expect(document.body.textContent).toContain('a topic page');

    await setInput(byLabel<HTMLInputElement>('From date'), '2026-02-01');
    await waitForDebounce();
    expect(document.body.textContent).not.toContain('Topic early');
    expect(document.body.textContent).toContain('a topic page');

    await setInput(byLabel<HTMLInputElement>('From date'), '');
    await waitForDebounce();
    expect(document.body.textContent).toContain('Topic early');

    await click(byLabel('Pages'));
    await waitForDebounce();
    expect(search.getState().filters.sources).not.toContain('page-text');
    expect(document.body.textContent).toContain('Topic early');
    expect(document.body.textContent).not.toContain('a topic page');
  });

  it('filters and regex do not reach smart search', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0, startedAt: 1000 });
    await createNote({ title: 'B', deviceId: 'd', pageBaseline: 0, startedAt: 2000 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' }, regexRunner: inThreadRunner() });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    const plainPrompts = gen.calls.map((c) => c.prompt);
    expect(plainPrompts.length).toBeGreaterThan(0);

    await act(async () => {
      search.setFilters({
        ...EMPTY_SEARCH_FILTERS,
        from: '2030-01-01',
        tags: ['nothing'],
        sources: ['audio-segment'],
      });
      search.setRegex(true);
    });
    await waitForDebounce();
    await click(buttonByText('Smart search'));
    expect(gen.calls.map((c) => c.prompt).slice(plainPrompts.length)).toEqual(plainPrompts);
  });

  it('closing and reopening keeps the query, Find results and smart results without a second model call', async () => {
    await createNote({ title: 'Entropy Lecture', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"about entropy"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('entropy');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('about entropy');
    const callsBefore = gen.calls.length;

    await click(buttonByText('Close'));
    expect(dialog()).toBeNull();

    await act(async () => search.openAdvanced());
    await settle();
    expect(queryInput().value).toBe('entropy');
    expect(document.body.textContent).toContain('Entropy Lecture');
    expect(findButtonByText('Open')).toBeDefined();
    expect(document.body.textContent).toContain('about entropy');
    expect(gen.calls.length).toBe(callsBefore);
  });

  it('opening a hit closes the overlay and navigates', async () => {
    const note = await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('unique');
    await click(buttonByText('Open'));
    expect(search.getState().advancedOpen).toBe(false);
    expect(dialog()).toBeNull();
    expect(sessions.getState().tab).toBe('sessions');
    expect(sessions.getState().selectedKey).toContain(note.id);
  });
});

describe('the partial-transcript caveat', () => {
  /** A finished recording whose transcription stopped partway. */
  async function seedPartialRecording(title: string, text: string): Promise<void> {
    const recording = await createRecording(
      { title, startedAt: 1000, durationMs: 120_000 },
      new Blob(['a']),
    );
    await finalizeRecording(recording.id, new Blob(['a']), {
      endedAt: 121_000,
      durationMs: 120_000,
    });
    await setRecordingTranscript(recording.id, {
      text,
      segments: [{ startMs: 0, endMs: 1000, text }],
      model: 'whisper',
      language: 'en',
      status: 'running',
      error: null,
      completedMs: 40_000,
      updatedAt: 1,
    });
  }

  it('warns under Find results that some recordings are not fully transcribed', async () => {
    await seedPartialRecording('Lecture', 'mitochondria are the powerhouse');
    render();
    await settle();
    await type('mitochondria');
    expect(document.body.textContent).toContain('mitochondria are the powerhouse');
    expect(document.body.textContent).toContain('not fully transcribed');
  });

  it('warns alongside smart-search results too', async () => {
    await createNote({ title: 'Biology', deviceId: 'd', pageBaseline: 0 });
    await seedPartialRecording('Lecture', 'mitochondria are the powerhouse');
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"about cells"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('mitochondria');
    await click(buttonByText('Smart search'));
    expect(document.body.textContent).toContain('about cells');
    expect(document.body.textContent).toContain('not fully transcribed');
  });

  it('says nothing when every recording is fully transcribed', async () => {
    const recording = await createRecording(
      { title: 'Lecture', startedAt: 1000, durationMs: 1000 },
      new Blob(['a']),
    );
    await finalizeRecording(recording.id, new Blob(['a']), { endedAt: 2000, durationMs: 1000 });
    await setRecordingTranscript(recording.id, {
      text: 'mitochondria are the powerhouse',
      segments: [{ startMs: 0, endMs: 1000, text: 'mitochondria are the powerhouse' }],
      model: 'whisper',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    render();
    await settle();
    await type('mitochondria');
    expect(document.body.textContent).toContain('mitochondria are the powerhouse');
    expect(document.body.textContent).not.toContain('not fully transcribed');
  });

  it('says nothing before a query is typed', async () => {
    await seedPartialRecording('Lecture', 'mitochondria are the powerhouse');
    render();
    await settle();
    expect(document.body.textContent).not.toContain('not fully transcribed');
  });
});
