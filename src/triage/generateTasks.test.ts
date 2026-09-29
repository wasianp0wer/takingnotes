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

describe('dueAtForEvent', () => {
  it('uses startsAt for a timed event', () => {
    expect(dueAtForEvent({ startsAt: NOW + 5 * HOUR, allDay: false })).toBe(NOW + 5 * HOUR);
  });

  it('uses the end of the local day for an all-day event', () => {
    expect(dueAtForEvent({ startsAt: TODAY, allDay: true })).toBe(endOfLocalDay(TODAY));
  });
});

describe('normalizeLookaheadDays', () => {
  it('keeps a non-negative integer', () => {
    expect(normalizeLookaheadDays(7)).toBe(7);
    expect(normalizeLookaheadDays(0)).toBe(0);
  });

  it('floors a fractional value', () => {
    expect(normalizeLookaheadDays(3.9)).toBe(3);
  });

  it('clamps a negative value to zero', () => {
    expect(normalizeLookaheadDays(-2)).toBe(0);
  });

  it('falls back to 7 for anything that is not a finite number', () => {
    expect(normalizeLookaheadDays(Number.NaN)).toBe(7);
    expect(normalizeLookaheadDays('5')).toBe(7);
    expect(normalizeLookaheadDays(undefined)).toBe(7);
    expect(normalizeLookaheadDays(Number.POSITIVE_INFINITY)).toBe(7);
  });
});

describe('planTaskSync', () => {
  it('creates one task for a deadline inside the window, copying the event fields', () => {
    const plan = planTaskSync(
      [
        event({
          id: 'e1',
          title: 'Essay',
          required: false,
          estimatedMinutes: 120,
          startsAt: NOW + 48 * HOUR,
        }),
      ],
      [],
      NOW,
      7,
    );

    expect(plan.create).toEqual([
      {
        title: 'Essay',
        required: false,
        estimatedMinutes: 120,
        dueAt: NOW + 48 * HOUR,
        status: 'open',
        source: 'calendar',
        eventId: 'e1',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.dismiss).toEqual([]);
  });

  it('never creates a task for an ordinary event inside the window', () => {
    expect(planTaskSync([event({ id: 'e1', kind: 'event' })], [], NOW, 7)).toEqual(EMPTY);
  });

  it('skips a deadline before today but generates one that already passed earlier today', () => {
    expect(planTaskSync([event({ id: 'e1', startsAt: TODAY - 1 })], [], NOW, 7)).toEqual(EMPTY);

    // F3-2: a deadline earlier today still becomes a task (it shows overdue).
    const plan = planTaskSync([event({ id: 'e1', startsAt: NOW - 2 * HOUR })], [], NOW, 7);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]?.dueAt).toBe(NOW - 2 * HOUR);
  });

  it('treats both window edges as inclusive', () => {
    expect(planTaskSync([event({ id: 'e1', startsAt: TODAY })], [], NOW, 7).create).toHaveLength(1);
    expect(
      planTaskSync([event({ id: 'e1', startsAt: addLocalDays(TODAY, 7) })], [], NOW, 7).create,
    ).toHaveLength(1);
    expect(
      planTaskSync([event({ id: 'e1', startsAt: addLocalDays(TODAY, 7) + 1 })], [], NOW, 7),
    ).toEqual(EMPTY);
  });

  it('honors the lookahead length', () => {
    const events = [event({ id: 'e1', startsAt: addLocalDays(TODAY, 5) })];

    expect(planTaskSync(events, [], NOW, 3)).toEqual(EMPTY);
    expect(planTaskSync(events, [], NOW, 7).create).toHaveLength(1);
  });

  it('due an all-day deadline at the end of its local day, which moves the last day out', () => {
    const inside = planTaskSync(
      [event({ id: 'e1', allDay: true, startsAt: addLocalDays(TODAY, 6) })],
      [],
      NOW,
      7,
    );
    expect(inside.create).toHaveLength(1);
    expect(inside.create[0]?.dueAt).toBe(endOfLocalDay(addLocalDays(TODAY, 6)));

    // F3-1: end of day 7 is past the window, which ends at the start of day 7.
    expect(
      planTaskSync([event({ id: 'e1', allDay: true, startsAt: addLocalDays(TODAY, 7) })], [], NOW, 7),
    ).toEqual(EMPTY);
  });

  it('is a no-op when the open task already matches the event', () => {
    const e1 = event({ id: 'e1' });
    const tasks = [task({ id: 't1', eventId: 'e1', title: e1.title, dueAt: dueAtForEvent(e1) })];

    expect(planTaskSync([e1], tasks, NOW, 7)).toEqual(EMPTY);
  });

  it('leaves done and dismissed tasks alone and never re-creates them', () => {
    const e1 = event({ id: 'e1', title: 'Renamed' });

    expect(
      planTaskSync(
        [e1],
        [task({ id: 't1', eventId: 'e1', status: 'done', title: 'Old', completedAt: NOW })],
        NOW,
        7,
      ),
    ).toEqual(EMPTY);

    expect(
      planTaskSync([e1], [task({ id: 't1', eventId: 'e1', status: 'dismissed', title: 'Old' })], NOW, 7),
    ).toEqual(EMPTY);
  });

  it('updates only title and dueAt when the event was edited', () => {
    const plan = planTaskSync(
      [
        event({
          id: 'e1',
          title: 'New',
          startsAt: NOW + 30 * HOUR,
          required: true,
          estimatedMinutes: 240,
        }),
      ],
      [
        task({
          id: 't1',
          eventId: 'e1',
          title: 'Old',
          dueAt: NOW,
          required: false,
          estimatedMinutes: 15,
        }),
      ],
      NOW,
      7,
    );

    expect(plan.update).toEqual([{ id: 't1', patch: { title: 'New', dueAt: NOW + 30 * HOUR } }]);
    // A16: required and estimatedMinutes stay the user's.
    expect(Object.keys(plan.update[0]!.patch).sort()).toEqual(['dueAt', 'title']);
    expect(plan.create).toEqual([]);
    expect(plan.dismiss).toEqual([]);
  });

  it('updates an open task even when the new due date is outside the window', () => {
    const plan = planTaskSync(
      [event({ id: 'e1', title: 'Far', startsAt: addLocalDays(TODAY, 30) })],
      [task({ id: 't1', eventId: 'e1', title: 'Far', dueAt: NOW })],
      NOW,
      7,
    );

    expect(plan.update).toEqual([
      { id: 't1', patch: { title: 'Far', dueAt: addLocalDays(TODAY, 30) } },
    ]);
  });

  it('dismisses an open task whose event is gone, leaving finished ones alone', () => {
    const plan = planTaskSync(
      [],
      [
        task({ id: 't-open', eventId: 'gone' }),
        task({ id: 't-done', eventId: 'gone', status: 'done', completedAt: NOW }),
        task({ id: 't-dismissed', eventId: 'gone', status: 'dismissed' }),
      ],
      NOW,
      7,
    );

    expect(plan.dismiss).toEqual(['t-open']);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
  });

  it('dismisses the open task of an event switched to the event kind', () => {
    const plan = planTaskSync(
      [event({ id: 'e1', kind: 'event', title: 'Lecture' })],
      [task({ id: 't1', eventId: 'e1', title: 'Old', dueAt: NOW })],
      NOW,
      7,
    );

    expect(plan.dismiss).toEqual(['t1']);
    expect(plan.update).toEqual([]);
    expect(plan.create).toEqual([]);
  });

  it('keeps the oldest of duplicate open tasks and dismisses the rest', () => {
    const e1 = event({ id: 'e1', title: 'Essay' });
    const plan = planTaskSync(
      [e1],
      [
        task({ id: 't-young', eventId: 'e1', createdAt: 5, title: 'Old', dueAt: NOW }),
        task({ id: 't-old', eventId: 'e1', createdAt: 1, title: 'Old', dueAt: NOW }),
      ],
      NOW,
      7,
    );

    expect(plan.dismiss).toEqual(['t-young']);
    expect(plan.update).toEqual([{ id: 't-old', patch: { title: 'Essay', dueAt: e1.startsAt } }]);
  });

  it('breaks a createdAt tie between duplicates by id', () => {
    const e1 = event({ id: 'e1' });
    const shared = { eventId: 'e1', createdAt: 1, title: e1.title, dueAt: dueAtForEvent(e1) };
    const plan = planTaskSync(
      [e1],
      [task({ id: 'b', ...shared }), task({ id: 'a', ...shared })],
      NOW,
      7,
    );

    expect(plan.dismiss).toEqual(['b']);
    expect(plan.update).toEqual([]);
  });

  it('never touches manual or scratchpad tasks', () => {
    expect(
      planTaskSync(
        [],
        [
          task({ id: 't1', source: 'manual', eventId: 'gone' }),
          task({ id: 't2', source: 'scratchpad', eventId: null }),
        ],
        NOW,
        7,
      ),
    ).toEqual(EMPTY);
  });

  it('is idempotent: applying a plan and replanning yields an empty plan', () => {
    const eNew = event({ id: 'e-new', title: 'New essay', startsAt: NOW + 24 * HOUR });
    const eEdited = event({ id: 'e-edited', title: 'Renamed', startsAt: NOW + 48 * HOUR });
    const eEventKind = event({ id: 'e-event-kind', kind: 'event' });
    const eDone = event({ id: 'e-done', title: 'Already handled' });
    const eFar = event({ id: 'e-far', startsAt: addLocalDays(TODAY, 30) });
    const events = [eNew, eEdited, eEventKind, eDone, eFar];

    const tasks = [
      task({ id: 't-edited', eventId: 'e-edited', title: 'Old name', dueAt: NOW, createdAt: 1 }),
      task({ id: 't-event-kind', eventId: 'e-event-kind', title: 'Lecture', dueAt: NOW }),
      task({ id: 't-done', eventId: 'e-done', status: 'done', title: 'Old', completedAt: NOW }),
      task({ id: 't-orphan', eventId: 'vanished', title: 'Orphan', dueAt: NOW }),
    ];

    const once = planTaskSync(events, tasks, NOW, 7);
    expect(once.create).toHaveLength(1);
    expect(once.update).toHaveLength(1);
    expect(once.dismiss).toEqual(['t-event-kind', 't-orphan']);

    const after = apply(tasks, once);
    expect(planTaskSync(events, after, NOW, 7)).toEqual(EMPTY);
  });

  it('does not mutate its inputs', () => {
    const events = [
      event({ id: 'e1', title: 'New' }),
      event({ id: 'e2', kind: 'event' }),
      event({ id: 'e3', startsAt: addLocalDays(TODAY, 30) }),
    ];
    const tasks = [
      task({ id: 't1', eventId: 'e1', title: 'Old', dueAt: NOW, createdAt: 5 }),
      task({ id: 't2', eventId: 'e1', title: 'Old', dueAt: NOW, createdAt: 1 }),
      task({ id: 't3', eventId: 'e2', title: 'Lecture' }),
      task({ id: 't4', eventId: 'gone' }),
    ];
    const before = structuredClone({ events, tasks });

    planTaskSync(events, tasks, NOW, 7);

    expect({ events, tasks }).toEqual(before);
  });
});
