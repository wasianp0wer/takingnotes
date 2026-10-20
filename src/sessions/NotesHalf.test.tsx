// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import type { SessionEntry } from '@/sessions/catalog';
import { NotesHalf } from '@/sessions/NotesHalf';
import type { NotesHalfProps } from '@/sessions/NotesHalf';
import { createNote, getNote } from '@/storage/notes';
import { createPage, createTypedPage, listPages } from '@/storage/pages';
import type { NoteRecord, PageRecord } from '@/storage/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;
let ctxSpy: { calls: string[] };
const originalGetContext = HTMLCanvasElement.prototype.getContext;

function fakeQueue(): TranscriptionQueue {
  return {
    start: vi.fn(async () => {}),
    enqueue: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    subscribe: () => () => {},
    idle: vi.fn(async () => {}),
    stop: vi.fn(),
  } as TranscriptionQueue;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetResumeLockForTests();
  ctxSpy = { calls: [] };
  const record = (name: string) => () => {
    ctxSpy.calls.push(name);
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function seedNoteEntry(): Promise<{ entry: SessionEntry; note: NoteRecord }> {
  const note = await createNote({
    title: 'Seminar notes',
    deviceId: 'huion',
    pageBaseline: 0,
    pageWidth: 1409,
    pageHeight: 1869,
    status: 'complete',
  });
  return { entry: { kind: 'note', key: `note:${note.id}`, note, recordings: [] }, note };
}

function inkPage(noteId: string, pageIndex: number): Promise<PageRecord> {
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
  });
}

async function renderWith(
  props: Partial<NotesHalfProps>,
  withEngine: LiveCaptureEngine = engine,
): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={withEngine}>
        <NotesHalf
          entry={null}
          pages={[]}
          pageIndex={0}
          onGoToPage={() => {}}
          mode="handwriting"
          onModeChange={() => {}}
          transcriptionQueue={fakeQueue()}
          sessionLocked={false}
          {...props}
        />
      </CaptureProvider>,
    );
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button ${JSON.stringify(text)}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('NotesHalf', () => {
  it('the switch is centred and defaults to Handwriting', async () => {
    await renderWith({});
    const sw = container.querySelector('[role="switch"]');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(sw?.closest('.justify-center')).not.toBeNull();
    expect(container.textContent).toContain('Handwriting');
  });

  it('toggling the switch asks for Transcription', async () => {
    const onModeChange = vi.fn();
    await renderWith({ onModeChange });
    await click(container.querySelector<HTMLElement>('[role="switch"]')!);
    expect(onModeChange).toHaveBeenCalledWith('transcription');
  });

  it('centres the page navigation', async () => {
    const { entry, note } = await seedNoteEntry();
    const pages = [await inkPage(note.id, 0), await inkPage(note.id, 1)];
    await renderWith({ entry, pages });
    const prev = container.querySelector('button[aria-label="Previous page"]');
    expect(prev?.parentElement?.className).toContain('justify-center');
  });

  it('renders ink for an ink page in Handwriting mode', async () => {
    const { entry, note } = await seedNoteEntry();
    const pages = [await inkPage(note.id, 0)];
    await renderWith({ entry, pages });
    expect(container.querySelector('canvas[aria-label="Page ink"]')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('renders the typed editor for a typed page in Handwriting mode', async () => {
    const { entry, note } = await seedNoteEntry();
    const typed = await createTypedPage({ noteId: note.id, pageIndex: 0, capturedAt: 5 });
    await renderWith({ entry, pages: [typed] });
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('canvas[aria-label="Page ink"]')).toBeNull();
  });

  it('Transcription mode shows gap analysis above the transcript', async () => {
    const { entry, note } = await seedNoteEntry();
    const pages = [await inkPage(note.id, 0)];
    await renderWith({ entry, pages, mode: 'transcription' });
    const gap = container.querySelector('[aria-label="Gaps"]');
    // TranscriptPanel has no marker of its own; its null-transcript copy is its root's text.
    const transcript = Array.from(container.querySelectorAll('div')).find(
      (el) =>
        el.children.length > 0 &&
        el.textContent?.includes('This page has not been transcribed yet.') &&
        !el.contains(gap),
    );
    expect(gap).toBeTruthy();
    expect(transcript).toBeTruthy();
    expect(gap!.compareDocumentPosition(transcript!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('This page has not been transcribed yet.');
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('the live page shows live ink', async () => {
    await renderWith({});
    await click(buttonByText('New note'));
    const state = engine.getState();
    const pages = await listPages(state.activeNoteId!);
    const n = (await getNote(state.activeNoteId!))!;
    const entry: SessionEntry = { kind: 'note', key: `note:${n.id}`, note: n, recordings: [] };
    expect(pages.some((p) => p.id === state.activePageId)).toBe(true);
    const live = vi.spyOn(engine, 'getLiveStrokes');
    await renderWith({ entry, pages });
    expect(container.querySelector('canvas[aria-label="Page ink"]')).not.toBeNull();
    expect(live).toHaveBeenCalled();
  });

  it('keeps typed text when the mode is toggled on a typed page', async () => {
    const { entry, note } = await seedNoteEntry();
    const typed = await createTypedPage({ noteId: note.id, pageIndex: 0, capturedAt: 5 });
    await renderWith({ entry, pages: [typed], mode: 'handwriting' });
    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, 'Newton: F=ma');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Same stale `pages` prop (typing sends no change signal), new mode.
    await renderWith({ entry, pages: [typed], mode: 'transcription' });
    expect(container.querySelector('textarea')?.value).toBe('Newton: F=ma');
    await renderWith({ entry, pages: [typed], mode: 'handwriting' });
    expect(container.querySelector('textarea')?.value).toBe('Newton: F=ma');
  });

  it('shows no empty prompt while pages are still loading', async () => {
    const { entry } = await seedNoteEntry();
    await renderWith({ entry, pages: null });
    expect(container.textContent).not.toContain('Resume this session');
  });

  it('a note entry with no pages shows an empty prompt and no canvas', async () => {
    const { entry } = await seedNoteEntry();
    await renderWith({ entry, pages: [] });
    expect(container.textContent).toContain('Resume this session to write or type a page');
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a recording entry renders an empty half', async () => {
    const entry: SessionEntry = {
      kind: 'recording',
      key: 'recording:r1',
      recording: {
        id: 'r1',
        sessionId: null,
        noteId: null,
        title: 'Audio',
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        mimeType: 'audio/webm',
        byteLength: 1,
        transcript: null,
      },
    };
    await renderWith({ entry });
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.textContent).not.toContain('Resume this session');
  });

  it('disables Type page with no active note', async () => {
    await renderWith({});
    expect(buttonByText('Type page').disabled).toBe(true);
  });

  it('creates a typed page via Type page once a note is active', async () => {
    await renderWith({});
    await click(buttonByText('New note'));
    expect(buttonByText('Type page').disabled).toBe(false);
    await click(buttonByText('Type page'));
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('disables New note while the session is locked', async () => {
    await renderWith({ sessionLocked: true });
    expect(buttonByText('New note').disabled).toBe(true);
  });

  it('disables New note and Type page while a resume is pending', async () => {
    const { note } = await seedNoteEntry();
    let release: (() => void) | null = null;
    const held = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('boom'));
    });
    const wrapped = { ...engine, resumeNote: () => held } as unknown as LiveCaptureEngine;
    await renderWith({}, wrapped);
    await click(buttonByText('New note'));
    expect(buttonByText('Type page').disabled).toBe(false);

    const { getResumeLock } = await import('@/notes/resumeLock');
    await act(async () => {
      void getResumeLock()
        .run(() => wrapped.resumeNote(note.id))
        .catch(() => {});
    });
    await settle();
    expect(buttonByText('New note').disabled).toBe(true);
    expect(buttonByText('Type page').disabled).toBe(true);

    (release as (() => void) | null)?.();
    await settle();
    expect(buttonByText('New note').disabled).toBe(false);
    expect(buttonByText('Type page').disabled).toBe(false);
  });

  it('page arrows call onGoToPage', async () => {
    const { entry, note } = await seedNoteEntry();
    const pages = [await inkPage(note.id, 0), await inkPage(note.id, 1)];
    const onGoToPage = vi.fn();
    await renderWith({ entry, pages, pageIndex: 0, onGoToPage });
    await click(container.querySelector<HTMLElement>('button[aria-label="Next page"]')!);
    expect(onGoToPage).toHaveBeenCalledWith(1);
  });
});
