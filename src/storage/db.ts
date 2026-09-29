import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type {
  CalendarEventRecord,
  NoteRecord,
  PageRecord,
  PageRenderRecord,
  RecordingAudioRecord,
  RecordingRecord,
  SessionRecord,
  SettingRecord,
  TaskRecord,
} from '@/storage/types';

export const DB_NAME = 'takingnotes';
export const DB_VERSION = 2;

export interface NotesDb extends DBSchema {
  notes: {
    key: string;
    value: NoteRecord;
    indexes: { 'by-started': number; 'by-session': string };
  };
  pages: {
    key: string;
    value: PageRecord;
    indexes: { 'by-note': string };
  };
  /** Out-of-line keys: the key is the page id, the value is bytes + metadata. */
  pageRenders: {
    key: string;
    value: PageRenderRecord;
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { 'by-started': number };
  };
  recordings: {
    key: string;
    value: RecordingRecord;
    indexes: { 'by-session': string; 'by-started': number };
  };
  /** Out-of-line keys: the key is the recording id, the value is bytes + MIME type. */
  recordingAudio: {
    key: string;
    value: RecordingAudioRecord;
  };
  events: {
    key: string;
    value: CalendarEventRecord;
    indexes: { 'by-start': number };
  };
  tasks: {
    key: string;
    value: TaskRecord;
    indexes: { 'by-status': string; 'by-event': string };
  };
}

let dbPromise: Promise<IDBPDatabase<NotesDb>> | null = null;

export function openNotesDb(): Promise<IDBPDatabase<NotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<NotesDb>(DB_NAME, DB_VERSION, {
      // Branch on `oldVersion`, not on `objectStoreNames.contains(...)`: a
      // future version bump needs to run only the steps a given user is
      // missing. Each `if (oldVersion < N)` block is one schema generation and
      // must never be edited once it has shipped.
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const notes = db.createObjectStore('notes', { keyPath: 'id' });
          notes.createIndex('by-started', 'startedAt');

          const pages = db.createObjectStore('pages', { keyPath: 'id' });
          pages.createIndex('by-note', 'noteId');

          db.createObjectStore('pageRenders');
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (oldVersion < 2) {
          // An index on a store that already exists has to be created through
          // the version-change transaction: `db.createObjectStore` would throw
          // for an existing store, and there is no other handle to it here.
          // Notes whose `sessionId` is null or absent are simply not in the
          // index - IndexedDB skips those - which is exactly what
          // `listNotesBySession` wants.
          tx.objectStore('notes').createIndex('by-session', 'sessionId');

          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('by-started', 'startedAt');

          const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
          recordings.createIndex('by-session', 'sessionId');
          recordings.createIndex('by-started', 'startedAt');

          db.createObjectStore('recordingAudio');

          const events = db.createObjectStore('events', { keyPath: 'id' });
          events.createIndex('by-start', 'startsAt');

          const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
          tasks.createIndex('by-status', 'status');
          tasks.createIndex('by-event', 'eventId');
        }
      },
      // Without these, a version bump with a second tab open hangs forever with
      // no diagnostic. Fail loudly instead.
      blocked() {
        console.warn(
          `[${DB_NAME}] upgrade blocked: another tab still holds an older connection`,
        );
      },
      blocking() {
        console.warn(`[${DB_NAME}] closing this connection so an upgrade can proceed`);
        void closeNotesDb();
      },
      terminated() {
        console.error(`[${DB_NAME}] connection terminated unexpectedly; will reopen`);
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

/**
 * Closes and drops the cached connection so the next call reopens. Closing
 * matters: `indexedDB.deleteDatabase` and version upgrades both block
 * indefinitely while any connection to the database is still open.
 */
export async function closeNotesDb(): Promise<void> {
  const pending = dbPromise;
  if (!pending) return;
  dbPromise = null;
  const db = await pending;
  db.close();
}

/** Test-only alias; each test starts from a fresh database. */
export const resetNotesDbForTests = closeNotesDb;
