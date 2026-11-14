import { beforeEach, describe, expect, it } from 'vitest';

import { createEvent, getEvent, listEvents, updateEvent } from '@/storage/events';
import { createTask, getTask, listTasks, updateTask } from '@/storage/tasks';
import { resetDatabase } from '@/test/resetDb';
import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@/triage/dates';
import { dueAtForEvent, syncTasksFromCalendar } from '@/triage/generateTasks';
import {
  addTaskWithDeadline,
  deleteEventAndUnlinkTasks,
  eventScheduleForDueAt,
  linkDatedManualTasks,
  updateTaskSchedule,
} from '@/triage/taskDeadlines';

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m, d, h, min, s, ms).getTime();

/** End of the local day three weeks out: past the default lookahead. */
const threeWeeksOut = () => endOfLocalDay(addLocalDays(Date.now(), 21));

beforeEach(resetDatabase);

describe('eventScheduleForDueAt', () => {
  it('reads an end-of-day dueAt as all-day and round-trips through dueAtForEvent', () => {
    const dueAt = endOfLocalDay(at(2026, 10, 20, 9));
    const schedule = eventScheduleForDueAt(dueAt);
    expect(schedule).toEqual({ startsAt: startOfLocalDay(dueAt), allDay: true });
    expect(dueAtForEvent(schedule)).toBe(dueAt);
  });

  it('reads any other dueAt as timed and round-trips', () => {
    const dueAt = at(2026, 10, 20, 14, 30);
    const schedule = eventScheduleForDueAt(dueAt);
    expect(schedule).toEqual({ startsAt: dueAt, allDay: false });
    expect(dueAtForEvent(schedule)).toBe(dueAt);
  });
});

describe('addTaskWithDeadline', () => {
  it('creates a deadline event and a task linked to it', async () => {
    const dueAt = threeWeeksOut();
    const task = await addTaskWithDeadline({
      title: 'Essay',
      dueAt,
      required: false,
      estimatedMinutes: 90,
    });

    const events = await listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Essay',
      kind: 'deadline',
      allDay: true,
      startsAt: startOfLocalDay(dueAt),
      source: 'manual',
      required: false,
      estimatedMinutes: 90,
      notes: '',
    });
    expect(task).toMatchObject({
      title: 'Essay',
      source: 'calendar',
      eventId: events[0]!.id,
      dueAt,
      required: false,
      estimatedMinutes: 90,
    });
    expect(await listTasks()).toEqual([task]);
  });

  it('creates no event for an undated task', async () => {
    const task = await addTaskWithDeadline({ title: 'Read' });
    expect(await listEvents()).toEqual([]);
    expect(task).toMatchObject({ source: 'manual', eventId: null, dueAt: null });
  });

  it('keeps a scratchpad source for an undated task', async () => {
    const task = await addTaskWithDeadline({ title: 'Line', source: 'scratchpad' });
    expect(task.source).toBe('scratchpad');
  });

  it('is left alone by a sync even far outside the lookahead window', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });

    const plan = await syncTasksFromCalendar();
    expect(plan).toEqual({ create: [], update: [], dismiss: [], unlink: [] });
    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: task.id, status: 'open' });
  });
});

describe('updateTaskSchedule', () => {
  it('writes a title and date change through to the linked event', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });
    const moved = at(2027, 0, 5, 14, 30);

    const updated = await updateTaskSchedule(task.id, { title: 'Final essay', dueAt: moved });

    expect(updated).toMatchObject({ title: 'Final essay', dueAt: moved, source: 'calendar' });
    const event = await getEvent(task.eventId!);
    expect(event).toMatchObject({ title: 'Final essay', startsAt: moved, allDay: false });
    expect(dueAtForEvent(event!)).toBe(moved);
    expect(await getTask(task.id)).toEqual(updated);
  });

  it('writes a title-only change through and keeps the date', async () => {
    const dueAt = threeWeeksOut();
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt });

    await updateTaskSchedule(task.id, { title: 'Draft' });

    expect(await getTask(task.id)).toMatchObject({ title: 'Draft', dueAt });
    expect(await getEvent(task.eventId!)).toMatchObject({
      title: 'Draft',
      startsAt: startOfLocalDay(dueAt),
      allDay: true,
    });
  });

  it('gives a plain task a date by creating its deadline and linking it', async () => {
    const plain = await createTask({ title: 'Read', estimatedMinutes: 30 });
    const dueAt = threeWeeksOut();

    const updated = await updateTaskSchedule(plain.id, { dueAt });

    const events = await listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Read',
      kind: 'deadline',
      allDay: true,
      source: 'manual',
      estimatedMinutes: 30,
    });
    expect(updated).toMatchObject({ source: 'calendar', eventId: events[0]!.id, dueAt });
  });

  it('only renames a plain undated task', async () => {
    const plain = await createTask({ title: 'Read' });
    const updated = await updateTaskSchedule(plain.id, { title: 'Read more' });
    expect(updated).toMatchObject({ title: 'Read more', source: 'manual', eventId: null });
    expect(await listEvents()).toEqual([]);
  });

  it('clearing the date of a manual deadline deletes the event and unlinks the task', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });

    const updated = await updateTaskSchedule(task.id, { dueAt: null });

    expect(updated).toMatchObject({ source: 'manual', eventId: null, dueAt: null });
    expect(await listEvents()).toEqual([]);
    expect(await getTask(task.id)).toEqual(updated);
  });

  it('refuses to clear a syllabus deadline and writes nothing', async () => {
    const event = await createEvent({
      title: 'Midterm',
      kind: 'deadline',
      startsAt: at(2027, 0, 5, 9),
      source: 'syllabus',
    });
    const task = await createTask({
      title: 'Midterm',
      dueAt: event.startsAt,
      source: 'calendar',
      eventId: event.id,
    });

    await expect(updateTaskSchedule(task.id, { title: 'Renamed', dueAt: null })).rejects.toThrow(
      'A syllabus deadline cannot be cleared',
    );

    expect(await getEvent(event.id)).toEqual(event);
    expect(await getTask(task.id)).toEqual(task);
  });

  it('rejects a missing task', async () => {
    await expect(updateTaskSchedule('nope', { title: 'x' })).rejects.toThrow(
      'Task not found: nope',
    );
  });
});

describe('linkDatedManualTasks', () => {
  it('links every open dated manual task exactly once', async () => {
    const a = await createTask({ title: 'A', dueAt: threeWeeksOut() });
    const b = await createTask({ title: 'B', dueAt: at(2027, 0, 5, 14, 30) });

    expect(await linkDatedManualTasks()).toBe(2);
    expect(await linkDatedManualTasks()).toBe(0);

    const events = await listEvents();
    expect(events).toHaveLength(2);
    for (const original of [a, b]) {
      const linked = await getTask(original.id);
      expect(linked).toMatchObject({ source: 'calendar', dueAt: original.dueAt });
      const event = events.find((e) => e.id === linked!.eventId);
      expect(event).toMatchObject({ title: original.title, kind: 'deadline' });
      expect(dueAtForEvent(event!)).toBe(original.dueAt);
    }
  });

  it('skips done, dismissed and undated manual tasks', async () => {
    const done = await createTask({ title: 'Done', dueAt: threeWeeksOut(), status: 'done' });
    const dismissed = await createTask({
      title: 'Dismissed',
      dueAt: threeWeeksOut(),
      status: 'dismissed',
    });
    const undated = await createTask({ title: 'Undated' });

    expect(await linkDatedManualTasks()).toBe(0);
    expect(await listEvents()).toEqual([]);
    for (const t of [done, dismissed, undated]) expect(await getTask(t.id)).toEqual(t);
  });
});

describe('deleteEventAndUnlinkTasks', () => {
  it('deletes a manual deadline and leaves its task open, undated and plain', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });

    await deleteEventAndUnlinkTasks(task.eventId!);
    await syncTasksFromCalendar();

    expect(await listEvents()).toEqual([]);
    expect(await getTask(task.id)).toMatchObject({
      status: 'open',
      source: 'manual',
      eventId: null,
      dueAt: null,
    });
  });

  it('leaves a finished task of a deleted manual deadline alone', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });
    await updateTask(task.id, { status: 'done', completedAt: Date.now() });

    await deleteEventAndUnlinkTasks(task.eventId!);

    expect(await getTask(task.id)).toMatchObject({ status: 'done', eventId: task.eventId });
  });

  it('still dismisses the task of a deleted syllabus deadline', async () => {
    const event = await createEvent({
      title: 'Midterm',
      kind: 'deadline',
      startsAt: Date.now() + 3_600_000,
      source: 'syllabus',
    });
    await syncTasksFromCalendar();

    await deleteEventAndUnlinkTasks(event.id);
    await syncTasksFromCalendar();

    expect(await listEvents()).toEqual([]);
    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'dismissed', source: 'calendar', eventId: event.id });
  });

  it('deletes an event that has no tasks', async () => {
    const event = await createEvent({ title: 'Lecture', kind: 'event', startsAt: Date.now() });

    await deleteEventAndUnlinkTasks(event.id);

    expect(await listEvents()).toEqual([]);
    expect(await listTasks()).toEqual([]);
  });
});

describe('re-kinding a deadline', () => {
  it('unlinks the task of a manual deadline switched to an event on the next sync', async () => {
    const task = await addTaskWithDeadline({ title: 'Essay', dueAt: threeWeeksOut() });

    await updateEvent(task.eventId!, { kind: 'event' });
    const plan = await syncTasksFromCalendar();

    expect(plan.unlink).toEqual([task.id]);
    expect(await getTask(task.id)).toMatchObject({
      status: 'open',
      source: 'manual',
      eventId: null,
      dueAt: null,
    });
    // Unlinked and undated, so later syncs leave it alone.
    expect(await syncTasksFromCalendar()).toEqual({
      create: [],
      update: [],
      dismiss: [],
      unlink: [],
    });
  });

  it('still dismisses the task of a syllabus deadline switched to an event', async () => {
    const event = await createEvent({
      title: 'Midterm',
      kind: 'deadline',
      startsAt: Date.now() + 3_600_000,
      source: 'syllabus',
    });
    await syncTasksFromCalendar();

    await updateEvent(event.id, { kind: 'event' });
    await syncTasksFromCalendar();

    expect((await listTasks())[0]).toMatchObject({ status: 'dismissed', eventId: event.id });
  });
});
