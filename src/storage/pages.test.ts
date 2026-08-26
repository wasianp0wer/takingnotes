import { beforeEach, describe, expect, it } from 'vitest';

import { openNotesDb } from '@/storage/db';
import { createNote, deleteNote } from '@/storage/notes';
import {
  countPoints,
  createPage,
  getPage,
  getPageRender,
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

  it('round-trips a rendered image Blob through IndexedDB', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await setPageRender(page.id, new Blob([bytes], { type: 'image/png' }), 800, 1000);

    const loaded = await getPage(page.id);
    expect(loaded?.render).toEqual({ type: 'image/png', width: 800, height: 1000 });

    const blob = await getPageRender(page.id);
    expect(blob?.type).toBe('image/png');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('stores exactly the bytes of a subarray-backed Blob', async () => {
    // `view.buffer` would have stored all 8 bytes of the backing buffer; taking
    // a Blob removes that footgun entirely.
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    const view = new Uint8Array([0, 0, 7, 8, 9, 0, 0, 0]).subarray(2, 5);
    await setPageRender(page.id, new Blob([view], { type: 'image/png' }), 10, 10);

    const blob = await getPageRender(page.id);
    expect(blob!.size).toBe(3);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('returns null from getPageRender when the page has no render', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    expect(await getPageRender(page.id)).toBeNull();
    expect(await getPageRender('missing')).toBeNull();
  });

  it('keeps image bytes out of listPages results', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });
    const bytes = new Uint8Array(4096).fill(7);
    await setPageRender(page.id, new Blob([bytes], { type: 'image/png' }), 800, 1000);

    const [listed] = await listPages(note.id);
    expect(listed.render).toEqual({ type: 'image/png', width: 800, height: 1000 });
    // No field anywhere on the record holds bytes.
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('"data"');
    for (const value of Object.values(listed)) {
      expect(value instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
  });

  it('persists both writes when two page updates race', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    await Promise.all([
      setPageRender(page.id, new Blob([new Uint8Array([1])], { type: 'image/png' }), 4, 5),
      setPageTranscript(page.id, {
        markdown: 'hi',
        model: 'm',
        promptVersion: 'v1',
        status: 'done',
        error: null,
        updatedAt: 1,
      }),
    ]);

    const loaded = await getPage(page.id);
    expect(loaded?.render).toEqual({ type: 'image/png', width: 4, height: 5 });
    expect(loaded?.transcript?.markdown).toBe('hi');
  });

  it('throws when rendering an unknown page', async () => {
    await expect(
      setPageRender('missing', new Blob([new Uint8Array([1])], { type: 'image/png' }), 1, 1),
    ).rejects.toThrow('missing');
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
      promptVersion: 'handwriting-v1',
      status: 'done',
      error: null,
      updatedAt: 42,
    });

    const loaded = await getPage(page.id);
    expect(loaded?.transcript?.markdown).toBe('# Heading');
    expect(loaded?.transcript?.status).toBe('done');
    // Both provenance fields must survive the round trip - they are what makes
    // "which pages need re-running after a model or prompt change" answerable.
    expect(loaded?.transcript?.model).toBe('some-vision-model');
    expect(loaded?.transcript?.promptVersion).toBe('handwriting-v1');
  });

  it('throws when updating an unknown page', async () => {
    await expect(
      setPageTranscript('missing', {
        markdown: '',
        model: 'm',
        promptVersion: 'v1',
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

  it('deletes page renders when their note is deleted', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const first = await createPage({
      noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [],
    });
    const second = await createPage({
      noteId: note.id, pageIndex: 1, devicePageNum: null, source: 'live', strokes: [],
    });
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    await setPageRender(first.id, blob, 1, 1);
    await setPageRender(second.id, blob, 1, 1);

    await deleteNote(note.id);

    expect(await getPageRender(first.id)).toBeNull();
    expect(await getPageRender(second.id)).toBeNull();
    const db = await openNotesDb();
    expect(await db.count('pageRenders')).toBe(0);
  });

  it('leaves another note\'s renders alone when one note is deleted', async () => {
    const doomed = await createNote({ title: 'A', deviceId: 'huion:abc', pageBaseline: 0 });
    const kept = await createNote({ title: 'B', deviceId: 'huion:abc', pageBaseline: 0 });
    const doomedPage = await createPage({
      noteId: doomed.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [],
    });
    const keptPage = await createPage({
      noteId: kept.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [],
    });
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    await setPageRender(doomedPage.id, blob, 1, 1);
    await setPageRender(keptPage.id, blob, 1, 1);

    await deleteNote(doomed.id);

    expect(await getPageRender(doomedPage.id)).toBeNull();
    expect(await getPageRender(keptPage.id)).not.toBeNull();
  });
});
