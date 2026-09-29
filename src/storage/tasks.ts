import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { TaskRecord, TaskSource, TaskStatus } from '@/storage/types';

export interface CreateTaskInput {
  title: string;
  /** A14: an unset estimate is 60 minutes. */
  required?: boolean;
  estimatedMinutes?: number;
  dueAt?: number | null;
  status?: TaskStatus;
  source?: TaskSource;
  /** Set when `source === 'calendar'`. */
  eventId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number | null;
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const now = Date.now();
  const task: TaskRecord = {
    id: newId(),
    title: input.title,
    required: input.required ?? true,
    estimatedMinutes: input.estimatedMinutes ?? 60,
    dueAt: input.dueAt ?? null,
    status: input.status ?? 'open',
    source: input.source ?? 'manual',
    eventId: input.eventId ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
    completedAt: input.completedAt ?? null,
  };

  const db = await openNotesDb();
  await db.put('tasks', task);
  return task;
}

export async function getTask(id: string): Promise<TaskRecord | undefined> {
  const db = await openNotesDb();
  return db.get('tasks', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten. `updatedAt` is maintained here, as in `updateEvent`;
 * `completedAt` is left to the caller, because "done" is a policy decision the
 * triage layer owns.
 */
export async function updateTask(
  id: string,
  patch: Partial<Omit<TaskRecord, 'id'>>,
): Promise<TaskRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('tasks', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Task not found: ${id}`);
  }
  const merged: TaskRecord = { ...existing, updatedAt: Date.now(), ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

export async function deleteTask(id: string): Promise<void> {
  const db = await openNotesDb();
  await db.delete('tasks', id);
}

/**
 * Unordered (primary-key order). Tasks are displayed by priority score, which
 * is computed from `now` at render time and never stored, so there is no
 * ordering this layer could usefully impose.
 */
export async function listTasks(): Promise<TaskRecord[]> {
  const db = await openNotesDb();
  return db.getAll('tasks');
}

export async function listTasksByStatus(status: TaskStatus): Promise<TaskRecord[]> {
  const db = await openNotesDb();
  return db.getAllFromIndex('tasks', 'by-status', IDBKeyRange.only(status));
}

/**
 * Every task generated from one event, whatever its status - the sync needs the
 * done and dismissed ones too, so it never re-creates them. Tasks with no
 * `eventId` are absent from the index entirely (IndexedDB skips null keys), so
 * manual tasks can never be swept up here.
 */
export async function getTasksByEvent(eventId: string): Promise<TaskRecord[]> {
  const db = await openNotesDb();
  return db.getAllFromIndex('tasks', 'by-event', IDBKeyRange.only(eventId));
}
