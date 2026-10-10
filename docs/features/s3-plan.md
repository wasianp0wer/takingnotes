# S3 — implementation plan

Bite-sized TDD tasks. Each: write the failing test → run it red → implement
the minimum → run it green → `npx tsc -b` → `npm run lint` → commit. Full
`npm test` + `npm run build` before every commit per the global gate.

## Task 1 — `recorder.ts`: incremental chunk persistence (K4, K5)

Rewrite `RecorderDeps` to inject three storage seams instead of one `save`:

```ts
export interface CreatePendingInput {
  title: string;
  sessionId: string | null;
  noteId: string | null;
  startedAt: number;
  mimeType: string;
}
export interface RecorderDeps {
  getUserMedia?: ...;
  MediaRecorder?: ...;
  /** K5: creates the RecordingRecord before any chunk exists. Default: createRecording with endedAt: null, durationMs: 0, a 0-byte Blob. */
  createPending?: (input: CreatePendingInput) => Promise<RecordingRecord>;
  /** K4: persists one chunk as it arrives. Default: appendRecordingChunk. */
  appendChunk?: (recordingId: string, seq: number, blob: Blob) => Promise<void>;
  /** K6: stitches a recording's persisted chunks. Default: stitchRecordingChunks. */
  stitch?: (recordingId: string) => Promise<Blob | null>;
  /** K6: the one atomic close. Default: finalizeRecording. */
  finalize?: (id: string, audio: Blob, patch: { endedAt: number; durationMs: number; mimeType?: string }) => Promise<RecordingRecord>;
  /** Cleans up a pending row that never got any audio. Default: deleteRecording. */
  deletePending?: (id: string) => Promise<void>;
  onSaved?: (recording: RecordingRecord) => void;
  now?: () => number;
  setInterval?: ...; clearInterval?: ...; timesliceMs?: number; tickMs?: number;
}
```

- `start()`: after `nextRecorder.start(timesliceMs)` succeeds and `startedAt`
  is read, call `createPendingFn` (default wraps `createRecording` from
  `@/storage/recordings` with `endedAt: null`, `durationMs: 0`, a 0-byte
  `Blob([], { type: mimeType })`). Only once that resolves does the code
  assign `ondataavailable`/`onstop`/`onerror` and flip state to `'recording'`
  — closing the (negligible but real) race between a chunk arriving and the
  pending row existing. A `createPendingFn` rejection stops tracks, calls
  `nextRecorder.stop()` defensively, and reports
  `Could not start recording: <message>`, same wording as every other
  start-time failure.
- `ondataavailable`: assigns a monotonic `seq` starting at 0, calls
  `appendChunkFn(recordingId, seq, event.data)`, and pushes the (internally
  caught) promise onto a `pendingAppends` array so `finish()` can wait for
  every chunk's write to land before stitching. A chunk whose own append
  throws is logged and skipped (a hole in the sequence, which storage's
  `stitchRecordingChunks` already tolerates) — it must never abort the
  recording in progress (A28).
- `finish()` (shared by explicit `stop()` and a spontaneous `onstop`):
  `await Promise.all(pendingAppends)`, then `stitchFn(recordingId)`. `null`
  (no chunks at all) → `deletePendingFn(recordingId)` (best-effort, logged on
  failure) and the existing `'Nothing was recorded'` idle state, `result:
  null`. Otherwise → `finalizeFn(recordingId, stitched, { endedAt, durationMs:
  endedAt - startedAt, mimeType: type })`; success sets idle state, calls
  `onSaved`, resolves with the record. **On `finalizeFn` throwing, nothing is
  cleaned up** — the chunks and the still-`endedAt: null` row are left
  exactly as they are, so a failed live stop is still recovered by K7 on the
  next launch; only the live UI reports
  `Could not save the recording: <message>`.

**Tests** (`src/audio/recorder.test.ts`, full rewrite of the harness's single
`save` mock into `createPending`/`appendChunk`/`stitch`/`finalize`/
`deletePending` mocks):
1. `start()` calls `createPendingFn` with `endedAt`-free input (title,
   sessionId, noteId, startedAt, mimeType) before any `appendChunk` call.
2. Two `ondataavailable` events persist two chunks with **seq 0 and seq 1**,
   in that order, each with the recording id from `createPendingFn`'s result
   — not seq values that happen to sort the same lexicographically and
   numerically (the Wave 1 retrospective's named trap), so use a third and
   later chunk too and assert seq **2** explicitly lands after a two-digit
   seq is possible in a longer synthetic run, or at minimum assert the
   literal seq integers 0, 1, 2 (not stringified) via the mock's captured
   call args.
3. `stop()` awaits every in-flight `appendChunk` before calling `stitch`
   (model a chunk append that resolves on a later microtask than `stop()`
   starts, and assert `stitch` is called only after it resolves).
4. `stop()` calls `finalize` with the stitched blob and the correct
   `endedAt`/`durationMs`/`mimeType`; `onSaved` fires with `finalize`'s
   result.
5. No chunks ever arrived → `stitch` returns `null` → `deletePending` is
   called with the pending recording's id, `finalize` is never called,
   `'Nothing was recorded'`.
6. `finalize` rejecting → idle with `Could not save the recording: <msg>`,
   `deletePending` **not** called (chunks/row survive for K7 recovery).
7. `createPending` rejecting → idle with `Could not start recording: <msg>`,
   no `MediaRecorder` left running, tracks stopped.
8. Every pre-existing recorder test not about the save mechanics (mime type
   fallback, elapsed tick, link capture/immunity to mutation, permission
   errors, double-start, double-stop, mid-`starting` stop) still passes
   against the new dependency shape.

Mutation check: break `seq` to always write `0` → test 2 goes red. Break the
`Promise.all(pendingAppends)` await (stitch immediately) → test 3 goes red.
Break the "finalize failure doesn't delete" behaviour → test 6 goes red.

## Task 2 — `audioRuntime.ts`: startup recovery (K7)

```ts
/** Finds every unfinished recording, stitches it, patches it closed, and queues its transcription. */
export async function recoverInterruptedRecordings(deps?: {...}): Promise<void>;
```

- For each `listUnfinishedRecordings()` row: `stitchRecordingChunks(id)`.
  `null` → `deleteRecording(id)`. Otherwise →
  `finalizeRecording(id, stitched, { endedAt: <derived>, durationMs: <derived> })`
  — **must** patch `endedAt`, per ⚑ finding #1's explicit warning that
  skipping this makes the *next* launch delete a recording this one just
  recovered. `endedAt` is derived as `startedAt + durationMs-so-far`-less: since
  recovery has no "when did the crash happen" signal, it uses `now()` at
  recovery time (the only honest answer — there is no better one, and this
  only affects display duration, never the audio bytes). Then
  `queue.enqueue(id)`.
- `startAudioRuntime()` calls `recoverInterruptedRecordings()` and awaits it
  **before** `queue.resume()` — ⚑ finding #2's load-bearing ordering.
  Idempotency flag covers the whole sequence, not just `resume()`.

**Tests** (`src/audio/audioRuntime.test.ts`, new — none exists today; uses
`fake-indexeddb` directly, no mocked storage module, so the real
`listUnfinishedRecordings`/`stitchRecordingChunks`/`finalizeRecording` run):
1. An unfinished recording with chunks is stitched, `endedAt` becomes
   non-null, its chunk rows are gone afterward
   (`listRecordingChunks` → `[]`), and it is handed to the injected queue's
   `enqueue`.
2. An unfinished recording with **no** chunks is deleted
   (`getRecording(id)` → `undefined` afterward) and never reaches `enqueue`.
3. A **finished** recording (`endedAt` already set) is left completely
   untouched: not stitched, not re-finalized, not enqueued — proves recovery
   doesn't re-touch settled work.
4. `startAudioRuntime()` calls recovery's work to completion before
   `queue.resume()` is invoked — observable via a recorded call order on a
   spy `recover`/`resume` pair, or (more end-to-end) by seeding one
   unfinished recording with a `transcript: null` + chunks and asserting
   that after `startAudioRuntime()` settles, the recording that reaches the
   queue is the **recovered, finished** row (`endedAt !== null`), never the
   pre-recovery unfinished snapshot — this is the regression ⚑ finding #2
   describes verbatim (resume() enqueuing a 0-byte row and poisoning it
   `failed` forever).

Mutation check: swap the `await` order (call `resume()` before recovery
resolves) → test 4 goes red. Remove the `endedAt` patch from the finalize call
→ a second "recover twice" test (add one) goes red because the row is deleted
on the second pass instead of being found already-finished.

## Task 3 — Consumer fix for K5 (⚑ finding #2)

- `src/audio/transcriptionQueue.ts`: `resume()`'s `listRecordings()` →
  `listFinishedRecordings()`. **Test**: seed one unfinished (`endedAt: null`,
  `transcript: null`) and one finished-but-unqueued (`endedAt` set,
  `transcript: null`) recording; `resume()` enqueues only the finished one.
  Mutation check: revert to `listRecordings()` → test goes red (the
  unfinished one gets enqueued too).
- `src/recordings/RecordingsView.tsx`: same import/call swap. **Test**
  (`RecordingsView.test.tsx`, extend existing): an unfinished recording
  (`endedAt: null`) seeded alongside a finished one does not appear in the
  rendered list; the finished one does.
- `src/gaps/analyzer.ts`'s `recordingForNote`: `listRecordings()` →
  `listFinishedRecordings()`; the `listRecordingsBySession` result filtered
  to `endedAt !== null` before merging. **Test** (extend
  `analyzer.test.ts` or add a focused `recordingForNote.test.ts` if none
  covers this predicate alone): a note linked to one unfinished and one
  finished recording resolves to the finished one; a note linked only to an
  unfinished recording resolves to `null` (same as "no recording").

## Task 4 — K8's mandatory decode-survival test

New file `src/audio/incrementalRecovery.decode.test.ts` (name chosen so the
mandatory test is not buried inside the general recorder suite).

1. Build the fixture once (a short `scripts/` helper or inline
   `beforeAll`, **not** regenerated by `npm test`): a real short tone encoded
   to WebM/Opus via the system's `ffmpeg`, committed as
   `src/audio/fixtures/truncatable-tone.webm` so `npm test` never shells out
   to `ffmpeg` to *produce* the fixture — only to *decode* it in this one
   test.
2. Slice the fixture's bytes into N chunks at byte offsets chosen to land
   inside real cluster boundaries (found once, by inspection, and hard-coded
   as constants with a comment) so each chunk looks like a real
   `MediaRecorder` timeslice delivery; withhold the file's final bytes
   (modelling "no stop() finalisation chunk ever arrived").
3. Drive the real `createRecorder()` with a fake `MediaRecorder` that emits
   those sliced chunks and **never calls `onstop`** (the crash). Let its
   `appendChunk`/`createPending` defaults run against `fake-indexeddb`.
4. Call `recoverInterruptedRecordings()` (Task 2) against that same fake db.
5. Assert the recovered recording's `getRecordingAudio()` blob: non-trivial
   byte length, starts with the real EBML magic (`0x1A 0x45 0xDF 0xA3`).
6. Feed that blob into the real `decodeToPcm16k` with a `decode` dependency
   that shells out to `ffmpeg` (spawn, stdin the bytes, `-f f32le -ar 16000
   -ac 1`, read stdout) and wraps the raw PCM in a minimal `AudioBuffer`-like
   object. Assert the resolved `Float32Array` is non-empty and not
   all-zero (`Math.max(...Array.from(pcm).map(Math.abs)) > 0.01`), proving
   real decoded signal, not silence or a decode that quietly returned
   nothing.
7. If `ffmpeg` cannot be spawned, the test throws (fails), with a message
   naming exactly that — never a skip, never a pass.

**This must fail first**: against today's `recorder.ts` (before Task 1),
there is no `appendRecordingChunk` call at all, so step 3 leaves nothing in
`recordingChunks`, step 4 (recovery, which doesn't exist before Task 2
either) has nothing to recover, and the test fails at "no unfinished
recording was found to recover" — a real, structural failure, not a decode
rejection. After Tasks 1–2 land, it exercises the whole pipeline for real.

**If step 6 rejects even after Tasks 1–2 are correct** (ffmpeg genuinely
cannot decode the truncated, stitched bytes): per the brief, stop here and
report it as a blocker, quoting ffmpeg's exact stderr, rather than loosening
the assertion or adding a remux fallback nobody asked to be built yet.

Mutation check: feed the UNtruncated full fixture through the same pipeline
as a sanity companion test (not mandatory, just confidence) — then break
`stitchRecordingChunks`'s seq-sort by one off-by-one (locally, temporarily,
to prove the decode test would actually notice garbled audio) — confirm the
truncation test goes red when the chunk order is scrambled, then revert.

## Task 5 — Battery (K26, K27)

- `huionBLE.ts`: add `onBattery: ((percent: number) => void) | null = null`;
  call it defensively (try/catch, matching `onNextPage`'s pattern) from
  `handleCommand`'s `case CMD.BATTERY`, right after `this.config.battery =
  data[3]`. Add `requestBattery(): Promise<void>` wrapping
  `this.write(makeFrame(CMD.BATTERY))`; the post-`MAX_INFO` handshake query
  calls it instead of writing the frame inline.
  **Tests** (`huionBLE.test.ts`): `onBattery` fires with the parsed
  percentage on a `CMD.BATTERY` reply; a throwing `onBattery` is caught and
  logged, not propagated (matching `onNextPage`'s own test); `requestBattery()`
  writes the `CMD.BATTERY` frame.
- `controller.ts`: `DeviceState.batteryPercent: number | null` (initial
  `null`). `device.onBattery = (percent) => setState({ batteryPercent: percent })`.
  A battery poll: `startBatteryPoll()` (interval `opts.batteryPollMs ??
  5*60_000`, calling `device.requestBattery()` each tick, swallowing its own
  rejection into a log line) started after `connect()` resolves and in
  `reconnectPolicy.onSuccess`; `stopBatteryPoll()` plus
  `setState({ batteryPercent: null })` in `disconnect()` and in `handleDrop()`
  (covers an explicit disconnect and every drop path, transport-level and
  watchdog-detected alike).
  **Tests** (`controller.test.ts`, injectable `now`/`setInterval`/
  `clearInterval` added to `DeviceControllerOptions` for this purpose):
  1. `batteryPercent` is `null` before connecting.
  2. Connecting and letting the handshake's existing post-`MAX_INFO` battery
     query answer sets `batteryPercent` to the parsed value (drives this
     through a transport fixture extended to answer `CMD.BATTERY`).
  3. Advancing the injected interval by one `batteryPollMs` issues a second
     `CMD.BATTERY` write (proves the periodic refresh, not just the
     handshake's one-off query).
  4. A transport-level drop (`transport.dropConnection()`) sets
     `batteryPercent` back to `null` **synchronously with the drop**, not on
     the next poll tick, and the interval issues no further `CMD.BATTERY`
     writes until reconnected (drive the fake clock/interval forward past
     several intervals-worth while disconnected and assert no new battery
     write lands).
  5. A successful reconnect resumes the periodic poll (another interval tick
     after reconnect produces another write).
- `DeviceStatus.tsx`: render `state.batteryPercent !== null ?
  \`${state.batteryPercent}% battery\` : null` beside the existing status
  line; nothing rendered when `null`.
  **Tests** (`DeviceStatus.test.tsx`): battery text shown when
  `batteryPercent` is a number; absent when `null`; a state update to `null`
  (simulating the drop-clears-it rule) removes previously-shown text.
- `src/test/fakeDeviceController.ts`: add `batteryPercent: null` to
  `idleState` so the type still compiles; no behavioural change to the fake
  otherwise needed (`setDeviceState({ batteryPercent })` already works via
  the generic patch mechanism).

Mutation check: remove the `setState({ batteryPercent: null })` from
`handleDrop()` → test 4 goes red (stale number survives the drop). Remove the
interval's periodic write → test 3 goes red.

## Task 6 — The pad's page button (K28–K31)

- `pageTurnDetector`'s composition in `controller.ts`: `onPageTurn: (count) =>
  setState({ storedPageCount: count })` — drop the `pageTurnEmitter.emit()`
  call that was there.
- `device.onNextPage` becomes a dedupe-guarded direct emit:
  ```ts
  let lastPageTurnAt = -Infinity;
  function emitPageTurn() {
    if (!capturing) return;
    const t = nowFn();
    if (t - lastPageTurnAt < pageTurnDedupeMs) return;
    lastPageTurnAt = t;
    pageTurnEmitter.emit();
  }
  device.onNextPage = () => emitPageTurn();
  ```
  `nowFn` and `pageTurnDedupeMs` (default 300) come from new
  `DeviceControllerOptions` fields, defaulting to `Date.now` — the same
  injection Task 5's battery poll needs, added together.

**Tests** (`controller.test.ts`):
1. **Rewrite** "fans page turns out to every subscriber" and "stops
   delivering to an unsubscribed consumer": drop `pageCountFake`/count
   plumbing entirely (no longer relevant), drive a bare `connectedFake()`,
   emit a `CMD.NEXT_PAGE` frame after `startCapture()`, assert immediate
   (same-tick, no `tick(50)` wait for a poll) delivery to every
   subscriber.
2. **Rewrite** "emits page turns from the count poll with no 0x8A involved":
   flip the assertion — a rising count **no longer** emits a page turn
   (`turns` stays empty), while `storedPageCount` still updates.
3. **Rewrite** "re-polls on reconnect so turns during the gap are found":
   flip the assertion — `storedPageCount` still updates to the gap's count
   via the reconnect re-poll, but **no** page turn is emitted from it (K30:
   missed turns are not recovered by the count poll anymore).
4. New: two `CMD.NEXT_PAGE` frames within the dedupe window (inject a fake
   `now`/short dedupe window for determinism) deliver **one** page turn; two
   frames `pageTurnDedupeMs + 1`ms apart deliver **two**.
5. New: the 5-second poll's heartbeat function (feeding
   `watchdog.noteFrame()` via `device.onFrame`) is untouched — a liveness
   test (`liveness.test.ts` or an extension to the watchdog-drop describe
   block in `controller.test.ts`) confirms the watchdog still stays quiet
   through a long idle stretch purely from the poll's own replies, with zero
   `0x8A` frames at all. (This may already be covered by an existing test;
   if so, confirm it still passes unmodified rather than duplicating it.)
6. New: a `CMD.NEXT_PAGE` frame received while **not** capturing
   (`startCapture()` never called, or after `stopCapture()`) does not emit a
   page turn — matches the detector's own pre-existing `!running` no-op this
   replaces.

Mutation check: remove the `if (!capturing) return;` guard → test 6 goes red.
Remove the dedupe comparison (always emit) → test 4's "one press, one page"
half goes red. Revert the `onPageTurn` change (re-add `pageTurnEmitter.emit()`
there) → test 2 goes red.

## Task 7 — Final pass

- `npm test`, `npx tsc -b`, `npm run lint`, `npm run build` all green.
- Re-read the two ⚑ findings against the final diff, line by line.
- Write `docs/features/s3-report.md` with the full status, including the
  K8 ffmpeg-dependency concern stated plainly.
