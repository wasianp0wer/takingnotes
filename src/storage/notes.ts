import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { DeviceType, NoteRecord, NoteStatus, TitleSource } from '@/storage/types';

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
  /** Null for legacy or imported notes, which belong to no session. */
  sessionId?: string | null;
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
    sessionId: input.sessionId ?? null,
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
 * The notes of one session, oldest first: within a session, chronological order
 * is the useful one. Notes whose `sessionId` is null or absent are not in the
 * index at all (IndexedDB skips null keys), so they can never be swept up here.
 */
export async function listNotesBySession(sessionId: string): Promise<NoteRecord[]> {
  const db = await openNotesDb();
  const notes = await db.getAllFromIndex('notes', 'by-session', IDBKeyRange.only(sessionId));
  return notes.sort((a, b) => a.startedAt - b.startedAt);
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

/**
 * K3: trimmed, lowercased, deduplicated, blanks dropped. First-seen order is
 * preserved rather than sorted, so writing a note's tags back does not
 * reshuffle them under the user's cursor.
 */
export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().toLowerCase();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Absent on pre-v4 rows, which reads as no tags. */
export function tagsOf(note: NoteRecord): string[] {
  return note.tags ?? [];
}

/** Absent on pre-v4 rows, which reads as the `Note <timestamp>` placeholder. */
export function titleSourceOf(note: NoteRecord): TitleSource {
  return note.titleSource ?? 'default';
}

export function setNoteTags(id: string, tags: readonly string[]): Promise<NoteRecord> {
  return updateNote(id, { tags: normalizeTags(tags) });
}

/**
 * A manual rename. Sets `titleSource: 'manual'`, which permanently opts this
 * note out of auto-titling (K20, A34) - the sticky flag is the whole point, so
 * this is the only path that writes a title by hand.
 */
// `async` deliberately, though nothing here awaits: a plain function that
// throws synchronously while declaring `Promise<NoteRecord>` rejects its
// *caller* rather than its promise, so `await expect(...).rejects` never
// sees it and every caller needs a try/catch around the call itself as
// well as around the await. `async` makes the throw a rejection.
export async function renameNote(id: string, title: string): Promise<NoteRecord> {
  const trimmed = title.trim();
  // A blank title would leave the note unidentifiable in the list, with no way
  // back except editing it again from a row that no longer names anything.
  if (trimmed === '') throw new Error('A note title cannot be blank');
  return updateNote(id, { title: trimmed, titleSource: 'manual' });
}

export interface NoteSummaryInput {
  summary: string;
  model: string;
  promptVersion: string;
  /** Written only when the title has not been set by hand (K18). */
  title?: string;
}

/**
 * K18: the summary always lands; the title lands only when the user has not
 * renamed the note. Read-modify-write in one transaction via `updateNote`,
 * after reading the existing row to decide about the title - two separate
 * transactions would let a rename land in between and be overwritten.
 */
export async function setNoteSummary(id: string, input: NoteSummaryInput): Promise<NoteRecord> {
  const existing = await getNote(id);
  if (!existing) throw new Error(`Note not found: ${id}`);

  const patch: Partial<Omit<NoteRecord, 'id'>> = {
    summary: input.summary,
    summaryModel: input.model,
    summaryPromptVersion: input.promptVersion,
  };

  const title = input.title?.trim() ?? '';
  // A blank generated title is a failed generation, not an instruction to
  // clear the title.
  if (title !== '' && titleSourceOf(existing) !== 'manual') {
    patch.title = title;
    patch.titleSource = 'auto';
  }
  return updateNote(id, patch);
}

/**
 * A35: derived by scanning rather than stored. A stored vocabulary would be a
 * cache to invalidate on every tag write, and the note count here is in the
 * hundreds.
 */
export async function listTagVocabulary(): Promise<string[]> {
  const notes = await listNotes();
  const all = new Set<string>();
  for (const note of notes) for (const tag of tagsOf(note)) all.add(tag);
  return [...all].sort();
}
