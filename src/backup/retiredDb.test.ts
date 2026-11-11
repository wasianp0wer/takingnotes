import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMPORTED_THIS_SESSION_KEY, cleanupRetiredDatabases, retireDatabase } from '@/backup/retiredDb';
import { ACTIVE_DB_KEY, RETIRED_DB_KEY } from '@/storage/activeDb';
import { DB_NAME, closeNotesDb, openNamedDb } from '@/storage/db';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function dbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name!).sort();
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Creates `name` with the full schema and one note in it. */
async function createNotesDb(name: string): Promise<void> {
  const db = await openNamedDb(name);
  await db.put('notes', { id: `n-${name}` } as never);
  db.close();
}

const NEW = `${DB_NAME}-abc`;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(async () => {
  await closeNotesDb();
  for (const name of await dbNames()) await deleteDb(name);
  vi.unstubAllGlobals();
});

describe('retireDatabase', () => {
  it('records names without dropping one already waiting', () => {
    const storage = memoryStorage();
    retireDatabase(DB_NAME, storage);
    retireDatabase(`${DB_NAME}-old`, storage);
    retireDatabase(DB_NAME, storage);
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME, `${DB_NAME}-old`]);
  });
});

describe('cleanupRetiredDatabases', () => {
  it('cleanup deletes the retired db only when the pointer and the active db verify', async () => {
    await createNotesDb(DB_NAME);
    await createNotesDb(NEW);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });

    // A fresh browser session: no import marker.
    await cleanupRetiredDatabases(storage, memoryStorage());

    expect(await dbNames()).toEqual([NEW]);
    expect(storage.getItem(RETIRED_DB_KEY)).toBeNull();
  });

  it('keeps everything in the session that performed the import', async () => {
    await createNotesDb(DB_NAME);
    await createNotesDb(NEW);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });
    await cleanupRetiredDatabases(storage, memoryStorage({ [IMPORTED_THIS_SESSION_KEY]: '1' }));
    expect(await dbNames()).toEqual([DB_NAME, NEW].sort());
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);
  });

  it('keeps everything when sessionStorage is missing or throws', async () => {
    await createNotesDb(DB_NAME);
    await createNotesDb(NEW);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });
    await cleanupRetiredDatabases(storage, null);
    const throwing = { getItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    await cleanupRetiredDatabases(storage, throwing);
    expect(await dbNames()).toEqual([DB_NAME, NEW].sort());
  });

  it('cleanup keeps the retired db when the pointer is missing', async () => {
    await createNotesDb(DB_NAME);
    await createNotesDb(NEW);
    const storage = memoryStorage({ [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });

    await cleanupRetiredDatabases(storage);

    expect(await dbNames()).toEqual([DB_NAME, NEW].sort());
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);
  });

  it('keeps the retired db when the pointer is not a valid name', async () => {
    await createNotesDb(DB_NAME);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: 'someone-else', [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([DB_NAME]);
  });

  it('keeps the retired db when the pointed-to db does not exist, and does not create it', async () => {
    await createNotesDb(DB_NAME);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);
  });

  it('keeps the retired db when the pointed-to db lacks a store', async () => {
    await createNotesDb(DB_NAME);
    const partial = await openDB(NEW, 1, {
      upgrade(db) {
        db.createObjectStore('notes', { keyPath: 'id' });
      },
    });
    partial.close();
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([DB_NAME]) });
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([DB_NAME, NEW].sort());
  });

  it('never deletes the database the pointer names', async () => {
    await createNotesDb(NEW);
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify([NEW]) });
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([NEW]);
  });

  it('ignores names that are not app databases', async () => {
    await createNotesDb(NEW);
    const other = await openDB('unrelated', 1, { upgrade: (db) => void db.createObjectStore('x') });
    other.close();
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: JSON.stringify(['unrelated']) });
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([NEW, 'unrelated'].sort());
  });

  it('does nothing and does not throw without storage or with a garbled list', async () => {
    await createNotesDb(DB_NAME);
    await createNotesDb(NEW);
    await expect(cleanupRetiredDatabases(null)).resolves.toBeUndefined();
    const storage = memoryStorage({ [ACTIVE_DB_KEY]: NEW, [RETIRED_DB_KEY]: '{not json' });
    await expect(cleanupRetiredDatabases(storage)).resolves.toBeUndefined();
    expect(await dbNames()).toEqual([DB_NAME, NEW].sort());
  });
});
