import { beforeEach, describe, expect, it } from 'vitest';

import { createNote, deleteNote, getNote, listNotes, updateNote } from '@/storage/notes';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('notes repository', () => {
  it('creates a note with sensible defaults', async () => {
    const note = await createNote({ title: 'Standup', deviceId: 'huion:abc', pageBaseline: 3 });

    expect(note.id).toBeTruthy();
    expect(note.title).toBe('Standup');
    expect(note.status).toBe('active');
    expect(note.deviceType).toBe('huion');
    expect(note.pageBaseline).toBe(3);
    expect(note.endedAt).toBeNull();
    expect(note.summary).toBeNull();
    expect(note.legacy).toBe(false);
    expect(note.legacySourceId).toBeNull();
    expect(note.deviceName).toBeNull();
    expect(note.pageWidth).toBeNull();
    expect(note.pageHeight).toBeNull();
    expect(note.startedAt).toBeGreaterThan(0);
  });

  it('persists both writes when two note updates race', async () => {
    const created = await createNote({ title: 'Race', deviceId: 'huion:abc', pageBaseline: 0 });

    await Promise.all([
      updateNote(created.id, { summary: 'a summary' }),
      updateNote(created.id, { status: 'complete' }),
    ]);

    const loaded = await getNote(created.id);
    expect(loaded?.summary).toBe('a summary');
    expect(loaded?.status).toBe('complete');
  });

  it('round-trips a note through the database', async () => {
    const created = await createNote({ title: 'Design', deviceId: 'huion:abc', pageBaseline: 0 });
    const loaded = await getNote(created.id);
    expect(loaded).toEqual(created);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getNote('missing')).toBeUndefined();
  });

  it('applies a partial update and returns the merged record', async () => {
    const created = await createNote({ title: 'Draft', deviceId: 'huion:abc', pageBaseline: 0 });
    const updated = await updateNote(created.id, { status: 'complete', endedAt: 1234 });

    expect(updated.status).toBe('complete');
    expect(updated.endedAt).toBe(1234);
    expect(updated.title).toBe('Draft');
    expect(await getNote(created.id)).toEqual(updated);
  });

  it('throws when updating an unknown id', async () => {
    await expect(updateNote('missing', { title: 'x' })).rejects.toThrow('missing');
  });

  it('lists notes newest first', async () => {
    const first = await createNote({ title: 'One', deviceId: 'huion:abc', pageBaseline: 0 });
    await updateNote(first.id, { startedAt: 1000 });
    const second = await createNote({ title: 'Two', deviceId: 'huion:abc', pageBaseline: 0 });
    await updateNote(second.id, { startedAt: 2000 });

    const listed = await listNotes();
    expect(listed.map((note) => note.title)).toEqual(['Two', 'One']);
  });

  it('deletes a note', async () => {
    const created = await createNote({ title: 'Temp', deviceId: 'huion:abc', pageBaseline: 0 });
    await deleteNote(created.id);
    expect(await getNote(created.id)).toBeUndefined();
  });
});
