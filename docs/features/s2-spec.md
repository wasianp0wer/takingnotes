# S2 — Triage: score colours and a configurable horizon: feature spec

Branch `phase3`, Wave 2 unit S2, built in its own worktree. Implements K22–K25
of `docs/spec-phase3.md` against the triage centre specified in
`docs/features/f3-spec.md` and the contracts in `docs/architecture.md`.
Owned paths: `src/triage/priority.ts`, `src/triage/TaskList.tsx`,
`src/triage/CalendarPanel.tsx`, `src/storage/settingKeys.ts` (one key), plus
each file's own test file.

## What already exists (read from the code)

- `src/triage/priority.ts` exports `priorityScore(task, now)` (the I7
  formula: urgency 0–2 times weight 1.0 required / 0.5 optional, times 100,
  rounded) and `rankTasks`. Scores therefore run **0–200**, not 0–100.
- `src/triage/TaskList.tsx` renders each open task's score in a
  `data-testid="task-score"` chip with classes
  `rounded-md bg-secondary px-1.5 text-xs tabular-nums`, plus, today, a
  special-cased `bg-destructive/15 text-destructive` once the score reaches
  100. Nothing below 100 gets any colour.
- `src/triage/CalendarPanel.tsx` exports `AGENDA_DAYS = 8` ("today plus the
  next 7 days", a hard-coded constant) and uses it inside the private
  `Agenda` component to build exactly 8 candidate days
  (`Array.from({ length: AGENDA_DAYS }, ...)`), filters to the ones with
  events, and renders `"Nothing in the next 7 days."` when none qualify.
- `src/storage/settingKeys.ts` is the one typed registry for every setting
  the UI reads/writes; a new key needs an entry in `SettingValues`, a default
  in `SETTING_DEFAULTS`, and (per `settingKeys.test.ts`) an entry in that
  test's "documents one default per key" assertion.
- `src/triage/generateTasks.ts` reads the *existing* `triage.lookaheadDays`
  setting to decide how far ahead a calendar deadline becomes a task
  (`planTaskSync`'s window). This file and that key are **off limits** (K24):
  a new, separate key is added instead of touching this one.
- The house component-test pattern (`src/triage/testing.ts`): `mount` via
  `createRoot` + `act`, `click`, `typeInto`, `flush`, `waitFor` — no
  `@testing-library/react` anywhere in `src/`.
- `fake-indexeddb/auto` is installed globally in `src/test/setup.ts`, so any
  test file can call `getSettingValue`/`setSettingValue` without special
  setup, but `CalendarPanel.test.tsx` today has no `beforeEach(resetDatabase)`
  — needed once the component reads/writes a real setting, so one test's
  write doesn't leak into the next.
- `src/audio/AudioSettings.tsx` is the house pattern for a component that
  self-manages one setting: load once on mount (guarded by a `loadedRef`
  against a late load clobbering an in-progress edit), commit on blur/Enter,
  never save on every keystroke.

## Decisions implemented

- **K22** The printed score gets a colour band, by absolute value:
  **≥140 red · 100–139 orange · 60–99 amber · 30–59 lime · <30 green.**
  Colour lands on the score text only — the background chip stays neutral,
  and the number itself (the content) is never replaced or hidden by colour.
  An optional task's weight (0.5) caps its score at 100, so it can reach
  amber/lime/green but never orange or red, however overdue — this is the
  deliberately chosen, weighted answer to "how much does this matter right
  now", not an urgency-only band.
- **K23** `CalendarPanel` gains a horizon control for its agenda: presets
  **3 / 7 / 14 / 30 / All**, plus a **Custom…** numeric field, backed by a new
  setting `triage.agendaDays` (default `7`, matching today's behaviour).
- **K24** ⚑ `triage.agendaDays` is a *new* key. `triage.lookaheadDays` and
  `generateTasks.ts` are not read, written, or touched by this unit. A test
  proves `generateTasks.test.ts` and `generateTasks.sync.test.ts` still pass
  untouched.
- **K25** The horizon affects only `CalendarPanel`'s agenda (the day list
  below the month grid), not the month grid itself and not the task list —
  the task list is not filtered by any horizon, today or after this change.

## Behavioural rules

### Score bands (`priority.ts`)

- `scoreBand(score: number): 'red' | 'orange' | 'amber' | 'lime' | 'green'`
  is a pure function over the already-computed integer score. Boundaries are
  absolute and inclusive at the low end of each band: `score >= 140` → red;
  `100 <= score < 140` → orange; `60 <= score < 100` → amber;
  `30 <= score < 60` → lime; `score < 30` → green (covers negative/zero too,
  though `priorityScore` never returns negative).
- `TaskList`'s score chip keeps its neutral `bg-secondary` background and
  adds exactly one `text-*` class chosen by `scoreBand(score)`. The old
  `score >= 100` special case (`bg-destructive/15 text-destructive`) is
  removed — it is superseded by the band, not layered under it.

### Agenda horizon (`CalendarPanel.tsx`)

- `triage.agendaDays: number` (new key in `settingKeys.ts`), default `7`.
  `Number.POSITIVE_INFINITY` is the in-process/stored sentinel for the "All"
  preset — `typeof Infinity === 'number'`, so it round-trips through
  `getSettingValue`'s type guard and through structured-clone storage
  (fake-indexeddb in tests, real IndexedDB in the browser) without a special
  case there.
- `CalendarPanel` self-manages this setting: loads it once on mount
  (`getSettingValue`), writes it on every change (`setSettingValue`),
  following `AudioSettings`'s `loadedRef`/no-per-keystroke-save pattern. No
  other file is touched to wire this through — `TriageView.tsx` and
  `useTriageData.ts` are unchanged.
- Five preset buttons (3, 7, 14, 30, All) plus a "Custom…" toggle that reveals
  a number input. Clicking a preset applies and persists it immediately;
  exactly one control is shown as selected at a time (the matching preset, or
  "Custom…" with its current value, if the stored value is none of the five
  presets).
- The Custom field commits on blur or Enter (not per keystroke), validated by
  a pure, exported `parseAgendaDays(input: string): number | null`:
  - empty string → `null` (rejected)
  - non-numeric → `null`
  - `0` → `null`
  - negative → `null`
  - fractional → floored, then re-checked against the other rules (so `7.9`
    commits as `7`, but `0.5` floors to `0` and is rejected)
  - `> 365` → `null`
  - otherwise the floored integer is returned and applied/persisted.
  An invalid commit shows an inline error, leaves the previously-applied
  horizon in storage and in the UI untouched, and does not clear what the
  user typed (same "don't destroy the only copy of the input" rule the rest
  of this view already follows).
- The agenda's day list is built by a pure, internal `candidateDaysForAgenda`
  helper: for a finite `agendaDays`, exactly the previous behaviour
  (`agendaDays + 1` consecutive local days starting today — `7` reproduces
  the old hard-coded `AGENDA_DAYS = 8`); for the `All` sentinel, every
  distinct local day, from today onward with no upper bound, that has at
  least one event — derived from the `events` prop actually passed in, not
  from a separately fetched unbounded list.
- The empty-state copy becomes horizon-aware: `"Nothing in the next N days."`
  for a finite `N` (so the default reproduces today's exact copy, `"Nothing
  in the next 7 days."`), and `"Nothing coming up."` for `All`.
- The month grid and its per-day dots are **unaffected** — K25 is explicit
  that only the agenda list changes.

## Assumptions

- **S2-A1** "All" needs *some* internal representation and the setting's
  type is constrained to `number` by the brief; `Infinity` is chosen over a
  magic finite sentinel (e.g. `36500`) because it needs no arbitrary ceiling
  and round-trips through every numeric type check in the codebase (`typeof`,
  `Number.isFinite` branches) without a special case, at the one cost that
  `parseAgendaDays` must explicitly reject a user typing a huge or infinite
  number into the *custom* field — which the done-when already requires.
- **S2-A2** A fractional custom input (e.g. `7.9`) floors rather than
  rejects outright, consistent with `generateTasks.ts`'s own
  `normalizeLookaheadDays` precedent (floor, don't error) for the sibling
  setting it is explicitly not allowed to touch.
- **S2-A3** "All" derives its day list from the `events` prop `CalendarPanel`
  already receives, not a second, separately-fetched unbounded query —
  `useTriageData`'s `listEvents()` already returns every stored event with no
  window, so no new data dependency is introduced.
- **S2-A4** The five preset/Custom control is rendered as plain buttons (the
  house pattern elsewhere in this view — e.g. `TaskList`'s Required toggle),
  not the existing `ui/select.tsx` Radix select, since the control's value
  set is small, fixed, and benefits from every option being visible and
  clickable at once rather than hidden in a dropdown.
- **S2-A5** Colour bands use Tailwind's stock palette (`text-red-600`,
  `text-orange-600`, `text-amber-600`, `text-lime-600`, `text-green-600`) —
  no `dark:` variant is added. Some `src/components/ui/*.tsx` shadcn
  primitives do carry `dark:` classes, but the app defines no `.dark` block
  and mounts no theme toggle anywhere under `src/`, so none of those
  variants is ever active; adding the first *live* dark-mode styling is out
  of scope for this unit.
