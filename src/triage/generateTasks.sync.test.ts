import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEvent, deleteEvent, listEvents, updateEvent } from '@/storage/events';
import { setSettingValue } from '@/storage/settingKeys';
import { listTasks, updateTask } from '@/storage/tasks';
import { resetDatabase } from '@/test/resetDb';
import { syncTasksFromCalendar } from '@/triage/generateTasks';

/**
 * `listEvents` delegates to the real repository unless a test overrides it once,
 * which is how the "a rejected run does not wedge the queue" case is provoked.
 */
vi.mock('@/storage/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/events')>();
  return { ...actual, listEvents: vi.fn(actual.listEvents) };
});

const HOUR = 3_600_000;

beforeEach(resetDatabase);

describe('syncTasksFromCalendar', () => {
  it('creates a task for a stored deadline and creates nothing on a second run', async () => {
    const event = await createEvent({
      title: 'Lab report',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });

    const first = await syncTasksFromCalendar();
    expect(first.create).toHaveLength(1);

    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Lab report',
      status: 'open',
      source: 'calendar',
      eventId: event.id,
      dueAt: event.startsAt,
    });

    const second = await syncTasksFromCalendar();
    expect(second).toEqual({ create: [], update: [], dismiss: [] });
    expect(await listTasks()).toHaveLength(1);
  });

  it('honors the stored lookahead setting', async () => {
    await createEvent({
      title: 'Midterm',
      kind: 'deadline',
      startsAt: Date.now() + 72 * HOUR,
    });

    await setSettingValue('triage.lookaheadDays', 1);
    expect((await syncTasksFromCalendar()).create).toEqual([]);
    expect(await listTasks()).toHaveLength(0);

    await setSettingValue('triage.lookaheadDays', 7);
    expect((await syncTasksFromCalendar()).create).toHaveLength(1);
    expect(await listTasks()).toHaveLength(1);
  });

  it('creates exactly one task when three syncs overlap', async () => {
    await createEvent({
      title: 'Problem set',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });

    const plans = await Promise.all([
      syncTasksFromCalendar(),
      syncTasksFromCalendar(),
      syncTasksFromCalendar(),
    ]);

    expect(plans.reduce((n, plan) => n + plan.create.length, 0)).toBe(1);
    expect(await listTasks()).toHaveLength(1);
  });

  it('flows an event rename and an event deletion through to the stored task', async () => {
    const event = await createEvent({
      title: 'Reading',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });
    await syncTasksFromCalendar();

    await updateEvent(event.id, { title: 'Renamed' });
    await syncTasksFromCalendar();
    expect((await listTasks())[0]).toMatchObject({ title: 'Renamed', status: 'open' });

    await deleteEvent(event.id);
    await syncTasksFromCalendar();
    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('dismissed');
  });

  it('dismisses through dismissTask, so a sync-dismissed task never keeps a completedAt', async () => {
    const event = await createEvent({
      title: 'Seminar',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });
    await syncTasksFromCalendar();
    const task = (await listTasks())[0]!;

    // The state the read-then-write race can leave behind: still open, but
    // already carrying a completedAt from a Done the user just clicked.
    await updateTask(task.id, { completedAt: Date.now() });

    await deleteEvent(event.id);
    await syncTasksFromCalendar();

    // One definition of "dismissed", the one in taskActions.
    expect((await listTasks())[0]).toMatchObject({ status: 'dismissed', completedAt: null });
  });

  it('keeps a user edit of required and estimate while the due date follows the event', async () => {
    const event = await createEvent({
      title: 'Essay',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });
    await syncTasksFromCalendar();
    const task = (await listTasks())[0]!;

    await updateTask(task.id, { required: false, estimatedMinutes: 10 });

    const movedTo = Date.now() + 48 * HOUR;
    await updateEvent(event.id, { startsAt: movedTo });
    const plan = await syncTasksFromCalendar();

    expect(plan.update).toEqual([{ id: task.id, patch: { title: 'Essay', dueAt: movedTo } }]);
    expect((await listTasks())[0]).toMatchObject({
      required: false,
      estimatedMinutes: 10,
      dueAt: movedTo,
    });
  });

  it('does not wedge the queue when a run rejects', async () => {
    await createEvent({
      title: 'Quiz',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });

    vi.mocked(listEvents).mockRejectedValueOnce(new Error('storage offline'));
    await expect(syncTasksFromCalendar()).rejects.toThrow('storage offline');

    expect((await syncTasksFromCalendar()).create).toHaveLength(1);
    expect(await listTasks()).toHaveLength(1);
  });
});
