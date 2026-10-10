import { beforeEach, describe, expect, it } from 'vitest';

import { loadSearchCorpus } from '@/search/corpus';
import { createNote } from '@/storage/notes';
import { createPage, createTypedPage, setPageTranscript } from '@/storage/pages';
import { createRecording, finalizeRecording } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

beforeEach(async () => {
  await resetDatabase();
});

describe('loadSearchCorpus', () => {
  it('returns an empty corpus for an empty database', async () => {
    const corpus = await loadSearchCorpus();
    expect(corpus.notes).toEqual([]);
    expect(corpus.recordings).toEqual([]);
    expect(corpus.recordingOwner.size).toBe(0);
  });

  it("groups a note's pages by pageIndex, ink and typed alike", async () => {
    const note = await createNote({ title: 'Lecture 1', deviceId: 'd1', pageBaseline: 0 });
    const p1 = await createPage({
      noteId: note.id,
      pageIndex: 1,
      devicePageNum: 1,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(p1.id, {
      markdown: 'ink text',
      model: 'gemma4',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    const p0 = await createTypedPage({ noteId: note.id, pageIndex: 0, text: 'typed text' });

    const corpus = await loadSearchCorpus();
    const found = corpus.notes.find((n) => n.note.id === note.id)!;
    expect(found.pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    expect(found.pages[0]).toMatchObject({ pageId: p0.id, isTyped: true, text: 'typed text' });
    expect(found.pages[1]).toMatchObject({ pageId: p1.id, isTyped: false, text: 'ink text' });
  });

  it('maps a direct and a session-linked recording to the same note, and leaves a standalone one unmapped', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({
      title: 'N',
      deviceId: 'd1',
      pageBaseline: 0,
      sessionId: session.id,
    });
    const direct = await createRecording(
      { title: 'r1', durationMs: 1000, noteId: note.id },
      new Blob(['a']),
    );
    await finalizeRecording(direct.id, new Blob(['a']), { endedAt: 2, durationMs: 1000 });
    const viaSession = await createRecording(
      { title: 'r2', durationMs: 1000, sessionId: session.id },
      new Blob(['b']),
    );
    await finalizeRecording(viaSession.id, new Blob(['b']), { endedAt: 2, durationMs: 1000 });
    const standalone = await createRecording({ title: 'r3', durationMs: 1000 }, new Blob(['c']));
    await finalizeRecording(standalone.id, new Blob(['c']), { endedAt: 2, durationMs: 1000 });

    const corpus = await loadSearchCorpus();
    expect(corpus.recordingOwner.get(direct.id)).toBe(note.id);
    expect(corpus.recordingOwner.get(viaSession.id)).toBe(note.id);
    expect(corpus.recordingOwner.has(standalone.id)).toBe(false);
    expect(corpus.recordings.map((r) => r.id).sort()).toEqual(
      [direct.id, standalone.id, viaSession.id].sort(),
    );
  });
});
