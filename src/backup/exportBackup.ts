import { buildBackupBlob, encodeRecord, type BackupEntry } from '@/backup/format';
import { BACKUP_STORES, OUT_OF_LINE_STORES, isBackupLocalStorageKey } from '@/backup/stores';
import { DB_VERSION, openNotesDb } from '@/storage/db';

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function collectLocalStorage(storage: Storage | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null || !isBackupLocalStorageKey(key)) continue;
      const value = storage.getItem(key);
      if (value !== null) out[key] = value;
    }
  } catch {
    // Unreadable storage: export what we have.
  }
  return out;
}

/**
 * Builds a `.tnbackup` Blob of every backed-up store plus the app's
 * localStorage. Each binary is wrapped in a Blob the moment it is encoded so
 * no list of ArrayBuffers is held.
 */
export async function exportBackup(opts: {
  appVersion: string;
  now?: () => number;
  storage?: Storage | null;
}): Promise<Blob> {
  const now = opts.now ?? Date.now;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const db = await openNotesDb();
  const parts: Blob[] = [];
  const sink = (buf: ArrayBuffer): number => parts.push(new Blob([buf])) - 1;
  const stores: Record<string, BackupEntry[]> = {};

  // One read transaction across all stores: a consistent snapshot.
  const tx = db.transaction([...BACKUP_STORES], 'readonly');
  for (const name of BACKUP_STORES) {
    const entries: BackupEntry[] = [];
    const outOfLine = OUT_OF_LINE_STORES.includes(name);
    let cursor = await tx.objectStore(name).openCursor();
    while (cursor) {
      entries.push({
        key: outOfLine ? cursor.key : null,
        value: encodeRecord(cursor.value, sink),
      });
      cursor = await cursor.continue();
    }
    stores[name] = entries;
  }
  await tx.done;

  return buildBackupBlob(
    {
      format: 1,
      appVersion: opts.appVersion,
      dbVersion: DB_VERSION,
      exportedAt: now(),
      stores,
      localStorage: collectLocalStorage(storage),
    },
    parts,
  );
}

/** `takingnotes-backup-YYYY-MM-DD.tnbackup`, date in local time. */
export function backupFileName(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `takingnotes-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.tnbackup`;
}
