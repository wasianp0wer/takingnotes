import { updateTask } from '@/storage/tasks';
import type { TaskRecord } from '@/storage/types';

/** `completedAt` is the triage layer's decision (architecture §2.4). */
export function completeTask(id: string, now: number = Date.now()): Promise<TaskRecord> {
  return updateTask(id, { status: 'done', completedAt: now });
}

export function dismissTask(id: string): Promise<TaskRecord> {
  return updateTask(id, { status: 'dismissed', completedAt: null });
}
