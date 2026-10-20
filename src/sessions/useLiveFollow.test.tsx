import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import type { CaptureEngine, CaptureState } from '@/capture/types';

import { createSessionsUiStore } from './sessionsUiStore';
import type { SessionsUiStore } from './sessionsUiStore';
import { useLiveFollow } from './useLiveFollow';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function stubEngine(initial: Partial<CaptureState> = {}) {
  let state: CaptureState = {
    activeSessionId: null,
    activeNoteId: null,
    activePageId: null,
    pageIndex: -1,
    ...initial,
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

function Host({ store }: { store: SessionsUiStore }) {
  useLiveFollow(store);
  return null;
}

async function mount(engine: CaptureEngine, store: SessionsUiStore): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <Host store={store} />
      </CaptureProvider>,
    );
  });
}

describe('useLiveFollow', () => {
  it('a note becoming active switches to Sessions and selects it, even from Triage while viewing another session', async () => {
    const { stub, set } = stubEngine();
    const store = createSessionsUiStore(null);
    store.selectEntry('note:other');
    store.setTab('triage');
    await mount(stub, store);
    await act(async () => set({ activeNoteId: 'n1', activePageId: 'p1', pageIndex: 0 }));
    expect(store.getState()).toMatchObject({
      tab: 'sessions',
      selectedKey: 'note:n1',
      pageIndex: 0,
    });
  });

  it('a page turn on the viewed active note is followed', async () => {
    const { stub, set } = stubEngine({ activeNoteId: 'n1', activePageId: 'p1', pageIndex: 0 });
    const store = createSessionsUiStore(null);
    store.selectEntry('note:n1');
    await mount(stub, store);
    await act(async () => set({ activePageId: 'p2', pageIndex: 1 }));
    expect(store.getState().pageIndex).toBe(1);
  });

  it('a page turn is not followed while viewing a different note', async () => {
    const { stub, set } = stubEngine({ activeNoteId: 'n1', activePageId: 'p1', pageIndex: 0 });
    const store = createSessionsUiStore(null);
    store.selectEntry('note:other');
    store.goToPage(3);
    await mount(stub, store);
    await act(async () => set({ activePageId: 'p2', pageIndex: 1 }));
    expect(store.getState()).toMatchObject({ selectedKey: 'note:other', pageIndex: 3 });
  });

  it('the initial render does not override a restored selection', async () => {
    const { stub } = stubEngine({ activeNoteId: 'n1', activePageId: 'p1', pageIndex: 2 });
    const store = createSessionsUiStore(null);
    store.selectEntry('note:other');
    store.setTab('triage');
    await mount(stub, store);
    expect(store.getState()).toMatchObject({
      tab: 'triage',
      selectedKey: 'note:other',
      pageIndex: 0,
    });
  });
});
