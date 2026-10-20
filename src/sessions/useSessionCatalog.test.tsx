import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { useSessionCatalog } from '@/sessions/useSessionCatalog';
import { createNote } from '@/storage/notes';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { CaptureEngine, CaptureState } from '@/capture/types';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type Loaded = { notes: NoteRecord[]; finished: RecordingRecord[] };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;

function fakeSignal() {
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return {
    subscribe,
    subscribeChanges: subscribe,
    fire: () => listeners.forEach((l) => l()),
  };
}
const transcription = fakeSignal();
const audio = fakeSignal();
const naming = fakeSignal();

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
});

function Host({ load }: { load?: () => Promise<Loaded> }) {
  const { catalog, loaded } = useSessionCatalog(
    {
      transcriptionQueue: transcription,
      audioQueue: audio,
      namingQueue: naming,
    },
    load,
  );
  return (
    <div>
      <div data-testid="loaded">{String(loaded)}</div>
      <div data-testid="keys">
        {[...catalog.sessions, ...catalog.uncategorized].map((e) => e.key).join(',')}
      </div>
    </div>
  );
}

async function render(
  load?: () => Promise<Loaded>,
  withEngine: CaptureEngine = engine,
): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={withEngine}>
        <Host load={load} />
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

const keys = () => container.querySelector('[data-testid="keys"]')?.textContent;

function makeNote(id: string): NoteRecord {
  return {
    id,
    title: id,
    status: 'complete',
    deviceId: 'd',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 1,
    endedAt: null,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
  };
}

describe('useSessionCatalog', () => {
  it('loads on mount', async () => {
    const n = await createNote({
      title: 'one',
      deviceId: 'd',
      pageBaseline: 0,
    });
    await render();
    expect(container.querySelector('[data-testid="loaded"]')?.textContent).toBe('true');
    expect(keys()).toBe(`note:${n.id}`);
  });

  it.each([
    ['transcription queue', transcription],
    ['audio queue', audio],
    ['naming queue', naming],
  ])('reloads when the %s signals', async (_name, signal) => {
    await render();
    expect(keys()).toBe('');
    const n = await createNote({
      title: 'late',
      deviceId: 'd',
      pageBaseline: 0,
    });
    await act(async () => signal.fire());
    await settle();
    expect(keys()).toBe(`note:${n.id}`);
  });

  describe('capture state', () => {
    // A stub engine whose state fields change one at a time, so each
    // dependency of the reload effect is pinned on its own.
    function stubEngine() {
      let state: CaptureState = {
        activeSessionId: null,
        activeNoteId: 'n1',
        activePageId: 'p1',
        pageIndex: 0,
      };
      const listeners = new Set<(s: CaptureState) => void>();
      const stub = {
        getState: () => state,
        subscribe: (fn: (s: CaptureState) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      } as unknown as CaptureEngine;
      const set = (patch: Partial<CaptureState>) => {
        state = { ...state, ...patch };
        listeners.forEach((l) => l(state));
      };
      return { stub, set };
    }

    it.each([
      ['activeNoteId', { activeNoteId: 'n2' }],
      ['activePageId', { activePageId: 'p2' }],
      ['pageIndex', { pageIndex: 1 }],
    ] as const)('reloads when only %s changes', async (_name, patch) => {
      const { stub, set } = stubEngine();
      let calls = 0;
      const load = async (): Promise<Loaded> => {
        calls++;
        return { notes: [], finished: [] };
      };
      await render(load, stub);
      const before = calls;
      expect(before).toBeGreaterThan(0);
      await act(async () => set(patch));
      await settle();
      expect(calls).toBe(before + 1);
    });
  });

  it('marks loaded and keeps the previous catalog when a load fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const load = async (): Promise<Loaded> => {
      if (fail) throw new Error('boom');
      return { notes: [makeNote('kept')], finished: [] };
    };
    await render(load);
    fail = true;
    await act(async () => naming.fire());
    await settle();
    expect(keys()).toBe('note:kept');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('is loaded even when the very first load fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await render(async () => {
      throw new Error('boom');
    });
    expect(container.querySelector('[data-testid="loaded"]')?.textContent).toBe('true');
    error.mockRestore();
  });

  it('an older load resolving after a newer one never wins', async () => {
    const resolvers: Array<(v: Loaded) => void> = [];
    const load = () => new Promise<Loaded>((resolve) => resolvers.push(resolve));
    await render(load);
    expect(resolvers).toHaveLength(1); // mount load
    await act(async () => naming.fire()); // second load
    expect(resolvers).toHaveLength(2);

    await act(async () => resolvers[1]({ notes: [makeNote('new')], finished: [] }));
    await act(async () => resolvers[0]({ notes: [makeNote('old')], finished: [] }));
    await settle();
    expect(keys()).toBe('note:new');
  });
});
