# Phase 3 Orchestration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This plan is the plan of record for Waves 2 and 3; each unit's own spec and plan are written by that unit's orchestrator.

**Goal:** Deliver the twelve Phase 3 items on a `phase3` branch, as seven units across three waves, with no two units editing the same code at the same time.

**Architecture:** Wave 1 fixes the shared data model and the shared mount points, implemented sequentially from its own detailed plan. Waves 2 and 3 are one orchestrator per unit, each in its own git worktree and branch, each running spec → plan → TDD implementation unattended. Merges are sequential into `phase3`, verified independently before and after each one.

**Tech Stack:** TypeScript, React 19, `idb`, Vitest, Tailwind, Ollama/Gemma for text generation, transformers.js Whisper for audio.

**Spec:** `docs/spec-phase3.md` (K1–K45). Wave 1's plan: `docs/superpowers/plans/2026-10-09-phase3-w1-foundations.md`.

## Global Constraints

Every unit inherits these. They are repeated verbatim in each brief.

- **Branch from `phase3`, work in your own worktree, never touch `main`.**
- **Commands:** tests `npm test`, typecheck `npx tsc -b`, lint `npm run lint`, build `npm run build`. All four pass before every commit.
- **The capture engine must not depend on the recorder** (`architecture.md` §6.5). Nothing in `src/capture/` imports from `src/audio/`.
- **Audio must never block writing** (A28). A failure in the microphone path is reported, never fatal to capture.
- **Schema changes are additive only** and every `if (oldVersion < N)` block in `src/storage/db.ts` is frozen once shipped. Wave 1 ships v4; **no Wave 2 or 3 unit may bump `DB_VERSION` or add a store.** If you believe you need one, that is a blocker — stop and report it.
- **Reuse the `ollama.model` setting** for any model call (A30, A36). No new model picker.
- **Every prompt lives in a versioned registry**, following `src/transcription/prompts.ts` and `src/gaps/prompts.ts`.
- **No new runtime dependencies.** If you believe you need one, that is a blocker — stop and report it.
- **TDD, and mutation-check every new test:** after it goes green, break the implementation and confirm the test goes red. Two tests in the Phase 2 session passed vacuously. A test that cannot fail is not done.
- **Do not edit files another unit owns.** Each brief lists both what you own and what is off limits. Touching an off-limits file is a blocker, not a judgement call.

## Review Focus

Five failure modes that cut across units, each assigned an owner.

1. **A truncated WebM recording that will not decode** — the central risk of the whole phase (K8). S3 must prove the stitched blob survives Whisper's decode path with a test that fails first.
2. **Two sessions' audio attributed to one page's gap analysis** — K45's overlap rule is the fix; without it a resumed note compares its new pages against the first sitting's recording. S1 owns it.
3. **A battery poll outliving its connection**, firing writes at a disconnected pad and surfacing a stale percentage as current. S3 owns it.
4. **A tag filter that hides the note currently being written**, leaving pen input landing somewhere invisible with no explanation. S5 owns it.
5. **A smart-search query over a library where most notes have no summary** — the common case on day one, before the naming backfill has run. S6 owns it, and K44 requires the result to say how many notes could not be screened.

---

## Wave 1 — foundations (sequential, implemented in-session)

Follow `docs/superpowers/plans/2026-10-09-phase3-w1-foundations.md` task by task. Nothing in Wave 2 starts until it is merged to `phase3` and all four commands pass.

It delivers: schema v4; the tag, title-provenance and summary writers; typed-page storage; the recording-chunk store; `engine.resumeNote()`; the `NoteList` and `NoteToolbar` mount points; and `architecture.md` §8 recording all of it.

---

## Wave 2 — five units in parallel

Each orchestrator is dispatched with the brief below as its entire context, plus the instruction to read `docs/spec-phase3.md` and `docs/architecture.md` §8 first.

### S1 — Sessions: resume, lock, auto-naming

**Owns decisions:** K9, K13–K21, K45. **Owns assumptions:** A32, A33, A34, A36, A41.

**Files you own:**
- `src/capture/SessionControls.tsx` — disable Start session while a session runs (K15); delete the "its audio recording was lost" wording and the `hadAudio` lookup that feeds it (K9); add Resume to the interrupted banner.
- `src/notes/NoteTitle.tsx` (create) — the inline title editor, mounted in `NoteToolbar.title`. An edit calls `renameNote`, which sets `titleSource: 'manual'` (K20).
- `src/notes/naming/` (create) — the summary/title queue: serial, resumable, modelled on `src/transcription/queue.ts`, with its prompt in a versioned registry. Fires when a note ends **and** its pages have finished transcribing (K17). Writes through `setNoteSummary` (K18). Never names a note whose transcription failed (K19).
- `src/gaps/analyzer.ts`, `src/gaps/window.ts` — K45: pick the recording with the greatest overlap with the page's speech window, replacing "the note's first recording" (A21).
- `src/notes/NotesView.tsx` — **shared, see the merge note below.** Pass your components into `NoteToolbar.title`, `NoteToolbar.banner` and `NoteList.rowActions`.

**Off limits:** `src/capture/engine.ts` and `src/capture/types.ts` (S4 owns them in Wave 2; `resumeNote` already exists from Wave 1 — call it, do not change it). `src/storage/*` (Wave 1 shipped every writer you need). `src/audio/*` (S3). `src/triage/*` (S2). Anything under `src/search/` (S6).

**Consumes from Wave 1:** `engine.resumeNote(noteId)`; `renameNote`, `setNoteSummary`, `titleSourceOf` from `@/storage/notes`; the `NoteToolbar` `title`/`banner` slots and the `NoteList` `rowActions` slot.

**Done when:** Resume works from the sidebar and the interrupted banner, on interrupted and completed notes alike; Start session and New note are both disabled during a session while End stays enabled; viewing a non-active note during a session shows the "writing still goes to «title»" banner (K16); a note that ends gets a generated title and summary unless renamed by hand; and a resumed note's second-sitting pages are gap-analysed against the second sitting's recording.

### S2 — Triage: score colours and a configurable horizon

**Owns decisions:** K22–K25.

**Files you own:**
- `src/triage/priority.ts` — add the band function. Bands are absolute on the printed score: ≥140 red, 100–139 orange, 60–99 amber, 30–59 lime, <30 green (K22).
- `src/triage/TaskList.tsx` — apply the band colour to the score text only.
- `src/triage/CalendarPanel.tsx` — the horizon control: presets 3/7/14/30/All plus `Custom…`, replacing the hard-coded 7 at `:20` and the "Nothing in the next 7 days" empty state at `:196` (K23, K25).
- `src/storage/settingKeys.ts` — add `'triage.agendaDays': number`, default `7`.

**Off limits:** ⚑ `triage.lookaheadDays` — K24. That key controls how far ahead a deadline becomes a task in `generateTasks.ts`. Do not read it, write it, or repurpose it. Also off limits: `src/triage/generateTasks.ts`, and everything outside `src/triage/` except the one settings key.

**Consumes from Wave 1:** nothing. You can start immediately and you share no file with any other unit except `settingKeys.ts`, which in Wave 2 is yours alone.

**Done when:** every open task's score carries its band colour; the horizon control persists across a reload; a custom value is validated (reject empty, zero, negative, non-numeric, and anything over 365); and the task list's own behaviour is provably unchanged — `generateTasks` tests all still pass untouched.

### S3 — Device: battery, the page button, audio that survives

**Owns decisions:** K4–K8, K26–K31. **Owns assumptions:** A31, A37, A40.

**Files you own:**
- `src/audio/recorder.ts` — K4/K5/K6: create the `RecordingRecord` at start with `endedAt: null`; append each chunk via `appendRecordingChunk` as it arrives; on stop, stitch, write `recordingAudio`, delete the chunks, then patch `endedAt`/`durationMs`/`byteLength`/`mimeType`, in that order.
- `src/audio/audioRuntime.ts` — K7: startup recovery over `listUnfinishedRecordings()`, stitching each and queueing its transcription. A recording with no chunks is deleted rather than left as an empty row. This lives in the audio runtime, not the capture engine (§6.5).
- `src/utils/huionBLE.ts`, `src/device/controller.ts` — K26/K27 battery: an `onBattery` callback, `DeviceState.batteryPercent: number | null`, requested on connect and refreshed every five minutes while connected. K28/K29/K31 page turns: `onNextPage` emits a page turn directly, with a ~300 ms dedupe; the 5-second count poll **keeps running** as the liveness heartbeat and as the source of `storedPageCount`, but a rising count no longer emits a turn.
- `src/app/DeviceStatus.tsx` — show the percentage beside the connection status, hidden when `null`.

**Off limits:** `src/capture/SessionControls.tsx` — S1 owns it, including deleting the "audio was lost" sentence your work makes false (K9). `src/capture/engine.ts` and `types.ts` (S4). `src/storage/*` (Wave 1 shipped `appendRecordingChunk`, `stitchRecordingChunks`, `deleteRecordingChunks`, `listUnfinishedRecordings`).

**Consumes from Wave 1:** the chunk repository and `listUnfinishedRecordings` from `@/storage/recordingChunks` and `@/storage/recordings`.

**Done when:** ⚑ **K8's decode test exists, failed first, and passes** — a recording truncated mid-stream, stitched by recovery, both plays and survives the decode path `whisperWorkerCore` uses. Plus: a reload mid-recording leaves the recording present and transcribed; the battery percentage shows and refreshes; the poll stops firing at a disconnected pad and the percentage goes `null`; and pressing the pad's page button creates a page in the app, once per press.

**If K8's decode test cannot be made to pass**, that is a blocker. Stop, report exactly what the decode path rejected, and do not ship a silent fallback.

### S4 — Typed pages

**Owns decisions:** K32–K35. **Owns assumptions:** A38.

**Files you own:**
- `src/capture/engine.ts`, `src/capture/types.ts` — add `newTypedPage(): Promise<string | null>` on `CaptureEngine`, implemented on the existing serial op chain via `createTypedPage`. And K34: a pen point arriving while the active page is typed opens a **new live page** rather than writing ink into the typed one.
- `src/notes/TypedPageEditor.tsx` (create) — the textarea, debounce-autosaved through `setPageText`, following `useScratchpad`'s pattern.
- `src/notes/NotesView.tsx` — **shared, see the merge note.** Render the editor instead of `InkCanvas` for a typed page, and mount a "Type page" button in `NoteToolbar.actions`.

**Off limits:** `src/storage/pages.ts` (Wave 1 shipped `createTypedPage`, `setPageText`, `isTypedPage`). `src/capture/SessionControls.tsx` (S1). `src/audio/*` and `src/device/*` (S3). `src/notes/NoteToolbar.tsx` and `src/notes/NoteList.tsx` — use their slots; do not edit them.

**Consumes from Wave 1:** `createTypedPage`, `setPageText`, `isTypedPage`, `TYPED_MODEL`, `TYPED_PROMPT_VERSION` from `@/storage/pages`; the `NoteToolbar.actions` slot.

**Done when:** a typed page can be created and typed into mid-session; its text appears in its transcript as `status: 'done'` (so transcription skips it); a blank typed page has no transcript; handwritten and typed pages mix in one note in any order; and writing on the pad while a typed page is open starts a new live page instead of mixing ink into the typed one.

### S5 — Tags

**Owns decisions:** K3 (the UI half), K36–K38. **Owns assumptions:** A35.

**Files you own:**
- `src/notes/TagEditor.tsx` (create) — inline tag editing, mounted in `NoteToolbar.meta`, writing through `setNoteTags`.
- `src/notes/TagFilterBar.tsx` (create) — tag chips with autocomplete from `listTagVocabulary()`, plus the AND/OR toggle (K37), mounted in `NoteList.filter`.
- `src/notes/useNotesData.ts` — the filtering itself.
- `src/notes/NotesView.tsx` — **shared, see the merge note.** Pass your components into `NoteList.filter` and `NoteToolbar.meta`.

**Off limits:** `src/storage/notes.ts` (Wave 1 shipped `normalizeTags`, `setNoteTags`, `tagsOf`, `listTagVocabulary`). `src/notes/NoteList.tsx` and `NoteToolbar.tsx` — use their slots. `src/capture/*`, `src/audio/*`, `src/triage/*`.

**Consumes from Wave 1:** `normalizeTags`, `setNoteTags`, `tagsOf`, `listTagVocabulary` from `@/storage/notes`; the `NoteList.filter` and `NoteToolbar.meta` slots.

**Done when:** tags can be added and removed on a note; the list filters by any selection under both AND and OR; the vocabulary autocompletes from tags already in use; and ⚑ **a filter that would hide the note currently being written does not silently hide it** — the active note stays visible, or the filter bar says plainly that it is filtered out. Pen input landing in a note the user cannot see is the failure to prevent.

---

## Wave 3 — search

Starts only once S1 is merged, because its first stage reads the summaries S1 generates.

### S6 — Find and smart search

**Owns decisions:** K39–K44. **Owns assumptions:** A39.

**Files you own:**
- `src/search/` (create) — the index-free local `find` over note titles, summaries, page transcripts, typed page text and audio transcripts (K41); the two-stage Gemma `smartSearch` (K42) with its prompts in a versioned registry; and the view.
- `src/app/AppShell.tsx` — add the Search tab beside Notes / Recordings / Triage.

**Off limits:** every other unit's files. Search reads storage; it writes nothing except, if needed, a settings key of its own.

**Consumes from Wave 1 and S1:** `NoteRecord.summary` and `summaryPromptVersion`; the typed-page transcript shape; `src/llm/ollamaText.ts`'s `generate`/`generateJson`.

**Done when:** Find returns hits across all five sources with links to note+page or recording+timestamp; smart search groups results into strong/moderate/weak as three separate sections; ⚑ **a library where most notes have no summary still returns useful results and says how many notes could not be screened** (K44); and a smart search over an empty library, or with Ollama unreachable, fails with a plain message rather than a stack trace.

---

## Merge protocol

**The shared-file note.** Four units pass components into `NotesView.tsx`'s slots: S1 (`title`, `banner`, `rowActions`), S4 (`actions`, plus the typed-page canvas swap), S5 (`filter`, `meta`). Wave 1's extraction reduces this to adding one prop per unit, but it does not eliminate it. These conflicts are expected, bounded to a props list, and resolved by me at merge time — not by the units, which must not coordinate with each other.

**Merge order**, chosen so the units that share no file land first and the `NotesView` conflicts are resolved one at a time:

1. **S2** (triage — shares nothing)
2. **S3** (device — shares nothing)
3. **S4** (typed pages — first `NotesView` touch)
4. **S5** (tags — second)
5. **S1** (sessions — third; also unblocks Wave 3)
6. **S6** (search — last)

**For each merge:** verify the unit's own branch independently (`npm test && npx tsc -b && npm run lint && npm run build`), merge into `phase3`, resolve conflicts, then verify `phase3` the same four ways before starting the next merge. A merge that leaves `phase3` red is reverted, not patched forward.

**Verify every subagent claim.** Re-run the tests and the build yourself. In the Phase 2 session every report was checked this way; they held up, but one flagged a real bug in another feature's merged code that its own author had not noticed.

## Done when

- `phase3` passes `npm test`, `npx tsc -b`, `npm run lint` and `npm run build`.
- All twelve of the owner's items are demonstrably addressed, each traceable to a decision in `docs/spec-phase3.md`.
- Every ⚑ item in the Review Focus and in each unit's Done-when has a test that failed before it passed.
- `docs/session-handoff.md` is rewritten for Phase 3: branch state, what was built, open issues in priority order, and any decision the owner made during the run.
