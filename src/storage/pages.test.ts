import { beforeEach, describe, expect, it } from 'vitest';

import { openNotesDb } from '@/storage/db';
import { createNote, deleteNote } from '@/storage/notes';
import {
  countPoints,
  createPage,
  createTypedPage,
  finalizePage,
  getPage,
  getPageRender,
  isTypedPage,
  listPages,
  pageEndedAt,
  setPageRender,
  setPageGapAnalysis,
  setPageStrokes,
  setPageText,
  setPageTranscript,
  TYPED_MODEL,
  TYPED_PROMPT_VERSION,
} from '@/storage/pages';
import type { GapAnalysisMeta, PageRecord, PageStroke } from '@/storage/types';
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

  it('replaces the strokes of a page and recomputes its point count', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });
    expect(page.finalizedAt).toBeNull();

    const updated = await setPageStrokes(page.id, STROKES);
    expect(updated.pointCount).toBe(3);
    expect(updated.strokes).toEqual(STROKES);

    // Incremental capture calls this repeatedly with a growing array; replacing
    // rather than appending is what makes a re-flush of the same strokes a
    // no-op instead of a duplication.
    const again = await setPageStrokes(page.id, STROKES);
    expect(again.pointCount).toBe(3);
    expect(again.strokes).toHaveLength(2);

    const shorter = await setPageStrokes(page.id, [STROKES[0]]);
    expect(shorter.pointCount).toBe(2);
  });

  it('keeps live-capture timestamps on strokes and points', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    await setPageStrokes(page.id, [
      {
        points: [{ x: 0.5, y: 0.5, pressure: 0.3, t: 1_700 }],
        startedAt: 1_700,
        endedAt: 1_700,
      },
    ]);

    const loaded = await getPage(page.id);
    expect(loaded?.strokes[0].startedAt).toBe(1_700);
    expect(loaded?.strokes[0].endedAt).toBe(1_700);
    expect(loaded?.strokes[0].points[0].t).toBe(1_700);
  });

  it('finalizes a page once and keeps the first timestamp', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    const finalized = await finalizePage(page.id, 5_000);
    expect(finalized.finalizedAt).toBe(5_000);

    // Startup recovery finalizes whatever is still open; it must not move the
    // mark on a page that was already closed properly.
    const again = await finalizePage(page.id, 9_000);
    expect(again.finalizedAt).toBe(5_000);
  });

  it('throws when finalizing or re-stroking an unknown page', async () => {
    await expect(finalizePage('missing', 1)).rejects.toThrow('missing');
    await expect(setPageStrokes('missing', [])).rejects.toThrow('missing');
  });

  it('treats a page created with an explicit finalizedAt as closed', async () => {
    // The legacy migration imports complete ROM pages; they must never look
    // like a page that is still being written.
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 1,
      source: 'rom',
      strokes: STROKES,
      capturedAt: 2_000,
      finalizedAt: 2_000,
    });

    expect(page.finalizedAt).toBe(2_000);
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

describe('typed pages', () => {
  it('creates a typed page with no strokes and no transcript', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 2 });
    expect(page.source).toBe('typed');
    expect(page.strokes).toEqual([]);
    expect(page.pointCount).toBe(0);
    expect(page.devicePageNum).toBeNull();
    expect(page.text).toBe('');
    expect(page.transcript).toBeNull();
    expect(page.finalizedAt).toBeNull();
    expect(isTypedPage(page)).toBe(true);
  });

  it('writing text mirrors it into the transcript as already done', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 0 });
    const updated = await setPageText(page.id, '  Leviathan ch. 13  ');
    expect(updated.text).toBe('  Leviathan ch. 13  ');
    expect(updated.transcript).toMatchObject({
      markdown: 'Leviathan ch. 13',
      model: TYPED_MODEL,
      promptVersion: TYPED_PROMPT_VERSION,
      status: 'done',
      error: null,
    });
  });

  it('leaves a blank typed page without a transcript', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 0 });
    await setPageText(page.id, 'something');
    const cleared = await setPageText(page.id, '   \n  ');
    expect(cleared.text).toBe('   \n  ');
    expect(cleared.transcript).toBeNull();
  });

  it('refuses to write text onto an ink page', async () => {
    const ink = await createPage({
      noteId: 'note-1', pageIndex: 0, devicePageNum: null, source: 'live', strokes: [],
    });
    await expect(setPageText(ink.id, 'typed')).rejects.toThrow(/typed/i);
  });
});

describe('pageEndedAt', () => {
  it('uses the latest stroke end when there is one', () => {
    const page = {
      capturedAt: 1_000,
      strokes: [{ points: [], endedAt: 5_000 }, { points: [], endedAt: 9_000 }],
    } as unknown as PageRecord;
    expect(pageEndedAt(page)).toBe(9_000);
  });

  it('falls back to capturedAt for a page with no timestamped strokes', () => {
    const page = { capturedAt: 1_000, strokes: [{ points: [] }] } as unknown as PageRecord;
    expect(pageEndedAt(page)).toBe(1_000);
  });
});

describe('setPageGapAnalysis', () => {
  const meta = (patch: Partial<GapAnalysisMeta> = {}): GapAnalysisMeta => ({
    status: 'done',
    at: 5_000,
    model: 'gemma4:12b',
    promptVersion: 'gap-gemma-v1',
    error: null,
    summarized: false,
    ...patch,
  });

  async function freshPage() {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    return createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });
  }

  it('starts absent, which reads as never analyzed', async () => {
    const page = await freshPage();
    expect(page.gapAnalysis).toBeUndefined();
  });

  it('stores the analysis meta and leaves the rest of the page alone', async () => {
    const page = await createPage({
      noteId: (await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 })).id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: STROKES,
    });

    const updated = await setPageGapAnalysis(page.id, meta());

    expect(updated.gapAnalysis).toEqual(meta());
    expect(updated.pointCount).toBe(3);
    expect(await getPage(page.id)).toEqual(updated);
  });

  it('replaces an earlier analysis, including a failure', async () => {
    const page = await freshPage();
    await setPageGapAnalysis(page.id, meta({ status: 'running' }));

    const failed = await setPageGapAnalysis(
      page.id,
      meta({ status: 'failed', error: 'Ollama 500', at: 6_000 }),
    );

    expect(failed.gapAnalysis).toMatchObject({ status: 'failed', error: 'Ollama 500' });
  });

  it('clears the analysis when passed null', async () => {
    const page = await freshPage();
    await setPageGapAnalysis(page.id, meta());
    const cleared = await setPageGapAnalysis(page.id, null);
    expect(cleared.gapAnalysis).toBeNull();
  });

  it('rejects a missing page', async () => {
    await expect(setPageGapAnalysis('nope', meta())).rejects.toThrow('Page not found: nope');
  });
});
