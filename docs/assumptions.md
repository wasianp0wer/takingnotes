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
