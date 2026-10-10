# S1 — Sessions: resume, lock, auto-naming

Written from `docs/spec-phase3.md`, `docs/architecture.md` §8 (the Wave 1
foundations contract) and the code as it stands on `phase3` after Wave 1.
Covers K9, K13–K21, K45 (owned decisions) and A32–A34, A36, A41 (owned
assumptions).

## Goal

Two of the owner's complaints are one feature: an interrupted session cannot
be picked back up, and there is no way to return to a finished note and keep
writing in it. Wave 1 built `engine.resumeNote(noteId)` for both; this unit
is the UI that reaches it, the lock that keeps a running session's writing
going somewhere predictable, and the auto-naming that makes a note findable
once it is done — notes today carry `Note <timestamp>` titles.

S1 also owns K45: gap analysis used to compare a page against the *first*
recording linked to its note (A21), which was unambiguous when a session held
exactly one recording. Resume makes a session hold several (K12), so S1 fixes
the comparison to use the recording that actually overlaps the page.

## What already exists (read from the code, not assumed)

- `engine.resumeNote(noteId)` (`src/capture/engine.ts`) is fully implemented
  per its contract in `architecture.md` §8.3: reopens rather than forks, keeps
  the note's original `startedAt`, resets `sessionStartedAt` to `now()`
  (K13 — already done, nothing for S1 to add), finalizes any page left open
  at `pageEndedAt`, and recreates/reactivates the session. **Nothing in the UI
  calls it yet** — that is this unit's job.
- `SessionControls.tsx` already disables "New note" during a session
  (`NoteToolbar`'s `sessionLocked` prop, wired from `NotesView.tsx` via
  `sessionStartedAtOf(state) !== null`) and already hides "Start session"
  whenever a session is active (it renders "End session" instead — there is
  structurally no Start button to click). K15's "New note"/"Start session"
  half is therefore already satisfied by Wave 1's code; what is missing is
  disabling **Resume on other notes**, and keeping both Start session and
  Resume disabled during the specific hazard window `architecture.md` §8.3
  documents: before a resume's own op has published state, a second
  `resumeNote` or a `startSession` falls through to `closeNote()` against the
  half-opened resume and leaves a stray empty page. This is a UI gating
  problem, not an engine one (the engine's correctness does not depend on it).
- `SessionControls.tsx`'s interrupted-note banner (`interruptedNoteOf`) says
  `"{title}" was interrupted; its audio recording was lost.` when the
  note's session has a recording, using a `hadAudio` lookup
  (`listRecordingsBySession`). K9: since Wave 1's audio persistence (K4–K7),
  this is false — an interruption now loses at most one second of audio, not
  the whole recording. The sentence and the lookup that feeds it are deleted.
- `NoteList` / `NoteToolbar` (`src/notes/NoteList.tsx`,
  `src/notes/NoteToolbar.tsx`) already expose the six Wave 2 mount points;
  S1's are `NoteList.rowActions`, `NoteToolbar.title`, `NoteToolbar.banner`.
  No edits to those two files are needed — only to `NotesView.tsx`, which
  wires props into them.
- `renameNote`, `setNoteSummary`, `titleSourceOf`, `tagsOf` already exist in
  `src/storage/notes.ts` with exactly the contract `architecture.md` §8.2
  describes. S1 writes through these only; it adds no new storage function
  and no new field (schema v4 is frozen, and `src/storage/*` is off limits).
- `src/transcription/queue.ts` is the model for a serial, resumable queue:
  subscribe-then-scan ordering, a dedupe-on-enqueue list, one job at a time,
  status changes announced through an emitter. S1's naming queue follows the
  same shape, with one necessary difference: the transcription queue persists
  a `pending` mark on the page it is about to work so a reload resumes it.
  `NoteRecord` has no spare field for that (see Assumptions below), so S1's
  queue is resumable by re-deriving eligibility from `note.summary === null`
  on startup rather than from a persisted in-progress marker.
- `src/gaps/analyzer.ts`'s `recordingForNote(noteId)` picks the *earliest*
  recording linked to a note (directly or via its session), full stop — no
  page or window is considered. It is also the one place in the gap-analysis
  path still reading `listRecordings()`/`listRecordingsBySession()` instead
  of `listFinishedRecordings()`, which `architecture.md` §8.2 flags as a bug
  this wave must close ("gap-analysis recording selection... must call
  `listFinishedRecordings()`"). `src/notes/GapPanel.tsx` is the only other
  caller of `recordingForNote`, used to decide what the panel's "Comparing
  against the recording from X to Y" line should name.

## Decisions implemented

**K9.** The interrupted banner in `SessionControls.tsx` drops "its audio
recording was lost" and the `hadAudio` lookup entirely. It now always reads
`"{title}" was interrupted.` A Resume button is added beside it (K14).

**K13.** Already correct (see above) — verified by a test that resumes a note
hours after it was created and asserts the elapsed clock starts at `0:00`,
not at the note's age.

**K14.** A `ResumeButton` component (`src/notes/ResumeButton.tsx`) is the one
place Resume is offered: in `NoteList.rowActions` for every note that is
neither legacy nor the active note, and in the interrupted banner for its one
note. Both call the same `engine.resumeNote(note.id)`.

**K15.** "New note" and "Start session" are already disabled while a session
is open (see above). S1 adds the missing half: Resume on every *other* note
is disabled while a session is open, and — closing the hazard window
`architecture.md` §8.3 calls out — Resume and Start session are both disabled
for as long as any `resumeNote` call anywhere is in flight, not only the
button that was clicked. This needs a signal shared between `NotesView`
(where the sidebar's Resume buttons live) and `SessionControls` (mounted
separately in `AppShell`'s header, not a descendant of `NotesView`), so S1
adds a small module-level store, `src/notes/resumeLock.ts`, in the same
"shared singleton" style `src/transcription/startTranscription.ts` already
uses for the transcription queue.

**K16.** `NotesView.tsx` passes a banner into `NoteToolbar.banner` reading
`Writing still goes to "{title}"` whenever the viewed note is not the active
note and a session is locked. It never hard-locks the sidebar — browsing
stays possible, per the owner's choice.

**K17–K19, K21.** `src/notes/naming/` is a new serial queue
(`createNamingQueue`, modelled on `transcription/queue.ts`) that fires when a
note both (a) is no longer `active` and (b) has every page finished —
`page.transcript !== null`, or `page.source === 'typed'` for a deliberately
blank typed page (K33's `transcript: null` there means "nothing to say", not
"still working") — and (c) has no page whose transcript ended `failed`
(K19: a failed page's note is never named, by never enqueueing it at all, so
no summary is generated either — see Assumptions). The trigger is two
existing public events: `engine.subscribePageFinalized` (fires once a note's
last page is finalized, and — read from `engine.ts` — note status is already
updated to `'complete'`/`'interrupted'` in storage *before* this fires, for
both `closeNote()` and startup `recover()`) and the transcription queue's own
`subscribe` (fires on every later status change, covering the case where the
note ends before its last page finishes transcribing). `ollama.model` and
`ollama.baseUrl` are read fresh per job (K21, reusing A30). The prompt lives
in `src/notes/naming/prompts.ts`, versioned (`naming-v1`), following
`transcription/prompts.ts`/`gaps/prompts.ts`. Output is written through
`setNoteSummary`, which already implements the "title only when not manual"
rule (K18) and the "blank generated title is a failed generation" rule.

**K20.** `src/notes/NoteTitle.tsx` is an inline `<input>`-on-click title
editor mounted in `NoteToolbar.title`. Committing an edit calls `renameNote`,
which sets `titleSource: 'manual'` — already implemented in
`src/storage/notes.ts`, so NoteTitle only has to call it and handle a blank
or failed edit by reverting to the last-known title.

**K45.** `src/gaps/window.ts` gains `overlapMs(window, recording)`, a pure
function returning the overlap in ms between a page's speech window and a
finished recording's `[startedAt, endedAt]` span (0 when disjoint).
`src/gaps/analyzer.ts`'s `recordingForNote` is replaced by
`recordingForPage(noteId, window)`: among every recording linked to the note
(directly or via session, same candidate gathering as before, but now
sourced from `listFinishedRecordings()` instead of `listRecordings()` —
closing the bug `architecture.md` §8.2 flags), it picks the one with the
greatest `overlapMs`, `null` when the window overlaps none of them (A41) or
candidates is empty. Ties favour the earlier-started recording (deterministic,
and the only way two finished recordings can tie here is identical spans — not
a case product use produces). `runPage` and `analyzeNote` are reordered so the
page's window is computed before its recording is resolved, since the
selection now depends on it; `analyzeNote` resolves and caches each page's own
recording once, reused by its own `runPage` call, so a note-wide run still
costs one recording scan rather than one per page times two.
`src/notes/GapPanel.tsx` is updated at its one call site (`recordingForNote` →
`recordingForPage`, computing the page's window first) since it is the only
other consumer of the function being replaced.

## Behavioural rules

- Resume is never offered for the active note, nor for a legacy note — the
  button renders nothing for either (K14's "any non-legacy note that is not
  the active note").
- Resume is disabled, independent of the shared in-flight lock, whenever a
  session is open and the target note is not the active note (K15).
- Clicking Resume disables every Resume button and the Start session button
  until that call's promise settles, successfully or not (the §8.3 hazard
  window). A second click on the *same* button while pending is a no-op by
  construction, since the button is disabled; this mirrors
  `PageTurnControls`'s `inFlight` ref, but the lock here is shared across
  components rather than local to one.
- A resume that throws clears the lock and surfaces the error the same way
  `SessionPanel` already surfaces a `startSession` failure — logged, and
  shown inline beside the control that was clicked.
- The "writing still goes to" banner reads the *active* note's title, not the
  viewed note's, and only appears when they differ and a session is open.
- Auto-naming never touches a manually renamed title (`titleSourceOf !==
  'manual'` gate, already enforced by `setNoteSummary`) but always refreshes
  the summary, including on a note's second (or later) ending after a resume
  — K20's "the summary keeps updating regardless."
- Auto-naming's text input is each page's markdown (ink/ROM) or text (typed),
  joined in `pageIndex` order. A note whose joined text is entirely blank is
  not sent to the model at all — nothing eligible to summarize is not the
  same question as "transcription failed," but sending blank input to Gemma
  would be exactly as likely to manufacture a confident, wrong title as the
  failed-transcription case K19 already guards against.
- K45's recording selection only matters when a page is eligible at all:
  `gapEligibility` already short-circuits on `no-strokes`/`no-timestamps`
  before ever looking at the recording, so a page with no usable window never
  reaches `recordingForPage`.

## Assumptions (S1-A1–S1-A5)

- **S1-A1** A note with any `failed` page transcript is never enqueued for
  naming at all — not just denied a title. The owner's reasoning for K19
  ("a confidently wrong title on exactly the notes whose content is least
  certain") applies equally to the summary, and partially-grounded content
  with no way to flag which part is suspect is a worse failure mode than a
  note that keeps its timestamp title until a human retries the failed page's
  transcription. Nothing re-triggers automatically once a note takes this
  path; the owner can retry the failed page's transcription by hand (already
  wired, `TranscriptPanel`'s Retry), which fires a fresh transcription
  `done`/`failed` event the naming queue listens for.
- **S1-A2** The naming queue cannot persist an in-progress marker on the
  `NoteRecord` (schema v4 is frozen and `src/storage/*` is off limits for
  this unit), so it is "resumable" in a weaker sense than the transcription
  queue: on startup it re-scans every note whose `summary` is still `null`
  and re-evaluates eligibility, rather than resuming a persisted `pending`
  row. A note that already has a summary is not reconsidered on startup
  (avoiding a full-library re-summarize on every launch); it is still
  reconsidered live, on every later page-transcript or page-finalized event,
  which is what makes K20's "summary keeps updating" true for a resumed note
  that ends a second time.
- **S1-A3** Resume's shared in-flight lock lives in a new module-level
  singleton (`src/notes/resumeLock.ts`), the same pattern
  `startTranscription.ts` already uses for the transcription queue, rather
  than a new React context. `SessionControls` and `NotesView` are mounted as
  siblings under `AppShell`, not one inside the other, so a plain prop or a
  context provider would need a change to `AppShell.tsx`/`main.tsx` — both
  outside this unit's ownership and unnecessary for a value this small.
- **S1-A4** K45 ties (two candidate recordings with numerically equal
  overlap) are broken by earliest `startedAt`, then by id. The spec does not
  name a tiebreak; this one is deterministic and never reachable except by
  two recordings with identical, fully-overlapping spans, which the app has
  no way to produce today.
- **S1-A5** `recordingForPage`'s candidate gathering (linked directly via
  `recording.noteId`, or via the note's `sessionId`) is otherwise unchanged
  from the old `recordingForNote`, except for reading `listFinishedRecordings()`
  instead of `listRecordings()` — closing the bug `architecture.md` §8.2
  already named for this exact call site.
