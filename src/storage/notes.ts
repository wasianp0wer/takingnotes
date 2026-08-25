import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { NoteRecord } from '@/storage/types';

export interface CreateNoteInput {
  title: string;
  deviceId: string;
  pageBaseline: number;
}

export async function createNote(input: CreateNoteInput): Promise<NoteRecord> {
  const note: NoteRecord = {
    id: newId(),
    title: input.title,
    status: 'active',
    deviceId: input.deviceId,
    deviceType: 'huion',
    startedAt: Date.now(),
    endedAt: null,
    pageBaseline: input.pageBaseline,
    summary: null,
    summaryModel: null,
    legacy: false,
  };

  const db = await openNotesDb();
  await db.put('notes', note);
  return note;
}

export async function getNote(id: string): Promise<NoteRecord | undefined> {
  const db = await openNotesDb();
  return db.get('notes', id);
}

export async function updateNote(
  id: string,
  patch: Partial<Omit<NoteRecord, 'id'>>,
): Promise<NoteRecord> {
  const db = await openNotesDb();
  const existing = await db.get('notes', id);
  if (!existing) {
    throw new Error(`Note not found: ${id}`);
  }
  const merged: NoteRecord = { ...existing, ...patch, id: existing.id };
  await db.put('notes', merged);
  return merged;
}

export async function listNotes(): Promise<NoteRecord[]> {
  const db = await openNotesDb();
  const ascending = await db.getAllFromIndex('notes', 'by-started');
  return ascending.reverse();
}

/** Deletes a note and every page belonging to it, in one transaction. */
export async function deleteNote(id: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(['notes', 'pages'], 'readwrite');

  await tx.objectStore('notes').delete(id);

  const index = tx.objectStore('pages').index('by-note');
  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}
