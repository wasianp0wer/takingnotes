# F3 Triage Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task follows superpowers:test-driven-development: write the test, watch it fail, implement, watch it pass, commit.

**Goal:** Replace the Triage placeholder with a working triage center: tasks ranked by the slack-based priority score, a local calendar whose deadlines generate tasks idempotently, and an autosaved scratchpad whose lines can be promoted to tasks.

**Architecture:** Pure logic in plain `.ts` modules under `src/triage/` (date math, priority, sync planner, form/line/format helpers) with unit tests; a thin IndexedDB-facing layer (`syncTasksFromCalendar`, `taskActions`) over the Phase 0 repositories; two React hooks (`useTriageData`, `useScratchpad`) plus `useNow`; thin presentational components assembled in `TriageView`.

**Tech Stack:** React 19, TypeScript (strict, `noUnusedLocals`), Vite, Tailwind 3 tokens, Radix-based `src/components/ui/*`, `idb` over IndexedDB, Vitest + happy-dom + fake-indexeddb.

**Spec:** `docs/features/f3-spec.md` (feature spec + test list + assumptions). Background: `docs/spec.md` (F3, I7–I9), `docs/architecture.md` (§2.2, §2.4, §2.5, §3.4, §5), `docs/assumptions.md` (A14–A16).

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/f3-triage` (branch `notes/f3-triage`). Always use absolute paths or `cd` into it in each command. Never push. Never use bare `git stash`.
- Edit only `src/triage/**` and `docs/features/f3-*`. Do not edit `src/storage/**`, `src/capture/**`, `src/app/**`, `src/main.tsx`, or old studio code. Add no dependencies.
- Keep the export name `TriageView` in `src/triage/TriageView.tsx`.
- Imports use the `@/` alias (e.g. `import { listTasks } from '@/storage/tasks'`). Type-only imports use `import type` (`verbatimModuleSyntax`).
- All times are epoch ms. Day math uses **local time** via `Date` setters (`setHours`, `setDate`), never `+ 86_400_000`.
- Priority formula, verbatim: `slack = h - d`; `urgency = slack >= 0 ? 1 / (1 + slack / 24) : 1 + min(-slack / 24, 1)`; `weight = required ? 1.0 : 0.5`; `score = round(100 * weight * urgency)`; no due date → urgency `0.1`; unset estimate → 60 minutes.
- Component tests: no `@testing-library/react`. Use `createRoot` + `act` with `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, as in `src/app/DeviceStatus.test.tsx`. IndexedDB tests call `resetDatabase` from `@/test/resetDb` in `beforeEach`.
- Commit messages: conventional style (`feat(triage): ...`, `test(triage): ...`), each ending with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commands: single test file `npx vitest run src/triage/<file>`; all tests `npx vitest run`; types `npx tsc -p tsconfig.app.json --noEmit`; lint a file `npx eslint src/triage/<file>`.
- Baseline: 241 tests pass; `npm run lint` has 1 pre-existing error in `src/components/CanvasEngine.tsx` (not ours).

## Review Focus

1. Overlapping syncs (mount + StrictMode double mount + focus + interval) must never create two tasks for one event — pinned by the concurrent-sync test in Task 3.
2. DST days (23 h / 25 h) must not shift due dates or agenda days — pinned by `dates.dst.test.ts` in Task 1.
3. A user edit of `required`/estimate on a generated task must survive later event edits (A16) — pinned in Task 3 planner tests.
4. Scratchpad typing that races the initial load must not be overwritten by the stored value, and pending text must be saved on unmount — pinned in Task 5.
5. Invalid numeric input (empty/negative/NaN estimate, garbage lookahead setting) must fall back sensibly instead of producing `NaN` scores — pinned in Tasks 2, 3, 4 and 6.

---

### Task 1: Local date helpers (`dates.ts`)

**Files:**
- Create: `src/triage/dates.ts`
- Test: `src/triage/dates.test.ts`, `src/triage/dates.dst.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `startOfLocalDay(ms: number): number`
  - `endOfLocalDay(ms: number): number` (23:59:59.999 local)
  - `addLocalDays(ms: number, days: number): number` (keeps wall-clock time)
  - `isSameLocalDay(a: number, b: number): boolean`
  - `monthGrid(year: number, month: number): number[][]` (month 0–11; weeks start Sunday; each cell a local-midnight ms; only weeks containing a day of the month)
  - `toDateInputValue(ms: number): string` (`YYYY-MM-DD`)
  - `toTimeInputValue(ms: number): string` (`HH:mm`)
  - `localDateTimeFromInputs(date: string, time: string): number | null` (`time === ''` → local midnight; invalid date/time → `null`)

- [ ] **Step 1: Write the failing tests** — `src/triage/dates.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  endOfLocalDay,
  isSameLocalDay,
  localDateTimeFromInputs,
  monthGrid,
  startOfLocalDay,
  toDateInputValue,
  toTimeInputValue,
} from '@/triage/dates';

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m, d, h, min, s, ms).getTime();

describe('startOfLocalDay / endOfLocalDay', () => {
  it('returns local midnight of the same day', () => {
    expect(startOfLocalDay(at(2026, 8, 28, 0))).toBe(at(2026, 8, 28));
    expect(startOfLocalDay(at(2026, 8, 28, 12, 30))).toBe(at(2026, 8, 28));
    expect(startOfLocalDay(at(2026, 8, 28, 23, 59, 59, 999))).toBe(at(2026, 8, 28));
  });

  it('returns the last millisecond of the same local day', () => {
    expect(endOfLocalDay(at(2026, 8, 28, 0))).toBe(at(2026, 8, 28, 23, 59, 59, 999));
    expect(endOfLocalDay(at(2026, 8, 28, 23, 59, 59, 999))).toBe(at(2026, 8, 28, 23, 59, 59, 999));
  });
});

describe('addLocalDays', () => {
  it('keeps the wall-clock time', () => {
    expect(addLocalDays(at(2026, 8, 28, 17, 45), 1)).toBe(at(2026, 8, 29, 17, 45));
  });
  it('crosses month and year ends', () => {
    expect(addLocalDays(at(2026, 8, 30, 9), 1)).toBe(at(2026, 9, 1, 9));
    expect(addLocalDays(at(2026, 11, 31, 9), 1)).toBe(at(2027, 0, 1, 9));
  });
  it('accepts negative and zero offsets', () => {
    expect(addLocalDays(at(2026, 9, 1, 9), -1)).toBe(at(2026, 8, 30, 9));
    expect(addLocalDays(at(2026, 9, 1, 9), 0)).toBe(at(2026, 9, 1, 9));
  });
});

describe('isSameLocalDay', () => {
  it('is true within a day and false across midnight', () => {
    expect(isSameLocalDay(at(2026, 8, 28, 0), at(2026, 8, 28, 23, 59))).toBe(true);
    expect(isSameLocalDay(at(2026, 8, 28, 23, 59, 59, 999), at(2026, 8, 29))).toBe(false);
  });
});

describe('monthGrid', () => {
  it('lays out September 2026 as 5 Sunday-first weeks', () => {
    const grid = monthGrid(2026, 8);
    expect(grid).toHaveLength(5);
    for (const week of grid) expect(week).toHaveLength(7);
    expect(grid[0][0]).toBe(at(2026, 7, 30));
    expect(grid[4][6]).toBe(at(2026, 9, 3));
    for (const week of grid) {
      for (const day of week) {
        expect(new Date(day).getDay()).toBe(week.indexOf(day));
        expect(startOfLocalDay(day)).toBe(day);
      }
    }
  });
  it('uses 4 rows for February 2026, which starts on a Sunday', () => {
    const grid = monthGrid(2026, 1);
    expect(grid).toHaveLength(4);
    expect(grid[0][0]).toBe(at(2026, 1, 1));
    expect(grid[3][6]).toBe(at(2026, 1, 28));
  });
});

describe('date/time input values', () => {
  it('formats with zero padding', () => {
    expect(toDateInputValue(at(2026, 0, 5, 7, 3))).toBe('2026-01-05');
    expect(toTimeInputValue(at(2026, 0, 5, 7, 3))).toBe('07:03');
  });
  it('round-trips', () => {
    const ms = at(2026, 8, 28, 17, 45);
    expect(localDateTimeFromInputs(toDateInputValue(ms), toTimeInputValue(ms))).toBe(ms);
  });
  it('treats an empty time as local midnight', () => {
    expect(localDateTimeFromInputs('2026-09-28', '')).toBe(at(2026, 8, 28));
  });
  it('rejects invalid input', () => {
    expect(localDateTimeFromInputs('', '')).toBeNull();
    expect(localDateTimeFromInputs('2026-02-30', '')).toBeNull();
    expect(localDateTimeFromInputs('2026-09-28', '25:00')).toBeNull();
    expect(localDateTimeFromInputs('not a date', '10:00')).toBeNull();
  });
});
```

`src/triage/dates.dst.test.ts` — DST in a fixed zone. Setting `process.env.TZ` before any `Date` use works in Node (it resets its zone cache on assignment). Restore it afterwards.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@/triage/dates';

const HOUR = 3_600_000;
let previousTz: string | undefined;

beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe('local day math across DST (America/New_York)', () => {
  it('spring forward: 2026-03-08 is 23 hours long', () => {
    const noon = new Date(2026, 2, 8, 12).getTime();
    expect(endOfLocalDay(noon) - startOfLocalDay(noon)).toBe(23 * HOUR - 1);
    const next = addLocalDays(new Date(2026, 2, 7, 12).getTime(), 1);
    expect(new Date(next).getHours()).toBe(12);
    expect(next - new Date(2026, 2, 7, 12).getTime()).toBe(23 * HOUR);
  });
  it('fall back: 2026-11-01 is 25 hours long', () => {
    const noon = new Date(2026, 10, 1, 12).getTime();
    expect(endOfLocalDay(noon) - startOfLocalDay(noon)).toBe(25 * HOUR - 1);
    expect(new Date(addLocalDays(new Date(2026, 9, 31, 12).getTime(), 1)).getHours()).toBe(12);
  });
});
```

If the DST test shows the zone did not change (e.g. the day is 24 h), confirm by logging `new Date(2026, 2, 8, 12).getTimezoneOffset()`; if Node really ignores the runtime assignment in this pool, move the `process.env.TZ = ...` assignment to the very first line of the file (before imports is not possible in ESM, so use a top-level statement in a `vi.hoisted(() => { process.env.TZ = 'America/New_York'; })`). Do not change `vitest.config.ts`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/triage/dates` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/triage/dates.ts`

```ts
/**
 * Local-time day math for the triage center. Everything goes through `Date`
 * setters so a DST day (23 h or 25 h) is still exactly one day; adding
 * 86 400 000 ms would drift by an hour twice a year.
 */

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** All-day items are due at the end of their local day (architecture §2.2). */
export function endOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Same wall-clock time `days` calendar days later (or earlier). */
export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/**
 * Weeks (Sunday first) covering `month` (0-11) of `year`. Each cell is local
 * midnight. Only weeks that contain a day of the month are included (4-6 rows).
 */
export function monthGrid(year: number, month: number): number[][] {
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const weeks: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const week: number[] = [];
    for (let c = 0; c < 7; c += 1) {
      week.push(new Date(year, month, 1 - offset + r * 7 + c).getTime());
    }
    weeks.push(week);
  }
  return weeks;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInputValue(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parses `<input type="date">` / `<input type="time">` values as local time.
 * An empty time means local midnight. Returns null for anything invalid,
 * including dates that `Date` would silently roll over (2026-02-30).
 */
export function localDateTimeFromInputs(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])];
  let h = 0;
  let mi = 0;
  if (time !== '') {
    const tm = /^(\d{2}):(\d{2})$/.exec(time);
    if (!tm) return null;
    h = Number(tm[1]);
    mi = Number(tm[2]);
    if (h > 23 || mi > 59) return null;
  }
  const result = new Date(y, mo, d, h, mi);
  if (result.getFullYear() !== y || result.getMonth() !== mo || result.getDate() !== d) return null;
  return result.getTime();
}
```

- [ ] **Step 4: Run to see them pass** — `npx vitest run src/triage/dates` → PASS; `npx eslint src/triage/dates*.ts` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/f3-triage
git add src/triage/dates.ts src/triage/dates.test.ts src/triage/dates.dst.test.ts
git commit -m "feat(triage): local-time day math and month grid

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Priority score (`priority.ts`)

**Files:**
- Create: `src/triage/priority.ts`
- Test: `src/triage/priority.test.ts`

**Interfaces:**
- Consumes: `TaskRecord` from `@/storage/types`.
- Produces:
  - `DEFAULT_ESTIMATE_MINUTES = 60`, `NO_DUE_DATE_URGENCY = 0.1`
  - `effectiveEstimateMinutes(minutes: number): number` (finite and ≥ 0 → itself, else 60)
  - `priorityScore(task: Pick<TaskRecord, 'required' | 'estimatedMinutes' | 'dueAt'>, now: number): number`
  - `interface RankedTask { task: TaskRecord; score: number }`
  - `rankTasks(tasks: readonly TaskRecord[], now: number): RankedTask[]` (score desc, dueAt asc with null last, createdAt asc, id asc; does not mutate input)

- [ ] **Step 1: Write the failing tests** — `src/triage/priority.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '@/storage/types';
import { effectiveEstimateMinutes, priorityScore, rankTasks } from '@/triage/priority';

const NOW = new Date(2026, 8, 28, 9).getTime();
const HOUR = 3_600_000;

const score = (required: boolean, hoursUntilDue: number | null, estimateHours: number) =>
  priorityScore(
    {
      required,
      dueAt: hoursUntilDue === null ? null : NOW + hoursUntilDue * HOUR,
      estimatedMinutes: estimateHours * 60,
    },
    NOW,
  );

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: overrides.id,
    required: true,
    estimatedMinutes: 60,
    dueAt: null,
    status: 'open',
    source: 'manual',
    eventId: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

describe('priorityScore - spec reference values (I7)', () => {
  it('required, due in 48 h, 2 h estimate → 34', () => expect(score(true, 48, 2)).toBe(34));
  it('required, due in 12 h, 8 h estimate → 86', () => expect(score(true, 12, 8)).toBe(86));
  it('optional, due in 12 h, 1 h estimate → 34', () => expect(score(false, 12, 1)).toBe(34));
  it('required, due in 2 h, 4 h estimate → 108', () => expect(score(true, 2, 4)).toBe(108));
});

describe('priorityScore - boundaries', () => {
  it('zero slack is full urgency', () => {
    expect(score(true, 3, 3)).toBe(100);
    expect(score(false, 3, 3)).toBe(50);
  });
  it('slack of exactly -24 h doubles the score', () => expect(score(true, 1, 25)).toBe(200));
  it('the overdue boost is capped at 2', () => {
    expect(score(true, -47, 1)).toBe(200);
    expect(score(true, -1000, 0)).toBe(200);
    expect(score(false, -1000, 0)).toBe(100);
  });
  it('slack of -23 h is just under the cap', () => expect(score(true, 1, 24)).toBe(196));
  it('an overdue task with no estimate still gets the boost', () =>
    expect(score(true, -12, 0)).toBe(150));
  it('no due date means urgency 0.1', () => {
    expect(score(true, null, 1)).toBe(10);
    expect(score(false, null, 1)).toBe(5);
  });
});

describe('estimates', () => {
  it('falls back to 60 minutes for unusable estimates', () => {
    expect(effectiveEstimateMinutes(Number.NaN)).toBe(60);
    expect(effectiveEstimateMinutes(-5)).toBe(60);
    expect(effectiveEstimateMinutes(Number.POSITIVE_INFINITY)).toBe(60);
    expect(effectiveEstimateMinutes(0)).toBe(0);
    expect(effectiveEstimateMinutes(90)).toBe(90);
  });
  it('scores a NaN estimate like a 60-minute one', () => {
    const t = { required: true, dueAt: NOW + 48 * HOUR };
    expect(priorityScore({ ...t, estimatedMinutes: Number.NaN }, NOW)).toBe(
      priorityScore({ ...t, estimatedMinutes: 60 }, NOW),
    );
  });
});

describe('rankTasks', () => {
  it('sorts by score, then due date (none last), then createdAt, then id', () => {
    const tasks = [
      task({ id: 'no-due-old', createdAt: 1 }),
      task({ id: 'urgent', dueAt: NOW + 2 * HOUR }),
      task({ id: 'tie-later-due', dueAt: NOW + 49 * HOUR, estimatedMinutes: 180 }),
      task({ id: 'tie-earlier-due', dueAt: NOW + 48 * HOUR, estimatedMinutes: 120 }),
      task({ id: 'no-due-b', createdAt: 2 }),
      task({ id: 'no-due-a', createdAt: 2 }),
    ];
    const ranked = rankTasks(tasks, NOW);
    expect(ranked.map((r) => r.task.id)).toEqual([
      'urgent',
      'tie-earlier-due',
      'tie-later-due',
      'no-due-old',
      'no-due-a',
      'no-due-b',
    ]);
    expect(ranked[1].score).toBe(ranked[2].score);
    expect(tasks[0].id).toBe('no-due-old'); // input untouched
  });
});
```

(`tie-earlier-due`: slack 46 h → 34; `tie-later-due`: slack 46 h → 34; both 34, earlier due wins.)

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/triage/priority` → FAIL.

- [ ] **Step 3: Implement** — `src/triage/priority.ts`

```ts
import type { TaskRecord } from '@/storage/types';

/** A14: an unset estimate counts as an hour. */
export const DEFAULT_ESTIMATE_MINUTES = 60;
/** A14: undated tasks sit below anything with a real deadline. */
export const NO_DUE_DATE_URGENCY = 0.1;

const HOUR_MS = 3_600_000;

export type PriorityInput = Pick<TaskRecord, 'required' | 'estimatedMinutes' | 'dueAt'>;

export function effectiveEstimateMinutes(minutes: number): number {
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_ESTIMATE_MINUTES;
}

/**
 * Spec I7, exactly. Slack is the time left once the work itself is done; the
 * less of it, the more urgent. Once slack is negative the task is effectively
 * late and gets a boost that grows over a day and caps at 2.
 */
export function priorityScore(task: PriorityInput, now: number): number {
  let urgency = NO_DUE_DATE_URGENCY;
  if (task.dueAt !== null && task.dueAt !== undefined) {
    const h = (task.dueAt - now) / HOUR_MS;
    const d = effectiveEstimateMinutes(task.estimatedMinutes) / 60;
    const slack = h - d;
    urgency = slack >= 0 ? 1 / (1 + slack / 24) : 1 + Math.min(-slack / 24, 1);
  }
  const weight = task.required ? 1.0 : 0.5;
  return Math.round(100 * weight * urgency);
}

export interface RankedTask {
  task: TaskRecord;
  score: number;
}

/** A total order, so the list never reshuffles between renders with equal scores. */
export function rankTasks(tasks: readonly TaskRecord[], now: number): RankedTask[] {
  return tasks
    .map((task) => ({ task, score: priorityScore(task, now) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ad = a.task.dueAt ?? Number.POSITIVE_INFINITY;
      const bd = b.task.dueAt ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad < bd ? -1 : 1;
      if (a.task.createdAt !== b.task.createdAt) return a.task.createdAt - b.task.createdAt;
      return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
    });
}
```

- [ ] **Step 4: Run to see them pass** — `npx vitest run src/triage/priority` → PASS; eslint clean.

- [ ] **Step 5: Commit** — `git add src/triage/priority.ts src/triage/priority.test.ts && git commit -m "feat(triage): slack-based priority score and task ranking" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

---

### Task 3: Calendar → task sync (`generateTasks.ts`, `taskActions.ts`)

**Files:**
- Create: `src/triage/generateTasks.ts`, `src/triage/taskActions.ts`
- Test: `src/triage/generateTasks.test.ts` (pure planner), `src/triage/generateTasks.sync.test.ts` (IndexedDB), `src/triage/taskActions.test.ts`

**Interfaces:**
- Consumes: `startOfLocalDay`, `endOfLocalDay`, `addLocalDays` from `@/triage/dates`; `listEvents` from `@/storage/events`; `listTasks`, `createTask`, `updateTask` from `@/storage/tasks`; `getSettingValue`, `SETTING_DEFAULTS` from `@/storage/settingKeys`; `CalendarEventRecord`, `TaskRecord` from `@/storage/types`.
- Produces:
  - `dueAtForEvent(event: Pick<CalendarEventRecord, 'startsAt' | 'allDay'>): number`
  - `normalizeLookaheadDays(value: unknown): number` (finite → `max(0, floor)`, else 7)
  - `interface NewTask { title: string; required: boolean; estimatedMinutes: number; dueAt: number; status: 'open'; source: 'calendar'; eventId: string; createdAt: number; updatedAt: number }`
  - `interface TaskSyncUpdate { id: string; patch: { title: string; dueAt: number } }`
  - `interface TaskSyncPlan { create: NewTask[]; update: TaskSyncUpdate[]; dismiss: string[] }`
  - `planTaskSync(events: readonly CalendarEventRecord[], tasks: readonly TaskRecord[], now: number, lookaheadDays: number): TaskSyncPlan`
  - `syncTasksFromCalendar(now?: number): Promise<TaskSyncPlan>` — serialized; `now` defaults to `Date.now()` at the moment the queued run starts.
  - `taskActions.ts`: `completeTask(id: string, now?: number): Promise<TaskRecord>`; `dismissTask(id: string): Promise<TaskRecord>`

**Rules (from `docs/features/f3-spec.md` → "Task sync"; implement exactly):**
- Window = `[startOfLocalDay(now), addLocalDays(startOfLocalDay(now), lookaheadDays)]`, inclusive.
- Only `kind === 'deadline'` events create tasks. Tasks are "the event's" when `source === 'calendar' && eventId === event.id`; manual/scratchpad tasks are ignored entirely even if they carry an `eventId`.
- Event with no task of any status → create iff `dueAtForEvent(event)` is in the window; copy `title`, `required`, `estimatedMinutes`; `createdAt = updatedAt = now`.
- Done/dismissed tasks: never created again, never updated, never dismissed.
- Event with open task(s): keep the oldest open (`createdAt` asc, then id asc), dismiss other open ones; if the kept one's `title` or `dueAt` differs from the event, update with patch `{ title: event.title, dueAt: dueAtForEvent(event) }` — exactly these two keys — even when the new due date is outside the window.
- Event `kind === 'event'` with open task(s) → dismiss them all.
- Open calendar task whose `eventId` matches no event → dismiss.
- Plan lists are in a deterministic order (events in input order; orphans in task input order). Inputs are not mutated.

- [ ] **Step 1: Write the failing planner tests** — `src/triage/generateTasks.test.ts`

Use fixtures built with local-time constructors. `NOW = new Date(2026, 8, 28, 15).getTime()` (Monday 15:00), `TODAY = new Date(2026, 8, 28).getTime()`.

```ts
import { describe, expect, it } from 'vitest';

import type { CalendarEventRecord, TaskRecord } from '@/storage/types';
import { addLocalDays, endOfLocalDay } from '@/triage/dates';
import {
  dueAtForEvent,
  normalizeLookaheadDays,
  planTaskSync,
  type TaskSyncPlan,
} from '@/triage/generateTasks';

const NOW = new Date(2026, 8, 28, 15).getTime();
const TODAY = new Date(2026, 8, 28).getTime();
const HOUR = 3_600_000;
const EMPTY: TaskSyncPlan = { create: [], update: [], dismiss: [] };

function event(overrides: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: `Event ${overrides.id}`,
    kind: 'deadline',
    startsAt: NOW + 24 * HOUR,
    endsAt: null,
    allDay: false,
    required: true,
    estimatedMinutes: 60,
    notes: '',
    source: 'manual',
    sourceRef: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: `Task ${overrides.id}`,
    required: true,
    estimatedMinutes: 60,
    dueAt: null,
    status: 'open',
    source: 'calendar',
    eventId: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

/** Applies a plan in memory the way syncTasksFromCalendar applies it to IndexedDB. */
function apply(tasks: TaskRecord[], plan: TaskSyncPlan): TaskRecord[] {
  let next = tasks.map((t) => ({ ...t }));
  next = next.map((t) => {
    const u = plan.update.find((x) => x.id === t.id);
    return u ? { ...t, ...u.patch } : t;
  });
  next = next.map((t) => (plan.dismiss.includes(t.id) ? { ...t, status: 'dismissed' as const } : t));
  plan.create.forEach((c, i) => next.push({ ...c, id: `new-${i}`, completedAt: null }));
  return next;
}
```

Then these `it` blocks (write each body fully; values below are the assertions):

1. `dueAtForEvent`: timed `{startsAt: NOW + 5*HOUR, allDay: false}` → `NOW + 5*HOUR`; all-day `{startsAt: TODAY, allDay: true}` → `endOfLocalDay(TODAY)`.
2. `normalizeLookaheadDays`: `7→7`, `3.9→3`, `-2→0`, `NaN→7`, `'5'→7`, `undefined→7`, `Infinity→7`.
3. Creates one task for a deadline inside the window, copying fields:
   `planTaskSync([event({id:'e1', title:'Essay', required:false, estimatedMinutes:120, startsAt: NOW + 48*HOUR})], [], NOW, 7)` → `create` equals `[{ title:'Essay', required:false, estimatedMinutes:120, dueAt: NOW+48*HOUR, status:'open', source:'calendar', eventId:'e1', createdAt: NOW, updatedAt: NOW }]`, `update: []`, `dismiss: []`.
4. `kind: 'event'` inside the window → `EMPTY`.
5. Deadline yesterday (`startsAt: TODAY - 1`) → `EMPTY`. Deadline earlier today (`NOW - 2*HOUR`) → one create (F3-2).
6. Window edges with lookahead 7: `startsAt: TODAY` → create; `startsAt: addLocalDays(TODAY, 7)` → create; `addLocalDays(TODAY, 7) + 1` → none. Lookahead 3 with `startsAt: addLocalDays(TODAY, 5)` → none; lookahead 7 → create.
7. All-day deadline on `addLocalDays(TODAY, 6)` → create with `dueAt = endOfLocalDay(addLocalDays(TODAY, 6))`; all-day on `addLocalDays(TODAY, 7)` → none (its due moment is end of that day, past the window; F3-1).
8. Idempotent: event e1 + open task `{eventId:'e1', title: e1.title, dueAt: dueAtForEvent(e1)}` → `EMPTY`.
9. Done task for e1 → `EMPTY` even though e1 is in window and its title changed. Dismissed task → `EMPTY`.
10. Edited event: open task `{eventId:'e1', title:'Old', dueAt: NOW, required:false, estimatedMinutes: 15}` with event `{id:'e1', title:'New', startsAt: NOW + 30*HOUR, required:true, estimatedMinutes: 240}` → `update` equals `[{ id: task.id, patch: { title:'New', dueAt: NOW + 30*HOUR } }]` and `Object.keys(update[0].patch).sort()` is `['dueAt','title']`.
11. Edited event moved outside window (`startsAt: addLocalDays(TODAY, 30)`) with an open task → still an update to the new dueAt.
12. Deleted event: open calendar task `{eventId:'gone'}` → `dismiss: [id]`; done/dismissed tasks for `'gone'` are not listed.
13. Event switched to `kind:'event'` with an open task → `dismiss: [id]`, no update.
14. Duplicates: two open tasks for e1 with `createdAt` 5 and 1 → keeps createdAt-1 (and updates it if stale), dismisses the createdAt-5 one; equal createdAt → lower id kept.
15. Manual task `{source:'manual', eventId:'gone'}` and scratchpad task `{source:'scratchpad', eventId:null}` → `EMPTY`.
16. Idempotence property on a mixed fixture: events `[e-new (in window), e-edited (task stale), e-event-kind (open task), e-done (done task), e-far (30 days out, no task)]` plus an orphan open task; `const once = planTaskSync(events, tasks, NOW, 7); const after = apply(tasks, once); expect(planTaskSync(events, after, NOW, 7)).toEqual(EMPTY);` and `once` is non-empty in every list.
17. Does not mutate inputs: deep-freeze-style check — `const before = structuredClone({events, tasks}); planTaskSync(...); expect({events, tasks}).toEqual(before)`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/triage/generateTasks.test.ts` → FAIL.

- [ ] **Step 3: Implement the planner** — `src/triage/generateTasks.ts`

```ts
import { listEvents } from '@/storage/events';
import { SETTING_DEFAULTS, getSettingValue } from '@/storage/settingKeys';
import { createTask, listTasks, updateTask } from '@/storage/tasks';
import type { CalendarEventRecord, TaskRecord } from '@/storage/types';
import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@/triage/dates';

export interface NewTask {
  title: string;
  required: boolean;
  estimatedMinutes: number;
  dueAt: number;
  status: 'open';
  source: 'calendar';
  eventId: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSyncUpdate {
  id: string;
  /** Exactly these two fields (A16): required/estimate stay the user's. */
  patch: { title: string; dueAt: number };
}

export interface TaskSyncPlan {
  create: NewTask[];
  update: TaskSyncUpdate[];
  dismiss: string[];
}

/** Architecture §3.4: all-day items are due at the end of their local day. */
export function dueAtForEvent(event: Pick<CalendarEventRecord, 'startsAt' | 'allDay'>): number {
  return event.allDay ? endOfLocalDay(event.startsAt) : event.startsAt;
}

export function normalizeLookaheadDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SETTING_DEFAULTS['triage.lookaheadDays'];
  }
  return Math.max(0, Math.floor(value));
}

const byAge = (a: TaskRecord, b: TaskRecord) =>
  a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Decides, without touching storage, what the task store must change to
 * reflect the calendar. Pure so every rule is unit-testable; see
 * docs/features/f3-spec.md "Task sync".
 */
export function planTaskSync(
  events: readonly CalendarEventRecord[],
  tasks: readonly TaskRecord[],
  now: number,
  lookaheadDays: number,
): TaskSyncPlan {
  const plan: TaskSyncPlan = { create: [], update: [], dismiss: [] };
  const windowStart = startOfLocalDay(now);
  const windowEnd = addLocalDays(windowStart, normalizeLookaheadDays(lookaheadDays));

  const tasksByEvent = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    if (t.source !== 'calendar' || t.eventId === null) continue;
    const list = tasksByEvent.get(t.eventId) ?? [];
    list.push(t);
    tasksByEvent.set(t.eventId, list);
  }

  const eventIds = new Set<string>();
  for (const event of events) {
    eventIds.add(event.id);
    const own = tasksByEvent.get(event.id) ?? [];
    const open = own.filter((t) => t.status === 'open').sort(byAge);

    if (event.kind !== 'deadline') {
      plan.dismiss.push(...open.map((t) => t.id));
      continue;
    }

    const dueAt = dueAtForEvent(event);
    if (own.length === 0) {
      if (dueAt >= windowStart && dueAt <= windowEnd) {
        plan.create.push({
          title: event.title,
          required: event.required,
          estimatedMinutes: event.estimatedMinutes,
          dueAt,
          status: 'open',
          source: 'calendar',
          eventId: event.id,
          createdAt: now,
          updatedAt: now,
        });
      }
      continue;
    }

    const [keep, ...extras] = open;
    plan.dismiss.push(...extras.map((t) => t.id));
    if (keep && (keep.title !== event.title || keep.dueAt !== dueAt)) {
      plan.update.push({ id: keep.id, patch: { title: event.title, dueAt } });
    }
  }

  for (const t of tasks) {
    if (t.source === 'calendar' && t.eventId !== null && t.status === 'open' && !eventIds.has(t.eventId)) {
      plan.dismiss.push(t.id);
    }
  }
  return plan;
}
```

- [ ] **Step 4: Run planner tests** → PASS.

- [ ] **Step 5: Write failing sync + action tests** — `src/triage/generateTasks.sync.test.ts` and `src/triage/taskActions.test.ts`, with `beforeEach(resetDatabase)`:

1. `createEvent({title:'Lab report', kind:'deadline', startsAt: Date.now() + 24h})`; `await syncTasksFromCalendar()`; `listTasks()` has one open calendar task with that `eventId`; a second `await syncTasksFromCalendar()` returns an empty plan and `listTasks()` still has length 1.
2. With `setSettingValue('triage.lookaheadDays', 1)` a deadline 3 days out creates nothing; with 7 it creates one.
3. Concurrency: `await Promise.all([syncTasksFromCalendar(), syncTasksFromCalendar(), syncTasksFromCalendar()])` with one deadline → exactly one task stored.
4. `updateEvent(id, {title:'Renamed'})` then sync → the task's title is `'Renamed'`; `deleteEvent(id)` then sync → the task's status is `'dismissed'`.
5. A task the user edited (`updateTask(id, {required:false, estimatedMinutes: 10})`) keeps those values after `updateEvent(eventId, {startsAt: ...})` + sync, while `dueAt` follows the event.
6. A rejected run does not wedge the queue: use `vi.spyOn(eventsModule, 'listEvents')` … if ESM spying is awkward, skip this test and instead assert in code review that the queue continues after a rejection (`queue = run.catch(() => undefined)`).
7. `taskActions`: `completeTask(id, 1234)` → `status 'done'`, `completedAt 1234`; `dismissTask(id)` → `status 'dismissed'`, `completedAt null`.

Use real `Date.now()`-relative times with a margin (hours), so tests are independent of the wall clock.

- [ ] **Step 6: Run to see them fail**, then implement the sync (append to `generateTasks.ts`) and `taskActions.ts`:

```ts
/**
 * One run at a time. Mount, window focus, the interval and StrictMode's double
 * mount all trigger syncs; two overlapping runs would both see "no task for
 * this event" and create two.
 */
let queue: Promise<unknown> = Promise.resolve();

export function syncTasksFromCalendar(now?: number): Promise<TaskSyncPlan> {
  const run = queue.then(() => runSync(now ?? Date.now()));
  queue = run.catch(() => undefined);
  return run;
}

async function runSync(now: number): Promise<TaskSyncPlan> {
  const [events, tasks, lookahead] = await Promise.all([
    listEvents(),
    listTasks(),
    getSettingValue('triage.lookaheadDays'),
  ]);
  const plan = planTaskSync(events, tasks, now, lookahead);
  for (const input of plan.create) await createTask(input);
  for (const { id, patch } of plan.update) await updateTask(id, patch);
  for (const id of plan.dismiss) await updateTask(id, { status: 'dismissed' });
  return plan;
}
```

```ts
// src/triage/taskActions.ts
import { updateTask } from '@/storage/tasks';
import type { TaskRecord } from '@/storage/types';

/** `completedAt` is the triage layer's decision (architecture §2.4). */
export function completeTask(id: string, now: number = Date.now()): Promise<TaskRecord> {
  return updateTask(id, { status: 'done', completedAt: now });
}

export function dismissTask(id: string): Promise<TaskRecord> {
  return updateTask(id, { status: 'dismissed', completedAt: null });
}
```

- [ ] **Step 7: Run all triage tests** — `npx vitest run src/triage` → PASS; `npx eslint src/triage` clean; `npx tsc -p tsconfig.app.json --noEmit` clean.

- [ ] **Step 8: Commit** — `git add src/triage/generateTasks* src/triage/taskActions* && git commit -m "feat(triage): idempotent deadline-to-task sync" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

---

### Task 4: UI helper modules (`format.ts`, `eventForm.ts`, `scratchpadLines.ts`)

**Files:**
- Create: `src/triage/format.ts`, `src/triage/eventForm.ts`, `src/triage/scratchpadLines.ts`
- Test: `src/triage/format.test.ts`, `src/triage/eventForm.test.ts`, `src/triage/scratchpadLines.test.ts`

**Interfaces:**
- Consumes: Task 1 date helpers; `CalendarEventRecord`, `CalendarEventKind` from `@/storage/types`; `DEFAULT_ESTIMATE_MINUTES` from `@/triage/priority`.
- Produces:
  - `format.ts`: `formatTime(ms): string` (`HH:mm`); `formatDayLabel(ms, now): string` (`'Today' | 'Tomorrow' | 'Yesterday' | 'Wed 30 Sep'`, plus ` 2027` when the year differs from `now`'s); `formatDue(dueAt: number | null, now: number): string` (`'No due date'`; else day label + (` HH:mm` unless `dueAt === endOfLocalDay(dueAt)`), prefixed `'Overdue · '` when `dueAt < now`); `formatMonthTitle(year, month): string` (`'September 2026'`).
  - `eventForm.ts`:
    ```ts
    export interface EventFormState {
      title: string; kind: CalendarEventKind; date: string; time: string;
      allDay: boolean; required: boolean; estimatedMinutes: string; notes: string;
    }
    export type EventFormValue = Pick<CalendarEventRecord,
      'title' | 'kind' | 'startsAt' | 'allDay' | 'required' | 'estimatedMinutes' | 'notes'>;
    export type EventFormResult = { ok: true; value: EventFormValue } | { ok: false; error: string };
    export function emptyEventForm(dayMs: number): EventFormState;      // date of dayMs, time '09:00', kind 'deadline', allDay false, required true, estimate '60', notes ''
    export function eventFormFromRecord(e: CalendarEventRecord): EventFormState; // allDay → time ''
    export function eventValueFromForm(form: EventFormState): EventFormResult;
    ```
    Validation: trimmed title empty → `'Give it a title.'`; bad date → `'Pick a valid date.'`; not all-day and bad/empty time → `'Pick a time or mark it all-day.'`; estimate: trimmed `''` → 60, else `Number(...)`, must be finite and ≥ 0 else `'Estimate must be a number of minutes.'`, rounded to an integer. All-day → `startsAt` = local midnight of the date. Title and notes are trimmed.
  - `scratchpadLines.ts`:
    ```ts
    export interface LineRange { text: string; start: number; end: number } // end excludes the '\n'
    export function lineAtCursor(text: string, cursor: number): LineRange;   // cursor clamped to [0, text.length]
    export function removeLine(text: string, range: LineRange): { text: string; cursor: number };
    export function taskTitleFromLine(line: string): string;
    ```
    `lineAtCursor` must special-case `cursor === 0` (start = 0): `text.lastIndexOf('\n', -1)` inspects index 0 and would misplace the start when the text begins with a newline. `removeLine` removes the line and one adjacent newline (the following one if present, else the preceding one); `cursor` is where the removed line started (clamped to the new length). `taskTitleFromLine` strips `^\s*(?:(?:[-*•+]|\d+[.)])\s+)?(?:\[[ xX]?\]\s+)?` and trims.

- [ ] **Step 1: Write the failing tests** covering, with `NOW = new Date(2026, 8, 28, 15).getTime()`:
  - `formatDue(null, NOW)` → `'No due date'`; `formatDue(new Date(2026,8,28,17,5).getTime(), NOW)` → `'Today 17:05'`; `formatDue(endOfLocalDay(NOW), NOW)` → `'Today'`; tomorrow 09:00 → `'Tomorrow 09:00'`; Wed Sep 30 2026 all-day → `'Wed 30 Sep'`; Jan 4 2027 10:00 → `'Mon 4 Jan 2027 10:00'`; today 09:00 → `'Overdue · Today 09:00'`; Sep 27 end-of-day → `'Overdue · Yesterday'`. `formatMonthTitle(2026, 8)` → `'September 2026'`.
  - Event form: `emptyEventForm(NOW)` values; record → form → value round-trip for a timed and an all-day event (value equals the record's picked fields); empty title, `date: ''`, `date: '2026-02-30'`, timed with `time: ''`, estimate `'-5'` and `'abc'` each return `{ok:false}` with the messages above; estimate `''` → 60, `' 90 '` → 90, `'12.6'` → 13; all-day ignores a bad time.
  - Lines: `lineAtCursor('a\nbb\nccc', 0)` → `{text:'a', start:0, end:1}`; cursor 3 → `bb` `{2,4}`; cursor 4 (end of `bb`) → `bb`; cursor 9 → `ccc` `{5,8}`... (text length 8, cursor clamped); `lineAtCursor('', 0)` → `{text:'', start:0, end:0}`. `removeLine` of the middle line → `'a\nccc'` cursor 2; of the last → `'a\nbb'` cursor 4 (clamped); of the only line → `''` cursor 0; of the first → `'bb\nccc'` cursor 0. `taskTitleFromLine`: `'- buy milk'` → `'buy milk'`, `'  * [ ] call Sam '` → `'call Sam'`, `'1. read ch 4'` → `'read ch 4'`, `'[x] done thing'` → `'done thing'`, `'• item'` → `'item'`, `'   '` → `''`, `'-dash-in-word'` → `'-dash-in-word'`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** the three modules per the interfaces. `format.ts` uses fixed English arrays:

```ts
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDayLabel(ms: number, now: number): string {
  const day = startOfLocalDay(ms);
  const today = startOfLocalDay(now);
  if (day === today) return 'Today';
  if (day === addLocalDays(today, 1)) return 'Tomorrow';
  if (day === addLocalDays(today, -1)) return 'Yesterday';
  const d = new Date(ms);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}
```

- [ ] **Step 4: Run to see them pass**; eslint clean.

- [ ] **Step 5: Commit** — `feat(triage): due-date labels, event form validation and scratchpad line helpers`.

---

### Task 5: Hooks (`useNow.ts`, `useScratchpad.ts`, `useTriageData.ts`)

**Files:**
- Create: `src/triage/useNow.ts`, `src/triage/useScratchpad.ts`, `src/triage/useTriageData.ts`, `src/triage/testing.ts` (shared test helpers: `mount`, `typeInto`, `click`, `flush`)
- Test: `src/triage/useScratchpad.test.tsx`, `src/triage/useTriageData.test.tsx`

**Interfaces:**
- Consumes: `syncTasksFromCalendar` (Task 3), `completeTask`/`dismissTask` (Task 3), `EventFormValue` (Task 4), repositories `listTasks`, `createTask`, `updateTask`, `CreateTaskInput` (`@/storage/tasks`), `listEvents`, `createEvent`, `updateEvent`, `deleteEvent` (`@/storage/events`), `getSettingValue`/`setSettingValue` (`@/storage/settingKeys`).
- Produces:
  ```ts
  export function useNow(intervalMs?: number): number;           // default 60_000
  export interface ScratchpadState { text: string; loaded: boolean; setText(next: string): void; flush(): Promise<void> }
  export function useScratchpad(opts?: { debounceMs?: number }): ScratchpadState;   // default 500
  export type TaskPatch = Partial<Pick<TaskRecord, 'title' | 'required' | 'estimatedMinutes' | 'dueAt'>>;
  export interface TriageData {
    tasks: TaskRecord[];            // every status; views filter to 'open'
    events: CalendarEventRecord[];  // earliest first
    loaded: boolean;
    error: string | null;
    refresh(): Promise<void>;       // sync, then reload
    saveEvent(value: EventFormValue, id?: string | null): Promise<void>;  // create when no id, else update; then refresh
    removeEvent(id: string): Promise<void>;
    addTask(input: CreateTaskInput): Promise<void>;
    patchTask(id: string, patch: TaskPatch): Promise<void>;
    completeTask(id: string): Promise<void>;
    dismissTask(id: string): Promise<void>;
  }
  export function useTriageData(opts?: { syncIntervalMs?: number }): TriageData;  // default 60_000
  ```

Behavior:
- `useScratchpad`: on mount reads `triage.scratchpad`; if the user has already called `setText` before the read resolves, the stored value is ignored. `setText` updates state immediately and (re)starts a `debounceMs` timer that writes the latest text with `setSettingValue('triage.scratchpad', text)`. Writes are chained on a promise so they land in order. On unmount, pending text is written immediately. `flush()` writes pending text now.
- `useTriageData`: `refresh()` = `await syncTasksFromCalendar()` then `Promise.all([listTasks(), listEvents()])`; apply the result only if this is the latest refresh (request counter) and the component is still mounted. Triggers: mount, `window` `focus` event, `setInterval(syncIntervalMs)`, and after `saveEvent`/`removeEvent`/`addTask`/`patchTask`/`completeTask`/`dismissTask`. Errors are caught into `error` (message string) and `console.error('[triage] ...', err)`; a later successful refresh clears `error`.
- `useNow`: `useState(() => Date.now())`, updated by `setInterval`.

`src/triage/testing.ts` (not a test file; used by all component tests):

```ts
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export interface Mounted { container: HTMLDivElement; root: Root; render(node: ReactNode): void; unmount(): void }

export function mount(node: ReactNode): Mounted {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const m: Mounted = {
    container,
    root,
    render: (n) => act(() => root.render(n)),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
  m.render(node);
  return m;
}

/** Sets a controlled input's value the way React listens for it. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
}

export async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** Lets IndexedDB callbacks and resulting renders settle. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

/** Polls until `check` stops throwing (IndexedDB work spans many macrotasks). */
export async function waitFor(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try { check(); return; } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await flush(1);
    }
  }
}
```

Do not use `vi.useFakeTimers()` together with fake-indexeddb (it schedules with timers and hangs). Test debounce and intervals with small real values passed through the options (`debounceMs: 30`, `syncIntervalMs: 50`).

- [ ] **Step 1: Write failing hook tests** using a tiny probe component that renders hook state into the DOM (e.g. `<pre data-testid="text">{state.text}</pre>` and exposes the hook's return value through a module-level `let latest: ScratchpadState`):
  - scratchpad loads the stored value (`setSettingValue('triage.scratchpad', 'hello')` before mount → text `'hello'`, `loaded` true);
  - typing three times within the debounce results in exactly one stored write of the final text (spy with `vi.spyOn(settingKeys, 'setSettingValue')` via `import * as settingKeys from '@/storage/settingKeys'`; if ESM namespace spying is not allowed, assert on the stored value instead: after debounce it equals the final text, and immediately after the last keystroke it still equals the old value);
  - unmounting with pending text writes it (read back via `getSettingValue`);
  - typing before the load resolves is not overwritten by the stored value;
  - `useTriageData`: a stored deadline event (tomorrow) produces an open calendar task in `tasks` after mount; creating another deadline event directly in the repository and dispatching `window.dispatchEvent(new Event('focus'))` makes its task appear; `saveEvent({...})` creates an event and its task; `removeEvent(id)` dismisses its task; `completeTask(id)` sets `done` with `completedAt`; the interval re-sync picks up a repository change within ~`syncIntervalMs`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement the hooks.**
- [ ] **Step 4: Run to see them pass**; eslint clean (react-hooks rules included); tsc clean.
- [ ] **Step 5: Commit** — `feat(triage): data, scratchpad and clock hooks`.

---

### Task 6: Task list (`TaskList.tsx`)

**Files:**
- Create: `src/triage/TaskList.tsx`
- Test: `src/triage/TaskList.test.tsx`

**Interfaces:**
- Consumes: `rankTasks` (Task 2), `formatDue` (Task 4), `localDateTimeFromInputs`, `endOfLocalDay` (Task 1), `TaskPatch` (Task 5), `CreateTaskInput`, `TaskRecord`; UI `Button`, `Input`, `Label`.
- Produces:
  ```ts
  export interface TaskListProps {
    tasks: TaskRecord[];   // open tasks only
    now: number;
    onAdd(input: CreateTaskInput): Promise<void> | void;
    onPatch(id: string, patch: TaskPatch): Promise<void> | void;
    onComplete(id: string): Promise<void> | void;
    onDismiss(id: string): Promise<void> | void;
  }
  export function TaskList(props: TaskListProps): JSX.Element;
  ```

Markup contract (tests rely on it):
- A heading `Tasks`. Empty state text `No open tasks.`
- One `<li data-task-id={id}>` per task in `rankTasks` order containing: the title; a score badge `<span data-testid="task-score" title="Priority score">{score}</span>` (styled `rounded-md bg-secondary px-1.5 text-xs tabular-nums`; scores ≥ 100 use `bg-destructive/15 text-destructive`); a toggle `<Button size="sm" variant="outline" aria-pressed={required} aria-label="Required">` showing `Required`/`Optional` that calls `onPatch(id, {required: !required})`; an estimate `<Input type="number" min={0} step={5} aria-label="Estimate (minutes)">` holding local text state and committing on blur or Enter: valid finite ≥ 0 → `onPatch(id, {estimatedMinutes: Math.round(n)})` (only when changed), otherwise revert to the stored value; the due label `formatDue(dueAt, now)` (overdue labels in `text-destructive`); a source hint for `calendar`/`scratchpad` tasks (small muted text); `Done` and `Dismiss` buttons (`aria-label={`Done: ${title}`}` / `Dismiss: ${title}`) calling `onComplete`/`onDismiss`.
- An add form `<form aria-label="Add task">`: title `<Input aria-label="Task title">`, `<Input type="date" aria-label="Due date">`, `<Input type="time" aria-label="Due time">`, a native `<input type="checkbox" aria-label="Required" defaultChecked>`, estimate `<Input type="number" aria-label="New task estimate (minutes)" placeholder="60">`, submit `<Button type="submit">Add</Button>`. On submit: trimmed empty title → show `Give the task a title.` and do nothing; due = no date → `null`; date without time → `endOfLocalDay(localDateTimeFromInputs(date, ''))` (F3-10); date+time → `localDateTimeFromInputs(date, time)`; invalid → show `Pick a valid date.`; estimate `''` → 60; call `onAdd({ title, dueAt, required, estimatedMinutes, source: 'manual' })` then reset the form.
- Layout: rows wrap on narrow widths (`flex flex-wrap items-center gap-2`), title takes `min-w-0 flex-1 truncate`.

- [ ] **Step 1: Write failing tests** (pure props, `vi.fn()` handlers, `NOW` fixed): renders rows in score order with badges (`[...container.querySelectorAll('[data-testid=task-score]')].map(e => e.textContent)` equals the expected descending list for three fixture tasks); empty state; clicking Done/Dismiss calls handlers with the id; required toggle calls `onPatch(id, {required:false})`; estimate typed `'90'` then blurred (`el.dispatchEvent(new FocusEvent('focusout', {bubbles:true}))` — React's `onBlur` listens to `focusout`) calls `onPatch(id, {estimatedMinutes: 90})`; `'-3'` reverts and does not call; add form with empty title shows the error and does not call `onAdd`; add with title + date only calls `onAdd` with `dueAt = endOfLocalDay(...)`, `source:'manual'`, `estimatedMinutes: 60`. Submit the form with `form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}))` inside `act`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**; eslint + tsc clean.
- [ ] **Step 5: Commit** — `feat(triage): ranked task list with inline edits and manual add`.

---

### Task 7: Calendar (`CalendarPanel.tsx`, `EventDialog.tsx`)

**Files:**
- Create: `src/triage/CalendarPanel.tsx`, `src/triage/EventDialog.tsx`
- Test: `src/triage/CalendarPanel.test.tsx`, `src/triage/EventDialog.test.tsx`

**Interfaces:**
- Consumes: `monthGrid`, `startOfLocalDay`, `addLocalDays`, `isSameLocalDay`, `toDateInputValue` (Task 1); `formatDayLabel`, `formatTime`, `formatMonthTitle` (Task 4); `EventFormState`, `EventFormValue`, `emptyEventForm`, `eventFormFromRecord`, `eventValueFromForm` (Task 4); `CalendarEventRecord`; UI `Dialog*`, `Button`, `Input`, `Label`, `Select*`.
- Produces:
  ```ts
  export interface EventDialogProps {
    open: boolean;
    onOpenChange(open: boolean): void;
    initial: EventFormState;
    /** null → creating. */
    eventId: string | null;
    onSave(value: EventFormValue): Promise<void>;
    onDelete?(): Promise<void>;
  }
  export function EventDialog(props: EventDialogProps): JSX.Element;

  export interface CalendarPanelProps {
    events: CalendarEventRecord[];
    now: number;
    onSaveEvent(value: EventFormValue, id: string | null): Promise<void>;
    onDeleteEvent(id: string): Promise<void>;
  }
  export function CalendarPanel(props: CalendarPanelProps): JSX.Element;
  export const AGENDA_DAYS = 8; // today + the next 7 days
  ```

EventDialog:
- Radix `Dialog` controlled by `open`/`onOpenChange`; `DialogTitle` `New event` or `Edit event`. Form state initialized from `initial` (the parent remounts the dialog with a new `key` per open, so no syncing effect is needed).
- Fields with labels: Title `<Input aria-label="Title">`; Kind via `Select` (`deadline` "Deadline — becomes a task", `event` "Event"), trigger `aria-label="Kind"`; Date `<Input type="date" aria-label="Date">`; `<input type="checkbox" aria-label="All day">`; Time `<Input type="time" aria-label="Time">` hidden when all-day; `<input type="checkbox" aria-label="Required">`; Estimate `<Input type="number" aria-label="Estimate (minutes)">`; Notes `<textarea aria-label="Notes">` styled like `Input` (`min-h-20`). Required and estimate carry a hint "Defaults for the generated task".
- Footer: when editing, a `Delete` button (`variant="destructive"`) calling `onDelete` then `onOpenChange(false)`; `Cancel` (`variant="outline"`); `Save` (submit). Save validates with `eventValueFromForm`; on error shows the message in `role="alert"` and stays open; on success awaits `onSave(value)` then `onOpenChange(false)`. Disable Save while saving.

CalendarPanel:
- Header: `formatMonthTitle(visibleYear, visibleMonth)`, buttons `aria-label="Previous month"`/`"Next month"`, `Today`, and `New event` (opens create dialog for today).
- Month grid: 7 weekday headers (`Sun`…`Sat`), then a `<button data-day={toDateInputValue(day)} aria-label={...}>` per cell showing the day number; `data-outside="true"` for days outside the visible month (muted); today gets `aria-current="date"` and a ring. Under the number, up to 3 dots: `<span data-dot="deadline">` (`bg-destructive`) and `<span data-dot="event">` (`bg-primary`) for events whose `startsAt` falls on that local day. Clicking a cell opens the create dialog prefilled with that day.
- Agenda `<section aria-label="Agenda">`: for `i = 0..AGENDA_DAYS-1`, day = `addLocalDays(startOfLocalDay(now), i)`; list events on that day sorted all-day first then by `startsAt`; skip days without events; heading `formatDayLabel(day, now)`; each item a button showing `All day` or `formatTime(startsAt)`, the title, and a `Deadline` tag for deadlines; clicking opens the edit dialog. When nothing falls in the range: `Nothing in the next 7 days.`
- Dialog state: `{ mode: 'create'; day: number } | { mode: 'edit'; event: CalendarEventRecord } | null`, plus a counter used as the dialog `key`.
- Layout: grid cells `aspect-square` on wide screens, compact on narrow (`text-xs`); the whole panel is `min-w-0`.

- [ ] **Step 1: Write failing tests.** Radix Dialog renders into a portal on `document.body`, so query `document.body`, not the container. Keep Select at its default in tests (Radix Select is not driveable in happy-dom); cover kind conversion in Task 4's pure tests instead.
  - CalendarPanel with `now = new Date(2026, 8, 28, 15)` and events: deadline Sep 29 10:00, event Sep 29 all-day, event Oct 5 (inside agenda: day 7), deadline Oct 6 (outside agenda), event Sep 2: grid shows `September 2026`; the `2026-09-29` cell has one `deadline` and one `event` dot; the `2026-09-02` cell has one event dot; `2026-09-28` has `aria-current="date"`; agenda text contains `Tomorrow`, the Oct 5 event title, and not the Oct 6 title; all-day sorts before 10:00 on Sep 29; "Next month" shows `October 2026` and the `2026-10-06` cell has a deadline dot; with no events the agenda says `Nothing in the next 7 days.`
  - Clicking the `2026-09-30` cell opens the dialog (`document.body.textContent` contains `New event`) with the Date input value `2026-09-30`.
  - EventDialog create: type a title, keep defaults, click Save → `onSave` called once with `{title, kind:'deadline', startsAt: new Date(2026,8,30,9).getTime(), allDay:false, required:true, estimatedMinutes:60, notes:''}` and `onOpenChange(false)`; empty title → alert text `Give it a title.` and `onSave` not called; edit mode prefills from `eventFormFromRecord` and shows `Delete`, which calls `onDelete`; toggling All day hides the Time input.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**; eslint + tsc clean.
- [ ] **Step 5: Commit** — `feat(triage): month grid, agenda and event dialog`.

---

### Task 8: Scratchpad component and `TriageView` assembly

**Files:**
- Create: `src/triage/Scratchpad.tsx`
- Modify: `src/triage/TriageView.tsx` (replace the placeholder body; keep `export function TriageView`)
- Test: `src/triage/Scratchpad.test.tsx`, `src/triage/TriageView.test.tsx`

**Interfaces:**
- Consumes: `lineAtCursor`, `removeLine`, `taskTitleFromLine` (Task 4); `useNow`, `useScratchpad`, `useTriageData` (Task 5); `TaskList` (Task 6); `CalendarPanel` (Task 7).
- Produces:
  ```ts
  export interface ScratchpadProps {
    text: string;
    loaded: boolean;
    onChange(text: string): void;
    onPromote(title: string): Promise<void> | void;
  }
  export function Scratchpad(props: ScratchpadProps): JSX.Element;
  ```

Scratchpad:
- Heading `Scratchpad`, hint `Saved automatically.` A `<textarea aria-label="Scratchpad">` (styled like `Input`, `min-h-48 font-mono text-sm`, disabled until `loaded`) and a `Promote line to task` button (`variant="outline" size="sm"`). Keyboard shortcut: `Mod+Enter` in the textarea also promotes.
- Promote: read `textarea.selectionStart`; `range = lineAtCursor(text, cursor)`; `title = taskTitleFromLine(range.text)`; empty → show `Put the cursor on a line with text.` (muted, `role="status"`) and stop; else `await onPromote(title)`, then `const r = removeLine(text, range); onChange(r.text)`, and restore focus + caret to `r.cursor` after render (`requestAnimationFrame` or an effect keyed on a pending-caret ref). Show `Added “{title}” to tasks.` in the status line.

TriageView:

```tsx
export function TriageView() {
  const now = useNow();
  const data = useTriageData();
  const pad = useScratchpad();
  const openTasks = useMemo(() => data.tasks.filter((t) => t.status === 'open'), [data.tasks]);

  return (
    <div className="grid min-h-0 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {data.error && (<p role="alert" className="text-sm text-destructive lg:col-span-2">{data.error}</p>)}
      <section aria-label="Tasks" className="min-w-0 rounded-lg border border-border p-4">
        <TaskList tasks={openTasks} now={now} onAdd={data.addTask} onPatch={data.patchTask}
          onComplete={data.completeTask} onDismiss={data.dismissTask} />
      </section>
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-label="Calendar" className="rounded-lg border border-border p-4">
          <CalendarPanel events={data.events} now={now} onSaveEvent={data.saveEvent} onDeleteEvent={data.removeEvent} />
        </section>
        <section aria-label="Scratchpad" className="rounded-lg border border-border p-4">
          <Scratchpad text={pad.text} loaded={pad.loaded} onChange={pad.setText}
            onPromote={(title) => data.addTask({ title, source: 'scratchpad' })} />
        </section>
      </div>
    </div>
  );
}
```

Keep the doc comment at the top of `TriageView.tsx` describing what it now does. On narrow screens it is one column (tasks, then calendar, then scratchpad); `lg` and up is two columns.

- [ ] **Step 1: Write failing tests.**
  - Scratchpad (pure props): text `'first\n- second\nthird'`, set the textarea caret into line 2 (`textarea.setSelectionRange(8, 8)`), click Promote → `onPromote('second')` and `onChange('first\nthird')`; caret on a blank line → no `onPromote`, status message shown; typing calls `onChange` with the new value.
  - TriageView (IndexedDB, `beforeEach(resetDatabase)`): with a stored deadline event tomorrow, mounting shows the event's title in the Tasks section and in the Agenda, and the three `section[aria-label]` areas exist; typing a line into the scratchpad and promoting it adds a task with that title to the Tasks section (use `waitFor`) and stores it with `source: 'scratchpad'` (`listTasks()`); clicking `Done: <title>` removes it from the list and stores `status: 'done'` with a numeric `completedAt`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite** — `npx vitest run` (all pass: 241 existing + new), `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint src/triage`, `npm run build`.
- [ ] **Step 5: Commit** — `feat(triage): scratchpad with promote-to-task and the assembled Triage view`, with a body summarizing F3 (what shipped, test count, assumptions in `docs/features/f3-spec.md`).

---

## Status: complete

All eight tasks implemented, each reviewed, plus a whole-branch review and one
fix wave. Branch `notes/f3-triage`, 18 commits from `1472d99`:

| Task | Commits |
|------|---------|
| 1 dates | `97158e2` |
| 2 priority | `e00f905` |
| 3 sync | `a66a295` |
| 4 UI helpers | `fe63377`, `1c9bd6c` |
| 5 hooks | `f2c3a4f`, `63c7d62` |
| 6 task list | `3b02da7` |
| 7 calendar | `ce8de08` |
| 8 scratchpad + TriageView | `72fd48d`, `902a9a8` |
| shared-file exception | `8589214` (one assertion in `src/app/AppShell.test.tsx`) |
| final fix wave | `ec67659`, `8b37152`, `3150599`, `42b99ce` |
| docs | `c582ebe`, `0c3c197`, plus this commit |

441 tests in 43 files pass; `tsc` and `npm run build` clean; `eslint src/triage`
shows only the pre-existing `react-hooks/set-state-in-effect` warning.
Decisions taken during execution, including the ones that deviate from this
plan, are recorded as assumptions F3-1 … F3-17 in `docs/features/f3-spec.md`,
which also carries the notes for the merger.
