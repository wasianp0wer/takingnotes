import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { DeviceType, NoteRecord, NoteStatus } from '@/storage/types';

export interface CreateNoteInput {
  title: string;
  deviceId: string;
  pageBaseline: number;
  /**
   * Everything below is optional and defaults to the live-capture shape. The
   * legacy migration sets them so an imported note is complete after a single
   * write - a half-written note would be re-imported as a duplicate.
   */
  deviceType?: DeviceType;
  deviceName?: string | null;
  pageWidth?: number | null;
  pageHeight?: number | null;
  status?: NoteStatus;
  startedAt?: number;
  endedAt?: number | null;
  legacy?: boolean;
  legacySourceId?: string | null;
}

export async function createNote(input: CreateNoteInput): Promise<NoteRecord> {
  const note: NoteRecord = {
    id: newId(),
    title: input.title,
    status: input.status ?? 'active',
    deviceId: input.deviceId,
    deviceType: input.deviceType ?? 'huion',
    deviceName: input.deviceName ?? null,
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? null,
    pageBaseline: input.pageBaseline,
    pageWidth: input.pageWidth ?? null,
    pageHeight: input.pageHeight ?? null,
    summary: null,
    summaryModel: null,
    legacy: input.legacy ?? false,
    legacySourceId: input.legacySourceId ?? null,
  };

  const db = await openNotesDb();
  await db.put('notes', note);
  return note;
}

export async function getNote(id: string): Promise<NoteRecord | undefined> {
  const db = await openNotesDb();
  return db.get('notes', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 */
export async function updateNote(
  id: string,
  patch: Partial<Omit<NoteRecord, 'id'>>,
): Promise<NoteRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('notes', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    // Abort rather than let an empty transaction commit. `tx.done` rejects with
    // AbortError, so it is consumed here to keep it from surfacing as an
    // unhandled rejection.
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Note not found: ${id}`);
  }
  const merged: NoteRecord = { ...existing, ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

export async function listNotes(): Promise<NoteRecord[]> {
  const db = await openNotesDb();
  const ascending = await db.getAllFromIndex('notes', 'by-started');
  return ascending.reverse();
}

/**
 * Deletes a note, every page belonging to it, and every page render belonging
 * to those pages, in one transaction.
 */
export async function deleteNote(id: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(['notes', 'pages', 'pageRenders'], 'readwrite');

  await tx.objectStore('notes').delete(id);

  const renders = tx.objectStore('pageRenders');
  const index = tx.objectStore('pages').index('by-note');
  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await renders.delete(cursor.primaryKey);
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}
