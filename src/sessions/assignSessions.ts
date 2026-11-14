import { createEmitter } from '@/device/emitter';
import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import { listNotes } from '@/storage/notes';
import type { NoteRecord, SessionRecord } from '@/storage/types';

/**
 * The start-up sweep that puts every note in a session (small improvements,
 * goal 7). Legacy notes (`sessionId: null`, from `migrateLegacyNotebooks`) and
 * notes from a v1 backup (no `sessionId` field) get a session of their own,
 * already ended, with the note's title and times.
 *
 * App-level rather than a `DB_VERSION` step: a backup import bypasses upgrade
 * blocks (handoff I2), so it runs on every start and must be idempotent.
 */

export interface AssignSessionsOptions {
  /** The note the capture engine has open, which the sweep must leave alone. */
  activeNoteId?: () => string | null;
}

const assigned = createEmitter<number>();

/**
 * Fires once after a sweep that linked at least one note, with the count. The
 * catalog reloads on it: the sweep runs alongside the Sessions view's first
 * load, which may already have grouped those notes as uncategorized.
 */
export function subscribeSessionsAssigned(listener: (count: number) => void): () => void {
  return assigned.subscribe(listener);
}

/**
 * Overlapping calls share one run (StrictMode mounts twice; a second caller
 * must not see the same orphans and give each a second session).
 */
let inFlight: Promise<number> | null = null;

export function assignSessionsToOrphanNotes(opts: AssignSessionsOptions = {}): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = sweep(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function sweep(opts: AssignSessionsOptions): Promise<number> {
  const notes = await listNotes();
  const activeId = opts.activeNoteId?.() ?? null;
  let count = 0;
  for (const note of notes) {
    if (typeof note.sessionId === 'string' || note.id === activeId) continue;
    if (await linkToNewSession(note.id)) count += 1;
  }
  if (count > 0) assigned.emit(count);
  return count;
}

/**
 * Creates the session and links the note in one transaction, re-reading the
 * note inside it: a note something else put in a session since the list was
 * read (a resume, an earlier sweep) is left as it is, and a failure leaves
 * neither write behind - so a retry can never give a note a second session.
 */
async function linkToNewSession(noteId: string): Promise<boolean> {
  const db = await openNotesDb();
  const tx = db.transaction(['notes', 'sessions'], 'readwrite');
  const notes = tx.objectStore('notes');
  const note: NoteRecord | undefined = await notes.get(noteId);
  if (!note || typeof note.sessionId === 'string') {
    await tx.done;
    return false;
  }
  const session: SessionRecord = {
    id: newId(),
    title: note.title,
    status: 'ended',
    startedAt: note.startedAt,
    endedAt: note.endedAt ?? note.startedAt,
  };
  await tx.objectStore('sessions').put(session);
  await notes.put({ ...note, sessionId: session.id });
  await tx.done;
  return true;
}
