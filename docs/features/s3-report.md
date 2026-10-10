# S3 report — device: battery, the page button, audio that survives

Worktree: `/Users/maddiepersonal/takingnotes/.claude/worktrees/agent-ae6cdce27cee7bb8c`
Branch: `worktree-agent-ae6cdce27cee7bb8c` (branched from `phase3` at `517fbe6`)

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
