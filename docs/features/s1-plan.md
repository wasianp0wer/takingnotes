# S1 — implementation plan

Bite-sized TDD tasks. Each: write the failing test, run it red, implement the
minimum, run it green, mutation-check anything non-trivial, commit. All four
gates (`npm test`, `npx tsc -b`, `npm run lint`, `npm run build`) pass before
every commit.

## 1. K9 — delete the false "audio recording was lost" wording

1. In `src/capture/SessionControls.test.tsx`, rewrite the two tests that
   assert on "recording was lost" / its absence into one test: whatever the
   session's recording history, the banner reads exactly `"{title}" was
   interrupted.` Delete the `hadAudio`-producing seed data that is no longer
   relevant (the recording-less vs recording-having setup collapses to one
   case). Run red (current code still says "recording was lost").
2. In `src/capture/SessionControls.tsx`: delete `hadAudio` from the
   `interrupted` state shape, delete the `listRecordingsBySession` lookup and
   its import, delete the conditional sentence, leave the wording that says
   only "was interrupted."
3. Run green. Mutation-check: revert the wording to include "recording was
   lost" and confirm the test fails; revert back.
4. `tsc -b`, `lint`, `build`, `test` all pass. Commit.

## 2. K45 — greatest-overlap recording selection

1. In `src/gaps/window.test.ts`, add tests for a new `overlapMs(window,
   recording)`: full containment, partial overlap, disjoint (0), and a
   boundary touch (0, not negative). Run red (function does not exist).
2. In `src/gaps/window.ts`, implement `overlapMs`. Run green.
3. In `src/gaps/analyzer.test.ts`:
   - Rewrite "uses the earliest recording linked to the note" to also prove
     overlap, not recency, decides: add a case where the *later*-started
     recording has the greater overlap with the page's window and must win
     (a case the old "earliest" rule would get wrong). Keep the existing
     earlier-wins case too (earlier here also has greater overlap, so both
     paths must select the same way for the right reason).
   - Add "skips a page whose window overlaps no recording" (two recordings,
     neither overlapping the page's window) — `gapEligibility` reports
     `no-recording` and nothing is written, same shape as the existing "no
     linked recording" test but with recordings present and simply too far
     away in time.
   - Add a note-wide (`analyzeNote`) test with two pages, each overlapping a
     different one of two recordings, asserting each page's suggestions
     carry the *other* page's non-matching recording id nowhere — i.e., each
     page's `GapSuggestionRecord.recordingId` is the recording that actually
     overlaps it.
   - Update the two tests seeding an unfinished recording (`endedAt: null`)
     if any exist, or add one: an unfinished recording overlapping a page's
     window in time must still be ignored (`listFinishedRecordings()`, not
     `listRecordings()`).
   Run red.
4. In `src/gaps/analyzer.ts`: replace `recordingForNote` with
   `recordingForPage(noteId, window)` per the spec (candidate gathering via
   `listFinishedRecordings()`, greatest-overlap selection, tie on earliest
   `startedAt` then id). Reorder `runPage` to compute `window` before
   `recording`. Rework `analyzeNote` to resolve each page's own recording
   once (a `Map<pageId, RecordingRecord | null>`) during the pending-marking
   pass and hand it to `runPage` as `resolvedRecording`.
5. In `src/notes/GapPanel.tsx`, swap the one call site: compute the page's
   window before calling `recordingForPage(noteId, window)`. Check
   `GapPanel.test.tsx` still passes unmodified (single-recording-per-note
   cases are unaffected by the selection rule change).
6. Run green. Mutation-check the tie-break and the "ignores unfinished
   recordings" test by reverting the `listFinishedRecordings()` swap back to
   `listRecordings()` and confirming the new test fails; revert back.
7. Four gates, commit.

## 3. `src/notes/resumeLock.ts` — the shared in-flight signal

1. `src/notes/resumeLock.test.ts`: a lock starts with `pending: false`;
   `run(fn)` sets `pending: true` for the duration of `fn` and notifies
   subscribers on both the rising and falling edge; a second `run` call
   while the first is in flight raises its own `pending` (there is only one
   flag, not a counter — the lock never needs to know *how many* calls are
   in flight, only whether any are) and settling the first does not clear it
   while the second is still running (an overlap case, even though product
   usage disables the buttons that would cause one); a thrown `fn` still
   clears `pending` and rethrows. Run red.
2. Implement `createResumeLock()` plus a module-singleton
   `getResumeLock()`/`resetResumeLockForTests()` pair, mirroring
   `startTranscription.ts`'s singleton shape. Run green.
3. Mutation-check: skip the `finally`-style release on a throw and confirm
   the rethrow-clears-pending test fails; revert.
4. Four gates, commit.

## 4. `src/notes/ResumeButton.tsx`

1. `src/notes/ResumeButton.test.tsx` (render with `createRoot`/`act`, no
   testing-library, per the house pattern): renders nothing for the active
   note; renders nothing for a legacy note; renders a "Resume" button for
   any other note that calls `engine.resumeNote(note.id)` on click; the
   button is disabled while `sessionLocked` is true; the button is disabled
   while the shared resume lock is pending, *including* for a different
   `ResumeButton` instance than the one clicked (two instances, click one,
   assert the other is disabled too — this is the test that actually proves
   the lock is shared, not per-component state); a thrown `resumeNote`
   surfaces a visible error and still clears the lock (next click works).
   Run red (component does not exist).
2. Implement `ResumeButton({ note, engine, activeNoteId, sessionLocked })`:
   `useSyncExternalStore` on `getResumeLock()`, `null` render guard for
   active/legacy, `onClick` wraps `engine.resumeNote(note.id)` in
   `getResumeLock().run(...)`, local error state on rejection. Run green.
3. Mutation-check the "shared, not per-instance" assertion: make the lock
   per-instance (a local `useState` instead of the module singleton) and
   confirm that specific assertion fails while the rest stay green; revert.
4. Four gates, commit.

## 5. Wire Resume into the sidebar and the interrupted banner

1. `src/notes/NotesView.test.tsx`: add a test that starting a session, then
   switching to a different existing note, shows a Resume button in that
   note's row, and clicking it makes it the active note (`engine.getState()
   .activeNoteId` changes) and ends the previous session's note. Run red.
2. In `src/notes/NotesView.tsx`, pass `rowActions={(note) => <ResumeButton
   note={note} engine={engine} activeNoteId={state.activeNoteId}
   sessionLocked={sessionLocked} />}` into `NoteList`. Run green.
3. `src/capture/SessionControls.test.tsx`: add a test that the interrupted
   banner's Resume button (present once K9's rewrite lands) calls
   `engine.resumeNote` on the interrupted note and that, mid-call, the
   panel's Start-session-equivalent state (there is no Start button once a
   resume has opened a note, but the *lock* itself) disables a second
   `ResumeButton` rendered elsewhere in the same test tree. Run red.
4. In `src/capture/SessionControls.tsx`, render `<ResumeButton note=
   {interrupted.note} engine={engine} activeNoteId={capture.activeNoteId}
   sessionLocked={isActive} />` beside the interrupted sentence. Run green.
5. `src/capture/SessionControls.tsx`: add `resumeLock.pending` to the Start
   button's `disabled` expression (`disabled={phase !== 'idle' ||
   resumeLockState.pending}`), via `useSyncExternalStore(getResumeLock()
   .subscribe, getResumeLock().getState)`. Add a test: start a resume on one
   note (hold it pending with a controlled promise, as the existing "offers
   only End while a start is in flight" test holds `fake.connect`), and
   assert the Start session button is disabled for as long as it is
   pending, then enabled once it settles. Run red, implement, green.
6. Four gates, commit.

## 6. K16 — the "writing still goes to" banner

1. `src/notes/NotesView.test.tsx`: start a session, select a different note
   in the sidebar, assert `container.textContent` contains `Writing still
   goes to` and the *active* note's title (not the viewed one). Assert the
   banner is absent when viewing the active note itself, and absent with no
   session open. Run red.
2. In `src/notes/NotesView.tsx`, compute the active note's title from
   `notes` and `state.activeNoteId`, and pass a `banner` into `NoteToolbar`
   when `sessionLocked && selectedNoteId !== state.activeNoteId &&
   state.activeNoteId !== null`. Inline JSX is enough; no new file needed
   for one sentence. Run green.
3. Mutation-check: swap the active-note lookup for the viewed note's own
   title and confirm the "names the active note, not the viewed one" test
   fails; revert.
4. Four gates, commit.

## 7. K20 — `src/notes/NoteTitle.tsx`

1. `src/notes/NoteTitle.test.tsx`: renders the current title as text;
   clicking it (or an explicit "Edit" affordance) shows a text input seeded
   with the current title; committing (Enter, or a Save button) a changed,
   non-blank value calls `renameNote(noteId, value)` and returns to text
   display with the new title; committing unchanged text is a no-op (no
   `renameNote` call); committing blank text reverts to the previous title
   and shows an inline error without calling `renameNote` with a blank
   string (duplicating `renameNote`'s own guard client-side, so the user
   sees why nothing happened rather than a thrown-and-swallowed rejection);
   Escape cancels back to the original title without calling `renameNote`. A
   `renameNote` rejection (simulate via a note id that does not exist) shows
   an inline error and leaves editing open so the user can retry or cancel.
   Run red.
2. Implement `NoteTitle({ noteId, title })` with local `editing`/`draft`/
   `error` state. Run green.
3. Mutation-check the "unchanged text is a no-op" test by removing that
   guard and confirming it fails; revert.
4. In `src/notes/NotesView.tsx`, pass `title={selectedNote && <NoteTitle
   noteId={selectedNote.id} title={selectedNote.title} />}` into
   `NoteToolbar`. Add one `NotesView.test.tsx` case: editing the title in
   the mounted view updates what the sidebar row shows for that note (proves
   the slot is wired, not just the component in isolation).
5. Four gates, commit.

## 8. K17–K19, K21 — the naming queue

1. `src/notes/naming/validate.test.ts`: `validateNamingResult` accepts
   `{ title: string, summary: string }` (trimming both), throws on anything
   else (not an object, missing/wrong-typed fields, an array). Run red,
   implement, green.
2. `src/notes/naming/prompts.ts` + `.test.ts`: `getNamingPrompt(model)`
   returns a `PromptSpec`-shaped `{ promptVersion: 'naming-v1', system,
   build({ text }) }`; `build` embeds the joined page text and asks for the
   `{"title": ..., "summary": ...}` shape `validateNamingResult` expects. A
   trivial test asserting the version string and that `build` includes the
   given text is enough — the prompt's wording is not itself a branch to
   cover.
3. `src/notes/naming/queue.test.ts` — the core of this task, each as its own
   red/green step:
   - `noteReadyForNaming` (exported pure function): true for a `complete`
     note whose one page is `done`; true for an `interrupted` note under the
     same condition; false while `active`; false for a `legacy` note; false
     while any page's transcript is `null` and its source is not `typed`;
     true for a `typed` page whose `transcript` is `null` (deliberately
     blank, K33); false when any page's transcript `status` is `'failed'`
     (K19) even if every other page is `done`.
   - `createNamingQueue` with a fake engine (`subscribePageFinalized`), a
     fake transcription-queue (`subscribe`), and `createFakeTextGenerator`
     (reused from `@/gaps/fakeTextGenerator`):
     - a `subscribePageFinalized` event for a page whose note just became
       eligible calls the generator once with the joined page text and
       writes the result through `setNoteSummary` (assert via
       `getNote(noteId)`).
     - a `transcriptionQueue.subscribe` event (not `subscribePageFinalized`)
       for the note's last-finishing page also triggers naming — proves the
       second trigger path, for a note that ended before its pages were
       done.
     - a note with a `failed` page is never enqueued: fire both triggers,
       assert the generator is never called and `note.summary` stays `null`.
     - a note whose joined page text is entirely blank is never enqueued:
       generator never called.
     - two eligible events for the same note while the first job is still
       running de-duplicate to one generator call (mirrors the
       transcription queue's own enqueue-dedupe test).
     - `start()` re-scans on construction: seed a note that is already
       eligible and already has `summary: null` *before* `start()` is
       called, assert it gets named without any live event.
     - `start()` does *not* re-name a note that already has a `summary`
       (even though it would still pass `noteReadyForNaming`) until a live
       event fires for it — proves the startup scan is the
       `summary === null` heuristic from S1-A2, not a blanket re-run.
     - a generator failure is logged and swallowed; the note's title and
       summary are untouched, and a later retry (firing the trigger again)
       tries again (no persisted "already failed, don't retry" state, per
       S1-A2).
   Run each red, implement incrementally, green.
4. `src/notes/naming/startNaming.ts` + a thin test mirroring
   `startTranscription.test.ts` if one exists (check first; if not, a short
   test asserting the singleton is reused across two calls and that
   `resetNamingQueueForTests()` clears it is enough — this file is
   otherwise wiring, not logic).
5. Mutation-check: the "does not re-name a note that already has a summary
   on startup" test, by deleting the `summary !== null` skip and confirming
   it fails; the "de-duplicates while running" test, by removing the dedupe
   check and confirming two generator calls happen instead of one. Revert
   both.
6. Four gates, commit.

## 9. Wire the naming queue into `NotesView`

1. `src/notes/NotesView.tsx`: add an optional `namingQueue` prop to
   `NotesViewProps` (test-only, mirroring the existing `queue` prop), and a
   `useState(() => props?.namingQueue ?? ensureNamingQueue(engine, queue))`
   initializer alongside the transcription queue's.
2. `src/notes/NotesView.test.tsx`: update the shared `render()` helper to
   construct and pass a no-op fake `namingQueue` (a `{ start: vi.fn(async ()
   => {}), subscribe: () => () => {}, idle: vi.fn(async () => {}), stop:
   vi.fn() }`), so no existing or new `NotesView` test can reach a real
   `fetch` — the same reasoning the existing `queue` prop already follows.
   This is a mechanical edit to the test file's setup, not new behavioural
   coverage; no red/green step needed, just confirm the full suite still
   passes.
3. Four gates, commit.

## 10. Full-suite pass and report

1. `npm test`, `npx tsc -b`, `npm run lint`, `npm run build` from a clean
   tree. Confirm the total test count is ≥ 1145 (the frozen baseline) plus
   everything this plan added, across more than 93 files.
2. Re-read `docs/architecture.md` §8 once more against the final diff: no
   edit landed in `src/capture/engine.ts`, `src/capture/types.ts`,
   `src/storage/*`, `src/audio/*`, `src/triage/*`, `src/search/*`, or inside
   `NoteList.tsx`/`NoteToolbar.tsx` themselves (only `NotesView.tsx` passing
   props into their existing slots).
3. Write `docs/features/s1-report.md`, commit.
