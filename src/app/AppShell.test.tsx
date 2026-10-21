import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/AppShell';
import { resetAudioRuntimeForTests } from '@/audio/audioRuntime';
import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { TabletProvider } from '@/device/TabletProvider';
import { resetNamingQueueForTests } from '@/notes/naming/startNaming';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import { createNote } from '@/storage/notes';
import { createPage } from '@/storage/pages';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import type { NoteRecord } from '@/storage/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import { resetTranscriptionQueueForTests } from '@/transcription/startTranscription';

const migrate = vi.hoisted(() =>
  vi.fn(async () => ({
    imported: 0,
    pages: 0,
    failed: 0,
    skipped: true,
  })),
);

vi.mock('@/storage/migrate', () => ({ migrateLegacyNotebooks: migrate }));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

// Node 25 ships a global `localStorage` stub that shadows happy-dom's and has
// no methods, so install a Map-backed Storage for these tests.
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

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetTranscriptionQueueForTests();
  resetNamingQueueForTests();
  resetAudioRuntimeForTests();
  resetResumeLockForTests();
  vi.stubGlobal('localStorage', memoryStorage());
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
  })) as never;
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  resetTranscriptionQueueForTests();
  resetNamingQueueForTests();
  vi.unstubAllGlobals();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

async function renderShell(): Promise<void> {
  await act(async () => {
    root.render(
      <TabletProvider>
        <CaptureProvider engine={engine}>
          <AppShell />
        </CaptureProvider>
      </TabletProvider>,
    );
  });
  await settle();
}

async function remountShell(): Promise<void> {
  act(() => root.unmount());
  root = createRoot(container);
  await renderShell();
}

function tab(label: string): HTMLElement {
  const found = [...container.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`no tab labelled ${label}`);
  return found as HTMLElement;
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function clickTab(label: string): Promise<void> {
  await act(async () => {
    tab(label).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button with text ${JSON.stringify(text)}`);
  return found;
}

function byLabel(label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`nothing labelled ${label}`);
  return found;
}

function selectedEntryKey(): string | null {
  return (
    container.querySelector('aside button[aria-current="true"]')?.getAttribute('data-entry-key') ??
    null
  );
}

/** A session note with `pageCount` unfinalized pages (nothing for the real transcription queue to pick up). */
async function seedSession(title: string, startedAt: number, pageCount: number): Promise<NoteRecord> {
  const note = await createNote({
    title,
    deviceId: 'huion',
    pageBaseline: 0,
    pageWidth: 1409,
    pageHeight: 1869,
    status: 'complete',
    startedAt,
    sessionId: `session-${title}`,
  });
  for (let i = 0; i < pageCount; i++) {
    await createPage({
      noteId: note.id,
      pageIndex: i,
      devicePageNum: i + 1,
      source: 'live',
      strokes: [],
    });
  }
  return note;
}

async function seedRecording(note: NoteRecord, title: string, startedAt: number): Promise<void> {
  const recording = await createRecording(
    {
      title,
      sessionId: note.sessionId,
      noteId: note.id,
      startedAt,
      durationMs: 1000,
      endedAt: startedAt + 1000,
    },
    new Blob(['a'], { type: 'audio/webm' }),
  );
  await setRecordingTranscript(recording.id, {
    text: title,
    segments: [],
    model: 'whisper',
    language: 'en',
    status: 'done',
    error: null,
    updatedAt: 1,
  });
}

describe('AppShell', () => {
  it('shows exactly two tabs, Sessions and Triage, centred with Start session', async () => {
    await renderShell();

    const names = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(names).toEqual(['Sessions', 'Triage']);

    const tabList = container.querySelector('[role="tablist"]')!;
    const centre = tabList.parentElement!;
    expect(centre.className.split(/\s+/)).toContain('justify-center');
    expect(centre.contains(buttonByText('Start session'))).toBe(true);

    // The rest of the header stays: device status, Record and Settings.
    expect(container.textContent).toContain('Not connected');
    expect(container.textContent).toContain('Record');
    expect(container.querySelector('[aria-label="Settings"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Session"]')).toBeTruthy();
  });

  it('opens on Sessions', async () => {
    await renderShell();

    expect(tab('Sessions').getAttribute('data-state')).toBe('active');
    expect(byLabel('Notes')).toBeTruthy();
    // F4's page-turn controls stay mounted through the notes half.
    expect(buttonByText('New page')).toBeTruthy();
  });

  it('switching to Triage and back keeps the selected session and page', async () => {
    await seedSession('Session A', 2_000, 2);
    const b = await seedSession('Session B', 1_000, 2);
    await renderShell();

    await click(container.querySelector(`aside button[data-entry-key="note:${b.id}"]`)!);
    await click(byLabel('Next page'));
    expect(container.textContent).toContain('Page 2 of 2');

    await clickTab('Triage');
    expect(tab('Triage').getAttribute('data-state')).toBe('active');
    expect(container.querySelector('section[aria-label="Tasks"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Calendar"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Scratchpad"]')).not.toBeNull();

    await clickTab('Sessions');
    expect(tab('Sessions').getAttribute('data-state')).toBe('active');
    expect(selectedEntryKey()).toBe(`note:${b.id}`);
    expect(container.textContent).toContain('Page 2 of 2');
  });

  it('a reload restores the selected session, page, recording and notes mode', async () => {
    await seedSession('Session A', 2_000, 1);
    const b = await seedSession('Session B', 1_000, 2);
    await seedRecording(b, 'First take', 1_000);
    await seedRecording(b, 'Second take', 2_000);
    await renderShell();

    await click(container.querySelector(`aside button[data-entry-key="note:${b.id}"]`)!);
    await click(byLabel('Next page'));
    await click(byLabel('Next recording'));
    await click(byLabel('Notes view'));
    expect(byLabel('Notes view').getAttribute('aria-checked')).toBe('true');

    await remountShell();

    expect(tab('Sessions').getAttribute('data-state')).toBe('active');
    expect(selectedEntryKey()).toBe(`note:${b.id}`);
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('Recording 2 of 2');
    expect(container.textContent).toContain('Second take');
    expect(byLabel('Notes view').getAttribute('aria-checked')).toBe('true');
  });

  it('starting capture while on Triage switches to Sessions and selects the live note', async () => {
    await seedSession('Older', 1_000, 1);
    await renderShell();
    await clickTab('Triage');
    expect(tab('Triage').getAttribute('data-state')).toBe('active');

    await act(async () => {
      await engine.startSession();
    });
    await settle();
    const activeId = engine.getState().activeNoteId;

    expect(activeId).not.toBeNull();
    expect(tab('Sessions').getAttribute('data-state')).toBe('active');
    expect(selectedEntryKey()).toBe(`note:${activeId}`);
  });

  it('the legacy migration runs once', async () => {
    await renderShell();
    await remountShell();

    // Once across two mounts (and across StrictMode's double mount in dev):
    // two overlapping runs would both find the "migrated" setting unset and
    // import the library twice.
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});
