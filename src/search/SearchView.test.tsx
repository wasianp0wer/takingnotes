import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { SearchView } from '@/search/SearchView';
import { createNote } from '@/storage/notes';
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

  it('shows a plain error string, and stays interactive, when the generator rejects', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://x: fetch failed');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('Could not reach Ollama');
    await type('still works');
    expect(queryInput().value).toBe('still works');
  });

  it('shows the unsummarizedCount line after a run over an all-null-summary library', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toMatch(/1 note.*no summary/);
  });

  it("a Find hit's Open button calls onOpenNotes for a note hit", async () => {
    await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    const onOpenNotes = vi.fn();
    const onOpenRecordings = vi.fn();
    render({ onOpenNotes, onOpenRecordings });
    await settle();
    await type('unique');
    await click(buttonByText('Open'));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
    expect(onOpenRecordings).not.toHaveBeenCalled();
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
      text: 'mentions a very distinctive keyword here',
      segments: [{ startMs: 0, endMs: 1000, text: 'mentions a very distinctive keyword here' }],
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
    expect(onOpenRecordings).toHaveBeenCalledTimes(1);
    expect(onOpenNotes).not.toHaveBeenCalled();
  });
});
