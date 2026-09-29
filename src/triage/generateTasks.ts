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
    if (
      t.source === 'calendar' &&
      t.eventId !== null &&
      t.status === 'open' &&
      !eventIds.has(t.eventId)
    ) {
      plan.dismiss.push(t.id);
    }
  }
  return plan;
}

/**
 * One run at a time. Mount, window focus, the interval and StrictMode's double
 * mount all trigger syncs; two overlapping runs would both see "no task for
 * this event" and create two.
 */
let queue: Promise<unknown> = Promise.resolve();

export function syncTasksFromCalendar(now?: number): Promise<TaskSyncPlan> {
  const run = queue.then(() => runSync(now ?? Date.now()));
  // The queue swallows the failure so one rejected run cannot wedge the next.
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
