# TakingNotes — Phase 2 Spec

Status: interview complete 2026-09-30. Phase 1 is merged on `notes-app`
(699 tests, builds clean). Phase 2 is built on `phase2`, cut from it.

Phase 0/1 documents remain in force: `docs/spec.md` (product), plus
`docs/architecture.md` (shared contract, extended here in §8) and
`docs/assumptions.md`.

Note on numbering: the repo's earlier "Phase 2A link resilience" work
(reconnect, liveness, poll-based page-turn detection) is already merged and is
unrelated to this document. Phase 2 here means the three features the brief
lists.

## Purpose

Phase 1 captures handwriting and audio and transcribes both locally. Phase 2
makes the recording *useful* to the notes, makes a course's deadlines arrive
without manual entry, and makes starting to work a single action.

Everything still runs locally: static SPA, no backend, Gemma via Ollama at
`http://localhost:11434`, Whisper in a Web Worker.

## Decisions from the interview

| # | Question | Decision |
|---|----------|----------|
| J1 | How is a gap found? | **By content first.** Substantive points present in the speech but absent from the notes. Time alignment is a hint that narrows which speech is compared against which page, not the definition of a gap. |
| J2 | Where does filled text go? | Stored separately with its provenance, reviewed one suggestion at a time, accept or reject. The handwriting transcript is never overwritten. |
| J3 | Syllabus input formats | PDF upload and pasted text. **URL support dropped** (a no-backend SPA cannot fetch arbitrary sites). |
| J4 | What does a session group? | One session = one note + one recording, started and ended together. Storage already permits more, so this can grow without a migration. |
| J5 | Gap analysis scope | Page by page. When a page's speech window is too large for one call, chunk the speech and summarize each chunk into key bullet points, then compare those bullets against the page's notes. |
| J6 | How much to report | Substantive only: claims, definitions, names, dates, argument steps, anything flagged as important or examinable. Skip asides, repetition and restatements of what was written. |
| J7 | What the syllabus import creates | Assignment deadlines only (`kind: 'deadline'`), which is what generates tasks. No class meetings, no recurrence. |

## Features

### P1 — Fill gaps in notes from the recording

**Trigger.** Per note, on demand ("Find gaps"), available once the note's page
transcripts and the linked recording's transcript are `done`. Re-runnable per
page.

**Which speech belongs to a page.** Each page has a time window from its first
stroke timestamp to `finalizedAt`, widened by a lead margin (speech precedes
writing) and a smaller trailing margin. Defaults: 60 s lead, 30 s trail.
Speech comes from the linked recording's `TranscriptSegment`s overlapping that
window (absolute time = `recording.startedAt + segment.startMs`).

**Two-stage comparison (J5).** If the window's speech fits the budget
(`GAP_DIRECT_CHAR_BUDGET`, default 6000 characters), compare it directly
against the page transcript. Otherwise: split the speech into overlapping
chunks (~3000 characters, ~300 character overlap), summarize each into key
bullet points with one model call per chunk, concatenate the bullets, and
compare those against the page transcript. The summarize step is lossy by
design and is recorded in the result so the UI can say so.

**Comparison output.** The model returns a JSON array of missing points:
`{ text, kind, sourceQuote }` where `kind` is one of `claim`, `definition`,
`name-or-date`, `example`, `argument-step`, `other`, and `sourceQuote` is
verbatim speech supporting the point so it can be checked against the
recording. Substantive-only rule per J6 lives in the prompt. Invalid JSON gets
one repair attempt, then the analysis fails with a readable error rather than
inventing results.

**Storage and review.** Each point becomes a `GapSuggestionRecord` with status
`proposed`. The note view lists a page's suggestions with their kind and
source quote; accept or reject each. Accepted suggestions persist as
recording-derived content attached to the page, clearly labelled, and never
merged into `TranscriptRecord.markdown`. Rejected ones are kept (status
`rejected`) so a re-run does not resurface them; a re-run replaces only
`proposed` suggestions.

**Guards.** Same discipline as Phase 1 transcription: `think: false`, capped
`num_predict`, per-call timeout, degenerate-output detection.

### P2 — Syllabus import populates assignments into the calendar

**Inputs.** A PDF file, or pasted text. Both land on the same extraction path.

**PDF text.** Extract per page with `pdfjs-dist`. A page whose text layer is
empty or near-empty (scanned syllabus) is rendered to a canvas and sent to
Gemma's vision path instead.

**Extraction.** One or more model calls (chunked by the same character budget
as P1) return a JSON array of assignments:
`{ title, dueDate, kind: 'deadline', estimatedMinutes?, notes? }`. Dates are
normalized to epoch ms; a date with no year resolves against a term start date
the user can set on the review screen, defaulting to the current date.
Unparseable dates are surfaced for manual entry rather than guessed.

**Review before write (never silent).** A table of extracted assignments,
each row editable (title, due date, required, estimated minutes) with an
include tick. Nothing reaches the calendar until you confirm.

**Idempotent re-import.** Each written event gets `source: 'syllabus'` and a
stable `sourceRef` derived from the import's identity plus the item (title and
date). Re-importing the same syllabus updates matching events instead of
duplicating them; the review screen marks rows that already exist.

**Downstream.** Written events are `kind: 'deadline'`, so F3's existing
`syncTasksFromCalendar` generates tasks with no further work.

### P3 — Manual session start, automatic recording and grouping

**Start session.** One action in the header: create a `Session`, open a `Note`
in it, start audio recording, and ensure the pad is connected, streaming and
its page-turn capture running.

**During.** Page turns add pages to the session's note, exactly as now. The
header shows session state: elapsed time, whether audio is recording, and the
device link.

**End session.** Finalize the current page, complete the note, stop the
recording (which queues its transcription), and mark the session ended.

**Audio must never block writing.** If the microphone is unavailable or
permission is denied, the session still starts and captures handwriting, with
the audio failure shown plainly. Likewise, a session with no pad connected
still records audio.

**Interruption.** On reload or crash, Phase 1 recovery marks the note
`interrupted` and its session ended; the in-progress recording is lost
(assumption A11 stands). The notes list shows interrupted sessions as such.

**Bare notes still work.** Writing with no session continues to auto-start a
note (a Phase 1 rule). Sessions are the primary flow, not the only one.

## Out of scope for Phase 2

Editing accepted gap text; gap analysis across notes; class meetings and
recurrence from syllabi; multi-note sessions in the UI; syllabus URL fetching;
incremental audio persistence (A11); a fix for the device reconnect bug
recorded in §9 below.

## Done means

Per feature: the app builds, all existing tests pass, new tests cover core
logic, committed on its branch with a short summary. Merged sequentially into
`phase2` at the end. Nothing pushed.
