# S2 — implementation plan

Each task: write the failing test(s), run `npm test -- <file>` to see it/them
fail for the right reason, implement the minimum, run green, mutation-check
(break the implementation, confirm red, revert), then run all four gates
(`npm test`, `npx tsc -b`, `npm run lint`, `npm run build`) before committing.

## Task 0 — baseline

Confirm 93 files / 1145 tests pass, `tsc -b` clean, lint clean, build clean,
on the freshly-rebased worktree. No commit (nothing changed yet).

## Task 1 — `scoreBand` (priority.ts)

1. In `src/triage/priority.test.ts`, add a `describe('scoreBand')` block
   testing every boundary: 139→orange, 140→red, 99→amber, 100→orange,
   59→lime, 60→amber, 29→green, 30→lime, 0→green, 200→red, and a negative
   score (defensive, should never occur) →green.
2. Run, confirm failure (`scoreBand` doesn't exist → import error).
3. Implement `scoreBand` in `priority.ts` per the spec's thresholds.
4. Run green.
5. Mutation-check: flip one boundary's `>=` to `>` (or shift a threshold by
   1), confirm the relevant boundary test goes red, revert.
6. Gates, commit: `feat(triage): add scoreBand for the priority score (K22)`.

## Task 2 — apply the band to `TaskList`'s score chip

1. In `TaskList.test.tsx`, replace the existing "scores at or above 100 get
   the destructive badge treatment" test with explicit, concrete-score band
   tests: construct tasks whose `priorityScore` lands in each of the five
   bands (reuse/extend existing fixtures where the score already matches;
   add new ones otherwise) and assert the chip's `className` contains the
   expected `text-*` class for that band and none of the other four bands'
   classes.
2. Run, confirm failure (old classes still present, new ones absent).
3. Implement: import `scoreBand` into `TaskList.tsx`, replace the
   `score >= 100 && 'bg-destructive/15 text-destructive'` line with a lookup
   from `scoreBand(score)` to a `text-*` class, keep `bg-secondary` as the
   only background class.
4. Run green.
5. Mutation-check: swap two band's classes in the lookup map, confirm two
   tests go red (the wrong colour is now asserted-against), revert.
6. Gates, commit:
   `feat(triage): colour the task score by band, text only (K22)`.

## Task 3 — `triage.agendaDays` setting key

1. In `settingKeys.test.ts`: add `'triage.agendaDays': 7` to the "documents
   one default per key" object; add an assertion to "falls back to the
   default when nothing is stored" (`getSettingValue('triage.agendaDays')`
   → `7`); add a round-trip test that also covers the `Infinity` sentinel
   (`setSettingValue('triage.agendaDays', Infinity)` →
   `getSettingValue('triage.agendaDays')` → `Infinity`).
2. Run, confirm failure (key doesn't exist on the type / default missing).
3. Implement in `settingKeys.ts`: add `'triage.agendaDays': number` to
   `SettingValues` with a doc comment citing K23, add `7` to
   `SETTING_DEFAULTS`.
4. Run green.
5. Mutation-check: change the default to `8`, confirm the "documents one
   default" and "falls back to default" tests go red, revert.
6. Gates, commit:
   `feat(storage): add triage.agendaDays setting, default 7 (K23)`.

## Task 4 — `generateTasks` is provably untouched

1. Run `npm test -- src/triage/generateTasks.test.ts
   src/triage/generateTasks.sync.test.ts` standalone and confirm both files
   pass, unmodified, against the current `git diff` (i.e. these two files
   show zero diff from `phase3`).
2. No code change. This is a checkpoint, not a commit — folded into the
   final report's evidence, and re-verified again at the end.

## Task 5 — `parseAgendaDays` (pure validator)

1. In `CalendarPanel.test.tsx`, add a `describe('parseAgendaDays')` block:
   `''`→null, `'0'`→null, `'-5'`→null, `'abc'`→null, `'366'`→null,
   `'365'`→365, `'1'`→1, `'7.9'`→7, `'0.5'`→null (floors to 0, still
   rejected), `'  14  '`→14 (trims), `'Infinity'`→null.
2. Run, confirm failure (doesn't exist yet).
3. Implement `export function parseAgendaDays(input: string): number | null`
   in `CalendarPanel.tsx` per the spec.
4. Run green.
5. Mutation-check: change the `> 365` bound to `> 366`, confirm the `'366'`
   test goes red; revert. Change `<= 0` to `< 0`, confirm the `'0'` test goes
   red; revert.
6. Gates, commit:
   `feat(triage): add parseAgendaDays validator (K23)`.

## Task 6 — `candidateDaysForAgenda` (pure day-list helper)

1. In `CalendarPanel.test.tsx`, add tests for a new (not yet exported, but
   exported for this test) `candidateDaysForAgenda(events, today, agendaDays)`:
   - finite `agendaDays = 7` reproduces exactly the old 8-day window (same
     `today + 0 .. today + 7`), independent of events.
   - `agendaDays = Infinity` with no events → `[]`.
   - `agendaDays = Infinity` with events on day 0, day 40, and **yesterday**
     → returns day 0 and day 40 only, ascending, excluding yesterday.
   - `agendaDays = Infinity` with two events on the same day → that day
     appears once.
2. Run, confirm failure.
3. Implement the helper in `CalendarPanel.tsx` (not exported from the
   module's public surface beyond what the test imports — keep it a named,
   exported-for-test function alongside `parseAgendaDays`).
4. Run green.
5. Mutation-check: drop the `day >= today` filter, confirm the "excludes
   yesterday" assertion goes red; revert.
6. Gates, commit:
   `feat(triage): add candidateDaysForAgenda, replacing the fixed 8-day window (K23, K25)`.

## Task 7 — wire the horizon control into `CalendarPanel`

This is the biggest task; split it into sub-steps, each with its own
red/green/mutation cycle, but one commit at the end since the control only
makes sense whole.

1. Add `beforeEach(resetDatabase)` to `CalendarPanel.test.tsx` (new import
   from `@/test/resetDb`) — needed now that the component touches real
   settings storage.
2. Test: on mount, with nothing stored, the agenda shows a day-7 event and
   excludes a day-8 one (**this already exists** — re-run it after the
   wiring to confirm it still holds under the new default-7 code path, not
   the old hard-coded one).
3. Test: the horizon control renders five buttons labelled `3`, `7`, `14`,
   `30`, `All`, plus a `Custom…` toggle; `7` is `aria-pressed="true"` and the
   others are not, on a fresh (unstored) mount.
4. Test: clicking `14` — the agenda now includes a day-10 event (previously
   excluded under the 7 default) and `14`'s `aria-pressed` flips to `true`,
   `7`'s flips to `false`.
5. Test: clicking `14` persists it — remount a fresh `CalendarPanel` (same
   test, no `resetDatabase` in between) and, after `waitFor`, the new mount
   shows `14` pressed and the day-10 event present. This is the "survives a
   reload" proof at the component level.
6. Test: clicking `All` shows a day-40 event and changes the empty state
   wording path (separate test with no events → `"Nothing coming up."`).
7. Test: clicking `Custom…` reveals a number input; typing `45` and blurring
   applies it (day-40 event appears, day-7/14/30 buttons all unpressed,
   `Custom…` pressed) and persists it (same remount-and-check pattern as
   step 5).
8. Test: typing `0`, `-5`, `abc`, or `400` into the custom field and blurring
   shows an inline error, leaves the previously-applied horizon as the
   active one (unchanged agenda contents), and does not clear the typed
   text.
9. Test: the empty-state copy for a finite horizon other than 7 (e.g. `3`)
   reads `"Nothing in the next 3 days."`.
10. Implement: load/save `triage.agendaDays` in `CalendarPanel` (mount
    effect + `loadedRef` guard, following `AudioSettings`'s pattern); render
    the five preset buttons plus `Custom…`/number input; replace
    `AGENDA_DAYS` usage in `Agenda` with `candidateDaysForAgenda(events,
    today, agendaDays)`; make the empty-state string horizon-aware.
11. Run the whole file green.
12. Mutation-check at least two of the above: (a) break the persistence by
    not calling `setSettingValue` on preset click, confirm step 5's test
    goes red, revert; (b) break the custom validation wiring by committing
    on every keystroke instead of on blur, confirm the "doesn't clear typed
    text" / error-timing assertion goes red, revert.
13. Full gates (`npm test`, `tsc -b`, lint, build).
14. Commit:
    `feat(triage): add the agenda horizon control to CalendarPanel (K23, K25)`.

## Task 8 — full regression + generateTasks re-check

1. `npm test` — full suite, confirm count is `1145 + <new tests>` across
   `93 + 0` files (no new files; four existing test files grew) and
   everything passes.
2. `npm test -- src/triage/generateTasks.test.ts
   src/triage/generateTasks.sync.test.ts` again, standalone, and
   `git diff phase3 -- src/triage/generateTasks.ts` is empty — the off-limits
   file truly was never touched.
3. `npx tsc -b`, `npm run lint`, `npm run build`.
4. No commit (verification only, folded into the final report).

## Task 9 — report

Write `docs/features/s2-report.md`: what changed, exact test counts, the
mutation-check log (every mutation tried and whether it was caught), gate
results, and the K22–K25 done-when checklist. Commit it.
