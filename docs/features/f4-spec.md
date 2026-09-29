# F4 — Page turn creates a new page: feature spec

Source requirements: `docs/spec.md` (F4, I5), `docs/architecture.md` (§3.1,
§3.5, §4), `docs/assumptions.md` (A7, A8, A9). Background:
`docs/superpowers/specs/2026-09-17-phase-2-session-engine-design.md` §5–§6.

## Goal

A physical page turn on the X10, as reported by the device controller's
page-turn detection, finalizes the current page and starts a new one in the
active note. An on-screen "New page" button does the same. Page-turn capture
(poll, liveness, reconnect) runs while the pad is connected. A turn with no
active note is ignored.

F4 only consumes existing layers: `DeviceController` (`src/device/controller.ts`)
and the `CaptureEngine` interface (`src/capture/types.ts`). It never depends on
the Phase 0 placeholder engine's internals, because F1 replaces that engine.

## What the controller already guarantees (read from `controller.ts`)

- `startCapture()` sets `capturing = true`, starts the liveness watchdog and the
  page-turn detector (baseline read of the stored page count), then publishes
  `storedPageCount`. `stopCapture()` stops detector, watchdog and reconnect
  policy and clears `isReconnecting`. Both are idempotent enough to call again.
- A drop while capturing (raw `'Disconnected'` status or watchdog verdict) sets
  `{ isConnected: false, isReconnecting: true }` and starts auto-reconnect. The
  detector is deliberately **kept running** across the gap so turns made while
  the link was down are recovered from the count on reconnect. Stopping capture
  during a reconnect would kill the reconnect and re-anchor the baseline,
  losing exactly those turns.
- Reconnect success sets `isReconnecting: false` (the driver's status updates
  flip `isConnected` back and restore streaming). Give-up sets
  `isReconnecting: false` with `isConnected` still false.
- `disconnect()` ends capture itself before closing the link, so a later
  `stopCapture()` is a harmless no-op.
- Nothing is gated on streaming, but `isConnected` becomes true at
  `'Authenticated'`, which is **mid-handshake** (before `connect()` resolves).
  `isStreaming` becomes true only after `connect()` has resolved and the
  streaming writes are done (`DeviceStatus` runs `connect()` then
  `startStreaming()`). Page turns only matter while pen data flows (D9: the
  stream is the source of truth).

## Design

### `src/capture/pageTurnCapture.ts` (plain module, the logic)

```ts
export interface PageTurnCaptureDeps {
  controller: DeviceController;
  engine: Pick<CaptureEngine, 'newPage'>;
  /** Defaults to console.error. Receives a message and the error. */
  onError?: (message: string, error: unknown) => void;
}
/** Attaches immediately; returns a detach function (idempotent). */
export function attachPageTurnCapture(deps: PageTurnCaptureDeps): () => void;
```

Capture lifecycle, evaluated on attach and on every `subscribeState` emission,
with a local `owned` flag ("we have called startCapture and not stopCapture"):

| Device state | `owned` false | `owned` true |
|---|---|---|
| `isConnected && isStreaming` | set `owned`, call `startCapture()` | nothing |
| `isReconnecting` | nothing | nothing (capture must survive the reconnect) |
| `!isConnected && !isReconnecting` (disconnected or reconnect gave up) | nothing | clear `owned`, call `stopCapture()` |
| connected but not streaming | nothing (handshake in progress) | nothing (e.g. streaming restore failed after reconnect; keep liveness/reconnect alive) |

- **The stop decision waits for the state to settle (one microtask).** On an
  unexpected drop the real controller emits state twice, synchronously:
  first `onStatus('Disconnected')` publishes `{ isConnected: false,
  isReconnecting: false }`, and only then does `handleDrop()` publish
  `isReconnecting: true`. Stopping on the first emission would flip the
  controller's `capturing` off, so `handleDrop()` would return early and
  auto-reconnect would never start. So a stop-looking state schedules a
  microtask that re-reads `controller.getState()` and stops only if it is
  still `!isConnected && !isReconnecting`.
- `owned` is updated **before** calling the controller, so the synchronous
  state emissions those calls cause (re-entrancy) are no-ops.
- `startCapture()` rejection or synchronous throw: report via `onError`,
  best-effort `stopCapture()` (wrapped), clear `owned`, so a later qualifying
  state change retries. No unhandled rejection.
- If the state goes to disconnected while `startCapture()` is still pending,
  `stopCapture()` is called once the state has settled, without waiting for the
  start to finish (the real controller tolerates this:
  detector generations discard the stale baseline).
- Detach: unsubscribe from state and page turns; if `owned`, call
  `stopCapture()` once. After detach, nothing more reaches the controller or
  the engine (late page-turn events and a late `startCapture` rejection are
  ignored, apart from error reporting).

Page turns: subscribe to `controller.subscribePageTurn` on attach; every event
calls `engine.newPage('device-turn')` exactly once. A `null` result (no active
note, A7) is ignored silently. A rejection or synchronous throw is reported via
`onError` and never propagates. The engine serializes `newPage` calls
(architecture §3.1), so F4 does not queue them; two quick turns make two pages
(A8).

### `src/capture/usePageTurnCapture.ts` (thin hook)

`usePageTurnCapture(): void` reads the controller with `useHuionDevice()` and the
engine with `useCaptureEngine()`, and runs
`useEffect(() => attachPageTurnCapture({ controller, engine }), [controller, engine])`.
Under StrictMode's double effect this yields `startCapture, stopCapture,
startCapture` against a connected pad and exactly one live page-turn
subscription, never two.

### `src/capture/pageTurnIndicator.ts` (pure helper)

`isPageTurn(prev: CaptureState, next: CaptureState): boolean` — true when both
states have the same non-null `activeNoteId` and a different non-null
`activePageId`. Starting, ending or switching notes is not a turn.

### `src/capture/PageTurnControls.tsx` (component)

- "New page" button (`Button`, `variant="outline"`, `size="sm"`): calls
  `engine.newPage('manual')`. Disabled while `activeNoteId === null` and while a
  `newPage` it started is in flight (prevents double pages on double click).
  Rejection is logged with `console.error` and the button re-enables.
- Transient indicator: when `isPageTurn(previousRenderedState, state)` (device
  or manual turn), shows `Page {pageIndex + 1}` in an element with
  `role="status"`; hides 2000 ms after the most recent turn (a new turn restarts
  the timer). The timer is cleared on unmount.

## Test list

`src/capture/pageTurnCapture.test.ts` (fake controller + stub engine)

1. Attaching while disconnected does not start capture.
2. Attaching while connected and streaming starts capture once.
3. Connect then stream: no `startCapture` after connect alone; exactly one after
   streaming starts.
4. Further state emissions while capturing (e.g. `storedPageCount` change,
   status text) do not start capture again.
5. Drop into reconnect (`isConnected: false, isReconnecting: true`) does not
   stop capture; reconnect success (connected + streaming again) does not start
   it a second time.
6. Reconnect gives up (`isReconnecting: false`, still disconnected) stops
   capture once.
7. Manual `disconnect()` leads to `stopCapture` and a later reconnect by the
   user (connect + stream) starts capture again.
8. Detach while capturing stops capture once and unsubscribes (later turns do
   not reach the engine; later state changes do not reach the controller).
9. Detach while never started does not call `stopCapture`; detach is idempotent.
10. Attach/detach/attach (StrictMode shape) leaves exactly one capture running
    and one subscription: one turn → one `newPage`.
11. A page turn calls `engine.newPage('device-turn')` exactly once.
12. Two turns call `newPage` twice (no local dedupe).
13. A turn with no active note (engine resolves `null`) is harmless: no error
    reported, capture keeps running, the next turn is still forwarded.
14. `newPage` rejecting is reported via `onError`, does not throw, and later
    turns still work; a synchronous throw likewise.
15. `startCapture` rejecting is reported, `stopCapture` is attempted, and the
    next qualifying state change retries.
16. Disconnect while `startCapture` is still pending calls `stopCapture`.
17. Default `onError` is `console.error`.
17a. A drop emitted in the real controller's two steps (`isConnected: false`,
     then `isReconnecting: true`) does not stop capture.
17b. `stopCapture` throwing is reported as `'stopCapture failed'`.

`src/capture/pageTurnCapture.integration.test.ts` (real `createDeviceController`
over `FakeHuionTransport`)

17c. A transport drop while capturing leaves the reconnect chase armed
     (`isReconnecting: true`) and F4 never calls `stopCapture`.
17d. Capture survives a full reconnect: one `startCapture`, no `stopCapture`.
17e. A real count-derived page turn reaches `engine.newPage('device-turn')`.

`src/capture/usePageTurnCapture.test.tsx` (hook, `useHuionDevice` mocked to the
fake controller, stub engine in `CaptureProvider`)

18. Mounted with a connected, streaming pad: capture starts; a turn calls
    `newPage('device-turn')`.
19. Under `<StrictMode>`: exactly one turn → exactly one `newPage`; capture is
    running after mount.
20. Unmount stops capture.
21. Re-renders of the host (device state changes) do not re-attach.

`src/capture/pageTurnIndicator.test.ts`

22. Same note, different page → true.
23. Note start (null → id), note end (id → null), note switch → false.
24. Same page (no change) → false.

`src/capture/PageTurnControls.test.tsx` (stub engine driven through
`CaptureProvider`)

25. Button is disabled with no active note, enabled with one.
26. Clicking calls `newPage('manual')` once.
27. Button is disabled while that `newPage` is pending; a second click does not
    call it again; re-enabled after it resolves.
28. A rejecting `newPage` logs and re-enables the button.
29. Indicator shows `Page 2` after a turn from page index 0 to 1 (manual or
    device — driven by engine state, not by the button).
30. Indicator hides after 2000 ms (fake timers); a second turn before then
    shows the new number and restarts the timer.
31. Starting a note does not show the indicator.
32. `AppShell` still renders "New page" (existing test stays green).

## Assumptions

- F4-A1 **Capture starts on connected *and* streaming**, not on connected
  alone. `isConnected` goes true at `'Authenticated'`, mid-handshake; starting
  the page-count poll there would interleave with the handshake. Streaming is
  the app's definition of "capturing" (D9), and `DeviceStatus` always streams
  after connecting.
- F4-A2 **Capture stops only on a full disconnect** (`!isConnected &&
  !isReconnecting`): an app `disconnect()`, or the reconnect policy giving up.
  While reconnecting, and while connected but not streaming after capture has
  started, capture is left running so liveness/reconnect keep working.
- F4-A3 After the reconnect policy gives up, F4 calls `stopCapture()`. The user
  reconnects with the Connect button; capture then starts again with a fresh
  baseline. Turns made between give-up and reconnect are not recovered (same
  as any disconnected period).
- F4-A4 StrictMode's double effect produces `startCapture, stopCapture,
  startCapture` on a connected pad. That is correct under the controller's
  contract (detector generations discard the stale baseline read); what F4
  guarantees is never two concurrent subscriptions or two starts without a stop.
- F4-A5 F4 forwards every turn and relies on the engine to serialize `newPage`
  and to return `null` with no active note (architecture §3.1, A7). It does not
  pre-check `activeNoteId`.
- F4-A6 Errors are logged with `console.error` and a `[page-turn]` prefix; no
  UI surface for them in Phase 1.
- F4-A7 The indicator shows for any page change within the same note, whether
  caused by the device, the button, or anything else that calls `newPage`. It
  does not show on note start. Duration 2000 ms.
- F4-A8 No keyboard shortcut in Phase 1 (optional per brief; avoids clashing
  with F1/F3 text inputs).
- F4-A9 A9 holds: button and physical turn are independent, so pressing both
  creates two pages.
- F4-A10 Tests use a stub `CaptureEngine` (`src/capture/pageTurnTestEngine.ts`)
  implementing the interface, not the placeholder engine, so they keep passing
  after F1 replaces `engine.ts`.
- F4-A11 The hook test mocks `@/device/TabletProvider`'s `useHuionDevice` to
  return the fake controller, since `TabletProvider` always builds a real
  controller.
- F4-A12 **The stop decision waits one microtask for the device state to
  settle** (deviation from the first plan draft, found in review). The real
  controller publishes a drop as `{ isConnected: false, isReconnecting: false }`
  and only then `isReconnecting: true`; stopping on the first emission would
  cancel auto-reconnect. Pinned by `pageTurnCapture.integration.test.ts`
  against the real `createDeviceController`.

## Known limitations and follow-ups (for the merger)

- Device layer (not F4's to fix): if a reconnect succeeds but restoring
  streaming fails (`huionBLE.reconnect()` swallows that error), the pad sits in
  `{ isConnected: true, isStreaming: false }` with a green status and no retry.
  F4 keeps capture running there (F4-A2), so page turns still create (empty)
  pages. The same state after the first connect means F4 never starts capture.
  Worth a follow-up: retry the restore, or show "connected, not streaming" as an
  actionable state in `DeviceStatus`.
- After F1 merges: move `src/capture/pageTurnTestEngine.ts` and the
  `pageCountFake` copy in `pageTurnCapture.integration.test.ts` into `src/test/`
  (F4 could not edit `src/test/**`).
