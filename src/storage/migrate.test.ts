import { beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_STORAGE_KEY,
  MIGRATION_SETTING_KEY,
  migrateLegacyNotebooks,
} from '@/storage/migrate';
import { listNotes } from '@/storage/notes';
import { listPages } from '@/storage/pages';
import { getSetting, setSetting } from '@/storage/settings';
import { resetDatabase } from '@/test/resetDb';

const LEGACY_NOTEBOOK = {
  id: 'nb-1',
  deviceId: 'huion:abc',
  notebookUuid: 'huion:abc',
  deviceType: 'huion',
  deviceName: 'Huion Note',
  notebookName: 'Meeting notes',
  downloadedAt: 1700000000000,
  pageWidth: 1409,
  pageHeight: 1869,
  pageCount: 2,
  pages: [
    {
      id: 'p-1',
      pageNum: 0,
      strokeCount: 1,
      pointCount: 2,
      timestamp: 1700000000000,
      strokes: [{ points: [{ x: 0.1, y: 0.2, pressure: 0.5 }, { x: 0.3, y: 0.4, pressure: 0.6 }] }],
    },
    {
      id: 'p-2',
      pageNum: 1,
      strokeCount: 1,
      pointCount: 1,
      timestamp: 1700000001000,
      strokes: [{ points: [{ x: 0.5, y: 0.6, pressure: 0.7 }] }],
    },
  ],
};

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

beforeEach(resetDatabase);

describe('migrateLegacyNotebooks', () => {
  it('imports a notebook as a completed legacy note', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });

    const result = await migrateLegacyNotebooks(storage);
    expect(result).toEqual({ imported: 1, pages: 2, failed: 0, skipped: false });

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Meeting notes');
    expect(notes[0].status).toBe('complete');
    expect(notes[0].legacy).toBe(true);
    expect(notes[0].startedAt).toBe(1700000000000);
    expect(notes[0].endedAt).toBe(1700000000000);
  });

  it('imports pages in order with rom as the source', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);

    const [note] = await listNotes();
    const pages = await listPages(note.id);

    expect(pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    expect(pages.map((page) => page.devicePageNum)).toEqual([0, 1]);
    expect(pages.every((page) => page.source === 'rom')).toBe(true);
    expect(pages[0].pointCount).toBe(2);
    expect(pages[1].pointCount).toBe(1);
  });

  it('never deletes the legacy localStorage key', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it('is idempotent - a second run imports nothing', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });

    await migrateLegacyNotebooks(storage);
    const second = await migrateLegacyNotebooks(storage);

    expect(second.skipped).toBe(true);
    expect(await listNotes()).toHaveLength(1);
  });

  it('records when the migration ran', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);
    expect(await getSetting(MIGRATION_SETTING_KEY, 0)).toBeGreaterThan(0);
  });

  it('handles a missing key', async () => {
    const result = await migrateLegacyNotebooks(makeStorage());
    expect(result).toEqual({ imported: 0, pages: 0, failed: 0, skipped: false });
    // Nothing to migrate is not a failure - the flag must still be set.
    expect(await getSetting(MIGRATION_SETTING_KEY, 0)).toBeGreaterThan(0);
  });

  it('handles malformed JSON without throwing', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: 'not json' });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(0);
  });

  it('stays retryable when the source is unreadable', async () => {
    const broken = makeStorage({ [LEGACY_STORAGE_KEY]: 'not json' });
    await migrateLegacyNotebooks(broken);
    expect(await getSetting(MIGRATION_SETTING_KEY, 0)).toBe(0);

    const fixed = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    const second = await migrateLegacyNotebooks(fixed);
    expect(second.skipped).toBe(false);
    expect(second.imported).toBe(1);
  });

  it('skips notebooks that are not objects', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([null, 'nope', LEGACY_NOTEBOOK]),
    });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(1);
  });

  it('falls back to a placeholder title when the name is missing', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([{ ...LEGACY_NOTEBOOK, notebookName: '' }]),
    });
    await migrateLegacyNotebooks(storage);
    const [note] = await listNotes();
    expect(note.title).toBe('Imported notebook');
  });

  it('stays retryable when the payload is valid JSON of the wrong shape', async () => {
    const bad = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ notebooks: [] }) });
    await migrateLegacyNotebooks(bad);
    expect(await getSetting(MIGRATION_SETTING_KEY, 0)).toBe(0);

    const fixed = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    const second = await migrateLegacyNotebooks(fixed);
    expect(second.skipped).toBe(false);
    expect(second.imported).toBe(1);
  });

  it('rejects an array-shaped notebook entry instead of importing it as a junk note', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([[], LEGACY_NOTEBOOK]),
    });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(1);

    const notes = await listNotes();
    expect(notes.some((note) => note.title === 'Imported notebook')).toBe(false);
  });

  it('imports a notebook with zero pages when pages is an object rather than an array', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([{ ...LEGACY_NOTEBOOK, pages: {} }]),
    });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(1);
    expect(result.pages).toBe(0);

    const [note] = await listNotes();
    const pages = await listPages(note.id);
    expect(pages).toHaveLength(0);
  });

  it('does not duplicate notes when retried after the migration flag is reset', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);

    await setSetting(MIGRATION_SETTING_KEY, 0);
    const second = await migrateLegacyNotebooks(storage);

    expect(second.imported).toBe(0);
    expect(await listNotes()).toHaveLength(1);
  });

  it('preserves device and page metadata', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);

    const [note] = await listNotes();
    expect(note.pageWidth).toBe(1409);
    expect(note.pageHeight).toBe(1869);
    expect(note.deviceName).toBe('Huion Note');
    expect(note.deviceType).toBe('huion');
    expect(note.legacySourceId).toBe('nb-1');

    const pages = await listPages(note.id);
    expect(pages.map((page) => page.capturedAt)).toEqual([1700000000000, 1700000001000]);
  });

  it('keeps wacom as the device type instead of hardcoding huion', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([{ ...LEGACY_NOTEBOOK, deviceType: 'wacom' }]),
    });
    await migrateLegacyNotebooks(storage);

    const [note] = await listNotes();
    expect(note.deviceType).toBe('wacom');
  });
});
