import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { DB_NAME, DB_VERSION, openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

/**
 * Builds a database at schema version 1 exactly as the shipped v1 upgrade
 * block did, so the upgrade test exercises the real upgrade path from v1 rather
 * than a fresh create. Inlined rather than imported: `db.ts`'s v1 block is
 * frozen and this copy must stay frozen with it.
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

/**
 * Builds a database at schema version 2 exactly as the shipped v1 and v2
 * upgrade blocks did, so the upgrade test exercises the real v2 → v3 path
 * rather than a fresh v3 create. Inlined for the same reason as
 * `createV1Database`: those blocks are frozen and this copy stays frozen too.
 */
async function createV2Database(): Promise<void> {
  const db = await openDB(DB_NAME, 2, {
    upgrade(database) {
      const notes = database.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('by-started', 'startedAt');
      notes.createIndex('by-session', 'sessionId');
      const pages = database.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('by-note', 'noteId');
      database.createObjectStore('pageRenders');
      database.createObjectStore('settings', { keyPath: 'key' });
      const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('by-started', 'startedAt');
      const recordings = database.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('by-session', 'sessionId');
      recordings.createIndex('by-started', 'startedAt');
      database.createObjectStore('recordingAudio');
      const events = database.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-start', 'startsAt');
      const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
      tasks.createIndex('by-status', 'status');
      tasks.createIndex('by-event', 'eventId');
    },
  });
  await db.put('notes', { id: 'note-2', title: 'Phase 1', startedAt: 2_000, sessionId: 'ses-1' });
  await db.put('pages', { id: 'page-2', noteId: 'note-2', pageIndex: 0 });
  await db.put('sessions', { id: 'ses-1', title: 'Phase 1', startedAt: 2_000 });
  await db.put('tasks', { id: 'task-1', title: 'Read ch. 4', status: 'open' });
  db.close();
}

/**
 * Builds a database at schema version 3 exactly as the shipped v1, v2 and v3
 * upgrade blocks did, so the upgrade test exercises the real v3 → v4 path
 * rather than a fresh v4 create. Inlined for the same reason as
 * `createV1Database`: those blocks are frozen and this copy stays frozen too.
 */
async function createV3Database(): Promise<void> {
  const db = await openDB(DB_NAME, 3, {
    upgrade(database) {
      const notes = database.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('by-started', 'startedAt');
      notes.createIndex('by-session', 'sessionId');
      const pages = database.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('by-note', 'noteId');
      database.createObjectStore('pageRenders');
      database.createObjectStore('settings', { keyPath: 'key' });
      const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('by-started', 'startedAt');
      const recordings = database.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('by-session', 'sessionId');
      recordings.createIndex('by-started', 'startedAt');
      database.createObjectStore('recordingAudio');
      const events = database.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-start', 'startsAt');
      const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
      tasks.createIndex('by-status', 'status');
      tasks.createIndex('by-event', 'eventId');
      const gaps = database.createObjectStore('gaps', { keyPath: 'id' });
      gaps.createIndex('by-note', 'noteId');
      gaps.createIndex('by-page', 'pageId');
    },
  });
  await db.put('notes', { id: 'note-3', title: 'Phase 2', startedAt: 3_000, sessionId: 'ses-3' });
  await db.put('pages', { id: 'page-3', noteId: 'note-3', pageIndex: 0 });
  await db.put('gaps', { id: 'gap-3', noteId: 'note-3', pageId: 'page-3' });
  db.close();
}

describe('openNotesDb', () => {
  it('creates the expected object stores', async () => {
    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
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

  it('creates every v3 index', async () => {
    const db = await openNotesDb();
    expect([...db.transaction('gaps').store.indexNames].sort()).toEqual([
      'by-note',
      'by-page',
    ]);
  });

  it('upgrades a v2 database to the current version without losing its rows', async () => {
    await createV2Database();

    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('notes', 'note-2')).toMatchObject({ title: 'Phase 1' });
    expect(await db.get('pages', 'page-2')).toMatchObject({ noteId: 'note-2' });
    expect(await db.get('sessions', 'ses-1')).toMatchObject({ title: 'Phase 1' });
    expect(await db.get('tasks', 'task-1')).toMatchObject({ status: 'open' });
    expect(db.objectStoreNames).toContain('gaps');
    // The v2 store and its indexes survive the version change untouched.
    expect([...db.transaction('notes').store.indexNames].sort()).toEqual([
      'by-session',
      'by-started',
    ]);
  });

  it('upgrades a v1 database to the current version without losing its rows', async () => {
    await createV1Database();

    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
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

  it('creates the v4 recordingChunks store and its index', async () => {
    const db = await openNotesDb();
    expect(db.objectStoreNames).toContain('recordingChunks');
    expect([...db.transaction('recordingChunks').store.indexNames]).toEqual(['by-recording']);
  });

  it('creates the v5 pcmCache store', async () => {
    const db = await openNotesDb();
    expect(db.objectStoreNames).toContain('pcmCache');
  });

  it('upgrades a v3 database to the current version without losing its rows', async () => {
    await createV3Database();

    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('notes', 'note-3')).toMatchObject({ title: 'Phase 2' });
    expect(await db.get('pages', 'page-3')).toMatchObject({ noteId: 'note-3' });
    expect(await db.get('gaps', 'gap-3')).toMatchObject({ pageId: 'page-3' });
    expect(db.objectStoreNames).toContain('recordingChunks');
    expect(db.objectStoreNames).toContain('pcmCache');
    // The v2 indexes survive the version change untouched.
    expect([...db.transaction('notes').store.indexNames].sort()).toEqual([
      'by-session',
      'by-started',
    ]);
  });
});
