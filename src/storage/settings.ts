import { openNotesDb } from '@/storage/db';

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openNotesDb();
  const record = await db.get('settings', key);
  // A stored `null` is a real value; only a missing record uses the fallback.
  return record === undefined ? fallback : (record.value as T);
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await openNotesDb();
  await db.put('settings', { key, value });
}
