import { beforeEach, describe, expect, it } from 'vitest';

import {
  createTask,
  deleteTask,
  getTask,
  getTasksByEvent,
  listTasks,
  listTasksByStatus,
  updateTask,
} from '@/storage/tasks';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('tasks repository', () => {
  it('creates a task with sensible defaults', async () => {
    const task = await createTask({ title: 'Read chapter 4' });

    expect(task.id).toBeTruthy();
    expect(task.required).toBe(true);
    // A14: an unset estimate is 60 minutes.
    expect(task.estimatedMinutes).toBe(60);
    expect(task.dueAt).toBeNull();
    expect(task.status).toBe('open');
    expect(task.source).toBe('manual');
    expect(task.eventId).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBe(task.createdAt);
    expect(await getTask(task.id)).toEqual(task);
  });

  it('records the event a generated task came from', async () => {
    const task = await createTask({
      title: 'Essay',
      source: 'calendar',
      eventId: 'event-1',
      required: false,
      estimatedMinutes: 120,
      dueAt: 9_000,
    });

    expect(task.source).toBe('calendar');
    expect(task.eventId).toBe('event-1');
    expect(task.required).toBe(false);
    expect(task.estimatedMinutes).toBe(120);
    expect(task.dueAt).toBe(9_000);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getTask('missing')).toBeUndefined();
  });

  it('applies a partial update and bumps updatedAt', async () => {
    const created = await createTask({ title: 'Draft', createdAt: 10, updatedAt: 10 });
    const updated = await updateTask(created.id, { status: 'done', completedAt: 50 });

    expect(updated.status).toBe('done');
    expect(updated.completedAt).toBe(50);
    expect(updated.createdAt).toBe(10);
    expect(updated.updatedAt).toBeGreaterThan(10);
    expect(await getTask(created.id)).toEqual(updated);
  });

  it('throws when updating an unknown id', async () => {
    await expect(updateTask('missing', { title: 'x' })).rejects.toThrow('missing');
  });

  it('persists both writes when two task updates race', async () => {
    const created = await createTask({ title: 'Race' });

    await Promise.all([
      updateTask(created.id, { title: 'renamed' }),
      updateTask(created.id, { status: 'dismissed' }),
    ]);

    const loaded = await getTask(created.id);
    expect(loaded?.title).toBe('renamed');
    expect(loaded?.status).toBe('dismissed');
  });

  it('lists every task regardless of status', async () => {
    await createTask({ title: 'Open' });
    await createTask({ title: 'Done', status: 'done' });

    expect(await listTasks()).toHaveLength(2);
  });

  it('filters tasks by status', async () => {
    const open = await createTask({ title: 'Open' });
    await createTask({ title: 'Done', status: 'done' });
    await createTask({ title: 'Dismissed', status: 'dismissed' });

    expect((await listTasksByStatus('open')).map((t) => t.id)).toEqual([open.id]);
    expect(await listTasksByStatus('done')).toHaveLength(1);
  });

  it('finds the tasks generated from one event', async () => {
    const mine = await createTask({ title: 'Mine', source: 'calendar', eventId: 'e1' });
    await createTask({ title: 'Theirs', source: 'calendar', eventId: 'e2' });
    // A manual task has no eventId at all, so it must not be swept up here.
    await createTask({ title: 'Manual' });

    expect((await getTasksByEvent('e1')).map((t) => t.id)).toEqual([mine.id]);
    expect(await getTasksByEvent('e3')).toEqual([]);
  });

  it('deletes a task', async () => {
    const created = await createTask({ title: 'Doomed' });
    await deleteTask(created.id);
    expect(await getTask(created.id)).toBeUndefined();
    await expect(deleteTask('missing')).resolves.toBeUndefined();
  });
});
