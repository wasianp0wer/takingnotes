import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportBackup } from '@/backup/exportBackup';
import { BackupFormatError, buildBackupBlob, readBackupHeader, type BackupEntry } from '@/backup/format';
import { ImportBlockedError } from '@/backup/guards';
import {
  BackupTooNewError,
  ImportBlockedError as ReExportedBlockedError,
  importBackup,
  inspectBackup,
} from '@/backup/importBackup';
import { cleanupRetiredDatabases } from '@/backup/retiredDb';
import { BACKUP_STORES, OUT_OF_LINE_STORES } from '@/backup/stores';
import { ACTIVE_DB_KEY, RETIRED_DB_KEY, getActiveDbName } from '@/storage/activeDb';
import { DB_NAME, DB_VERSION, closeNotesDb, openNamedDb, openNotesDb, type NotesDb } from '@/storage/db';

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

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function dbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name!).sort();
}

const oneTab = async () => 1;

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(async () => {
  await closeNotesDb();
  for (const name of await dbNames()) await deleteDb(name);
  vi.unstubAllGlobals();
});

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

/** One record in every backed-up store, with binaries in the three byte-carrying stores. */
async function seedAll(tag: string): Promise<void> {
  const db = await openNotesDb();
  await db.put('notes', { id: `n-${tag}`, status: 'complete', sessionId: 's1', startedAt: 1 } as never);
  await db.put('pages', { id: `pg-${tag}`, noteId: `n-${tag}`, transcript: { status: 'done', text: tag } } as never);
  await db.put('pageRenders', { data: bytes(1, 2, 3, 250), type: 'image/png', width: 4, height: 5 }, `pg-${tag}`);
  await db.put('settings', { key: `k-${tag}`, value: { nested: [1, 2] } } as never);
  await db.put('sessions', { id: `s-${tag}`, title: tag, status: 'ended', startedAt: 1, endedAt: 2 });
  await db.put('recordings', { id: `r-${tag}`, endedAt: 9, transcript: null } as never);
  await db.put('recordingAudio', { data: bytes(9, 8, 7, 0, 255), type: 'audio/webm' }, `r-${tag}`);
  await db.put('events', { id: `e-${tag}`, startsAt: 3 } as never);
  await db.put('tasks', { id: `t-${tag}`, status: 'open' } as never);
  await db.put('gaps', { id: `g-${tag}`, noteId: 'n', pageId: 'p' } as never);
  await db.put('recordingChunks', { id: `c-${tag}`, recordingId: `r-${tag}`, seq: 0, data: bytes(4, 4), type: 'a' } as never);
}

type Snapshot = Record<string, { keys: IDBValidKey[]; values: unknown[] }>;

async function snapshot(db: IDBPDatabase<NotesDb>): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const name of BACKUP_STORES) {
    out[name] = { keys: await db.getAllKeys(name), values: await db.getAll(name) };
  }
  return out;
}

async function activeSnapshot(): Promise<Snapshot> {
  return snapshot(await openNotesDb());
}

function expectBytesEqual(a: unknown, b: unknown): void {
  expect([...new Uint8Array(a as ArrayBuffer)]).toEqual([...new Uint8Array(b as ArrayBuffer)]);
}

function manifestBlob(over: Record<string, unknown>, parts: Blob[] = []): Blob {
  return buildBackupBlob(
    {
      format: 1,
      appVersion: '1.0.0',
      dbVersion: DB_VERSION,
      exportedAt: 5,
      stores: {},
      localStorage: {},
      ...over,
    } as never,
    parts,
  );
}

/**
 * Wraps a staging database so that every `put` in the `failOn`-th readwrite
 * transaction throws.
 */
function failingStaging(failOn: number, mode: 'sync' | 'async' = 'sync') {
  let txCount = 0;
  return async (name: string) => {
    const db = await openNamedDb(name);
    return new Proxy(db, {
      get(target, prop) {
        const real = (target as unknown as Record<PropertyKey, unknown>)[prop];
        if (prop !== 'transaction') return typeof real === 'function' ? real.bind(target) : real;
        return (...args: Parameters<typeof db.transaction>) => {
          const tx = db.transaction(...args);
          if (args[1] !== 'readwrite') return tx;
          txCount += 1;
          if (txCount !== failOn) return tx;
          return new Proxy(tx, {
            get(t, p) {
              const v = (t as unknown as Record<PropertyKey, unknown>)[p];
              if (p !== 'objectStore') return typeof v === 'function' ? v.bind(t) : v;
              return (storeName: never) => {
                const store = t.objectStore(storeName);
                return new Proxy(store, {
                  get(s, q) {
                    if (q === 'put') {
                      if (mode === 'async') {
                        // A second insert of the same key: the request fails
                        // asynchronously (ConstraintError) and aborts the tx.
                        return (value: never, key?: never) => {
                          void s.put!(value, key).catch(() => {});
                          return s.add!(value, key);
                        };
                      }
                      return () => {
                        throw new Error('injected put failure');
                      };
                    }
                    const w = (s as unknown as Record<PropertyKey, unknown>)[q];
                    return typeof w === 'function' ? w.bind(s) : w;
                  },
                });
              };
            },
          });
        };
      },
    }) as IDBPDatabase<NotesDb>;
  };
}

describe('inspectBackup', () => {
  it('summarises a backup', async () => {
    await seedAll('a');
    const blob = await exportBackup({ appVersion: '3.1.4', now: () => 77, storage: null });
    const summary = await inspectBackup(blob);
    expect(summary.appVersion).toBe('3.1.4');
    expect(summary.exportedAt).toBe(77);
    expect(summary.dbVersion).toBe(DB_VERSION);
    expect(summary.counts.notes).toBe(1);
    expect(summary.counts.recordings).toBe(1);
    expect(Object.keys(summary.counts).sort()).toEqual([...BACKUP_STORES].sort());
  });

  it('refuses a newer DB_VERSION', async () => {
    await expect(inspectBackup(manifestBlob({ dbVersion: DB_VERSION + 1 }))).rejects.toBeInstanceOf(
      BackupTooNewError,
    );
  });
});

describe('importBackup', () => {
  it('round-trips export → import byte-exact', async () => {
    await seedAll('a');
    const storage = memoryStorage({
      'takingnotes.activeTheme': 'dark',
      takingnotes_downloaded_memory: '{"x":1}',
      'unrelated.key': 'keep',
    });
    vi.stubGlobal('localStorage', storage);
    const seeded = await activeSnapshot();
    const blob = await exportBackup({ appVersion: '1.0.0', storage });

    // Wipe: new data in the DB, and changed/added localStorage keys.
    const db = await openNotesDb();
    for (const name of BACKUP_STORES) await db.clear(name);
    await seedAll('b');
    storage.setItem('takingnotes.activeTheme', 'light');
    storage.setItem('takingnotes.sessionsUi', 'stale');

    await importBackup(blob, { storage, countTabs: oneTab });

    const pointer = getActiveDbName(storage);
    expect(pointer).not.toBe(DB_NAME);
    expect(pointer.startsWith(`${DB_NAME}-`)).toBe(true);
    // The old database is kept (and recorded as retired) until a verified restart.
    expect(await dbNames()).toEqual([DB_NAME, pointer].sort());
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);

    const restored = await activeSnapshot();
    expect((await openNotesDb()).name).toBe(pointer);
    expect(restored).toEqual(seeded);
    for (const name of ['pageRenders', 'recordingAudio', 'recordingChunks'] as const) {
      const before = seeded[name].values[0] as { data: ArrayBuffer };
      const after = restored[name].values[0] as { data: ArrayBuffer };
      expect(after.data).toBeInstanceOf(ArrayBuffer);
      expectBytesEqual(after.data, before.data);
    }
    expect(OUT_OF_LINE_STORES.every((s) => restored[s].keys[0] === seeded[s].keys[0])).toBe(true);

    expect(storage.getItem('takingnotes.activeTheme')).toBe('dark');
    expect(storage.getItem('takingnotes_downloaded_memory')).toBe('{"x":1}');
    expect(storage.getItem('takingnotes.sessionsUi')).toBeNull();
    expect(storage.getItem('unrelated.key')).toBe('keep');
  });

  it('import keeps the previous database until a verified restart', async () => {
    await seedAll('old');
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const oldData = await activeSnapshot();
    const blob = manifestBlob({ stores: { notes: [{ key: null, value: { id: 'imported' } }] } });

    await importBackup(blob, { storage, countTabs: oneTab });

    const pointer = getActiveDbName(storage);
    expect(pointer).not.toBe(DB_NAME);
    // Nothing is deleted by the import itself: the old data is intact.
    expect(await dbNames()).toEqual([DB_NAME, pointer].sort());
    const old = await openNamedDb(DB_NAME);
    expect(await snapshot(old)).toEqual(oldData);
    old.close();
    expect(JSON.parse(storage.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);

    // The "restart": the app opens the pointed-to db, then the cleanup runs.
    await closeNotesDb();
    expect((await openNotesDb()).name).toBe(pointer);
    await cleanupRetiredDatabases(storage);
    expect(await dbNames()).toEqual([pointer]);
    expect(storage.getItem(RETIRED_DB_KEY)).toBeNull();
    expect(await (await openNotesDb()).count('notes')).toBe(1);
  });

  it('retiredDb key is never exported or imported', async () => {
    await seedAll('a');
    const storage = memoryStorage({
      [RETIRED_DB_KEY]: JSON.stringify(['takingnotes-leftover']),
      'takingnotes.activeTheme': 'dark',
    });
    const exported = await exportBackup({ appVersion: '1.0.0', storage });
    const { manifest } = await readBackupHeader(exported);
    expect(manifest.localStorage).toEqual({ 'takingnotes.activeTheme': 'dark' });

    const target = memoryStorage();
    vi.stubGlobal('localStorage', target);
    const blob = manifestBlob({
      localStorage: { [RETIRED_DB_KEY]: JSON.stringify(['takingnotes-evil']), 'takingnotes.activeTheme': 'dark' },
    });
    await importBackup(blob, { storage: target, countTabs: oneTab });
    expect(JSON.parse(target.getItem(RETIRED_DB_KEY)!)).toEqual([DB_NAME]);
    expect(target.getItem('takingnotes.activeTheme')).toBe('dark');
  });

  for (const mode of ['sync', 'async'] as const) {
    it(`failure mid-import leaves data untouched (${mode} put failure)`, async () => {
      await seedAll('a');
      const storage = localStorage;
      storage.setItem('takingnotes.activeTheme', 'light');
      const blob = await exportBackup({ appVersion: '1.0.0', storage: memoryStorage({ 'takingnotes.activeTheme': 'dark' }) });
      await closeNotesDb();
      await deleteDb(DB_NAME);
      await seedAll('original');
      const before = await activeSnapshot();
      const namesBefore = await dbNames();
      const progress: number[] = [];

      const err = await importBackup(blob, {
        storage,
        countTabs: oneTab,
        openStaging: failingStaging(3, mode),
        onProgress: (done) => progress.push(done),
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      if (mode === 'sync') expect((err as Error).message).toBe('injected put failure');
      else expect((err as Error).name).toBe('ConstraintError');
      // One record per store, so batches 1 and 2 committed and batch 3 failed.
      expect(progress).toEqual([0, 1, 2]);
      expect(storage.getItem(ACTIVE_DB_KEY)).toBeNull();
      expect(getActiveDbName(storage)).toBe(DB_NAME);
      expect(storage.getItem('takingnotes.activeTheme')).toBe('light');
      expect(await dbNames()).toEqual(namesBefore);
      expect(await activeSnapshot()).toEqual(before);
    });
  }

  it('blocker appearing mid-import aborts before the swap', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    localStorage.setItem('takingnotes.activeTheme', 'light');
    const blob = manifestBlob({
      stores: {
        notes: [{ key: null, value: { id: 'imported' } }],
        tasks: [{ key: null, value: { id: 't' } }],
      },
      localStorage: { 'takingnotes.activeTheme': 'dark' },
    });
    let tabs = 1;
    const err = await importBackup(blob, {
      countTabs: async () => tabs,
      // A second tab opens once the first batch has been written.
      onProgress: (done) => {
        if (done > 0) tabs = 2;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportBlockedError);
    expect((err as ImportBlockedError).blockers).toEqual(['other-tabs']);
    expect(localStorage.getItem(ACTIVE_DB_KEY)).toBeNull();
    expect(localStorage.getItem('takingnotes.activeTheme')).toBe('light');
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(await activeSnapshot()).toEqual(before);
  });

  it('re-exports ImportBlockedError', () => {
    expect(ReExportedBlockedError).toBe(ImportBlockedError);
  });

  it('a pointer write that does not stick restores localStorage and drops staging', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    const inner = memoryStorage({ 'takingnotes.activeTheme': 'light', 'takingnotes.sessionsUi': 'mine' });
    // Accepts the probe key, silently drops the pointer itself.
    const storage = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'setItem') {
          return (k: string, v: string) => (k === ACTIVE_DB_KEY ? undefined : target.setItem(k, v));
        }
        const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Storage;
    const blob = manifestBlob({
      stores: { notes: [{ key: null, value: { id: 'imported' } }] },
      localStorage: { 'takingnotes.activeTheme': 'dark' },
    });
    await expect(importBackup(blob, { storage, countTabs: oneTab })).rejects.toThrow(/not persisted/);
    expect(inner.getItem('takingnotes.activeTheme')).toBe('light');
    expect(inner.getItem('takingnotes.sessionsUi')).toBe('mine');
    expect(inner.getItem(ACTIVE_DB_KEY)).toBeNull();
    // The retired record is rolled back too: nothing marks the live db for deletion.
    expect(inner.getItem(RETIRED_DB_KEY)).toBeNull();
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(await activeSnapshot()).toEqual(before);
  });

  it('a count mismatch in staging aborts the import', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    // Two entries with the same in-line key collapse into one record.
    const blob = manifestBlob({
      stores: { notes: [{ key: null, value: { id: 'dup' } }, { key: null, value: { id: 'dup' } }] },
    });
    await expect(importBackup(blob, { countTabs: oneTab })).rejects.toThrow(/count/i);
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(getActiveDbName()).toBe(DB_NAME);
    expect(await activeSnapshot()).toEqual(before);
  });

  it('foreign file leaves data untouched', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    const foreign = new Blob(['PK\x03\x04 definitely a zip file, not a backup']);
    const err = await importBackup(foreign, { countTabs: oneTab }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupFormatError);
    expect((err as BackupFormatError).reason).toBe('not-a-backup');
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(getActiveDbName()).toBe(DB_NAME);
    expect(await activeSnapshot()).toEqual(before);
  });

  it('refuses a newer DB_VERSION', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    const blob = manifestBlob({
      dbVersion: DB_VERSION + 1,
      stores: { notes: [{ key: null, value: { id: 'future' } }] },
      localStorage: { 'takingnotes.activeTheme': 'future' },
    });
    await expect(importBackup(blob, { countTabs: oneTab })).rejects.toBeInstanceOf(BackupTooNewError);
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(localStorage.getItem('takingnotes.activeTheme')).toBeNull();
    expect(await activeSnapshot()).toEqual(before);
  });

  it('malformed manifest is rejected before any write', async () => {
    await seedAll('original');
    const before = await activeSnapshot();
    const cases: Record<string, unknown>[] = [
      { stores: [] },
      { stores: { notes: 'nope' } },
      { stores: { notes: [{ key: null }] } },
      { stores: { notes: [null] } },
      { stores: { pageRenders: [{ key: null, value: { data: 1 } }] } },
      { stores: { pageRenders: [{ key: 'p', value: { data: { $tnbin: 0 } } }] } },
      { localStorage: { 'takingnotes.x': 5 } },
      { localStorage: [] },
      { dbVersion: '5' },
      { dbVersion: 0 },
      { appVersion: 5 },
      { exportedAt: 'yesterday' },
    ];
    for (const over of cases) {
      const err = await importBackup(manifestBlob(over), { countTabs: oneTab }).catch((e: unknown) => e);
      expect(err, JSON.stringify(over)).toBeInstanceOf(BackupFormatError);
      expect((err as BackupFormatError).reason, JSON.stringify(over)).toBe('corrupt');
    }

    // Binary refs that are negative, fractional or run past the end of the file.
    const badRefs: unknown[] = [
      [{ offset: -1, length: 1 }],
      [{ offset: 0.5, length: 1 }],
      [{ offset: 0, length: 999 }],
      [{ offset: 0 }],
      ['x'],
    ];
    for (const binaries of badRefs) {
      const good = manifestBlob({}, [new Blob([bytes(1, 2)])]);
      // Rebuild with a hand-written binaries table.
      const json = JSON.stringify({
        format: 1,
        appVersion: '1',
        dbVersion: DB_VERSION,
        exportedAt: 1,
        stores: {},
        localStorage: {},
        binaries,
      });
      const len = String(new TextEncoder().encode(json).length).padStart(12, '0');
      const blob = new Blob(['TNBACKUP1\n', len, json, bytes(1, 2)]);
      expect(good.size).toBeGreaterThan(0);
      const err = await importBackup(blob, { countTabs: oneTab }).catch((e: unknown) => e);
      expect(err, JSON.stringify(binaries)).toBeInstanceOf(BackupFormatError);
      expect(['corrupt', 'truncated']).toContain((err as BackupFormatError).reason);
      if (!(Array.isArray(binaries) && JSON.stringify(binaries).includes('999'))) {
        expect((err as BackupFormatError).reason, JSON.stringify(binaries)).toBe('corrupt');
      }
    }

    expect(await dbNames()).toEqual([DB_NAME]);
    expect(getActiveDbName()).toBe(DB_NAME);
    expect(await activeSnapshot()).toEqual(before);
  });

  it('imports a v4 backup that lacks pcmCache-era stores', async () => {
    await seedAll('original');
    const blob = manifestBlob(
      {
        dbVersion: 4,
        stores: {
          notes: [{ key: null, value: { id: 'old-note', status: 'complete' } }],
          recordings: [{ key: null, value: { id: 'old-rec', endedAt: 3, transcript: null } }],
          recordingAudio: [{ key: 'old-rec', value: { data: { $tnbin: 0 }, type: 'audio/webm' } }],
        },
      },
      [new Blob([bytes(5, 6, 7)])],
    );
    await importBackup(blob, { countTabs: oneTab });
    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toContain('pcmCache');
    expect(await db.getAll('notes')).toEqual([{ id: 'old-note', status: 'complete' }]);
    expect(await db.count('sessions')).toBe(0);
    expect(await db.count('recordingChunks')).toBe(0);
    const audio = await db.get('recordingAudio', 'old-rec');
    expectBytesEqual(audio!.data, bytes(5, 6, 7));
  });

  it('ignores stores it does not know', async () => {
    const blob = manifestBlob({
      stores: {
        notes: [{ key: null, value: { id: 'n' } }],
        pcmCache: [{ key: null, value: { recordingId: 'r' } }],
        someFutureStore: [{ key: 'x', value: 1 }],
      },
    });
    const summary = await inspectBackup(blob);
    expect(summary.counts).not.toHaveProperty('pcmCache');
    await importBackup(blob, { countTabs: oneTab });
    const db = await openNotesDb();
    expect(await db.count('notes')).toBe(1);
    expect(await db.count('pcmCache')).toBe(0);
  });

  it('never imports the active-database pointer from a backup', async () => {
    const blob = manifestBlob({
      localStorage: { [ACTIVE_DB_KEY]: 'takingnotes-evil', 'takingnotes.activeTheme': 'dark', 'other.key': 'x' },
    });
    await importBackup(blob, { countTabs: oneTab });
    expect(localStorage.getItem(ACTIVE_DB_KEY)).not.toBe('takingnotes-evil');
    expect(localStorage.getItem('takingnotes.activeTheme')).toBe('dark');
    expect(localStorage.getItem('other.key')).toBeNull();
  });

  it('refuses while recording', async () => {
    const db = await openNotesDb();
    await db.put('recordings', { id: 'live', endedAt: null, transcript: null } as never);
    const blob = manifestBlob({ stores: { notes: [{ key: null, value: { id: 'n' } }] } });
    const err = await importBackup(blob, { countTabs: oneTab }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportBlockedError);
    expect((err as ImportBlockedError).blockers).toEqual(['recording-active']);
    expect(await dbNames()).toEqual([DB_NAME]);
    expect(getActiveDbName()).toBe(DB_NAME);
  });

  it('reports progress up to total', async () => {
    const notes: BackupEntry[] = Array.from({ length: 120 }, (_, i) => ({
      key: null,
      value: { id: `n${i}` },
    }));
    const blob = manifestBlob({
      stores: { notes, tasks: [{ key: null, value: { id: 't' } }] },
    });
    const calls: [number, number][] = [];
    await importBackup(blob, { countTabs: oneTab, onProgress: (d, t) => calls.push([d, t]) });
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every(([, t]) => t === 121)).toBe(true);
    const done = calls.map(([d]) => d);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(done.at(-1)).toBe(121);
    expect(Math.max(...done.slice(1).map((d, i) => d - done[i]))).toBeLessThanOrEqual(50);
  });
});
