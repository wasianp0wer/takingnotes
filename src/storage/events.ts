import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type {
  CalendarEventKind,
  CalendarEventRecord,
  CalendarEventSource,
} from '@/storage/types';

export interface CreateEventInput {
  title: string;
  kind: CalendarEventKind;
  startsAt: number;
  endsAt?: number | null;
  allDay?: boolean;
  /** Defaults copied onto a generated task. A14: an unset estimate is 60 minutes. */
  required?: boolean;
  estimatedMinutes?: number;
  notes?: string;
  source?: CalendarEventSource;
  sourceRef?: string | null;
  /** The migration and tests pass these; live creation lets them default to now. */
  createdAt?: number;
  updatedAt?: number;
}

export async function createEvent(input: CreateEventInput): Promise<CalendarEventRecord> {
  const now = Date.now();
  const event: CalendarEventRecord = {
    id: newId(),
    title: input.title,
    kind: input.kind,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    allDay: input.allDay ?? false,
    required: input.required ?? true,
    estimatedMinutes: input.estimatedMinutes ?? 60,
    notes: input.notes ?? '',
    source: input.source ?? 'manual',
    sourceRef: input.sourceRef ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  };

  const db = await openNotesDb();
  await db.put('events', event);
  return event;
}

export async function getEvent(id: string): Promise<CalendarEventRecord | undefined> {
  const db = await openNotesDb();
  return db.get('events', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 *
 * `updatedAt` is maintained here rather than by every caller - the task sync
 * reads it to decide what changed, and one caller forgetting to bump it would
 * make an edit invisible. A caller that needs a specific value (a re-import
 * replaying recorded timestamps) can still pass it in the patch.
 */
export async function updateEvent(
  id: string,
  patch: Partial<Omit<CalendarEventRecord, 'id'>>,
): Promise<CalendarEventRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('events', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Event not found: ${id}`);
  }
  const merged: CalendarEventRecord = {
    ...existing,
    updatedAt: Date.now(),
    ...patch,
    id: existing.id,
  };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

export async function deleteEvent(id: string): Promise<void> {
  const db = await openNotesDb();
  await db.delete('events', id);
}

/** Calendar order: earliest first. */
export async function listEvents(): Promise<CalendarEventRecord[]> {
  const db = await openNotesDb();
  return db.getAllFromIndex('events', 'by-start');
}

/** Events starting inside `[fromMs, toMs]`, both bounds inclusive, earliest first. */
export async function listEventsBetween(
  fromMs: number,
  toMs: number,
): Promise<CalendarEventRecord[]> {
  const db = await openNotesDb();
  return db.getAllFromIndex('events', 'by-start', IDBKeyRange.bound(fromMs, toMs));
}
