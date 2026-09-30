import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { NotesView } from '@/notes/NotesView';
import { createNote } from '@/storage/notes';
import { createPage, setPageTranscript } from '@/storage/pages';
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

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
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
        <NotesView queue={queue} />
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
});
