# P3 Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One header control starts a session — the engine creates a `Session`, a `Note` in it and its first page; the UI ensures the pad is connected and streaming and starts audio recording — and ending it finalizes the page, completes the note, ends the session and stops the recording, with audio failures never blocking handwriting.

**Architecture:** The engine gains one internal opener (`openNote`) used by both `startNote` (bare notes, pen auto-start) and `startSession` (manual sessions), so ids are captured inside the serialized op instead of read off published state afterwards; a manual session additionally publishes an optional `sessionStartedAt` on the state object (`types.ts` is frozen, so this is additive, with a `sessionStartedAtOf()` reader). `SessionControls` is a thin hook wrapper around a fully injectable `SessionPanel` (engine, controller, recorder, now), which calls `engine.startSession()` first and then the pad and the microphone, tolerating failures of both.

**Tech Stack:** React 19, TypeScript 5.9 (`@/` = `src/`), Vitest 3 + happy-dom + fake-indexeddb, no `@testing-library/react` (`createRoot` + `act`), Tailwind + local `@/components/ui/*`, lucide-react icons.

**Spec:** `docs/features/p3-spec.md` — read its "Design", "Tests" and "Assumptions" sections before starting any task.

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/p3-sessions` (branch `p3-sessions`). Never push. Never bare `git stash`.
- Edit only: `src/capture/engine.ts`, `src/capture/engine.test.ts`, `src/capture/SessionControls.tsx`, and new `src/capture/*` files you add plus their tests. Do **NOT** edit `src/capture/types.ts`, `src/capture/CaptureContext.tsx`, `src/capture/pageTurnTestEngine.ts`, `src/capture/pageTurn*.ts(x)`, `src/storage/**`, `src/llm/**`, `src/audio/**`, `src/app/**`, `src/device/**`, `src/utils/**`, `src/gaps/**`, `src/syllabus/**`, `src/notes/**`, `src/triage/**`, `src/test/**`, `src/main.tsx`.
- `SessionControls` keeps its export name and renders everything inside an element with `aria-label="Session"` (`src/app/AppShell.test.tsx` asserts it).
- The four session tests already in `src/capture/engine.test.ts` ("startSession opens a session with a note in it and reports both ids", "endSession finalizes the page, completes the note and ends the session", "endSession is a no-op when idle", "startSession ends an already-open note first") must not be weakened or rewritten; they keep passing as they are. The same goes for every other existing test in that file — in particular the full-state `expect(engine.getState()).toEqual(IDLE)` and `toEqual({ activeSessionId, activeNoteId, activePageId, pageIndex })` assertions, which is why `sessionStartedAt` is **absent** rather than `null` when no manual session is open.
- The engine must not import anything from `@/audio/**`. The recorder is the UI's business (`docs/architecture.md` §6.5).
- Component tests set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and render with `createRoot` inside `act` — pattern: `src/app/DeviceStatus.test.tsx`. Fake recorder pattern: `src/audio/RecorderControl.test.tsx`. Fake device: `createFakeDeviceController()` from `@/test/fakeDeviceController`. Database reset: `resetDatabase()` from `@/test/resetDb` in `beforeEach`.
- Error logging keeps the existing prefixes: `[capture]` in the engine, `[session]` in `SessionControls`.
- Commands: one file `npx vitest run <path>`; all tests `npx vitest run` (baseline: 70 files, 769 tests, all passing); types `npx tsc -b`; lint `npx eslint <files>`; build `npm run build`.
- No new lint errors or warnings in touched files. `react-hooks/set-state-in-effect` warns: never call `setState` synchronously in an effect body (after an `await` is fine).
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

1. **Start clicked twice** (impatient double-click, or two starts in flight): must not leave two sessions running or two recordings going — Task 3 test "a second click while starting is ignored".
2. **`RecorderControl`'s Stop pressed during a session** (it shares the one recorder singleton, P3-A3): the session must keep running and show `No audio`, and End must still work — Task 4 test "survives the recorder being stopped from elsewhere".
3. **The pad drops mid-session** (`isConnected: false`, `isReconnecting: true`): the session keeps running and the link line says so; nothing unwinds — Task 3 test "shows a mid-session reconnect without ending the session".
4. **Unmount while a start is in flight** (the user switches away, or StrictMode remounts): no state update after unmount, no unhandled rejection — Task 3 test "unmounting mid-start is quiet".
5. **Start pressed after the pen already auto-started a bare note** (the real classroom case): the bare note must be completed, not left `active`, and the clock must run from the session — Task 4 test "starting over a pen-started bare note completes it".

---

### Task 1: Engine — one opener, real `startSession`/`endSession`, session state for the UI

**Files:**
- Modify: `src/capture/engine.ts`
- Test: `src/capture/engine.test.ts` (append to the existing `describe`)

**Interfaces:**
- Consumes: `createSession`, `updateSession`, `getSession`, `listSessions` (`@/storage/sessions`); `createNote`, `getNote`, `listNotes`, `updateNote` (`@/storage/notes`); `createPage`, `getPage`, `listPages` (`@/storage/pages`); `CaptureEngine`, `CaptureState`, `NewPageReason` (`@/capture/types`, read-only).
- Produces (later tasks and `SessionControls` rely on these exact names):
  ```ts
  export interface LiveCaptureState extends CaptureState {
    /** Present only while a session started by `startSession()` is open. */
    sessionStartedAt?: number;
  }
  /** The session's start time, or null when no manual session is open. */
  export function sessionStartedAtOf(state: CaptureState): number | null;
  export interface LiveCaptureEngine extends CaptureEngine {
    getState(): LiveCaptureState;
    start(): Promise<void>;
    flush(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` in `src/capture/engine.test.ts` (it already has `engine`, `fake`, `IDLE`, `stroke`, `tick`, `hooks` in scope). Add `sessionStartedAtOf` to the existing `@/capture/engine` import.

```ts
  it('startSession records the session on the note and publishes its start time', async () => {
    await engine.start();

    const { sessionId, noteId } = await engine.startSession({ title: 'Seminar' });

    const note = await getNote(noteId);
    expect(note).toMatchObject({ status: 'active', sessionId, title: 'Seminar' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'active', endedAt: null });
    const state = engine.getState();
    expect(state.sessionStartedAt).toBe(note!.startedAt);
    expect(sessionStartedAtOf(state)).toBe(note!.startedAt);
  });

  it('gives each concurrent startSession its own pair of ids', async () => {
    await engine.start();

    // Two clicks in one tick (or a click while the first start is still in
    // flight): reading the session id off published state after the await would
    // hand both callers the newer session.
    const [first, second] = await Promise.all([
      engine.startSession({ title: 'One' }),
      engine.startSession({ title: 'Two' }),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.noteId).not.toBe(second.noteId);
    expect((await getNote(first.noteId))?.sessionId).toBe(first.sessionId);
    expect((await getNote(second.noteId))?.sessionId).toBe(second.sessionId);
    expect(await listSessions()).toHaveLength(2);
    expect(await listNotes()).toHaveLength(2);
    expect(await listPages(first.noteId)).toHaveLength(1);
    expect(await listPages(second.noteId)).toHaveLength(1);
  });

  it('endSession clears the published session start time', async () => {
    await engine.start();
    await engine.startSession();

    await engine.endSession();

    expect(engine.getState()).toEqual(IDLE);
    expect(sessionStartedAtOf(engine.getState())).toBeNull();
  });

  it('endNote also clears the published session start time', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();

    // Whatever closes the note ends its session, so the UI can never show a
    // session the engine no longer has.
    await engine.endNote();

    expect(sessionStartedAtOf(engine.getState())).toBeNull();
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
  });

  it('publishes no session start time for a bare note', async () => {
    await engine.start();

    const noteId = await engine.startNote({ title: 'Bare' });

    // A bare note still gets its own session record (Phase 1's shape, A10),
    // but it is not a manual session, so the header shows none.
    expect(sessionStartedAtOf(engine.getState())).toBeNull();
    expect((await getNote(noteId))?.sessionId).toBeTruthy();
  });

  it('leaves nothing open when the session write fails', async () => {
    await engine.start();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.failSessionWrites = 1;

    await expect(engine.startSession()).rejects.toThrow('session write failed');
    expect(engine.getState()).toEqual(IDLE);

    // The next pen point must start a fresh note rather than accumulate into a
    // buffer that will never have a page.
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();
    expect(await listNotes()).toHaveLength(1);
    logged.mockRestore();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: FAIL — `sessionStartedAtOf` is not exported (a collection/type error), and once it exists, the "own pair of ids" and "publishes its start time" tests fail against the thin delegation.

- [ ] **Step 3: Implement the engine changes**

In `src/capture/engine.ts`:

a. After `CaptureEngineDeps`, add the state extension and the reader:

```ts
/**
 * What the live engine actually publishes. `CaptureState` (foundations-owned,
 * `src/capture/types.ts`) has no field for "a manually started session is open"
 * or for when it began, and P3 does not own that file, so the engine adds one
 * optional field to the same object (spec P3-A1). It is *absent* - not null -
 * while idle and for bare notes, so nothing that reads `CaptureState` changes
 * shape.
 */
export interface LiveCaptureState extends CaptureState {
  /** Present only while a session started by `startSession()` is open. */
  sessionStartedAt?: number;
}

/**
 * When the open manual session began, or null when none is. The reader exists
 * so `SessionControls` can ask a plain `CaptureState` (what the context hands
 * it) without a cast.
 */
export function sessionStartedAtOf(state: CaptureState): number | null {
  const at = (state as LiveCaptureState).sessionStartedAt;
  return typeof at === 'number' ? at : null;
}
```

b. Widen the engine interface's `getState` and the internal state variable:

```ts
export interface LiveCaptureEngine extends CaptureEngine {
  getState(): LiveCaptureState;
  /**
   * Attaches to the pen stream, starts the flush timer and runs startup
   * recovery. Idempotent; resolves when recovery has finished. Called
   * implicitly by every public method except getState/dispose.
   */
  start(): Promise<void>;
  /** Persists the active buffer now; resolves once every queued write has landed. */
  flush(): Promise<void>;
}
```

and inside `createCaptureEngine`: `let state: LiveCaptureState = { ...idleState };`, `const stateEmitter = createEmitter<LiveCaptureState>();`, `function setState(next: LiveCaptureState)`. `idleState` keeps its four fields, so `setState({ ...idleState })` drops `sessionStartedAt` — which is how `closeNote` clears it.

c. Replace `startNote` with a shared opener. The `map` callback runs **inside** the op, which is what gives each caller its own pair of ids:

```ts
  /**
   * Opens Session + Note + page 0 and makes them active, ending any open note
   * first. Both entry points funnel through here: `startNote` for bare notes and
   * pen-input auto-start, `startSession` for a manual session (P3).
   *
   * `map` runs inside the op, so a caller gets the ids of the records *this*
   * call created. Reading them off published state after the await would hand
   * two concurrent callers the same, newer session. It also keeps the returned
   * promise the one `enqueue` already attached a handler to, so the pen
   * handler's fire-and-forget `void startNote()` cannot produce an unhandled
   * rejection.
   */
  function openNote<T>(
    opts: { title?: string; manual: boolean },
    map: (ids: { sessionId: string; noteId: string }) => T,
  ): Promise<T> {
    void start();
    if (noteOpen) void closeNote();
    noteOpen = true;
    const opener = ++openerSeq;
    const b = buffer;

    return enqueue(async () => {
      try {
        const startedAt = now();
        const stamp = new Date(startedAt).toLocaleString();
        const title = opts.title ?? `${opts.manual ? 'Session' : 'Note'} ${stamp}`;
        const device = controller.getState();

        const session = await createSession({ title, startedAt });
        const note = await createNote({
          title,
          deviceId: device.deviceName || 'huion',
          deviceType: 'huion',
          deviceName: device.deviceName || null,
          pageBaseline: device.isConnected ? device.storedPageCount : 0,
          pageWidth: HUION_DEFAULT_PAGE_WIDTH_A5,
          pageHeight: HUION_DEFAULT_PAGE_HEIGHT_A5,
          sessionId: session.id,
          startedAt,
        });
        // Whatever arrived during the auto-start window is written with the
        // page itself, so nothing needs a second round trip.
        const buffered = [...b.strokes];
        const page = await createPage({
          noteId: note.id,
          pageIndex: 0,
          devicePageNum: devicePageNum(),
          source: 'live',
          strokes: buffered,
          capturedAt: startedAt,
        });

        b.pageId = page.id;
        if (b.strokes.length === buffered.length) b.dirty = false;
        const next: LiveCaptureState = {
          activeSessionId: session.id,
          activeNoteId: note.id,
          activePageId: page.id,
          pageIndex: 0,
        };
        // Only a manual session is a session as far as the header is concerned.
        if (opts.manual) next.sessionStartedAt = startedAt;
        setState(next);
        // Anything written since that snapshot (the stroke in progress, or a
        // stroke that closed mid-creation).
        void flushBuffer(b);
        return map({ sessionId: session.id, noteId: note.id });
      } catch (error) {
        // No note is open after all, so the next pen point tries again rather
        // than accumulating into a buffer that will never have a page - unless a
        // later opener has already claimed the flag.
        if (openerSeq === opener) noteOpen = false;
        throw error;
      }
    });
  }

  function startNote(opts: { title?: string } = {}): Promise<string> {
    return openNote({ title: opts.title, manual: false }, (ids) => ids.noteId);
  }

  function startSession(opts: { title?: string } = {}): Promise<{ sessionId: string; noteId: string }> {
    return openNote({ title: opts.title, manual: true }, (ids) => ids);
  }
```

d. Share the closing half and drop the delegation comment. Replace the returned object's `endNote`, `startSession` and `endSession` with:

```ts
    startNote,
    startSession,
    newPage,

    endNote: endOpenNote,
    // One session is one note, started and ended together (spec J4), so ending
    // the session is the same close path: finalize the page, complete the note,
    // end the session.
    endSession: endOpenNote,
```

with, next to `closeNote`:

```ts
  /** `endNote`/`endSession`: the close path, or nothing when idle. */
  function endOpenNote(): Promise<void> {
    void start();
    if (!noteOpen) return Promise.resolve();
    return closeNote();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: PASS — every test in the file, including the four foundations session tests and the existing full-state `toEqual` assertions.

- [ ] **Step 5: Check types and lint**

Run: `npx tsc -b && npx eslint src/capture/engine.ts src/capture/engine.test.ts`
Expected: no output from either.

- [ ] **Step 6: Commit**

```bash
git add src/capture/engine.ts src/capture/engine.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): real startSession/endSession with session state for the UI

One internal opener serves bare notes and manual sessions, and it reports the
ids from inside the op - two concurrent startSession calls each got the newer
session id before. A manual session publishes sessionStartedAt on the state
object (types.ts is not P3's to edit), absent for bare notes and when idle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Engine — serialization, pen input during a session, recovery of an interrupted session

**Files:**
- Test: `src/capture/engine.test.ts` (append)
- Modify (only if a test reveals a defect): `src/capture/engine.ts`

**Interfaces:**
- Consumes: everything Task 1 produced (`sessionStartedAtOf`, `startSession`, `endSession`, `LiveCaptureEngine`).
- Produces: nothing new. This task proves §3.1's rules still hold for the session flow.

- [ ] **Step 1: Write the failing tests**

Append inside the same `describe` in `src/capture/engine.test.ts`:

```ts
  it('keeps writing on the session note when the pen comes down', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();

    // No second note and no second session: the pen's auto-start only fires
    // when nothing is open.
    expect(await listNotes()).toHaveLength(1);
    expect(await listSessions()).toHaveLength(1);
    expect(engine.getState().activeNoteId).toBe(noteId);
    expect(engine.getState().activeSessionId).toBe(sessionId);
    const pages = await listPages(noteId);
    expect(pages).toHaveLength(1);
    expect(pages[0].strokes).toHaveLength(1);
  });

  it('serializes a session start, a page turn and a session end fired together', async () => {
    await engine.start();

    const starting = engine.startSession({ title: 'Seminar' });
    const turning = engine.newPage('device-turn');
    const ending = engine.endSession();
    const [{ sessionId, noteId }] = await Promise.all([starting, turning, ending]);

    // Queued, never interleaved: one note, pages 0 and 1, both finalized.
    expect(await listNotes()).toHaveLength(1);
    const pages = await listPages(noteId);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    for (const page of pages) expect(page.finalizedAt).not.toBeNull();
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
    expect(engine.getState()).toEqual(IDLE);
  });

  it('recovers a session interrupted by a reload', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();
    // A reload or crash: nothing ended the session.
    engine.dispose();

    const next = createCaptureEngine({ controller: fake });
    const finalized = vi.fn();
    next.subscribePageFinalized(finalized);
    await next.start();

    expect(await getNote(noteId)).toMatchObject({ status: 'interrupted' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
    const pages = await listPages(noteId);
    expect(pages[0].finalizedAt).not.toBeNull();
    // The recovered page still queues for transcription.
    expect(finalized).toHaveBeenCalledWith(pages[0].id);
    expect(next.getState()).toEqual(IDLE);
    next.dispose();
  });
```

- [ ] **Step 2: Run them to verify they fail (or, for the ones that pass, that they pass for the right reason)**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: the three tests run. Recovery and pen auto-start are existing behaviour, so those two may pass immediately — that is the point of writing them: they pin rules the session flow must not break. If any of the three fails, fix `src/capture/engine.ts` (not the test) and say in the commit what was wrong.

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: 70 files, 769 + the new tests, all passing.

- [ ] **Step 4: Check types and lint**

Run: `npx tsc -b && npx eslint src/capture/engine.ts src/capture/engine.test.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/capture/engine.ts src/capture/engine.test.ts
git commit -m "$(cat <<'EOF'
test(capture): pin session serialization, pen input and reload recovery

Session start, page turn and session end fired in one tick queue instead of
interleaving; the pen writes onto the session's note rather than opening a
second one; a session left open by a reload comes back interrupted, its
session ended and its page finalized and queued.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `SessionControls` — the control, its states, and starting a session

**Files:**
- Modify: `src/capture/SessionControls.tsx` (replace the placeholder body, keep the export name and `aria-label="Session"`)
- Test: `src/capture/SessionControls.test.tsx` (create)

**Interfaces:**
- Consumes: `sessionStartedAtOf` from `@/capture/engine` (Task 1); `useCaptureEngine` from `@/capture/CaptureContext`; `useHuionDevice` from `@/device/TabletProvider`; `getAudioRuntime`, `startAudioRuntime` from `@/audio/audioRuntime`; `formatClock` from `@/audio/format`; `Recorder`, `RecorderLink` types from `@/audio/recorder`; `Button` from `@/components/ui/button`; `DeviceController` from `@/device/controller`; `CaptureEngine` from `@/capture/types`.
- Produces:
  ```ts
  /** AppShell's mount point. No props (architecture §6.7). */
  export function SessionControls(): React.JSX.Element;
  /** The logic and markup, with every dependency injected. Tests render this. */
  export interface SessionPanelProps {
    engine: CaptureEngine;
    controller: DeviceController;
    recorder: Recorder;
    /** Clock for the elapsed time. Defaults to `Date.now`. */
    now?: () => number;
  }
  export function SessionPanel(props: SessionPanelProps): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/capture/SessionControls.test.tsx`:

```tsx
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

    // The pad has not come back yet, so the start is still running and the
    // button is disabled. An impatient second click on it must neither start a
    // second session nor end the one that just opened.
    const busy = [...container.querySelectorAll('button')].find((el) => el.disabled);
    expect(busy).toBeTruthy();
    await click(busy as HTMLButtonElement);
    release?.();
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
    release?.();
    await settle();

    expect(logged.mock.calls.filter(([m]) => String(m).includes('Warning'))).toEqual([]);
    logged.mockRestore();
    // A fresh root, so afterEach's unmount has something to unmount.
    root = createRoot(container);
  });
});
```

Note: this file uses real timers throughout — `resetDatabase()`, the engine's flush timer and the panel's one-second tick all depend on them. Do not introduce `vi.useFakeTimers()` here.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/capture/SessionControls.test.tsx`
Expected: FAIL — `SessionPanel` is not exported from `@/capture/SessionControls`.

- [ ] **Step 3: Implement the panel**

Replace `src/capture/SessionControls.tsx` (the start path and the display; Task 4 adds the end path and the interrupted notice — write `end()` as specified here so Task 4 only adds its tests and the notice):

```tsx
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, Play, Square } from 'lucide-react';

import { getAudioRuntime, startAudioRuntime } from '@/audio/audioRuntime';
import { formatClock } from '@/audio/format';
import type { Recorder } from '@/audio/recorder';
import { useCaptureEngine } from '@/capture/CaptureContext';
import { sessionStartedAtOf } from '@/capture/engine';
import type { CaptureEngine } from '@/capture/types';
import { Button } from '@/components/ui/button';
import type { DeviceController } from '@/device/controller';
import { useHuionDevice } from '@/device/TabletProvider';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SessionPanelProps {
  engine: CaptureEngine;
  controller: DeviceController;
  recorder: Recorder;
  /** Clock for the elapsed time. Defaults to `Date.now`. */
  now?: () => number;
}

type Phase = 'idle' | 'starting' | 'ending';

/**
 * P3 (docs/features/p3-spec.md): start a session - one Session, one Note in it,
 * one recording - show its elapsed time, whether audio is recording and the
 * device link, and end all of it together (spec J4).
 *
 * Everything is injected so the panel can be tested against the real engine, a
 * fake device controller and a fake recorder without a provider;
 * `SessionControls` below is the wrapper `AppShell` mounts.
 *
 * Order matters twice. The engine never touches the recorder (architecture
 * §6.5), so the session is started first and the recorder second, and an audio
 * failure is *reported*, never unwound (A28: writing is never blocked). The pad
 * is ensured before the microphone because `requestDevice()` needs the user
 * activation that awaiting `getUserMedia()`'s prompt would consume (P3-A2).
 */
export function SessionPanel({ engine, controller, recorder, now = Date.now }: SessionPanelProps) {
  const capture = useSyncExternalStore(engine.subscribe, engine.getState);
  const device = useSyncExternalStore(controller.subscribeState, controller.getState);
  const audio = useSyncExternalStore(recorder.subscribe, recorder.getState);

  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const startedAt = sessionStartedAtOf(capture);
  const isActive = startedAt !== null;
  const recording = audio.status === 'recording' || audio.status === 'stopping';

  // Alive only while mounted: a start that resolves after an unmount must not
  // set state (React logs a warning) - and must not throw either.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One tick a second while a session runs, so the clock moves without the
  // engine having to publish anything.
  useEffect(() => {
    if (!isActive) return;
    const handle = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [isActive]);

  const start = useCallback(async () => {
    setPhase('starting');
    setSessionError(null);
    setDeviceError(null);
    setAudioError(null);

    let ids: { sessionId: string; noteId: string };
    try {
      ids = await engine.startSession();
    } catch (error) {
      console.error('[session] starting the session failed', error);
      if (mounted.current) {
        setSessionError(messageOf(error));
        setPhase('idle');
      }
      return;
    }

    // The pad: connect and stream, which is all F4's page-turn capture needs -
    // `attachPageTurnCapture` (mounted once by AppShell) starts the controller's
    // capture itself as soon as both are true.
    try {
      const state = controller.getState();
      if (!state.isConnected) {
        await controller.connect();
        await controller.startStreaming();
      } else if (!state.isStreaming) {
        await controller.startStreaming();
      }
    } catch (error) {
      console.error('[session] the pad could not be started', error);
      if (mounted.current) setDeviceError(messageOf(error));
    }

    // Audio last, and never fatal: the session is already capturing.
    try {
      await recorder.start(ids);
      const after = recorder.getState();
      if (after.status !== 'recording') {
        if (mounted.current) setAudioError(after.error ?? 'Recording did not start');
      }
    } catch (error) {
      console.error('[session] recording could not start', error);
      if (mounted.current) setAudioError(messageOf(error));
    }

    if (mounted.current) setPhase('idle');
  }, [controller, engine, recorder]);

  const end = useCallback(async () => {
    setPhase('ending');
    try {
      await engine.endSession();
    } catch (error) {
      console.error('[session] ending the session failed', error);
      if (mounted.current) setSessionError(messageOf(error));
    } finally {
      // Always: the audio is in memory (A11) and only `stop()` saves it and
      // queues its transcription.
      try {
        await recorder.stop();
      } catch (error) {
        console.error('[session] stopping the recording failed', error);
        if (mounted.current) setAudioError(messageOf(error));
      }
      if (mounted.current) setPhase('idle');
    }
  }, [engine, recorder]);

  const link = device.isReconnecting
    ? 'Reconnecting...'
    : device.isConnected
      ? device.isStreaming
        ? `Pad connected${device.deviceName ? ` · ${device.deviceName}` : ''}`
        : 'Pad connected, not streaming'
      : 'Pad not connected';

  return (
    <div aria-label="Session" className="flex flex-wrap items-center gap-2">
      {isActive ? (
        <Button variant="destructive" size="sm" disabled={phase !== 'idle'} onClick={() => void end()}>
          <Square />
          {phase === 'ending' ? 'Ending...' : 'End session'}
        </Button>
      ) : (
        <Button variant="default" size="sm" disabled={phase !== 'idle'} onClick={() => void start()}>
          <Play />
          {phase === 'starting' ? 'Starting...' : 'Start session'}
        </Button>
      )}

      {isActive && (
        <>
          <span data-testid="session-elapsed" className="text-sm tabular-nums">
            {formatClock(now() - startedAt)}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {recording ? <Mic className="size-3" /> : <MicOff className="size-3" />}
            {recording ? 'Recording' : 'No audio'}
          </span>
          <span className="text-xs text-muted-foreground">{link}</span>
        </>
      )}

      {sessionError && (
        <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
          {sessionError}
          <button type="button" className="underline" onClick={() => setSessionError(null)}>
            Dismiss
          </button>
        </span>
      )}
      {deviceError && (
        <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
          {deviceError}
          <button type="button" className="underline" onClick={() => setDeviceError(null)}>
            Dismiss
          </button>
        </span>
      )}
      {audioError && (
        <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
          {audioError}
          <button type="button" className="underline" onClick={() => setAudioError(null)}>
            Dismiss
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * AppShell's mount point (docs/architecture.md §6.7): no props, reads the
 * engine, the device controller and the app-wide recorder singleton - the same
 * instance `RecorderControl` drives (P3-A3), so a session's recording and the
 * header's Record button can never be two different recordings.
 */
export function SessionControls() {
  const engine = useCaptureEngine();
  const { controller } = useHuionDevice();
  const [recorder] = useState<Recorder>(() => getAudioRuntime().recorder);

  useEffect(() => {
    startAudioRuntime();
  }, []);

  return <SessionPanel engine={engine} controller={controller} recorder={recorder} />;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/capture/SessionControls.test.tsx src/app/AppShell.test.tsx`
Expected: PASS, including AppShell's `aria-label="Session"` assertion.

- [ ] **Step 5: Check types and lint**

Run: `npx tsc -b && npx eslint src/capture/SessionControls.tsx src/capture/SessionControls.test.tsx`
Expected: no output. If `react-hooks/set-state-in-effect` warns, the fix is to move the `setState` behind an `await`/callback, not to disable the rule.

- [ ] **Step 6: Commit**

```bash
git add src/capture/SessionControls.tsx src/capture/SessionControls.test.tsx
git commit -m "$(cat <<'EOF'
feat(capture): SessionControls starts a session, the pad and the recording

One click opens the session, ensures the pad is connected and streaming (which
is all F4's page-turn capture needs) and starts the app's recorder. A refused
microphone or a pad that will not connect is shown plainly and the session keeps
capturing handwriting (A28).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `SessionControls` — ending a session, and interrupted sessions

**Files:**
- Modify: `src/capture/SessionControls.tsx` (add the interrupted notice; `end()` already exists from Task 3)
- Test: `src/capture/SessionControls.test.tsx` (append)

**Interfaces:**
- Consumes: `SessionPanel`, `SessionPanelProps` (Task 3); `listNotes` from `@/storage/notes`; `NoteRecord` from `@/storage/types`.
- Produces:
  ```ts
  /**
   * The note whose session was interrupted, or null. Newest-first input
   * (`listNotes()`).
   */
  export function interruptedNoteOf(notes: NoteRecord[], activeNoteId: string | null): NoteRecord | null;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/capture/SessionControls.test.tsx` (add `createNote` from `@/storage/notes` and `interruptedNoteOf` from `@/capture/SessionControls` to the imports):

```tsx
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

  it('says a session was interrupted and its recording lost', async () => {
    await createNote({
      title: 'Interrupted seminar',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      startedAt: 5_000,
    });
    render();
    await settle();

    expect(panel().textContent).toContain('interrupted');
    expect(panel().textContent).toContain('recording was lost');

    await click(button('Dismiss'));
    expect(panel().textContent).not.toContain('recording was lost');
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
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/capture/SessionControls.test.tsx`
Expected: FAIL — `interruptedNoteOf` is not exported and no notice is rendered. ("ends the session and the recording together" and the bare-note test should already pass from Task 3.)

- [ ] **Step 3: Implement the notice**

In `src/capture/SessionControls.tsx` add the helper above `SessionPanel`:

```tsx
/**
 * The note whose session was interrupted by a reload or crash, or null. Only the
 * newest note counts: once a later session has run, the old notice is stale.
 *
 * `active` counts as interrupted when it is not the note being written now -
 * the engine's startup recovery may not have flipped it to `interrupted` yet,
 * and it means the same thing to the person reading the header (P3-A4). One
 * session is one note (J4), so an interrupted note is an interrupted session.
 */
export function interruptedNoteOf(
  notes: NoteRecord[],
  activeNoteId: string | null,
): NoteRecord | null {
  const newest = notes.find((note) => !note.legacy);
  if (!newest || newest.id === activeNoteId) return null;
  if (newest.status === 'interrupted' || newest.status === 'active') return newest;
  return null;
}
```

with `import { listNotes } from '@/storage/notes';` and `import type { NoteRecord } from '@/storage/types';`.

Inside `SessionPanel`, after the other state:

```tsx
  const [interrupted, setInterrupted] = useState<NoteRecord | null>(null);
  const [dismissedNoteId, setDismissedNoteId] = useState<string | null>(null);

  // Re-read when the active note changes: that covers the first render (where
  // the engine's startup recovery may still be in flight), a note the pen
  // auto-starts, and a session that just ended.
  useEffect(() => {
    let alive = true;
    void listNotes()
      .then((notes) => {
        if (alive) setInterrupted(interruptedNoteOf(notes, capture.activeNoteId));
      })
      .catch((error: unknown) => {
        console.error('[session] reading the notes list failed', error);
      });
    return () => {
      alive = false;
    };
  }, [capture.activeNoteId]);
```

and, in the markup after the error lines:

```tsx
      {interrupted && interrupted.id !== dismissedNoteId && (
        <span role="status" className="flex items-center gap-1 text-xs text-amber-600">
          {`"${interrupted.title}" was interrupted; its audio recording was lost.`}
          <button
            type="button"
            className="underline"
            onClick={() => setDismissedNoteId(interrupted.id)}
          >
            Dismiss
          </button>
        </span>
      )}
```

The copy must contain the words `interrupted` and `recording was lost` (the tests assert them, and A11 says the audio is genuinely gone — never imply it will come back).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/capture/SessionControls.test.tsx src/app/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Whole suite, types, lint, build**

Run: `npx vitest run && npx tsc -b && npx eslint src/capture/SessionControls.tsx src/capture/SessionControls.test.tsx src/capture/engine.ts src/capture/engine.test.ts && npm run build`
Expected: all tests pass (769 baseline plus the new ones), no type errors, no lint output, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/capture/SessionControls.tsx src/capture/SessionControls.test.tsx
git commit -m "$(cat <<'EOF'
feat(capture): end a session together with its recording, surface interruptions

Ending finalizes the page, completes the note and ends the session, and stops
the recorder in a finally so the audio is saved and queued whatever the note
did. A reload leaves the newest note interrupted; the header says so and says
the recording was lost (A11), rather than pretending it will return.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Verification and docs

**Files:**
- Modify: none (unless verification finds something)

- [ ] **Step 1: Full verification**

Run each and read the output: `npm run build`, `npx vitest run`, `npx tsc -b`, `npx eslint src/capture/engine.ts src/capture/engine.test.ts src/capture/SessionControls.tsx src/capture/SessionControls.test.tsx`.
Expected: build succeeds; every test passes (769 existing + the new ones, with all four foundations session tests among them); no type errors; no lint output.

- [ ] **Step 2: Confirm no ownership breach**

Run: `git diff --name-only 2d66e5e..HEAD` (the branch base; `main...HEAD` would also list every Phase 2 foundations file this branch inherited)
Expected: only `docs/features/p3-spec.md`, `docs/features/p3-plan.md`, `src/capture/engine.ts`, `src/capture/engine.test.ts`, `src/capture/SessionControls.tsx`, `src/capture/SessionControls.test.tsx`.

- [ ] **Step 3: Commit the docs**

```bash
git add docs/features/p3-spec.md docs/features/p3-plan.md
git commit -m "$(cat <<'EOF'
docs: P3 session spec and plan

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
