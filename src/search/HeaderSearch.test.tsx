// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchCorpus } from '@/search/corpus';
import { HeaderSearch } from '@/search/HeaderSearch';
import { SearchProvider } from '@/search/SearchContext';
import { createSearchStore } from '@/search/searchStore';
import type { SearchStore } from '@/search/searchStore';
import { SessionsUiProvider } from '@/sessions/SessionsUiContext';
import { createSessionsUiStore } from '@/sessions/sessionsUiStore';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';
import type { NoteRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let corpus: SearchCorpus;
vi.mock('@/search/corpus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/search/corpus')>()),
  loadSearchCorpus: () => Promise.resolve(corpus),
}));

const baseNote: NoteRecord = {
  id: 'n1',
  title: 'Seminar',
  status: 'complete',
  deviceId: 'huion',
  deviceType: 'huion',
  deviceName: null,
  startedAt: 1,
  endedAt: 2,
  pageBaseline: 0,
  pageWidth: null,
  pageHeight: null,
  summary: null,
  summaryModel: null,
  legacy: false,
  legacySourceId: null,
  sessionId: null,
  tags: [],
};

function makeCorpus(pageTexts: string[]): SearchCorpus {
  return {
    notes: [
      {
        note: baseNote,
        pages: pageTexts.map((text, i) => ({ pageId: `p${i}`, pageIndex: i, isTyped: false, text })),
        audioText: '',
        primaryRecordingId: null,
      },
    ],
    recordings: [],
    recordingOwner: new Map(),
    partialTranscriptCount: 0,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let search: SearchStore;
let sessions: SessionsUiStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  search = createSearchStore();
  sessions = createSessionsUiStore(null);
  corpus = makeCorpus(['the bureau met']);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <SessionsUiProvider store={sessions}>
        <SearchProvider store={search}>
          <HeaderSearch />
        </SearchProvider>
      </SessionsUiProvider>,
    );
  });
}

async function openBox(): Promise<HTMLInputElement> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Search"]')!.click();
  });
  return container.querySelector<HTMLInputElement>('input[aria-label="Quick search"]')!;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, k: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

const options = () => [...container.querySelectorAll('[role="option"]')];

describe('HeaderSearch', () => {
  it('reveals and focuses the input from the Search button', async () => {
    await mount();
    const input = await openBox();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('shows at most 8 option rows with source, session title and snippet', async () => {
    corpus = makeCorpus(Array.from({ length: 12 }, (_, i) => `page ${i} bureau text`));
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    const rows = options();
    expect(rows).toHaveLength(8);
    expect(rows[0]!.textContent).toContain('Page');
    expect(rows[0]!.textContent).toContain('Seminar');
    expect(rows[0]!.textContent).toContain('bureau text');
    expect(rows[0]!.querySelector('mark.bg-search-highlight')?.textContent).toBe('bureau');
  });

  it('the quick box is always plain text', async () => {
    search.setRegex(true);
    await mount();
    const input = await openBox();
    await type(input, 'b.reau');
    expect(options()).toHaveLength(0);
  });

  it('ArrowDown then Enter opens the highlighted hit and closes the dropdown', async () => {
    const openNote = vi.spyOn(sessions, 'openNote');
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    await key(input, 'ArrowDown');
    await key(input, 'Enter');
    expect(openNote).toHaveBeenCalledWith('n1', 0, 'transcription');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('Enter with nothing highlighted opens advanced search seeded with the query', async () => {
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    await key(input, 'Enter');
    expect(search.getState().advancedOpen).toBe(true);
    expect(search.getState().query).toBe('bureau');
  });

  it('the Open advanced search button does the same', async () => {
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open advanced search',
    )!;
    await act(async () => button.click());
    expect(search.getState().advancedOpen).toBe(true);
    expect(search.getState().query).toBe('bureau');
  });

  it('Escape closes the dropdown', async () => {
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await key(input, 'Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('shows no listbox below the minimum query length', async () => {
    await mount();
    const input = await openBox();
    await type(input, 'b');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('Escape collapses the box, and re-opening reloads the corpus', async () => {
    await mount();
    let input = await openBox();
    await type(input, 'bureau');
    expect(options()).toHaveLength(1);
    await key(input, 'Escape');
    expect(container.querySelector('input[aria-label="Quick search"]')).toBeNull();
    corpus = makeCorpus(['the bureau met', 'another bureau page']);
    input = await openBox();
    expect(options()).toHaveLength(2);
  });

  it('collapses when focus leaves the widget', async () => {
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.querySelector('input[aria-label="Quick search"]')).toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('points aria-activedescendant at the highlighted option', async () => {
    await mount();
    const input = await openBox();
    expect(input.getAttribute('aria-controls')).toBeNull();
    await type(input, 'bureau');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe('quick-search-results');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    await key(input, 'ArrowDown');
    const id = input.getAttribute('aria-activedescendant');
    expect(id).toBe('quick-search-opt-0');
    expect(options()[0]!.id).toBe(id);
  });

  it('clicking an option opens it', async () => {
    const openNote = vi.spyOn(sessions, 'openNote');
    await mount();
    const input = await openBox();
    await type(input, 'bureau');
    const row = options()[0]!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      (row as HTMLElement).click();
    });
    expect(openNote).toHaveBeenCalledWith('n1', 0, 'transcription');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
