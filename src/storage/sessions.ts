import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { SessionRecord, SessionStatus } from '@/storage/types';

export interface CreateSessionInput {
  title: string;
  /** All optional; the defaults are the live-capture shape (a session that just began). */
  status?: SessionStatus;
  startedAt?: number;
  endedAt?: number | null;
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const session: SessionRecord = {
    id: newId(),
    title: input.title,
    status: input.status ?? 'active',
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? null,
  };

  const db = await openNotesDb();
  await db.put('sessions', session);
  return session;
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  const db = await openNotesDb();
  return db.get('sessions', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 */
export async function updateSession(
  id: string,
  patch: Partial<Omit<SessionRecord, 'id'>>,
): Promise<SessionRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('sessions', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Session not found: ${id}`);
  }
  const merged: SessionRecord = { ...existing, ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/** Newest first, matching `listNotes`. */
export async function listSessions(): Promise<SessionRecord[]> {
  const db = await openNotesDb();
  const ascending = await db.getAllFromIndex('sessions', 'by-started');
  return ascending.reverse();
}
