import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assignSessionsToOrphanNotes,
  subscribeSessionsAssigned,
} from '@/sessions/assignSessions';
import { buildSessionCatalog } from '@/sessions/catalog';
import { openNotesDb } from '@/storage/db';
import { createNote, getNote, listNotes } from '@/storage/notes';
import { createSession, getSession, listSessions } from '@/storage/sessions';
import type { NoteRecord, RecordingRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

function noteInput(title: string, startedAt: number, endedAt: number | null) {
  return {
    title,
    deviceId: 'd',
    pageBaseline: 0,
    status: 'complete' as const,
    startedAt,
    endedAt,
  };
}

/** A legacy note: `sessionId: null`, as `migrateLegacyNotebooks` writes it. */
function legacyNote(title: string, startedAt: number, endedAt: number | null) {
  return createNote({ ...noteInput(title, startedAt, endedAt), legacy: true, sessionId: null });
}

/** A v1 note, written before the field existed: no `sessionId` key at all. */
async function v1Note(title: string, startedAt: number, endedAt: number | null) {
  const note = await createNote(noteInput(title, startedAt, endedAt));
  const bare: NoteRecord = { ...note };
  delete bare.sessionId;
  const db = await openNotesDb();
  await db.put('notes', bare);
  return bare;
}

function orphanRecording(id: string, startedAt: number): RecordingRecord {
  return {
    id,
    sessionId: null,
    noteId: null,
    title: `rec ${id}`,
    startedAt,
    endedAt: startedAt + 1,
    durationMs: 1,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript: null,
  };
}

beforeEach(async () => {
  await resetDatabase();
});

describe('assignSessionsToOrphanNotes', () => {
  it('gives a legacy note and a v1 note each an ended session of their own', async () => {
    const legacy = await legacyNote('Old lecture', 1_000, 2_000);
    const v1 = await v1Note('Older lecture', 500, null);

    expect(await assignSessionsToOrphanNotes()).toBe(2);

    const legacyAfter = await getNote(legacy.id);
    const v1After = await getNote(v1.id);
    expect(typeof legacyAfter?.sessionId).toBe('string');
    expect(typeof v1After?.sessionId).toBe('string');
    expect(legacyAfter?.sessionId).not.toBe(v1After?.sessionId);

    expect(await getSession(legacyAfter!.sessionId!)).toMatchObject({
      title: 'Old lecture',
      startedAt: 1_000,
      status: 'ended',
      endedAt: 2_000,
    });
    // No end time on the note: the session ends when it started.
    expect(await getSession(v1After!.sessionId!)).toMatchObject({
      title: 'Older lecture',
      startedAt: 500,
      status: 'ended',
      endedAt: 500,
    });
  });

  it('leaves a note already in a session untouched', async () => {
    const session = await createSession({ title: 'Live', startedAt: 10 });
    const inSession = await createNote({
      ...noteInput('Live', 10, 20),
      sessionId: session.id,
    });

    expect(await assignSessionsToOrphanNotes()).toBe(0);

    expect(await getNote(inSession.id)).toEqual(inSession);
    expect(await listSessions()).toHaveLength(1);
  });

  it('does nothing on a second run', async () => {
    await legacyNote('Old', 1, 2);

    expect(await assignSessionsToOrphanNotes()).toBe(1);
    expect(await assignSessionsToOrphanNotes()).toBe(0);
    expect(await listSessions()).toHaveLength(1);
  });

  it('gives each orphan exactly one session when two sweeps overlap', async () => {
    await legacyNote('A', 1, 2);
    await v1Note('B', 3, 4);

    await Promise.all([assignSessionsToOrphanNotes(), assignSessionsToOrphanNotes()]);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    const notes = await listNotes();
    expect(new Set(notes.map((n) => n.sessionId))).toEqual(new Set(sessions.map((s) => s.id)));
  });

  it('skips the note the engine has open', async () => {
    const open = await legacyNote('Open', 1, null);
    const closed = await legacyNote('Closed', 2, 3);

    expect(await assignSessionsToOrphanNotes({ activeNoteId: () => open.id })).toBe(1);

    expect((await getNote(open.id))?.sessionId).toBeNull();
    expect(typeof (await getNote(closed.id))?.sessionId).toBe('string');
  });

  it('announces a sweep that linked notes, and stays quiet otherwise', async () => {
    const heard = vi.fn();
    const off = subscribeSessionsAssigned(heard);
    try {
      expect(await assignSessionsToOrphanNotes()).toBe(0);
      expect(heard).not.toHaveBeenCalled();

      await legacyNote('Old', 1, 2);
      await assignSessionsToOrphanNotes();
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('leaves only orphan recordings in the catalog\'s uncategorized group', async () => {
    const legacy = await legacyNote('Old', 1_000, 2_000);
    const v1 = await v1Note('Older', 500, 600);

    await assignSessionsToOrphanNotes();

    const catalog = buildSessionCatalog(await listNotes(), [orphanRecording('r1', 700)]);
    expect(catalog.sessions.map((e) => e.key).sort()).toEqual(
      [`note:${legacy.id}`, `note:${v1.id}`].sort(),
    );
    expect(catalog.uncategorized.map((e) => e.key)).toEqual(['recording:r1']);
  });
});
