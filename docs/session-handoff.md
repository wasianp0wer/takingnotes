# Session handoff

## 2026-10-19/20 session: Sessions UI, search and themes (branch `sessions-ui`)

Paste or reference this at the start of the next session. It is the summary of
record for this work: what is where, how it was run, what was built, what was
decided on the owner's behalf, and what is still open.

### Where the work is

| Branch | Contents |
|---|---|
| `sessions-ui` | **This session's work**: 42 commits on top of `phase3` `a04336a`, HEAD `c17b836`. **Not merged.** |
| `phase3` | Unchanged since the session began, apart from the design doc commits `bd4d4a0` and `a04336a` made before branching |
| `main` | Unchanged |

Verified at `c17b836`: **1889 tests in 147 files** (baseline 1614 / 119),
`npx tsc -b` clean, `npm run lint` 0 errors (5 warnings: 4 in
`src/utils/huionTransport.ts` and 1 `set-state-in-effect` in
`src/triage/useTriageData.ts`, both pre-existing and untouched), and
`npm run build` succeeds with no chunk-size warning.

Key docs:
- spec `docs/superpowers/specs/2026-10-19-sessions-ui-and-themes-design.md`
- plan `docs/superpowers/plans/2026-10-19-sessions-ui-and-themes.md` (18 tasks)
- contract `docs/architecture.md` §9; earlier sections it replaces carry a "superseded by §9" note
- the approved mockup, which is local and untracked:
  `.superpowers/brainstorm/84846-1792455913/content/sessions-layout-v3.html`

**Next step is the owner's:** merge `sessions-ui` into `phase3` locally, push and
open a PR, or keep it. Nothing has ever been pushed (see the `origin/main` trap
below). A PR from this branch would carry Phases 1–3 as well.

### How the session ran

1. **Interview.** Brainstorming with one question at a time and browser mockups
   (v1 → v3). The owner set the shape: two big tabs; a sessions sidebar with
   quick and advanced filters and an Uncategorized group; notes and transcript
   side by side; a header search with an expandable advanced view and regex;
   sharp, mostly borderless, hover-only styling; themes as JSON, with a builder in
   Settings. A reviewer read the design as a builder would and raised three
   questions. The owner answered two: live capture jumps to the live session, and
   advanced-search filters narrow Find only. The third (fonts) was a designer's
   call.
2. **Plan.** 18 TDD tasks, pre-flight scanned for cross-task conflicts. Two were
   ruled on before starting (see the rulings below).
3. **Build.** Subagent-driven: one fresh implementer per task, then a task review,
   then fix rounds with scoped re-reviews. Opus did the integration tasks (13, 15)
   and the risky reviews; Sonnet did the rest; Haiku did small re-reviews.
   Every task passed review, most after one fix round.
4. **Final whole-branch review** on Opus, then one fix wave of five Important
   findings plus docs, and a scoped re-review. Clean.
5. **Owner follow-ups on 2026-10-20**, built directly with TDD in this session
   (see *Follow-ups* below).
6. The app was run with Playwright and checked by screenshot in all five
   themes, in Triage and Settings, and with seeded long and Markdown/LaTeX
   transcripts.

### What was built

- **Shell.**
  - Two tabs, Sessions and Triage, centred in the header with Start session
    beside them. Search, pad status, Record and Settings sit on the right.
  - Both tabs stay mounted (`forceMount`), so nothing is lost on a tab switch.
- **Sessions view.**
  - **Sidebar:**
    - a quick filter on title and tags, always plain text
    - an advanced filter: date range, tags any/all, title, text, has recording,
      has typed page, status, and a Regex switch
    - Sessions and Uncategorized groups with counts, and a "Live" marker on the
      note being written
  - **Header:** inline title and tags, Resume, and the writing-destination banner.
  - **Notes half:** the Handwriting/Transcription switch, page arrows, New
    note / End note / Type page, and gap analysis.
  - **Audio half:** ‹ Recording N of M ›, the player, transcription status above
    the transcript, clickable timestamps, rename by clicking the title, and Delete.
  - Selection, page, recording and notes mode persist across tab switches and
    reloads (`takingnotes.sessionsUi`, versioned). Filters persist across tab
    switches only.
  - A stale or unknown saved key falls back quietly: active note, then newest
    session, then newest uncategorized entry.
  - Live capture jumps to the live session, even from Triage.
- **Search.**
  - **Header quick search:** plain text, with a dropdown of up to 8 hits.
    Keyboard navigation and full combobox ARIA. It collapses on Escape or blur
    and reloads the corpus each time it reopens.
  - **Full-screen advanced search** is built on the Radix Dialog, so focus is
    trapped, the app behind is hidden from screen readers, Escape works from
    anywhere and focus returns to the opener.
    - Filters (date, tags, sources) narrow Find only.
    - With Regex on, matching runs in a Worker with a 1 s budget.
    - Smart search is unchanged.
    - Query and results survive closing (resolves S6-A9).
  - Opening a hit selects its session and page (in Transcription mode) or seeks
    the player to an audio segment. Phase 3 had declined the seek.
- **Themes.**
  - JSON themes: 41 colour tokens per element kind, plus shape and fonts. They are
    validated by `parseTheme` and applied as CSS variables; tokens are HSL
    triplets, so Tailwind's `/alpha` works.
  - Five built-ins: Light (the new default), Dark, Midnight Blue, Rainbow (one
    colour per element kind, in the spirit of Hiberbee) and Sakura.
  - The active theme is mirrored to `localStorage` and painted before React
    loads, with no Light flash.
  - Settings has a picker with swatches, plus New / Edit / Duplicate / Delete and
    Import / Export as `.json`. Imports are capped at 256 KB and their ids are
    made unique against the built-ins.
  - A builder with live preview: Cancel restores the previous theme, and it warns
    on low ink contrast.
  - A theme sets `color-scheme` from its base, so native controls go dark with a
    dark theme.
- **Ink.** The on-screen canvas uses the theme's `canvas-bg` and `ink` colours.
  The OCR raster (`rasterize.ts`) stays white and black always (`RASTER_INK`),
  because theming it would change what the model reads.
- **Visual language.**
  - Square corners and background tints instead of resting borders.
  - Outline and fill appear on hover only.
  - `focus-visible` rings are always present.
  - Element-kind colour classes: `text-heading`, `text-session-title`,
    `text-tag`, `text-timestamp`, `text-date`, `text-link`,
    `bg-search-highlight`.
  - A guard test fails on any hard-coded colour in `.tsx` or `index.css`.
  - Triage keeps its layout and is restyled only.

### Follow-ups the owner asked for after the build (2026-10-20)

1. **The notes half defaults to Transcription,** and picking a session opens it
   on its transcript. Starting capture (Start session, New note, Resume, or the pen
   starting a note) still switches to Handwriting, because a live page has no
   transcript yet. *Changing that is a one-line change if the owner wants
   Transcription there too.*
2. **Gap analysis is pinned to the bottom of the notes half** in Transcription
   mode. The transcript scrolls above it, and the strip is capped at 40% of the
   half and scrolls on its own. (The original design had it above the transcript.)
3. **Borders**: one separates the session sidebar from the main view, and each
   half (notes, audio) is framed.
4. **Transcribed handwriting sits in its own bordered box.** The box has a set
   size between the page controls and the gaps strip, and scrolls inside itself.
   The model/prompt line sits outside the box.
5. **A serif transcript font in every built-in**: `'Iowan Old Style',
   'Palatino Linotype', Palatino, Georgia, ui-serif, serif`. These are system
   fonts, so nothing is downloaded. A theme has one transcript font, so typed
   pages and audio segments use it too.
6. **Transcripts render as Markdown with LaTeX maths.**
   - **Why:** Gemma writes `$…$` maths such as `$\rightarrow$`. The v2 prompts
     (`src/transcription/prompts.ts`, 2026-10-20) now ask for LaTeX maths
     explicitly; see "Transcription prompt v2" below.
   - **How:** `src/notes/TranscriptMarkdown.tsx` uses react-markdown with
     remark-gfm, remark-math and rehype-katex (`throwOnError: false`). Raw HTML
     is never rendered. Single newlines join into a paragraph (standard
     Markdown); remark-breaks was removed with prompt v2, since a handwritten
     line end is not a line break the writer intended.
   - **Loading:** it is lazy-loaded (`LazyTranscriptMarkdown.tsx`, about 440 kB),
     so the startup bundle is unchanged at 484 kB. The text shows plain for a
     moment first.
   - **Scope:** display only. The stored transcript, and so search and gap
     analysis, read the raw text.
   - **Limit:** `$$…$$` on one line typesets inline; only on its own lines is it
     a block.
   - Supersedes F1-A4 (marked in `docs/features/f1-spec.md`).
7. **Transcription prompt v2** (`src/transcription/prompts.ts`, 2026-10-20).
   Gemma was inconsistent about headings, line breaks and diagrams, so the
   prompt now defines the cues instead of leaving them to the model. All four
   families share one rule block plus one family guard, and all bump to `v2`.
   - **Headings:** underlined text, and only underlined text, is a heading.
     On the first page of a note the first underlined line is `# ` and the rest
     `## `; on later pages every underlined line is `## `. The model sees one
     image, so the queue passes `firstPage: page.pageIndex === 0` through
     `PageTranscriber.transcribePage`. *Owner call pending:* a session that
     spans several notes gets one H1 per note.
   - **Line breaks:** a handwritten line end is not an output line break; lines
     that continue a thought join into a paragraph, and a blank line starts a
     new one. The renderer dropped remark-breaks to match (item 6).
   - **Diagrams:** inline notation (`a <- b`, `x -> y`, relations) stays as
     text or LaTeX; a ruled table becomes a Markdown table; a freestanding
     drawing is never drawn in characters but replaced with one italic note,
     `*[Diagram: …]*`, naming what it shows and its labels.
   - **Also new:** maths as LaTeX between `$`, struck-through words omitted,
     inserted words placed at the caret.
   - **Versioning:** the page position is not part of `promptVersion`; it is
     a fact about the page, not a tuning. `promptVersionFor(model)` gives the
     version alone for the queue's `pending` mark, which has no page loaded.
     Existing transcripts keep showing `gemma-v1` under the box; Retry re-runs
     a page with v2. There is no bulk re-transcribe.
   - **Not yet done:** the v2 wording has not been run against real pages. The
     first thing to check is whether Gemma honours the paragraph rule and the
     `*[Diagram: …]*` form; both are plain-language rules it may need examples for.

### What the review process caught

These are worth knowing: each would have reached the owner, and none was caught
by the implementing task's own tests.

- **Patterns of a dozen characters or fewer froze the tab.** `.*.*.*.*z` and
  `(\w+\s?){12}$` got past the first regex guard and hung on ordinary prose.
  This is why regex runs in a Worker with a budget, not on the main thread.
- **The early theme paint was undone.** The provider repainted Light on every
  launch and overwrote the saved mirror before the stored choice loaded.
- **Typed text could be overwritten.** Flipping Handwriting/Transcription on a
  typed page remounted its editor from stale text, so the next keystroke would
  overwrite what was saved.
- **Quick search loaded its corpus once per session.** New notes never appeared
  until a reload. It also lacked `aria-activedescendant`.
- **The advanced-search modal didn't manage focus.** Escape didn't work while the
  search was loading, Tab reached the hidden app behind it, and focus wasn't
  restored on close.
- **The final review found five more:**
  - a saved Transcription mode hid live ink when capture started
  - the theme's transcript font was used nowhere
  - dark themes left native controls light
  - the regex quantifier cap refused `\w+\s+\w+`
  - the sidebar regex filter flickered on every page turn during capture
- **Tests that couldn't fail:**
  - Switch tests that a hard-coded Switch passed
  - catalog reload tests that couldn't tell their three triggers apart
  - a Task 6 guard that was redundant once the effect keyed on the token

  Each was strengthened and mutation-checked.

### Decisions taken on the owner's behalf

Each is listed with what it costs if it's wrong.

- **Regex safety is two layers:** a static guard (instant rejection of nested
  or repeated quantified groups, over-long patterns and bad syntax) plus a Worker
  runner with a 1000 ms budget. No regex runs on the main thread in production.
  - *Cost:* regex filtering and Find are asynchronous, with a structured-clone
    cost per query.
  - An interim cap of two `*`/`+` quantifiers was removed after the final review,
    because it refused ordinary patterns. *Cost:* a pathological pattern now takes
    1 s and then errors, rather than being refused instantly.
- **The sidebar regex filter is stale-while-revalidate.** While the same
  patterns re-run against a rebuilt catalog, the last matches keep filtering.
- **Theme colours in JSON are `#rrggbb` only.** *Cost:* no `rgb()` or named
  colours in custom themes.
- **`useThemes()` outside a provider returns Light with no-op setters,** so
  existing tests stay unwrapped. `main.tsx` wraps the real app.
- **The theme builder has a Base (light/dark) select.** A custom dark theme needs
  it to get the `.dark` class.
- **The Switch's keyboard coverage is "it is a native button".** happy-dom
  cannot synthesise Space or Enter.
- **Commit trailers name the model that wrote each commit** (Sonnet, Opus or
  Haiku).
- **Intermediate commits had search unreachable between Task 13 and Task 15.**
  This is on a feature branch only.
- **Triage is always mounted, as a consequence of `forceMount`.** It refreshes
  on `useTriageData`'s 60 s interval and on window focus, not on tab entry.

### Owner checks (need a human or the real pad)

1. Ink visibility on the dark themes, on the real pad. On-screen ink uses the
   theme's `ink`; the OCR raster stays white and black.
2. A real Gemma transcription, rendered: maths, headings and lists in the bordered
   box.
3. Whether the five palettes and the Rainbow per-element colours read well.
4. Triage refreshing every 60 s or on window focus, rather than on tab entry.
5. Recording rename and delete. The spec suggested a small menu by the recording
   arrows; the build has click-the-title rename, and Delete stays inside the
   recording detail. Confirm, or ask for the menu.
6. The theme builder's preview doesn't reach the page canvas. Editing `canvas-bg`
   or `ink` recolours the rest of the UI, but `InkCanvas` draws with the saved
   theme until you save. Making the canvas follow the preview would re-render
   every theme consumer on each keystroke.
7. `.font-mono` now uses the theme's mono font instead of being forced to the UI
   font. Check that digit-aligned UI still looks right.
8. Removed dividers that have no replacement tint: rows in the syllabus
   `ReviewTable`, and the `TaskList` add-task form. Confirm the separation is
   enough.

### Known limitations and deferred minors

None of these block a merge; the final review triaged all of them as
OK-TO-DEFER.

- **Regex:**
  - A zero-length first match counts as no match, so `x*` on `axxb` reports
    nothing.
  - A Worker that fails to load is reused until its 1 s budget expires.
  - Loading the module Worker under Electron or `file://` is untested.
- **Search:**
  - Escape in quick search drops focus to the page body rather than the Search
    button.
  - A recording with two segments starting at the same millisecond gives a
    duplicate React key.
- **Themes:**
  - Saving and deleting custom themes rewrite the stored list, so malformed
    stored entries are dropped permanently.
  - Two theme saves within one IndexedDB round trip could lose one.
  - Escape during an in-flight builder save still activates the theme.
- **Live follow:**
  - `useLiveFollow` is a passive effect, so a page turn can show the previous
    page for one frame. `useLayoutEffect` would fix that.
  - `openRecording` resets the page to 0 even when you're on the same note.
- **Sidebar:** the checkboxes are native, styled only by `accent-color`.
- **Tag-mode defaults differ:** the sidebar defaults to AND, advanced search to
  OR.
- **Pre-existing:** `setPageText` sends no change signal, so other views of a
  typed page refresh only on the next reload trigger.

### Environment notes from this session

- **Node 25 shadows happy-dom's `localStorage`** with a global that has no
  methods. Tests that touch `localStorage` stub a Map-backed Storage. See
  `src/themes/ThemeProvider.test.tsx`.
- **The machine is sometimes very heavily loaded** (load average 80). At that
  level `npm test` shows random timeouts in untouched files, and one run took 51
  minutes. Check `uptime` and re-run before believing a failure. A quiet run
  takes about 17 s.
- **The repo has no Prettier config.** Running Prettier with defaults switches
  files to double quotes. House style is single quotes, width 100.
- **To screenshot the app:** start `PORT=5199 HOST=127.0.0.1 npm run dev`, then
  run `playwright-core` against the cached Chromium in
  `~/Library/Caches/ms-playwright`. It isn't a project dependency; it was
  installed in the session scratchpad. Consider `/run-skill-generator` to
  capture this as a project skill.
---

## Phase 3 complete

Written 2026-10-10, revised 2026-10-15 and again 2026-10-19. Paste or reference
this at the start of a new session. It is the summary of record for Phase 3:
what is where, what was built, what was decided on the owner's behalf, and what
is still open.

## Where the work is

**`phase3` is the branch that matters.** 139 commits ahead of `main`, HEAD
`e177463`. Verified on that commit: **1614 tests across 119 files**, `npx tsc -b`
clean, `npm run lint` 0 errors (5 pre-existing warnings in
`src/utils/huionTransport.ts`, untouched), `npm run build` succeeds, working tree
clean. (Phase 3 itself ended at `2724bc5` with 1498 tests across 115 files; the
difference is the 2026-10-19 session below.)

| Branch | Contents |
|---|---|
| `phase3` | **Everything: Phases 1, 2 and 3** |
| `main` | Phases 1 and 2 (`0be7c38`), deliberately untouched — the owner tests `phase3` before it merges |
| `worktree-agent-*`, `wave2/*`, `wave3/*`, `s1-sessions` | Phase 3 units, all merged into `phase3`; kept as milestones |
| `notes-app`, `notes/f*`, `p1-gaps`, `p2-syllabus`, `p3-sessions`, `phase2` | Phase 1 and 2 milestones |

Phase 3's unit worktrees have been removed. Each unit's branch was confirmed an
ancestor of `phase3`, and each worktree confirmed clean, first.

### ⚑ Two environment traps that cost real time here

**`origin/main` is at `d150499` — 230 commits behind local `main`.** Nothing from
Phases 1, 2 or 3 was ever pushed. Tooling that creates a git worktree from the
*remote* default rather than local `HEAD` silently hands you a pre-Phase-1 tree
with no `docs/` directory at all. That happened to three of five delegated
worktrees this session. Verify a worktree's base before trusting work done in it:
`git merge-base --is-ancestor <base> HEAD`.

**Give every worktree a real in-tree `npm install`.** A symlink to the main
checkout's `node_modules` is partly refused by the sandbox: Vite cannot resolve
`pdfjs-dist`'s worker across it, so six test files silently fail to load and
roughly 70 tests never run — while `npm test` still reports everything it *did*
run as passing. `scripts/run.mjs` also resolves `node_modules` relative to its own
project directory, so `npm run lint` and `npm run build` crash outright in a
symlinked worktree.

A related one-off at the start of this session: the main checkout's `node_modules`
predated the Phase 2 syllabus work, so `pdfjs-dist` was declared but never
installed and the same six files were silently not running. `npm install` fixed it;
the lockfile was already correct.

## What this session did

1. **Interview.** Four rounds of batched questions settled the twelve requests into
   decisions. The owner overruled one proposal: on the pad's page button, they
   judged that treating `0x8A` as the sole page-turn trigger was fine since nothing
   reads the pad's stored page data, and a missed press can simply be pressed
   again. That was right, and it surfaced a coupling worth keeping — the ROM count
   poll also feeds the liveness watchdog, so it stays running as a heartbeat.
2. **Spec.** `docs/spec-phase3.md`, decisions **K1–K46**, assumptions **A31–A41**,
   written to project convention rather than the tool default path. It records two
   supersessions the work forced: A11 (audio lost on crash) and A21 (gap analysis
   pinned to a note's first recording).
3. **Plans.** A detailed task-by-task plan for the foundations wave
   (`docs/superpowers/plans/2026-10-09-phase3-w1-foundations.md`) and an
   orchestration plan of record briefing the later units
   (`…-phase3-orchestration.md`), each brief naming the files its unit owns and the
   files that are off limits.
4. **Wave 1 — foundations, sequential.** Schema v4, the storage writers for every
   new field, `engine.resumeNote()`, and the `NoteList`/`NoteToolbar` extraction
   with six named mount points so later units could not collide. 1083 → 1145 tests.
5. **Wave 2 — five units in parallel**, one orchestrator each in its own worktree,
   each running spec → plan → TDD unattended: sessions/auto-naming, triage,
   device/audio, typed pages, tags. Each got a pre-merge review and at least one
   fix round, then was merged sequentially with `phase3` verified before and after.
   1145 → 1367 tests.
6. **Wave 3 — search**, last because its smart mode screens the summaries
   auto-naming produces. Four fix rounds. 1367 → 1498 tests.
7. **Reviews.** A pre-merge review per unit, a whole-branch review per wave (on the
   most capable model), and a scoped re-review after every fix round.

## What the 2026-10-19 session added

Transcription was rebuilt to run **window by window**, persisting a partial
transcript and a cursor after each five-minute window, so a lecture-length job
survives a reload, can be paused and resumed, yields to a recording the owner
just made, and shows a real proportion instead of a counter with no total.
The reason it was needed turned out to be a defect, not slowness: with
`return_timestamps` set and no `max_new_tokens`, transformers.js routes through
`_generate_with_seek`, whose loop advances by `seek += segment_offset` — and
that offset is **zero** whenever the model's last segment boundary is the
`<|0.00|>` timestamp, so the decode re-generates the same audio for ever while
emitting a progress report on every spin, which is precisely why the pass
counter climbed and the stall watchdog never fired.

Design and plan: `docs/superpowers/specs/2026-10-18-chunked-resumable-transcription-design.md`
and `…/plans/2026-10-18-chunked-resumable-transcription.md`; the contract is
`docs/architecture.md` §8.6. **⚑ One thing left open:** the eleven files that
were uncommitted when that session began (the `passes`/watchdog/download work)
were swept into feature commits `0535eb9` and `cce118b` rather than kept
separate as the owner asked, so reverting this feature would also revert their
own work. Splitting them back out is unresolved.

## What was built

The owner's twelve requests, each traceable to a decision in `docs/spec-phase3.md`
and to a unit spec in `docs/features/s*-spec.md`.

- **Sessions.** `engine.resumeNote(noteId)` is one mechanism for both restarting an
  interrupted session and returning to a finished note: it reopens rather than
  forks, appends a page after the last, and keeps the note's original `startedAt`.
  While a session runs, New note and Start session are disabled and End stays
  enabled; viewing another note raises a banner naming where writing is going.
- **Auto-naming.** A serial, resumable queue names a note from its content once it
  ends *and* its pages have finished transcribing. The summary always writes; the
  title only if you have not renamed it by hand, which opts that note out
  permanently. A note whose transcription failed is never named.
- **Triage.** The priority score carries an absolute colour band (≥140 red through
  <30 green) on the number itself. The agenda lookahead is a persisted setting —
  presets plus a validated custom value — under a *new* key, `triage.agendaDays`.
- **Audio that survives.** `MediaRecorder` chunks persist as they arrive and close
  atomically in one transaction; startup recovery stitches an interrupted
  recording. The old behaviour lost the whole recording.
- **The pad's page button.** The `0x8A` notification is the page-turn trigger
  directly, with a ~300 ms dedupe. The 5-second ROM count poll keeps running as the
  liveness heartbeat and as the source of `devicePageNum`.
- **Battery.** Shown beside the connection status, refreshed on connect and every
  five minutes, hidden when unknown, cleared the moment the link drops.
- **Typed pages.** A typed page mixes freely with handwritten ones and mirrors its
  text into the page's existing `transcript` as already-done, so transcription skips
  it while search and gap analysis read the one field they know. Pen input on a
  typed page opens a new live page rather than mixing ink into it.
- **Tags.** Normalised on write, edited inline, with an AND/OR filter bar. A filter
  never silently hides the note being written.
- **Search.** Its own tab. **Find** is immediate and local over five sources;
  **Smart search** asks Gemma to screen the per-note summaries, then bands only the
  candidates strong/moderate/weak. A hit selects its exact note and page, or its
  recording.

Key docs: `docs/spec-phase3.md` (K1–K46), `docs/architecture.md` §8 (the Phase 3
contract; §8.2 audio, §8.4 mount points, §8.5 search), `docs/assumptions.md`
(A1–A41), and per unit `docs/features/s*-spec.md` / `s*-plan.md` / `s*-report.md`.

## What the owner should check first, in priority order

1. **⚑ Interrupt a real recording, reopen the app, confirm it plays *and*
   transcribes.** This is the one thing tests cannot reach. A crash-truncated WebM
   is proven to decode under **ffmpeg**, and the fixture is ffmpeg-authored (a
   known-size Segment and a SeekHead pointing at withheld Cues) where a live
   `MediaRecorder` emits neither. The production path is the browser's own
   `decodeAudioData`, which is stricter. The audio *bytes* are preserved either way;
   if a browser refuses them the contingency is a remux step, not built. See
   `architecture.md` §8.2.
2. **Nothing else in Phase 3 has been used against the real pad.** Every other
   claim here is tests and builds.
3. The pad's page button: confirm one press makes exactly one page, and that a
   missed press is visible via the toolbar's "Page N of M".
4. Smart search's relevance, which cannot be judged without real summaries over
   real notes. Expect the screening prompt and band thresholds to need a tuning
   pass; both are versioned (K43) so the tuning is traceable.

## Decisions taken on the owner's behalf

Recorded so they can be overturned rather than discovered.

**Design.** Resume reopens rather than forks, and two concurrent resumes of the
same note share one promise. K45 settles the choice A21 deferred: a page is
compared against the recording with the greatest overlap with its own speech
window. Naming waits for a transcript to reach `done` **or** `failed`, not merely
to exist. `finalizeTypedPage` deliberately does not emit `pageFinalized` — the
note-level `subscribeNoteEnded` is naming's honest trigger. The agenda horizon got
a new settings key rather than reusing `triage.lookaheadDays`. Score bands are
absolute on the printed number. Smart search is summary-first, two-stage, and its
hits are note-granular. `finalizeRecording` writes all three stores in one
transaction, replacing the spec's own four-step ordering. The session lock is split
across two units, because New note lives in the toolbar Wave 1 extracted.

**Declined.** A compound `['recordingId','seq']` chunk index, in favour of
documenting the in-memory sort as an accepted cost at lecture lengths. Extracting
the `tx.abort()` / `tx.done.catch()` / `throw` preamble duplicated across six
repository writers. Seeking the audio player from a search hit. Lifting search
state so a tab switch keeps the query. Reordering two lines in audio recovery.
Each is listed under *Known limitations* with what it costs.

**Added beyond the brief**, each because leaving it meant telling the owner
something untrue: audio transcripts in smart search; batching the screen prompt
against the project's own character budget; reporting "screened by title alone"
rather than claiming page text was used; reporting "could not check N notes" rather
than "no matches".

**Process.** Wave 1 ran through subagents too, rather than inline as its plan said.
Every claimed mutation check was re-run by hand rather than trusted. Five reviews
ran on the most capable model, where a miss costs a lecture. Two ownership
boundaries were lifted mid-flight. One flake and one merge brace were fixed in the
integration branch directly rather than dispatched. S5 was merged ahead of S3,
since S3 shares no file with it. At merge time, S5's and S1's independently-invented
reload mechanisms were unified on one name, and S1's single-listing recording
lookup was taken over S3's two-listing version after verifying the candidate sets
are identical.

## What the process caught

Worth knowing, because it is the argument for running the next phase the same way.

**Four defects that would each have cost the owner work**, none of which the
implementing unit's own tests caught: a double-click on Resume finalising the page
being written on; recovery deleting a lecture another pass had just saved; the
`MediaRecorder` starting before its data handler existed, so the one droppable
chunk was the one carrying the container header; and auto-naming firing
mid-transcription, stamping a confidently wrong title on exactly the notes whose
content was least certain.

**Two whole-wave findings no single unit could see**, because each unit was built
in isolation: a note ending on a typed page emitted no event at all, so the note
that most needed auto-naming never got it until a restart; and the naming and
transcription queues each issued a local model call with nothing serialising them,
against the invariant stated in the transcription queue's own header.

**Smart search never read audio transcripts** — four of five sources — while the
unit's own report claimed all five. That is how a gap survives a review.

**Twelve tests that could not fail.** Three were found by re-running a claimed
mutation by hand and finding it undetected; the rest were self-caught by
implementers doing the same to their own work and disclosing it. The worst were
*named* for the constraint they did not check: one asserted `not.toContain` against
an array that starts empty; another claimed to prove the phase's sharpest
constraint while only demonstrating that two keys in a key-value store do not
collide.

**Fifteen defects in the spec and plans themselves**, including a test framework
the repo does not use, an invented test harness, a synchronous throw from a
Promise-typed function, and — the structural one — no task owning the question
*"who already consumes what this changes the meaning of"*, which is how a
transcript-destroying bug reached the final review.

## Open product questions for the owner

None blocking; each is a unit's own documented assumption, not an oversight.

- The AND/OR tag filter defaults to **OR**, and filter state is not persisted
  across reloads (K37 left both unstated; S5-A1/A2).
- Typing requires an active note, so starting a note by typing alone is two clicks —
  New note, then Type page (S4-A1).
- A bare pen-started note (active note, no locked session) shows no
  writing-destination banner, and a test pins that. Writing genuinely is going
  there; K16 sits under the Lock heading, so the narrow reading is defensible.
- The first launch after this ships names the entire back catalogue, since every
  pre-Phase-3 note has `summary === null`. That is what was asked for, but it runs
  with no progress indication.
- Search loses its query and results on a tab switch, so the search → open a
  candidate → come back → check the next workflow means retyping and paying for the
  model calls again. The fix is to lift that state into `AppShell`; declined late in
  the run as a convenience rather than a correctness problem, against ~24 existing
  test call sites (S6-A9).

## Known limitations, recorded deliberately

- **An audio search hit selects the right recording and names its segment in a
  hint, rather than seeking the player.** `RecordingDetail`'s `<audio>` is private
  to a third file. The recordings view has had clickable segment timestamps since
  Phase 2, so the segment is one click away.
- **`PageRecord.devicePageNum` is constant across a streaming session's pages.** It
  follows from the pad not committing pages to ROM while streaming. No consumer
  reads it for logic.
- **`stitchRecordingChunks` sorts in memory**, because `by-recording` indexes
  `recordingId` alone. Deliberate at lecture lengths (~5,400 rows for 90 minutes); a
  later phase can add a compound index in a v5 block. Note the per-phase rule: no
  Wave 2 or 3 unit could bump `DB_VERSION`, but a new phase may.
- **`listAllPageText` still reads full page rows** and only omits `strokes` from its
  projection. Disclosed in its own doc comment.
- **A recovered recording's duration is estimated** from chunk count × timeslice.
- **Recovery's chunk-count read sits between the stitch and the finalize**, widening
  a pre-existing double-finalize window by one database read. Unreachable today —
  recovery runs once at startup, before any recorder is live. **If you ever build
  multi-tab recovery, reorder those two lines first.**
- **Smart search's relevance quality is unverified against real Gemma**, and nothing
  anywhere exercises a real Ollama call; every model test uses a fake that runs the
  real validator.
- Inherited and still open from Phase 2, none touched here: the swallowed
  device-reconnect error (`architecture.md` §7), the 15-minute audio stall timeout,
  and two-column PDF date assembly.

## Decisions settled, so they are not re-litigated

- A session may hold **several recordings** (K12), which is why K45 exists.
- Schema v4 is additive only; every new field is optional with a documented
  absent-reading, so the upgrade needs no data migration.
- `triage.lookaheadDays` is **not** the agenda horizon. It controls how far ahead a
  deadline becomes a task; reusing it would have changed task generation as a side
  effect of changing a view.
- Smart search was chosen over embeddings (a second model to install plus a third
  background queue) and over keyword-prefilter-then-rerank (nothing to rerank when
  the query shares no words with the note).
- A typed page's text lives in the page's existing `transcript` field, so no
  consumer needs to learn about a second text path. A blank typed page has no
  transcript at all, so search and gap analysis skip it.
- Model output is untrusted input: capped, degenerate-rejected, and parsed through
  `src/llm/ollamaText.ts`'s existing salvage/repair rather than any second path.

## How this session was run, if you want the same again

Interview with batched questions → spec → a sequential foundations wave fixing the
shared data model and UI mount points → parallel units, one orchestrator each in
its own worktree, each running spec → plan → TDD → a pre-merge review per unit, a
whole-branch review per wave, then sequential merges verified before and after.
Search last, because it needs what auto-naming produces.

What mattered most, in order:

- **Re-run every mutation check yourself.** The single highest-value question to ask
  of any passing test is "would this still pass against a broken implementation?"
  Three of this phase's worst defects were found exactly that way, in work whose
  report said it was fine.
- **Treat a test's name as a claim to verify, not as coverage.** The most dangerous
  tests here were the ones named for the constraint they could not check.
- **Fix the shared data model and the shared mount points first.** Four units ended
  up adding to the same view and the merges cost one import line and one additive
  test block each, because each added to a named slot rather than editing shared
  JSX. Also: check brace balance after any union-merge of test files — git silently
  dropped a closing `});` at two different junctions.
- **Ask who already consumes what you are changing the meaning of.** Its absence
  from the plan is what let a changed return value break three untouched call sites.
- **Let a unit report an undetected mutation rather than chase it.** Every unit did
  so at least once, and that honesty is why their diffs could be trusted on sight.
  One unit tried an instructed fix, proved empirically it could not work, documented
  the negative result, and took a different approach — which is the behaviour to
  reward.
