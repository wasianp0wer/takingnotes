# Session handoff — Phase 1 and Phase 2 complete

Written 2026-10-09. Paste or reference this at the start of a new session.

## Where the work is

**`phase2` is the branch that matters.** It is a superset of everything:
Phase 1 + Phase 2. 68 commits ahead of `notes-app`, HEAD `4213a4a`.

| Branch | Contents | Verified |
|---|---|---|
| `phase2` | **Everything: all of Phase 1 and Phase 2** | 1083 tests / 90 files, build ✓, `tsc -b` ✓, 0 lint errors |
| `notes-app` | Phase 1 only, kept as a milestone | 699 tests |
| `main` | Untouched since the start of this work | — |
| `notes/f1-transcription`, `notes/f2-audio`, `notes/f3-triage`, `notes/f4-page-turn` | Phase 1 features, merged into `notes-app` | nothing outstanding |
| `p1-gaps`, `p2-syllabus`, `p3-sessions` | Phase 2 features, merged into `phase2` | nothing outstanding |
| `phase-2a-link-resilience` | Pre-existing device work, merged in as the base of `notes-app` | — |

**Nothing has been pushed.** Worktrees live under `.claude/worktrees/` (gitignored).

**Before merging `phase2` into `main`:** the main checkout still has an
uncommitted deletion of `docs/superpowers/**` plus a `.gitignore` change.
`phase2` descends from committed history, so those files still exist on it and
a merge would bring them back unless that deletion is committed first.

## What was built

Phase 1 turned a 4000-line drawing studio into a note-taking app. Phase 2 made
the recording useful to the notes.

- **Capture** — live pen stream segmented into strokes, every point timestamped,
  persisted incrementally (pen-up plus a periodic flush), so a crash loses at
  most the stroke in progress. Writing with no note open auto-starts one.
- **Handwriting transcription** — pages rendered at 1024px and transcribed by
  Gemma via Ollama, with the earlier harness findings honoured: `think: false`,
  capped `num_predict`, per-page timeout, degenerate-output rejection. Serial,
  resumable queue; prompts in a versioned registry.
- **Audio** — microphone recording linked to the active note, Whisper
  (transformers.js) in a Web Worker, recordings view with playback and clickable
  segment timestamps.
- **Triage** — the slack-based priority formula, idempotent task generation from
  deadline events, month calendar plus agenda, autosaving scratchpad.
- **Page turns** — physical turns detected by polling the pad's stored page
  count (the `0x8A` notification misses ~1 in 5), plus an on-screen button.
- **Sessions** — one action starts the pad, a note and the recording together;
  one session = one note + one recording. A microphone refusal never blocks
  writing. A session stays endable even while the Bluetooth chooser is open.
- **Gap filling** — per-page speech windows (60s lead, 30s trail), chunk-and-
  summarize when a window exceeds ~6000 chars, substantive-only content
  comparison, accept/reject review. Never writes into the handwriting
  transcript.
- **Syllabus import** — PDF and pasted text (no URL support), vision fallback
  for scanned pages, mandatory review table, writes `kind: 'deadline'` events
  that feed the existing task sync.

Key docs: `docs/spec.md` and `docs/spec-phase2.md` (product decisions),
`docs/architecture.md` (shared contract, §6 is Phase 2),
`docs/assumptions.md` (A1–A30), `docs/features/*-spec.md` and `*-plan.md`.

## Open issues, in priority order

1. **Nothing has been tested against the real pad.** Every claim above is tests
   and builds. This is the next real check.
2. **Device reconnect bug, unfixed** (recorded in `docs/architecture.md` §7):
   if a reconnect succeeds but restoring the pen stream fails, the error is
   swallowed. The pad reports connected while sending no pen input and nothing
   retries; page turns still create empty pages. Found by F4, out of scope then.
3. **Audio stall timeout** — `DEFAULT_STALL_TIMEOUT_MS` in
   `src/audio/transcriptionQueue.ts` is 15 minutes. A pure-compute WASM
   transcription longer than that is falsely marked failed. Proper fix is a
   worker heartbeat.
4. **A two-column PDF page can yield a plausible, pre-ticked, wrong date**
   (p2-spec L3). PDF text assembly trusts pdf.js item order.
5. **A recording in progress is lost on reload or crash** (A11). Incremental
   audio persistence was deliberately deferred.

## Decisions the owner made, so they are not re-litigated

- Gaps are **missing content** first; time alignment only narrows which speech
  is compared to which page. Substantive only — claims, definitions, names,
  dates, argument steps — not asides or restatements.
- Gap suggestions stay **separate** from the handwriting transcript, reviewed
  one at a time. Rejected ones never resurface.
- Syllabus import: **PDF and pasted text only**; URL support dropped because a
  no-backend SPA cannot fetch arbitrary sites. **Assignment deadlines only**, no
  class meetings or recurrence. Review table is mandatory.
- A session is **one note + one recording**, started and ended together.
- **Re-importing a syllabus whose dates changed creates duplicates** rather than
  updating — accepted 2026-10-09: a syllabus rarely changes and a changed one
  can be fixed by hand.
- Two files sharing a name must **not** collide — fixed 2026-10-09; the import
  key is now `file:<content hash>:<name>`.
- Whisper runs in-browser; the calendar is local to the app; gap filling and
  syllabus extraction reuse the one `ollama.model` setting.

## How this session was run, if you want the same again

Interview with batched questions → spec committed → a sequential foundations
step that fixes the shared data model and mount points → one orchestrator per
feature in its own git worktree and branch, each delegating to subagents under
TDD → merge sequentially, verifying tests and build on every branch
independently before and after each merge.

Two cautions learned here:
- **Verify subagent claims yourself.** Every report was checked by re-running
  tests and the build; the reports held up, but one flagged a real bug in
  another feature's merged code that its own author had not noticed.
- **Mutation-check new tests.** Two tests written in this session passed
  vacuously at first (one asserted a dropdown value that was always present
  regardless of the bug). Reverting the fix to confirm the test goes red caught
  both.
