import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recorder, RecorderLink, RecorderState } from '@/audio/recorder';
import { RecorderControl } from '@/audio/RecorderControl';
import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine, type LiveCaptureEngine } from '@/capture/engine';
import { interruptedNoteOf, SessionPanel } from '@/capture/SessionControls';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import { createNote, listNotes } from '@/storage/notes';
import { countPoints, listPages } from '@/storage/pages';
import { createRecording } from '@/storage/recordings';
import { createSession, listSessions } from '@/storage/sessions';
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
  resetResumeLockForTests();
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

    const notesBefore = await listNotes();
    expect(notesBefore).toHaveLength(1);
    const noteId = notesBefore[0].id;
    const pagesBefore = await listPages(noteId);
    expect(pagesBefore).toHaveLength(1);
    expect(countPoints(pagesBefore[0].strokes)).toBe(0);

    // A28: writing is never blocked. The stroke lands on the session's note.
    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(engine.getState().activeNoteId).toBe(notes[0].id);
    // The point above the "one note exists" check: the stroke itself actually
    // landed on that note's page, not just that starting a session created a
    // note before any pen input arrived.
    const pagesAfter = await listPages(noteId);
    expect(pagesAfter).toHaveLength(1);
    expect(countPoints(pagesAfter[0].strokes)).toBeGreaterThan(0);
  });

  it('reports a recorder that throws and keeps the session', async () => {
    recorder.startImpl = () => Promise.reject(new Error('Recording is not supported'));
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain('Recording is not supported');
    expect(button('End session')).toBeTruthy();
  });

  it('reports a mislinked recording and keeps capturing handwriting', async () => {
    // The header's Record button already has the recorder going (P3-A3) when
    // Start session is pressed. The real recorder's start() is then a silent
    // no-op (recorder.ts line 204) and the existing recording keeps the link
    // it captured earlier - here, the standalone case from A10 - not this
    // session's. `startImpl` mirrors that: it leaves the state untouched.
    recorder.setState({
      status: 'recording',
      startedAt: 0,
      elapsedMs: 0,
      link: { sessionId: null, noteId: null },
      error: null,
    });
    recorder.startImpl = async () => {};
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain(
      'Audio was already recording when this session started, so this session has no recording of its own.',
    );
    // The session is nevertheless open, not unwound (A28).
    expect(button('End session')).toBeTruthy();
    expect(engine.getState().activeNoteId).not.toBeNull();

    const notesBefore = await listNotes();
    expect(notesBefore).toHaveLength(1);
    const noteId = notesBefore[0].id;
    const pagesBefore = await listPages(noteId);
    expect(pagesBefore).toHaveLength(1);
    expect(countPoints(pagesBefore[0].strokes)).toBe(0);

    // Handwriting still lands on the session's own note despite the mislink.
    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();

    expect(engine.getState().activeNoteId).toBe(noteId);
    const pagesAfter = await listPages(noteId);
    expect(pagesAfter).toHaveLength(1);
    expect(countPoints(pagesAfter[0].strokes)).toBeGreaterThan(0);
  });

  it('reports a mislinked recording when the header just pressed Record', async () => {
    // Record was pressed moments before Start session: the recorder is still
    // 'starting' (awaiting getUserMedia), so `recorder.start(ids)` here is a
    // silent no-op (recorder.ts line 204 only proceeds from 'idle') - a
    // recording begins seconds from now, but under the other link, not this
    // session's. That must read the same as the already-'recording' case,
    // not as "Recording did not start".
    recorder.setState({
      status: 'starting',
      startedAt: null,
      elapsedMs: 0,
      link: null,
      error: null,
    });
    recorder.startImpl = async () => {};
    render();

    await click(button('Start session'));
    await settle();

    expect(panel().textContent).toContain(
      'Audio was already recording when this session started, so this session has no recording of its own.',
    );
    expect(panel().textContent).not.toContain('Recording did not start');
    expect(button('End session')).toBeTruthy();
    expect(engine.getState().activeNoteId).not.toBeNull();
  });

  it('says why this session has no audio even with the header mounted alongside it', async () => {
    // The already-recording message is P3's own diagnosis - the recorder's own
    // state carries no error for this case - so this panel is the only surface
    // that can explain it, whether or not `RecorderControl` is mounted beside
    // it on the same singleton (P3-A3, the real arrangement in AppShell).
    recorder.setState({
      status: 'recording',
      startedAt: 0,
      elapsedMs: 0,
      link: { sessionId: null, noteId: null },
      error: null,
    });
    recorder.startImpl = async () => {};
    act(() => {
      root.render(
        <CaptureProvider engine={engine}>
          <RecorderControl recorder={recorder} />
          <SessionPanel engine={engine} controller={fake} recorder={recorder} now={() => clock} />
        </CaptureProvider>,
      );
    });

    await click(button('Start session'));
    await settle();

    const alerts = [...container.querySelectorAll('[role="alert"]')].filter((el) =>
      el.textContent?.includes('Audio was already recording'),
    );
    expect(alerts).toHaveLength(1);
    expect(panel().textContent).toContain(
      'Audio was already recording when this session started, so this session has no recording of its own.',
    );
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

  it('offers only End while a start is in flight, so the UI cannot fire a second Start', async () => {
    // Renamed from "disables the control while a start is in flight": that
    // name and its old assertions described a button being disabled, but by
    // the point this test reaches, the session is already open, so the only
    // button on screen is End session, never Start - there never was a
    // second Start button to click, disabled or not. Fix 2 makes End itself
    // clickable during this same window (see "lets End close a session..."
    // above), so what actually prevents a double `startSession()` here is
    // structural: no Start button is rendered once `isActive` is true. That
    // is what this test now proves, plus that the interrupted-looking start
    // still completes normally (one session, one linked recording) once the
    // pad comes back.
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

    // The pad has not come back yet, so the start is still running - and yet
    // no Start button exists to click a second time.
    expect(() => button('Start session')).toThrow();
    expect(button('End session')).toBeTruthy();

    // Cast: TS's control-flow analysis narrows `release` to `never` here -
    // it does not track the async reassignment inside `fake.connect`'s
    // executor, run via a closure it never sees called from this scope.
    (release as (() => void) | null)?.();
    await settle();

    expect(await listSessions()).toHaveLength(1);
    expect(recorder.links).toHaveLength(1);
    expect(engine.getState().activeNoteId).not.toBeNull();
  });

  it('lets End close a session while the start sequence is still awaiting the pad', async () => {
    // The session is already open in the engine as soon as `startSession()`
    // resolves, but `controller.connect()` has no page-level timeout around
    // the browser's Bluetooth chooser - it can hang indefinitely. The person
    // must still be able to end the session they can see is running.
    let release: (() => void) | null = null;
    fake.connect = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render();

    await click(button('Start session'));
    await settle();
    const noteId = engine.getState().activeNoteId;
    expect(noteId).not.toBeNull();

    const endButton = button('End session');
    expect(endButton.disabled).toBe(false);
    await click(endButton);
    await settle();

    const notes = await listNotes();
    expect(notes.find((n) => n.id === noteId)).toMatchObject({ status: 'complete' });
    expect((await listSessions())[0]).toMatchObject({ status: 'ended' });
    expect(recorder.stops).toBe(1);
    expect(button('Start session')).toBeTruthy();

    // Release the hung connect so nothing is left pending past the test.
    (release as (() => void) | null)?.();
    await settle();
  });

  it('does not start audio for a session that was ended while the pad hung', async () => {
    // The other side of End being clickable mid-start: when the chooser finally
    // answers, the start sequence resumes - but its session is already over.
    // Starting the recorder then would leave audio running against a note that
    // is `complete`, with nothing in this panel offering to stop it.
    let release: (() => void) | null = null;
    fake.connect = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render();

    await click(button('Start session'));
    await settle();
    await click(button('End session'));
    await settle();
    expect(recorder.links).toHaveLength(0);

    // The chooser answers only now, after the session is gone.
    (release as (() => void) | null)?.();
    await settle();

    expect(recorder.links).toHaveLength(0);
    expect(recorder.getState().status).toBe('idle');
    expect(button('Start session')).toBeTruthy();
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

  it('unmounting mid-start does not derail the session or the recording', async () => {
    // React 19 no longer warns on a `setState` after unmount, so a spy that
    // only checks for a logged "Warning" can never fail here regardless of
    // whether the `mounted` ref guard in SessionControls.tsx exists - it
    // proves nothing about that guard. What *is* genuinely testable from
    // outside is that unmounting mid-start does not derail the start itself:
    // the session the click opened is still open, the recorder still got
    // going, and the component's own error-reporting path logged nothing.
    // Whether the guard's specific job - suppressing a `setState` call on the
    // unmounted panel - actually ran is not observable from here either way;
    // that part of the guard's effect stays unverified by this test.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release: (() => void) | null = null;
    fake.connect = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render();

    await click(button('Start session'));
    // As in "disables the control..." above: the session write needs real
    // IndexedDB ticks, so draining the engine's chain here is what actually
    // gets the component past `engine.startSession()` and into the pending,
    // deliberately-hung `controller.connect()` - the thing we're about to
    // unmount out from under.
    await settle();
    act(() => root.unmount());
    // Same TS narrowing quirk as above.
    (release as (() => void) | null)?.();
    await settle();

    expect(engine.getState().activeNoteId).not.toBeNull();
    expect(recorder.links).toHaveLength(1);
    expect(logged.mock.calls.filter(([m]) => String(m).includes('[session]'))).toEqual([]);
    logged.mockRestore();
    // A fresh root, so afterEach's unmount has something to unmount.
    root = createRoot(container);
  });

  it('ends the session and the recording together', async () => {
    render();
    await click(button('Start session'));
    await settle();
    const noteId = engine.getState().activeNoteId;

    await click(button('End session'));
    await settle();

    expect(recorder.stops).toBe(1);
    const notes = await listNotes();
    expect(notes[0]).toMatchObject({ id: noteId, status: 'complete' });
    expect((await listSessions())[0]).toMatchObject({ status: 'ended' });
    expect(button('Start session')).toBeTruthy();
  });

  it('still stops the recording when ending the note fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    render();
    await click(button('Start session'));
    await settle();
    // Same state and the same subscription (spread keeps both), only the close
    // path fails - a note write that rejects mid-session.
    const broken = {
      ...engine,
      endSession: () => Promise.reject(new Error('note write failed')),
    } as unknown as LiveCaptureEngine;
    render({ engine: broken });

    await click(button('End session'));
    await settle();

    // The audio is in memory until stop() saves it (A11), so it is stopped
    // whatever the note did.
    expect(recorder.stops).toBe(1);
    expect(panel().textContent).toContain('note write failed');
    logged.mockRestore();
  });

  it('survives the recorder being stopped from elsewhere', async () => {
    render();
    await click(button('Start session'));
    await settle();

    // The header's own Record/Stop drives the same recorder singleton (P3-A3).
    await act(async () => {
      await recorder.stop();
    });

    expect(panel().textContent).toContain('No audio');
    expect(button('End session')).toBeTruthy();

    await click(button('End session'));
    await settle();
    expect(button('Start session')).toBeTruthy();
  });

  it('starting over a pen-started bare note completes it', async () => {
    render();
    // The student writes before pressing Start: the pen auto-starts a bare note.
    fake.emitPen({ x: 0.1, y: 0.1, status: 1, pressure: 0.5 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    await settle();
    const bare = engine.getState().activeNoteId;
    expect(bare).not.toBeNull();
    // A bare note is not a session, so the control still offers Start.
    expect(button('Start session')).toBeTruthy();

    clock += 5000;
    await click(button('Start session'));
    await settle();

    const notes = await listNotes();
    expect(notes.find((n) => n.id === bare)).toMatchObject({ status: 'complete' });
    expect(engine.getState().activeNoteId).not.toBe(bare);
    // The clock runs from the session, not from the bare note.
    expect(panel().textContent).toContain('0:00');
  });

  it('says only that the note was interrupted, whether or not its session had a recording (K9)', async () => {
    // K9: since audio persists incrementally (K4-K7), an interruption no
    // longer loses a recording outright, so the old "its audio recording was
    // lost" wording would be false. The sentence is gone regardless of
    // whether the interrupted session actually had a recording.
    const session = await createSession({ title: 'Interrupted seminar', startedAt: 5_000 });
    await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });
    await createRecording(
      { title: 'Interrupted seminar', durationMs: 1000, sessionId: session.id, startedAt: 5_000 },
      new Blob(['audio'], { type: 'audio/webm' }),
    );
    render();
    await settle();

    expect(panel().textContent).toContain('"Interrupted seminar" was interrupted.');
    expect(panel().textContent).not.toContain('recording was lost');

    await click(button('Dismiss'));
    expect(panel().textContent).not.toContain('was interrupted');
  });

  it('says the note was interrupted even with no recording at all', async () => {
    // A bare note the pen auto-started still gets its own session (A10), but
    // never had a recording at all. Same wording either way after K9.
    const session = await createSession({ title: 'Bare note', startedAt: 5_000 });
    await createNote({
      title: 'Bare note',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });
    render();
    await settle();

    expect(panel().textContent).toContain('"Bare note" was interrupted.');
    expect(panel().textContent).not.toContain('recording was lost');
  });

  it('offers Resume in the interrupted banner, and resuming it makes the note active (K14)', async () => {
    const session = await createSession({ title: 'Interrupted seminar', startedAt: 5_000 });
    const interrupted = await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });
    render();
    await settle();

    await click(button('Resume'));
    await settle();

    expect(engine.getState().activeNoteId).toBe(interrupted.id);
  });

  it('disables every Resume button and Start session for as long as a resume is in flight (architecture.md §8.3)', async () => {
    const session = await createSession({ title: 'Interrupted seminar', startedAt: 5_000 });
    await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });

    // Rejects rather than resolves, deliberately: a *successful* resume
    // itself sets `sessionStartedAt` (K13), which would replace "Start
    // session" with "End session" regardless of the lock, confounding what
    // this test checks. A rejection keeps `isActive` false throughout, so
    // "Start session" stays the button to inspect.
    let release: (() => void) | null = null;
    const held = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('Note not found'));
    });
    const wrapped = { ...engine, resumeNote: () => held } as unknown as LiveCaptureEngine;
    render({ engine: wrapped });
    await settle();

    const resumeButton = button('Resume');
    await act(async () => {
      resumeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(resumeButton.disabled).toBe(true);
    expect(button('Start session').disabled).toBe(true);

    (release as (() => void) | null)?.();
    await settle();

    expect(button('Start session').disabled).toBe(false);
    expect(button('Resume').disabled).toBe(false);
  });

  it('disables every Resume button while Start session itself is in flight (mirror of the hazard above, fix round 1, Important 1)', async () => {
    const session = await createSession({ title: 'Interrupted seminar', startedAt: 5_000 });
    await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });

    let release: (() => void) | null = null;
    const held = new Promise<{ sessionId: string; noteId: string }>((resolve) => {
      release = () => resolve({ sessionId: 's', noteId: 'n' });
    });
    const wrapped = { ...engine, startSession: () => held } as unknown as LiveCaptureEngine;
    render({ engine: wrapped });
    await settle();

    expect(button('Resume').disabled).toBe(false);

    await act(async () => {
      button('Start session').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // sessionStartedAtOf(state) still reads null here - startSession's op
    // has not published state yet - the exact §8.3 window, with the clicks
    // swapped from the test above. Without holding the lock around this
    // call too, Resume would still read enabled and could fall through to
    // closeNote() against the half-opened startSession.
    expect(button('Resume').disabled).toBe(true);

    (release as (() => void) | null)?.();
    await settle();
  });

  it('says nothing when the newest note finished cleanly', async () => {
    await createNote({
      title: 'Finished',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'complete',
      startedAt: 5_000,
    });
    render();
    await settle();

    expect(panel().textContent).not.toContain('interrupted');
  });

  it('clears the notice once a new session starts', async () => {
    const session = await createSession({ title: 'Interrupted seminar', startedAt: 5_000 });
    await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
      sessionId: session.id,
    });
    await createRecording(
      { title: 'Interrupted seminar', durationMs: 1000, sessionId: session.id, startedAt: 5_000 },
      new Blob(['audio'], { type: 'audio/webm' }),
    );
    render();
    await settle();
    expect(panel().textContent).toContain('was interrupted');

    // Starting a session changes `activeNoteId`: the effect must re-read the
    // notes list off that change, not just on mount. The new session's note
    // is now the newest, and it is the engine's current note, so
    // `interruptedNoteOf` excludes it - the notice should clear on its own,
    // with no Dismiss click.
    await click(button('Start session'));
    await settle();

    expect(panel().textContent).not.toContain('was interrupted');
  });

  it('reads an interrupted session from the newest note only', () => {
    const note = (id: string, status: 'active' | 'complete' | 'interrupted', startedAt: number) =>
      ({ id, status, startedAt, legacy: false }) as never;

    // Newest first, as `listNotes()` returns them.
    expect(interruptedNoteOf([note('b', 'interrupted', 2), note('a', 'complete', 1)], null)?.id).toBe('b');
    expect(interruptedNoteOf([note('b', 'complete', 2), note('a', 'interrupted', 1)], null)).toBeNull();
    // Still `active` because recovery has not run yet: the same situation.
    expect(interruptedNoteOf([note('b', 'active', 2)], null)?.id).toBe('b');
    // Unless it is the note being written right now.
    expect(interruptedNoteOf([note('b', 'active', 2)], 'b')).toBeNull();
    // A legacy header row is skipped entirely, even one whose status would
    // otherwise look interrupted - the next-newest, clean note is the real
    // newest as far as the notice is concerned.
    expect(
      interruptedNoteOf(
        [
          { id: 'legacy', status: 'interrupted', startedAt: 3, legacy: true } as never,
          { id: 'a', status: 'complete', startedAt: 1, legacy: false } as never,
        ],
        null,
      ),
    ).toBeNull();
  });
});
