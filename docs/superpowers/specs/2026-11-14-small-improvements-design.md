# Small improvements, 2026-11-14 — design

Branch `nov-14-small-improvements`, cut from `main` at `e01e3da`. Its first three
commits are the owner's previously uncommitted work (transcript find bar,
device battery/cancel, settings height cap), committed as-is; this round builds
on them.

## Intent

A round of polish requested by the owner after using the app. Eight changes,
each small on its own. The common thread: the Sessions view should keep its
controls in reach while you read, Triage should stop having two disconnected
ideas of "something due", and the session/note distinction should disappear
from the UI because, in practice, it is already one-to-one.

## Goals

1. **Pinned audio controls and find bar.** In the audio half, the recording's
   player stays fixed at the top while its transcript scrolls beneath it. The
   transcript find bar (`src/notes/TranscriptFind.tsx`) still opens only on
   Cmd/Ctrl+F (owner's choice), but once open it sits pinned above the
   scrolling transcript, not inside it. The same holds in the notes half's
   Transcription view: the bar sits above the bordered transcript box, never
   scrolling with it.
2. **Custom recording player** in the app's visual language, which can seek
   anywhere in the recording.
   - Root cause of "can't skip": recordings are `MediaRecorder` WebM, which
     carries no duration, so the native `<audio controls>` reports
     `duration === Infinity` and its seek bar is unusable.
   - The player: play/pause, a scrub bar across the whole recording (click or
     drag to seek, keyboard arrows step), current time / total time,
     back 15 s / forward 15 s, and a playback speed control (1×, 1.25×, 1.5×,
     2×, 0.75×).
   - Total length: `audio.duration` when finite, otherwise
     `RecordingRecord.durationMs`.
   - Keeps everything the native player is used for today: the `seekTo`
     path used by timestamp clicks and search-hit seeks (`seek` / `onSeekApplied`),
     and Download audio.
   - The `<audio>` element stays, without `controls`, as the engine.
3. **Default event time 21:00** instead of 09:00 (`emptyEventForm` in
   `src/triage/eventForm.ts`).
4. **Dated tasks are deadlines.** Adding a task with a date in the Triage task
   list creates a calendar `deadline` event *and* its linked task
   (`source: 'calendar'`, `eventId` set) at once.
   - The linked task stays visible however far out it is due: task sync must
     not dismiss or withhold a task merely because its deadline lies beyond
     `triage.lookaheadDays`. (Today sync only *creates* inside the window and
     never dismisses for being outside it; keep it that way, and the
     immediate create covers the far-out case.)
   - Editing a linked task's title or due date writes through to its event, so
     the next sync does not revert the edit (sync copies event → task for
     exactly those two fields, A16).
   - Undated tasks, including scratchpad tasks, stay plain tasks with no event.
   - Upgrade: existing open `source: 'manual'` tasks with a `dueAt` each get a
     matching deadline and become linked. Done by the same start-up sweep
     mechanism as goal 7 (idempotent: a linked task is never re-linked).
   - Required and estimate are copied onto the event at creation only; after
     that they stay the task's own, as today (A16). *(Builder's call.)*
   - A date with no time makes an **all-day** deadline, so `dueAt` stays end
     of day, as today; the 21:00 default applies only to the event dialog.
     The upgrade sweep follows the same rule, so no existing due time moves.
     *(Builder's call.)*
   - **Inline editing in the task list (owner: yes, this round).** Click a
     task's title to edit it in place (Enter or blur saves, Escape cancels).
     Click its due date to edit date and time in place.
     - On a linked task, title and date edits write to the event; sync then
       agrees.
     - Adding a date to an undated plain task creates its deadline and links
       it.
     - Clearing the date of a task linked to a *manual* deadline deletes that
       deadline and the task becomes plain. A task linked to a *syllabus*
       deadline cannot have its date cleared (the field offers no clear),
       since re-import would bring the event back. *(Builder's call.)*
     - Runs after the add-form change; both touch `TaskList.tsx`.
5. **Clicking a calendar day shows that day.** A day click opens a small
   panel (popover anchored to the cell) listing that day's events in time
   order. Each entry opens the existing edit dialog; an **Add event** button
   opens the create dialog for that day. An empty day shows "Nothing on this
   day" plus Add event. The header's existing "New event" button is unchanged.
6. **Settings in left-hand tabs.** Vertical tabs: Theme, Transcription, Audio,
   Backup (the four existing sections, unchanged inside). The dialog widens to
   fit; the selected tab's content scrolls, the tab list does not. The tab
   last used is not remembered (opens on Theme).
7. **One note per session, every note in a session.**
   - Remove the **New note** button. Start session (header) is the only way
     to start one by hand; starting to write with the pen still starts one.
   - A pen-started note becomes a full session in the engine and header
     (clock, End session): the engine's `manual` distinction goes, along with
     its "Note …" title prefix (titles become "Session <stamp>"). **It never
     starts audio** (owner): the mic stays off until Record is pressed.
   - **Start session asks before recording** (owner). Start session still
     starts the session and connects the pad, then shows a prompt in the
     session panel, "Record audio for this session?", with **Record** and
     **Not now**. The recorder starts only on Record. Not now leaves the
     session running with no audio (the header Record button still works).
     Ending the session while the prompt is open dismisses it. If a recording
     is already running, no prompt is shown and today's "already recording"
     message stands.
   - **End note leaves the notes half** (owner). The header's End session is
     the only end control, so ending always stops and saves a recording.
   - Start-up sweep: every note with no `sessionId` (legacy and imported
     notes) gets a new session with the note's title, `startedAt` and
     `endedAt`, status `ended`. Runs on every start, so an old backup imported
     later is covered too (backup import skips DB upgrade steps, handoff I2).
     Idempotent and per-note, so a failure partway leaves a consistent state.
   - The Uncategorized group then holds only recordings that belong to no
     note. It keeps its name.
8. **Notes-half controls as icons on one row.** New page and
   Type page / Handwrite page become icon buttons on the same row as the
   Handwriting/Transcription switch. Each has a tooltip and an `aria-label`
   carrying today's wording; disabled states and their explanatory titles are
   unchanged. Page navigation (‹ Page N of M ›) stays on its own row below.
   - `PageTurnControls` must stay mounted (architecture §4); it moves, it is
     not removed. Its "Page N" status text may be dropped from this row if it
     duplicates the navigation row.

## Non-goals

- Always-visible find bar (owner chose Cmd/Ctrl+F only).
- Merging the task and event stores into one record type.
- Changing how syllabus deadlines produce tasks, or the lookahead setting.
- Remembering the settings tab, waveform display, volume control in the
  custom player.
- Migrating orphan recordings (recordings with no note) into sessions.

## Anti-goals

- A seek or timestamp click that silently stops working because the native
  player was replaced. Search hits and transcript timestamps must still seek.
- A task the owner just typed disappearing from the list.
- The start-up sweep running on every start in a way that creates duplicates
  (a second session for a note, a second deadline for a task).
- Losing ink: removing New note must not change what happens when the pen
  touches the pad with no session running.

## Constraints

- TDD, subagent-driven, per the owner's global CLAUDE.md.
- House style: single quotes, width 100; theme tokens only (a guard test
  fails on hard-coded colours); square corners, hover-only outlines,
  `focus-visible` rings.
- No `DB_VERSION` bump (the sweeps are app-level, not schema).
- Tests that touch `localStorage` stub it (Node 25 shadows happy-dom's).
- happy-dom has no CSS Custom Highlight API and no media playback; player
  tests drive `currentTime` / events on the element.

## Approaches considered

- **Dated task → deadline.** (A, chosen) create the deadline and its linked
  task together, write task edits through to the event. (B) create only the
  deadline and let sync make the task — rejected: a task due beyond the
  lookahead vanishes until its window opens.
- **Notes without a session.** (A, chosen) an idempotent sweep on every start.
  (B) a one-time `DB_VERSION` upgrade — rejected: backup import bypasses
  upgrade blocks (I2), so an old backup would reintroduce Uncategorized notes.
- **Sticky controls.** Restructure the audio half so the player and find bar
  live in a fixed header above the scroll area, rather than CSS
  `position: sticky` inside the scroller — the find bar is rendered by the
  wrapper around the transcript, so it needs a way to render above the
  scroller (lift its open state, or a slot), which the builder chooses.
- **Player.** Custom controls over a hidden `<audio>`; a separate audio
  library was not considered worth a dependency.

## Left to the builder

- Icon choices (lucide-react, already used).
- Exact popover component for the day panel (Radix Popover, matching the
  existing Radix primitives).
- How the find bar's open state reaches the pinned area.
- Where the start-up sweeps run (alongside the existing start-up recovery /
  retired-DB work) and their module names.
