# S3 report — device: battery, the page button, audio that survives

Worktree: `/Users/maddiepersonal/takingnotes/.claude/worktrees/agent-ae6cdce27cee7bb8c`
Branch: `worktree-agent-ae6cdce27cee7bb8c` (branched from `phase3` at `517fbe6`)

## Fix round 1 (coordinator review)

Two findings, both flowing from concerns I raised myself in the original
report. Both addressed; status moves from the original DONE_WITH_CONCERNS
to a cleaner DONE_WITH_CONCERNS (the `ffmpeg` dependency is now opt-in for
one extra layer of proof, not load-bearing for the suite passing - see
below - but it's still worth the owner knowing it's there).

### Finding 1 — the suite must no longer depend on a system binary to pass

`src/audio/incrementalRecovery.decode.test.ts` is split into two layers:

1. **A structural check that runs unconditionally, with no `ffmpeg` or any
   other external tool.** `assertStructurallyValidStitchedWebm()` parses
   the recovered bytes as EBML/Matroska by hand (a hand-rolled, dependency-
   free vint decoder - `vintLength`/`readElementSize`, about 25 lines):
   - a valid EBML header at the front (the magic bytes);
   - every chunk boundary (where the recorder split deliveries) lands on a
     real Cluster element id;
   - each of those Clusters is *complete*: decoding its own EBML size field
     places its end **exactly** at the next chunk boundary (or, for the
     last one, exactly at the truncation point) - never short, never long;
   - the overall byte length matches exactly what withholding the final
     cluster and the Cues trailer should leave.

   This test alone guards S3's own stitching logic hermetically and can
   never be skipped.

2. **The `ffmpeg` real-decode check, now conditional.** `detectFfmpeg()`
   runs once at module load (`spawnSync('ffmpeg', ['-version'])`). When
   `ffmpeg` is missing, both `ffmpeg`-dependent tests are skipped via
   `it.skipIf`, a console warning fires with the full reason and exactly
   how to enable it (`FFMPEG_MISSING_MESSAGE` - not a bare skip), and the
   skipped tests' own titles carry a `[SKIPPED - ...]` suffix so it's
   visible in the test list too, not only in the console. When `ffmpeg`
   *is* present and decode fails, it still fails loudly - no change there.

   `npm test` as a whole no longer depends on `ffmpeg` to pass: on a
   machine without it, the structural test still runs and still catches a
   stitching regression; only the extra, stronger "real decoder accepts
   this" proof is unverified that run, and the run says so plainly.

**Verified the skip actually skips** (not just read the code): shadowed
`ffmpeg` by prepending a scratch directory containing a fake `ffmpeg` script
that exits 127 to `PATH` (the coordinator's suggested approach), then ran
`npx vitest run src/audio/incrementalRecovery.decode.test.ts` with that
`PATH`. Result: the console warning printed verbatim, the structural test
ran and passed, and both `ffmpeg` tests reported as skipped (`1 passed | 2
skipped (3)`) - the file as a whole still reports as passed, not failed.
Then re-ran with the real `ffmpeg` back on `PATH` and confirmed all 3 pass
again.

**Mutation-tested the new structural check specifically** (two separate
probes against `src/storage/recordingChunks.ts`'s `seq` sort, each a local,
reverted probe - the file is unchanged in this commit):
- Reversed the sort entirely → caught, but only by the EBML-header-at-front
  assertion (the header chunk landed last).
- A second, subtler probe that swaps only chunks `seq 3` and `seq 5` while
  leaving chunk 0 (the header) untouched → the header assertion is
  satisfied, but the new per-boundary Cluster-id-and-size check catches it
  on its own: `"Cluster at byte 13149 should be complete, ending exactly at
  the next chunk boundary: expected 17389 to be 17387"`. This confirms the
  new structural logic pulls real, independent weight rather than being
  redundant with the header check.

Both probes reverted immediately after confirming.

### Finding 2 — residual-risk note in the architecture doc

Added to `docs/architecture.md` §8.2, directly after the
`finalizeRecording`/invariant bullets (the incremental-audio subsection):
a "Known limitation, with a named next step" paragraph stating plainly what
K8 verifies (structural validity, plus - when `ffmpeg` is available - real
decodability under `ffmpeg`), what it does not (the browser's own
`AudioContext.decodeAudioData` on the same truncated bytes - `ffmpeg` is
known to be more tolerant of damaged containers than a browser may be), the
contingency if a browser ever refuses (a remux step, not built since no
failing test has asked for it), the fact that the raw bytes are preserved
and recoverable either way (strictly better than A11's total loss), and the
one manual check that would close the residual risk (interrupt a real
recording on real hardware, reopen, confirm it plays and transcribes).

### Gates after this round

96 files / **1180 tests** pass (was 1179 - net +1, from splitting one test
into a structural test plus two conditional `ffmpeg` tests).
`npx tsc -b` clean. `npm run lint`: 0 errors, 5 pre-existing warnings
(unchanged from before this round). `npm run build` succeeds. Off-limits
files (`src/storage/*`, `capture/engine.ts`, `capture/types.ts`,
`SessionControls.tsx`, `package.json`, `package-lock.json`): confirmed
zero diff again.

## Status: DONE_WITH_CONCERNS

Everything in the brief is implemented and tested, including K8's mandatory
decode test. The one concern (see below) is that K8's test depends on the
system's `ffmpeg` being on `PATH` - a deliberate, disclosed choice, not a
silent workaround, but a real deviation from "no new dependencies" worth the
owner's explicit sign-off.

## Setup note (not S3's bug, but worth recording)

This worktree's branch was created from an old pre-`phase3` commit (the
`worktree.baseRef: fresh` default branching from `main`), not from `phase3`
as the brief instructed. Since the worktree was clean with zero unique
commits, I fixed this with `git reset --hard phase3` before starting -
a safe fast-forward (the branch's prior HEAD was a strict ancestor of
`phase3`), confirmed via `git merge-base --is-ancestor`. Flagging this in
case other Wave 2 worktrees have the same problem.

Also: this worktree's `node_modules` was present but empty (only a `.vite`
cache dir), which broke `npm run lint` and would have broken `npm run build`.
I ran `npm install` to populate it from the existing `package-lock.json` -
no dependency was added or changed (`git diff` on `package.json` and
`package-lock.json` is empty).

## Commits (oldest to newest)

1. `de721f0` docs(s3): spec and plan
2. `493031c` feat(audio): persist recording chunks incrementally and close atomically (K4-K6)
3. `1601319` feat(audio): startup recovery for interrupted recordings (K7)
4. `6f7e67b` fix(audio,gaps): route three K5 consumers through listFinishedRecordings() (⚑ finding #2)
5. `b4c5936` test(audio): K8's mandatory decode-survival test for a crash-truncated recording
6. `b84db89` feat(device): battery level in DeviceStatus; 0x8A as the direct page-turn trigger (K26-K31)

## Test summary

**96 files / 1179 tests pass** (baseline was 93/1145 - net +3 files, +34
tests). `npx tsc -b` clean. `npm run lint`: 0 errors, 5 pre-existing
warnings unrelated to this work (`useTriageData.ts`, `huionTransport.ts`).
`npm run build` succeeds.

## K8's decode test - explicit outcome

**It exists, failed first, and passes.**

- A real WebM/Opus fixture (`src/audio/fixtures/truncatable-tone.webm`,
  generated once with the system's `ffmpeg`, committed as a binary) is
  sliced at its real Matroska Cluster boundaries into 8 MediaRecorder-shaped
  chunks. The final cluster and the trailing Cues element (the muxer's
  finalisation - the role `MediaRecorder.stop()`'s own final flush plays in
  a real recording) are withheld entirely, modelling exactly K8's risk: a
  crash before `stop()` ever ran, so the container was never finalised.
- Driven through the real `recorder.ts` and the real
  `recoverInterruptedRecordings()` against `fake-indexeddb` - nothing about
  the recording/recovery path is mocked.
- **Confirmed failing first**: I temporarily swapped in the pre-Task-1
  `recorder.ts`/`audioRuntime.ts` (commit `de721f0`) and re-ran the test; it
  failed immediately (`resetAudioRuntimeForTests is not a function` - the
  recovery infrastructure didn't exist yet), then I restored the fixed
  files and confirmed green again.
- **Decode outcome**: the recovered, truncated bytes decode successfully.
  Real `ffmpeg` recovers ~3.55s of the original 4s of genuinely non-silent
  audio (`maxAbs` of the PCM > 0.01), logging "File ended prematurely" as an
  informational line, not a fatal error. **Nothing was rejected** - the
  truncated container was decodable throughout my testing, so there was no
  rejection message to report. This matches Matroska's design for streaming
  output (unknown-size segments, no Cues needed to decode what's already
  written) and is consistent with why browsers can play an in-progress
  MediaRecorder blob without ever calling `stop()`.
- **Mutation-tested**: I reversed `stitchRecordingChunks`' `seq` sort as a
  local, reverted probe (`src/storage/recordingChunks.ts` is **unchanged**
  in every commit - the off-limits boundary was never crossed) and
  confirmed the test's EBML-magic-bytes assertion catches the resulting
  corruption (wrong leading bytes, since the header chunk landed last).
  Reverted immediately after confirming.

**The ⚑ concern, stated plainly**: this test's `decode` dependency shells
out to the system's `ffmpeg` (verified present on this machine at
`/opt/homebrew/bin/ffmpeg`) rather than a real `AudioContext`, because
`happy-dom` (this project's only configured test environment) implements no
`AudioContext`/`OfflineAudioContext` at all, and every other audio test in
this codebase (`pcm.test.ts`) has always faked that seam rather than really
decoding anything - there was never a way to exercise a real decoder in this
suite before K8. `ffmpeg` is not an npm dependency (`package.json` and
`package-lock.json` are byte-for-byte unchanged) and no application code
path depends on it, but **`npm test`'s pass/fail for this one file now
depends on a system binary this project has never previously required**. If
your CI image lacks `ffmpeg`, this one test fails loudly (by design - never
a silent skip), which is why I'm marking the overall status
DONE_WITH_CONCERNS rather than plain DONE: I made a judgment call here that
the brief's "no new dependencies" rule is about `npm`/`package.json`, and
that a real decode is worth more than a faked one for the single highest-
stakes test in this unit, but this deserves your explicit sign-off rather
than silent acceptance. `docs/features/s3-spec.md`'s "K8's decode test"
section has the full reasoning, including the fallback position (a pure
EBML structural check) I considered and didn't need.

## Decisions implemented

- **K4** chunks persisted as they arrive via `appendRecordingChunk` - done.
- **K5** `RecordingRecord` created at `start()`, `endedAt: null`, before any
  chunk exists - done.
- **K6** `stop()` stitches then calls `finalizeRecording` (one atomic
  transaction) - never a stitch-then-patch sequence - done. Per ⚑ finding
  #1.
- **K7** startup recovery (`recoverInterruptedRecordings`) runs before
  `queue.resume()`; a chunkless recording is deleted, not left as a husk -
  done.
- **K8** mandatory decode test - done (see above).
- **K9** - not mine; `SessionControls.tsx` is S1's file and untouched here.
- **K26** `DeviceState.batteryPercent`, `onBattery` callback - done.
- **K27** requested on connect (already was), refreshed every 5 minutes
  while connected, reset to `null` synchronously with every disconnect/drop
  path, poll stopped the same moment - done.
- **K28** `0x8A` is the direct page-turn trigger - done.
- **K29** the 5s poll keeps running unchanged as the liveness heartbeat and
  `storedPageCount` source; only what it *triggers* changed - done.
- **K30** no compensation added for the miss rate - done (nothing to do).
- **K31** 300ms dedupe window, non-sliding (keyed off the first press in a
  burst) - done.

Also fixed, per the brief's explicit instruction (the ⚑ finding #2 names
these three): `transcriptionQueue.resume()`, `RecordingsView`'s list load,
and `gaps/analyzer.ts`'s `recordingForNote` all now read
`listFinishedRecordings()` instead of `listRecordings()`. `recordingForNote`
required touching `src/gaps/analyzer.ts`, the one exception the brief grants
into the storage off-limits boundary.

## Mutations I ran and what happened

All of these were introduced, confirmed red, then reverted:

- `recorder.ts`: `seq` always `0` → chunk-ordering test caught it. Skipped
  `await Promise.all(pendingAppends)` before stitching → the await-ordering
  test caught it. Let a `finalize` failure delete the pending row → the
  "leaves it for recovery" test caught it.
- `audioRuntime.ts`: ran `recover()` and `resume()` concurrently instead of
  sequentially → the ordering test caught it. Patched `endedAt` with the
  wrong value → three tests caught it, including the "recover twice"
  regression guard.
- `transcriptionQueue.ts` / `RecordingsView.tsx` / `analyzer.ts`: reverted
  each to its old `listRecordings()` call (or dropped the session-link
  filter) → each new regression test caught it.
- `storage/recordingChunks.ts` (local probe only, never committed):
  reversed the `seq` sort → K8's EBML-magic-bytes assertion caught the
  resulting corruption.
- `controller.ts`: removed the `capturing` guard on `emitPageTurn` → the
  not-capturing test caught it. Removed the dedupe comparison → the dedupe
  test caught it. Restored the old `onPageTurn`'s `pageTurnEmitter.emit()`
  call → both K29 tests caught it.
- `DeviceStatus.tsx`: removed the `batteryPercent !== null` guard → **my
  first version of this mutation was NOT caught** (see below).

## A mutation that was not detected, and what I did about it

My first `DeviceStatus.test.tsx` assertion for "battery hidden when unknown"
was `expect(container.textContent).not.toMatch(/\d+%/)`. When I dropped the
`!== null` guard, the component rendered `" · null% battery"` - which
contains no digits, so that regex passed anyway. The mutation was invisible.
I rewrote the assertion to `not.toContain('battery')` (both the "unknown"
test and the "hides again after going back to null" test), re-ran the
mutation, confirmed it now fails with the exact `"null% battery"` text
visible in the diff, then reverted the component change. This is recorded
here per the instruction to say so plainly rather than treat it as settled
once the test was green.

## Concerns, for the owner

1. **K8's `ffmpeg` dependency** (above) - the main one. Needs an explicit
   yes/no on whether depending on a system binary for one test's pass/fail
   is acceptable, or whether a pure structural (EBML-only, no real decode)
   test would be preferred instead.
2. I did not attempt to compensate for, or even characterize, whether a real
   browser's `AudioContext.decodeAudioData` is *more* or *less* strict than
   `ffmpeg` about a truncated Matroska stream - I have evidence `ffmpeg`
   tolerates it gracefully, but I have no way to test Chrome's actual
   behaviour from this harness. If the owner's "probe the real hardware"
   step (mentioned as still outstanding in `docs/session-handoff.md`) turns
   up a real browser rejecting a truncated recording that `ffmpeg` accepts,
   K8's "chunk bytes remain on disk and recoverable" fallback path
   (a remux step) is the next thing to build - not built here, since the
   test never demanded it.
3. The worktree setup issue (branched from the wrong base, empty
   `node_modules`) cost real time; if other Wave 2 worktrees have the same
   problem, the same fix applies (`git reset --hard phase3` when the branch
   is a strict ancestor; `npm install`).

## Fix round 2 (coordinator review)

Two Criticals, four Importants, plus cheap items. Addressed in full.

### C1 — recovery could delete a lecture another pass just saved

`src/audio/audioRuntime.ts`'s `recoverInterruptedRecordings`:

- **Re-read before delete.** On `stitch(id) === null`, the function now
  re-reads the row and only deletes when it is *still* `endedAt === null`
  **and** `byteLength === 0`. A row some other actor (another tab, or a
  second recovery pass) finalized in between - writing its audio and
  purging its chunks atomically via `finalizeRecording` - fails that check
  and is left alone.
- **`recorder.ts` exposes its active id.** `Recorder` gains
  `getActiveRecordingId(): string | null` (the closure's own `recordingId`,
  already tracked for other purposes). `recoverInterruptedRecordings` takes
  an `activeRecordingId` dep (default:
  `getAudioRuntime().recorder.getActiveRecordingId()`) and skips any
  unfinished row that matches it entirely - never stitching, finalizing, or
  deleting a recording this same process's recorder is actively writing
  right now.

**Tests** (`src/audio/audioRuntime.test.ts`): one seeds an unfinished row,
injects a `stitch` override that itself calls the real `finalizeRecording`
(modelling another actor completing it first) and returns `null`, and
asserts the row survives as the other actor's save rather than being
deleted. The other seeds a live, chunked row and passes
`activeRecordingId: () => pending.id`, asserting the row, its chunks, and
`enqueue` are all completely untouched.

**Mutation-tested** (two reverted probes against `audioRuntime.ts`):
removing the re-read guard (bare `deleteRecording` on `null`) turned the
first test red (`expected undefined to be defined` - the row was gone).
Removing the `activeRecordingId` skip turned the second red
(`expected 5000 to be null` - the live row got finalized). Both reverted.

### C2 — `MediaRecorder` was started before its handler existed

`src/audio/recorder.ts`'s `start()` is reordered: construct the
`MediaRecorder` (needed for its `mimeType`) → resolve deps → `await
createPendingFn(...)` → re-check `stopRequested` (I1) → attach
`ondataavailable`/`onstop`/`onerror` → **then** `nextRecorder.start(timesliceMs)`.
Previously `start()` ran first and the handlers were attached only once
`createPendingFn` resolved, leaving the one real window in which the
recorder could legitimately be producing data - immediately after
`start()` - with nothing listening. Now the real `MediaRecorder` cannot
produce data before `start()` runs, and `start()` runs only after every
handler is already attached: the window is closed structurally, not merely
narrowed.

A `nextRecorder.start()` failure now happens with the pending row already
existing (created above it); that row is deleted immediately rather than
left as an orphan for a future launch's K7 recovery.

**Test**: the previously-vacuous "creates the pending record before any
chunk is appended" test (which asserted `appendChunk` was never called
after a bare `start()` that never emitted anything - true regardless of
ordering) is replaced by a test that holds `createPending` pending with a
manually-resolved promise, confirms the fake `MediaRecorder`'s `state` is
not `'recording'` yet, emits a chunk anyway (proving no handler exists to
drop it silently - the structural proof, not an incidental one), resolves
`createPending`, confirms `state` becomes `'recording'` only then, and
confirms a chunk emitted after that point is captured as seq 0.

**Mutation-tested**: moved `nextRecorder.start()` back to immediately after
construction (the old order) → the new C2 test went red
(`expected 'recording' not to be 'recording'`). Reverted.

Also updated (behaviour now correctly reflects the new order): "reports a
mediaRecorder.start() failure" now expects `createPending` to have been
called once and `deletePending` to clean up the resulting orphan, since
`createPending` now runs before `start()` rather than after.

### I1 — a `stop()` during the `createPending` await was swallowed

A second `stopRequested` check, structurally identical to the existing
getUserMedia-pending one, runs after `createPendingFn` resolves - the only
other await point before `MediaRecorder.start()` is ever called. On a hit:
tracks stop, the now-pointless pending row is deleted (best-effort), state
returns to idle with no error.

**Test**: holds `createPending` pending, calls `stop()` while it's still
pending, confirms `status` stays `'starting'`, resolves `createPending`,
and confirms the mic is released, `deletePending` was called with the
pending row's id, and the `MediaRecorder`'s `state` never became
`'recording'`.

**Mutation-tested**: removed the second `stopRequested` check entirely →
the test went red (`expected 'recording' to be 'idle'` - the recording
started anyway). Reverted.

### I2 — an unguarded `stitchFn` await could hang `stop()` forever

`finish()`'s body (from the `pendingAppends` await onward) now runs inside
a `try/finally`; the `finally` always clears `recordingId` and resolves
every `stopWaiters` entry, regardless of which step inside fails. The
`stitchFn` call itself also gets its own inner `try/catch` (matching the
existing pattern for `finalizeFn`/`deletePendingFn`), reporting through
`state.error` and leaving the row for K7 recovery on rejection.

**Test**: injects a `stitch` that always rejects, confirms `await
recorder.stop()` resolves (not hangs) with `result: null`, `status: 'idle'`,
the right error message, `finalize`/`deletePending` both uncalled (left for
recovery), and - the brick check - that a *new* `start()` succeeds
immediately after.

**Mutation-tested**: removed the inner `try/catch` around `stitchFn`
(keeping the outer `try/finally`, so this specifically tests whether the
inner guard matters on its own) → the test went red on the `status`/`error`
assertions, *and* vitest separately reported an unhandled rejection for the
same run - both symptoms the finding named. Reverted.

### I3 — a failed chunk write was invisible, untested, and `seq 0` was not interchangeable

`appendChunkWithRetry()`: `seq 0` (the container header - EBML, Segment
info, Tracks) gets one retry before being treated as lost; any seq gets a
non-fatal `state.warning` (new `RecorderState` field, reset on every new
`start()`) on final failure, in addition to the existing `console.error`.
The stray `A42` citation in the old comment (no such assumption exists) is
now `A28`, the actual one ("audio must never block writing... reported,
never fatal").

**Tests** (four): seq 0 failing once then succeeding on retry (two calls,
no warning); seq 0 failing on both the attempt and the retry (two calls, a
warning naming "chunk 0" and the underlying error, recording still live); a
non-zero seq failing (exactly one call - no retry - a warning naming
"chunk 1", recording still live); a fresh `start()` clearing a stale
warning from the previous recording.

**Mutation-tested** (two reverted probes): removing the `seq === 0` retry
branch turned both seq-0 tests red (`expected "spy" to be called 2 times,
but got 1`). Separately, removing the `setState({ warning: ... })` call
from `reportFailure` (keeping the `console.error`) turned three tests red,
including a `TypeError` on `.toMatch()` receiving `null` instead of a
string - confirming the warning text itself, not just that *something*
logged, is what the tests depend on. Both reverted.

### I4 — the residual-risk note disclosed the substituted decoder but not the substituted container

Two corrections:

1. **`docs/architecture.md` §8.2's residual-risk note** now explicitly
   names the fixture's provenance: it is `ffmpeg`-authored, not
   `MediaRecorder`-authored - a known-size Segment and a SeekHead pointing
   at the withheld Cues, neither of which a real `MediaRecorder` ever
   writes (its Segment size is unknown from the first byte, and it never
   writes Cues, stop or no stop). The manual check is widened to "capture a
   real `MediaRecorder` crash-truncation... reopen the app, and confirm the
   recovered recording both plays and transcribes" rather than just
   "interrupt a real recording".
2. **Two incorrect statements, corrected at the source:**
   `src/audio/incrementalRecovery.decode.test.ts`'s comment describing the
   withheld Cues as "the role `MediaRecorder.stop()`'s own final flush
   plays in a real recording" is wrong (`MediaRecorder` never writes Cues)
   and is rewritten to say so plainly, pointing at the architecture.md note
   for the full reasoning. This round's own fix-round-1 report entry above
   (now several commits old) separately claimed the result "matches
   Matroska's design for streaming output (unknown-size segments...)" -
   also wrong, since this fixture's Segment is *not* unknown-size; that
   entry is left as the historical record of what I believed at the time
   rather than silently rewritten, with this correction serving as the
   record of what's actually true.

### Cheap items

- `docs/features/s3-spec.md`'s K8 section rewritten to match the fix-round-1
  structural/conditional-decode split (it still described the old single
  "fails loudly with no ffmpeg" design) and to carry the same provenance
  disclosure as the architecture.md note.
- `controller.ts`'s `device.onBattery` now gates on `device.isConnected`
  before calling `setState`, so "never a stale number as current" is true
  by construction. **Test**: a `CMD.BATTERY` reply emitted after
  `transport.dropConnection()` is confirmed not to resurrect a
  just-cleared `batteryPercent`. **Mutation-tested**: removed the gate →
  the test went red (`expected 55 to be null`, got `55`). Reverted.
- The deleted "clearError clears it"/`track.stopped` assertions are
  restored into the finalize-failure test (renamed to say so) in
  `recorder.test.ts`.
- `docs/architecture.md` §8.2 gains a paragraph on the K28/K29 side effect:
  `engine.devicePageNum()` stamps `storedPageCount + 1`, which does not
  rise while streaming (true before S3 too, but S3 is what makes every
  `0x8A` press reliably create a page rather than only the rare one that
  happened to coincide with a ROM-count rise) - so a note written across
  many physical page turns in one sitting now gets many pages all carrying
  the same frozen `devicePageNum`.

### Gates after this round

96 files / **1190 tests** pass (was 1180). `npx tsc -b` clean. `npm run
lint`: 0 errors, the same 5 pre-existing warnings. `npm run build`
succeeds. Off-limits files (`src/storage/*`, `capture/engine.ts`,
`capture/types.ts`, `SessionControls.tsx`, `package.json`,
`package-lock.json`): reconfirmed zero diff against the `517fbe6`
merge-base. Re-verified the `ffmpeg` skip: shadowed it off `PATH` again
(same scratch-script technique as fix round 1) - the structural test still
ran and passed, both real-decode tests reported skipped, the file reported
passed overall; restored real `ffmpeg` and confirmed all 3 pass.

Two cross-unit test files needed the same mechanical fix as everyone who
touches `Recorder`/`RecorderState` will: `src/audio/RecorderControl.test.tsx`
and `src/capture/SessionControls.test.tsx` each have a hand-written fake
`Recorder` that now needs `warning: null` and a `getActiveRecordingId`
stub. `SessionControls.tsx` itself (off limits, owned by S1) was not
touched.
