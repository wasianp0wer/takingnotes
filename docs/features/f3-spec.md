# F3 — Triage center: feature spec

Branch `notes/f3-triage`. Implements F3 of `docs/spec.md` (decisions I7–I9,
assumptions A14–A16) against the contracts in `docs/architecture.md` §2.2,
§2.4, §2.5 and §3.4. Owned paths: `src/triage/**` only.

## What the user gets

One Triage tab with three areas that sit side by side on wide screens and stack
on narrow ones:

1. **Tasks** — every open task, sorted by priority score (highest first), each
   showing its score, a required/optional toggle, an editable estimate in
   minutes, its due date, and Done / Dismiss actions. A small form adds a
   manual task (title, optional due date and time, required, estimate).
2. **Calendar** — a month grid (previous/next month, today highlighted, a dot
   per day that has events; deadlines and ordinary events look different) and
   an agenda listing today and the next 7 days. Clicking a day opens the
   create-event dialog prefilled with that date; clicking an agenda item opens
   the edit dialog. The dialog edits title, kind (deadline/event), date, time
   or all-day, required, estimated minutes and notes, and can delete.
3. **Scratchpad** — a plain textarea saved automatically (~500 ms after typing
   stops, and on unmount). "Promote line to task" turns the line under the
   cursor into a task with `source: 'scratchpad'` and removes that line.

## Modules (`src/triage/`)

| File | Responsibility |
|------|----------------|
| `dates.ts` | Local-time day math: `startOfLocalDay`, `endOfLocalDay`, `addLocalDays`, `isSameLocalDay`, `monthGrid`, date/time `<input>` value conversion. |
| `priority.ts` | `priorityScore(task, now)` (I7 formula, exactly) and `rankTasks(tasks, now)`. |
| `generateTasks.ts` | Pure `planTaskSync(events, tasks, now, lookaheadDays)`, `dueAtForEvent(event)`, and `syncTasksFromCalendar(now)` which applies a plan through the repositories, serialized. |
| `taskActions.ts` | `completeTask(id, now)` (sets `completedAt`), `dismissTask(id)`, `reopenTask` is out of scope. |
| `format.ts` | Deterministic due-date and minute labels for the UI. |
| `eventForm.ts` | Pure conversion/validation between the event dialog's form state and `CreateEventInput`. |
| `scratchpadLines.ts` | Pure `lineAtCursor`, `removeLineAt`, `taskTitleFromLine`. |
| `useTriageData.ts` | Loads tasks and events, syncs on mount / window focus / every 60 s / after event mutations; exposes mutations. |
| `useScratchpad.ts` | Loads `triage.scratchpad`, debounced autosave, flush on unmount. |
| `useNow.ts` | A `now` that ticks every 60 s so scores and labels stay current. |
| `TaskList.tsx`, `CalendarPanel.tsx`, `EventDialog.tsx`, `Scratchpad.tsx` | Thin components. |
| `TriageView.tsx` | Replaces the placeholder body; keeps the `TriageView` export. |

## Rules

### Priority (I7)

```
h = (dueAt - now) / 3.6e6            d = estimatedMinutes / 60
slack   = h - d
urgency = slack >= 0 ? 1 / (1 + slack / 24) : 1 + min(-slack / 24, 1)
weight  = required ? 1.0 : 0.5
score   = round(100 * weight * urgency)
```

No due date → urgency 0.1. An estimate that is not a finite number ≥ 0 counts
as 60 minutes (A14). The score is never stored.

`rankTasks` sorts by score descending, then due date ascending (no due date
last), then `createdAt` ascending, then id — a total order, so the list never
jitters between renders.

### Task sync (I8, A15, A16)

- `dueAtForEvent(event)` = `allDay ? endOfLocalDay(startsAt) : startsAt`.
- Window = `[startOfLocalDay(now), addLocalDays(startOfLocalDay(now), lookaheadDays)]`,
  both ends inclusive.
- Only `kind === 'deadline'` events generate tasks.
- A deadline event with **no** task of any status whose `eventId` is its id
  gets one new task iff its due moment is inside the window. The task copies
  `title`, `required`, `estimatedMinutes`; `dueAt = dueAtForEvent(event)`;
  `source: 'calendar'`; `status: 'open'`.
- Done or dismissed tasks are never re-created and never modified.
- For an event that has an open task: if the task's `title` or `dueAt`
  differs from the event's, update exactly those two fields. `required` and
  `estimatedMinutes` on the task are never touched after creation (A16). This
  applies even when the edited due date is outside the window.
- An open calendar task whose event no longer exists is dismissed.
- An open calendar task whose event is now `kind: 'event'` is dismissed.
- If an event somehow has more than one open task, the oldest (`createdAt`,
  then id) is kept and the rest are dismissed.
- Manual and scratchpad tasks are never touched by the sync.
- Idempotence: applying a plan and planning again yields an empty plan.
- `syncTasksFromCalendar` reads `triage.lookaheadDays` (invalid → 7, negative →
  0, fractional → floored) and serializes calls, so overlapping triggers
  (mount, focus, interval, StrictMode double mount) never create duplicates.

### Done / dismiss

Marking done sets `status: 'done'` and `completedAt = now`. Dismissing sets
`status: 'dismissed'` and leaves `completedAt` null. Both disappear from the
list.

## Tests to write

**`dates.test.ts`**
1. `startOfLocalDay` returns local midnight of the same day (from 00:00, noon, 23:59:59.999).
2. `endOfLocalDay` returns 23:59:59.999 local of the same day.
3. `addLocalDays` keeps the wall-clock time, crosses month and year ends, accepts negative n.
4. `isSameLocalDay` true within a day, false across midnight.
5. DST (run under `TZ=America/New_York` set in the test): 2026-03-08 is 23 h long; `addLocalDays` over it keeps 12:00; `endOfLocalDay - startOfLocalDay` = 23 h − 1 ms; November 1 2026 is 25 h.
6. `monthGrid(2026, 8)` (September 2026): weeks start Sunday, first cell is Aug 30, last cell is Oct 3, 5 rows × 7; every cell is a local midnight; `monthGrid(2026, 1)` (Feb 2026, starts on Sunday) has 4 rows.
7. `toDateInputValue` / `toTimeInputValue` round-trip with `fromDateInputs` (date + time, date only → end of day option, invalid → null).

**`priority.test.ts`**
1. Reference values: required/48h/2h → 34; required/12h/8h → 86; optional/12h/1h → 34; required/2h/4h → 108.
2. Zero slack → 100 (required), 50 (optional).
3. Slack exactly −24 h → 200; slack −48 h → 200 (cap); slack −23 h → 196.
4. No due date → 10 (required), 5 (optional).
5. Unset/invalid estimate (NaN, negative) treated as 60 minutes; estimate 0 respected.
6. Overdue past its due moment with zero estimate uses the boost (dueAt 12 h ago, estimate 0 → 150).
7. `rankTasks` ordering: score desc; ties by dueAt asc with null last; then createdAt; then id.

**`generateTasks.test.ts`** (planner, pure)
1. `dueAtForEvent`: timed → `startsAt`; all-day → end of that local day.
2. Deadline inside window with no task → one create with copied fields.
3. `event`-kind never creates.
4. Deadline before today → no create; deadline earlier today (already passed) → create.
5. Window edges: exactly start of today → create; exactly start + lookahead → create; 1 ms later → none; 1 ms before start of today → none; a lookahead of 3 excludes a deadline 5 days out that 7 would include.
6. All-day deadline on the last day inside the window boundary rules (end-of-day due moment).
7. Existing open task with same title/dueAt → no-op (idempotent).
8. Existing done task → no create, no update. Existing dismissed task → same.
9. Edited title → update `{title}`+`{dueAt}` patch contains only those keys; `required`/`estimatedMinutes` untouched even if event defaults changed.
10. Edited due moved outside window → still updates the open task.
11. Deleted event → open calendar task dismissed; done/dismissed ones left alone.
12. Event changed to `event` kind → its open task dismissed.
13. Duplicate open tasks for one event → oldest kept, others dismissed.
14. Manual and scratchpad tasks untouched (even with an `eventId` matching nothing).
15. Idempotence property: apply plan in memory, replan → empty plan, across a mixed fixture.
16. Plan does not mutate its inputs.

**`generateTasks.sync.test.ts`** (with fake-indexeddb)
1. `syncTasksFromCalendar` creates tasks for a stored deadline, and a second run creates nothing.
2. Honors the stored `triage.lookaheadDays`.
3. Two concurrent calls create exactly one task.
4. Updating and deleting events flows through to the stored tasks.

**`taskActions.test.ts`**
1. `completeTask` sets status done and `completedAt`; `dismissTask` sets dismissed and leaves `completedAt` null.

**`format.test.ts`**, **`eventForm.test.ts`**, **`scratchpadLines.test.ts`**
- Due labels: no due, today with time, end-of-day (no time), tomorrow, other days, overdue.
- Event form: record → form → input round-trip; all-day handling; empty title and bad date rejected; estimate parsing.
- Line at cursor: first, middle, last line, empty text, cursor at line end; removing a line keeps the rest; bullet/checkbox prefixes stripped from the title.

**Hooks and components** (createRoot + act + fake-indexeddb, per `src/app/DeviceStatus.test.tsx`)
1. `useScratchpad`: loads the stored value; saves once after the debounce, not per keystroke; flushes pending text on unmount.
2. `useTriageData`: syncs on mount (a stored deadline appears as a task); re-syncs on window `focus`; re-syncs after `saveEvent`/`removeEvent`.
3. `TaskList`: renders tasks in score order with score badges; Done/Dismiss/required toggle/estimate call the right handlers; add-task form creates a manual task and rejects an empty title.
4. `CalendarPanel`: month grid marks days with events; agenda shows today..today+7 and nothing beyond; month navigation.
5. `EventDialog`: create saves the form; edit prefills; delete calls remove.
6. `Scratchpad`: typing updates, promote turns the cursor line into a `scratchpad` task and removes it.
7. `TriageView`: renders the three areas.

## Assumptions

Made without asking; each can be revisited.

- F3-1 The window's upper bound is inclusive and is **start of day** of
  today + `lookaheadDays` (as briefed). With the default 7, a deadline due at
  any time on days 0–6 is generated, plus one due exactly at midnight starting
  day 7; later deadlines on day 7 appear when the next day's window opens.
- F3-2 A deadline that already passed **earlier today** is generated (A15
  only excludes deadlines before today); it shows with the overdue boost.
- F3-3 An event switched from `deadline` to `event` dismisses its open task,
  exactly like deletion; switching back does not re-create it (a dismissed task
  blocks re-creation).
- F3-4 Duplicate open tasks for one event (only possible through a past race)
  are repaired by keeping the oldest and dismissing the rest.
- F3-5 An estimate that is not a finite number ≥ 0 is scored as 60 minutes;
  an explicit 0 is respected.
- F3-6 Promoting a scratchpad line moves it: the line is removed from the
  scratchpad and leading list markers (`-`, `*`, `•`, `1.`, `[ ]`, `- [ ]`)
  are stripped from the task title. A blank line promotes nothing. Promoted
  tasks are required, 60 min, no due date.
- F3-7 Done and dismissed tasks are hidden; there is no undo/reopen UI in F3.
- F3-8 `triage.lookaheadDays` has no settings UI in F3 (it would require
  editing `src/app/SettingsDialog.tsx`, which F3 does not own); the stored
  value is honored if present.
- F3-9 Weeks in the month grid start on Sunday; the grid shows only the weeks
  that contain a day of the month (4–6 rows). Labels use a fixed 24 h
  `HH:mm` format so tests are locale-independent.
- F3-10 Manual tasks with a date but no time are due at the end of that local
  day, matching all-day events.
- F3-11 Event time without an end: `endsAt` stays null; F3 does not edit event
  duration.
- F3-12 One line outside F3's owned paths had to change:
  `src/app/AppShell.test.tsx`'s "switches tabs" test asserted the retired
  placeholder string "Triage arrives with F3". It now asserts that the three
  `section[aria-label]` landmarks of the real view render. No non-test file
  outside `src/triage/**` was touched.
- F3-13 `CalendarPanel` seeds its visible month from `now` once at mount and
  does not re-sync if `now` ticks past a month boundary while the panel stays
  open; the `Today` button recovers it. Today's ring still lands on the right
  day because it is computed from the live `now`.
- F3-14 No form on this tab loses the user's typing when a write fails. The
  scratchpad's promote, the add-task form and the event dialog all opt into
  `useTriageData`'s `{ rethrow: true }`, so a failed write keeps the text,
  keeps the dialog open, and reports the failure in place. `TriageView`'s
  `role="alert"` banner still shows `data.error` as well, so a failed save is
  reported on both surfaces — deliberate, since the banner is the only signal
  for mutations that have no form (Done, Dismiss, the inline edits).
- F3-15 A failed scratchpad autosave is reported where the "Saved
  automatically." hint sits, and the text stays in the box and is retried; the
  copy tells the user to take their own copy, because the retry can fail too.
- F3-16 The sync's look-ahead window ends at **start of day** of
  today + `lookaheadDays` (F3-1, as briefed), while the agenda covers today
  through today + 7 **inclusive**. A deadline at, say, 10:00 on day 7 is
  therefore visible in the agenda with its Deadline badge but generates no
  task until the next day's window opens. Kept deliberately rather than
  widened, because F3-1's bound was briefed and two boundary tests pin it.
  If it should be aligned, the change is
  `windowEnd = endOfLocalDay(addLocalDays(windowStart, lookahead))` plus those
  two tests and this assumption. The same bound makes a stored
  `lookaheadDays: 0` mean "only a deadline at exactly 00:00 today", which no
  UI can currently set (F3-8).
- F3-17 `syncTasksFromCalendar` reads a task's status and later writes it, so
  a task the user marks done inside that window can be recorded `dismissed`
  instead. Accepted **only while F3-7 holds**: done and dismissed tasks are
  both simply hidden, so the user sees no difference and no text is lost. This
  expires the moment a completed-tasks view, an undo, or any reporting on
  `completedAt` arrives — at which point `runSync` must re-read the record and
  skip the dismiss unless it is still `open`.

## Notes for the merger

F3 merges last, after F1, F2 and F4.

1. **Highest risk: `src/components/ui/select.tsx` and `src/components/ui/label.tsx`
   become F3-only once F1 lands.** Outside `src/triage/**`, `ui/select` is
   imported only by `src/components/ExportDialog.tsx` and `ui/label` only by
   `ExportDialog.tsx`, `CanvasSettingsPanel.tsx` and `ToolSettingsPanel.tsx` —
   all studio files F1 deletes. If F1 also prunes "now-unused" UI primitives or
   drops `@radix-ui/react-select` / `@radix-ui/react-label` from
   `package.json`, F3's `EventDialog` and `TaskList` stop compiling. Verify
   both files and both dependencies survive before calling the merge green.
2. **`src/app/AppShell.test.tsx` is the one file F3 shares.** F3 changed a
   single assertion in the `switches tabs` test (the Phase-0 placeholder string
   it matched is what F3 was asked to remove) to three per-landmark
   `section[aria-label]` checks. Expect a trivial conflict; keep F3's version.
   That test now mounts the real `TriageView`, so it drives IndexedDB in a file
   with no `resetDatabase` in `beforeEach` — safe under Vitest's per-file
   isolation, but if it starts failing after the merge look at `src/storage`,
   not at the assertion.
3. **`src/triage/testing.ts`** is F3's private `createRoot` + `act` harness and
   **`src/triage/estimate.ts`** its shared estimate parser. F1/F2/F4 very
   likely wrote near-identical test harnesses; consolidating into `src/test/`
   is worth doing after the merge, not as part of it.
4. **F3 assumes nothing about `src/app/**` beyond the mount point.**
   `TriageView` keeps its export, imports nothing from `src/app`, and F3-8
   deliberately ships no `triage.lookaheadDays` settings UI so that
   `SettingsDialog.tsx` stays untouched.
5. **`src/triage/dates.dst.test.ts` sets `process.env.TZ` process-wide** in
   `beforeAll` and restores it in `afterAll` (verified portable under
   `TZ=UTC`). Safe under per-file isolation; it is the test that would flake if
   in-worker parallelism across files is ever enabled.
6. **`TaskList`, `EventDialog` and `Scratchpad` depend on their caller opting
   into `{ rethrow: true }`.** `TriageView` does, and two integration tests pin
   that wiring, but the prop types cannot enforce it: a second view that mounts
   one of these components and passes a bare `data.addTask` / `data.saveEvent`
   would compile and silently go back to losing the user's typing on a failed
   write. Each prop says so in its doc comment — keep it that way if another
   caller ever appears.
