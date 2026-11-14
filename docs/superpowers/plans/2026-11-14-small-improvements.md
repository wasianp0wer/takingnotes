# Small improvements (2026-11-14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight UI and behaviour improvements across the Sessions view, Triage and Settings, per the approved design.

**Architecture:** Mostly local component changes. Two data rules are enforced by idempotent sweeps, not schema upgrades: a dated task always has a linked deadline (`src/triage/taskDeadlines.ts`, run at the start of every task sync), and every note has a session (`src/sessions/assignSessions.ts`, run at start-up after the legacy migration). No `DB_VERSION` bump and no new dependencies.

**Tech Stack:** React 19 + TypeScript, Vite, Vitest + Testing Library on happy-dom, IndexedDB via `idb`, Radix primitives in `src/components/ui`, lucide-react icons, Tailwind with theme tokens.

**Spec:** `docs/superpowers/specs/2026-11-14-small-improvements-design.md`

## Global Constraints

- TDD: every unit of work starts with a failing test that has been run and seen to fail for the expected reason.
- House style: single quotes, width 100, no Prettier run. Theme tokens only; the colour guard test fails on hard-coded colours. Square corners, hover-only outlines, `focus-visible` rings.
- No `DB_VERSION` change. No new npm dependency (the lockfile must not change).
- Tests that touch `localStorage` stub a Map-backed Storage (Node 25 shadows happy-dom's).
- `PageTurnControls` must stay mounted (architecture §4).
- Verification: `npm test`, `npx tsc -b`, `npm run lint` (0 errors), `npm run build`. If tests time out, check `uptime`; under heavy load, re-run before believing a failure.
- Each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model that wrote it).

## Review Focus

1. **A recording with no stored length** (`audio.duration === Infinity`, typical for MediaRecorder WebM) must still scrub across its whole length using `recording.durationMs`. Pinned in Task 1.
2. **A seek requested before the audio is ready** (search hit, transcript timestamp) must still land once the player exists, as it does today. Pinned in Task 1.
3. **The start-up session sweep running twice at once** (StrictMode double mount, or a second tab) must not give a note two sessions. Pinned in Task 6.
4. **The task sweep running on every sync** must never make a second deadline for a task, and must leave done or dismissed tasks alone. Pinned in Task 3.
5. **Ending the session while "Record audio for this session?" is open** must close the prompt and never start the recorder. Pinned in Task 7.

## Task graph

| Task | Files (main ones) | Depends on | Parallel-safe with |
|---|---|---|---|
| 1 Recording player | `src/recordings/RecordingPlayer.tsx` (new), `RecordingDetail.tsx` | none | 3, 5, 6, 7, 8 |
| 2 Pinned player and find bar | `RecordingDetail.tsx`, `src/sessions/AudioHalf.tsx`, `src/notes/TranscriptFind.tsx`, `src/notes/TranscriptPanel.tsx` | 1 | 4, 5, 6, 7, 8 |
| 3 Dated tasks are deadlines | `src/triage/taskDeadlines.ts` (new), `useTriageData.ts`, `generateTasks.ts` | none | 1, 5, 6, 7, 8 |
| 4 Inline task editing | `src/triage/TaskList.tsx` | 3 | 2, 5, 6, 7, 8 |
| 5 Calendar day panel, 21:00 default | `src/triage/CalendarPanel.tsx`, `src/triage/DayEventsDialog.tsx` (new), `eventForm.ts` | none | all |
| 6 Every note in a session | `src/capture/engine.ts`, `src/sessions/assignSessions.ts` (new), `src/app/AppShell.tsx` | none | 1, 3, 5, 7, 8 |
| 7 Start session asks before recording | `src/capture/SessionControls.tsx` | none | 1, 3, 5, 6, 8 |
| 8 Notes-half icon row | `src/notes/NoteToolbar.tsx`, `src/sessions/NotesHalf.tsx`, `src/capture/PageTurnControls.tsx` | none | 1, 3, 5, 6, 7 |
| 9 Settings tabs | `src/app/SettingsDialog.tsx` | none | all |

Each task's own test files sit beside its source files and count as part of its file list. Run the tasks in waves of at most four parallel worktrees, because the machine is often heavily loaded: **Wave 1:** 1, 3, 5, 9. **Wave 2:** 6, 7, 8. **Wave 3:** 2, 4. Merge back one task at a time and run the full suite after each merge.

---

### Task 1: Custom recording player

**Files:**
- Create: `src/recordings/RecordingPlayer.tsx`, `src/recordings/RecordingPlayer.test.tsx`
- Modify: `src/recordings/RecordingDetail.tsx` (the `<audio controls>` block at ~line 311), `src/recordings/RecordingDetail.test.tsx`

**Interfaces:**
- Produces: `RecordingPlayer` with props `{ src: string; durationMs: number; audioRef: RefObject<HTMLAudioElement | null>; onDownload?: () => void }`. It renders the `<audio>` element itself (no `controls` attribute) and attaches `audioRef` to it. `RecordingDetail` keeps owning `audioRef` and `seekTo`, so seeking is unchanged.
- Exported helper `effectiveDurationMs(audioDuration: number, storedMs: number): number` returns `audioDuration * 1000` when it is finite and greater than 0, and `storedMs` otherwise.

- [ ] **Step 1: Write failing tests** in `RecordingPlayer.test.tsx`:
  - `effectiveDurationMs(Infinity, 90_000)` is `90_000`; `effectiveDurationMs(NaN, 90_000)` is `90_000`; `effectiveDurationMs(120, 90_000)` is `120_000`.
  - The player renders a button named `Play`; clicking it calls `play()` on the audio element (stub `HTMLMediaElement.prototype.play`), and after a `play` event the button is named `Pause`.
  - The scrub bar is a `slider` named `Seek`. With `durationMs={90_000}` and the element's `duration` left at its default, `aria-valuemax` reflects 90 s. Setting it to 45 s sets `audio.currentTime` to `45`.
  - `Back 15 seconds` from `currentTime = 10` sets it to `0` (clamped). `Forward 15 seconds` from `80` with 90 s total sets it to `90` (clamped).
  - Time readout: after a `timeupdate` with `currentTime = 65`, the text `1:05 / 1:30` is shown (use `formatClock` from `@/audio/format`).
  - A control named `Playback speed` cycles 1× → 1.25× → 1.5× → 2× → 0.75× → 1× and sets `playbackRate` each time.
  - The rendered `<audio>` has no `controls` attribute.
- [ ] **Step 2: Run** `npx vitest run src/recordings/RecordingPlayer.test.tsx`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `RecordingPlayer`.** Use the existing `Slider` (`src/components/ui/slider.tsx`) for scrubbing and ghost icon `Button`s with lucide `Play`, `Pause`, `RotateCcw`, `RotateCw`. Read the time from the element's `timeupdate`, `play`, `pause`, `loadedmetadata` and `durationchange` events. Show Download audio as an icon button with the label "Download audio" when `onDownload` is given.
- [ ] **Step 4: Run** the player tests. Expected: PASS.
- [ ] **Step 5: Swap it into `RecordingDetail`.** First add failing tests to `RecordingDetail.test.tsx`:
  - The detail renders a `Seek` slider and no `audio[controls]`.
  - **Review Focus 2:** a `seek` prop given before the audio URL resolves still sets `currentTime` once the player mounts. Keep or adapt the existing seek tests so they assert this.
  - Clicking a transcript timestamp still seeks the element.
  - Download audio still works through the player's button.

  Then replace the `<audio ref={audioRef} controls …>` and the Download button with `<RecordingPlayer src={audioUrl} durationMs={totalMs or recording.durationMs} audioRef={audioRef} onDownload={download} />`.
- [ ] **Step 6: Run** `npx vitest run src/recordings src/sessions/AudioHalf.test.tsx`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(recordings): custom player that seeks across the whole recording`.

### Task 2: Pinned player and find bar

**Files:**
- Modify: `src/recordings/RecordingDetail.tsx`, `src/sessions/AudioHalf.tsx`, `src/notes/TranscriptFind.tsx`, `src/notes/TranscriptPanel.tsx`, and their tests.

**Interfaces:**
- Consumes: `RecordingPlayer` from Task 1.
- `FindableTranscript` gains a way to render its bar outside the scrolling content. Recommended: a `bar` render slot, or splitting it into a `useTranscriptFind()` hook plus a `TranscriptFindBar` component, so the bar sits above the scroller and the shortcut wrapper wraps both. Cmd/Ctrl+F still opens it only while focus is inside the transcript area, and Escape still closes it without closing an enclosing dialog.

- [ ] **Step 1: Write failing tests:**
  - `AudioHalf`/`RecordingDetail`: the player (`Seek` slider) is **not** inside the element that scrolls (the `overflow-auto` container); the transcript list is inside it. Assert with DOM containment: find the scroll container by a `data-audio-scroll` attribute.
  - With the find bar opened by Cmd+F on the audio transcript, the `role="search"` bar is outside `[data-audio-scroll]`.
  - In `TranscriptPanel`, the opened bar is outside `[data-transcript-text]` (it is today; keep it so) and renders above it.
  - The existing `TranscriptFind` tests (matching, step, Escape, focus return) still pass unchanged or are adapted only for the new structure.
- [ ] **Step 2: Run** them. Expected: FAIL on the containment assertions.
- [ ] **Step 3: Restructure.** In `AudioHalf`, the outer `overflow-auto` wrapper goes away. `RecordingDetail` lays out as a column: the header (title, status), the player and the find bar are `shrink-0`; the transcript region is `min-h-0 flex-1 overflow-auto` and carries `data-audio-scroll`. The transcription status lines (queued, progress) stay above the scroller.
- [ ] **Step 4: Run** `npx vitest run src/recordings src/sessions src/notes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): keep the player and find bar pinned above the transcript`.

### Task 3: Dated tasks are deadlines

**Files:**
- Create: `src/triage/taskDeadlines.ts`, `src/triage/taskDeadlines.test.ts`
- Modify: `src/triage/useTriageData.ts` (`addTask`, `patchTask`), `src/triage/generateTasks.ts` (`runSync`), tests beside each.

**Interfaces:**
- Produces, all in `taskDeadlines.ts`:
  - `eventScheduleForDueAt(dueAt: number): { startsAt: number; allDay: boolean }`. If `dueAt === endOfLocalDay(dueAt)`, it is all-day: `startsAt = startOfLocalDay(dueAt)`, `allDay = true`. Otherwise `startsAt = dueAt`, `allDay = false`. So `dueAtForEvent` of the result always equals `dueAt`.
  - `addTaskWithDeadline(input: CreateTaskInput): Promise<TaskRecord>`. With `dueAt == null` it is a plain `createTask(input)`. Otherwise it creates a `deadline` event (`source: 'manual'`, the task's title, `required`, `estimatedMinutes`, and `notes: ''`), then the task with `source: 'calendar'` and that `eventId`, and the same `dueAt`. Both writes go in **one** IndexedDB transaction over `events` and `tasks`, so a failure leaves neither.
  - `updateTaskSchedule(id: string, patch: { title?: string; dueAt?: number | null }): Promise<TaskRecord>`. This is the write-through for Task 4:
    - **Linked task:** a title or date change also goes to its event (`title`, plus `startsAt`/`allDay` via `eventScheduleForDueAt`).
    - **Plain task given a date:** creates the deadline and links it, so `source` becomes `'calendar'`.
    - **Linked task cleared to `dueAt: null`:** if the event's `source` is `'manual'`, the event is deleted and the task becomes `source: 'manual'`, `eventId: null`, `dueAt: null`. If the event's source is `'syllabus'`, it throws `Error('A syllabus deadline cannot be cleared')`.
    - One transaction per call.
  - `linkDatedManualTasks(): Promise<number>`. This is the upgrade sweep: every **open** task with `source: 'manual'` and `dueAt !== null` gets a deadline as above and is linked. It returns how many it linked. It is idempotent, because a linked task no longer has `source: 'manual'`.
- `useTriageData.addTask` calls `addTaskWithDeadline`, and `patchTask` routes `title`/`dueAt` patches through `updateTaskSchedule` (other fields still go to `updateTask`). `runSync` awaits `linkDatedManualTasks()` before listing events and tasks.

- [ ] **Step 1: Write failing tests** in `taskDeadlines.test.ts`. Use `fake-indexeddb` as the other storage tests do, with local-time fixtures as in `dates.test.ts`.
  - `eventScheduleForDueAt(endOfLocalDay(d))` is all-day, and its `dueAtForEvent` equals the input. A timed `dueAt` (14:30) round-trips as timed.
  - `addTaskWithDeadline({title:'Essay', dueAt: <date 3 weeks out, 23:59:59.999>})` gives 1 event (`kind: 'deadline'`, `allDay: true`) and 1 task (`source: 'calendar'`, `eventId` = event id).
  - `addTaskWithDeadline` without `dueAt` creates no event.
  - Then `syncTasksFromCalendar(now)` with the default lookahead creates no second task for that event and dismisses nothing (the far-out task stays open).
  - `updateTaskSchedule` covers each case above, including the syllabus throw (and that nothing was written).
  - **Review Focus 4:** `linkDatedManualTasks()` run twice links once (the second call returns 0, and there is one event per task). A `done` manual dated task and a `dismissed` one get no event. An undated manual task gets no event.
- [ ] **Step 2: Run** `npx vitest run src/triage/taskDeadlines.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `taskDeadlines.ts`. Reuse `endOfLocalDay`/`startOfLocalDay` from `dates.ts` and the record shapes `createEvent`/`createTask` build. Do not add a second record-building path that could drift: extract a pure builder from each storage module if the transaction needs one.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Wire it in.** Add failing tests to `useTriageData.test.tsx`: `addTask` with a date yields an event in `events`, and `patchTask(id, {dueAt})` on a linked task moves its event. Then add a test to `generateTasks.sync.test.ts` that a pre-existing manual dated task is linked after one sync. Implement the wiring.
- [ ] **Step 6: Run** `npx vitest run src/triage`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(triage): a dated task is a calendar deadline`.

### Task 4: Inline task editing

**Files:**
- Modify: `src/triage/TaskList.tsx` (`TaskRow`), `src/triage/TaskList.test.tsx`

**Interfaces:**
- Consumes: `onPatch(id, { title?, dueAt? })`, which already exists in `TaskListProps` and is routed by Task 3 through `updateTaskSchedule`.
- `TaskRow` needs to know whether a task's deadline came from a syllabus, to hide the clear option. Add `syllabusEventIds?: ReadonlySet<string>` to `TaskListProps`; `TriageView` passes the ids of events whose `source === 'syllabus'`. `TriageView.tsx` is a modify too.

- [ ] **Step 1: Write failing tests:**
  - Clicking a task's title shows an input named `Task title` holding the title. Typing a new title and pressing Enter calls `onPatch(id, { title: 'New' })`. Blur saves the same way. Escape restores the old title and calls nothing. An empty title is not saved, and the old one is restored.
  - Clicking the due date shows date and time inputs (`Due date`, `Due time`). Changing the date and pressing Enter calls `onPatch` with the date at the time given. With no time, it is `endOfLocalDay` of the date, matching the add form.
  - An undated task shows an `Add due date` control that opens the same editor.
  - A `Clear due date` button calls `onPatch(id, { dueAt: null })`. It is absent when the task's `eventId` is in `syllabusEventIds`.
  - If `onPatch` rejects, the editor stays open with the typed value and an inline error, mirroring the add form's wording style.
- [ ] **Step 2: Run** `npx vitest run src/triage/TaskList.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** in `TaskRow`. Reuse the add form's date/time parsing: extract `dueAtFromInputs(date: string, time: string): number | null | 'invalid'` from `AddTaskForm` and use it in both places.
- [ ] **Step 4: Run** `npx vitest run src/triage`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(triage): edit a task's title and due date in place`.

### Task 5: Calendar day panel, 21:00 default

**Files:**
- Create: `src/triage/DayEventsDialog.tsx`, `src/triage/DayEventsDialog.test.tsx`
- Modify: `src/triage/CalendarPanel.tsx` (`openCreate`, day cell `onClick`), `src/triage/eventForm.ts` (`emptyEventForm`), and their tests.

**Interfaces:**
- `DayEventsDialog` props: `{ day: number | null; events: CalendarEventRecord[]; now: number; onClose(): void; onEdit(event: CalendarEventRecord): void; onAdd(day: number): void }`. `day === null` means closed. This is built on the existing `Dialog` (no Popover dependency is installed, and adding one would touch the lockfile).

- [ ] **Step 1: Write failing tests:**
  - `emptyEventForm(day).time === '21:00'`.
  - `DayEventsDialog`: its title is the day label (`formatDayLabel`). It lists only that day's events, in `startsAt` order, each showing its time (or "All day") and title. Clicking one calls `onEdit`. `Add event` calls `onAdd(day)`. An empty day shows `Nothing on this day`.
  - `CalendarPanel`: clicking a day cell opens the day dialog, not the event dialog. From it, `Add event` opens the event dialog in create mode for that day, defaulting to 21:00. Clicking an event opens the event dialog in edit mode. The header's `New event` button still opens create for today directly.
- [ ] **Step 2: Run** `npx vitest run src/triage/eventForm.test.ts src/triage/DayEventsDialog.test.tsx src/triage/CalendarPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extend `DialogState` with `{ mode: 'day'; day: number }`. Opening create or edit from the day dialog replaces it, so only one dialog is open at a time.
- [ ] **Step 4: Run** `npx vitest run src/triage`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(triage): a day click shows that day's events; events default to 21:00`.

### Task 6: Every note in a session

**Files:**
- Create: `src/sessions/assignSessions.ts`, `src/sessions/assignSessions.test.ts`
- Modify: `src/capture/engine.ts` (`openNote`, `startNote`), `src/capture/engine.test.ts` (or the engine test file that covers `startNote`), `src/app/AppShell.tsx` (`useLegacyMigration`)

**Interfaces:**
- `assignSessionsToOrphanNotes(): Promise<number>`. Every note whose `sessionId` is not a string gets `createSession({ title: note.title, startedAt: note.startedAt })`, then `updateSession(id, { status: 'ended', endedAt: note.endedAt ?? note.startedAt })`, then `updateNote(note.id, { sessionId })`. It returns the count. A note that is the engine's active note is skipped. **Concurrency:** a module-level in-flight promise makes overlapping calls share one run. Each note's write is per-note, so a failure partway leaves every finished note consistent. Note creation of the session and the link should be in one transaction if the storage helpers allow it; otherwise create, then link, and on a retry a session with no note is harmless but must not be duplicated for the same note.
- After the sweep links any notes, the Sessions view must refresh. Use whatever change signal the catalog already listens to (`useSessionCatalog`'s reload triggers); if none fits, emit the same signal renames use.
- Engine: `startNote()` behaves exactly as `startSession()` does in the engine. The session title is `Session <stamp>`, and `sessionStartedAt` is set. The `manual` option and the "Note …" prefix go. The engine still never touches the recorder.
- `AppShell.useLegacyMigration` runs `migrateLegacyNotebooks().then(() => assignSessionsToOrphanNotes())`, so a first-start migration's notes are covered on that same start. Errors are logged, as now.

- [ ] **Step 1: Write failing tests:**
  - **Sweep:** a legacy note (`sessionId: null`) and a v1 note (no field) each get a session with the note's title, `startedAt`, `status: 'ended'` and `endedAt`. A note already in a session is untouched. A second run returns 0.
  - **Review Focus 3:** `Promise.all([sweep(), sweep()])` yields exactly one session per orphan note.
  - **Catalog:** after the sweep, `buildSessionCatalog` puts those notes under `sessions`, and `uncategorized` holds only orphan recordings.
  - **Engine:** a pen-started note (`startNote()`) has a title starting `Session ` and publishes `sessionStartedAt`.
  - **Engine (anti-goal):** strokes buffered before the note exists are still written to page 0. Keep the existing test; add one if it does not exist.
- [ ] **Step 2: Run** `npx vitest run src/sessions/assignSessions.test.ts src/capture`. Expected: FAIL.
- [ ] **Step 3: Implement** the sweep, the engine change and the AppShell chaining. Remove now-dead code paths for `manual: false` and update the comments that describe them.
- [ ] **Step 4: Run** `npx vitest run src/sessions src/capture src/app`. Expected: PASS. Fix tests elsewhere that asserted the "Note …" title.
- [ ] **Step 5: Commit** `feat(sessions): every note belongs to a session`.

### Task 7: Start session asks before recording

**Files:**
- Modify: `src/capture/SessionControls.tsx` (`start`, render), `src/capture/SessionControls.test.tsx`

**Interfaces:**
- No new exports. A new local state `recordPrompt: { sessionId: string; noteId: string } | null`.

- [ ] **Step 1: Write failing tests:**
  - After Start session (engine and pad stubs succeed), `recorder.start` has **not** been called, and the panel shows `Record audio for this session?` with buttons `Record` and `Not now`.
  - `Record` calls `recorder.start(ids)` with the session's ids, and the existing ownership and error handling still applies (its existing tests keep passing).
  - `Not now` hides the prompt, and the recorder is never started.
  - If the recorder is already `recording` or `starting` when the pad step finishes, no prompt is shown, and the existing "Audio was already recording…" message is shown.
  - **Review Focus 5:** ending the session while the prompt is open removes the prompt. A `Record` click that races the end (the prompt's ids are no longer the engine's `activeSessionId`) does not start the recorder.
  - A pen-started session (the engine's state changes without Start session) shows no prompt.
- [ ] **Step 2: Run** `npx vitest run src/capture/SessionControls.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the recorder start out of `start()` into the Record handler, keeping its ownership checks verbatim. Keep the existing "session already over" check (`engine.getState().activeSessionId !== ids.sessionId`) before showing the prompt, and again in the Record handler.
- [ ] **Step 4: Run** `npx vitest run src/capture src/app`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(session): ask before recording when a session starts`.

### Task 8: Notes-half icon row

**Files:**
- Modify: `src/notes/NoteToolbar.tsx`, `src/sessions/NotesHalf.tsx`, `src/capture/PageTurnControls.tsx`, and their tests (`NoteToolbar.test.tsx`, `NotesHalf.test.tsx`, PageTurnControls' test if present).

**Interfaces:**
- `NoteToolbarProps` loses `onNewNote`, `onEndNote`, `sessionLocked` and `hasActiveNote`; it keeps page navigation only. The New note and End note buttons are removed outright.
- `PageTurnControls` gains `variant?: 'button' | 'icon'`. In `icon` mode it renders a ghost icon button (lucide `FilePlus`) with `aria-label="New page"` and the existing `title` strings, and it drops its "Page N" status text (the navigation row already shows the page).
- The Type page / Handwrite page button becomes an icon button: `Keyboard` when it would make a typed page, and `PenLine` when it would switch to handwriting. Its `aria-label` and `title` keep today's wording.

- [ ] **Step 1: Write failing tests:**
  - `NotesHalf`: there is no button named `New note` or `End note`. A button named `New page` and the Type page button (by its existing label) are in the same row element as the `Notes view` switch (the switch's closest `[data-notes-controls]` contains both). Both are icon buttons: they contain an `svg` and no visible text.
  - Disabled states are unchanged: `New page` is disabled with no active note, and Type page is disabled while a resume is pending.
  - `PageTurnControls` still mounts exactly once in the app (`AppShell` test, if one asserts it).
- [ ] **Step 2: Run** `npx vitest run src/notes/NoteToolbar.test.tsx src/sessions/NotesHalf.test.tsx src/capture`. Expected: FAIL.
- [ ] **Step 3: Implement.** The row is `flex items-center justify-center gap-2` with the switch, then the icons. Wrap the icons in the existing `Tooltip` primitive, or rely on `title` if the Tooltip pattern is not used for buttons elsewhere; match the codebase.
- [ ] **Step 4: Run** `npx vitest run src/notes src/sessions src/capture`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notes): icon controls beside the Handwriting/Transcription switch`.

### Task 9: Settings tabs

**Files:**
- Modify: `src/app/SettingsDialog.tsx`, `src/app/SettingsDialog.test.tsx`

**Interfaces:** None outside the file. It uses `src/components/ui/tabs.tsx` with `orientation="vertical"`.

- [ ] **Step 1: Write failing tests:**
  - Opening Settings shows a vertical `tablist` with tabs `Theme`, `Transcription`, `Audio` and `Backup`, in that order. `Theme` is selected, and its content is visible.
  - Selecting `Backup` shows the backup section (for example the `Export backup…` button) and hides the theme picker.
  - The tab list is outside the scrolling body (`[data-settings-body]`), and the active panel is inside it.
  - Reopening the dialog starts on `Theme`.
- [ ] **Step 2: Run** `npx vitest run src/app/SettingsDialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Widen the dialog (for example `sm:max-w-3xl`) and keep the viewport cap from commit `567ad3e`. The `Separator`s between sections go.
- [ ] **Step 4: Run** `npx vitest run src/app`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): group settings under tabs on the left`.

---

### Final: integration

- [ ] Full suite, `npx tsc -b`, `npm run lint` and `npm run build` all green on the branch.
- [ ] Screenshot pass in the running app (handoff "To screenshot the app"): the audio half with the player pinned while scrolled, the find bar open, the notes-half icon row, the Triage day dialog, the Settings tabs, and the Start session prompt.
- [ ] A whole-branch review, then fixes.
- [ ] Update `docs/session-handoff.md` with a section for this round.
