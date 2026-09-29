import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { DB_NAME, DB_VERSION, openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

/**
 * Builds a database at schema version 1 exactly as the shipped v1 upgrade
 * block did, so the upgrade test exercises the real v1 → v2 path rather than a
 * fresh v2 create. Inlined rather than imported: `db.ts`'s v1 block is frozen
 * and this copy must stay frozen with it.
 */
async function createV1Database(): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      const notes = database.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('by-started', 'startedAt');
      const pages = database.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('by-note', 'noteId');
      database.createObjectStore('pageRenders');
      database.createObjectStore('settings', { keyPath: 'key' });
    },
  });
  await db.put('notes', { id: 'note-1', title: 'Legacy', startedAt: 1_000 });
  await db.put('pages', { id: 'page-1', noteId: 'note-1', pageIndex: 0 });
  await db.put('settings', { key: 'kept', value: 'yes' });
  db.close();
}

describe('openNotesDb', () => {
  it('creates the expected object stores', async () => {
    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'events',
      'notes',
      'pageRenders',
      'pages',
      'recordingAudio',
      'recordings',
      'sessions',
      'settings',
      'tasks',
    ]);
  });

  it('creates the by-note index on pages', async () => {
    const db = await openNotesDb();
    const index = db.transaction('pages').store.index('by-note');
    expect(index.name).toBe('by-note');
  });

  it('creates every v2 index', async () => {
    const db = await openNotesDb();
    const indexNames = (store: 'notes' | 'sessions' | 'recordings' | 'events' | 'tasks') =>
      [...db.transaction(store).store.indexNames].sort();

    expect(indexNames('notes')).toEqual(['by-session', 'by-started']);
    expect(indexNames('sessions')).toEqual(['by-started']);
    expect(indexNames('recordings')).toEqual(['by-session', 'by-started']);
    expect(indexNames('events')).toEqual(['by-start']);
    expect(indexNames('tasks')).toEqual(['by-event', 'by-status']);
  });

  it('upgrades a v1 database to v2 without losing its rows', async () => {
    await createV1Database();

    const db = await openNotesDb();
    expect(db.version).toBe(2);
    expect(await db.get('notes', 'note-1')).toMatchObject({ title: 'Legacy' });
    expect(await db.get('pages', 'page-1')).toMatchObject({ noteId: 'note-1' });
    expect(await db.get('settings', 'kept')).toEqual({ key: 'kept', value: 'yes' });
    expect(db.objectStoreNames).toContain('sessions');
    // The index has to be created on the *existing* store through the upgrade
    // transaction; creating it on a fresh store would miss this case entirely.
    expect([...db.transaction('notes').store.indexNames]).toContain('by-session');
  });

  it('returns the same connection on repeated calls', async () => {
    const first = await openNotesDb();
    const second = await openNotesDb();
    expect(first).toBe(second);
  });
});
