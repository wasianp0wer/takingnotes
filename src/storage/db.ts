import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

import { getActiveDbName } from '@/storage/activeDb';

import type {
  CalendarEventRecord,
  GapSuggestionRecord,
  NoteRecord,
  PageRecord,
  PageRenderRecord,
  PcmCacheRecord,
  RecordingAudioRecord,
  RecordingChunkRecord,
  RecordingRecord,
  SessionRecord,
  SettingRecord,
  TaskRecord,
} from '@/storage/types';

export const DB_NAME = 'takingnotes';
export const DB_VERSION = 5;

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
  gaps: {
    key: string;
    value: GapSuggestionRecord;
    indexes: { 'by-note': string; 'by-page': string };
  };
  /**
   * In-line keys. Transient per-chunk audio for a recording in progress; see
   * `RecordingChunkRecord`.
   */
  recordingChunks: {
    key: string;
    value: RecordingChunkRecord;
    indexes: { 'by-recording': string };
  };
  /**
   * In-line keys on `recordingId`. Transient decoded audio for a recording
   * whose transcription is unfinished; see `PcmCacheRecord`. No index: every
   * read is by primary key.
   */
  pcmCache: {
    key: string;
    value: PcmCacheRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<NotesDb>> | null = null;

// Branch on `oldVersion`, not on `objectStoreNames.contains(...)`: a
// future version bump needs to run only the steps a given user is
// missing. Each `if (oldVersion < N)` block is one schema generation and
// must never be edited once it has shipped.
//
// ⚑ MIGRATION DEBT (I2): backup import (`src/backup/importBackup.ts`) writes
// an older backup's records into a staging database already opened at
// DB_VERSION, so these blocks never run over imported records. That is
// harmless while every version (1-5) is schema-only. Before any version bump
// that migrates DATA, first make import open staging at
// `manifest.dbVersion`, write the records, then reopen at DB_VERSION so the
// upgrade runs over them.
function upgradeNotesDb(
  db: IDBPDatabase<NotesDb>,
  oldVersion: number,
  _newVersion: number | null,
  tx: IDBPTransaction<NotesDb, StoreNames<NotesDb>[], 'versionchange'>,
): void {
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
  if (oldVersion < 3) {
    // Phase 2 gap suggestions (docs/architecture.md §6.2). Indexed by
    // both note and page: the note view lists a whole note's suggestions,
    // and a re-run of one page deletes that page's proposed ones.
    const gaps = db.createObjectStore('gaps', { keyPath: 'id' });
    gaps.createIndex('by-note', 'noteId');
    gaps.createIndex('by-page', 'pageId');
  }
  if (oldVersion < 4) {
    // Phase 3 incremental audio (K4-K7). Indexed by recording so a
    // stitch reads exactly one recording's chunks, and so a recording
    // deleted mid-flight can drop its own without a full scan.
    const chunks = db.createObjectStore('recordingChunks', { keyPath: 'id' });
    chunks.createIndex('by-recording', 'recordingId');
    // No data migration: every v4 field is optional with a documented
    // absent-reading (K1), so existing rows are already valid v4 rows.
  }
  if (oldVersion < 5) {
    // Chunked resumable transcription: the decoded-audio cache that
    // keeps a resumed job from re-decoding. In-line keys on
    // `recordingId`, no index - every read is by primary key.
    db.createObjectStore('pcmCache', { keyPath: 'recordingId' });
    // No data migration: `completedMs`, `leaseOwner` and `leaseAt` are
    // all optional on `AudioTranscriptRecord` with documented
    // absent-readings, so existing rows are already valid v5 rows.
  }
}

export function openNamedDb(name: string): Promise<IDBPDatabase<NotesDb>> {
  return openDB<NotesDb>(name, DB_VERSION, {
    upgrade: upgradeNotesDb,
    blocked() {
      console.warn(`[${name}] upgrade blocked: another tab still holds an older connection`);
    },
    terminated() {
      console.error(`[${name}] connection terminated unexpectedly`);
    },
  });
}

export function openNotesDb(): Promise<IDBPDatabase<NotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<NotesDb>(getActiveDbName(), DB_VERSION, {
      upgrade: upgradeNotesDb,
      // Without these, a version bump with a second tab open hangs forever with
      // no diagnostic. Fail loudly instead.
      blocked() {
        console.warn(`[${DB_NAME}] upgrade blocked: another tab still holds an older connection`);
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
