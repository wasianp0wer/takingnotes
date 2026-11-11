import type { IDBPDatabase } from 'idb';

import {
  BackupFormatError,
  decodeRecord,
  readBackupHeader,
  sliceBinary,
  type BackupEntry,
  type BackupManifest,
} from '@/backup/format';
import { ImportBlockedError, findImportBlockers } from '@/backup/guards';

export { ImportBlockedError };
import {
  BACKUP_STORES,
  OUT_OF_LINE_STORES,
  isBackupLocalStorageKey,
  type BackupStoreName,
} from '@/backup/stores';
import { markImportedThisSession, retireDatabase } from '@/backup/retiredDb';
import { ACTIVE_DB_KEY, RETIRED_DB_KEY, getActiveDbName, setActiveDbName } from '@/storage/activeDb';
import { DB_NAME, DB_VERSION, closeNotesDb, openNamedDb, type NotesDb } from '@/storage/db';

export type BackupSummary = {
  appVersion: string;
  exportedAt: number;
  dbVersion: number;
  counts: Record<string, number>;
};

export class BackupTooNewError extends Error {
  readonly dbVersion: number;
  constructor(dbVersion: number) {
    super(
      `This backup was made by a newer version of the app (database v${dbVersion}; this app reads up to v${DB_VERSION}). Update the app, then import it.`,
    );
    this.dbVersion = dbVersion;
    this.name = 'BackupTooNewError';
  }
}

const MAX_BATCH_RECORDS = 50;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const NO_BYTES = new ArrayBuffer(0);

const corrupt = (message: string) => new BackupFormatError('corrupt', message);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNonNegativeInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** The `$tnbin` indexes a record references, validated against the binaries table. */
function binaryIndexes(value: unknown, binaryCount: number): number[] {
  const out: number[] = [];
  decodeRecord(value, (index) => {
    if (!isNonNegativeInt(index) || index >= binaryCount) {
      throw corrupt(`Record references a missing binary (${index})`);
    }
    out.push(index);
    return NO_BYTES;
  });
  return out;
}

/**
 * `readBackupHeader` checks only the outer frame. Everything the import will
 * trust is checked here, before a single write.
 */
function validateManifest(manifest: BackupManifest, binaryStart: number, fileSize: number): void {
  const m = manifest as unknown as Record<string, unknown>;
  if (typeof m.appVersion !== 'string') throw corrupt('appVersion is not a string');
  if (!Number.isInteger(m.dbVersion) || (m.dbVersion as number) < 1) {
    throw corrupt('dbVersion is not a positive integer');
  }
  // Checked before the rest: a newer format may lay out its manifest differently.
  if ((m.dbVersion as number) > DB_VERSION) throw new BackupTooNewError(m.dbVersion as number);
  if (typeof m.exportedAt !== 'number' || !Number.isFinite(m.exportedAt)) {
    throw corrupt('exportedAt is not a number');
  }

  if (!Array.isArray(m.binaries)) throw corrupt('binaries is not an array');
  for (const ref of m.binaries as unknown[]) {
    if (!isPlainObject(ref) || !isNonNegativeInt(ref.offset) || !isNonNegativeInt(ref.length)) {
      throw corrupt('Malformed binary reference');
    }
    if (binaryStart + ref.offset + ref.length > fileSize) {
      throw new BackupFormatError('truncated', 'A binary runs past the end of the file');
    }
  }
  const binaryCount = (m.binaries as unknown[]).length;

  if (!isPlainObject(m.localStorage)) throw corrupt('localStorage is not an object');
  for (const value of Object.values(m.localStorage)) {
    if (typeof value !== 'string') throw corrupt('localStorage holds a non-string value');
  }

  if (!isPlainObject(m.stores)) throw corrupt('stores is not an object');
  for (const [name, entries] of Object.entries(m.stores)) {
    if (!Array.isArray(entries)) throw corrupt(`Store ${name} is not an array`);
    const outOfLine = (OUT_OF_LINE_STORES as readonly string[]).includes(name);
    for (const entry of entries as unknown[]) {
      if (!isPlainObject(entry) || !('key' in entry) || !('value' in entry)) {
        throw corrupt(`Malformed entry in ${name}`);
      }
      const { key } = entry;
      if (outOfLine && typeof key !== 'string' && !(typeof key === 'number' && Number.isFinite(key))) {
        throw corrupt(`Entry in ${name} lacks its key`);
      }
      binaryIndexes(entry.value, binaryCount);
    }
  }
}

async function readValidated(file: Blob): Promise<{ manifest: BackupManifest; binaryStart: number }> {
  const { manifest, binaryStart } = await readBackupHeader(file);
  validateManifest(manifest, binaryStart, file.size);
  return { manifest, binaryStart };
}

function entriesOf(manifest: BackupManifest, store: BackupStoreName): BackupEntry[] {
  return Object.hasOwn(manifest.stores, store) ? manifest.stores[store] : [];
}

function summarise(manifest: BackupManifest): BackupSummary {
  const counts: Record<string, number> = {};
  for (const store of BACKUP_STORES) counts[store] = entriesOf(manifest, store).length;
  return {
    appVersion: manifest.appVersion,
    exportedAt: manifest.exportedAt,
    dbVersion: manifest.dbVersion,
    counts,
  };
}

/** Reads and validates a backup's header without writing anything. */
export async function inspectBackup(file: Blob): Promise<BackupSummary> {
  return summarise((await readValidated(file)).manifest);
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Resolves once the delete settles either way; a blocked delete is not waited on. */
function deleteDatabaseBestEffort(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Splits a store's entries into batches of ≤ 50 records and ≤ 64 MB of binaries. */
function* batches(
  entries: BackupEntry[],
  manifest: BackupManifest,
): Generator<{ entries: BackupEntry[]; binaries: number[] }> {
  let current: BackupEntry[] = [];
  let currentBinaries = new Set<number>();
  let bytes = 0;
  for (const entry of entries) {
    const refs = binaryIndexes(entry.value, manifest.binaries.length);
    const size = refs.reduce((sum, i) => sum + manifest.binaries[i].length, 0);
    if (current.length > 0 && (current.length >= MAX_BATCH_RECORDS || bytes + size > MAX_BATCH_BYTES)) {
      yield { entries: current, binaries: [...currentBinaries] };
      current = [];
      currentBinaries = new Set();
      bytes = 0;
    }
    current.push(entry);
    for (const i of refs) currentBinaries.add(i);
    bytes += size;
  }
  if (current.length > 0) yield { entries: current, binaries: [...currentBinaries] };
}

async function writeBatch(
  db: IDBPDatabase<NotesDb>,
  store: BackupStoreName,
  batch: { entries: BackupEntry[]; binaries: number[] },
  file: Blob,
  manifest: BackupManifest,
  binaryStart: number,
): Promise<void> {
  // Load every binary before opening the transaction: awaiting file reads
  // inside it would let it auto-commit half-written.
  const loaded = new Map<number, ArrayBuffer>();
  for (const i of batch.binaries) {
    loaded.set(i, await sliceBinary(file, binaryStart, manifest.binaries[i]).arrayBuffer());
  }
  const values = batch.entries.map((entry) =>
    decodeRecord(entry.value, (i) => loaded.get(i) as ArrayBuffer),
  );

  const outOfLine = OUT_OF_LINE_STORES.includes(store);
  const tx = db.transaction(store, 'readwrite');
  const pending: Promise<unknown>[] = [tx.done];
  try {
    const objectStore = tx.objectStore(store);
    batch.entries.forEach((entry, n) => {
      pending.push(
        outOfLine
          ? objectStore.put(values[n] as never, entry.key as never)
          : objectStore.put(values[n] as never),
      );
    });
  } catch (err) {
    // Swallow the rejections the abort causes; the original error wins.
    for (const p of pending) p.catch(() => {});
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    throw err;
  }
  await Promise.all(pending);
}

async function verifyCounts(db: IDBPDatabase<NotesDb>, manifest: BackupManifest): Promise<void> {
  const tx = db.transaction([...BACKUP_STORES], 'readonly');
  for (const store of BACKUP_STORES) {
    const actual = await tx.objectStore(store).count();
    const expected = entriesOf(manifest, store).length;
    if (actual !== expected) {
      throw new Error(`Import check failed: ${store} count is ${actual}, expected ${expected}`);
    }
  }
  await tx.done;
}

function restoreItem(storage: Storage, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

/**
 * Replaces the app's localStorage keys, records `oldName` as retired, then
 * switches the pointer; restores all three if anything throws. The retired
 * record is written before the pointer, so a pointer that sticks always has
 * it, and the old database is deleted only by a later, verified start
 * (`cleanupRetiredDatabases`).
 */
function swapIn(storage: Storage, manifest: BackupManifest, staging: string, oldName: string): void {
  const previous = new Map<string, string>();
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && isBackupLocalStorageKey(key)) previous.set(key, storage.getItem(key) ?? '');
  }
  const previousPointer = storage.getItem(ACTIVE_DB_KEY);
  const previousRetired = storage.getItem(RETIRED_DB_KEY);
  try {
    for (const key of previous.keys()) storage.removeItem(key);
    for (const [key, value] of Object.entries(manifest.localStorage)) {
      if (isBackupLocalStorageKey(key)) storage.setItem(key, value);
    }
    if (oldName !== staging) retireDatabase(oldName, storage);
    setActiveDbName(staging, storage);
  } catch (err) {
    try {
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const key = storage.key(i);
        if (key !== null && isBackupLocalStorageKey(key)) storage.removeItem(key);
      }
      for (const [key, value] of previous) storage.setItem(key, value);
      restoreItem(storage, ACTIVE_DB_KEY, previousPointer);
      restoreItem(storage, RETIRED_DB_KEY, previousRetired);
    } catch {
      // Storage refused the rollback too; the pointer write above failed, so
      // the old database is still the one that opens.
    }
    throw err;
  }
}

/**
 * Replaces every backed-up store and the app's localStorage keys with the
 * backup's contents, all or nothing. The data is written to a fresh staging
 * database and only becomes live when the active-db pointer is switched to
 * it, so any failure before that leaves the current data exactly as it was.
 * The previous database is never deleted here: it is recorded as retired and
 * removed on a later start once the pointer verifies (`./retiredDb`). The
 * caller flushes storage (desktop) and reloads the page afterwards.
 *
 * `countTabs`, `openStaging` and `session` exist for tests.
 */
export async function importBackup(
  file: Blob,
  opts: {
    onProgress?: (done: number, total: number) => void;
    storage?: Storage;
    countTabs?: () => Promise<number | null>;
    openStaging?: (name: string) => Promise<IDBPDatabase<NotesDb>>;
    /** sessionStorage for the import marker; defaults to the global one. */
    session?: Storage | null;
  } = {},
): Promise<void> {
  const { manifest, binaryStart } = await readValidated(file);

  const storage = opts.storage ?? defaultStorage();
  const checkBlockers = async () => {
    const blockers = await findImportBlockers({ countTabs: opts.countTabs, storage });
    if (blockers.length > 0) throw new ImportBlockedError(blockers);
  };
  await checkBlockers();
  if (!storage) throw new ImportBlockedError(['storage-blocked']);

  const oldName = getActiveDbName(storage);
  const staging = `${DB_NAME}-${Date.now().toString(36)}`;
  const openStaging = opts.openStaging ?? openNamedDb;
  const total = BACKUP_STORES.reduce((sum, s) => sum + entriesOf(manifest, s).length, 0);
  let done = 0;

  let db: IDBPDatabase<NotesDb> | null = null;
  try {
    // ⚑ MIGRATION DEBT (I2): staging opens at the current DB_VERSION, so an
    // older backup's records skip every `if (oldVersion < N)` block in
    // `upgradeNotesDb`. Harmless while versions 1-5 are schema-only. Any
    // future version bump that migrates DATA must first change this to open
    // staging at `manifest.dbVersion`, write the records, close, and reopen
    // at DB_VERSION so the upgrade runs over them.
    db = await openStaging(staging);
    opts.onProgress?.(0, total);
    for (const store of BACKUP_STORES) {
      for (const batch of batches(entriesOf(manifest, store), manifest)) {
        await writeBatch(db, store, batch, file, manifest, binaryStart);
        done += batch.entries.length;
        opts.onProgress?.(done, total);
      }
    }
    await verifyCounts(db, manifest);
    db.close();
    db = null;
    // A long import gives a recording, transcription or new tab time to
    // start writing to the old database; those writes would be lost at the
    // swap, so check again right before it.
    await checkBlockers();
    await closeNotesDb();
    // Before the swap: the importing tab (and its reload) must never delete
    // the retired database. Throws, aborting the import, if it can't be set.
    markImportedThisSession(opts.session);
    swapIn(storage, manifest, staging, oldName);
  } catch (err) {
    db?.close();
    await deleteDatabaseBestEffort(staging);
    throw err;
  }
}
