import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findImportBlockers } from '@/backup/guards';
import { openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const throwingStorage = {
  getItem() {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('denied');
  },
  removeItem() {
    throw new Error('denied');
  },
} as unknown as Storage;

const oneTab = async () => 1;
const idle = () => ({ countTabs: oneTab, storage: memoryStorage() });

function recording(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    sessionId: null,
    noteId: null,
    title: 'R',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript: null,
    ...over,
  };
}

function audioTranscript(status: string) {
  return { text: '', segments: [], model: 'm', language: null, status, error: null, updatedAt: 1 };
}

beforeEach(resetDatabase);
afterEach(resetDatabase);

describe('findImportBlockers', () => {
  it('no blockers on idle data', async () => {
    const db = await openNotesDb();
    await db.put('sessions', { id: 's1', title: 'S', status: 'ended', startedAt: 1, endedAt: 2 });
    await db.put('notes', { id: 'n1', status: 'interrupted' } as never);
    await db.put('recordings', recording({ transcript: audioTranscript('paused') }) as never);
    await db.put('pages', { id: 'p1', noteId: 'n1', transcript: { status: 'done' } } as never);
    await db.put('pages', { id: 'p2', noteId: 'n1', transcript: null } as never);
    expect(await findImportBlockers(idle())).toEqual([]);
  });

  it('blocks on an active session', async () => {
    const db = await openNotesDb();
    await db.put('sessions', { id: 's1', title: 'S', status: 'active', startedAt: 1, endedAt: null });
    expect(await findImportBlockers(idle())).toEqual(['session-active']);
  });

  it('blocks on an active note', async () => {
    const db = await openNotesDb();
    await db.put('notes', { id: 'n1', status: 'active' } as never);
    expect(await findImportBlockers(idle())).toEqual(['session-active']);
  });

  it('blocks on a recording in progress', async () => {
    const db = await openNotesDb();
    await db.put('recordings', recording({ endedAt: null }) as never);
    expect(await findImportBlockers(idle())).toEqual(['recording-active']);
  });

  it('blocks on a running page transcription', async () => {
    const db = await openNotesDb();
    await db.put('pages', { id: 'p1', noteId: 'n1', transcript: { status: 'running' } } as never);
    expect(await findImportBlockers(idle())).toEqual(['transcription-running']);
  });

  it('blocks on a pending page transcription', async () => {
    const db = await openNotesDb();
    await db.put('pages', { id: 'p1', noteId: 'n1', transcript: { status: 'pending' } } as never);
    expect(await findImportBlockers(idle())).toEqual(['transcription-running']);
  });

  it('blocks on a running recording transcription', async () => {
    const db = await openNotesDb();
    await db.put('recordings', recording({ transcript: audioTranscript('running') }) as never);
    expect(await findImportBlockers(idle())).toEqual(['transcription-running']);
  });

  it('blocks on a pending recording transcription', async () => {
    const db = await openNotesDb();
    await db.put('recordings', recording({ transcript: audioTranscript('pending') }) as never);
    expect(await findImportBlockers(idle())).toEqual(['transcription-running']);
  });

  it('blocks on other tabs', async () => {
    expect(await findImportBlockers({ countTabs: async () => 2, storage: memoryStorage() })).toEqual([
      'other-tabs',
    ]);
  });

  it('an unknown tab count is not a blocker', async () => {
    expect(await findImportBlockers({ countTabs: async () => null, storage: memoryStorage() })).toEqual(
      [],
    );
  });

  it('blocks when storage cannot hold the pointer', async () => {
    expect(await findImportBlockers({ countTabs: oneTab, storage: throwingStorage })).toEqual([
      'storage-blocked',
    ]);
    expect(await findImportBlockers({ countTabs: oneTab, storage: null })).toEqual(['storage-blocked']);
  });

  it('reports every blocker at once', async () => {
    const db = await openNotesDb();
    await db.put('sessions', { id: 's1', title: 'S', status: 'active', startedAt: 1, endedAt: null });
    await db.put('recordings', recording({ endedAt: null, transcript: audioTranscript('running') }) as never);
    const blockers = await findImportBlockers({ countTabs: async () => 3, storage: null });
    expect([...blockers].sort()).toEqual(
      ['other-tabs', 'recording-active', 'session-active', 'storage-blocked', 'transcription-running'].sort(),
    );
  });
});
