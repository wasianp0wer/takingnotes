import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { NoteRecord, PageRecord, SettingRecord } from '@/storage/types';

export const DB_NAME = 'takingnotes';
export const DB_VERSION = 1;

export interface NotesDb extends DBSchema {
  notes: {
    key: string;
    value: NoteRecord;
    indexes: { 'by-started': number };
  };
  pages: {
    key: string;
    value: PageRecord;
    indexes: { 'by-note': string };
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<NotesDb>> | null = null;

export function openNotesDb(): Promise<IDBPDatabase<NotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<NotesDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('notes')) {
          const notes = db.createObjectStore('notes', { keyPath: 'id' });
          notes.createIndex('by-started', 'startedAt');
        }
        if (!db.objectStoreNames.contains('pages')) {
          const pages = db.createObjectStore('pages', { keyPath: 'id' });
          pages.createIndex('by-note', 'noteId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Closes and drops the cached connection so each test starts from a fresh
 * database. Closing matters: `indexedDB.deleteDatabase` blocks indefinitely
 * while any connection to it is still open.
 */
export async function resetNotesDbForTests(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}
