import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_DB_KEY,
  canSwitchDatabase,
  getActiveDbName,
  setActiveDbName,
} from '@/storage/activeDb';
import { DB_NAME, closeNotesDb, openNamedDb, openNotesDb } from '@/storage/db';

const STORE_NAMES = [
  'events',
  'gaps',
  'notes',
  'pageRenders',
  'pages',
  'pcmCache',
  'recordingAudio',
  'recordingChunks',
  'recordings',
  'sessions',
  'settings',
  'tasks',
];

const throwingStorage = {
  getItem() {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('denied');
  },
  removeItem() {
    throw new Error('denied');
  },
} as unknown as Storage;

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Node 25 ships a non-functional global localStorage that shadows happy-dom's,
// so install a working in-memory one for these tests.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
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

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeNotesDb();
  await deleteDb('takingnotes-x');
  await deleteDb('takingnotes-staging');
  await deleteDb(DB_NAME);
});

describe('active database pointer', () => {
  it('defaults to takingnotes when unset', () => {
    expect(getActiveDbName()).toBe('takingnotes');
  });

  it('returns a stored staging name', () => {
    localStorage.setItem(ACTIVE_DB_KEY, 'takingnotes-staging');
    expect(getActiveDbName()).toBe('takingnotes-staging');
  });

  it('ignores a foreign value', () => {
    localStorage.setItem(ACTIVE_DB_KEY, 'other');
    expect(getActiveDbName()).toBe('takingnotes');
  });

  it('falls back to the default when storage throws', () => {
    expect(getActiveDbName(throwingStorage)).toBe('takingnotes');
  });

  it('setActiveDbName round-trips and throws on a failed write', () => {
    setActiveDbName('takingnotes-staging');
    expect(getActiveDbName()).toBe('takingnotes-staging');
    const dropping = {
      ...localStorage,
      setItem() {},
      getItem: () => null,
    } as unknown as Storage;
    expect(() => setActiveDbName('takingnotes-staging', dropping)).toThrow();
  });

  it('canSwitchDatabase is true with working storage', () => {
    expect(canSwitchDatabase()).toBe(true);
  });

  it('canSwitchDatabase is false when storage throws', () => {
    expect(canSwitchDatabase(throwingStorage)).toBe(false);
    expect(canSwitchDatabase(null)).toBe(false);
  });
});

describe('opening by name', () => {
  it('openNamedDb creates all v5 stores', async () => {
    const db = await openNamedDb('takingnotes-x');
    expect([...db.objectStoreNames].sort()).toEqual(STORE_NAMES);
    db.close();
  });

  it('openNotesDb opens the pointed-to database', async () => {
    setActiveDbName('takingnotes-staging');
    const db = await openNotesDb();
    expect(db.name).toBe('takingnotes-staging');
  });
});
