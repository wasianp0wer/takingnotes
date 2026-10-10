# S3 — Device: battery, the page button, audio that survives (feature spec)

Product source: `docs/spec-phase3.md` §2 ("S3 — audio that survives an
interruption") and §5 ("S3 — device"). Owns decisions **K4–K8, K26–K31**.
Contracts: `docs/architecture.md` §8 (`recordingChunks`, `finalizeRecording`,
`listUnfinishedRecordings`/`listFinishedRecordings`, `resumeNote`'s
`pageEndedAt`). Assumptions owned: **A31, A37, A40**. Companion brief:
`/Users/maddiepersonal/takingnotes/.superpowers/wave2/S3-brief.md`, which
carries two ⚑ findings from the Wave 1 whole-branch review that this spec
treats as binding.

S3 owns `src/audio/recorder.ts`, `src/audio/audioRuntime.ts`,
`src/utils/huionBLE.ts`, `src/device/controller.ts`, `src/app/DeviceStatus.tsx`.
Off limits: `src/capture/SessionControls.tsx` (S1), `src/capture/engine.ts` and
`types.ts` (S4), `src/storage/*` (Wave 1). One exception granted by the brief:
`src/gaps/analyzer.ts`'s `recordingForNote` predicate, to fix the
`listRecordings()` → `listFinishedRecordings()` consumer bug. The brief also
instructs fixing `src/recordings/RecordingsView.tsx` and
`src/audio/transcriptionQueue.ts`'s `resume()` for the same bug, even though
those files aren't in the "files you own" list verbatim — the ⚑ finding names
them explicitly as consumers that must change, so this spec treats that as
in-scope too.

## What already exists (read from the code)

- **`src/audio/recorder.ts`** buffers `MediaRecorder` chunks in memory
  (`chunks: Blob[]`) and writes once, in `finish()`, via `createRecording()`
  (storage/recordings.ts) which does the metadata+bytes write in one
  transaction. A crash before `finish()` runs loses every chunk — nothing
  touches storage until stop. State machine: `idle → starting → recording →
  stopping → idle`, with careful handling of a `stop()` landing mid-`starting`
  (`stopRequested`) and of `onerror`/spontaneous `onstop`.
- **`src/audio/audioRuntime.ts`** builds the app's one recorder + queue +
  whisper client lazily, and `startAudioRuntime()` is an idempotent
  (module-flag) call that only resumes the transcription queue
  (`queue.resume()`). It has no recovery step today.
- **`src/audio/transcriptionQueue.ts`**'s `resume()` calls `listRecordings()`
  (not `listFinishedRecordings()`) and enqueues every recording whose
  transcript is `null`/`pending`/`running`. Since Wave 1's K5, a
  `RecordingRecord` exists from the moment recording starts (`transcript:
  null`, zero-byte audio) — so on every reload, `resume()` would enqueue the
  very in-progress recording K4–K7 exist to protect, `getRecordingAudio()`
  would hand it a 0-byte blob (not `null`, because the row exists), the decode
  would throw, and the job would be written `failed` — permanently, since
  `resume()` never re-queues a `failed` row. The audio would still be on disk
  (once K4–K7 land) but its transcript would be silently destroyed on the
  very reload the feature exists to survive. This is ⚑ finding #2 from the
  brief, and it is why **recovery must run before `queue.resume()`**.
- **`src/recordings/RecordingsView.tsx`** calls `listRecordings()` directly to
  populate the list — same bug: an in-progress recording would appear with a
  0-byte player and a "Not transcribed" label that looks stuck.
- **`src/gaps/analyzer.ts`'s `recordingForNote`** calls `listRecordings()` and
  `listRecordingsBySession()` to find the earliest recording linked to a note,
  for gap analysis. Same bug: it could pick an in-progress recording with no
  audio yet.
- **`src/storage/recordingChunks.ts`** (Wave 1, off limits, already shipped)
  gives me `appendRecordingChunk`, `listRecordingChunks`,
  `stitchRecordingChunks`, `deleteRecordingChunks`.
- **`src/storage/recordings.ts`** (Wave 1, off limits, already shipped) gives
  me `listUnfinishedRecordings()` (`endedAt === null`, newest first),
  `listFinishedRecordings()` (the complement), and **`finalizeRecording(id,
  audio, patch)`** — the one-transaction close (writes `recordingAudio`,
  patches `endedAt`/`durationMs`/`byteLength`/`mimeType`, deletes that
  recording's chunks) that closes the crash window described in ⚑ finding #1.
- **`src/audio/pcm.ts`**'s `decodeToPcm16k(blob, deps?)` is the decode step
  between a saved recording and Whisper: `blob.arrayBuffer()` →
  `deps.decode` (default: `AudioContext.decodeAudioData`) →
  `deps.renderOffline` (default: `OfflineAudioContext`) with a pure
  downmix+resample fallback. Every existing test injects fake `decode`/
  `renderOffline` — **`happy-dom` (this project's only configured test
  environment) implements no `AudioContext` at all**, so the real browser
  decode path has never been exercised by this test suite, for any feature,
  at any point. This is a pre-existing limitation of the test harness, not
  something S3 introduces.
- **`src/device/pageTurnDetector.ts`** polls `getStoredPageCount()` every
  `pollIntervalMs` (default 5000ms), fires `onPageTurn(count, previous)` when
  the count *rises*, and exposes `hint()` to poll sooner. `createLivenessWatchdog`
  treats every inbound frame (including the poll's own `0x85` reply) as a
  sign of life; the poll interval (5s) is deliberately below the watchdog's
  `idleMs` (15s) so a healthy poll keeps the watchdog permanently quiet.
- **`src/device/controller.ts:227`**: `device.onNextPage = () =>
  detector.hint();` — the `0x8A` notification only makes the detector poll
  sooner; `detector`'s own `onPageTurn` callback is what calls
  `pageTurnEmitter.emit()`, gated on the ROM count actually rising. Since the
  pad does not commit pages to ROM while streaming, the count never rises
  during a live session, so a `0x8A` currently has no visible effect at all
  during normal use.
- **`src/utils/huionBLE.ts`** already parses `CMD.BATTERY` (`0x8E`) into
  `config.battery` (`handleCommand`'s `case CMD.BATTERY`) and already queries
  it once, after `MAX_INFO`, on every `connect()` and `reconnect()` (both
  funnel through `performHandshake()`). There is no `onBattery` callback and
  no way to re-request it later.
- **`src/app/DeviceStatus.tsx`** shows connection state and
  `storedPageCount`; nothing about battery.

## Decisions implemented

### Audio survives an interruption (K4–K8)

- **K4** `MediaRecorder` chunks are persisted as they arrive
  (`ondataavailable`, the existing `timesliceMs`, default 1000) via
  `appendRecordingChunk`, so an interruption loses at most one timeslice.
- **K5** `recorder.start()` creates the `RecordingRecord` immediately (via a
  new `createPendingRecording` call into `@/storage/recordings`... **no** —
  storage is off limits, so S3 uses `createRecording(input, new Blob([],
  {type}))` with `endedAt: null`, `durationMs: 0` exactly as K5 specifies;
  `createRecording` already accepts `endedAt?: number | null` with no
  special-case needed, since it already defaults `endedAt` to `null` when
  omitted). This happens before the first chunk exists, with `startedAt`,
  `link` (`sessionId`/`noteId`) and `title` already on disk.
- **K6** `stop()` calls `finalizeRecording(id, stitchedBlob, { endedAt,
  durationMs, mimeType })` — **not** a manual stitch→write→delete→patch
  sequence (⚑ finding #1: that four-step order spans two transactions and a
  crash between them discards a finished lecture or resurrects a deleted one).
  `finalizeRecording` does all three writes (`recordingAudio` put, `recordings`
  patch, `recordingChunks` delete) in one transaction.
- **K7** `audioRuntime.ts` gains `recoverInterruptedRecordings()`: for every
  row from `listUnfinishedRecordings()`, stitch its chunks
  (`stitchRecordingChunks`); if `null` (no chunks at all), delete the row
  (`deleteRecording`) rather than leave an empty husk; otherwise call
  `finalizeRecording(id, stitched, { endedAt: <derived>, durationMs:
  <derived> })` — the same atomic close `stop()` uses, so recovery can never
  reopen the crash window ⚑ finding #1 describes (recovery must *also* patch
  `endedAt`, not just stitch, or the next launch sees zero chunks and an
  unfinished row and deletes a recording recovery just finished saving).
  Every recovered recording is then queued for transcription
  (`queue.enqueue(id)`).
- **`startAudioRuntime()`'s ordering is load-bearing** (⚑ finding #2):
  recovery runs to completion *before* `queue.resume()` is called, and
  `resume()` itself is changed to read `listFinishedRecordings()` instead of
  `listRecordings()`, so it can never see (and fail-and-poison) a row that is
  still being written.
- **K8** ⚑ The mandatory test: build a recording whose chunks exist in
  storage but which was never `stop()`-ed (no finalisation chunk, exactly
  what a crash leaves behind), run recovery, and prove the recovered audio
  is real, decodable audio and not merely "some bytes exist". See
  "K8's decode test" below for exactly what this proves and the one
  deliberate compromise it makes, given the test environment's constraints.
- **K9** is S1's job (`SessionControls.tsx` is off limits to S3).

### Consumer fix for K5's semantics (⚑ finding #2)

Three call sites are changed from `listRecordings()` to
`listFinishedRecordings()`:

1. `src/audio/transcriptionQueue.ts`'s `resume()`.
2. `src/recordings/RecordingsView.tsx`'s list load.
3. `src/gaps/analyzer.ts`'s `recordingForNote` — the `listRecordings()` call
   becomes `listFinishedRecordings()`; the `listRecordingsBySession()` result
   (which has no "finished" variant in storage, and S3 may not add one) is
   filtered in-place (`recording.endedAt !== null`) before being merged with
   the direct-link list. This is the one exception the brief grants into
   `src/storage/*`'s off-limits boundary — a predicate change only, no new
   storage function.

### The pad's physical page button (K28–K31)

- **K28** `controller.ts`'s `device.onNextPage` assignment stops calling
  `detector.hint()` and instead calls a new `emitPageTurn()` that fires
  `pageTurnEmitter.emit()` directly (gated on `capturing`, matching the
  existing implicit gating: `detector.hint()` was already a no-op unless
  `detector.start()` had run, i.e. unless `capturing`).
- **K29** The detector's own `onPageTurn` callback is changed to update
  `storedPageCount` only — it no longer calls `pageTurnEmitter.emit()`. The
  5-second poll (`pollIntervalMs`), the watchdog wiring (`onFrame` /
  `noteFrame()`), and `reconnectPolicy.onSuccess`'s `detector.hint()` re-poll
  are **all left running unchanged** — removing or slowing any of them would
  starve the liveness watchdog (⚑) or stale `storedPageCount` (used by
  `engine.devicePageNum()`, outside S3's files).
- **K30** No compensation is added for the ~20% miss rate. Accepted per spec.
- **K31** A dedupe window (default 300ms, injectable for tests) guards
  `emitPageTurn()`: two `0x8A` notifications within the window count as one
  page turn; the timestamp of the *first* one in a burst is what starts the
  window (so two presses exactly 300ms apart are never collapsed into one —
  the window does not slide).

### Battery (K26–K27)

- **K26** `DeviceState` gains `batteryPercent: number | null`.
  `huionBLE.ts` gains `onBattery: ((percent: number) => void) | null`,
  fired (defensively, matching every other consumer callback) from
  `handleCommand`'s `case CMD.BATTERY`, right after `config.battery` is set.
  `controller.ts` wires `device.onBattery = (percent) => setState({
  batteryPercent: percent })`.
- Also factored out: `HuionNoteBLE.requestBattery(): Promise<void>` (a thin
  wrapper around the existing `this.write(makeFrame(CMD.BATTERY))`), reused
  by the post-`MAX_INFO` handshake query so there is exactly one write site.
- **K27** `controller.ts` owns a battery poll timer (default 5 minutes,
  injectable `setInterval`/`clearInterval`/`now` for tests), started right
  after `connect()` resolves and re-started on every successful reconnect
  (`reconnectPolicy.onSuccess`); stopped, and `batteryPercent` reset to
  `null`, the moment the link is no longer connected — in `disconnect()` and
  in `handleDrop()` (covers both an explicit disconnect and a detected drop,
  including the watchdog-detected kind). This is the ⚑ requirement: *a poll
  must not outlive its connection, and a stale number must never be shown as
  current* — `batteryPercent` goes to `null` synchronously with
  `isConnected: false`, not just whenever the next poll happens to fire.
- **`DeviceStatus.tsx`** renders `state.batteryPercent` beside the existing
  connection line when non-null (e.g. `· 82% battery`), and renders nothing
  extra when `null` (covers "before the first reply" and "while
  disconnected").

## K8's decode test: what it proves, and the one compromise

The brief requires a test that a *stitched, truncated* recording "both plays
and survives the decode path `whisperWorkerCore` uses" — meaning
`decodeToPcm16k`, the step between a saved recording and the Whisper worker
(`whisperWorkerCore` itself only ever receives already-decoded `Float32Array`
PCM over the worker protocol; it has no decode step of its own to survive).

**The constraint that matters:** this repository's only configured test
environment (`happy-dom`, per `vitest.config.ts`) implements no
`AudioContext`/`OfflineAudioContext` at all, and every existing audio test in
this codebase (`pcm.test.ts`) exercises `decodeToPcm16k` exclusively through
injected fake `decode`/`renderOffline` functions — this is the established,
deliberate project convention (`architecture.md` §5: "Hardware, network,
audio and ML sit behind the interfaces above, so tests use fakes"), not a gap
S3 introduces. No dependency already in `package.json` provides a real
audio/video codec, and the brief forbids adding a new one.

**What the test does, to stay honest about that constraint and still be
non-vacuous:**

1. It builds **real, valid WebM/Opus bytes** (not placeholder bytes) —
   generated once, offline, with the system's `ffmpeg` (not a project
   dependency; not invoked by the application or by `npm test`'s default
   path) and committed as a binary fixture
   (`src/audio/fixtures/truncatable-tone.webm`) representing what a short
   real recording's bytes look like.
2. It slices that fixture into several chunks the way `MediaRecorder`'s
   `timeslice` delivery would, and deliberately **withholds the final
   chunk's remainder** (the bytes a graceful `stop()` would still be holding
   when a crash happens) — modelling exactly the K8 risk ("a stream
   truncated mid-flight has no finalised WebM container"), not byte-level
   corruption of a chunk that did fully arrive.
3. It drives this through the **real** `recorder.ts` (fake `MediaRecorder`/
   `getUserMedia`, real chunk persistence) and the **real** recovery path in
   `audioRuntime.ts` against `fake-indexeddb`, so the assembled, recovered
   Blob is produced by the actual K4–K7 code, not hand-built.
4. It asserts the recovered Blob is **structurally valid enough to be a
   plausible audio file** (non-trivial size, starts with the real EBML
   magic bytes `0x1A45DFA3`) and then feeds it through `decodeToPcm16k`
   with a `decode` dependency that shells out to the system's `ffmpeg` to
   really decode the bytes to PCM — the same substitution point
   (`PcmDeps.decode`) the architecture already designates as injectable,
   just pointed at a real decoder instead of a canned fixture, for this one
   test only. The assertion is that this resolves with a non-empty,
   non-silent `Float32Array` whose duration is close to (but necessarily
   less than) the untruncated recording's — i.e. the audio that did arrive
   before the crash is recovered and is really decodable, which is the
   entire point of K4–K8.
5. **If `ffmpeg` is not on the `PATH` when this test runs, the test fails
   loudly** (a clear "ffmpeg is required for this test" message), rather
   than silently skipping or passing. This is the one deliberate deviation
   from "no new dependency": it is not an `npm` dependency (nothing in
   `package.json`/`package-lock.json` changes), but it does mean this one
   test's pass/fail is contingent on a system tool this project has never
   previously required. This is called out explicitly in the final report
   as a concern for the owner to weigh — not hidden, and not worked around
   with a weaker assertion.

This is reported as a `DONE_WITH_CONCERNS`-grade compromise, not a silent
fallback: the test fails first (today, before K4–K7 exist, there is nothing
in storage to recover at all, so the recovery call itself has nothing to
act on and the test fails there), and after the fix it exercises real bytes
through a real decoder and a real recovery path.

## Behavioural rules

- Audio never blocks writing (A28): every audio failure path already reports
  and continues; S3 adds no new way for an audio failure to touch capture.
  Nothing in `src/capture/` is touched by S3, and nothing S3 adds imports
  from `src/audio/` into `src/capture/`.
- Recovery runs once per page load, before `queue.resume()`, gated by the
  same kind of module-level idempotency flag `startAudioRuntime()` already
  uses.
- A recording recovered with zero bytes of actual audio (every chunk was
  lost, not just the last one) is still queued for transcription if it has
  *some* audio; only a recording with **no chunks at all** is deleted (K7).
- `emitPageTurn()`'s dedupe is a pure function of elapsed time since the last
  *emitted* turn, not since the last *received* `0x8A` — so a burst of three
  presses within 300ms each is one page turn, matching "one press cannot
  make two pages," while two presses 301ms apart are two.
- Battery timers and page-turn dedupe state are injectable (`now`,
  `setInterval`/`clearInterval`) so tests never wait out a real 5 minutes or
  300ms.

## Assumptions (S3's own, beyond A31/A37/A40 already recorded in spec-phase3.md)

- S3-A1 `ffmpeg` is available on `PATH` in this environment and is used only
  as a test-time decode oracle for K8's mandatory test; no application code
  path depends on it. Flagged as a concern, not hidden.
- S3-A2 "Plays" for K8's purposes means "decodes to non-empty, non-silent PCM
  via a real decoder" — there is no `<audio>` element-level playback
  assertion, because `happy-dom`'s media elements do not actually decode
  audio either.
- S3-A3 The battery poll's 5-minute default and the page-turn dedupe's 300ms
  default are both constructor-injectable, following the existing pattern in
  `recorder.ts` (`timesliceMs`, `tickMs`) and `transcriptionQueue.ts`
  (`stallTimeoutMs`).
- S3-A4 `createRecording`'s existing signature (already shipped, off limits)
  is sufficient for K5: passing `endedAt: null` and an empty `Blob` creates
  the "exists from the start" row with no storage-layer change needed.
