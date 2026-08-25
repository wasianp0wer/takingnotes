import { DB_NAME, resetNotesDbForTests } from '@/storage/db';

/** Closes any open connection and deletes the database so each test starts clean. */
export async function resetDatabase(): Promise<void> {
  await resetNotesDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('deleteDatabase blocked - a connection was left open'));
  });
}
