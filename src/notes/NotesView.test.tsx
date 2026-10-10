import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import type { NamingQueue } from '@/notes/naming/queue';
import { resetNamingQueueForTests } from '@/notes/naming/startNaming';
import { NotesView } from '@/notes/NotesView';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import { PAGE_TRANSCRIBING_MESSAGE } from '@/notes/TranscriptPanel';
import { createNote, getNote, setNoteSummary, setNoteTags } from '@/storage/notes';
import { createPage, getPage, setPageTranscript } from '@/storage/pages';
import type { NoteRecord, PageRecord, TranscriptStatus } from '@/storage/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;
let queue: FakeQueue;

/** Records the ink drawing calls, so a real `drawStrokes` run is observable. */
interface InkSpy {
  calls: string[];
}

let ink: InkSpy;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

function createInkContext(spy: InkSpy): unknown {
  const record = (name: string) => () => {
    spy.calls.push(name);
  };
  return {
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

/**
 * A no-op naming queue. Every NotesView mount here must pass one: without
 * it, NotesView would build the real one via `ensureNamingQueue`, which
 * calls `fetch` against Ollama the moment any note in a test happens to be
 * eligible - the same reasoning the existing `queue` prop already follows
 * for the transcription queue.
 */
interface FakeNamingQueue extends NamingQueue {
  /** Lets a test fire the same event a real queue's `subscribe` would, after writing to storage itself. */
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

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetResumeLockForTests();
  resetNamingQueueForTests();
  ink = { calls: [] };
  // happy-dom has no canvas backend; a recording context lets the real
  // `drawStrokes` run so a bad stroke shape would still throw here.
  HTMLCanvasElement.prototype.getContext = (() => createInkContext(ink)) as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
  queue = createFakeQueue();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

/** Renders and lets the storage reads settle (fake-indexeddb resolves on timers). */
async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <NotesView queue={queue} namingQueue={createFakeNamingQueue()} />
      </CaptureProvider>,
    );
  });
  await settle();
}

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

/** The Resume button inside the sidebar row whose title is `noteTitle`. */
function resumeButtonForNote(noteTitle: string): HTMLButtonElement | undefined {
  const row = [...container.querySelectorAll('li')].find((li) =>
    li.textContent?.includes(noteTitle),
  );
  return [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Resume');
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

// React patches `HTMLInputElement.prototype.value` to track the value it last
// rendered; setting `el.value` directly goes through that patched setter, so
// React sees no change and never fires `onChange`. The native setter (grabbed
// before any patching) is what's needed to simulate real typing.
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

describe('NotesView', () => {
  it("renders F4's page-turn controls in the toolbar", async () => {
    await render();

    expect(findButtonByText('New page')).toBeDefined();
  });

  it('lists live and legacy notes, labelling the legacy one', async () => {
    await seedNote({ title: 'Live note', startedAt: 2_000 });
    await seedNote({
      title: 'Imported notebook',
      deviceId: 'legacy',
      legacy: true,
      startedAt: 1_000,
      pageWidth: null,
      pageHeight: null,
    });

    await render();

    expect(container.textContent).toContain('Live note');
    expect(container.textContent).toContain('Imported notebook');
    expect(container.textContent).toContain('Legacy');
  });

  it('starts a note on New note and shows it in the list', async () => {
    await render();
    expect(engine.getState().activeNoteId).toBeNull();

    await click(buttonByText('New note'));

    expect(engine.getState().activeNoteId).not.toBeNull();
    // The engine's default title is `Note <local date time>`.
    expect(container.textContent).toContain('Note ');
  });

  it("holds the shared resume lock around New note's own startNote() call, disabling Resume elsewhere meanwhile (fix round 1, Important 1, mirror)", async () => {
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    let release: (() => void) | null = null;
    const held = new Promise<string>((resolve) => {
      release = () => resolve('note-id');
    });
    const wrapped = { ...engine, startNote: () => held } as unknown as LiveCaptureEngine;
    await act(async () => {
      root.render(
        <CaptureProvider engine={wrapped}>
          <NotesView queue={queue} namingQueue={createFakeNamingQueue()} />
        </CaptureProvider>,
      );
    });
    await settle();

    await click(buttonByText('New note'));

    const resumeButton = resumeButtonForNote('Last week');
    expect(resumeButton).toBeDefined();
    expect(resumeButton!.disabled).toBe(true);

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

    await render();
    await click(buttonByText('Lecture 3'));

    expect(container.textContent).toContain('Newton on motion');
    expect(container.textContent).toContain('gemma4:12b');
    expect(container.textContent).toContain('Page 1 of 2');

    await click(buttonByLabel('Next page'));

    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('Ollama unreachable at http://localhost:11434');

    await click(buttonByText('Retry'));

    expect(queue.retry).toHaveBeenCalledWith(page2.id);
  });

  it('mounts the gap panel for the viewed page, beside the transcript', async () => {
    // P1's mount point (docs/architecture.md §6.7): the notes view is the only
    // place it appears, so nothing else may claim it.
    const note = await seedNote({ title: 'Lecture 4' });
    const page = await seedPage(note.id, 0);
    await setPageTranscript(page.id, transcript('done', { markdown: 'Kepler' }));

    await render();

    const gaps = container.querySelector('[aria-label="Gaps"]');
    expect(gaps?.getAttribute('data-note-id')).toBe(note.id);
    expect(gaps?.getAttribute('data-page-id')).toBe(page.id);
  });

  it('offers Transcribe for a finalized page with no transcript', async () => {
    const note = await seedNote({ title: 'Untranscribed' });
    const page = await seedPage(note.id, 0);

    await render();
    await click(buttonByText('Transcribe'));

    expect(queue.retry).toHaveBeenCalledWith(page.id);
  });

  it('renders a legacy page with null dims and points without timestamps', async () => {
    const note = await seedNote({
      title: 'Old notebook',
      deviceId: 'legacy',
      legacy: true,
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

    expect(container.textContent).toContain('Old notebook');
    expect(container.textContent).toContain('Page 1 of 1');
    // Drew the two-point stroke as a line and the single-point stroke as a dot,
    // at the A5 fallback aspect with a 1024 long edge.
    expect(ink.calls).toContain('lineTo');
    expect(ink.calls).toContain('arc');
    const canvas = container.querySelector('canvas');
    expect(canvas?.width).toBe(772);
    expect(canvas?.height).toBe(1024);
  });

  it('shows the empty state when there are no notes', async () => {
    await render();

    expect(container.textContent).toContain('No notes yet');
    expect(container.textContent).toContain('No note selected');
  });

  it('disables New note once a session is open (K15)', async () => {
    await render();

    expect(buttonByText('New note').disabled).toBe(false);

    await act(async () => {
      await engine.startSession();
    });
    await settle();

    expect(buttonByText('New note').disabled).toBe(true);
  });

  it('filters the sidebar by tag and keeps the active note visible (⚑)', async () => {
    const tagged = await seedNote({ title: 'Tagged seminar' });
    await setNoteTags(tagged.id, ['seminar']);
    await seedNote({ title: 'Untagged note' });

    await render();
    await click(buttonByText('New note')); // starts and activates a fresh, untagged note

    await click(buttonByText('seminar')); // the filter chip

    expect(container.textContent).toContain('Tagged seminar');
    expect(container.textContent).not.toContain('Untagged note');
    // The just-started note is untagged and would not match "seminar", but
    // it is the active note, so its row must still be present (⚑).
    expect(container.textContent).toContain('Note '); // engine default title prefix
    expect(container.textContent).toContain("doesn't match this filter");
  });

  it('tagging a note through the toolbar updates the sidebar vocabulary', async () => {
    await seedNote({ title: 'Needs a tag' });
    await render();
    await click(buttonByText('Needs a tag'));

    const tagInput = container.querySelector<HTMLInputElement>('input[aria-label="Add a tag"]');
    if (!tagInput) throw new Error('no tag input');
    await type(tagInput, 'thesis');
    await click(buttonByText('Add tag'));

    expect(container.textContent).toContain('thesis');
    // The filter bar's chip for the new tag.
    expect(buttonByText('thesis')).toBeTruthy();
  });

  it('disables "Type page" with no active note', async () => {
    await render();
    expect(buttonByText('Type page').disabled).toBe(true);
  });

  it('creates a typed page via "Type page" and lets it be typed into', async () => {
    await render();
    await click(buttonByText('New note'));

    await click(buttonByText('Type page'));

    expect(engine.getState().pageIndex).toBe(1);
    const activePageId = engine.getState().activePageId!;
    const activePage = await getPage(activePageId);
    expect(activePage?.source).toBe('typed');

    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, 'Newton: F=ma');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The real default debounce (500ms) - this is the one place it's worth
    // proving the full NotesView -> TypedPageEditor -> setPageText wiring
    // against it; TypedPageEditor.test.tsx covers the debounce logic itself
    // with a fast override.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const saved = await getPage(activePageId);
    expect(saved?.text).toBe('Newton: F=ma');
    expect(saved?.transcript?.markdown).toBe('Newton: F=ma');
  });

  it('shows the transcribing message for the active, unfinalized live page (fix round 2, Fix 4)', async () => {
    // The positive case the absence check below needs: without this, nothing
    // in the suite ever proves `PAGE_TRANSCRIBING_MESSAGE` shows up for the
    // live page it actually describes, so a change that silently stopped it
    // from ever rendering (for any page) would leave the typed-page test
    // below green regardless.
    await render();
    await click(buttonByText('New note'));

    expect(container.textContent).toContain(PAGE_TRANSCRIBING_MESSAGE);
  });

  it('does not show the "will be transcribed" message for the active typed page', async () => {
    await render();
    await click(buttonByText('New note'));
    await click(buttonByText('Type page'));

    expect(container.textContent).not.toContain(PAGE_TRANSCRIBING_MESSAGE);
  });

  it('offers Resume on a finished note and makes it active (K14)', async () => {
    await seedNote({ title: 'This week', status: 'complete', startedAt: 2_000 });
    const lastWeek = await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    await render();
    expect(engine.getState().activeNoteId).toBeNull();

    const resumeButton = resumeButtonForNote('Last week');
    expect(resumeButton).toBeDefined();
    expect(resumeButton!.disabled).toBe(false);

    await click(resumeButton!);
    await act(async () => {
      await engine.flush();
    });

    expect(engine.getState().activeNoteId).toBe(lastWeek.id);
  });

  it('disables Resume on another note while a session is locked (K15)', async () => {
    const other = await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    await render();

    await act(async () => {
      await engine.startSession();
    });
    await settle();
    const activeId = engine.getState().activeNoteId;
    expect(activeId).not.toBeNull();
    expect(activeId).not.toBe(other.id);

    const resumeButton = resumeButtonForNote('Last week');
    expect(resumeButton).toBeDefined();
    expect(resumeButton!.disabled).toBe(true);

    await click(resumeButton!);
    await act(async () => {
      await engine.flush();
    });

    // Disabled, so the click was a no-op: the session's own note is still active.
    expect(engine.getState().activeNoteId).toBe(activeId);
  });

  it('disables New note while a resume elsewhere is pending (fix round 1, Important 1)', async () => {
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    let release: (() => void) | null = null;
    const held = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('boom'));
    });
    const wrapped = { ...engine, resumeNote: () => held } as unknown as LiveCaptureEngine;
    await act(async () => {
      root.render(
        <CaptureProvider engine={wrapped}>
          <NotesView queue={queue} namingQueue={createFakeNamingQueue()} />
        </CaptureProvider>,
      );
    });
    await settle();

    const resumeButton = resumeButtonForNote('Last week');
    expect(resumeButton).toBeDefined();
    await click(resumeButton!);

    // sessionStartedAtOf(state) still reads null here (the wrapped
    // resumeNote never resolved, so no op has published state) - exactly
    // the architecture.md §8.3 window. Without the fix, New note would
    // still read enabled and could fall through to closeNote() against
    // the half-opened resume.
    expect(buttonByText('New note').disabled).toBe(true);

    (release as (() => void) | null)?.();
    await settle();

    expect(buttonByText('New note').disabled).toBe(false);
  });

  it('disables "Type page" while a resume elsewhere is pending (fix round 2, Fix 4)', async () => {
    // Unlike the New note test above, there's an active note here already -
    // otherwise `state.activeNoteId === null` alone would disable "Type
    // page" for an unrelated reason, and the assertion below would prove
    // nothing about the resume-lock gating this test exists to check.
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    let release: (() => void) | null = null;
    const held = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('boom'));
    });
    const wrapped = { ...engine, resumeNote: () => held } as unknown as LiveCaptureEngine;
    await act(async () => {
      root.render(
        <CaptureProvider engine={wrapped}>
          <NotesView queue={queue} namingQueue={createFakeNamingQueue()} />
        </CaptureProvider>,
      );
    });
    await settle();

    await click(buttonByText('New note'));
    expect(buttonByText('Type page').disabled).toBe(false);

    const resumeButton = resumeButtonForNote('Last week');
    expect(resumeButton).toBeDefined();
    await click(resumeButton!);

    // Same architecture.md §8.3 window the New note test above guards:
    // `resumeNote` never resolved, so this resume of a *different* note is
    // still in flight. "Type page" was previously the one mutating toolbar
    // control left ungated here.
    expect(buttonByText('Type page').disabled).toBe(true);

    (release as (() => void) | null)?.();
    await settle();

    expect(buttonByText('Type page').disabled).toBe(false);
  });

  it('does not offer Resume on the active note itself', async () => {
    await render();
    await click(buttonByText('New note'));

    expect(findButtonByText('Resume')).toBeUndefined();
  });

  it('shows "Writing still goes to" naming the active note when viewing a different one (K16)', async () => {
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    await render();

    await act(async () => {
      await engine.startSession();
    });
    await settle();
    const active = engine.getState().activeNoteId;
    expect(active).not.toBeNull();
    const activeNote = await getNote(active!);

    await click(buttonByText('Last week'));

    expect(container.textContent).toContain(`Writing still goes to "${activeNote!.title}"`);
    // Names the *active* note, not "Last week" (the one being viewed).
    expect(container.textContent).not.toContain('Writing still goes to "Last week"');
  });

  it('does not show the banner while viewing the active note itself', async () => {
    await render();
    await click(buttonByText('New note'));

    expect(container.textContent).not.toContain('Writing still goes to');
  });

  it('does not show the banner when no session is open', async () => {
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    await render();
    await click(buttonByText('Last week'));

    expect(container.textContent).not.toContain('Writing still goes to');
  });

  it('editing the title in the toolbar updates what the sidebar row shows (K20)', async () => {
    await seedNote({ title: 'Lecture 3' });
    await render();

    // Two "Lecture 3" buttons exist once K20 is wired - the sidebar's
    // select button (inside <aside>) and the toolbar's title editor.
    const titleButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Lecture 3' && !b.closest('aside'),
    );
    expect(titleButton).toBeDefined();

    await click(titleButton!);
    const titleInput = container.querySelector('input')!;
    expect(titleInput).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!
        .set!;
      setter.call(titleInput, 'The French Revolution');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    expect(container.textContent).toContain('The French Revolution');
    expect(
      [...container.querySelectorAll('li')].some((li) =>
        li.textContent?.includes('The French Revolution'),
      ),
    ).toBe(true);
  });

  it('refreshes the sidebar and toolbar when the naming queue announces a change (fix round 1, Important 5)', async () => {
    // Before the fix, nothing subscribed to NamingQueue.subscribe, so the
    // owner's third complaint (the timestamp title never changes) stayed
    // true even once naming worked - the sidebar only refreshed on capture
    // state or a transcript-status change, and naming finishes seconds
    // after whichever of those triggered it.
    const note = await seedNote({ title: 'Note 1', status: 'complete' });
    const namingQueue = createFakeNamingQueue();
    await act(async () => {
      root.render(
        <CaptureProvider engine={engine}>
          <NotesView queue={queue} namingQueue={namingQueue} />
        </CaptureProvider>,
      );
    });
    await settle();
    expect(container.textContent).toContain('Note 1');

    // What the real naming queue does to storage, then the one signal it
    // gives the rest of the app that something changed.
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

  it('does not show the banner for a bare, pen-started note (an active note with no locked session)', async () => {
    // Isolates the `sessionLocked` term from `activeNoteId !== null`: a pen
    // stroke with no session running makes a note active without ever
    // setting `sessionStartedAt` (A6), so the banner must still stay off even
    // though an active note now exists and a different one is being viewed.
    await seedNote({ title: 'Last week', status: 'complete', startedAt: 1_000 });
    const fake = createFakeDeviceController();
    const bareEngine = createCaptureEngine({ controller: fake });
    await act(async () => {
      root.render(
        <CaptureProvider engine={bareEngine}>
          <NotesView queue={queue} namingQueue={createFakeNamingQueue()} />
        </CaptureProvider>,
      );
    });
    await settle();

    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();
    expect(bareEngine.getState().activeNoteId).not.toBeNull();

    await click(buttonByText('Last week'));

    expect(container.textContent).not.toContain('Writing still goes to');
    bareEngine.dispose();
  });
});
