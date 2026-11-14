/**
 * Every dated task is a calendar deadline (small improvements 2026-11-14, goal 4).
 *
 * A task with a date owns a `deadline` event and is linked to it (`source:
 * 'calendar'`), so it shows on the calendar and the sync keeps the two in step.
 * The sync only copies event -> task (A16), so the task -> event direction is
 * written here, together with the task, in one transaction over both stores.
 */
import type { IDBPTransaction } from 'idb';

import { openNotesDb, type NotesDb } from '@/storage/db';
import { buildEventRecord } from '@/storage/events';
import { buildTaskRecord, createTask, type CreateTaskInput } from '@/storage/tasks';
import type { CalendarEventRecord, TaskRecord } from '@/storage/types';
import { endOfLocalDay, startOfLocalDay } from '@/triage/dates';

type DeadlineTx = IDBPTransaction<NotesDb, ('events' | 'tasks')[], 'readwrite'>;

/**
 * The inverse of `dueAtForEvent`: an end-of-day due moment is an all-day
 * deadline, anything else is timed, so `dueAtForEvent` of the result is `dueAt`.
 */
export function eventScheduleForDueAt(dueAt: number): { startsAt: number; allDay: boolean } {
  if (dueAt === endOfLocalDay(dueAt)) return { startsAt: startOfLocalDay(dueAt), allDay: true };
  return { startsAt: dueAt, allDay: false };
}

/** The manual deadline event a dated task owns. */
function deadlineEventFor(
  task: Pick<TaskRecord, 'title' | 'required' | 'estimatedMinutes'>,
  dueAt: number,
  now: number,
): CalendarEventRecord {
  return buildEventRecord(
    {
      title: task.title,
      kind: 'deadline',
      ...eventScheduleForDueAt(dueAt),
      required: task.required,
      estimatedMinutes: task.estimatedMinutes,
      notes: '',
      source: 'manual',
    },
    now,
  );
}

async function abortWith(tx: DeadlineTx, error: Error): Promise<never> {
  tx.abort();
  await tx.done.catch(() => undefined);
  throw error;
}

/** `createTask`, except a dated task is created together with its deadline. */
export async function addTaskWithDeadline(input: CreateTaskInput): Promise<TaskRecord> {
  if (input.dueAt == null) return createTask(input);

  const now = Date.now();
  const draft = buildTaskRecord(input, now);
  const event = deadlineEventFor(draft, input.dueAt, now);
  const task: TaskRecord = { ...draft, source: 'calendar', eventId: event.id };

  const db = await openNotesDb();
  const tx = db.transaction(['events', 'tasks'], 'readwrite');
  await Promise.all([tx.objectStore('events').put(event), tx.objectStore('tasks').put(task)]);
  await tx.done;
  return task;
}

/**
 * The write-through for a task's title and date (the inline editor's
 * `onPatch`). A linked task's edit also moves its event; a plain task given a
 * date gets a deadline; a cleared date drops a manual deadline and refuses a
 * syllabus one. One transaction per call.
 */
export async function updateTaskSchedule(
  id: string,
  patch: { title?: string; dueAt?: number | null },
): Promise<TaskRecord> {
  const now = Date.now();
  const db = await openNotesDb();
  const tx = db.transaction(['events', 'tasks'], 'readwrite');
  const tasks = tx.objectStore('tasks');
  const events = tx.objectStore('events');

  const existing = await tasks.get(id);
  if (!existing) return abortWith(tx, new Error(`Task not found: ${id}`));

  const title = patch.title ?? existing.title;
  const dueAt = patch.dueAt === undefined ? existing.dueAt : patch.dueAt;
  let next: TaskRecord = { ...existing, title, dueAt, updatedAt: now };

  const event = existing.eventId === null ? undefined : await events.get(existing.eventId);
  if (event) {
    if (dueAt === null) {
      if (event.source !== 'manual') {
        return abortWith(tx, new Error('A syllabus deadline cannot be cleared'));
      }
      await events.delete(event.id);
      next = { ...next, source: 'manual', eventId: null };
    } else {
      await events.put({ ...event, title, ...eventScheduleForDueAt(dueAt), updatedAt: now });
    }
  } else if (existing.eventId === null && dueAt !== null) {
    const created = deadlineEventFor(next, dueAt, now);
    await events.put(created);
    next = { ...next, source: 'calendar', eventId: created.id };
  }

  await tasks.put(next);
  await tx.done;
  return next;
}

/**
 * A plain undated task: what a typed task becomes when its manual deadline
 * stops being one, so the task outlives the calendar entry instead of
 * vanishing with it.
 */
export function unlinkedTask(task: TaskRecord, now: number): TaskRecord {
  return { ...task, source: 'manual', eventId: null, dueAt: null, updatedAt: now };
}

/**
 * Deletes an event (the calendar's Delete). A manual deadline is the one a
 * typed task owns, so its open tasks are unlinked into plain undated tasks in
 * the same transaction; the sync could not tell afterwards, since the deleted
 * event's source goes with it. A syllabus event's tasks are left linked, and
 * the next sync dismisses them as before.
 */
export async function deleteEventAndUnlinkTasks(id: string): Promise<void> {
  const now = Date.now();
  const db = await openNotesDb();
  const tx = db.transaction(['events', 'tasks'], 'readwrite');
  const tasks = tx.objectStore('tasks');
  const events = tx.objectStore('events');

  const event = await events.get(id);
  const writes: Promise<unknown>[] = [events.delete(id)];
  if (event?.source === 'manual') {
    const linked = await tasks.index('by-event').getAll(IDBKeyRange.only(id));
    for (const task of linked) {
      if (task.status === 'open') writes.push(tasks.put(unlinkedTask(task, now)));
    }
  }
  await Promise.all(writes);
  await tx.done;
}

/**
 * The upgrade sweep: every open manual task with a date gets its deadline and
 * is linked. Idempotent, since a linked task is no longer `source: 'manual'`.
 * Returns how many tasks it linked.
 */
export async function linkDatedManualTasks(): Promise<number> {
  const now = Date.now();
  const db = await openNotesDb();
  const tx = db.transaction(['events', 'tasks'], 'readwrite');
  const tasks = tx.objectStore('tasks');
  const events = tx.objectStore('events');

  const open = await tasks.index('by-status').getAll(IDBKeyRange.only('open'));
  const writes: Promise<unknown>[] = [];
  let linked = 0;
  for (const task of open) {
    if (task.source !== 'manual' || task.dueAt === null) continue;
    const event = deadlineEventFor(task, task.dueAt, now);
    writes.push(
      events.put(event),
      tasks.put({ ...task, source: 'calendar', eventId: event.id, updatedAt: now }),
    );
    linked += 1;
  }
  await Promise.all(writes);
  await tx.done;
  return linked;
}
