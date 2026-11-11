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

/** Every store `upgradeNotesDb` creates at DB_VERSION. */
const EXPECTED_STORES: readonly string[] = [...BACKUP_STORES, 'pcmCache'];

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
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
 * the pointer reads back to a valid name; the database it names opens with
 * every expected store; and the retired name is neither the pointer nor
 * `getActiveDbName()`. Otherwise everything is kept for a later start.
 * Best-effort: never throws.
 */
export async function cleanupRetiredDatabases(
  storage: Storage | null = defaultStorage(),
): Promise<void> {
  try {
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
