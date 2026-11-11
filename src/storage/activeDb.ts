import { DB_NAME } from '@/storage/db';

/** localStorage key naming the IndexedDB database the app should open. */
export const ACTIVE_DB_KEY = 'takingnotes.activeDb';
/**
 * localStorage key listing databases an import replaced (JSON array of
 * names). Import never deletes the previous database; a later start does,
 * once the pointer has verifiably survived (`src/backup/retiredDb.ts`).
 */
export const RETIRED_DB_KEY = 'takingnotes.retiredDb';
const PROBE_KEY = `${ACTIVE_DB_KEY}.probe`;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True for `takingnotes` or `takingnotes-<suffix>`: a name this app's databases use. */
export function isValidDbName(name: string | null): name is string {
  return (
    name === DB_NAME ||
    (name !== null && name.startsWith(`${DB_NAME}-`) && name.length > DB_NAME.length + 1)
  );
}

/** The pointed-to database name; `DB_NAME` when unset, foreign, or storage throws. */
export function getActiveDbName(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): string {
  try {
    const value = storage?.getItem(ACTIVE_DB_KEY) ?? null;
    return isValidDbName(value) ? value : DB_NAME;
  } catch {
    return DB_NAME;
  }
}

/** Writes the pointer and reads it back; throws if it did not stick. */
export function setActiveDbName(name: string, storage: Storage | null = defaultStorage()): void {
  if (!storage) throw new Error('No storage available to hold the active database name');
  storage.setItem(ACTIVE_DB_KEY, name);
  if (storage.getItem(ACTIVE_DB_KEY) !== name) {
    throw new Error('Active database name was not persisted');
  }
}

/** True when the pointer can be written (probe write + remove succeeds). */
export function canSwitchDatabase(storage: Storage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}
