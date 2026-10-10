# S4 — Typed pages: report

**Status: DONE**

**Worktree:** `/Users/maddiepersonal/takingnotes/.claude/worktrees/s4-typed-pages`
**Branch:** `wave2/s4-typed-pages`

## Environment note (resolved, not a concern for the feature itself)

The worktree I was originally handed was rooted at `origin/main` (230 commits
behind `phase3` — nothing from Phases 1–3 had ever been pushed), with none of
the files this unit needed. I reported that as BLOCKED without attempting to
fix it myself. The coordinator confirmed it, replaced the worktree with one
correctly branched from `phase3`, and separately fixed a `node_modules`
symlink issue in it that caused 6/93 test files to fail to collect and
`lint`/`build` to crash. I had independently diagnosed and fixed the same
symlink symptom myself (via `vitest.config.ts`'s `server.fs.allow`) before
the coordinator's fix landed; once `node_modules` became a real install, my
fix was redundant, so I reverted it (`205eb81`) to keep the branch's diff
scoped to S4's actual work. Confirmed baseline after all of this: **1145
tests across 93 files**, matching the brief exactly.

## Commits (oldest → newest)

```
0b823d8 docs(s4): spec and plan for typed pages
3890379 feat(capture): add newTypedPage to the CaptureEngine interface
6de226e feat(capture): implement newTypedPage and K34's pen-triggered live page
d9b8b54 feat(notes): add TypedPageEditor, an autosaved textarea for a typed page
42891c7 feat(notes): mount "Type page" and swap the canvas for a typed page's editor
```

(Plus two environment-only commits before these, `90300b7` and its revert
`205eb81` — see above.)

## Test summary

**1160 tests across 94 files, all passing.** (Baseline 1145/93 + 15 new: 8 in
`engine.test.ts`, 4 in `TypedPageEditor.test.tsx`, 3 in `NotesView.test.tsx`.)

Four gates, all green on the final commit:
- `npm test` — 1160/94 passing.
- `npx tsc -b` — clean.
- `npm run lint` — 0 errors, the same 5 pre-existing warnings in
  `huionTransport.ts`/`useTriageData.ts` (files this unit never touches).
- `npm run build` — succeeds.

## Decisions implemented

- **K32** (mix handwritten/typed pages in any order): the storage layer
  already allowed this (Wave 1); S4 makes the engine and UI create and
  display typed pages correctly alongside live ones, in sequences exercised
  by tests (`live → typed → live`, `typed → typed`).
- **K33** (typed page's transcript mirrors its text, `status: 'done'`):
  consumed as-shipped from `src/storage/pages.ts`'s `setPageText`; S4 never
  writes `transcript` directly. Verified indirectly through
  `TypedPageEditor`'s and `NotesView`'s tests, which assert
  `transcript.markdown`/`transcript.status` after a save.
- **K34** ⚑ (pen input on a typed page opens a new live page): implemented
  as `startLivePageAfterTyping()` in the engine, triggered from `handlePen`.
  Deliberately does **not** reuse `newPage`'s `closeBuffer()` pattern — that
  would force the stroke that triggered the transition onto the *outgoing*
  (typed) page, which is exactly what A38 forbids. The triggering stroke
  instead lands, unsplit, on the new live page. Covered by three tests,
  including one proving a stroke isn't split and one proving the transition
  fires exactly once per down-stroke, not once per point.
- **K35** (autosaved typed editor reachable from the toolbar): `TypedPageEditor`
  (debounced through `setPageText`, following `useScratchpad`'s
  dirty-tracking/flush-on-unmount pattern) mounted via `NoteToolbar.actions`
  as a "Type page" button.
- **A38** ⚑ (typed page never holds ink, ink page never holds typed text):
  enforced two ways — the ink `buffer` is never pointed at a typed page's id
  (so even a defensive `setPageStrokes` call could never land on one), and
  K34 redirects ink to a fresh page the instant it would otherwise reach the
  typed one. Also closed a gap *not* explicitly called out by the brief but
  required by A38's own "never" framing: `recover()` and `resumeNote()` both
  scan a note's pages and previously queued *every* unfinalized page for
  transcription unconditionally — including a typed one left open by a
  crash, whose `'done'` transcript the transcription queue's `markPending`
  would then overwrite with `'pending'`. Both now route through a shared
  `finalizeLeftOpen()` that only returns a live page's id to queue. Two tests
  cover this (one for each function).

Everything in the brief's "Done when" is implemented and test-covered:
typed-page creation/editing mid-session, `status: 'done'` transcript
mirroring, mixed-order pages in one note, and K34's redirect-to-a-new-live-page.

## My own assumptions worth flagging (documented in `docs/features/s4-spec.md` §6)

- **S4-A1**: `newTypedPage()` requires an active note (no-op → `null`
  otherwise), mirroring `newPage`'s own A7 rule. A brand-new note's page 0 is
  therefore always live — there's no "start a note by typing, pen never
  involved at all" path. The owner's stated scenario ("in case the pad dies
  **mid-lecture**") is about a note already in progress; "New note" then
  "Type page" covers the from-scratch case in two clicks. Flagging this
  explicitly in case the product intent was broader than the interview notes
  in `spec-phase3.md` capture.
- **S4-A2**: `TranscriptPanel` is suppressed for a typed page (shows a wrong
  "Transcribed when the page is finished" message otherwise) — my own call,
  not stated in the spec.
- **S4-A3**: a typed page's editor is open for editing for *any* typed page
  navigated to, not only the currently-active one.
- **S4-A4**: the `recover()`/`resumeNote()` fix above is defense in depth.
  **Correction, added in the fix round below**: I originally framed this as
  "independent of whether the three live engine paths already prevent an
  unfinalized typed page from reaching those loops in practice" — that
  understated it. Review Finding 1 found a real race in exactly those live
  paths (`newTypedPage`'s own write-in-flight window) that *could* leave a
  typed page unfinalized if the app were interrupted mid-window; the
  `recover()`/`resumeNote()` fix is what would have kept that scenario safe
  even before Finding 1's own fix landed. It's covering a real, reachable
  gap, not a hypothetical one.

## Mutation-check results

Every new test was broken-then-reverted. All but one caught the break:

- **Not detected**: `newTypedPage`'s outer `if (!noteOpen) return
  Promise.resolve(null);` early-return. The function's enqueued op has its
  own `if (noteId === null) return null;` immediately inside, and because
  `enqueue` serializes all writes, that inner check alone already produces
  the same observable result (`null`, no note, idle state) for this test. I
  verified this is not a gap specific to my code: the exact same experiment
  against `newPage`'s own pre-existing, already-shipped `if (!noteOpen)
  return Promise.resolve(null);` (its A7 guard) shows the identical
  property — `newPage`'s own "ignores a page turn with no active note (A7)"
  test doesn't catch removal of that early-return either, for the same
  reason. This is a structural characteristic of the double-guard pattern
  already in the codebase, not a weakness I introduced; the outer check's
  only real job is avoiding a wasted `closeBuffer()`/`enqueue` round trip
  when nothing is open; the inner check is what the engine's actual
  correctness story takes to the ask.

All other mutations (pageIndex arithmetic, `pageFinalized` emission for a
live vs. typed page, `closeBuffer()` vs. not in `startLivePageAfterTyping`,
dropping the synchronous `activeTypedPageId` clear, dropping the
`isTypedPage` guard in `finalizeLeftOpen`, the editor's flush-on-unmount,
error-surfacing, initial-text wiring, and value-wiring to `setPageText`, the
`TranscriptPanel` suppression, the canvas swap, and the "Type page" button's
disabled condition) were all caught — tests went red, and green again on
revert.

## Files touched

- `src/capture/types.ts` — `newTypedPage` on `CaptureEngine`.
- `src/capture/engine.ts` — implementation (`newTypedPage`,
  `startLivePageAfterTyping`, `activeTypedPageId`, `finalizeTypedPage`,
  `finalizeLeftOpen`), plus the `handlePen`/`closeNote`/`newPage` touch-points.
- `src/capture/engine.test.ts` — 8 new tests.
- `src/capture/pageTurnTestEngine.ts`, `src/audio/RecorderControl.test.tsx`,
  `src/transcription/startTranscription.test.ts` — one rejecting stub line
  each, the mechanical `tsc -b` fix the brief named.
- `src/notes/TypedPageEditor.tsx` (new), `src/notes/TypedPageEditor.test.tsx`
  (new).
- `src/notes/NotesView.tsx`, `src/notes/NotesView.test.tsx` — "Type page"
  button, canvas swap, `TranscriptPanel` suppression, 3 new tests.
- `docs/features/s4-spec.md`, `docs/features/s4-plan.md`, this report.

## Concerns

None blocking. The one open question is S4-A1 above (typed-from-scratch, no
pen ever involved) — if the owner wants that too, it's a small, scoped
follow-up (teach `openNote` a typed first-page variant), not a rework of
anything shipped here.

---

# Fix round 1

Three findings from review. Addressed in commits `b6ddbf5` (Findings 1 and
2) and `6d0f3df` (Finding 3).

## Finding 1 (Critical) — a stroke could be silently and permanently dropped during `newTypedPage`'s own write

**What changed.** `newTypedPage` cleared `activeTypedPageId` and parked the
ink buffer synchronously, but only set `activeTypedPageId` to the new page's
id *inside* its enqueued op, after `createTypedPage` resolved. A stroke
completing in that window took neither of `handlePen`'s two branches
(`noteOpen` already true, `activeTypedPageId` still null) and its ink sat in
a buffer nothing was scheduled to claim - dropped silently and permanently.

Fixed with two synchronous flags, `typedPagePending` and
`typedToLiveRedirectPending` (declared and documented in `engine.ts` next to
`activeTypedPageId`):

- `typedPagePending` is set before `newTypedPage`'s op is enqueued and
  cleared in that op's `finally` (both the success and the early-return/
  failure paths). `handlePen`'s redirect condition now treats "a typed page
  is being created" the same as "a typed page is active":
  `!typedToLiveRedirectPending && (activeTypedPageId !== null ||
  typedPagePending)`.
- `startLivePageAfterTyping` now reads `activeTypedPageId` **fresh, inside
  its own op**, not captured before it is enqueued. If `newTypedPage`'s op
  had already run by the time this one starts (the chain is FIFO), it has
  set `activeTypedPageId` to the page it just created, and that page gets
  finalized by this op too - "the typed page is created and immediately
  finalised, and a live page takes the ink," exactly as suggested.
- `typedToLiveRedirectPending`, set synchronously the moment the redirect
  fires and cleared in *its* op's `finally`, stops a second point of the
  same down-stroke from queuing a second, redundant redirect before the
  first one has run.

**Test added** (`engine.test.ts`, `typed pages and pen input (K34)` describe
block): `'does not drop a stroke that completes while newTypedPage is still
creating its page'`. Uses a new `vi.mock('@/storage/pages', ...)` with a
`hooks.deferredTypedPage` lever (same countdown-hook pattern already used for
`@/storage/notes`/`@/storage/sessions` in this file) to hold `createTypedPage`
open while a full stroke is delivered, then releases it and asserts the
stroke lands on a new live page with its points intact.

**Mutation-check** (all against the final committed code, reverted after
each):

1. Remove the pending marker (`typedPagePending = true;`):
   ```
   $ npx vitest run src/capture/engine.test.ts -t "does not drop a stroke"
   FAIL ... does not drop a stroke that completes while newTypedPage is still creating its page
   AssertionError: expected [ 'live', 'typed' ] to deeply equal [ 'live', 'typed', 'live' ]
   Tests  1 failed | 54 skipped (55)
   ```
   Detected.
2. Capture `activeTypedPageId` before `enqueue` instead of fresh inside the op:
   ```
   $ npx vitest run src/capture/engine.test.ts -t "does not drop a stroke"
   FAIL ... does not drop a stroke that completes while newTypedPage is still creating its page
   AssertionError: expected typedPage.finalizedAt ("object"/null) to be type of 'number'
   Tests  1 failed | 54 skipped (55)
   ```
   Detected - this is the exact "stale, never-cleared `activeTypedPageId`" consequence reasoned through while designing the fix.
3. Remove the `typedToLiveRedirectPending` guard:
   ```
   $ npx vitest run src/capture/engine.test.ts
   Tests  3 failed | 52 passed (55)
   ```
   Detected (the re-trigger tests and the new test all fail).

All three detected. No mutation went unnoticed for this finding.

## Finding 2 (Important) — a test that could not fail

**What changed.** `'does not emit pageFinalized for the typed page it leaves
behind'` asserted only `expect(finalized).not.toContain(typedId)` against a
`finalized` array that starts empty - true even if the whole K34 redirect
were deleted. Renamed to `'finalizes the typed page it leaves behind,
without emitting pageFinalized for it'` and strengthened to first assert the
redirect actually ran (a third, live page exists and is the active one, and
isn't the note's first page), then assert the typed page it left behind
**is** finalized, and only then assert `finalized` stays empty.

**Mutation-check:**
```
$ npx vitest run src/capture/engine.test.ts -t "finalizes the typed page it leaves behind"
# with the K34 redirect's trigger condition replaced by `false`:
FAIL ... finalizes the typed page it leaves behind, without emitting pageFinalized for it
AssertionError: expected [ 'live', 'typed' ] to deeply equal [ 'live', 'typed', 'live' ]
Tests  1 failed | 54 skipped (55)
```
Detected - confirms the strengthened test now fails under the exact
condition ("redirect deleted") the original version could not catch.

## Finding 3 (Important, scope-limited) — the double-failure data-loss case in `TypedPageEditor`

**What changed.** Documented in `docs/features/s4-spec.md` §8 ("Known
limitations") with the precise triggering condition (a failed debounced
write *and* a failed flush-on-unmount retry of that same pending edit), why
it's not fixed here (a retry policy or navigation guard is a larger design
question; it mirrors a pre-existing `useScratchpad` risk), and a note that
it's pinned by test. No production code changed.

**Test added** (`TypedPageEditor.test.tsx`): `'known limitation: a failed
debounced write followed by a failed unmount flush loses the edit without a
trace'`. Fails both the debounced write and the subsequent unmount-flush
retry, then asserts storage still holds the pre-edit text.

**Sensitivity check** (not a mutation of production code, since this test
intentionally pins current - not fixed - behavior; instead, confirms the
test is actually testing the double-failure condition and not something
vacuous): with the *second* failure removed (unmount flush succeeds), the
same assertion's expected outcome flips:
```
$ npx vitest run src/notes/TypedPageEditor.test.tsx -t "known limitation"
AssertionError: expected 'lost edit' to be 'original'
Tests  1 failed | 4 skipped (5)
```
This confirms the test is sensitive to exactly the double-failure condition
it documents, not trivially true regardless of what fails.

## Framing correction

My original report's S4-A4 called the `recover()`/`resumeNote()` fix
"defense in depth... independent of whether the three live engine paths
already prevent an unfinalized typed page from reaching those loops in
practice." That understated it: Finding 1 found a real, reachable race in
exactly those live paths. The `recover()`/`resumeNote()` fix is what would
have kept a crash during that window safe even before Finding 1's engine fix
landed - it was always covering a real gap, not a hypothetical one.
Corrected in place in the S4-A4 bullet above.

## Final verification

All four gates, after this round, on the final commit:
- `npm test` — **1162 tests across 94 files**, all passing.
- `npx tsc -b` — clean.
- `npm run lint` — 0 errors, same 5 pre-existing warnings in untouched files.
- `npm run build` — succeeds.
