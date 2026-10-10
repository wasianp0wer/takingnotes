# Phase 3 — product decisions

Written 2026-10-09 from an interview with the owner after a week of real use.
Companion to `docs/spec.md` (Phase 1) and `docs/spec-phase2.md` (Phase 2), and
read alongside `docs/architecture.md` and `docs/assumptions.md`.

Spec location note: the brainstorming skill's default is
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. This project already
keeps product decisions in `docs/spec*.md` and per-feature specs in
`docs/features/*-spec.md`, and a future session will look there, so the project
convention wins.

Decisions are numbered **K1–K46** (Phase 2 used J). New assumptions continue
the shared list at **A31**.

## Why Phase 3 exists

A week of daily use surfaced four kinds of friction, and every item below is one
of them:

1. **Sessions are fragile.** An interruption destroys the recording outright and
   the sitting cannot be picked back up.
2. **Notes are unfindable.** They carry timestamp titles, have no tags, and
   there is no search of any kind.
3. **Triage is rigid.** The lookahead is hard-coded to a week and urgency is a
   bare number with nothing to read at a glance.
4. **Two device affordances are broken or missing.** The pad's physical page
   button does nothing, and the battery level is parsed but never shown.

Success: a lecture that can be run end to end, recovered from mid-way without
losing audio, and found again three weeks later.

## Scope

Six feature units, named here and used throughout:

| Unit | Covers | Wave |
|---|---|---|
| **W1 foundations** | schema v4, `resumeNote()`, the notes-sidebar scaffold | 1 |
| **S1 sessions** | resume, session lock, auto-naming and summaries | 2 |
| **S2 triage** | score colours, configurable agenda horizon | 2 |
| **S3 device** | battery level, page-button fix, incremental audio persistence | 2 |
| **S4 typed pages** | typing a page when the pad is unavailable | 2 |
| **S5 tags** | tagging notes, filtering the list by tag | 2 |
| **S6 search** | plain find, and smart search via Gemma | 3 |

Out of scope, deliberately: the open issues inherited from Phase 2 that nobody
asked about (the swallowed device-reconnect error in `architecture.md` §7, the
15-minute audio stall timeout, two-column PDF date assembly). They stay
recorded, unfixed.

---

## 1. Schema v4

**K1** The upgrade from `DB_VERSION = 3` to `4` is additive only — new stores,
new indexes, new optional fields. No row is rewritten. Every new field is
optional with a documented absent-reading, following the precedent set by
`sessionId` (v2) and `gapAnalysis` (v3) in `src/storage/types.ts`.

| Record | Change | Absent reads as |
|---|---|---|
| `NoteRecord` | `tags?: string[]` | `[]` |
| `NoteRecord` | `titleSource?: 'default' \| 'auto' \| 'manual'` | `'default'` |
| `NoteRecord` | `summaryPromptVersion?: string \| null` | `null` |
| `PageRecord` | `source` gains `'typed'`; `text?: string` | n/a; `undefined` for ink pages |
| `RecordingRecord` | no shape change — see K8 | — |
| new store `recordingChunks` | `{ id, recordingId, seq, data: ArrayBuffer, type }`, index `by-recording` | — |

**K2** `titleSource` exists because "auto-naming must never overwrite an edit"
needs to tell a manual rename apart from the `Note <timestamp>` placeholder that
`openNote()` writes. Reading absent as `'default'` makes every pre-Phase-3 note
eligible for auto-naming, which is also exactly the summary backfill S6 needs.

**K3** Tags are normalised on write: trimmed, lowercased, deduplicated, empty
strings dropped. The displayed form is the normalised form — there is no
separate display name to keep in sync. The tag vocabulary for autocomplete is
derived by scanning notes, not stored; the note count here is in the hundreds,
not millions.

---

## 2. S3 — audio that survives an interruption

Today `src/audio/recorder.ts` buffers chunks in memory and writes once, in
`save()`. A reload or crash takes the whole recording (A11, Phase 2 open issue
5). This is the bug the owner reported.

**K4** `MediaRecorder` chunks are persisted as they arrive (the existing
`timesliceMs`, default 1000) to `recordingChunks`, so an interruption loses at
most one second of audio.

**K5** The `RecordingRecord` is created at **start**, with `endedAt: null`,
`durationMs: 0` and `byteLength: 0` — not at stop. This inversion is what makes
recovery possible without a second bookkeeping store: the link, title and
`startedAt` are on disk before any chunk is, and an unfinished recording is
identifiable by `endedAt === null` alone.

**K6** `stop()` stitches the chunks in `seq` order, writes `recordingAudio`,
deletes the chunks, then patches `endedAt`, `durationMs`, `byteLength` and
`mimeType`. Order matters: the chunks are only deleted once the stitched blob is
durably written.

**K7** Startup recovery (the same pass that `engine.recover()` performs for
notes, but owned by the audio runtime, not the capture engine — the engine must
not depend on the recorder, `architecture.md` §6.5) finds every recording with
`endedAt === null`, stitches it, and queues its transcription. A recording with
no chunks at all is deleted rather than left as an empty row.

**K8** ⚑ A stream truncated mid-flight has no finalised WebM container. This is
the one genuine technical risk in Phase 3 and it is **not to be assumed away**:
S3 must include a test that a stitched, truncated recording both plays and
survives the Whisper decode path used by `whisperWorkerCore`. If it does not,
the chunk bytes remain on disk and recoverable, and the fallback is a remux step
— but that is to be discovered by a failing test, not in use.

**K9** The interrupted-session banner in `SessionControls.tsx` loses its
"its audio recording was lost" wording, along with the `hadAudio` lookup that
fed it. The sentence was honest about Phase 2's behaviour; after K4 it is false.

---

## 3. W1 + S1 — sessions

### Resume

**K10** One mechanism, `engine.resumeNote(noteId)`, serves both "restart an
interrupted session" and "return to an old note". The owner chose a single
Resume available on any note; interruption only makes it more prominent.

**K11** Resume reopens rather than forks. The target `NoteRecord` goes back to
`status: 'active'` with `endedAt: null`; its `SessionRecord` goes back to
`status: 'active'` with `endedAt: null`; a new page is opened at
`pageIndex = <highest existing> + 1`. No existing page is modified and no page
is ever re-finalised. The note keeps its original `startedAt`.

**K12** A session may hold **several recordings**. `RecordingRecord.sessionId`
and `listRecordingsBySession` already allow this; what changes is that it now
actually happens. Gap filling is unaffected because every `GapSuggestionRecord`
already carries its own `recordingId`. This supersedes the part of A21 that
assumed one recording per session.

**K13** The header's elapsed clock measures the **current sitting**, not the
note's lifetime: `sessionStartedAt` is set to `now()` on resume. A note resumed
three days later must not show a 72-hour timer.

**K14** Resume is offered on any non-legacy note that is not the active note.
It is a button on the note in the sidebar and in the interrupted banner. While a
session is open the UI disables it (K15), but `resumeNote()` itself still ends
any open note first, through the existing `closeNote()` path — the engine is
callable from tests and from a future caller, and it must not depend on a button
being disabled for its correctness.

### Lock

**K15** While a session is open (`sessionStartedAt !== null`): "New note" and
"Start session" are disabled, and so is Resume on other notes. "End session" and
"End note" stay enabled — ending is the escape hatch and must never be
reachable only by reload.

**K16** The sidebar stays clickable and other notes stay readable. Viewing
anything other than the active note shows a persistent banner reading
*"Writing still goes to «title»"*. Chosen over a hard lock so a lecture can be
checked against last week's notes without ending the session; the banner is what
keeps "where is my writing going" unambiguous.

### Auto-naming

**K17** A note is named and summarised when it ends **and** its pages have
finished transcribing, whichever is later. The work runs on a serial, resumable
queue modelled on `src/transcription/queue.ts` — same reasoning as there: one
Ollama call at a time, survives a reload, retryable.

**K18** Gemma receives the note's page transcripts (and typed page text, K33)
and returns a short title plus a one-to-two-sentence summary. `summary`,
`summaryModel` and `summaryPromptVersion` are always written. `title` is written
only when `titleSource !== 'manual'`, and writing it sets `titleSource: 'auto'`.
The prompt lives in a versioned registry alongside the existing ones.

**K19** A note whose transcription failed is never named: it keeps its timestamp
title. Naming from partial text would produce a confidently wrong title on
exactly the notes whose content is least certain. The owner accepted this.

**K20** The note title is inline-editable in the notes header. An edit sets
`titleSource: 'manual'`, which permanently opts that note out of auto-titling.
The summary keeps updating regardless.

**K21** Auto-naming reuses `ollama.model`, extending A30 to a third consumer.
No separate model picker.

---

## 4. S2 — triage

**K22** The priority score is colour-banded on the printed number, by absolute
score: **≥140 red · 100–139 orange · 60–99 amber · 30–59 lime · <30 green**.
Scores run 0–200 (`priority.ts`: urgency to 2.0, weight 1.0 required / 0.5
optional), so an optional task cannot pass orange however overdue it is. The
owner chose absolute bands over urgency-only bands knowingly: the colour answers
"how much does this matter right now", which is the weighted question.

Colour is applied to the score text only, and since the score *is* the content,
nothing is conveyed by colour alone.

**K23** The agenda horizon becomes a new setting, `triage.agendaDays`, default
`7`: presets 3 / 7 / 14 / 30 / All, plus a `Custom…` numeric field. Persisted
through `settingKeys.ts` like every other setting.

**K24** ⚑ It must **not** reuse the existing `triage.lookaheadDays`. That key
controls how far ahead a calendar deadline becomes a task (`generateTasks.ts`);
rebinding it would silently change task generation as a side effect of changing
a view's range. Two different questions, two different keys.

**K25** The horizon affects `CalendarPanel`'s agenda only — the hard-coded
"Today plus the next 7 days" at `CalendarPanel.tsx:20` and the "Nothing in the
next 7 days" empty state at `:196`. The task list is not filtered by horizon
today and does not become so.

---

## 5. S3 — device

### Battery

**K26** `DeviceState` gains `batteryPercent: number | null`, shown beside the
existing connection status in `DeviceStatus`, and hidden entirely when `null`.
`huionBLE.ts` already parses `CMD.BATTERY` (0x8E, byte 3) into `config.battery`
at `huionBLE.ts:1032` — this is an `onBattery` callback and state plumbing, not
protocol work.

**K27** Battery is requested on connect (already done) and refreshed every five
minutes while connected. It is `null` before the first reply and while
disconnected; a stale number is never shown as current.

### The pad's physical page button

**K28** A `0x8A` notification becomes a page turn directly. `controller.ts:227`
currently demotes it to `detector.hint()`, and a turn is emitted only when the
polled ROM page count *rises* — which it does not do during a live streaming
session, so the press is swallowed even though the notification arrived. The
owner's probe confirmed the notification itself is reliable enough to act on.

**K29** ⚑ The 5-second page-count poll **keeps running**, for two reasons that
have nothing to do with page turns:

- It is the liveness heartbeat. `controller.ts:228` feeds every inbound frame to
  the watchdog, and the poll's own `0x85` reply is what keeps it quiet during
  stretches with no pen input (poll 5s against `idleMs` 15s). Remove the poll
  and the watchdog declares a healthy pad dead whenever writing pauses.
- It is the source of `storedPageCount`, which `engine.devicePageNum()` stamps
  onto each new page record.

What changes is only what the poll *triggers*: a rising count no longer emits a
page turn.

**K30** The ~20% `0x8A` miss rate measured in Phase 2 is accepted rather than
compensated for. The owner's reasoning, accepted 2026-10-09: nothing in this app
reads the pad's stored page data, so a missed turn costs one app page boundary,
the toolbar's persistent "Page N of M" makes the miss visible, and pressing the
button again recovers it. This supersedes the design note in
`pageTurnDetector.ts` that made the poll load-bearing.

**K31** A ~300 ms dedupe window guards against one press emitting a doubled
frame. It must not be long enough to swallow a deliberate double press.

---

## 6. S4 — typed pages

**K32** `PageRecord.source` gains `'typed'` and the page carries its text in
`text`. A note mixes handwritten and typed pages freely, in any order, including
a resumed note.

**K33** A typed page writes its own `TranscriptRecord` from its text, with
`model: 'typed'`, a `promptVersion` of `'typed/1'` and `status: 'done'`. This is
what makes transcription skip it while gap filling, search and page navigation
all work on it unchanged — no second text field for every consumer to learn
about.

**K34** ⚑ Pen input while a typed page is active opens a **new live page**
rather than writing ink into the typed one. The pad coming back to life mid-note
is the whole reason this feature exists, and it must not produce a page that is
half text and half ink.

**K35** Typed text is autosaved on a debounce, following `useScratchpad`'s
pattern, and the editor is reachable from the notes toolbar as "Type page".

---

## 7. S5 — tags

**K36** Tags attach to notes only. One session is one note (J4), so tagging the
note tags its session and recordings by association. Tasks are not tagged.

**K37** The notes list gains a filter bar: tag chips with autocomplete from tags
already in use, and an **AND/OR toggle** — AND to narrow to notes carrying every
selected tag, OR to widen to notes carrying any. The owner chose both over
picking one.

**K38** Tag editing lives inline in the notes header, beside the editable title.
Ordering of the notes list does not change: newest first, as `listNotes` returns
it.

---

## 8. S6 — search

**K39** Search gets its own tab, beside Notes / Recordings / Triage. It spans
notes *and* recordings, so it does not belong inside either view.

**K40** One query box, two modes:

- **Find** — immediate local substring match, no model involved.
- **Smart search** — an explicit action that runs the Gemma pass below.

**K41** Both modes search note titles, note summaries, page transcripts, typed
page text and audio transcripts. A hit links to note + page, or to recording +
segment timestamp for audio (the recordings view already has clickable segment
timestamps).

**K42** Smart search is two-stage, summary-first:

1. Gemma screens the per-note summaries produced by K17–K18 and picks candidate
   notes. This scales with the number of notes rather than the volume of text.
2. Only those candidates' transcripts are read, and each hit is banded
   **strong / moderate / weak**.

The three bands are displayed as three separate groups. The alternative
approaches were rejected: Ollama embeddings would need a second model installed
and a third background queue, and a keyword prefilter plus rerank finds nothing
to rerank when the query shares no words with the note.

**K43** ⚑ Smart search quality is wholly dependent on summary quality, which
cannot be judged until there are real summaries over real notes. The band
thresholds and the screening prompt are therefore expected to need tuning after
first contact, and the prompt is versioned (K18) so that tuning is traceable.

**K44** A note with no summary (transcription failed, K19) is reachable by Find
but invisible to smart search's screening stage. It is not silently dropped: the
results state how many notes could not be screened.

**K46** ⚑ (fix round 2, Fix 3c) `summary` is `null` for three populations, not
just K44's: legacy notes (excluded from naming by design), a note whose page
transcription failed (K19 - deliberate, no summary from partial content), and -
until the fix for Important 1 landed - a note that ended on a typed page before
that fix shipped. Smart search's screening stage (K42 stage 1) reads summaries,
so a summary-less note needs a stated fallback or the owner can search for a
real lecture and have the app behave as if it does not exist. The fallback:
smart search screens a summary-less note on its title plus its page text
instead of its summary, and the result still states how many notes could not
be screened by summary (K44's reporting, extended to cover the fallback path
too, not narrowed by it). This is a decision, not an implementation - S6 builds
it.

---

## 9. The choice A21 deferred

**K45** ⚑ A21 pinned gap analysis to the *first* recording linked to a note and
flagged that "a multi-recording session would need a choice". K12 creates
exactly that session, so Phase 3 makes the choice: a page is compared against
the recording whose time span **overlaps that page's speech window**, and when
several overlap, the one with the greatest overlap.

Both halves of the data needed are already there — a page has `capturedAt` and
`finalizedAt`, a recording has `startedAt` and `endedAt`, and the lead/trail
window logic lives in `src/gaps/window.ts`. A page that overlaps no recording is
skipped, which is what A22 already prescribes for a note with no recording.

This belongs to **S1**, not S6: S1 is the unit that makes multi-recording
sessions real, so it is the unit that must not leave gap analysis comparing a
resumed page against the first sitting's audio.

---

## Assumptions added

- **A31** `MediaRecorder` chunks written in `seq` order and concatenated produce
  a blob the browser can decode. Verified by test, not assumed (K8).
- **A32** A session may hold several recordings; anything that reads a session's
  audio handles a list. Supersedes the single-recording part of A21.
- **A33** Resume never rewrites captured content. The only mutations are
  `status`/`endedAt` on the note and session, plus newly appended pages.
- **A34** A note's `titleSource` is sticky: once `'manual'`, no automated path
  ever writes its title again.
- **A35** The tag vocabulary is derived by scanning notes on demand. Acceptable
  at this note count; a stored vocabulary would be a cache to invalidate.
- **A36** Auto-naming, gap analysis, syllabus extraction and page transcription
  all share `ollama.model` (extends A30).
- **A37** `0x8A` is treated as reliable enough to be the sole page-turn trigger.
  Missed presses are recovered by pressing again (K30).
- **A38** A typed page never holds ink and an ink page never holds typed text
  (K34).
- **A39** Smart search reads only candidate notes' transcripts, so its cost
  scales with candidates, not with the library.
- **A40** A11 is superseded: audio is persisted incrementally and an
  interruption keeps the recording (K4–K7).
- **A41** A21 is superseded: a page's gap analysis uses the recording with the
  greatest overlap with that page's speech window, not the note's first
  recording (K45).

## Sequencing

Branch **`phase3`**, merged into it for the owner to test. Three waves, because
smart search needs the summaries auto-naming produces, and resume, tags and
search all edit the same notes sidebar.

- **Wave 1 — W1, sequential, not delegated.** Schema v4, `engine.resumeNote()`,
  and the notes-sidebar scaffold that S5's filter bar and S1's Resume button
  both mount into. Fixing the shared data model and the shared mount points
  first is what let Phase 2's parallel features merge cleanly; the same applies
  here.
- **Wave 2 — S1, S2, S3, S4, S5 in parallel**, one orchestrator per unit in its
  own git worktree and branch, each delegating under TDD.
- **Wave 3 — S6**, once summaries exist to screen.

## Testing requirements

Beyond the normal TDD expectation, three specific obligations carried over from
the Phase 2 retrospective and the risks above:

1. **K8's decode test is mandatory** and must fail first against the unfixed
   code. A green test that never saw a truncated stream proves nothing.
2. **Mutation-check every new test.** Two tests in the Phase 2 session passed
   vacuously; reverting the fix to confirm the test goes red caught both.
3. **Subagent claims are re-verified** by re-running tests, `tsc -b`, lint and
   the build on every branch independently, before and after each merge.
