import { ACTIVE_DB_KEY } from '@/storage/activeDb';

/**
 * Every store worth backing up, in `db.ts` creation order. `pcmCache` is
 * omitted: it is a transient, re-derivable cache.
 */
export const BACKUP_STORES = [
  'notes',
  'pages',
  'pageRenders',
  'settings',
  'sessions',
  'recordings',
  'recordingAudio',
  'events',
  'tasks',
  'gaps',
  'recordingChunks',
] as const;

export type BackupStoreName = (typeof BACKUP_STORES)[number];

/** Stores with out-of-line keys: their entries carry an explicit key. */
export const OUT_OF_LINE_STORES: readonly BackupStoreName[] = ['pageRenders', 'recordingAudio'];

/**
 * The app's own localStorage keys (`takingnotes.*` and the legacy
 * `takingnotes_*`), minus the active-database pointer, which names a
 * per-install database and must not travel with a backup.
 */
export function isBackupLocalStorageKey(key: string): boolean {
  if (key === ACTIVE_DB_KEY) return false;
  return key.startsWith('takingnotes.') || key.startsWith('takingnotes_');
}
