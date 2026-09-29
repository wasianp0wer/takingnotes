import { beforeEach, describe, expect, it } from 'vitest';

import { createTask, getTask } from '@/storage/tasks';
import { resetDatabase } from '@/test/resetDb';
import { completeTask, dismissTask } from '@/triage/taskActions';

beforeEach(resetDatabase);

describe('completeTask', () => {
  it('marks the task done and records when it was completed', async () => {
    const task = await createTask({ title: 'Read chapter 4' });

    const done = await completeTask(task.id, 1234);

    expect(done.status).toBe('done');
    expect(done.completedAt).toBe(1234);
    expect(await getTask(task.id)).toMatchObject({ status: 'done', completedAt: 1234 });
  });

  it('defaults the completion time to now', async () => {
    const task = await createTask({ title: 'Read chapter 5' });
    const before = Date.now();

    const done = await completeTask(task.id);

    expect(done.completedAt).toBeGreaterThanOrEqual(before);
    expect(done.completedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('dismissTask', () => {
  it('marks the task dismissed and leaves completedAt null', async () => {
    const task = await createTask({ title: 'Optional reading' });

    const dismissed = await dismissTask(task.id);

    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.completedAt).toBeNull();
    expect(await getTask(task.id)).toMatchObject({ status: 'dismissed', completedAt: null });
  });

  it('clears a completion time left by an earlier done', async () => {
    const task = await createTask({ title: 'Changed my mind' });
    await completeTask(task.id, 1234);

    const dismissed = await dismissTask(task.id);

    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.completedAt).toBeNull();
  });
});
