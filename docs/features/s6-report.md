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

Nothing from the brief was left unimplemented. One thing was implemented
in a deliberately bounded way rather than the fuller form the brief's
wording could suggest — see Concerns below (S6-A6).

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

- **S6-A6 ⚑ "Links to note + page / recording + timestamp" (K41) is
  cross-tab navigation, not a deep link.** `NotesView`, `NoteList`,
  `NoteToolbar` and `RecordingsView` are off-limits (owned by other units)
  and expose no prop through which an external caller can select a
  specific note, page or recording — confirmed by reading their actual
  prop types and by checking there is no `createContext`/module-level
  store standing in for one anywhere in the app outside `CaptureContext`/
  `TabletProvider`, neither of which carries a selection. A Find or smart-
  search hit's "Open" button switches `AppShell`'s tab to Notes or
  Recordings and relies on the hit's own text (note title, page number and
  typed/ink marker, or recording title and formatted timestamp) for the
  owner to find the right row themselves afterward. This is not a crash
  and not a silent no-op, but it is one extra manual step short of the
  single-click deep link K41's wording could be read to promise. Closing
  it for real needs a new prop on `NotesView`/`RecordingsView` that is
  outside this unit's ownership to add. Recorded as a decision for
  whichever unit or phase next owns those files, not made silently — full
  reasoning in `docs/features/s6-spec.md`'s S6-A6.
- **S6-A4: a per-candidate band-stage failure is swallowed, not surfaced.**
  If Ollama becomes unreachable *between* the screen call and the band
  calls, every band call fails, each is individually caught and logged,
  and the run completes with zero hits rather than a visible error — a
  false negative rather than a crash. This is deliberate (one malformed
  reply must not cost every other already-screened candidate's result)
  and is named in both the spec and the plan, but it means K44's "fails
  with a plain message" guarantee is airtight only for the *first* Ollama
  call of a run, not for every call. Flagging this explicitly rather than
  letting it pass as fully covered.
- `recordingOwner` in `src/search/corpus.ts` is built by calling
  `recordingsForNote(note.id)` once per note (per the brief's instruction
  to reuse that helper rather than re-derive its two link paths), which
  costs one `listFinishedRecordings()` scan per note. Accepted at today's
  note counts (same reasoning `listTagVocabulary` already relies on for
  A35), but it is the one place in this unit whose cost scales with the
  library rather than with search activity — worth knowing about if a
  future owner profiles the Search tab's mount time against a much larger
  archive.
- No new setting, store, index or dependency was added; `DB_VERSION` is
  untouched.

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
