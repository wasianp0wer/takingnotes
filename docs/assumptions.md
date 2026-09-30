# Assumptions

Assumptions made during autonomous execution of Phase 0 and Phase 1, without
asking. Each can be revisited; the ones most worth a second look are marked ⚑.

## Process and branches

- A1 ⚑ **Base branch.** Phase 1 is built on `notes-app`, cut from the unmerged
  `phase-2a-link-resilience` branch (156 passing tests: paced writes,
  reconnect, liveness, poll-based page-turn detection) rather than from
  `main`. F4 relies on its page-turn detector. `main` is not modified; merging
  `notes-app` into `main` is left to you.
- A2 Feature branches `notes/f1-transcription`, `notes/f2-audio`,
  `notes/f3-triage`, `notes/f4-page-turn` are cut from `notes-app` after
  Phase 0 and merged back into `notes-app` in the order F1 → F4 → F2 → F3
  (F4 mounts into F1's view).
- A3 Worktrees live under `.claude/worktrees/` (already gitignored), next to
  the existing `phase-2a` worktree.
- A4 The uncommitted deletion of `docs/superpowers/**` and the `.gitignore`
  `logs/` line in the main checkout are left as they are. Those files still
  exist on `notes-app` (it descends from committed history). Two of them are
  modified on `phase-2a`, so merging into a `main` checkout where they are
  deleted but not committed will need that deletion committed or resolved
  first.
- A5 Each feature writes its own spec (with its test list) and implementation
  plan under `docs/features/`.

## Product

- A6 A note is started by writing (pen input with no active note), or by
  "New note" in the Notes view. It ends with "End note" or when another note
  starts. Phase 1 creates one Session per Note. Phase 2 will let one manually
  started session span notes and recordings.
- A7 A page turn with no active note is ignored. The next pen stroke starts a
  note.
- A8 Blank pages are kept when turned past, so page numbering stays aligned
  with the device. Transcription skips empty pages and marks them done with
  empty text.
- A9 ⚑ The on-screen "New page" button and a physical page turn are
  independent. Pressing the button and also turning the physical page creates
  two pages. The button is meant for when the pad is not reporting turns.
- A10 Recordings made with no active note are standalone (`sessionId` and
  `noteId` are null).
- A11 Audio is held in memory while recording and saved on stop. A tab crash
  mid-recording loses that recording. Incremental chunk persistence is
  deferred.
- A12 Whisper default model is `Xenova/whisper-base.en` (English only; a
  setting). Multilingual transcription is out of scope for Phase 1.
- A13 ⚑ Ollama must accept the app's origin. Ollama allows `localhost`
  origins by default, so `npm run dev` works. A deployed build (e.g.
  Cloudflare Pages via `wrangler.toml`) needs `OLLAMA_ORIGINS` set by the
  user.
- A14 Tasks with no due date get urgency 0.1. Unset estimates default to 60
  minutes.
- A15 Deadlines already past before today are not auto-generated as tasks. An
  open task whose deadline passes stays open and gets the overdue boost.
- A16 Editing an event updates only the title and due date of its open task.
  User edits to `required` and the estimate on the task are preserved.
- A17 The Wacom (`wacomBLE.ts`) and WebHID (`tabletUSB.ts`) drivers are pen
  input code, not drawing code. Their files are left untouched and simply
  unwired from the UI.
- A18 The legacy localStorage notebook library is imported once at startup
  via the existing `migrateLegacyNotebooks()` and appears in the notes list.
  The old `DownloadedMemoryPage` UI is removed with the studio.
- A19 ROM page download is not exposed in the Phase 1 UI (D9: manual last
  resort). The probe (`probe.html`) keeps that capability.

## Phase 2

- A20 Phase 2 is built on branch `phase2`, cut from `notes-app` (the merged
  Phase 1 result). Feature branches `p1-gaps`, `p2-syllabus`, `p3-sessions`
  (flat names: git cannot nest a branch under the existing `phase2` ref) merge back into it in the order P3 → P1 → P2.
- A21 ⚑ Gap analysis runs against the *first* recording linked to the note.
  A session has one recording (J4), so this is unambiguous today; a
  multi-recording session would need a choice.
- A22 A page with no strokes, or a note with no linked recording, is skipped
  by gap analysis rather than failing.
- A23 A re-run of gap analysis replaces `proposed` suggestions and leaves
  `accepted` and `rejected` ones alone, so rejected points do not come back.
- A24 Accepted gap text is displayed as recording-derived content attached to
  the page. It is not editable in Phase 2 and never enters
  `TranscriptRecord.markdown`.
- A25 The syllabus review table always appears; nothing is written to the
  calendar without confirmation, even when every row parsed cleanly.
- A26 `sourceRef` is derived from an import key (the file name, or `pasted`
  plus a hash of the text) plus the assignment title and resolved date. Editing
  a title on the review screen therefore creates a new event rather than
  updating the old one.
- A27 Assignments whose date cannot be resolved are shown with an empty date
  for manual entry and are excluded until one is given.
- A28 ⚑ Starting a session requests the microphone. If that is refused the
  session continues without audio; handwriting capture is never blocked.
- A29 `pdfjs-dist` is added for PDF text extraction. Its worker is bundled
  locally rather than loaded from a CDN, so the app keeps working offline.
- A30 Gap analysis and syllabus extraction use the same Ollama model setting as
  page transcription (`ollama.model`). No separate model picker in Phase 2.
