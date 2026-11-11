import { countOpenTabs } from '@/backup/tabPresence';
import { canSwitchDatabase } from '@/storage/activeDb';
import { openNotesDb } from '@/storage/db';

export type ImportBlocker =
  | 'other-tabs'
  | 'session-active'
  | 'recording-active'
  | 'transcription-running'
  | 'storage-blocked';

export class ImportBlockedError extends Error {
  readonly blockers: ImportBlocker[];
  constructor(blockers: ImportBlocker[]) {
    super(`Import is blocked: ${blockers.join(', ')}`);
    this.blockers = blockers;
    this.name = 'ImportBlockedError';
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isBusy = (status: unknown) => status === 'pending' || status === 'running';

/**
 * Everything that makes replacing the database unsafe right now. An unknown
 * tab count (no Web Locks) is not a blocker: the desktop build has one window.
 */
export async function findImportBlockers(
  deps: { countTabs?: () => Promise<number | null>; storage?: Storage | null } = {},
): Promise<ImportBlocker[]> {
  const countTabs = deps.countTabs ?? (() => countOpenTabs());
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const blockers = new Set<ImportBlocker>();

  const tabs = await countTabs();
  if (tabs !== null && tabs > 1) blockers.add('other-tabs');

  const db = await openNotesDb();
  const tx = db.transaction(['sessions', 'notes', 'recordings', 'pages'], 'readonly');
  for (const session of await tx.objectStore('sessions').getAll()) {
    if (session.status === 'active') blockers.add('session-active');
  }
  for (const note of await tx.objectStore('notes').getAll()) {
    if (note.status === 'active') blockers.add('session-active');
  }
  for (const recording of await tx.objectStore('recordings').getAll()) {
    if (recording.endedAt === null) blockers.add('recording-active');
    if (isBusy(recording.transcript?.status)) blockers.add('transcription-running');
  }
  // Pages carry strokes, so walk them with a cursor instead of loading all at once.
  let cursor = await tx.objectStore('pages').openCursor();
  while (cursor) {
    if (isBusy(cursor.value.transcript?.status)) blockers.add('transcription-running');
    cursor = await cursor.continue();
  }
  await tx.done;

  if (!canSwitchDatabase(storage)) blockers.add('storage-blocked');

  const order: ImportBlocker[] = [
    'other-tabs',
    'session-active',
    'recording-active',
    'transcription-running',
    'storage-blocked',
  ];
  return order.filter((b) => blockers.has(b));
}
