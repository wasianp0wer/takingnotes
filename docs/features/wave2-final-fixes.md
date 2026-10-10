# Wave 2 final fixes — whole-branch review, fix round 2

Applied directly on `phase3` (the integration branch, not a worktree). This
is one fix wave; there is no second round after this one.

Baseline going in: 1350 tests / 108 files, `tsc -b` clean, lint 0 errors,
build passing. Final: **1367 tests / 108 files**, all four gates still
passing after every commit.

## Fix 1 (Important) — a note ending on a typed page was never auto-named until the next app start

**Root cause.** The naming queue (`src/notes/naming/queue.ts`) had exactly
two triggers: `engine.subscribePageFinalized` and
`transcriptionQueue.subscribe`. A note whose active page is typed reaches
neither on `endNote`/`closeNote`: `finalizeTypedPage` deliberately never
emits `pageFinalized` for the page it closes (doing so would let the
transcription queue's `markPending` overwrite the typed page's already-
`'done'` transcript — the bug a previous fix round closed), and typed pages
never touch the transcription queue at all. So **ending a note on a typed
page emitted no event whatsoever.** The note still became `complete` and
genuinely eligible for naming (`noteReadyForNaming` treats a typed page as
finished), but nothing ever asked — until the next app start's self-healing
`summary === null` rescan.

**Fix.** Added `subscribeNoteEnded(fn: (noteId: string) => void): () => void`
to `CaptureEngine` (`src/capture/types.ts`). `closeNote()`
(`src/capture/engine.ts`) now fires it with the note id right after the note
is marked `complete` and the session `ended` — fired unconditionally there,
the same "best effort" standard the existing `emitPageFinalized` call next
to it already keeps. The naming queue subscribes to this as a third trigger
alongside its existing two.

Three test doubles fully implement `CaptureEngine` (not `Pick<...>`) and
each needed the new method added: `src/capture/pageTurnTestEngine.ts`
(no-op stub), `src/audio/RecorderControl.test.tsx`'s `createFakeCaptureEngine`
(throwing stub), `src/transcription/startTranscription.test.ts`'s inline
double (throwing stub) — matching how each already handled
`subscribePageFinalized`. `src/notes/naming/startNaming.ts`'s
`ensureNamingQueue` and its test's `fakeEngine()` were widened the same way.

Did **not** make `finalizeTypedPage` emit `pageFinalized` — the existing
comment there gives the correct reason not to.

**Tests.**
- `src/capture/engine.test.ts`: a new `describe('subscribeNoteEnded …')`
  block — fires after a plain `endNote`; fires for a note ending on a typed
  active page with `pageFinalized` staying empty (the exact scenario); fires
  for a typed-only note; does not fire on an idle no-op `endNote`.
- `src/notes/naming/queue.test.ts`: a new test names a note via
  `subscribeNoteEnded` for a typed-only note. **Deliberately creates the
  note *after* calling `queue.start()`**, not before — the obvious way to
  write it (note created, then `start()`, then fire the event) would also
  pass with the subscription deleted outright, because `start()`'s own
  startup rescan (`summary === null`) would enqueue the same note
  independently. Caught this exact vacuous shape via mutation-check before
  fixing the test ordering. Also updated the existing "blank typed page"
  test (Fix 4 item) to fire the real `subscribeNoteEnded` trigger instead of
  a synthetic `pageFinalized` for a typed page the engine never emits.

**Mutation-check:** both the engine-level and queue-level tests went red
when the `subscribeNoteEnded`/emission wiring was commented out, then green
again on revert. One mutation attempt (first draft of the queue-level test)
was *not* detected on the first try — documented above and fixed before
commit, not swept under.

## Fix 2 (Important) — naming and page transcription could issue concurrent Ollama calls

**Root cause.** `src/transcription/queue.ts` runs jobs one at a time by
design (a vision model on a laptop is the bottleneck). The naming queue is a
second, independent serial queue reading the same `ollama.model` setting,
with no shared token — two concurrent 180 s calls had become the normal
case, worst on this branch's first launch where naming's startup scan
enqueues the owner's whole back catalogue right as transcription resumes
whatever page backlog survived a reload.

**Fix.** `createNamingQueue`'s `drain()` now awaits
`transcriptionQueue.idle()` (already exposed) before shifting each job off
its queue, re-checking `stopped` and `queued.length` after the await. Page
transcription — what the owner is actively watching — keeps priority;
naming only runs in the gaps. `NamingQueueDeps.transcriptionQueue` widened
to `Pick<TranscriptionQueue, 'subscribe' | 'idle'>`.

**Anti-deadlock/anti-starvation reasoning** (also in the code comment on
`drain()`): `idle()` only resolves from the transcription queue's own
internal `running`/`queued` state, which `drain()` never blocks or holds a
lock on — this loop takes no lock transcription could be waiting on, and
transcription's own drain loop runs entirely independently of this one, so
there is no cycle. It cannot starve naming forever either: `idle()` resolves
the instant transcription has nothing queued or running, including "never
started anything at all" — there is no reachable state where transcription
holds the gate shut while genuinely idle.

One residual, named honestly rather than hidden: this is unidirectional
gating, not a true mutex. If a page gets enqueued to transcription in the
small window between `idle()` resolving and naming's own `generateJson`
call actually starting, both calls can briefly overlap. The task's own
framing endorsed this "simplest honest form" over a full priority mutex; I
did not build the latter, given the added complexity for a race window that
is a few microtasks wide at most.

**Tests** (`describe('gating on the transcription queue …')` in
`queue.test.ts`): a naming job does not start while transcription is busy,
and drains once it goes idle; two notes queued while busy are both
eventually named once transcription goes idle once (not starved).

**Mutation-check:** removed the `idle()` await and the following
`stopped`/`queued.length` guards — both new tests went red (jobs ran
immediately despite "busy"), then green again on revert.

## Fix 3 — three data-access questions for S6 (search), settled ahead of time

**(a) `recordingsForNote`.** Lifted `gaps/analyzer.ts`'s module-private
`candidateRecordings` into `src/storage/recordings.ts` as an exported
`recordingsForNote(noteId): Promise<RecordingRecord[]>` — the one place that
knows both ways a recording links to a note (direct `noteId`, or via the
note's session, K12/A32), finished-only, de-duplicated by id. Semantics
unchanged exactly. `candidateRecordings` now forwards to it one line.
Added a doc comment (matching `listFinishedRecordings`'s own precedent)
telling future callers not to re-derive the two link paths, and a one-line
comment on `createRecording`'s `startedAt` noting why it's always a number
(the `by-started` index silently skips an invalid key, and `recordingsForNote`
depends on that completeness).

Left `listRecordingsBySession` in place even though it has zero production
callers now — the task named this as a fact worth noting, not an instruction
to delete it, and it still has direct test coverage.

**(b) `listAllPageText`.** Added to `src/storage/pages.ts`: a lightweight
per-page projection (`{ id, noteId, pageIndex, text, transcript }`, no
`strokes`/`render`/`gapAnalysis`) over every page in the database, for a
corpus-wide plain-text scan instead of one `listPages()` call per note plus
every page's ink loaded into memory. `listPages()` itself is unchanged.
Honest doc-comment caveat: IndexedDB has no server-side column projection,
so the heavy fields are still loaded transiently per row either way — what
this buys is one bulk scan instead of N indexed queries, and a result list
that doesn't pin every page's strokes in memory for a search's whole run.

**(c) K46.** Recorded in `docs/spec-phase3.md`: smart search falls back to a
summary-less note's title plus its page text (not just failed-transcription
notes, K44 — also legacy notes and, pre-Fix-1, a note that ended on a typed
page), and the result still states how many notes could not be screened by
summary. `docs/architecture.md` §8.5 points S6 at both helpers above and at
K46.

**Tests:** `recordingsForNote` got a direct `describe` block in
`storage/recordings.test.ts` (direct link, session-only link, both-at-once
de-dup, excludes unfinished, empty case). `listAllPageText` got a direct
`describe` block in `storage/pages.test.ts` (projects across multiple notes,
drops `strokes`, empty-database case).

**Mutation-check:** breaking the session-link branch of `recordingsForNote`
turned both the new direct test *and* the pre-existing
`gaps/analyzer.test.ts` session-link test red (the latter already exercised
this path through `candidateRecordings`/`noteHasRecording` — good
confirmation the forward is faithful). Returning `[]` unconditionally from
`listAllPageText` turned its new test red. Both reverted after confirming.

## Fix 4 — the cheap ones

- **`audioRuntime.ts` recovery duration.** A recovered recording's
  `endedAt`/`durationMs` are now estimated from `chunkCount *
  DEFAULT_TIMESLICE_MS` (the latter newly exported from `recorder.ts`,
  replacing a literal `1000`), anchored at `recording.startedAt` — not from
  `now()` at recovery time. Removed the now-unused `now` injection point
  from `RecoveryDeps` and updated every `audioRuntime.test.ts` call site
  and expectation accordingly (a deliberate test change, called out here per
  the task's own instruction). Mutation-checked by reverting to the old
  `now()`-based formula — 3 tests went red.
- **Renamed `gaps/recordingForNote.test.ts` → `gaps/sessionLinkedRecordings.test.ts`**,
  after what it actually tests now (`recordingForNote` no longer exists on
  this branch); updated its header comment's one stale reference to
  `candidateRecordings` to point at `recordingsForNote`.
- **`PAGE_TRANSCRIBING_MESSAGE`.** Exported the "page is still transcribing"
  string as a constant from `TranscriptPanel.tsx` (reworded slightly) and
  pointed `NotesView.test.tsx`'s existing absence-only assertion at it
  instead of a hardcoded literal copy. Also added the missing **positive**
  case — the message actually shows for an active, unfinalized live page —
  since nothing in the suite checked that before; mutation-checking proved
  it was needed: short-circuiting the message's render branch left the old
  absence-only test green while the new positive test went red.
- **"Type page" resume-lock gating.** `NotesView.tsx`'s "Type page" button
  is now also disabled while `resumeLockState.pending` (architecture.md
  §8.3's window), matching "New note"'s own gating. Added a test mirroring
  the existing "disables New note while a resume elsewhere is pending" case,
  with an active note already open so the assertion isn't trivially true for
  the unrelated `activeNoteId === null` reason. Mutation-checked by dropping
  the new disjunct — test went red, confirmed, reverted.

## Constraints honored

- No new runtime/dev dependencies, no `DB_VERSION` bump, no new store or
  index.
- Nothing in `src/capture/` imports from `src/audio/` (unchanged by this
  work — `recorder.ts`'s new export is consumed by `src/audio/audioRuntime.ts`,
  not by capture).
- All four gates (`npm test`, `npx tsc -b`, `npm run lint`, `npm run build`)
  passed before every commit in this wave.

## Commits (oldest to newest)

1. `197efbb` — Fix 1: `subscribeNoteEnded`.
2. `56000cb` — Fix 2: gate naming's drain on transcription's idleness.
3. `daddb33` — Fix 3: `recordingsForNote`, `listAllPageText`, K46, architecture §8.5.
4. `2428253` — Fix 4: recovery duration estimate, test rename, shared
   message constant + positive test, "Type page" resume-lock gating.

## Concerns for the follow-up reviewer

- Fix 2's gate is unidirectional (naming waits on transcription; the
  reverse is not enforced). Documented above and in-code; flagged rather
  than silently assumed complete.
- K8/A31-style "known limitation" framing wasn't needed anywhere else in
  this wave — no new technical risk of that shape was introduced.
