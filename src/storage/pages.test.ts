import { beforeEach, describe, expect, it } from 'vitest';

import { createNote, deleteNote } from '@/storage/notes';
import {
  countPoints,
  createPage,
  getPage,
  listPages,
  setPageRender,
  setPageTranscript,
} from '@/storage/pages';
import type { PageStroke } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const STROKES: PageStroke[] = [
  { points: [{ x: 0.1, y: 0.1, pressure: 0.5 }, { x: 0.2, y: 0.2, pressure: 0.6 }] },
  { points: [{ x: 0.3, y: 0.3, pressure: 0.4 }] },
];

beforeEach(resetDatabase);

describe('countPoints', () => {
  it('sums points across strokes', () => {
    expect(countPoints(STROKES)).toBe(3);
  });

  it('returns zero for no strokes', () => {
    expect(countPoints([])).toBe(0);
  });
});

describe('pages repository', () => {
  it('creates a page and derives its point count', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 4,
      source: 'rom',
      strokes: STROKES,
    });

    expect(page.pointCount).toBe(3);
    expect(page.source).toBe('rom');
    expect(page.devicePageNum).toBe(4);
    expect(page.render).toBeNull();
    expect(page.renderType).toBeNull();
    expect(page.transcript).toBeNull();
    expect(await getPage(page.id)).toEqual(page);
  });

  it('lists pages ordered by pageIndex regardless of insertion order', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    for (const pageIndex of [2, 0, 1]) {
      await createPage({
        noteId: note.id,
        pageIndex,
        devicePageNum: null,
        source: 'live',
        strokes: [],
      });
    }

    const listed = await listPages(note.id);
    expect(listed.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  });

  it('scopes listPages to one note', async () => {
    const first = await createNote({ title: 'A', deviceId: 'huion:abc', pageBaseline: 0 });
    const second = await createNote({ title: 'B', deviceId: 'huion:abc', pageBaseline: 0 });
    await createPage({ noteId: first.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });
    await createPage({ noteId: second.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });

    expect(await listPages(first.id)).toHaveLength(1);
  });

  it('round-trips a rendered image through IndexedDB', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await setPageRender(page.id, bytes.buffer, 'image/png', 800, 1000);

    const loaded = await getPage(page.id);
    expect(loaded?.renderW).toBe(800);
    expect(loaded?.renderH).toBe(1000);
    expect(loaded?.renderType).toBe('image/png');
    expect(new Uint8Array(loaded!.render!)).toEqual(bytes);
  });

  it('stores a transcript on a page', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    await setPageTranscript(page.id, {
      markdown: '# Heading',
      model: 'some-vision-model',
      status: 'done',
      error: null,
      updatedAt: 42,
    });

    const loaded = await getPage(page.id);
    expect(loaded?.transcript?.markdown).toBe('# Heading');
    expect(loaded?.transcript?.status).toBe('done');
  });

  it('throws when updating an unknown page', async () => {
    await expect(
      setPageTranscript('missing', {
        markdown: '',
        model: 'm',
        status: 'failed',
        error: 'nope',
        updatedAt: 1,
      }),
    ).rejects.toThrow('missing');
  });

  it('deletes pages when their note is deleted', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    await createPage({ noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });
    await createPage({ noteId: note.id, pageIndex: 1, devicePageNum: null, source: 'live', strokes: [] });

    await deleteNote(note.id);
    expect(await listPages(note.id)).toEqual([]);
  });
});
