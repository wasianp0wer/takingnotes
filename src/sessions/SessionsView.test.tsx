// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TranscriptionQueue as AudioTranscriptionQueue,
  TranscriptionQueueState,
} from '@/audio/transcriptionQueue';
import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import type { NamingQueue } from '@/notes/naming/queue';
import { resetNamingQueueForTests } from '@/notes/naming/startNaming';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import { PAGE_TRANSCRIBING_MESSAGE } from '@/notes/TranscriptPanel';
import { SessionsUiProvider } from '@/sessions/SessionsUiContext';
import { SessionsView } from '@/sessions/SessionsView';
import { createSessionsUiStore, SESSIONS_UI_STORAGE_KEY } from '@/sessions/sessionsUiStore';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';
import { useLiveFollow } from '@/sessions/useLiveFollow';
import { getDraft, resetAllDrafts, setDraftChoice } from '@/gaps/reviewDraft';
import { createGap } from '@/storage/gaps';
import { createNote, getNote, setNoteSummary } from '@/storage/notes';
import { createPage, getPage, listPages, setPageTranscript } from '@/storage/pages';
import { createRecording, getRecording, setRecordingTranscript } from '@/storage/recordings';
import type { NoteRecord, PageRecord, RecordingRecord, TranscriptStatus } from '@/storage/types';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;
let fake: FakeDeviceController;
let queue: FakeQueue;
let audioQueue: FakeAudioQueue;
let store: SessionsUiStore;

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let ink: { calls: string[] };

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

type FakeQueue = TranscriptionQueue & { retry: ReturnType<typeof vi.fn> };

function createFakeQueue(): FakeQueue {
  return {
    start: vi.fn(async () => {}),
    enqueue: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    subscribe: () => () => {},
    idle: vi.fn(async () => {}),
    stop: vi.fn(),
  } as FakeQueue;
}

interface FakeNamingQueue extends NamingQueue {
  emit: (noteId: string) => void;
}

function createFakeNamingQueue(): FakeNamingQueue {
  const listeners = new Set<(noteId: string) => void>();
  return {
    start: vi.fn(async () => {}),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    idle: vi.fn(async () => {}),
    stop: vi.fn(),
    emit: (noteId) => {
      for (const fn of listeners) fn(noteId);
    },
  };
}

type FakeAudioQueue = AudioTranscriptionQueue;

function createFakeAudioQueue(): FakeAudioQueue {
  const state: TranscriptionQueueState = {
    activeId: null,
    stage: null,
    progress: null,
    passes: null,
    completedMs: null,
    durationMs: null,
    queuedIds: [],
  };
  return {
    enqueue: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    getState: () => state,
    subscribe: () => () => {},
    subscribeChanges: () => () => {},
    whenIdle: vi.fn(async () => {}),
  } as unknown as FakeAudioQueue;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetResumeLockForTests();
  resetNamingQueueForTests();
  ink = { calls: [] };
  const record = (name: string) => () => {
    ink.calls.push(name);
  };
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    arc: record('arc'),
    fill: record('fill'),
  })) as never;
  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${counter++}`);
  URL.revokeObjectURL = vi.fn();
  window.confirm = () => true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fake = createFakeDeviceController();
  engine = createCaptureEngine({ controller: fake });
  queue = createFakeQueue();
  audioQueue = createFakeAudioQueue();
  store = createSessionsUiStore(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

/** Mirrors `AppShell`: the store above the view, plus the live-capture follow. */
function Harness({ namingQueue }: { namingQueue: NamingQueue }) {
  useLiveFollow(store);
  return <SessionsView queue={queue} namingQueue={namingQueue} audioQueue={audioQueue} />;
}

async function render(
  opts: { withEngine?: LiveCaptureEngine; namingQueue?: NamingQueue } = {},
): Promise<void> {
  const namingQueue = opts.namingQueue ?? createFakeNamingQueue();
  await act(async () => {
    root.render(
      <CaptureProvider engine={opts.withEngine ?? engine}>
        <SessionsUiProvider store={store}>
          <Harness namingQueue={namingQueue} />
        </SessionsUiProvider>
      </CaptureProvider>,
    );
  });
  await settle();
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.textContent?.trim() === text);
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function entryButton(noteId: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `aside button[data-entry-key="note:${noteId}"]`,
  );
  if (!found) throw new Error(`no sidebar entry for note ${noteId}`);
  return found;
}

/** The key of the entry the sidebar marks as selected. */
function selectedEntryKey(): string | null {
  return (
    container.querySelector('aside button[aria-current="true"]')?.getAttribute('data-entry-key') ??
    null
  );
}

/** The header's Resume (the only one outside the header is the interrupted notice, not mounted here). */
function headerResume(): HTMLButtonElement | undefined {
  return findButtonByText('Resume');
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

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function transcript(
  status: TranscriptStatus,
  fields: { markdown?: string; error?: string | null } = {},
) {
  return {
    markdown: fields.markdown ?? '',
    model: 'gemma4:12b',
    promptVersion: 'gemma-v1',
    status,
    error: fields.error ?? null,
    updatedAt: 1_700_000_000_000,
  };
}

function seedNote(overrides: Partial<Parameters<typeof createNote>[0]> = {}): Promise<NoteRecord> {
  return createNote({
    title: 'Seminar notes',
    deviceId: 'huion',
    pageBaseline: 0,
    pageWidth: 1409,
    pageHeight: 1869,
    status: 'complete',
    sessionId: `s-${Math.random()}`,
    ...overrides,
  });
}

function seedPage(
  noteId: string,
  pageIndex: number,
  overrides: Partial<Parameters<typeof createPage>[0]> = {},
): Promise<PageRecord> {
  return createPage({
    noteId,
    pageIndex,
    devicePageNum: pageIndex + 1,
    source: 'live',
    strokes: [
      {
        points: [
          { x: 0.1, y: 0.1, pressure: 0.5, t: 10 },
          { x: 0.2, y: 0.3, pressure: 0.6, t: 20 },
        ],
        startedAt: 10,
        endedAt: 20,
      },
    ],
    finalizedAt: 1_000 + pageIndex,
    ...overrides,
  });
}

function seedRecording(
  overrides: Partial<Parameters<typeof createRecording>[0]> = {},
): Promise<RecordingRecord> {
  const startedAt = overrides.startedAt ?? 1000;
  const durationMs = overrides.durationMs ?? 65_000;
  return createRecording(
    { title: 'Recording', durationMs, startedAt, endedAt: startedAt + durationMs, ...overrides },
    new Blob(['audio-bytes'], { type: 'audio/webm' }),
  );
}

async function startSession(withEngine: LiveCaptureEngine = engine): Promise<string> {
  await act(async () => {
    await withEngine.startSession();
  });
  await settle();
  const id = withEngine.getState().activeNoteId;
  if (id === null) throw new Error('no active note after startSession');
  return id;
}

describe('SessionsView', () => {
  it('with no stored selection, selects the active note, else the newest session', async () => {
    const older = await seedNote({ title: 'Older session', startedAt: 1_000 });
    const newest = await seedNote({ title: 'Newest session', startedAt: 2_000 });
    // Newer than both sessions, but uncategorized: sessions come first.
    await seedNote({ title: 'Loose note', startedAt: 3_000, sessionId: null });

    await render();
    expect(selectedEntryKey()).toBe(`note:${newest.id}`);
    expect(store.getState().selectedKey).toBe(`note:${newest.id}`);

    act(() => root.unmount());
    root = createRoot(container);
    // Active before the view mounts, as when a session is already running.
    await act(async () => {
      await engine.resumeNote(older.id);
    });
    store = createSessionsUiStore(null);
    await render();
    expect(selectedEntryKey()).toBe(`note:${older.id}`);
    expect(store.getState().selectedKey).toBe(`note:${older.id}`);
  });

  it('a restored selection naming a deleted note falls back quietly', async () => {
    await seedNote({ title: 'Older session', startedAt: 1_000 });
    const newest = await seedNote({ title: 'Newest session', startedAt: 2_000 });
    for (const stale of ['note:deleted-id', 'recording:gone', 'garbage-without-prefix']) {
      const storage = memoryStorage();
      storage.setItem(
        SESSIONS_UI_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          selectedKey: stale,
          pageIndex: 3,
          recordingId: 'gone',
          notesMode: 'handwriting',
        }),
      );
      store = createSessionsUiStore(storage);
      await render();

      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(selectedEntryKey()).toBe(`note:${newest.id}`);
      expect(store.getState().selectedKey).toBe(`note:${newest.id}`);
      expect(store.getState().pageIndex).toBe(0);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('an empty library shows the empty state', async () => {
    await render();

    expect(container.textContent).toContain('No sessions yet');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // New note and the page-turn controls stay reachable from the empty state.
    expect(findButtonByText('New note')).toBeDefined();
    expect(findButtonByText('New page')).toBeDefined();
  });

  it('notes and audio for one session render side by side', async () => {
    const note = await seedNote({ title: 'Lecture', sessionId: 's1' });
    await seedPage(note.id, 0);
    await seedRecording({ title: 'Lecture audio', sessionId: 's1', noteId: note.id });
    await render();
    // Sessions open on the transcript by default; show the ink for this check.
    await click(container.querySelector<HTMLElement>('[role="switch"]')!);

    const notes = container.querySelector('[data-half="notes"]')!;
    const audio = container.querySelector('[data-half="audio"]')!;
    expect(notes).not.toBeNull();
    expect(audio).not.toBeNull();
    expect(notes.parentElement).toBe(audio.parentElement);
    const row = notes.parentElement!.className.split(/\s+/);
    expect(row).toContain('flex');
    expect(row).not.toContain('flex-col');
    expect(notes.className.split(/\s+/)).toContain('flex-1');
    expect(audio.className.split(/\s+/)).toContain('flex-1');
    // Each half is framed by a border in the theme's border colour.
    for (const half of [notes, audio]) {
      expect(half.className.split(/\s+/)).toEqual(expect.arrayContaining(['border', 'border-border']));
    }
    expect(notes.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notes.querySelector('canvas')).not.toBeNull();
    expect(audio.querySelector('audio')).not.toBeNull();
    expect(audio.textContent).toContain('Recording 1 of 1');
  });

  it('the writing-destination banner shows while a locked session writes elsewhere', async () => {
    const lastWeek = await seedNote({ title: 'Last week', startedAt: 1_000 });
    await render();

    const activeId = await startSession();
    const activeNote = await getNote(activeId);
    expect(selectedEntryKey()).toBe(`note:${activeId}`);

    await click(entryButton(lastWeek.id));

    expect(container.textContent).toContain(`Writing still goes to "${activeNote!.title}"`);
    // Names the *active* note, not the one being viewed.
    expect(container.textContent).not.toContain('Writing still goes to "Last week"');
  });

  it('a just-started session with no finished pages or recordings renders both halves without error', async () => {
    // An older session in the library: losing the just-started selection to
    // the fallback would land here.
    const older = await seedNote({ title: 'Older session', startedAt: 1_000 });
    await seedPage(older.id, 0);
    const errors = vi.spyOn(console, 'error');
    await render();
    const activeId = await startSession();

    expect(selectedEntryKey()).toBe(`note:${activeId}`);
    expect(container.querySelector('[data-half="notes"]')).not.toBeNull();
    expect(container.querySelector('[data-half="audio"]')).not.toBeNull();
    expect(container.querySelector('[data-half="audio"] audio')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(findButtonByText('New page')).toBeDefined();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a persisted Transcription mode gives way to the live canvas when capture starts', async () => {
    const storage = memoryStorage();
    storage.setItem(
      SESSIONS_UI_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedKey: null,
        pageIndex: 0,
        recordingId: null,
        notesMode: 'transcription',
      }),
    );
    store = createSessionsUiStore(storage);
    await render();
    expect(store.getState().notesMode).toBe('transcription');

    await startSession();

    expect(store.getState().notesMode).toBe('handwriting');
    expect(container.querySelector('[data-half="notes"] canvas')).not.toBeNull();
    expect(container.textContent).not.toContain(PAGE_TRANSCRIBING_MESSAGE);
  });

  it('openRecording from the store seeks the player', async () => {
    const note = await seedNote({ title: 'Lecture', sessionId: 's1', startedAt: 1_000 });
    await seedNote({ title: 'Newer', startedAt: 2_000 });
    await seedRecording({ title: 'First', sessionId: 's1', noteId: note.id, startedAt: 1_000 });
    const second = await seedRecording({
      title: 'Second',
      sessionId: 's1',
      noteId: note.id,
      startedAt: 2_000,
    });
    await render();
    expect(selectedEntryKey()).not.toBe(`note:${note.id}`);

    await act(async () => {
      store.openRecording(second.id, 42_000, note.id);
    });
    await settle();

    expect(selectedEntryKey()).toBe(`note:${note.id}`);
    expect(container.textContent).toContain('Recording 2 of 2');
    const audio = container.querySelector('[data-half="audio"] audio') as HTMLAudioElement;
    expect(audio.currentTime).toBe(42);
    // Applied once: the request is cleared, so a re-render never re-seeks.
    expect(store.getState().seek).toBeNull();
  });
});

describe('SessionsView (ported from NotesView and RecordingsView)', () => {
  it("a gap's time selects its recording and seeks it, keeping the viewed page and the review draft", async () => {
    resetAllDrafts();
    const note = await seedNote({ title: 'Lecture', sessionId: 's1', startedAt: 1_000 });
    await seedRecording({ title: 'First', sessionId: 's1', noteId: note.id, startedAt: 1_000 });
    const second = await seedRecording({
      title: 'Second',
      sessionId: 's1',
      noteId: note.id,
      startedAt: 2_000,
    });
    await seedPage(note.id, 0);
    const page = await seedPage(note.id, 1);
    await setPageTranscript(page.id, transcript('done', { markdown: 'Page two notes.' }));
    const gapInput = {
      noteId: note.id,
      pageId: page.id,
      recordingId: second.id,
      fromMs: 2_000,
      toMs: 60_000,
      kind: 'claim' as const,
      model: 'gemma4:12b',
      promptVersion: 'gap-compare-gemma-v1',
    };
    const gap = await createGap({
      ...gapInput,
      text: 'The treaty was signed in 1919.',
      sourceQuote: 'signed in 1919',
      quoteStartMs: 42_000,
      quoteEndMs: 47_000,
    });
    const other = await createGap({ ...gapInput, text: 'Another point.', sourceQuote: 'another' });
    setDraftChoice(note.id, other, 'rejected');
    store.selectEntry(`note:${note.id}`);
    store.goToPage(1);
    await render();
    expect(container.textContent).toContain('Recording 1 of 2');

    await click(buttonByText('Review suggestions (2)'));
    const time = document.body.querySelector<HTMLButtonElement>(
      `[data-gap-row="${gap.id}"] button[data-seek-ms]`,
    );
    expect(time?.textContent).toBe('0:42–0:47');
    await click(time!);

    expect(document.body.querySelector('[data-gap-row]')).toBeNull(); // the dialog closed
    expect(container.textContent).toContain('Recording 2 of 2');
    const audio = container.querySelector('[data-half="audio"] audio') as HTMLAudioElement;
    expect(audio.currentTime).toBe(42);
    expect(store.getState()).toMatchObject({ selectedKey: `note:${note.id}`, pageIndex: 1 });
    expect(getDraft(note.id).get(other.id)).toBe('rejected');
  });

  it("mounts F4's page-turn controls", async () => {
    await render();
    expect(findButtonByText('New page')).toBeDefined();
  });

  it('New note starts a note, selects it and marks it Live in the sidebar', async () => {
    await render();
    expect(engine.getState().activeNoteId).toBeNull();

    await click(buttonByText('New note'));

    const activeId = engine.getState().activeNoteId;
    expect(activeId).not.toBeNull();
    expect(selectedEntryKey()).toBe(`note:${activeId}`);
    expect(entryButton(activeId!).querySelector('[data-live]')?.textContent).toBe('Live');
  });

  it("holds the shared resume lock around New note's startNote(), disabling the header's Resume meanwhile", async () => {
    await seedNote({ title: 'Last week', startedAt: 1_000 });
    let release: (() => void) | null = null;
    const held = new Promise<string>((resolve) => {
      release = () => resolve('note-id');
    });
    const wrapped = { ...engine, startNote: () => held } as unknown as LiveCaptureEngine;
    await render({ withEngine: wrapped });
    expect(headerResume()?.disabled).toBe(false);

    await click(buttonByText('New note'));

    expect(headerResume()?.disabled).toBe(true);
    (release as (() => void) | null)?.();
    await settle();
  });

  it('shows a done transcript, navigates pages and retries a failed one', async () => {
    const note = await seedNote({ title: 'Lecture 3' });
    const page1 = await seedPage(note.id, 0);
    const page2 = await seedPage(note.id, 1);
    await setPageTranscript(page1.id, transcript('done', { markdown: 'Newton on motion' }));
    await setPageTranscript(
      page2.id,
      transcript('failed', { error: 'Ollama unreachable at http://localhost:11434' }),
    );
    store.setNotesMode('transcription');
    await render();

    expect(container.textContent).toContain('Newton on motion');
    expect(container.textContent).toContain('gemma4:12b');
    expect(container.textContent).toContain('Page 1 of 2');

    await click(buttonByLabel('Next page'));

    expect(store.getState().pageIndex).toBe(1);
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('Ollama unreachable at http://localhost:11434');

    await click(buttonByText('Retry'));

    expect(queue.retry).toHaveBeenCalledWith(page2.id);
  });

  it('offers Transcribe for a finalized page with no transcript', async () => {
    const note = await seedNote({ title: 'Untranscribed' });
    const page = await seedPage(note.id, 0);
    store.setNotesMode('transcription');
    await render();

    await click(buttonByText('Transcribe'));

    expect(queue.retry).toHaveBeenCalledWith(page.id);
  });

  it('renders a legacy page with null dims and points without timestamps', async () => {
    const note = await seedNote({
      title: 'Old notebook',
      deviceId: 'legacy',
      legacy: true,
      sessionId: null,
      pageWidth: null,
      pageHeight: null,
    });
    await seedPage(note.id, 0, {
      source: 'rom',
      devicePageNum: null,
      strokes: [
        { points: [{ x: 0.1, y: 0.2, pressure: 0.5 }, { x: 0.4, y: 0.5, pressure: 0.4 }] },
        { points: [{ x: 0.8, y: 0.8, pressure: 0.3 }] },
      ],
    });

    await render();
    await click(container.querySelector<HTMLElement>('[role="switch"]')!);

    expect(selectedEntryKey()).toBe(`note:${note.id}`);
    expect(container.textContent).toContain('Page 1 of 1');
    expect(ink.calls).toContain('lineTo');
    expect(ink.calls).toContain('arc');
    const canvas = container.querySelector('canvas');
    expect(canvas?.width).toBe(772);
    expect(canvas?.height).toBe(1024);
  });

  it('disables New note once a session is open (K15)', async () => {
    await render();
    expect(buttonByText('New note').disabled).toBe(false);

    await startSession();

    expect(buttonByText('New note').disabled).toBe(true);
  });

  it("tagging a note in the header adds the tag to the advanced filter's choices", async () => {
    await seedNote({ title: 'Needs a tag' });
    await render();

    const tagInput = container.querySelector<HTMLInputElement>('input[aria-label="Add a tag"]');
    if (!tagInput) throw new Error('no tag input');
    await type(tagInput, 'thesis');
    await click(buttonByText('Add tag'));
    await click(buttonByText('▸ Advanced filter'));

    const chip = [...container.querySelectorAll('aside button[aria-pressed]')].find(
      (b) => b.textContent?.trim() === 'thesis',
    );
    expect(chip).toBeDefined();
  });

  it('turns the blank first page into a typed page via Type page and saves what is typed into it', async () => {
    await render();
    await click(buttonByText('New note'));
    const blank = engine.getState().activePageId!;

    await click(buttonByText('Type page'));

    // Replaced in place: same page, same position, no empty page left behind.
    expect(engine.getState()).toMatchObject({ activePageId: blank, pageIndex: 0 });
    const activePageId = engine.getState().activePageId!;
    expect((await getPage(activePageId))?.source).toBe('typed');
    expect(await listPages(engine.getState().activeNoteId!)).toHaveLength(1);
    expect(store.getState().pageIndex).toBe(0);

    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, 'Newton: F=ma');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The real default debounce (500ms), proving the whole wiring once.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const saved = await getPage(activePageId);
    expect(saved?.text).toBe('Newton: F=ma');
    expect(saved?.transcript?.markdown).toBe('Newton: F=ma');
  });

  it('switches a blank typed page back to handwriting in place when the pen writes', async () => {
    await render();
    await click(buttonByText('New note'));
    await click(buttonByText('Type page'));
    const pageId = engine.getState().activePageId!;
    expect(container.querySelector('textarea')).not.toBeNull();

    await act(async () => {
      fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
      fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    });
    await act(async () => engine.flush());
    await settle();

    expect(engine.getState()).toMatchObject({ activePageId: pageId, pageIndex: 0 });
    expect((await getPage(pageId))?.source).toBe('live');
    // The view reloaded the page under its unchanged id: the editor is gone.
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('keeps typing that has not autosaved yet when the pen writes, opening a new page', async () => {
    await render();
    await click(buttonByText('New note'));
    await click(buttonByText('Type page'));
    const typedId = engine.getState().activePageId!;

    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, 'half a thought');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Well inside the 500ms debounce: nothing is in the database yet.
    expect((await getPage(typedId))?.text).toBe('');

    await act(async () => {
      fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
      fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    });
    await act(async () => engine.flush());
    await settle();

    const pages = await listPages(engine.getState().activeNoteId!);
    expect(pages.map((p) => p.source)).toEqual(['typed', 'live']);
    expect(pages[0]).toMatchObject({ id: typedId, text: 'half a thought' });
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('shows the transcribing message for the active, unfinalized live page', async () => {
    await render();
    await click(buttonByText('New note'));
    // Starting a note switches to Handwriting (live follow); switch back.
    await act(async () => store.setNotesMode('transcription'));
    await settle();

    expect(container.textContent).toContain(PAGE_TRANSCRIBING_MESSAGE);
  });

  it('does not show the transcribing message for the active typed page', async () => {
    await render();
    await click(buttonByText('New note'));
    // Starting a note switches to Handwriting (live follow); switch back.
    await act(async () => store.setNotesMode('transcription'));
    await settle();
    await click(buttonByText('Type page'));

    expect(container.textContent).not.toContain(PAGE_TRANSCRIBING_MESSAGE);
  });

  it("offers Resume on a finished note in the header and makes it active (K14)", async () => {
    await seedNote({ title: 'This week', startedAt: 2_000 });
    const lastWeek = await seedNote({ title: 'Last week', startedAt: 1_000 });
    await render();
    expect(engine.getState().activeNoteId).toBeNull();

    await click(entryButton(lastWeek.id));
    expect(headerResume()?.disabled).toBe(false);
    await click(headerResume()!);
    await act(async () => {
      await engine.flush();
    });

    expect(engine.getState().activeNoteId).toBe(lastWeek.id);
  });

  it('disables Resume on another note while a session is locked (K15)', async () => {
    const other = await seedNote({ title: 'Last week', startedAt: 1_000 });
    await render();
    const activeId = await startSession();
    expect(activeId).not.toBe(other.id);

    await click(entryButton(other.id));
    const resume = headerResume();
    expect(resume).toBeDefined();
    expect(resume!.disabled).toBe(true);

    await click(resume!);
    await act(async () => {
      await engine.flush();
    });
    expect(engine.getState().activeNoteId).toBe(activeId);
  });

  it('does not offer Resume on the active note itself', async () => {
    await render();
    await click(buttonByText('New note'));

    expect(headerResume()).toBeUndefined();
  });

  it('does not show the banner while viewing the active note itself', async () => {
    await render();
    await startSession();

    expect(container.textContent).not.toContain('Writing still goes to');
  });

  it('does not show the banner when no session is open', async () => {
    const lastWeek = await seedNote({ title: 'Last week', startedAt: 1_000 });
    await seedNote({ title: 'This week', startedAt: 2_000 });
    await render();
    await click(entryButton(lastWeek.id));

    expect(container.textContent).not.toContain('Writing still goes to');
  });

  it('does not show the banner for a bare, pen-started note (an active note with no locked session)', async () => {
    const lastWeek = await seedNote({ title: 'Last week', startedAt: 1_000 });
    const fake = createFakeDeviceController();
    const bareEngine = createCaptureEngine({ controller: fake });
    await render({ withEngine: bareEngine });

    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();
    expect(bareEngine.getState().activeNoteId).not.toBeNull();

    await click(entryButton(lastWeek.id));

    expect(container.textContent).not.toContain('Writing still goes to');
    bareEngine.dispose();
  });

  it('editing the title in the header updates the sidebar entry (K20)', async () => {
    const note = await seedNote({ title: 'Lecture 3' });
    await render();

    const titleButton = buttons().find(
      (b) => b.textContent?.trim() === 'Lecture 3' && !b.closest('aside'),
    );
    expect(titleButton).toBeDefined();
    await click(titleButton!);
    const titleInput = container.querySelector<HTMLInputElement>(
      'input:not([aria-label="Filter sessions"])',
    )!;
    await type(titleInput, 'The French Revolution');
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(entryButton(note.id).textContent).toContain('The French Revolution');
  });

  it('refreshes the sidebar and header when the naming queue announces a change', async () => {
    const note = await seedNote({ title: 'Note 1' });
    const namingQueue = createFakeNamingQueue();
    await render({ namingQueue });
    expect(container.textContent).toContain('Note 1');

    await setNoteSummary(note.id, {
      summary: 'Covers the three laws of motion.',
      model: 'gemma4:12b',
      promptVersion: 'naming-v1',
      title: 'Newton on motion',
    });
    await act(async () => {
      namingQueue.emit(note.id);
    });
    await settle();

    expect(container.textContent).toContain('Newton on motion');
    expect(container.textContent).not.toContain('Note 1');
  });

  it('deleting a recording removes it from storage and from the audio half', async () => {
    const note = await seedNote({ title: 'Lecture', sessionId: 's1' });
    const recording = await seedRecording({ title: 'DeleteMe', sessionId: 's1', noteId: note.id });
    await setRecordingTranscript(recording.id, {
      text: 'x',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    await render();
    expect(container.textContent).toContain('Recording 1 of 1');

    await click(buttonByLabel('Delete recording'));

    expect(await getRecording(recording.id)).toBeUndefined();
    expect(container.textContent).not.toContain('Recording 1 of 1');
    expect(container.querySelector('[data-half="audio"] audio')).toBeNull();
  });
});
