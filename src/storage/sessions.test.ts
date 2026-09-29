import { beforeEach, describe, expect, it } from 'vitest';

import {
  createSession,
  getSession,
  listSessions,
  updateSession,
} from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('sessions repository', () => {
  it('creates a session with sensible defaults', async () => {
    const session = await createSession({ title: 'Lecture 3' });

    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Lecture 3');
    expect(session.status).toBe('active');
    expect(session.startedAt).toBeGreaterThan(0);
    expect(session.endedAt).toBeNull();
  });

  it('round-trips a session through the database', async () => {
    const created = await createSession({ title: 'Seminar', startedAt: 500 });
    expect(await getSession(created.id)).toEqual(created);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getSession('missing')).toBeUndefined();
  });

  it('applies a partial update and returns the merged record', async () => {
    const created = await createSession({ title: 'Draft' });
    const updated = await updateSession(created.id, { status: 'ended', endedAt: 900 });

    expect(updated.status).toBe('ended');
    expect(updated.endedAt).toBe(900);
    expect(updated.title).toBe('Draft');
    expect(await getSession(created.id)).toEqual(updated);
  });

  it('throws when updating an unknown id', async () => {
    await expect(updateSession('missing', { title: 'x' })).rejects.toThrow('missing');
  });

  it('persists both writes when two session updates race', async () => {
    const created = await createSession({ title: 'Race' });

    await Promise.all([
      updateSession(created.id, { title: 'renamed' }),
      updateSession(created.id, { status: 'ended' }),
    ]);

    const loaded = await getSession(created.id);
    expect(loaded?.title).toBe('renamed');
    expect(loaded?.status).toBe('ended');
  });

  it('lists sessions newest first', async () => {
    const first = await createSession({ title: 'One', startedAt: 1_000 });
    const second = await createSession({ title: 'Two', startedAt: 2_000 });

    expect((await listSessions()).map((s) => s.id)).toEqual([second.id, first.id]);
  });
});
