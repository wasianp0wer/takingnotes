import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recorder, RecorderLink, RecorderState } from '@/audio/recorder';
import { createCaptureEngine, type LiveCaptureEngine } from '@/capture/engine';
import { SessionPanel } from '@/capture/SessionControls';
import { listNotes } from '@/storage/notes';
import { listSessions } from '@/storage/sessions';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const IDLE_RECORDER: RecorderState = {
  status: 'idle',
  startedAt: null,
  elapsedMs: 0,
  link: null,
  error: null,
};

interface FakeRecorder extends Recorder {
  setState(patch: Partial<RecorderState>): void;
  readonly links: RecorderLink[];
  readonly stops: number;
  /** What `start` does. Reassign to refuse the microphone or to throw. */
  startImpl: (link: RecorderLink) => Promise<void>;
}

/** Mirrors the fake in `src/audio/RecorderControl.test.tsx`. */
function createFakeRecorder(initial: Partial<RecorderState> = {}): FakeRecorder {
  let state: RecorderState = { ...IDLE_RECORDER, ...initial };
  const listeners = new Set<() => void>();
  const links: RecorderLink[] = [];
  let stops = 0;

  function set(patch: Partial<RecorderState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  }

  const fake: FakeRecorder = {
    links,
    get stops() {
      return stops;
    },
    startImpl: async (link) => {
      set({ status: 'recording', startedAt: 0, elapsedMs: 0, link, error: null });
    },
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async start(link) {
      links.push(link);
      await fake.startImpl(link);
    },
    async stop() {
      stops += 1;
      set({ ...IDLE_RECORDER });
      return null;
    },
    clearError: () => set({ error: null }),
    setState: set,
  };
  return fake;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fake: FakeDeviceController;
let engine: LiveCaptureEngine;
let recorder: FakeRecorder;
let clock = 1_000_000;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fake = createFakeDeviceController();
  engine = createCaptureEngine({ controller: fake, now: () => clock });
  recorder = createFakeRecorder();
  clock = 1_000_000;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
});

function render(overrides: { engine?: LiveCaptureEngine } = {}) {
  act(() => {
    root.render(
      <SessionPanel
        engine={overrides.engine ?? engine}
        controller={fake}
        recorder={recorder}
        now={() => clock}
      />,
    );
  });
}

function panel(): HTMLElement {
  const found = container.querySelector('[aria-label="Session"]');
  if (!found) throw new Error('no element labelled Session');
  return found as HTMLElement;
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button containing "${text}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Lets the engine's op chain and the panel's effects settle. */
async function settle() {
  await act(async () => {
    await engine.flush();
  });
}

describe('SessionPanel', () => {
  it('offers Start session while idle', async () => {
    render();
    await settle();

    expect(panel()).toBeTruthy();
    expect(button('Start session')).toBeTruthy();
    expect(container.querySelector('[data-testid="session-elapsed"]')).toBeNull();
  });

  it('starts the session, the pad and the recording from one click', async () => {
    render();

    await click(button('Start session'));
    await settle();

    const sessions = await listSessions();
    const notes = await listNotes();
    expect(sessions).toHaveLength(1);
    expect(notes).toHaveLength(1);
    // Connect then stream: connecting without streaming captures no pen input.
    expect(fake.calls).toEqual(['connect', 'startStreaming']);
    expect(recorder.links).toEqual([{ sessionId: sessions[0].id, noteId: notes[0].id }]);
    expect(button('End session')).toBeTruthy();
    expect(panel().textContent).toContain('0:00');
    expect(panel().textContent).toContain('Recording');
  });

  it('leaves a connected, streaming pad alone', async () => {
    fake.setDeviceState({ isConnected: true, isStreaming: true, deviceName: 'Huion Note' });
    render();

    await click(button('Start session'));
    await settle();

    expect(fake.calls).toEqual([]);
    expect(panel().textContent).toContain('Pad connected');
  });

  it('starts streaming on a pad that is connected but silent', async () => {
    fake.setDeviceState({ isConnected: true, isStreaming: false });
    render();

    await click(button('Start session'));
    await settle();

    expect(fake.calls).toEqual(['startStreaming']);
  });

  it('keeps the session when the pad will not connect', async () => {
    fake.connect = () => Promise.reject(new Error('User cancelled the requestDevice() chooser'));
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain('User cancelled');
    // The session is running and audio started anyway: a session with no pad
    // still records.
    expect(button('End session')).toBeTruthy();
    expect(engine.getState().activeNoteId).not.toBeNull();
    expect(recorder.links).toHaveLength(1);
  });

  it('keeps capturing handwriting when the microphone is refused', async () => {
    recorder.startImpl = async () => {
      recorder.setState({
        status: 'idle',
        error: 'Microphone access was denied. Allow it in the browser to record.',
      });
    };
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain('Microphone access was denied');
    expect(panel().textContent).toContain('No audio');
    expect(button('End session')).toBeTruthy();

    // A28: writing is never blocked. The stroke lands on the session's note.
    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();
    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(engine.getState().activeNoteId).toBe(notes[0].id);
  });

  it('reports a recorder that throws and keeps the session', async () => {
    recorder.startImpl = () => Promise.reject(new Error('Recording is not supported'));
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain('Recording is not supported');
    expect(button('End session')).toBeTruthy();
  });

  it('reports a session that cannot start and touches neither pad nor microphone', async () => {
    const broken = {
      ...engine,
      startSession: () => Promise.reject(new Error('session write failed')),
    } as unknown as LiveCaptureEngine;
    render({ engine: broken });

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain('session write failed');
    expect(recorder.links).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(button('Start session')).toBeTruthy();
  });

  it('shows the elapsed time growing', async () => {
    render();
    await click(button('Start session'));
    await settle();
    expect(panel().textContent).toContain('0:00');

    clock += 65_000;
    // Real timers on purpose: the panel's own one-second tick is what has to
    // move the clock, and the engine's flush timer and fake-indexeddb both run
    // on real timers in this file.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    expect(panel().textContent).toContain('1:05');
  });

  it('disables the control while a start is in flight', async () => {
    let release: (() => void) | null = null;
    fake.connect = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render();

    await click(button('Start session'));
    // The session write itself takes real IndexedDB ticks (fake-indexeddb
    // schedules them with setImmediate, not just microtasks), so a bare
    // `click()` lands mid-write, before the pad's `connect()` has even been
    // called. Draining the engine's op chain here gets past that write -
    // `connect()` is now the thing in flight, hung on `release` - without
    // resolving it, since `flush()` only awaits the engine's own chain.
    await settle();

    // The pad has not come back yet, so the start is still running and the
    // button is disabled. An impatient second click on it must neither start a
    // second session nor end the one that just opened.
    const busy = [...container.querySelectorAll('button')].find((el) => el.disabled);
    expect(busy).toBeTruthy();
    await click(busy as HTMLButtonElement);
    // Cast: TS's control-flow analysis narrows `release` to `never` here -
    // it does not track the async reassignment inside `fake.connect`'s
    // executor, run via a closure it never sees called from this scope.
    (release as (() => void) | null)?.();
    await settle();

    expect(await listSessions()).toHaveLength(1);
    expect(recorder.links).toHaveLength(1);
    expect(engine.getState().activeNoteId).not.toBeNull();
  });

  it('shows a mid-session reconnect without ending the session', async () => {
    fake.setDeviceState({ isConnected: true, isStreaming: true });
    render();
    await click(button('Start session'));
    await settle();

    await act(async () => {
      fake.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    });

    expect(panel().textContent).toContain('Reconnecting');
    expect(button('End session')).toBeTruthy();
    expect(engine.getState().activeNoteId).not.toBeNull();
  });

  it('unmounting mid-start is quiet', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release: (() => void) | null = null;
    fake.connect = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render();

    await click(button('Start session'));
    act(() => root.unmount());
    // Same TS narrowing quirk as above.
    (release as (() => void) | null)?.();
    await settle();

    expect(logged.mock.calls.filter(([m]) => String(m).includes('Warning'))).toEqual([]);
    logged.mockRestore();
    // A fresh root, so afterEach's unmount has something to unmount.
    root = createRoot(container);
  });
});
