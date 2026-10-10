import { beforeEach, describe, expect, it } from 'vitest';

import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  listNotesBySession,
  normalizeTags,
  renameNote,
  setNoteSummary,
  setNoteTags,
  tagsOf,
  titleSourceOf,
  updateNote,
  listTagVocabulary,
} from '@/storage/notes';
import type { CreateNoteInput } from '@/storage/notes';
import type { NoteRecord } from '@/storage/types';
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

  it('defaults sessionId to null', async () => {
    const note = await createNote({ title: 'Loose', deviceId: 'huion:abc', pageBaseline: 0 });
    expect(note.sessionId).toBeNull();
  });

  it('lists the notes of one session, oldest first', async () => {
    const mine = await createNote({
      title: 'First',
      deviceId: 'huion:abc',
      pageBaseline: 0,
      sessionId: 'sess-1',
      startedAt: 1_000,
    });
    const alsoMine = await createNote({
      title: 'Second',
      deviceId: 'huion:abc',
      pageBaseline: 0,
      sessionId: 'sess-1',
      startedAt: 2_000,
    });
    await createNote({
      title: 'Theirs',
      deviceId: 'huion:abc',
      pageBaseline: 0,
      sessionId: 'sess-2',
    });
    // A note with no session must not be swept into any session's list.
    await createNote({ title: 'Loose', deviceId: 'huion:abc', pageBaseline: 0 });

    const listed = await listNotesBySession('sess-1');
    expect(listed.map((note) => note.id)).toEqual([mine.id, alsoMine.id]);
    expect(await listNotesBySession('sess-3')).toEqual([]);
  });
});

describe('tag normalization', () => {
  it('trims, lowercases, deduplicates and drops blanks', () => {
    expect(normalizeTags(['  Math ', 'MATH', 'history', '', '   ', 'History']))
      .toEqual(['math', 'history']);
  });

  it('preserves first-seen order so a note\'s tags do not reshuffle on every write', () => {
    expect(normalizeTags(['zeta', 'alpha', 'ZETA'])).toEqual(['zeta', 'alpha']);
  });

  it('reads an absent tags field as empty', () => {
    expect(tagsOf({ id: 'n' } as NoteRecord)).toEqual([]);
  });
});

describe('note tags, titles and summaries', () => {
  async function note(overrides: Partial<CreateNoteInput> = {}) {
    return createNote({ title: 'Note 1', deviceId: 'huion:a', pageBaseline: 0, ...overrides });
  }

  it('normalizes on write', async () => {
    const created = await note();
    const updated = await setNoteTags(created.id, [' Seminar ', 'SEMINAR', 'week-3']);
    expect(updated.tags).toEqual(['seminar', 'week-3']);
    expect((await getNote(created.id))?.tags).toEqual(['seminar', 'week-3']);
  });

  it('renaming marks the title manual', async () => {
    const created = await note();
    const renamed = await renameNote(created.id, '  Hobbes, ch. 13  ');
    expect(renamed.title).toBe('Hobbes, ch. 13');
    expect(titleSourceOf(renamed)).toBe('manual');
  });

  it('refuses a blank rename', async () => {
    const created = await note();
    await expect(renameNote(created.id, '   ')).rejects.toThrow(/blank/i);
    expect((await getNote(created.id))?.title).toBe('Note 1');
  });

  it('throws when summarizing an unknown note', async () => {
    await expect(
      setNoteSummary('missing', { summary: 's', model: 'm', promptVersion: 'v' }),
    ).rejects.toThrow(/not found/i);
  });

  it('a summary writes the title when the title is still the default', async () => {
    const created = await note();
    const summarized = await setNoteSummary(created.id, {
      summary: 'Sovereignty and the state of nature.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: 'Hobbes on sovereignty',
    });
    expect(summarized.title).toBe('Hobbes on sovereignty');
    expect(titleSourceOf(summarized)).toBe('auto');
    expect(summarized.summary).toBe('Sovereignty and the state of nature.');
    expect(summarized.summaryModel).toBe('gemma4:12b');
    expect(summarized.summaryPromptVersion).toBe('summary/1');
  });

  it('a summary never overwrites a manual title, but still writes the summary', async () => {
    const created = await note();
    await renameNote(created.id, 'My own title');
    const summarized = await setNoteSummary(created.id, {
      summary: 'Sovereignty.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: 'Hobbes on sovereignty',
    });
    expect(summarized.title).toBe('My own title');
    expect(titleSourceOf(summarized)).toBe('manual');
    expect(summarized.summary).toBe('Sovereignty.');
  });

  it('a summary with a blank title leaves the title alone', async () => {
    const created = await note();
    const summarized = await setNoteSummary(created.id, {
      summary: 'Something.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: '   ',
    });
    expect(summarized.title).toBe('Note 1');
    expect(titleSourceOf(summarized)).toBe('default');
  });

  it('builds the tag vocabulary from every note, sorted and deduplicated', async () => {
    const a = await note({ title: 'A' });
    const b = await note({ title: 'B' });
    await setNoteTags(a.id, ['seminar', 'week-3']);
    await setNoteTags(b.id, ['Seminar', 'lecture']);
    expect(await listTagVocabulary()).toEqual(['lecture', 'seminar', 'week-3']);
  });

  it('a rename racing a summary keeps the manual title', async () => {
    const created = await note();

    // Deliberately not awaited in sequence: both open readwrite transactions on
    // 'notes', so this is the only arrangement where the two can overlap at all.
    const summary = setNoteSummary(created.id, {
      summary: 'Sovereignty and the state of nature.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: 'Hobbes on sovereignty',
    });
    const rename = renameNote(created.id, 'My own title');
    await Promise.all([summary, rename]);

    const after = await getNote(created.id);
    // Whichever transaction won, the manual rename is what survives, and the
    // summary lands either way.
    expect(after?.title).toBe('My own title');
    expect(titleSourceOf(after!)).toBe('manual');
    expect(after?.summary).toBe('Sovereignty and the state of nature.');
  });
});
