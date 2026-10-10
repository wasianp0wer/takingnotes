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
