import { beforeEach, describe, expect, it } from 'vitest';

import { DB_VERSION, openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('openNotesDb', () => {
  it('creates the expected object stores', async () => {
    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(['notes', 'pages', 'settings']);
  });

  it('creates the by-note index on pages', async () => {
    const db = await openNotesDb();
    const index = db.transaction('pages').store.index('by-note');
    expect(index.name).toBe('by-note');
  });

  it('returns the same connection on repeated calls', async () => {
    const first = await openNotesDb();
    const second = await openNotesDb();
    expect(first).toBe(second);
  });
});
