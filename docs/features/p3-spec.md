# P3 — Manual session start, automatic recording and grouping: feature spec

Source requirements: `docs/spec-phase2.md` (P3, decision J4 — one session is one
note plus one recording, started and ended together), `docs/architecture.md`
(§6.5 P3 contract, §3.1 engine behavioural rules, §6.7 ownership),
`docs/assumptions.md` (A10, A11, A28).

## Goal

One control in the header starts a session: the engine creates a `Session`, a
`Note` in it and the note's first page, the UI ensures the pad is connected and
streaming (so F4's page-turn capture runs) and starts audio recording. While the
session runs the header shows its elapsed time, whether audio is recording and
the device link. Ending the session finalizes the page, completes the note, ends
the session and stops the recording, which queues its transcription through the
existing audio queue.

Two rules shape everything:

- **The engine must not depend on the recorder** (§6.5). `SessionControls` calls
  `engine.startSession()` and *then* the recorder; an audio failure is reported
  without unwinding the session.
- **Audio must never block writing** (A28). A refused microphone, an
  unsupported browser, a pad that will not connect: each is shown plainly and
  the session keeps capturing handwriting.

## What already exists (read from the code)

- `src/capture/types.ts` (frozen, foundations-owned) declares
  `startSession(opts?): Promise<{ sessionId: string; noteId: string }>` and
  `endSession(): Promise<void>` on `CaptureEngine`, and `CaptureState` with
  exactly `activeSessionId`, `activeNoteId`, `activePageId`, `pageIndex`.
- `src/capture/engine.ts` ships thin delegation: `startSession` awaits
  `startNote` then reads `state.activeSessionId`; `endSession` calls the same
  `closeNote()` path as `endNote`. Four tests in `engine.test.ts` pin the
  contract. Phase 1's `startNote` already creates exactly one `Session` per
  note, so the *records* are right; what is missing is the real flow (below).
- `src/capture/SessionControls.tsx` is a placeholder rendering
  `<span aria-label="Session">`; `AppShell` mounts it in the header and
  `AppShell.test.tsx` asserts that label. Both stay.
- `usePageTurnCapture()` is mounted once by `AppShell`; `attachPageTurnCapture`
  starts the controller's capture by itself as soon as the pad is **connected
  and streaming**. So "ensure page-turn capture is running" means nothing more
  than getting the pad connected and streaming — P3 must not call
  `startCapture`/`stopCapture` itself.
- `getAudioRuntime().recorder` is the app-wide `Recorder` singleton that
  `RecorderControl` already uses; `onSaved` enqueues the recording on the
  transcription queue. `recorder.start(link)` never throws for a refused
  microphone — it resolves with `status: 'idle'` and a human-readable `error`.
- Startup recovery in the engine already marks notes left `active` as
  `interrupted`, ends their sessions, finalizes unfinalized pages and then ends
  any remaining `active` session.

## Design

### 1. Engine — `src/capture/engine.ts`

**One opener, two entry points.** The body of today's `startNote` op becomes an
internal `openNote(opts: { title?: string; session: 'own' | 'manual' })` that
creates the session, the note (with `sessionId`) and page 0, publishes the state
and returns `{ sessionId, noteId }` **from inside the op**.

- `startNote(opts?)` → `openNote({ ..., session: 'own' })`, resolving the note
  id. Behaviour unchanged: bare notes and pen-input auto-start keep working, and
  a bare note still gets its own session record (Phase 1 shape, A10 unchanged).
- `startSession(opts?)` → `openNote({ ..., session: 'manual' })`, resolving both
  ids. Ends any active note first (synchronously flipping `noteOpen`, exactly as
  `startNote` does, so a `newPage`/`endNote` arriving meanwhile queues behind the
  creation rather than being dropped).

This fixes a real defect in the delegation: it reads `state.activeSessionId`
*after* awaiting, so two `startSession()` calls in one tick can each report the
other's session id. Ids are captured inside the op instead.

**`endSession()`** keeps calling the same `closeNote()` path — finalize the page,
`status: 'complete'` on the note, `status: 'ended'` on the session, state back to
idle — and stays a no-op when idle. `endNote()` is unchanged, so whichever way a
session's note is closed, the session is ended and the UI sees it.

**Session state for the UI.** `CaptureState` has no field for "a manual session
is open" or for its start time, and `types.ts` is not P3's to edit (§6.7). The
engine therefore publishes an **additive** optional field on the same state
object:

```ts
export interface LiveCaptureState extends CaptureState {
  /** Present only while a session started by `startSession()` is open. */
  sessionStartedAt?: number;
}
export function sessionStartedAtOf(state: CaptureState): number | null;
export interface LiveCaptureEngine extends CaptureEngine {
  getState(): LiveCaptureState;
  // ...start(), flush() as today
}
```

`sessionStartedAt` is **absent** (not `null`) while idle and for bare notes, so
every existing full-state `toEqual` assertion keeps passing, and consumers that
only know `CaptureState` are unaffected. `sessionStartedAtOf` is what
`SessionControls` reads, so it never has to cast. Nothing in `types.ts` changes;
this is reported as assumption P3-A1 rather than a contract edit.

Everything else in §3.1 stands unchanged: serialized `newPage`/`endNote`
(and now `startSession`/`endSession`) on the one op chain, incremental stroke
persistence, `t`/`startedAt`/`endedAt` on points and strokes, startup recovery.

### 2. `src/capture/SessionControls.tsx`

Two exports in one file, so the app keeps one mount point and the logic is
testable without a `TabletProvider`:

```tsx
/** AppShell's mount point. No props (§6.7); reads the hooks and the audio singleton. */
export function SessionControls(): JSX.Element;

/** The logic and the markup. Tests render this with fakes. */
export function SessionPanel(props: {
  engine: CaptureEngine;
  controller: DeviceController;
  recorder: Recorder;
  now?: () => number;
}): JSX.Element;
```

`SessionControls` calls `useCaptureEngine()`, `useHuionDevice()` and
`getAudioRuntime().recorder` (memoized in a `useState` initializer, as
`RecorderControl` does) and renders `SessionPanel`. `SessionPanel` subscribes to
the engine and the controller with `useSyncExternalStore`, so a test drives it
with `createCaptureEngine({ controller: createFakeDeviceController() })` and a
fake recorder and needs no provider.

The whole block renders inside `<div aria-label="Session">` — the label the host
test asserts.

**Start (one click).**

1. `phase = 'starting'`, previous errors cleared.
2. `const { sessionId, noteId } = await engine.startSession()`. If this rejects:
   show a session error, stay idle, do not touch the pad or the microphone —
   there is nothing to record into.
3. Ensure the pad, tolerating failure: `if (!isConnected) { await connect();
   await startStreaming(); } else if (!isStreaming) { await startStreaming(); }`.
   A rejection (the commonest being a dismissed Bluetooth chooser) becomes a
   device error; the session continues, and audio still starts — "a session with
   no pad still records audio". Page-turn capture needs nothing more: F4's
   attachment starts it on connected+streaming.
4. Ensure audio, tolerating failure: `await recorder.start({ sessionId, noteId
   })`, then read `recorder.getState()`; anything other than `status:
   'recording'` becomes an audio error carrying the recorder's own message
   (mic denied / no microphone / not supported). A throw is treated the same
   way. The session keeps running and keeps capturing handwriting (A28).
5. `phase = 'idle'` (the session itself is now visible through the engine state).

The pad is ensured **before** the microphone on purpose: `requestDevice()` needs
user activation, which awaiting `getUserMedia()`'s prompt would consume
(P3-A2).

**During.** With `sessionStartedAtOf(state) !== null`:

- an "End session" button (destructive variant);
- the elapsed clock, `formatClock(now() - sessionStartedAt)`, re-rendered by a
  1 s interval and `data-testid="session-elapsed"`;
- audio: a pulsing dot plus `Recording` while the recorder is
  `recording`/`stopping`, otherwise `No audio`;
- the link: `Pad connected` / `Reconnecting...` / `Pad not connected`, from the
  controller state, plus `not streaming` when connected without the stream.

**End (one click).** `phase = 'ending'`; `await engine.endSession()` in a `try`
with `await recorder.stop()` in the `finally`, so the audio is saved and queued
even if the note failed to close; a rejection from either becomes a visible
error. `recorder.stop()` resolving is what queues the transcription (the
runtime's `onSaved`). Then `phase = 'idle'`.

**Errors** render as `role="alert"` lines with a `Dismiss` button each
(session / device / audio), so one failure never hides another and none of them
blocks the session.

**Interrupted sessions.** After a reload or crash the in-progress recording is
gone (A11) and recovery has marked the note `interrupted`. On mount, and
whenever `activeNoteId` changes, the panel reads `listNotes()` (newest first)
and shows a notice when the newest non-legacy note is `interrupted`, or is
`active` but is not the engine's current note (recovery may not have finished
yet — the same situation, so it reads the same). The notice says the session was
interrupted and its audio recording was lost, and is dismissible. It never
claims the audio will come back.

## Tests

`src/capture/engine.test.ts` (appended; the four foundations tests stay as they
are and must keep passing):

1. **Session create persistence** — `startSession({ title })` writes an active
   `Session`, an active `Note` whose `sessionId` is that session, and page 0;
   state reports both ids, `pageIndex: 0` and `sessionStartedAt`.
2. **Paired ids under concurrency** — two `startSession()` calls in one tick each
   resolve with their *own* `{ sessionId, noteId }` pair (the note's stored
   `sessionId` equals the reported one for both), and exactly two sessions, two
   notes and one page per note exist.
3. **Session end persistence** — `endSession()` finalizes the page, completes the
   note, ends the session, and clears the state including `sessionStartedAt`.
4. **`startSession` ends an open session first** — the first note is `complete`,
   its session `ended`, and a new pair is active.
5. **Bare note path unchanged** — `startNote()` still creates Session + Note +
   page 0 and publishes **no** `sessionStartedAt` (so the control shows no
   session), and `sessionStartedAtOf` reports `null`.
6. **Pen auto-start unchanged** — writing with no session still auto-starts a
   note and keeps the strokes written meanwhile (existing test) *and* writing
   during a session lands on the session's note: no second note, no second
   session.
7. **Serialization under concurrent calls** — `startSession()`,
   `newPage('device-turn')` and `endSession()` fired in the same tick queue: the
   note ends with exactly two pages, both finalized, note `complete`, session
   `ended`, state idle.
8. **`endNote()` on a session's note** clears `sessionStartedAt` too (the UI can
   never show a session the engine no longer has).
9. **A failed session write** (`hooks.failSessionWrites`) makes `startSession()`
   reject, leaves the state idle with no note open, and the next pen point
   starts a fresh note.
10. **Startup recovery of an interrupted session** — a session started and left
    open, then a fresh engine's `start()`: the note becomes `interrupted`, its
    session `ended`, the unfinalized page is finalized and `pageFinalized`
    fires for it.

`src/capture/SessionControls.test.tsx` (new; `createRoot` + `act`, the
`DeviceStatus.test.tsx` pattern — no `@testing-library/react`; real engine over
`createFakeDeviceController` and `resetDatabase()`, plus a fake `Recorder`):

11. **Idle** — renders `Start session` inside `[aria-label="Session"]`, no clock.
12. **Start with a disconnected pad** — one click: a session exists, the
    controller saw `connect` then `startStreaming`, the recorder was started with
    that session's `{ sessionId, noteId }`, and the control shows `End session`,
    `0:00` and `Recording`.
13. **Already connected and streaming** — no `connect`, no `startStreaming`.
14. **Connected but not streaming** — `startStreaming` only.
15. **Device-not-connected path** — `connect()` rejects: the device error shows,
    the session is still active and capturing, and the recorder still started.
16. **Audio-failure isolation** — the microphone is refused (recorder stays idle
    with a `NotAllowedError` message): the session stays active, the engine still
    has its note and page, an alert shows the message, `No audio` is shown, and a
    pen stroke still lands on the session's note.
17. **`recorder.start` throwing** is reported the same way and leaves the session
    running.
18. **Session-start failure** — `engine.startSession()` rejects: an alert shows,
    the recorder was never started, the control still offers `Start session`.
19. **Elapsed clock** — advances with wall clock (injected `now`, fake timers).
20. **End** — one click: `engine.endSession()` and `recorder.stop()` both ran,
    the note is `complete`, the session `ended`, control back to `Start session`.
21. **End with a failing `endSession`** — the recorder is still stopped (the
    `finally`) and the error is shown.
22. **Busy states** — the button is disabled and reads `Starting...` /
    `Ending...` while a start/end is in flight.
23. **Interrupted notice** — newest note `interrupted` in storage: the notice
    names the interruption and says the recording was lost; `Dismiss` hides it.
24. **No notice** when the newest note is `complete`.

## Assumptions

- **P3-A1** `CaptureState` (foundations-owned, frozen) has no field for a manual
  session or its start time, so the engine publishes an additive optional
  `sessionStartedAt` on the same object (`LiveCaptureState`) with a
  `sessionStartedAtOf(state)` reader. Absent — not `null` — while idle and for
  bare notes, so existing full-state assertions and `CaptureState` consumers are
  untouched. `types.ts` is not edited.
- **P3-A2** The pad is ensured before the microphone: `requestDevice()` needs
  user activation that an awaited `getUserMedia()` prompt would consume. Neither
  failure unwinds the session.
- **P3-A3** `SessionControls` uses the app-wide `getAudioRuntime().recorder`, the
  same instance `RecorderControl` drives, so no `AppShell` or `RecorderControl`
  change is needed. `Record`/`Stop` stay usable; stopping there ends the
  session's recording early while the session keeps capturing handwriting.
- **P3-A4** "Interrupted" is read from storage: the newest non-legacy note is
  `interrupted`, or `active` but not the engine's current note. One session is
  one note (J4), so an interrupted note is an interrupted session.
- **P3-A5** The in-progress recording is lost (A11). The notice says so; no
  partial-audio recovery is attempted.
- **P3-A6** Elapsed time is wall-clock from the session's `startedAt`, ticked
  once a second while a session is open. It is not persisted; a reload ends the
  session anyway.
- **P3-A7** `endSession()` on a bare note behaves as `endNote()` (the same close
  path). The control only offers "End session" while a manual session is open.
- **P3-A8** A session's default title is `Session <local date and time>`, and its
  note carries the same title (Phase 1's shape). A caller-supplied `title`
  applies to both.
- **P3-A9** One session at a time, in the engine and in the UI. Starting a
  session while one is open ends the first (foundations test 4), which is what
  J4's "one note, one recording, started and ended together" implies.
