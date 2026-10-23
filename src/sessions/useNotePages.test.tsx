// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { notifyPagesChanged } from '@/notes/pageChanges';
import { useNotePages } from '@/sessions/useNotePages';
import * as pagesModule from '@/storage/pages';
import type { PageRecord } from '@/storage/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;
let seen: (PageRecord[] | null)[];

const queue = { subscribe: () => () => {} } as unknown as TranscriptionQueue;

function Probe({ noteId }: { noteId: string | null }) {
  seen.push(useNotePages(noteId, queue));
  return null;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  seen = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  vi.restoreAllMocks();
});

async function render(noteId: string | null): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <Probe noteId={noteId} />
      </CaptureProvider>,
    );
  });
}

function page(noteId: string): PageRecord {
  return { id: `p-${noteId}`, noteId } as PageRecord;
}

describe('useNotePages', () => {
  it('returns null while loading, then the rows', async () => {
    vi.spyOn(pagesModule, 'listPages').mockResolvedValue([page('a')]);
    await render('a');
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toEqual([page('a')]);
  });

  it('returns an empty array for no note', async () => {
    await render(null);
    expect(seen.at(-1)).toEqual([]);
  });

  it('never shows the previous note\'s rows while the new note is still loading', async () => {
    let releaseB!: (rows: PageRecord[]) => void;
    vi.spyOn(pagesModule, 'listPages').mockImplementation((id: string) =>
      id === 'a'
        ? Promise.resolve([page('a')])
        : new Promise<PageRecord[]>((resolve) => {
            releaseB = resolve;
          }),
    );
    await render('a');
    expect(seen.at(-1)).toEqual([page('a')]);
    await render('b');
    expect(seen.at(-1)).toBeNull();
    await act(async () => {
      releaseB([page('b')]);
    });
    expect(seen.at(-1)).toEqual([page('b')]);
  });

  it('ignores a slow read for a note the user has since left (stale-note guard)', async () => {
    let releaseA!: (rows: PageRecord[]) => void;
    vi.spyOn(pagesModule, 'listPages').mockImplementation((id: string) =>
      id === 'a'
        ? new Promise<PageRecord[]>((resolve) => {
            releaseA = resolve;
          })
        : Promise.resolve([page('b')]),
    );
    await render('a');
    await render('b');
    await act(async () => {
      releaseA([page('a')]);
    });
    expect(seen.at(-1)).toEqual([page('b')]);
    expect(seen.some((r) => r?.[0]?.noteId === 'a')).toBe(false);
  });

  it('reloads when pages change for its note, and only its note', async () => {
    const spy = vi.spyOn(pagesModule, 'listPages').mockResolvedValue([page('a')]);
    await render('a');
    expect(seen.at(-1)).toEqual([page('a')]);
    const extra = { id: 'p-new', noteId: 'a' } as PageRecord;
    spy.mockResolvedValue([page('a'), extra]);
    await act(async () => {
      notifyPagesChanged('other');
    });
    expect(seen.at(-1)).toEqual([page('a')]);
    await act(async () => {
      notifyPagesChanged('a');
    });
    expect(seen.at(-1)).toEqual([page('a'), extra]);
  });
});
