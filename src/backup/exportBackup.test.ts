import { beforeEach, describe, expect, it } from 'vitest';

import { backupFileName, exportBackup } from '@/backup/exportBackup';
import { decodeRecord, readBackupHeader, sliceBinary } from '@/backup/format';
import { BACKUP_STORES, OUT_OF_LINE_STORES, isBackupLocalStorageKey } from '@/backup/stores';
import { DB_VERSION, openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

function memoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

async function seedAll(): Promise<void> {
  const db = await openNotesDb();
  await db.put('notes', { id: 'n1' } as never);
  await db.put('pages', { id: 'pg1', noteId: 'n1' } as never);
  await db.put('pageRenders', { data: new Uint8Array([1, 2, 3]).buffer, type: 'image/png', width: 1, height: 1 }, 'p1');
  await db.put('settings', { key: 'k', value: 1 } as never);
  await db.put('sessions', { id: 's1' } as never);
  await db.put('recordings', { id: 'r1' } as never);
  await db.put('recordingAudio', { data: new Uint8Array([9, 8]).buffer, type: 'audio/webm' }, 'r1');
  await db.put('events', { id: 'e1' } as never);
  await db.put('tasks', { id: 't1' } as never);
  await db.put('gaps', { id: 'g1' } as never);
  await db.put('recordingChunks', { id: 'c1', recordingId: 'r1', seq: 0, data: new ArrayBuffer(4), type: 'a' } as never);
  await db.put('pcmCache', { recordingId: 'r1' } as never);
}

describe('exportBackup', () => {
  it('exports every store except pcmCache', async () => {
    await seedAll();
    const blob = await exportBackup({ appVersion: '1.0.0', storage: null });
    const { manifest } = await readBackupHeader(blob);
    expect(Object.keys(manifest.stores)).toHaveLength(11);
    expect(Object.keys(manifest.stores)).not.toContain('pcmCache');
    expect(Object.keys(manifest.stores)).toEqual([...BACKUP_STORES]);
    expect(manifest.stores.notes).toHaveLength(1);
  });

  it('keeps out-of-line keys and binaries', async () => {
    await seedAll();
    const blob = await exportBackup({ appVersion: '1.0.0', storage: null });
    const { manifest, binaryStart } = await readBackupHeader(blob);
    expect(OUT_OF_LINE_STORES).toEqual(['pageRenders', 'recordingAudio']);
    const entry = manifest.stores.pageRenders[0];
    expect(entry.key).toBe('p1');
    const value = decodeRecord(entry.value, (i) => {
      expect(manifest.binaries[i].length).toBe(3);
      return new Uint8Array([0]).buffer;
    }) as { type: string };
    expect(value.type).toBe('image/png');
    const idx = (entry.value as { data: { $tnbin: number } }).data.$tnbin;
    const bytes = new Uint8Array(await sliceBinary(blob, binaryStart, manifest.binaries[idx]).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(manifest.stores.notes[0].key).toBeNull();
  });

  it('exports only takingnotes localStorage keys', async () => {
    const storage = memoryStorage({
      'takingnotes.activeTheme': 'dark',
      takingnotes_downloaded_memory: '{}',
      'takingnotes.sessionsUi': '{}',
      'takingnotes.activeDb': 'takingnotes-x',
      'other.key': 'no',
    });
    const blob = await exportBackup({ appVersion: '1.0.0', storage });
    const { manifest } = await readBackupHeader(blob);
    expect(Object.keys(manifest.localStorage).sort()).toEqual([
      'takingnotes.activeTheme',
      'takingnotes.sessionsUi',
      'takingnotes_downloaded_memory',
    ]);
    expect(isBackupLocalStorageKey('takingnotes.activeDb')).toBe(false);
  });

  it('records appVersion, DB_VERSION and exportedAt', async () => {
    const blob = await exportBackup({ appVersion: '2.3.4', now: () => 42, storage: null });
    const { manifest } = await readBackupHeader(blob);
    expect(manifest.appVersion).toBe('2.3.4');
    expect(manifest.dbVersion).toBe(DB_VERSION);
    expect(manifest.exportedAt).toBe(42);
  });
});

describe('backupFileName', () => {
  it('uses the local date', () => {
    const t = new Date(2026, 10, 5, 23, 59).getTime();
    expect(backupFileName(t)).toBe('takingnotes-backup-2026-11-05.tnbackup');
  });
});
