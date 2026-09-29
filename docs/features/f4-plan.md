# F4 Page Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A physical page turn (from the device controller's detection) or the on-screen "New page" button makes the capture engine start a new page, while page-turn capture (poll, liveness, reconnect) runs whenever the pad is connected and streaming.

**Architecture:** A plain module `attachPageTurnCapture` owns the controller's capture lifecycle and forwards page-turn events to `engine.newPage('device-turn')`; `usePageTurnCapture` is a one-effect wrapper. `PageTurnControls` renders the manual button and a transient "Page N" indicator driven by a pure `isPageTurn` helper. Everything is tested against a stub `CaptureEngine` and `createFakeDeviceController`, never the placeholder engine (F1 replaces it).

**Tech Stack:** React 19, TypeScript 5.9, Vitest 3 + happy-dom, no testing-library (render with `createRoot` + `act`).

**Spec:** `docs/features/f4-spec.md` (read its "Design" and "Assumptions" sections before starting any task).

**Execution note:** Task 1's stop rule as written below stops on the real controller's first drop emission and cancels auto-reconnect. Review caught it; the shipped code defers the stop by one microtask and adds an integration test against the real controller (commit d0c6486, spec F4-A12). The code below is the original plan text.

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/f4-page-turn` (branch `notes/f4-page-turn`). Never push. Never bare `git stash`.
- Edit only: `src/capture/usePageTurnCapture.ts`, `src/capture/PageTurnControls.tsx`, new files `src/capture/pageTurn*.ts(x)` and their tests. Do NOT edit `src/capture/engine.ts`, `src/capture/types.ts`, `src/capture/CaptureContext.tsx`, `src/notes/**`, `src/app/**`, `src/main.tsx`, `src/storage/**`, `src/device/**`, `src/utils/huion*`, `src/test/**`.
- Import alias `@/` = `src/`. Tests sit beside sources as `*.test.ts(x)`.
- Component tests set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and render with `createRoot` inside `act` (pattern: `src/app/DeviceStatus.test.tsx`).
- Error logging uses `console.error` with a `[page-turn]` prefix.
- Indicator duration: 2000 ms. Indicator text: `Page {pageIndex + 1}`. Button text: `New page` (AppShell test asserts it).
- Every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commands: single test file `npx vitest run <path>`; all tests `npx vitest run`; lint `npx eslint <files>`; build `npm run build`.
- No new lint errors or warnings in touched files (the config warns on `react-hooks/set-state-in-effect` and `react-hooks/refs`: do not call setState synchronously in an effect body and do not read refs during render).

## Review Focus

1. Reconnect gives up, then the user reconnects with the button: capture must start again (Task 1 test "restarts after a give-up and a manual reconnect").
2. `startCapture` throws synchronously while `stopCapture` emits a state change: must not recurse into an endless start/stop loop (Task 1 test "does not loop when startCapture throws and stopCapture emits").
3. `startCapture` rejects after the capture was detached: the error is reported but nothing is started or stopped again (Task 1 test "a late startCapture failure after detach touches nothing").
4. The note ends while the "Page N" indicator is showing: the indicator must still hide on its timer, not stick (Task 3 test "still hides when the note ends while it is showing").
5. `PageTurnControls` unmounts while a manual `newPage` is pending: resolving it later must not log errors (Task 3 test "unmounting mid-request is quiet").

---

### Task 1: Stub engine + page-turn capture logic (`pageTurnCapture.ts`)

**Files:**
- Create: `src/capture/pageTurnTestEngine.ts`
- Create: `src/capture/pageTurnCapture.ts`
- Test: `src/capture/pageTurnCapture.test.ts`

**Interfaces:**
- Consumes: `DeviceController`, `DeviceState` from `@/device/controller`; `CaptureEngine`, `CaptureState`, `NewPageReason` from `@/capture/types`; `createEmitter` from `@/device/emitter`; `createFakeDeviceController`, `FakeDeviceController` from `@/test/fakeDeviceController` (tests only).
- Produces:
  - `createStubCaptureEngine(initial?: Partial<CaptureState>): StubCaptureEngine` where `StubCaptureEngine extends CaptureEngine` with `readonly newPageCalls: NewPageReason[]`, `setState(patch: Partial<CaptureState>): void`, `newPageImpl: (reason: NewPageReason) => Promise<string | null>` (assignable; default advances the page when a note is active, resolves `null` otherwise). `startNote()` makes ids `note-N`, `session-N`, `page-N` and `pageIndex: 0`.
  - `attachPageTurnCapture(deps: PageTurnCaptureDeps): () => void` and `interface PageTurnCaptureDeps { controller: DeviceController; engine: Pick<CaptureEngine, 'newPage'>; onError?: (message: string, error: unknown) => void }`. Error messages used: `'startCapture failed'`, `'stopCapture failed'`, `'newPage failed'`. Default `onError` is `console.error(\`[page-turn] ${message}\`, error)`.

- [ ] **Step 1: Write the stub engine (test support, no test of its own)**

`src/capture/pageTurnTestEngine.ts`:

```ts
import type { CaptureEngine, CaptureState, NewPageReason } from '@/capture/types';
import { createEmitter } from '@/device/emitter';
import type { PageStroke } from '@/storage/types';

/**
 * A `CaptureEngine` for F4's tests. It implements only the interface, so the
 * tests keep meaning the same thing after F1 replaces the placeholder engine.
 */
export interface StubCaptureEngine extends CaptureEngine {
  /** Every `newPage` reason, in call order (recorded before `newPageImpl` runs). */
  readonly newPageCalls: NewPageReason[];
  /** Merges a patch into the state and notifies subscribers, as any engine change would. */
  setState(patch: Partial<CaptureState>): void;
  /** What `newPage` does. Reassign to make it reject, throw, or hang. */
  newPageImpl: (reason: NewPageReason) => Promise<string | null>;
}

const IDLE: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

const NO_STROKES: readonly PageStroke[] = [];

export function createStubCaptureEngine(initial: Partial<CaptureState> = {}): StubCaptureEngine {
  const stateEmitter = createEmitter<CaptureState>();
  const inkEmitter = createEmitter<void>();
  const finalizedEmitter = createEmitter<string>();
  const newPageCalls: NewPageReason[] = [];
  let state: CaptureState = { ...IDLE, ...initial };
  let counter = 0;
  const nextId = (kind: string) => `${kind}-${++counter}`;

  // A new object per change: useSyncExternalStore needs a new reference per
  // change and the same one in between.
  function setState(patch: Partial<CaptureState>) {
    state = { ...state, ...patch };
    stateEmitter.emit(state);
  }

  const engine: StubCaptureEngine = {
    newPageCalls,
    setState,
    async newPageImpl() {
      if (state.activeNoteId === null) return null;
      const pageId = nextId('page');
      setState({ activePageId: pageId, pageIndex: state.pageIndex + 1 });
      return pageId;
    },
    getState: () => state,
    subscribe: (fn) => stateEmitter.subscribe(fn),
    async startNote() {
      const noteId = nextId('note');
      setState({
        activeSessionId: nextId('session'),
        activeNoteId: noteId,
        activePageId: nextId('page'),
        pageIndex: 0,
      });
      return noteId;
    },
    async endNote() {
      setState({ ...IDLE });
    },
    newPage(reason) {
      newPageCalls.push(reason);
      // Called synchronously, so an impl that throws throws out of newPage.
      return engine.newPageImpl(reason);
    },
    getLiveStrokes: () => NO_STROKES,
    subscribeInk: (fn) => inkEmitter.subscribe(fn),
    subscribePageFinalized: (fn) => finalizedEmitter.subscribe(fn),
    dispose() {},
  };
  return engine;
}
```

- [ ] **Step 2: Write the failing tests**

`src/capture/pageTurnCapture.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachPageTurnCapture } from '@/capture/pageTurnCapture';
import { createStubCaptureEngine } from '@/capture/pageTurnTestEngine';
import type { DeviceState } from '@/device/controller';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';

const LIVE: Partial<DeviceState> = {
  isConnected: true,
  isStreaming: true,
  deviceName: 'Fake Huion Note',
  status: 'Live streaming',
};

/** Lets pending promise callbacks (a rejected newPage, a startCapture) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function lifecycle(controller: FakeDeviceController): string[] {
  return controller.calls.filter((c) => c === 'startCapture' || c === 'stopCapture');
}

function setup(initial: Partial<DeviceState> = {}) {
  const controller = createFakeDeviceController(initial);
  const engine = createStubCaptureEngine();
  const onError = vi.fn();
  const detach = attachPageTurnCapture({ controller, engine, onError });
  return { controller, engine, onError, detach };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachPageTurnCapture - capture lifecycle', () => {
  it('does not start capture while disconnected', () => {
    const { controller } = setup();
    expect(lifecycle(controller)).toEqual([]);
    expect(controller.isCapturing).toBe(false);
  });

  it('starts capture once when attached to a connected, streaming pad', () => {
    const { controller } = setup(LIVE);
    expect(lifecycle(controller)).toEqual(['startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('waits for streaming: connect alone is mid-handshake', async () => {
    const { controller } = setup();
    await controller.connect();
    expect(lifecycle(controller)).toEqual([]);
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture']);
  });

  it('does not start again on later state changes while capturing', () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ storedPageCount: 4 });
    controller.setDeviceState({ status: 'Something else' });
    expect(lifecycle(controller)).toEqual(['startCapture']);
  });

  it('keeps capture running through a reconnect and does not restart it', () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ status: 'Reconnect attempt 2' });
    // Driver handshake done, streaming not yet restored.
    controller.setDeviceState({ isConnected: true, isReconnecting: false });
    controller.setDeviceState({ isStreaming: true });
    expect(lifecycle(controller)).toEqual(['startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('stops capture once when the reconnect gives up', () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ isReconnecting: false });
    controller.setDeviceState({ status: 'Disconnected' });
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
  });

  it('restarts after a give-up and a manual reconnect', async () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ isReconnecting: false });
    await controller.connect();
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('stops on a manual disconnect and starts again on the next connect', async () => {
    const { controller } = setup(LIVE);
    await controller.disconnect();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
    await controller.connect();
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
  });

  it('stops capture once on detach and then ignores the controller', () => {
    const { controller, engine, detach } = setup(LIVE);
    detach();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);

    controller.emitPageTurn();
    controller.setDeviceState({ isConnected: false, isStreaming: false });
    controller.setDeviceState({ ...LIVE });
    expect(engine.newPageCalls).toEqual([]);
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
  });

  it('does not stop a capture it never started, and detach is idempotent', () => {
    const { controller, detach } = setup();
    detach();
    detach();
    expect(lifecycle(controller)).toEqual([]);
  });

  it('attach, detach, attach (StrictMode) leaves one capture and one subscription', () => {
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const first = attachPageTurnCapture({ controller, engine, onError: vi.fn() });
    first();
    attachPageTurnCapture({ controller, engine, onError: vi.fn() });

    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
    expect(controller.isCapturing).toBe(true);
    controller.emitPageTurn();
    expect(engine.newPageCalls).toEqual(['device-turn']);
  });
});

describe('attachPageTurnCapture - page turns', () => {
  it('turns into exactly one newPage("device-turn")', async () => {
    const { controller, engine } = setup(LIVE);
    await engine.startNote();

    controller.emitPageTurn({ storedPageCount: 3 });
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn']);
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('forwards every turn, with no local dedupe', async () => {
    const { controller, engine } = setup(LIVE);
    await engine.startNote();

    controller.emitPageTurn();
    controller.emitPageTurn();
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(engine.getState().pageIndex).toBe(2);
  });

  it('a turn with no active note is harmless (A7)', async () => {
    const { controller, engine, onError } = setup(LIVE);

    controller.emitPageTurn();
    await flush();
    controller.emitPageTurn();
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(engine.getState().activeNoteId).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(controller.isCapturing).toBe(true);
  });

  it('reports a rejected newPage and keeps forwarding', async () => {
    const { controller, engine, onError } = setup(LIVE);
    await engine.startNote();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);

    controller.emitPageTurn();
    await flush();

    expect(onError).toHaveBeenCalledWith('newPage failed', failure);
    expect(controller.isCapturing).toBe(true);

    engine.newPageImpl = async () => 'page-x';
    controller.emitPageTurn();
    await flush();
    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a newPage that throws synchronously', () => {
    const { controller, engine, onError } = setup(LIVE);
    const failure = new Error('boom');
    engine.newPageImpl = () => {
      throw failure;
    };

    expect(() => controller.emitPageTurn()).not.toThrow();
    expect(onError).toHaveBeenCalledWith('newPage failed', failure);
  });

  it('logs to console.error by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);
    attachPageTurnCapture({ controller, engine });

    controller.emitPageTurn();
    await flush();

    expect(spy).toHaveBeenCalledWith('[page-turn] newPage failed', failure);
  });
});

describe('attachPageTurnCapture - startCapture failures', () => {
  it('reports a rejected startCapture, cleans up, and retries on the next state change', async () => {
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const onError = vi.fn();
    const failure = new Error('not authenticated');
    const realStart = controller.startCapture;
    controller.startCapture = vi.fn(() => Promise.reject(failure));

    attachPageTurnCapture({ controller, engine, onError });
    await flush();

    expect(onError).toHaveBeenCalledWith('startCapture failed', failure);
    expect(controller.calls).toContain('stopCapture');

    controller.startCapture = vi.fn(realStart);
    controller.setDeviceState({ status: 'Live streaming again' });
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
    await flush();
    expect(controller.isCapturing).toBe(true);
  });

  it('does not loop when startCapture throws and stopCapture emits', () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    const start = vi.fn(() => {
      throw new Error('sync failure');
    });
    controller.startCapture = start;
    // The real controller's stopCapture publishes state; make the fake do so too.
    controller.stopCapture = () => controller.setDeviceState({ isReconnecting: false });

    attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });

    expect(start).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops right away when the pad disconnects while startCapture is pending', async () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    let finishStart: () => void = () => {};
    controller.startCapture = vi.fn(
      () => new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
    );

    attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });
    controller.setDeviceState({ isConnected: false, isStreaming: false });
    expect(lifecycle(controller)).toEqual(['stopCapture']);

    finishStart();
    await flush();
    expect(lifecycle(controller)).toEqual(['stopCapture']);
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a late startCapture failure after detach touches nothing', async () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    let failStart: (error: unknown) => void = () => {};
    controller.startCapture = vi.fn(
      () => new Promise<void>((_resolve, reject) => {
        failStart = reject;
      }),
    );

    const detach = attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });
    detach();
    expect(lifecycle(controller)).toEqual(['stopCapture']);

    const failure = new Error('late');
    failStart(failure);
    await flush();

    expect(onError).toHaveBeenCalledWith('startCapture failed', failure);
    expect(lifecycle(controller)).toEqual(['stopCapture']);
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
  });
});
```

Note: when `controller.startCapture` is replaced by a `vi.fn`, the fake no longer records `'startCapture'` in `calls`; that is why those tests count starts on the mock and `lifecycle()` shows only `stopCapture`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/capture/pageTurnCapture.test.ts`
Expected: FAIL (cannot resolve `@/capture/pageTurnCapture`).

- [ ] **Step 4: Write the implementation**

`src/capture/pageTurnCapture.ts`:

```ts
import type { CaptureEngine } from '@/capture/types';
import type { DeviceController, DeviceState } from '@/device/controller';

export interface PageTurnCaptureDeps {
  controller: DeviceController;
  engine: Pick<CaptureEngine, 'newPage'>;
  /** Defaults to `console.error` with a `[page-turn]` prefix. */
  onError?: (message: string, error: unknown) => void;
}

function logError(message: string, error: unknown) {
  console.error(`[page-turn] ${message}`, error);
}

/**
 * Keeps the controller's capture (page-turn poll, liveness, auto-reconnect)
 * running while the pad is connected and streaming, and turns every page-turn
 * event into `engine.newPage('device-turn')`. Returns a detach function.
 *
 * Lifecycle rules (docs/features/f4-spec.md):
 * - Start on connected AND streaming. `isConnected` goes true at
 *   'Authenticated', mid-handshake; streaming only starts after connect()
 *   resolves, so the first page-count poll never interleaves with the handshake.
 * - Never stop while reconnecting. The controller keeps its detector running
 *   through a drop so turns made while the link was down are recovered from the
 *   count; stopping would end the reconnect and re-anchor that baseline.
 * - Stop only on a full disconnect (not connected, not reconnecting): an app
 *   disconnect() or the reconnect policy giving up.
 */
export function attachPageTurnCapture(deps: PageTurnCaptureDeps): () => void {
  const { controller, engine } = deps;
  const onError = deps.onError ?? logError;

  let attached = true;
  // True between our startCapture() and our stopCapture(). Set before calling
  // the controller, because both calls publish state synchronously and land
  // back in evaluate() below.
  let owned = false;
  // Which start a late startCapture() failure belongs to.
  let attempt = 0;
  // Set while we clean up a failed start: the state that stopCapture()
  // publishes must not trigger an immediate retry (an endless loop when
  // startCapture throws synchronously).
  let recovering = false;

  function stop() {
    try {
      controller.stopCapture();
    } catch (error) {
      onError('stopCapture failed', error);
    }
  }

  function start() {
    owned = true;
    const myAttempt = ++attempt;
    const fail = (error: unknown) => {
      onError('startCapture failed', error);
      // Detached, stopped since, or superseded by a newer start: not ours to undo.
      if (!attached || !owned || myAttempt !== attempt) return;
      owned = false;
      recovering = true;
      try {
        stop();
      } finally {
        recovering = false;
      }
    };
    try {
      controller.startCapture().catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  function evaluate(state: DeviceState) {
    if (!attached || recovering) return;
    if (!owned && state.isConnected && state.isStreaming) {
      start();
    } else if (owned && !state.isConnected && !state.isReconnecting) {
      owned = false;
      stop();
    }
  }

  function onPageTurn() {
    if (!attached) return;
    try {
      // A null result means no active note (A7): nothing to do.
      Promise.resolve(engine.newPage('device-turn')).catch((error: unknown) => {
        onError('newPage failed', error);
      });
    } catch (error) {
      onError('newPage failed', error);
    }
  }

  // Page turns first, so no turn can slip between capture starting and the
  // subscription existing.
  const unsubscribeTurns = controller.subscribePageTurn(onPageTurn);
  const unsubscribeState = controller.subscribeState(evaluate);
  evaluate(controller.getState());

  return () => {
    if (!attached) return;
    attached = false;
    unsubscribeTurns();
    unsubscribeState();
    if (owned) {
      owned = false;
      stop();
    }
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/capture/pageTurnCapture.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 6: Lint the new files**

Run: `npx eslint src/capture/pageTurnCapture.ts src/capture/pageTurnCapture.test.ts src/capture/pageTurnTestEngine.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/f4-page-turn
git add src/capture/pageTurnTestEngine.ts src/capture/pageTurnCapture.ts src/capture/pageTurnCapture.test.ts
git commit -m "feat(capture): page-turn capture lifecycle and turn forwarding

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `usePageTurnCapture` hook

**Files:**
- Modify: `src/capture/usePageTurnCapture.ts` (replace the placeholder body; keep the export name)
- Test: `src/capture/usePageTurnCapture.test.tsx`

**Interfaces:**
- Consumes: `attachPageTurnCapture(deps): () => void` (Task 1); `createStubCaptureEngine()` (Task 1); `useHuionDevice()` from `@/device/TabletProvider`; `useCaptureEngine()` and `CaptureProvider` from `@/capture/CaptureContext`.
- Produces: `usePageTurnCapture(): void` (already called once by `AppShell`).

- [ ] **Step 1: Write the failing tests**

`src/capture/usePageTurnCapture.test.tsx`:

```tsx
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createStubCaptureEngine, type StubCaptureEngine } from '@/capture/pageTurnTestEngine';
import { usePageTurnCapture } from '@/capture/usePageTurnCapture';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';

// TabletProvider always builds a real controller, so the hook's only way to
// the device is mocked to hand out the fake instead.
const device = vi.hoisted(() => ({ controller: null as FakeDeviceController | null }));

vi.mock('@/device/TabletProvider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useHuionDevice() {
      const controller = device.controller!;
      const state = useSyncExternalStore(controller.subscribeState, controller.getState);
      return { controller, state };
    },
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let controller: FakeDeviceController;
let engine: StubCaptureEngine;
let renders = 0;

function Host() {
  renders++;
  usePageTurnCapture();
  return null;
}

function render({ strict = false } = {}) {
  const tree = (
    <CaptureProvider engine={engine}>
      <Host />
    </CaptureProvider>
  );
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function lifecycle(): string[] {
  return controller.calls.filter((c) => c === 'startCapture' || c === 'stopCapture');
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  controller = createFakeDeviceController({
    isConnected: true,
    isStreaming: true,
    status: 'Live streaming',
  });
  device.controller = controller;
  engine = createStubCaptureEngine();
  renders = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usePageTurnCapture', () => {
  it('starts capture and turns a device page turn into a new page', async () => {
    render();
    await act(async () => {
      await engine.startNote();
    });

    await act(async () => {
      controller.emitPageTurn({ storedPageCount: 2 });
    });

    expect(lifecycle()).toEqual(['startCapture']);
    expect(engine.newPageCalls).toEqual(['device-turn']);
  });

  it('under StrictMode, one turn makes exactly one page and capture is running', async () => {
    render({ strict: true });
    await act(async () => {
      await engine.startNote();
    });

    await act(async () => {
      controller.emitPageTurn();
    });

    expect(engine.newPageCalls).toEqual(['device-turn']);
    expect(controller.isCapturing).toBe(true);
    expect(lifecycle().at(-1)).toBe('startCapture');
  });

  it('stops capture on unmount', () => {
    render();
    act(() => root.unmount());
    expect(lifecycle()).toEqual(['startCapture', 'stopCapture']);
    expect(controller.isCapturing).toBe(false);
    // afterEach unmounts again; give it a fresh root to unmount.
    root = createRoot(container);
  });

  it('does not re-attach when device state re-renders the host', () => {
    render();
    const before = renders;

    act(() => controller.setDeviceState({ storedPageCount: 5 }));
    act(() => controller.setDeviceState({ status: 'Still streaming' }));

    expect(renders).toBeGreaterThan(before);
    expect(lifecycle()).toEqual(['startCapture']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/capture/usePageTurnCapture.test.tsx`
Expected: FAIL (the placeholder hook never starts capture: `expected [] to deeply equal ['startCapture']`).

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/capture/usePageTurnCapture.ts` with:

```ts
import { useEffect } from 'react';

import { useCaptureEngine } from '@/capture/CaptureContext';
import { attachPageTurnCapture } from '@/capture/pageTurnCapture';
import { useHuionDevice } from '@/device/TabletProvider';

/**
 * F4 (docs/architecture.md §3.5). Mounted once by `AppShell`. While the pad is
 * connected and streaming it keeps the controller's capture running (page-turn
 * polling, liveness, reconnect) and forwards every page-turn event to
 * `engine.newPage('device-turn')`. All the logic lives in
 * `attachPageTurnCapture`; this only ties it to the component's lifetime.
 *
 * Under StrictMode's double effect a connected pad sees startCapture,
 * stopCapture, startCapture - never two live subscriptions.
 */
export function usePageTurnCapture(): void {
  const { controller } = useHuionDevice();
  const engine = useCaptureEngine();

  useEffect(() => attachPageTurnCapture({ controller, engine }), [controller, engine]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/capture/usePageTurnCapture.test.tsx src/app/AppShell.test.tsx`
Expected: PASS (4 + 4 tests). AppShell uses the real `TabletProvider` controller, which is disconnected, so no capture starts there.

- [ ] **Step 5: Lint**

Run: `npx eslint src/capture/usePageTurnCapture.ts src/capture/usePageTurnCapture.test.tsx`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/f4-page-turn
git add src/capture/usePageTurnCapture.ts src/capture/usePageTurnCapture.test.tsx
git commit -m "feat(capture): usePageTurnCapture ties page-turn capture to the app shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `PageTurnControls` (New page button + Page N indicator)

**Files:**
- Create: `src/capture/pageTurnIndicator.ts`
- Test: `src/capture/pageTurnIndicator.test.ts`
- Modify: `src/capture/PageTurnControls.tsx` (replace the placeholder body; keep the export name)
- Test: `src/capture/PageTurnControls.test.tsx`

**Interfaces:**
- Consumes: `createStubCaptureEngine()` / `StubCaptureEngine` (Task 1: `newPageCalls`, `newPageImpl`, `setState`, `startNote`, `endNote`); `useCaptureEngine()`, `useCaptureState()`, `CaptureProvider` from `@/capture/CaptureContext`; `Button` from `@/components/ui/button`; `CaptureState` from `@/capture/types`.
- Produces: `isPageTurn(prev: CaptureState, next: CaptureState): boolean`, `PAGE_INDICATOR_MS = 2000`, `PageTurnControls()` component.

- [ ] **Step 1: Write the failing helper tests**

`src/capture/pageTurnIndicator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isPageTurn, PAGE_INDICATOR_MS } from '@/capture/pageTurnIndicator';
import type { CaptureState } from '@/capture/types';

const idle: CaptureState = { activeSessionId: null, activeNoteId: null, activePageId: null, pageIndex: -1 };
const page0: CaptureState = { activeSessionId: 's1', activeNoteId: 'n1', activePageId: 'p0', pageIndex: 0 };
const page1: CaptureState = { ...page0, activePageId: 'p1', pageIndex: 1 };
const otherNote: CaptureState = { activeSessionId: 's2', activeNoteId: 'n2', activePageId: 'q0', pageIndex: 0 };

describe('isPageTurn', () => {
  it('is a turn when the page changes within the same note', () => {
    expect(isPageTurn(page0, page1)).toBe(true);
  });

  it('is not a turn when a note starts, ends or is replaced', () => {
    expect(isPageTurn(idle, page0)).toBe(false);
    expect(isPageTurn(page1, idle)).toBe(false);
    expect(isPageTurn(page1, otherNote)).toBe(false);
  });

  it('is not a turn when the page did not change', () => {
    expect(isPageTurn(page0, { ...page0 })).toBe(false);
    expect(isPageTurn(idle, idle)).toBe(false);
  });

  it('shows the indicator for two seconds', () => {
    expect(PAGE_INDICATOR_MS).toBe(2000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/capture/pageTurnIndicator.test.ts`
Expected: FAIL (cannot resolve `@/capture/pageTurnIndicator`).

- [ ] **Step 3: Implement the helper**

`src/capture/pageTurnIndicator.ts`:

```ts
import type { CaptureState } from '@/capture/types';

/** How long the "Page N" indicator stays up after the most recent turn. */
export const PAGE_INDICATOR_MS = 2000;

/**
 * True when the active page changed within the same note - a device turn, the
 * "New page" button, or anything else that called `newPage`. Starting, ending
 * or switching notes is not a turn.
 */
export function isPageTurn(prev: CaptureState, next: CaptureState): boolean {
  return (
    prev.activeNoteId !== null &&
    prev.activeNoteId === next.activeNoteId &&
    next.activePageId !== null &&
    prev.activePageId !== next.activePageId
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/capture/pageTurnIndicator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing component tests**

`src/capture/PageTurnControls.test.tsx`:

```tsx
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { PageTurnControls } from '@/capture/PageTurnControls';
import { createStubCaptureEngine, type StubCaptureEngine } from '@/capture/pageTurnTestEngine';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: StubCaptureEngine;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createStubCaptureEngine();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render() {
  act(() => {
    root.render(
      <CaptureProvider engine={engine}>
        <PageTurnControls />
      </CaptureProvider>,
    );
  });
}

function button(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === 'New page');
  if (!found) throw new Error('no New page button');
  return found;
}

function indicator(): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function startNote() {
  await act(async () => {
    await engine.startNote();
  });
}

describe('PageTurnControls - New page button', () => {
  it('is disabled with no active note and enabled with one', async () => {
    render();
    expect(button().disabled).toBe(true);
    await startNote();
    expect(button().disabled).toBe(false);
  });

  it('calls newPage("manual") once per click', async () => {
    render();
    await startNote();
    await click(button());
    expect(engine.newPageCalls).toEqual(['manual']);
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('is disabled while its newPage is pending, so a double click makes one page', async () => {
    render();
    await startNote();
    let finish: (id: string | null) => void = () => {};
    engine.newPageImpl = () => new Promise((resolve) => {
      finish = resolve;
    });

    await click(button());
    expect(button().disabled).toBe(true);
    await click(button());
    expect(engine.newPageCalls).toEqual(['manual']);

    await act(async () => {
      finish('page-x');
    });
    expect(button().disabled).toBe(false);
  });

  it('logs a failed newPage and re-enables the button', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render();
    await startNote();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);

    await click(button());

    expect(spy).toHaveBeenCalledWith('[page-turn] manual new page failed', failure);
    expect(button().disabled).toBe(false);
  });

  it('unmounting mid-request is quiet', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render();
    await startNote();
    let finish: (id: string | null) => void = () => {};
    engine.newPageImpl = () => new Promise((resolve) => {
      finish = resolve;
    });

    await click(button());
    act(() => root.unmount());
    await act(async () => {
      finish('page-x');
    });

    expect(spy).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('PageTurnControls - Page N indicator', () => {
  it('shows the new page number after a turn, whatever caused it', async () => {
    render();
    await startNote();
    expect(indicator()).toBe('');

    // A device turn: the engine changes page without the button.
    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 2');

    await click(button());
    expect(indicator()).toBe('Page 3');
  });

  it('does not show when a note starts', async () => {
    render();
    await startNote();
    expect(indicator()).toBe('');
  });

  it('hides after two seconds, and a new turn restarts the timer', async () => {
    vi.useFakeTimers();
    render();
    await startNote();

    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 2');

    act(() => vi.advanceTimersByTime(1500));
    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 3');

    act(() => vi.advanceTimersByTime(1500));
    expect(indicator()).toBe('Page 3');

    act(() => vi.advanceTimersByTime(500));
    expect(indicator()).toBe('');
  });

  it('still hides when the note ends while it is showing', async () => {
    vi.useFakeTimers();
    render();
    await startNote();
    await act(async () => {
      await engine.newPage('device-turn');
    });
    await act(async () => {
      await engine.endNote();
    });

    act(() => vi.advanceTimersByTime(2000));
    expect(indicator()).toBe('');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/capture/PageTurnControls.test.tsx`
Expected: FAIL (placeholder button is always disabled; no `[role="status"]`).

- [ ] **Step 7: Implement the component**

Replace the whole of `src/capture/PageTurnControls.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { isPageTurn, PAGE_INDICATOR_MS } from '@/capture/pageTurnIndicator';
import { Button } from '@/components/ui/button';

/**
 * F4 (docs/architecture.md §3.5), mounted in the NotesView page toolbar: the
 * on-screen "New page" button - the fallback for when the pad is not reporting
 * turns (A9: pressing it and turning the paper page makes two pages) - and a
 * transient "Page N" indicator shown after any page turn in the active note.
 */
export function PageTurnControls() {
  const engine = useCaptureEngine();
  const { activeNoteId } = useCaptureState();
  const [pending, setPending] = useState(false);
  const [shownPage, setShownPage] = useState<number | null>(null);
  // Guards the gap between a click and the re-render that disables the button.
  const inFlight = useRef(false);

  // Subscribed directly rather than derived from useCaptureState in an effect:
  // the state change itself is the event, and setState happens in the
  // subscription callback rather than synchronously in the effect body.
  useEffect(() => {
    let previous = engine.getState();
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe((next) => {
      const turned = isPageTurn(previous, next);
      previous = next;
      if (!turned) return;
      setShownPage(next.pageIndex + 1);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        setShownPage(null);
      }, PAGE_INDICATOR_MS);
    });
    return () => {
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [engine]);

  async function newPage() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await engine.newPage('manual');
    } catch (error) {
      console.error('[page-turn] manual new page failed', error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        aria-live="polite"
        className="text-xs font-medium tabular-nums text-muted-foreground"
      >
        {shownPage !== null ? `Page ${shownPage}` : ''}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={activeNoteId === null || pending}
        title={activeNoteId === null ? 'Start writing to begin a note' : 'Finish this page and start a new one'}
        onClick={() => void newPage()}
      >
        New page
      </Button>
    </div>
  );
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/capture/PageTurnControls.test.tsx src/capture/pageTurnIndicator.test.ts src/app/AppShell.test.tsx`
Expected: PASS (9 + 4 + 4 tests).

- [ ] **Step 9: Lint**

Run: `npx eslint src/capture/PageTurnControls.tsx src/capture/PageTurnControls.test.tsx src/capture/pageTurnIndicator.ts src/capture/pageTurnIndicator.test.ts`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/f4-page-turn
git add src/capture/pageTurnIndicator.ts src/capture/pageTurnIndicator.test.ts src/capture/PageTurnControls.tsx src/capture/PageTurnControls.test.tsx
git commit -m "feat(capture): New page button and transient Page N indicator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Whole-branch verification and summary commit (orchestrator)

**Files:**
- Modify: `docs/features/f4-spec.md` (only if implementation deviated; append to Assumptions)
- Add: `docs/features/f4-spec.md`, `docs/features/f4-plan.md` (commit them)

- [ ] **Step 1: Full test run**

Run: `npx vitest run`
Expected: all pass; count = 241 baseline + new tests.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Lint touched files**

Run: `npx eslint src/capture`
Expected: no errors or warnings in F4 files.

- [ ] **Step 4: Commit the docs with the feature summary in the body**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/f4-page-turn
git add docs/features/f4-spec.md docs/features/f4-plan.md
git commit -m "docs(f4): page-turn feature spec, plan and summary

<summary paragraph: what shipped, test counts, key assumptions>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
