import { BACKUP_STORES } from '@/backup/stores';
import { ACTIVE_DB_KEY, RETIRED_DB_KEY, getActiveDbName, isValidDbName } from '@/storage/activeDb';

/**
 * Databases an import replaced, and their deferred deletion.
 *
 * Import never deletes the previous database: the only record of the new one
 * is the `takingnotes.activeDb` pointer in localStorage, which Chromium writes
 * to disk lazily. If that write is lost (a crash or force-quit right after the
 * import), the app opens the previous database again, so it has to still be
 * there. Its name is recorded under `RETIRED_DB_KEY` instead, and a later start
 * deletes it once the pointer and the database it names both check out.
 */

/**
 * sessionStorage marker set by the import, before the swap. While it is
 * present (the importing tab, including its post-import reload), cleanup
 * keeps everything: there the pointer reading back proves only that it is in
 * Chromium's in-memory DOMStorage, not that it reached disk. A new browser
 * session starts without it.
 */
export const IMPORTED_THIS_SESSION_KEY = 'takingnotes.importedThisSession';

/** Every store `upgradeNotesDb` creates at DB_VERSION. */
const EXPECTED_STORES: readonly string[] = [...BACKUP_STORES, 'pcmCache'];

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultSession(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Marks this browser session as the one that imported. Throws if it can't. */
export function markImportedThisSession(session: Storage | null = defaultSession()): void {
  if (!session) throw new Error('No sessionStorage to mark the import in');
  session.setItem(IMPORTED_THIS_SESSION_KEY, String(Date.now()));
  if (session.getItem(IMPORTED_THIS_SESSION_KEY) === null) {
    throw new Error('Import marker was not persisted');
  }
}

/** The recorded names; [] when unset or unreadable. */
function readRetired(storage: Pick<Storage, 'getItem'>): string[] {
  const raw = storage.getItem(RETIRED_DB_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('retiredDb is not a list');
  return parsed.filter((n): n is string => typeof n === 'string');
}

/**
 * Records `name` for deletion on a later start, keeping any name already
 * waiting. Throws if storage refuses the write; the caller writes this
 * before switching the pointer.
 */
export function retireDatabase(name: string, storage: Storage): void {
  let names: string[];
  try {
    names = readRetired(storage);
  } catch {
    names = [];
  }
  if (!names.includes(name)) names.push(name);
  storage.setItem(RETIRED_DB_KEY, JSON.stringify(names));
}

/**
 * Whether `name` exists and has every store the app expects. Opens without a
 * version so nothing is upgraded, and aborts the creation if it doesn't exist.
 */
function hasExpectedStores(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name);
    } catch {
      resolve(false);
      return;
    }
    request.onupgradeneeded = () => {
      // Only fires when the database does not exist; abort so it isn't created.
      request.transaction?.abort();
    };
    request.onerror = (event) => {
      event.preventDefault();
      resolve(false);
    };
    request.onblocked = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const ok = EXPECTED_STORES.every((store) => db.objectStoreNames.contains(store));
      db.close();
      resolve(ok);
    };
  });
}

/** True only when the delete succeeded; blocked or failed deletes are retried next start. */
function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Deletes the databases an import retired, but only when all of these hold:
 * this is not the browser session that imported (no
 * `IMPORTED_THIS_SESSION_KEY`, and sessionStorage readable); the pointer
 * reads back to a valid name; the database it names opens with
 * every expected store; and the retired name is neither the pointer nor
 * `getActiveDbName()`. Otherwise everything is kept for a later start.
 * Best-effort: never throws.
 */
export async function cleanupRetiredDatabases(
  storage: Storage | null = defaultStorage(),
  session: Storage | null = defaultSession(),
): Promise<void> {
  try {
    // Unreadable sessionStorage or the importing session: keep everything.
    if (!session || session.getItem(IMPORTED_THIS_SESSION_KEY) !== null) return;
    if (!storage) return;
    const retired = readRetired(storage);
    if (retired.length === 0) return;

    const pointer = storage.getItem(ACTIVE_DB_KEY);
    if (!isValidDbName(pointer)) return;
    if (!(await hasExpectedStores(pointer))) return;
    // Re-read after the await: the pointer must still be the one verified.
    if (storage.getItem(ACTIVE_DB_KEY) !== pointer) return;
    const active = getActiveDbName(storage);

    const deleted: string[] = [];
    for (const name of retired) {
      if (!isValidDbName(name) || name === pointer || name === active) continue;
      if (await deleteDatabase(name)) deleted.push(name);
    }
    if (deleted.length === 0) return;

    const remaining = readRetired(storage).filter((n) => !deleted.includes(n));
    if (remaining.length === 0) storage.removeItem(RETIRED_DB_KEY);
    else storage.setItem(RETIRED_DB_KEY, JSON.stringify(remaining));
  } catch {
    // Keep everything; a later start tries again.
  }
}
