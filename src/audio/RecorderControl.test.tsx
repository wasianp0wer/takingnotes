import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recorder, RecorderLink, RecorderState } from '@/audio/recorder';
import { RecorderControl } from '@/audio/RecorderControl';
import { CaptureProvider } from '@/capture/CaptureContext';
import type { CaptureEngine, CaptureState } from '@/capture/types';

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

const IDLE_STATE: RecorderState = {
  status: 'idle',
  startedAt: null,
  elapsedMs: 0,
  link: null,
  error: null,
};

interface FakeRecorder extends Recorder {
  setState(patch: Partial<RecorderState>): void;
}

function createFakeRecorder(initial: Partial<RecorderState> = {}): FakeRecorder {
  let state: RecorderState = { ...IDLE_STATE, ...initial };
  const listeners = new Set<() => void>();

  function set(patch: Partial<RecorderState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start: vi.fn(async (link: RecorderLink) => {
      set({ status: 'recording', startedAt: 0, elapsedMs: 0, link, error: null });
    }),
    stop: vi.fn(async () => {
      set({ ...IDLE_STATE });
      return null;
    }),
    clearError: vi.fn(() => set({ error: null })),
    setState: set,
  };
}

function createFakeCaptureEngine(state: CaptureState): CaptureEngine {
  return {
    getState: () => state,
    subscribe: () => () => {},
    // Resume is not exercised through this double.
    resumeNote: () => Promise.reject(new Error('resumeNote is not exercised through this double')),
  } as unknown as CaptureEngine;
}

function render(recorder: Recorder, capture: CaptureEngine) {
  act(() => {
    root.render(
      <CaptureProvider engine={capture}>
        <RecorderControl recorder={recorder} />
      </CaptureProvider>,
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`no button containing "${text}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const WITH_NOTE: CaptureState = {
  activeSessionId: 's1',
  activeNoteId: 'n1',
  activePageId: 'p1',
  pageIndex: 0,
};

const NO_NOTE: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

describe('RecorderControl', () => {
  it('starts recording and shows the linked/elapsed state', async () => {
    const recorder = createFakeRecorder();
    render(recorder, createFakeCaptureEngine(WITH_NOTE));

    expect(button('Record')).toBeTruthy();

    await click(button('Record'));

    expect(recorder.start).toHaveBeenCalledWith({ sessionId: 's1', noteId: 'n1' });
    expect(button('Stop')).toBeTruthy();
    expect(container.querySelector('[data-testid="recorder-elapsed"]')?.textContent).toBe('0:00');
    expect(container.textContent).toContain('Linked to note');
  });

  it('updates the elapsed clock as state changes', async () => {
    const recorder = createFakeRecorder();
    render(recorder, createFakeCaptureEngine(WITH_NOTE));

    await click(button('Record'));
    act(() => recorder.setState({ elapsedMs: 65_000 }));

    expect(container.querySelector('[data-testid="recorder-elapsed"]')?.textContent).toBe('1:05');
  });

  it('starts with null link and no "Linked to note" when there is no active note', async () => {
    const recorder = createFakeRecorder();
    render(recorder, createFakeCaptureEngine(NO_NOTE));

    await click(button('Record'));

    expect(recorder.start).toHaveBeenCalledWith({ sessionId: null, noteId: null });
    expect(container.textContent).not.toContain('Linked to note');
  });

  it('shows an error and dismisses it', async () => {
    const recorder = createFakeRecorder({ error: 'Microphone access was denied.' });
    render(recorder, createFakeCaptureEngine(WITH_NOTE));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Microphone access was denied.');

    const dismiss = container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    await click(dismiss);

    expect(recorder.clearError).toHaveBeenCalled();
  });

  it('stops recording on click', async () => {
    const recorder = createFakeRecorder();
    render(recorder, createFakeCaptureEngine(WITH_NOTE));

    await click(button('Record'));
    await click(button('Stop'));

    expect(recorder.stop).toHaveBeenCalled();
  });
});
