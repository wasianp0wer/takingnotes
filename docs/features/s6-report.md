# S6 — Find and smart search: report

Branch `wave3/s6-search`, cut from `phase3`. Spec:
`docs/features/s6-spec.md`. Plan: `docs/features/s6-plan.md`.

## Status: DONE

All four gates pass: `npx tsc -b` clean, `npm run lint` 0 errors (the same
5 pre-existing warnings in `src/triage/useTriageData.ts` and
`src/utils/huionTransport.ts` the handoff described, untouched by this
unit), `npm run build` succeeds, `npm test` **1429 passing in 114 files**
(baseline was 1367/108; +62 tests, +6 files, 0 regressions).

## Commits (oldest to newest)

1. `7cefd66` docs(search): add S6 spec and plan; feat(search): add the shared search corpus reader
2. `777e48a` feat(search): add Find, a pure substring match over the corpus
3. `2c86639` feat(search): add the smart-search prompt registry and JSON validators
4. `4c7395b` feat(search): add the two-stage smart search (screen, then band)
5. `99bf2d7` feat(search): wire smart search to the app's Ollama settings
6. `87717c7` feat(search): add the Search view (Find live, Smart search on demand)
7. `8a51230` feat(app): add the Search tab, wired to cross-tab navigation
8. (this commit) docs(search): add the S6 report

## Decisions implemented

- **K39** — Search is its own tab in `AppShell.tsx`, beside Notes/
  Recordings/Triage, because it spans both.
- **K40** — one query box, two modes: Find recomputes from an
  already-loaded corpus on every keystroke (no model, no debounce needed
  since the match is pure and synchronous); Smart search is an explicit
  button.
- **K41** — both modes cover all five sources: note titles, note
  summaries, page transcripts, typed page text (the same `transcript`
  field, mirrored per K33 - `isTyped` tags which kind a hit came from),
  and audio transcript segments. A hit is page-granular for notes and
  segment-granular for recordings.
- **K42** — smart search is two-stage and summary-first: `search-screen-v1`
  shortlists candidate notes from their summary (or K46's fallback),
  `search-band-v1` reads only those candidates' full page text and bands
  each one strong/moderate/weak, rendered as three separate sections.
- **K43** — both prompts live in a versioned registry
  (`src/search/prompts.ts`), so tuning either after first contact with real
  summaries is traceable.
- **K44** — a summary-less note is reachable by Find regardless; smart
  search states how many notes could not be screened by summary. An empty
  library or a blank query makes zero Ollama calls (the view shows a plain
  "nothing to search yet" message); the screen call's rejection (e.g. an
  unreachable host) propagates as a plain error string the view catches
  and displays — never a stack trace.
- **K46** — a summary-less note (`summary === null`) is screened on its
  title plus its joined page text instead of being invisible to stage 1;
  `unsummarizedCount` is computed over the whole corpus, not narrowed by
  how many candidates the screen stage happens to return.
- **A39** — smart search's cost scales with the number of screened
  candidates (one band call each), not with the size of the library.

**⚠ Superseded by later fix rounds - kept for history, not current status.**
At the time this was written, nothing from the brief had been left
unimplemented *in the sense the brief asked for*, but the pre-merge review
(fix round 3) found that the K41 claim two bullets above ("both modes
cover all five sources") was **false for smart search**: it never read
`corpus.recordings` or `recordingOwner` at all, screening and banding only
on `note.summary` and page text - four of the five sources, not five. That
gap, and several related ones, are fixed in "Fix round 3" below; the
Concerns section has been rewritten to reflect the state after all three
fix rounds rather than left describing the state at first delivery. See
"Fix round 3" for what changed and why the original claim was wrong.

## Mutation-check results

Every new test was mutation-checked (implementation broken, test
confirmed red, change reverted) as it was written. All detected the break
on the first attempt **except one**, caught and fixed before it shipped:

- `SearchView.test.tsx`'s original "Open button" test only exercised a
  note-title hit. Mutating `openFor` to always call `onOpenNotes` (even
  for an audio-segment hit) passed that test unchanged — it never actually
  checked the audio-routing branch. Added a second test
  ("…calls onOpenRecordings, not onOpenNotes, for an audio-segment hit")
  using a real recording + transcript segment; re-ran the same mutation
  and it was now caught. Both the original gap and the fix are visible in
  the final test file.

No other mutation went undetected. Spot-checked mutations included: the
blank-query and null-summary guards in `find.ts`; the out-of-range index
bound and the band-default-to-`'none'` fallback in `validate.ts`; the
numbered-candidate-list and the `(no content)` fallback in `prompts.ts`;
the empty-corpus/blank-query short-circuit, the per-candidate `try/catch`
resilience, the serial (not parallel) band loop, and the exact
`unsummarizedCount` formula in `smartSearch.ts`; the empty-library gate,
the double-click re-entrancy guard (`runningRef`), the Find-results
query-gating, and the try/catch around the smart-search handler (removing
it produced a genuine unhandled rejection, caught by Vitest itself) in
`SearchView.tsx`; and the Search tab's own presence in `AppShell.tsx`.

## Concerns

**Rewritten after fix round 3 to describe the current state - see that
section below for what changed and when.** The two items below were
present-tense "not yet done" when this section was first written; both
have since been substantially addressed. One genuine, deliberate
limitation remains and is named plainly rather than worked around.

- **S6-A6, UPDATED (fix round 1): "links to note + page" is real for notes,
  cross-tab-plus-one-click for a recording's exact segment - by deliberate
  choice, not an open gap.** The coordinator lifted the ownership boundary
  for exactly `src/notes/NotesView.tsx` and `src/recordings/RecordingsView.tsx`
  so this unit could add external-selection support: a Find or smart-search
  hit for a note now selects that exact note *and* page; an audio hit now
  selects the exact recording. The one thing that still takes one extra
  click: seeking to the exact segment timestamp within the audio player,
  because that requires a prop on `RecordingDetail.tsx` - a third file
  never named in the lifted boundary. Rather than reach into a file outside
  the grant, `RecordingsView` selects the right recording and shows a
  "look for the segment at …" hint beside its existing per-segment
  click-to-seek list. The coordinator has since explicitly ruled this
  settled ("a fair degradation... not worth the boundary") - it is recorded
  here as a permanent, intentional limitation, not a TODO.
- **S6-A4, UPDATED (fix round 1 Finding 2, extended fix round 3 I2): a
  failed candidate is reported, not swallowed.** A band-stage failure (and,
  as of fix round 3, a failed screen batch) is still caught so it cannot
  cost the rest of an already-screened run, but it is now counted in
  `uncheckedCount` and `SearchView` reports it in its own line, distinct
  from "No matches." - so a run that could not check some or all of its
  candidates no longer reads as a confidently empty result. K44's "fails
  with a plain *thrown* message" guarantee is still airtight only for the
  very first Ollama call of a run (the first screen batch); every call
  after that degrades to a counted, reported omission instead of a
  thrown error. That is a considered trade-off (see S6-A4 in the spec),
  not an oversight, and is reported as such rather than claimed to be
  fully equivalent to a thrown error.
- `src/search/corpus.ts`'s `recordingOwner` map, originally built by
  calling `recordingsForNote(note.id)` once per note (one
  `listFinishedRecordings()` scan per note), was replaced in fix round 3
  (I5, a boundary extension the coordinator authorised) by
  `recordingOwnersByNote` - one pass over notes and finished recordings
  already loaded, added to `src/storage/recordings.ts`. This concern is
  **resolved**, not outstanding.
- No new setting, store, index or dependency was added; `DB_VERSION` is
  untouched.
- **Not changed, by the coordinator's explicit instruction:** the
  `RecordingDetail` audio-seek gap above, and smart search's result
  quality against real Gemma (K43's own explicitly deferred question -
  the band thresholds and both prompts are expected to need tuning after
  first contact with a real model and real summaries, which this unit
  cannot evaluate from inside a test suite).

---

## Fix round 1

Two findings from the coordinator's review. Baseline going in: 1429 tests
across 114 files, all four gates green. Baseline coming out: **1447 tests
across 114 files**, all four gates green (`npx tsc -b` clean; `npm run
lint` 0 errors, same 5 pre-existing warnings; `npm run build` succeeds;
`npm test` 1447 passing).

### Finding 1 (Important) — K41's "links to" is now a real selection, not just a tab switch

**What changed.** The coordinator lifted the ownership boundary for
exactly `src/notes/NotesView.tsx` and `src/recordings/RecordingsView.tsx`
so this unit could add external-selection support to them.

- `NotesView` gained `external?: NotesExternalSelection` (`{ token,
  noteId, pageIndex }`) and `onExternalSelectionApplied?: () => void`.
  The request is applied inside the *same* render-time comparison block
  that already resolves the default/active-note selection (not in an
  effect — that block exists specifically to avoid a placeholder-frame
  flash, and an external request deserves the same treatment). It sits in
  its own `else if` branch, checked *after* the existing "a note just
  became active" branch and *before* the "nothing chosen yet" fallback.
  The comment at that branch in `NotesView.tsx` writes out why this can
  never fight the active-note branch: `prevActiveNoteId` initializes from
  `state.activeNoteId` at mount, so `activeNoteIdChanged` is always
  `false` on a fresh mount's first render — and `NotesView` is remounted
  fresh every time `AppShell` switches to the Notes tab (Radix's
  `TabsContent` unmounts inactive panels; confirmed by reading
  `@radix-ui/react-tabs`'s `TabsContent` and `@radix-ui/react-presence`'s
  `Presence`, not assumed), which is the only way a Search-driven
  `external` ever arrives. Notifying the caller is deferred to a
  `useEffect` keyed on the applied token, not called inline in that
  render-time block, specifically to avoid React's "update a component
  while rendering a different component" hazard (calling an *ancestor's*
  setState, unlike this file's existing pattern of calling its own).
- `RecordingsView` gained the analogous `external?:
  RecordingsExternalSelection` (`{ token, recordingId, startMs? }`) and
  `onExternalSelectionApplied?: () => void`, applied inside `load()` (an
  effect-driven async function, not render — no hazard to avoid there).
  `load`'s `useCallback` deps were changed from `[]` to `[external,
  onExternalSelectionApplied]` so a new request arriving while this view
  is already mounted still re-runs the subscribing effect and applies
  immediately, not only on the next unrelated reload; `AppShell`'s
  `clearNavigationTarget` was wrapped in `useCallback(() => …, [])` so
  this doesn't resubscribe on every unrelated parent render.
- `AppShell` gained `NavigationTarget` (`'note' | 'recording'`, each
  carrying a monotonic `token`), `openNote`/`openRecording` (bump the
  token, set the target, switch tabs), and `clearNavigationTarget`,
  passed to both views as `onExternalSelectionApplied`.
- `SearchView`'s `onOpenNotes`/`onOpenRecordings` props changed from
  `() => void` to `(noteId, pageIndex) => void` /
  `(recordingId, startMs?) => void`; `openFor` and the smart-search hit's
  `Open` button were updated to pass the real target.
- **One residual gap, by design:** `RecordingsView` cannot seek
  `RecordingDetail`'s `<audio>` element — that element and its `seekTo`
  are private to `RecordingDetail.tsx`, a third file never named in the
  lifted boundary. Rather than stretch the grant to a file it didn't name,
  `RecordingsView` selects the correct recording and shows a one-line hint
  ("Jumped here from search — look for the segment at …") naming the
  timestamp, beside that recording's own segment list (which already has
  per-segment click-to-seek). An audio hit costs one more click than a
  note hit. Flagging this rather than silently reaching into a third file,
  or silently shipping less than asked without saying so.

**Tests added** (all mutation-checked; token/revert pairs below show the
actual commands and output):

`src/notes/NotesView.test.tsx`, new `describe` block (5 tests):
- *a fresh external selection wins over a different note already active
  at mount* — seeds an active note via `engine.resumeNote` **before**
  mounting, then renders with `external` naming a different note/page;
  asserts the external target is shown (via the sidebar's own
  `aria-current` attribute — a new `selectedSidebarTitle()` helper, not
  `container.textContent`, since the sidebar always lists every note's
  title regardless of selection and an earlier draft of this test used
  `.textContent` and failed for the wrong reason before I caught it).
- *calls `onExternalSelectionApplied` once the request has been applied.*
- *re-applies the same note+page on a second request (a new token)* —
  renders, re-renders (no unmount) with the identical `noteId`/`pageIndex`
  but a bumped token, and asserts re-selection; also re-renders with the
  token *unchanged* as a control and asserts it does **not** re-fire.
- *a live session starting after an external selection was already
  consumed still takes over (K16 keeps working).*
- *with no external prop at all, resolves exactly as before* (regression
  guard for every pre-existing test in the file).

Mutation 1 — removed the `hasPendingExternalSelection` branch:
```
$ npx vitest run src/notes/NotesView.test.tsx
× a fresh external selection wins over a different note already active at mount
× calls onExternalSelectionApplied once the request has been applied
× re-applies the same note+page on a second request …
3 failed | 29 passed
```
Reverted; re-ran green (32/32).

Mutation 2 — removed `setAppliedExternalToken(external.token)` (so the
branch always re-fires):
```
$ npx vitest run src/notes/NotesView.test.tsx
× re-applies the same note+page on a second request … (expected 'Manual Pick' to be 'Search Target')
× a live session starting after an external selection was already consumed still takes over …
  (expected 'Search Target' not to be 'Search Target')
× calls onExternalSelectionApplied once the request has been applied
3 failed | 29 passed
```
Reverted; re-ran green (32/32).

Mutation 3 — dropped the `setPageIndex(external.pageIndex)` line:
```
$ npx vitest run src/notes/NotesView.test.tsx
× a fresh external selection wins over a different note already active at mount
  (expected … to contain 'Page 2 of 2')
1 failed | 31 passed
```
Reverted; re-ran green (32/32).

`src/recordings/RecordingsView.test.tsx`, new `describe` block (6 tests):
- *selects the recording an external request names, over the newest-first
  default.*
- *shows the "look for the segment at" hint when the request names a
  timestamp, and clears it on a manual pick.*
- *calls `onExternalSelectionApplied` once the request has been applied.*
- *re-applies the same recording on a second request (a new token).*
- *an unrelated reload (the queue reporting a change) does not re-snap to
  an already-applied request after a manual pick* — added mid-mutation-
  check, see the disclosure below.
- *a request naming an unknown recording id is ignored, falling back to
  the normal default.*

Mutation 1 — removed the whole external-selection block from `load()`:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
× selects the recording an external request names … (expected … to contain 'Target')
× shows the "look for the segment at" hint … (expected … to contain 'look for the segment')
× calls onExternalSelectionApplied once the request has been applied (called 0 times)
× re-applies the same recording on a second request … (expected … to contain 'Target')
4 failed | 13 passed
```
(The "unknown id" test correctly stayed green — it is testing the
fallback path this mutation didn't touch.) Reverted; re-ran green (18/18).

**⚑ Mutation 2 was not detected on the first attempt — disclosing in
full, as the brief asks.** Removing
`appliedExternalTokenRef.current = external.token;` (so the "already
applied" guard never actually records anything) passed **all 17 tests
that existed at that point**:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
✓ 17 tests passed
```
Cause: my "re-applies the same recording" test's manual-pick step clicks
a row directly (`setSelectedId` in the `onClick`), which never calls
`load()` at all — so there was no scenario in which `load()` ran a second
time while the *same, unchanged* `external` value was still present. The
only two `load()` calls in that test happened because `external` itself
had just changed (which is exactly when the guard is supposed to let the
request through) — so a guard that never worked would have looked
identical. I added a new test, *an unrelated reload (the queue reporting
a change) does not re-snap to an already-applied request after a manual
pick*: same `external` value for the entire test, a manual pick, then
`queue.fireChange()` (a reload with no prop change at all, simulating a
transcript status update), asserting the manual pick survives it. Re-ran
the same mutation against the fixed test file:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
× an unrelated reload (the queue reporting a change) does not re-snap to an already-applied request after a manual pick
  (expected 'TargetDec 31, 1969, 7:00 PM · 1:05Not…' to contain 'Other')
1 failed | 17 passed
```
Now caught. Reverted; re-ran green (18/18, the new test included).

Mutation 3 — dropped the `list.some((r) => r.id === external.recordingId)`
existence check:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
× a request naming an unknown recording id is ignored, falling back to the normal default
  (AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion)
1 failed | 17 passed
```
Reverted; re-ran green.

Mutation 4 — dropped `setSegmentHintMs(external.startMs ?? null)`:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
× shows the "look for the segment at" hint … (expected … to contain 'look for the segment')
1 failed | 17 passed
```
Reverted; re-ran green.

Mutation 5 — dropped `setSegmentHintMs(null)` in the manual-pick
`onClick`:
```
$ npx vitest run src/recordings/RecordingsView.test.tsx
× shows the "look for the segment at" hint … (expected … not to contain 'look for the segment')
1 failed | 17 passed
```
Reverted; re-ran green.

`src/app/AppShell.test.tsx` (2 new end-to-end tests, seeding real notes/
pages/recordings and driving the whole `AppShell` tree):
- *a Search hit's Open button for a note navigates to the exact note and
  page it names* — types a query, clicks `Open`, asserts the Notes tab is
  active, the right note is the sidebar's `aria-current` row, and "Page 2
  of 2" is shown.
- *a Search hit's Open button for a recording switches to Recordings with
  that recording selected* — asserts the Recordings tab is active, the
  right recording is selected, and the segment hint names the right
  timestamp.

Mutation 1 — swapped `noteTarget`/`recordingTarget` wiring (passed
`undefined` as `NotesView`'s `external`):
```
$ npx vitest run src/app/AppShell.test.tsx
× a Search hit's Open button for a note navigates to the exact note and page it names
  (expected … to contain 'Page 2 of 2')
1 failed | 6 passed
```
Reverted; re-ran green (7/7).

Mutation 2 — dropped `setTab('notes')` from `openNote`:
```
$ npx vitest run src/app/AppShell.test.tsx
× a Search hit's Open button for a note navigates to the exact note and page it names
  (expected 'inactive' to be 'active')
1 failed | 6 passed
```
Reverted; re-ran green (7/7).

**Also re-verified** (touched by this round's `SearchView.tsx` signature
change, not newly written): mutating `hit.pageIndex ?? 0` to `hit.pageIndex!`
(so a note-title hit would pass `undefined` instead of `0`) was caught by
the existing "defaults to page 0 for a note-title hit" test
(`toHaveBeenCalledExactlyOnceWith(note.id, 0)` failed with `undefined`
received). Reverted; re-ran green.

### Finding 2 (Important) — band-stage failures now report as "could not check", not "no matches"

**What changed.** `SmartSearchResult` gained `uncheckedCount: number`
(`src/search/smartSearch.ts`): incremented in the existing per-candidate
`catch` block (the one that already drops a failed candidate so it can't
cost the rest of the run), so the drop is now counted rather than
silently vanishing. `SearchView.tsx` renders it in its own line
("N notes could not be checked — search failed partway through for
…"), styled `text-destructive`, placed above the Strong/Moderate/Weak
sections so it is visible whether or not any section also has hits.

**Tests added:**

`src/search/smartSearch.test.ts` (3 tests, one updated):
- *the existing "drops only the candidate whose band call rejects" test*
  gained an assertion that `result.uncheckedCount === 1`.
- *a run where some band calls fail reports both the hits it got and the
  count it could not check* — three candidates, one band call fails,
  asserts both surviving hits and `uncheckedCount === 1`.
- *a run where every band call fails reports zero hits and a non-zero
  `uncheckedCount`, not an indistinguishable empty result* — two
  candidates, both band calls fail, asserts all three bands empty and
  `uncheckedCount === 2`.

Mutation — removed `result.uncheckedCount += 1;` from the catch block:
```
$ npx vitest run src/search/smartSearch.test.ts
× drops only the candidate whose band call rejects … (expected 1 to be 0)
× a run where some band calls fail reports both the hits it got and the count it could not check (expected 1 to be 0)
× a run where every band call fails reports zero hits and a non-zero uncheckedCount … (expected 2 to be 0)
3 failed | 13 passed
```
Reverted; re-ran green (16/16).

`src/search/SearchView.test.tsx` (2 tests):
- *reports both the hits it got and the count it could not check when
  some band calls fail* — asserts the rendered hit text and the
  "1 note could not be checked" line both appear.
- *does not read as 'no matches' when every band call fails* — a single
  candidate whose band call fails; asserts the "could not be checked"
  line appears (rather than only the three bands' own "No matches.").

Mutation — changed `{smart.uncheckedCount > 0 && (…)}` to `{false && (…)}`:
```
$ npx vitest run src/search/SearchView.test.tsx
× reports both the hits it got and the count it could not check when some band calls fail
  (expected … to contain '1 note could not be checked')
× does not read as 'no matches' when every band call fails
  (expected … to contain '1 note could not be checked')
2 failed | 11 passed
```
Reverted; re-ran green (13/13, before Finding 1's two further additions
brought the file to 14).

### Summary of mutations not detected this round

One, found and fixed within this round rather than shipped: RecordingsView's
`appliedExternalTokenRef` update (Finding 1, Mutation 2 above). No mutation
was left undetected in the final, committed test suite — every mutation
listed above was re-run against the final test files after any fix and
confirmed caught.

---

## Fix round 2

One finding. Baseline going in: 1447 tests across 114 files, all four
gates green. Baseline coming out: **1451 tests across 114 files**, all
four gates green (`npx tsc -b` clean; `npm run lint` 0 errors, same 5
pre-existing warnings; `npm run build` succeeds; `npm test` 1451 passing).

### Finding (Important) — nothing proved `AppShell` issues a new token per click

The coordinator froze `AppShell`'s note-path token bump
(`navigationTokenRef.current += 1;` → no-op) and all 7 `AppShell` tests at
the time still passed: the contract was tested on `NotesView`'s side (it
re-applies when the token changes) but never on `AppShell`'s side (that
the token actually changes).

**I tried the literal fix first, then confirmed empirically why it doesn't
close the gap, before reaching for the fallback.** Added a round-trip test
— click a Search hit, navigate away to a third tab, navigate back to
Search, retype the query, click the identical hit a second time, assert
the second click still lands on the right note+page. It passes. I then
re-ran the coordinator's exact mutation (froze the note-path bump) against
that new test:

```
$ npx vitest run src/app/AppShell.test.tsx
✓ 8 tests passed
```

**Still green — the mutation is invisible to any test that goes through a
real tab round-trip.** Both `NotesView` and `RecordingsView` are remounted
fresh by Radix's `TabsContent` every time `AppShell` switches back to
their tab (the same fact fix round 1's own `NotesView` comment relies on
to show its two selection-resolution branches never fire on the same
render). A fresh mount's `appliedExternalToken` starts at `null` regardless
of what `external.token` is, so it re-applies *any* defined `external`
prop on arrival — including a frozen, repeated token — and a second
delivery of the identical note+page produces identical rendered output
either way. The downstream view's own "already applied" bookkeeping is
wiped by the remount before a second delivery, frozen or not, ever reaches
it. This is exactly the "say so" case the coordinator's ask anticipated,
so I did not keep the round-trip test as the safety net (it is kept anyway,
as a real regression guard for the end-to-end feature - it just does not,
and structurally cannot, prove this specific contract) and instead pulled
the token bump itself out into a directly-testable seam.

**The fix:** `src/app/AppShell.tsx` gained `createNavigationTargetFactory`
(exported), a plain closure holding one `token` counter with two methods,
`.note(noteId, pageIndex)` and `.recording(recordingId, startMs?)`, each
bumping the shared counter and returning the tagged target object.
`AppShell`'s `openNote`/`openRecording` were reduced to one line each,
calling `navigationTargets.note(...)`/`navigationTargets.recording(...)` -
the factory instance is built once via `useState(createNavigationTargetFactory)`.
This is the literal code `openNote`/`openRecording` run; testing the
factory directly tests whether `AppShell` would ever hand out a repeated
token, independent of whether `NotesView`/`RecordingsView` happen to mask
the consequence today.

**Tests added**, `src/app/AppShell.test.tsx`:
- *clicking the same Search hit a second time, after navigating away and
  back, still lands on the right note and page* — the round-trip test
  described above. Kept as a feature-level regression guard; does not by
  itself prove token monotonicity (see above).
- `describe('createNavigationTargetFactory (Fix round 2)')`, three tests:
  - *bumps the token on every call on the note path, never repeating it -
    even for the identical note+page.*
  - *bumps the token on every call on the recording path, never repeating
    it - even for the identical recording.*
  - *shares one monotonic counter across both paths, so no two targets of
    either kind ever collide* — four calls alternating `.note`/`.recording`,
    asserting all four tokens are distinct.

**Mutation 1 — froze the note-path bump** (removed `token += 1;` from
`.note`):
```
$ npx vitest run src/app/AppShell.test.tsx
× bumps the token on every call on the note path, never repeating it - even for the identical note+page
  (expected +0 not to be +0)
× shares one monotonic counter across both paths, so no two targets of either kind ever collide
  (expected 3 to be 4)
2 failed | 9 passed
```
Reverted; re-ran green (11/11).

**Mutation 2 — froze the recording-path bump** (removed `token += 1;`
from `.recording`):
```
$ npx vitest run src/app/AppShell.test.tsx
× bumps the token on every call on the recording path, never repeating it - even for the identical recording
  (expected +0 not to be +0)
× shares one monotonic counter across both paths, so no two targets of either kind ever collide
  (expected 2 to be 4)
2 failed | 9 passed
```
Reverted; re-ran green (11/11).

Both bumps are now caught independently and together. No mutation went
undetected this round.

---

## Fix round 3

A pre-merge review with one Critical and six Important findings, worked
in the order given. Baseline going in: 1451 tests across 114 files, all
four gates green. Baseline coming out: **1498 tests across 115 files**
(new file: `src/search/screenBatch.test.ts`), all four gates green
(`npx tsc -b` clean; `npm run lint` 0 errors, same 5 pre-existing
warnings; `npm run build` succeeds; `npm test` 1498 passing).

The review also credited this unit's prior rigour directly (the
remount-premise design, the two self-found undetected mutations) and
flagged that the findings below, while real, are concentrated rather than
spread across the unit. Addressed in order: C1, I1, I2, I3, I6, then I4,
I5, M2 as the "if you still have room" items. M5 was consciously not
attempted - see its own entry below for why, stated rather than silently
skipped. M6 and M10 are folded into the entries above that already touch
the same text.

### C1 (Critical) — smart search never read recording transcripts

**What was wrong.** `src/search/smartSearch.ts` never referenced
`corpus.recordings` or `corpus.recordingOwner` at all. Both the screen
stage's candidate text and the band stage's detail text came only from
`note.summary` and page text - four of K41's five sources, not five. This
made smart search blind to exactly the case it exists for (a lecture
spoken at length but barely written down), and compounded K46: a note
whose page transcription failed has no summary and no page text, so with
this gap it was screened on a bare timestamp title even when its full
Whisper transcript was already sitting in `corpus.recordings`, already
attributed to it by `corpus.recordingOwner` - read, mapped, and never used.

**The fix.**
- `src/search/corpus.ts`: each `SearchNote` gained `audioText` (its owned,
  done-transcribed recordings' `AudioTranscriptRecord.text`, joined oldest
  first) and `primaryRecordingId` (the earliest contributing recording, or
  `null`).
- `src/search/smartSearch.ts`: `screenTextFor` appends `audioText` (capped,
  `SCREEN_AUDIO_TEXT_MAX = 800`) to whichever base text applies (summary or
  K46's fallback); `detailTextFor` joins page text and the full
  `audioText`, capped at `DETAIL_TEXT_MAX_CHARS`.
- Band granularity ruling (given by the coordinator rather than left to
  guess): a smart-search hit stays note-granular, but when a note has no
  page text at all, its hit now carries `recordingId:
  note.primaryRecordingId` instead of implying a page that was never the
  source. `SearchView`'s smart-hit "Open" button opens that recording when
  set, the note otherwise.
- The report's own K41 bullet ("both modes cover all five sources") was
  false at the time it was written; corrected above rather than silently
  left to read as though it had always been true.

**Tests added** (`src/search/smartSearch.test.ts`, `src/search/corpus.test.ts`,
`src/search/SearchView.test.tsx`):
- corpus.test.ts: joins a note's owned, done-transcribed recordings into
  `audioText` oldest-first and names the earliest as `primaryRecordingId`;
  excludes a failed/running transcript and a recording with no owning
  note; a note with no recordings has `audioText: ''` and
  `primaryRecordingId: null`.
- smartSearch.test.ts: feeds `audioText` into the screen stage alongside a
  summary; feeds it into K46's fallback when there is no summary or page
  text; feeds the *full* transcript (not the screening gist) into the band
  stage; a hit for a page-text-less note carries `recordingId`; a hit for
  a note with page text does not, even when it also has a recording; a
  hit for a note with neither carries no `recordingId` at all.
- SearchView.test.tsx: a smart-search hit's Open button opens the
  recording, not the note, when the note has no page text.

Mutation 1 — removed `audioText` from the screen stage's text (`corpus.ts`
untouched; `smartSearch.ts`'s `screenTextFor` returns `base` only):
```
$ npx vitest run src/search/smartSearch.test.ts
× feeds a note's recording transcript into the screen stage alongside its summary (C1)
× feeds a note's recording transcript into the K46 fallback when it has no summary and no page text (C1)
2 failed | 26 passed (28)
```
Reverted; re-ran green (28/28).

Mutation 2 — removed `audioText` from the band stage's detail text:
```
$ npx vitest run src/search/smartSearch.test.ts
× feeds the full recording transcript (not just the screening gist) into the band stage
  (expected '...NOTES (titled "Note a"):\n(the note has no content)' to contain '...')
1 failed | 27 passed
```
Reverted; re-ran green.

Mutation 3 — forced `recordingId` to always be `undefined`:
```
$ npx vitest run src/search/smartSearch.test.ts
× a hit for a note with no page text offers its recording as the Open target instead of a page (C1's band-granularity ruling)
  (expected undefined to be 'rec-1')
1 failed | 27 passed
```
Reverted. Mutation 4 — forced `recordingId` to always be set when a
recording exists, regardless of page text:
```
$ npx vitest run src/search/smartSearch.test.ts
× a hit for a note that has page text keeps pointing at the note, even when it also has a recording
  (expected 'rec-1' to be undefined)
1 failed | 27 passed
```
Reverted; re-ran green (28/28).

Mutation 5 — `corpus.ts`: dropped the `isDoneTranscribed` filter (a
failed/running transcript's stale `.text` would then count):
```
$ npx vitest run src/search/corpus.test.ts
× excludes a failed or still-running transcript from audioText, and skips a recording with no owning note
  (expected 'leftover text from a stale attempt' to be '')
1 failed | 5 passed
```
Reverted. Mutation 6 — reversed the oldest-first sort:
```
$ npx vitest run src/search/corpus.test.ts
× joins a note's owned, done-transcribed recordings into audioText, oldest first...
  (expected 'second half of the lecture\n\nfirst half...' to be 'first half...\n\nsecond half...')
1 failed | 5 passed
```
Reverted; re-ran green (6/6).

Mutation 7 — `SearchView.tsx`: `openSmartHit` always calls `onOpenNotes`:
```
$ npx vitest run src/search/SearchView.test.tsx
× a smart-search hit's Open button opens the recording, not the note, when the note has no page text (fix round 3, C1)
  (expected "spy" to be called once with arguments - called 0 times)
1 failed | 17 passed
```
Reverted; re-ran green.

### I1 (Important) — K46's fallback overclaimed for a note with nothing

**What was wrong.** When a summary-less note also had no page text, the
view reported it as "screened by title and page text" - an overclaim for
exactly the population K46 names (legacy notes, a note whose
transcription failed). C1's fix dissolves most of this (those notes now
usually have `audioText`), but a note with no summary, no page text *and*
no recording still exists and still deserves an honest sentence.

**The fix.** `SmartSearchResult` gained `titleOnlyCount`: the subset of
`unsummarizedCount` with empty page text *and* empty `audioText`.
`SearchView` renders two lines instead of one: the genuinely-screened-by-
fallback subset (`unsummarizedCount - titleOnlyCount`) gets "N notes have
no summary yet and were screened by title and page text or recording
content instead."; `titleOnlyCount` gets its own, separate "N notes have
neither page text nor a recording, and were screened by title alone."

**Tests added** (`src/search/smartSearch.test.ts`, `describe('titleOnlyCount (I1)')`,
and two `SearchView.test.tsx` tests for the two distinct lines): counts a
summary-less note with nothing; does not count one with page text; does
not count one with only recording text; does not count a note that has a
summary at all; stays `<= unsummarizedCount` and independent of what the
screen stage returns.

Mutation — `titleOnlyCount` computed as `unsummarizedCount` itself
(dropped the page-text/audio-text filter):
```
$ npx vitest run src/search/smartSearch.test.ts
× titleOnlyCount (I1) > does not count a summary-less note that has page text
× titleOnlyCount (I1) > does not count a summary-less note that has only recording text
× titleOnlyCount (I1) > is always <= unsummarizedCount, and both are independent of what the screen stage returns
3 failed | 25 passed (28)
```
Reverted; re-ran green (28/28).

### I2 (Important) — the screen prompt was unbounded over the whole library

**What was wrong.** Every note's candidate went into one `generateJson`
call with no cap on count, while per-candidate text was capped at 1000
characters (never truncating a real summary). The project's own ceiling
for one un-chunked prompt is `GAP_DIRECT_CHAR_BUDGET = 6000`
(`src/gaps/constants.ts`); past it, Ollama truncates the *front* of the
prompt - where the system prompt and query line live - producing either a
validator-rejected non-answer or a plausible array keyed only to whatever
survived truncation, silently losing every note screened off the front.

**The fix.** `src/search/screenBatch.ts`'s `batchScreenCandidates` (new
file, mirroring `gaps/chunk.ts`'s precedent) splits candidates into
batches within `SCREEN_BATCH_CHAR_BUDGET` (= `GAP_DIRECT_CHAR_BUDGET`),
never splitting one candidate across two batches. `runSmartSearch` now
makes one screen call per batch, unions the chosen indices, and (per the
coordinator's explicit instruction) counts any failed batch's candidates
into `uncheckedCount` rather than letting the whole run reject - "the
screen stage" is no longer one atomic call once batched, so it now
degrades the same way the band stage's existing per-candidate resilience
already does.
`validateScreenIndices`'s signature changed from a candidate *count* to
the exact `Set` of indices a given call actually offered - under
batching, a count-based `1..N` range would wrongly accept an index that
belongs to a *different* batch's own prompt (one this call never showed
the model).

**Tests added:**
- `src/search/screenBatch.test.ts` (new, 8 tests): single batch when well
  under budget; `[]` for no candidates; splits once the running total
  would exceed budget; never splits one candidate across two batches;
  covers every candidate exactly once, in order; a single oversized
  candidate still gets its own batch; defaults to
  `SCREEN_BATCH_CHAR_BUDGET` and falls back to it for a non-positive
  budget; **counts the title's own length toward the budget, not just the
  text** (added after a first version of this suite failed to catch
  exactly that - see its own mutation below).
- `src/search/validate.test.ts`: a non-contiguous valid set is accepted
  exactly; an index that is numerically in range but was never offered by
  *this* call (belongs to a different batch) is dropped.
- `src/search/smartSearch.test.ts`: a failed screen call (unbatched, small
  library) counts both its candidates into `uncheckedCount` rather than
  rejecting the whole run; a seven-note run (forcing two real batches
  against the real 6000-char budget) with the first batch's call failing
  still bands the second batch's chosen candidate.

Mutation 1 — `screenBatch.ts`: disabled the budget check entirely (`if
(false)` in place of the overflow condition). Re-run fresh, against the
current 8-test file, to get this exactly right rather than from memory:
```
$ npx vitest run src/search/screenBatch.test.ts
× splits into multiple batches once the running total would exceed the budget
× counts the title's own length toward the budget, not just the text
× still gives a single oversized candidate its own batch rather than dropping it
3 failed | 5 passed (8)
```
Reverted; re-ran green (8/8).

**⚑ Mutation 2 was not detected on the first attempt.** Changed the
batch-size calculation from `candidate.title.length + candidate.text.length`
to `candidate.text.length` alone (silently dropping the title from the
budget):
```
$ npx vitest run src/search/screenBatch.test.ts
✓ 7 tests passed
```
Cause: every existing test used short, near-identical titles ("Note N"),
so omitting the title's length never pushed a batch over its test
budget by enough to produce a different split. Added a dedicated test -
two candidates with a 95-character title each and 1-character text,
split at a 150-character budget, which only splits if the title is
counted - and re-ran the same mutation:
```
$ npx vitest run src/search/screenBatch.test.ts
× counts the title's own length toward the budget, not just the text
  (expected [ [...] ] to have a length of 2 but got 1)
1 failed | 7 passed
```
Now caught. Reverted; re-ran green (8/8, the new test included).

Mutation 3 — `validate.ts`: dropped the `!validIndices.has(index)` bound
check (back to accepting any integer):
```
$ npx vitest run src/search/validate.test.ts
× an empty array, or an array that fully drops, validates to []
× drops an index that is numerically in range but was never offered by this call (a different batch's index)
2 failed | 14 passed
```
Reverted; re-ran green (16/16).

Mutation 4 — `smartSearch.ts`: dropped `result.uncheckedCount += batch.length`
on a failed batch:
```
$ npx vitest run src/search/smartSearch.test.ts
× fix round 3, I2: a failed screen batch is caught and counted into uncheckedCount...
× one failed screen batch does not stop a later batch in the same run from being screened and banded
  (expected +0 to be 5)
2 failed | 26 passed
```
Reverted; re-ran green (28/28).

### I3 (Important) — band labels were coupled only by authorship

**What was wrong.** The band prompt's wording hand-typed
`"strong"/"moderate"/"weak"/"none"`, and `validate.ts`'s `BAND_VALUES` set
hand-typed the same four. Nothing would have broken if a future prompt
retune renamed or added a band except that the validator would silently
default every such row to `'none'`, dropping every hit in that band with
every test still green - the exact class of defect the review's own
`toContain('"band"')`-vs-`toContain('"band_label"')` example describes
one level up.

**The fix.** `src/search/prompts.ts` now exports `SMART_SEARCH_BANDS`
(`['strong', 'moderate', 'weak']`, also now the home of the
`SmartSearchBand` type, moved from `validate.ts`) and `BAND_LABELS`
(the same three plus `'none'`). The band prompt's system text is built
from `BAND_LABELS` via a `BAND_RULE_LIST` join, not hand-typed prose.
`validate.ts`'s `BAND_VALUES` is `new Set(BAND_LABELS)` - the same array,
imported, not re-typed. `SearchView.tsx`'s own hand-copied
`BANDS = ['strong','moderate','weak']` (a *third* duplication the review
didn't name explicitly but is the same risk) was also replaced with an
import of `SMART_SEARCH_BANDS`. The screen prompt's worked example
(`[1, 4, 7]`) is now `SCREEN_EXAMPLE_INDICES`, exported and interpolated
into the prompt text, and imported verbatim by its own round-trip test
rather than a hand-typed `[1, 3]` stand-in.

**Tests added** (`src/search/prompts.test.ts`): `it.each(BAND_LABELS)`
round-trips *every* label the prompt quotes through `validateBandResult`
to itself, and asserts the prompt's own system text actually contains
`"${label}"` for each - so a renamed or added band is covered
automatically, not by a hand-maintained list of expected labels; the
screen-prompt round-trip now builds its reply from
`SCREEN_EXAMPLE_INDICES` and asserts the prompt's own text contains the
same literal array rendering.

Mutation 1 — renamed `'none'` to `'not-relevant'` in `BAND_LABELS` only
(leaving the prompt's `BAND_DESCRIPTION` record incomplete for the new
key, simulating a half-done rename):
```
$ npx tsc -b
src/search/prompts.ts(54,3): error TS2353: Object literal may only specify
  known properties, and 'none' does not exist in type
  'Record<"strong" | "moderate" | "weak" | "not-relevant", string>'.
src/search/smartSearch.ts(206,11): error TS2367: This comparison appears
  to be unintentional because the types
  '"strong" | "moderate" | "weak" | "not-relevant"' and '"none"' have no overlap.
src/search/smartSearch.ts(214,7): error TS7053: Element implicitly has an
  'any' type... Property 'not-relevant' does not exist on type 'SmartSearchResult'.
```
Caught at the type level before a test even ran - `BAND_DESCRIPTION`'s
type is keyed off `BandLabel` (derived from `BAND_LABELS`), so an
incomplete rename cannot compile. Reverted; `npx tsc -b` clean again.

**Correcting an overstated claim in an earlier draft of this entry, found
by actually running the experiment rather than asserting it:** a second
attempt renamed `'weak'` to `'faint'` *everywhere the string literal
appears* (`prompts.ts`'s array and description record, `smartSearch.ts`'s
`SmartSearchResult`/`SmartSearchHit` field), to check whether I3's fix
makes a full band rename a one-array-edit operation. It does not, and
should not be reported as if it does:
```
$ npx tsc -b
src/search/SearchView.tsx(46,3): error TS2353: ...'weak' does not exist
  in type 'Record<"strong" | "moderate" | "faint", string>'.
src/search/smartSearch.test.ts(81,19): error TS2339: Property 'weak' does
  not exist on type 'SmartSearchResult'. (x7, across the test file)
```
This is correct, expected behaviour, not a gap: `SmartSearchResult`'s
`strong`/`moderate`/`weak` fields are a hand-written TypeScript interface,
not generated from `SMART_SEARCH_BANDS` - I3's fix couples the *prompt
wording* to the *validator's accepted values* (the literal finding), not
every field name derived from a band anywhere in the codebase, and a real
rename correctly still requires touching `SearchView.tsx`'s own
`BAND_LABEL` record and both the production and test references to the
result's field names by hand, caught by the compiler and by tests that
reference the old name directly - not silently. Reverted all three
files; `npx tsc -b` clean, full `src/search` suite green (108/108)
afterward.

### I6 (Important) — stale smart-search results outlived their query

**What was wrong.** `onChange` set `query` and cleared nothing. Running
smart search for "entropy", getting a Strong hit, then typing "osmosis"
left the entropy hit's bands sitting under the now-current Find results
for osmosis, reading as an answer to a query they were never computed
for - or, worse, three "No matches." lines reading as "osmosis isn't in
your notes" when they were never asked about osmosis at all.

**The fix.** `handleQueryChange` now also calls `setSmart(null)` and
`setError(null)` on every keystroke.

**Tests added:** runs smart search, confirms the hit renders, types a
different query, confirms the hit (and the whole Strong/Moderate/Weak
block) is gone; the analogous test for a smart-search error.

Mutation — dropped `setSmart(null)`/`setError(null)` from
`handleQueryChange`:
```
$ npx vitest run src/search/SearchView.test.tsx
× clears a stale smart-search result when the query changes (fix round 3, I6)
× clears a smart-search error when the query changes
2 failed | 22 passed
```
Reverted; re-ran green (24/24 - by then I4/I5/M2's tests had also landed).

### I4 (Important, "if room") — Find had no debounce, no minimum length, no cap, and a linear lookup inside the segment loop

**The fix, in `src/search/find.ts`:**
- `MIN_QUERY_LENGTH = 2`: `findInCorpus` returns `[]` below it, not just
  for a blank query.
- The per-matching-segment `corpus.notes.find(...)` (a linear scan,
  called once per *matching segment*, not once per `findInCorpus` call)
  is hoisted into a `noteId -> title` `Map` built once.

**In `src/search/SearchView.tsx`:** Find now recomputes/renders from a
`debouncedQuery` (150ms, `FIND_DEBOUNCE_MS`), not the raw `query` the
`Input` stays bound to; rendered hits are capped at `FIND_RESULTS_CAP`
(50) with a "Showing first 50 of N matches." line naming the true total.

**Tests added:** `find.test.ts` - returns `[]` below `MIN_QUERY_LENGTH`
even for a non-blank query; matches once the query reaches it; attributes
an audio hit to the *right* note's title out of several (pins the
hoisting didn't lose per-recording attribution). `SearchView.test.tsx` -
does not search below `MIN_QUERY_LENGTH` in the UI; a hit is not shown
immediately after typing, only once the debounce elapses; caps rendered
hits and states the true total.

Mutation 1 — `find.ts`: `q.length < 0` in place of `< MIN_QUERY_LENGTH`:
```
$ npx vitest run src/search/find.test.ts
× returns [] for a query shorter than MIN_QUERY_LENGTH, even a non-blank one
2 failed | 11 passed
```
Reverted. Mutation 2 — attributed every audio hit to `corpus.notes[0]`'s
title regardless of `recordingOwner`:
```
$ npx vitest run src/search/find.test.ts
× attributes an audio hit to the right note's title when the corpus has several notes
  (noteTitle: "Wrong Note" instead of "Right Note")
1 failed | 12 passed
```
Reverted; re-ran green (13/13).

**⚑ A near-miss, caught before it shipped rather than after.** The first
version of the debounce test only checked that a hit was absent
immediately after typing and present after the wait - which also passes
if `hits` is computed straight from `query` (undebounced), because the
surrounding block is *separately* gated on `debouncedQuery.trim() !== ''`;
while that gate is empty, nothing renders regardless of what `hits` was
computed from. Confirmed empirically:
```
$ # hits computed from `query` instead of `debouncedQuery`
$ npx vitest run src/search/SearchView.test.tsx -t "debounces Find:"
✓ 1 passed | 23 skipped (24) - the original test did not notice
```
Added a second test that completes one debounce cycle (so
`debouncedQuery` is non-empty but *stale*), then changes `query` again
without waiting - the only state where the two possible implementations
disagree - and re-ran the same mutation:
```
$ npx vitest run src/search/SearchView.test.tsx -t "own recompute"
× debounces Find's own recompute, not just the surrounding block's visibility
  (expected 'Smart searchTitle — Wave LectureWave Lecture...' to contain 'Thermo Lecture')
1 failed | 23 skipped (24)
```
Now caught. Reverted; re-ran green (24/24).

Mutation 3 — `SearchView.tsx`: `visibleHits = hits` (cap removed):
```
$ npx vitest run src/search/SearchView.test.tsx -t "caps rendered"
× caps rendered Find hits and states the true total (fix round 3, I4)
  (expected 61 to be less than or equal to 51)
```
Reverted; re-ran green.

### I5 (Important, "if room") — recordingOwner's per-note cost, and no loading state

**The fix.** `src/storage/recordings.ts` gained `recordingOwnersByNote`
(a boundary extension the coordinator authorised for this one function):
takes notes and finished recordings already loaded and returns the
recordingId -> noteId map in one pass, still the one place both link
paths are checked. `src/search/corpus.ts`'s `loadSearchCorpus` calls it
once instead of looping `recordingsForNote` per note. Also: `SearchView`
now renders a real "Loading…" state (with its `aria-label="Search"`
landmark already present) instead of returning `null` while the corpus
loads.

**Tests added:** `src/storage/recordings.test.ts`,
`describe('recordingOwnersByNote (fix round 3, I5)')` - maps a direct
link; maps a session link; leaves a standalone recording unmapped; a
direct link wins over a session link naming a different note; matches
`recordingsForNote` looped per note, for a corpus exercising both link
kinds at once (an equivalence check against the function it replaces).
`SearchView.test.tsx` - the Search landmark is present and a loading
message shown before the corpus resolves.

Mutation 1 — `recordingOwnersByNote`: swapped the direct/session-link
priority:
```
$ npx vitest run src/storage/recordings.test.ts
× a direct noteId link wins over a session link naming a different note
  (expected 'session-note' to be 'direct-note')
1 failed | 29 passed
```
Reverted. A second attempted mutation (removing the `typeof === 'string'`
guard when *building* the session map, while leaving the symmetric guard
on the *reading* side untouched) was tried and found to be **genuinely
inert** - unfalsifiable by any test, because the reading-side guard
already prevents a `null`/`undefined` key from ever being looked up,
regardless of whether it was ever inserted. Confirmed by reasoning
through every reachable code path before writing a test for it, rather
than writing one that would only look rigorous; no test was added for
this one, and that absence is deliberate, not an oversight.

Mutation 2 — `SearchView.tsx`: `corpus === null` returns `null` again:
```
$ npx vitest run src/search/SearchView.test.tsx -t "shows a loading state"
× shows a loading state, with the Search landmark already present...
  (expected null not to be null)
```
Reverted; re-ran green.

### M2 — no AbortController on unmount

**The fix.** `handleSmartSearch` creates an `AbortController`, passes its
signal to `runSmartSearch` (which already supported and was tested
against one in fix round 1), and stores it in a ref; the view's unmount
effect aborts it. A `liveRef` guards the three post-`await` `setState`
calls in `handleSmartSearch` against firing after unmount (abort does not
stop the function's own `await` from eventually settling).

**Tests added:** a custom (non-fake-helper) generator that captures the
signal it was called with and never resolves; after Smart search starts
and the first call is confirmed in flight, the view is unmounted and the
captured signal is asserted `aborted === true`.

Mutation — dropped `abortRef.current?.abort()` from the unmount cleanup:
```
$ npx vitest run src/search/SearchView.test.tsx -t "aborts an in-flight"
× aborts an in-flight smart search when the view unmounts...
  (expected false to be true)
```
Reverted; re-ran green (24/24, full file).

### M5 — not attempted; reported rather than silently skipped

The coordinator's own ranking placed this last among the "if you still
have room" items, after M2. Given the number of items already closed
this round (one Critical and five Importants, each mutation-checked) and
the structural size of this one - lifting `query`/`smart` into `AppShell`
means either making `SearchView`'s relevant props required (breaking most
of its ~24-test file's existing call sites, which render it directly
without a stateful wrapper) or adding a dual controlled/uncontrolled
fallback mode (a real increase in the component's own complexity for a
convenience fix, not a correctness one) - I judged the risk of
destabilising a large, already-thoroughly-tested surface late in an
unattended run to outweigh the benefit of this specific item, and stopped
here rather than rush it. Stated plainly per the instruction to escalate
rather than guess: **M5 is not done.** If it is still wanted, the
dual-mode-props shape is the one I'd reach for, scoped as its own
follow-up with its own dedicated test pass.

### M6 and M10

M6 (the "1 note have no summary" grammar) was folded into I1's rewrite of
that same line - the new text already has correct subject-verb agreement
throughout (`{n === 1 ? 'note has' : 'notes have'}`, `{n === 1 ? 'was' :
'were'}`), checked by grep for any remaining "note have"/"notes has" in
`src/search/*.tsx`/`*.ts` (none found). M10 is this document: the
Concerns section above has been rewritten from present-tense "not yet
done" to the actual current state, and the false K41 claim is corrected
in place with a visible note explaining what was wrong and when it was
fixed, rather than silently rewritten as though it had always been true.

### Summary of mutations not detected this round

One, found and fixed within the round: I2's `screenBatch.ts` title-length
mutation, whose first test suite didn't distinguish title-inclusion from
exclusion because every test used near-identical short titles. A second
mutation (I5, the session-map build-side guard) was investigated and
found to be genuinely inert rather than under-tested - reasoned through
rather than tested around. No mutation was left undetected in the final,
committed test suite.
