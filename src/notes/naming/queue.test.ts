import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeTextGenerator, type FakeTextGenerator } from '@/gaps/fakeTextGenerator';
import { createNamingQueue, noteReadyForNaming, type NamingQueue } from '@/notes/naming/queue';
import { createNote, getNote } from '@/storage/notes';
import { createPage, createTypedPage, setPageTranscript } from '@/storage/pages';
import type { NoteRecord, PageRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const MODEL = 'gemma4:12b';
const BASE_URL = 'http://localhost:11434';
const RESULT = JSON.stringify({ title: 'Newton on motion', summary: 'Covers the three laws.' });

function note(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'note-1',
    title: 'Note 1',
    status: 'complete',
    deviceId: 'huion',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 1_000,
    endedAt: 2_000,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId: null,
    ...overrides,
  };
}

function donePage(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page-1',
    noteId: 'note-1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [],
    pointCount: 0,
    capturedAt: 1_000,
    render: null,
    transcript: {
      markdown: 'Some notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    },
    finalizedAt: 2_000,
    ...overrides,
  };
}

describe('noteReadyForNaming', () => {
  it('is true for a complete note whose one page is done', () => {
    expect(noteReadyForNaming(note({ status: 'complete' }), [donePage()])).toBe(true);
  });

  it('is true for an interrupted note under the same condition', () => {
    expect(noteReadyForNaming(note({ status: 'interrupted' }), [donePage()])).toBe(true);
  });

  it('is false while active', () => {
    expect(noteReadyForNaming(note({ status: 'active' }), [donePage()])).toBe(false);
  });

  it('is false for a legacy note', () => {
    expect(noteReadyForNaming(note({ status: 'complete', legacy: true }), [donePage()])).toBe(false);
  });

  it('is false while any page has no transcript and is not typed', () => {
    const notDone = donePage({ transcript: null, source: 'live' });
    expect(noteReadyForNaming(note(), [donePage(), notDone])).toBe(false);
  });

  it('is false while any page transcript is pending (fix round 1, Critical)', () => {
    // The transcription queue's own `markPending` writes a non-null
    // `pending` transcript record and emits - a naive `transcript !== null`
    // check would misread that as finished, exactly the bug this guards.
    const pending = donePage({
      id: 'page-2',
      transcript: {
        markdown: '',
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    });
    expect(noteReadyForNaming(note(), [donePage(), pending])).toBe(false);
  });

  it('is false while any page transcript is running (fix round 1, Critical)', () => {
    const running = donePage({
      id: 'page-2',
      transcript: {
        markdown: '',
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'running',
        error: null,
        updatedAt: 0,
      },
    });
    expect(noteReadyForNaming(note(), [donePage(), running])).toBe(false);
  });

  it('is true for a typed page whose transcript is null (deliberately blank, K33)', () => {
    const typed = donePage({ id: 'page-2', source: 'typed', transcript: null, text: '' });
    expect(noteReadyForNaming(note(), [donePage(), typed])).toBe(true);
  });

  it('is false when any page transcript failed, even if every other page is done (K19)', () => {
    const failed = donePage({
      id: 'page-2',
      transcript: {
        markdown: '',
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'failed',
        error: 'Ollama unreachable',
        updatedAt: 0,
      },
    });
    expect(noteReadyForNaming(note(), [donePage(), failed])).toBe(false);
  });

  it('is false for a note with no pages', () => {
    expect(noteReadyForNaming(note(), [])).toBe(false);
  });
});

interface Deps {
  engine: { subscribePageFinalized: ReturnType<typeof vi.fn>; subscribeNoteEnded: ReturnType<typeof vi.fn> };
  transcriptionQueue: { subscribe: ReturnType<typeof vi.fn> };
  generator: FakeTextGenerator;
  queue: NamingQueue;
  /**
   * Awaits the fired event's own handling before resolving - the production
   * callback is typed `=> void`, but at runtime still returns the handler's
   * promise, which these fakes capture so a test need not race it with a
   * bare `idle()` call (nothing is `queued` yet the instant a fire-and-forget
   * event is dispatched; `idle()` alone cannot tell "nothing queued yet" from
   * "nothing left to do").
   */
  firePageFinalized: (pageId: string) => Promise<void>;
  fireTranscriptChange: (pageId: string) => Promise<void>;
  /** Fires the engine's `subscribeNoteEnded` trigger (fix round 2, Important 1). */
  fireNoteEnded: (noteId: string) => Promise<void>;
}

function setup(): Deps {
  const pageFinalizedHandlers: Array<(pageId: string) => Promise<void>> = [];
  const transcriptChangeHandlers: Array<(pageId: string) => Promise<void>> = [];
  const noteEndedHandlers: Array<(noteId: string) => Promise<void>> = [];
  const generator = createFakeTextGenerator([RESULT]);

  const engine = {
    subscribePageFinalized: vi.fn((fn: (pageId: string) => Promise<void>) => {
      pageFinalizedHandlers.push(fn);
      return () => {
        const i = pageFinalizedHandlers.indexOf(fn);
        if (i >= 0) pageFinalizedHandlers.splice(i, 1);
      };
    }),
    subscribeNoteEnded: vi.fn((fn: (noteId: string) => Promise<void>) => {
      noteEndedHandlers.push(fn);
      return () => {
        const i = noteEndedHandlers.indexOf(fn);
        if (i >= 0) noteEndedHandlers.splice(i, 1);
      };
    }),
  };
  const transcriptionQueue = {
    subscribe: vi.fn((fn: (pageId: string) => Promise<void>) => {
      transcriptChangeHandlers.push(fn);
      return () => {
        const i = transcriptChangeHandlers.indexOf(fn);
        if (i >= 0) transcriptChangeHandlers.splice(i, 1);
      };
    }),
  };

  const queue = createNamingQueue({
    engine,
    transcriptionQueue,
    getSettings: async () => ({ baseUrl: BASE_URL, model: MODEL }),
    createGenerator: () => generator,
  });

  return {
    engine,
    transcriptionQueue,
    generator,
    queue,
    firePageFinalized: (pageId) => Promise.all(pageFinalizedHandlers.map((fn) => fn(pageId))).then(() => undefined),
    fireTranscriptChange: (pageId) =>
      Promise.all(transcriptChangeHandlers.map((fn) => fn(pageId))).then(() => undefined),
    fireNoteEnded: (noteId) => Promise.all(noteEndedHandlers.map((fn) => fn(noteId))).then(() => undefined),
  };
}

describe('createNamingQueue', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('names a note on a subscribePageFinalized event once it is eligible', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes about Newton.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    await d.firePageFinalized(page.id);
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
    expect(d.generator.calls[0].prompt).toContain('Notes about Newton.');
    const updated = await getNote(created.id);
    expect(updated?.title).toBe('Newton on motion');
    expect(updated?.titleSource).toBe('auto');
    expect(updated?.summary).toBe('Covers the three laws.');
    expect(updated?.summaryModel).toBe(MODEL);
    expect(updated?.summaryPromptVersion).toBe('naming-v1');
  });

  it('names a note on a transcriptionQueue status-change event, for a note that ended before its pages finished', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes about Newton.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    // Not subscribePageFinalized - the transcript-change path.
    await d.fireTranscriptChange(page.id);
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
    const updated = await getNote(created.id);
    expect(updated?.title).toBe('Newton on motion');
  });

  it('never enqueues a note with a failed page (K19) - generator never called, no summary written', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const good = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(good.id, {
      markdown: 'Notes about Newton.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const bad = await createPage({ noteId: created.id, pageIndex: 1, devicePageNum: 2, source: 'live', strokes: [] });
    await setPageTranscript(bad.id, {
      markdown: '',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'failed',
      error: 'boom',
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    await d.firePageFinalized(good.id);
    await d.firePageFinalized(bad.id);
    await d.queue.idle();

    expect(d.generator.calls).toEqual([]);
    const updated = await getNote(created.id);
    expect(updated?.summary).toBeNull();
    expect(updated?.title).toBe('Note A');
  });

  it('does not name a note whose last page has only just been marked pending (fix round 1, Critical)', async () => {
    // The ordinary note-end race the review flagged: pages 1-2 are done,
    // the note just went complete, and page 3 has been finalized and
    // marked `pending` by the transcription queue (a non-null transcript
    // record, exactly what `markPending` writes) - but has not actually
    // transcribed yet. A naive `transcript !== null` check would read page
    // 3 as finished and name the note from pages 1-2 alone.
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    for (let i = 0; i < 2; i++) {
      const page = await createPage({
        noteId: created.id,
        pageIndex: i,
        devicePageNum: i + 1,
        source: 'live',
        strokes: [],
      });
      await setPageTranscript(page.id, {
        markdown: `Page ${i} notes.`,
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'done',
        error: null,
        updatedAt: 0,
      });
    }
    const page3 = await createPage({
      noteId: created.id,
      pageIndex: 2,
      devicePageNum: 3,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(page3.id, {
      markdown: '',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'pending',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    // The note-end event: page 3 was just finalized (and is now pending).
    await d.firePageFinalized(page3.id);
    await d.queue.idle();

    expect(d.generator.calls).toEqual([]);
    const updated = await getNote(created.id);
    expect(updated?.summary).toBeNull();
    expect(updated?.title).toBe('Note A');

    // Once page 3 actually finishes, the note is named correctly - proving
    // this is a timing fix, not a permanent block.
    await setPageTranscript(page3.id, {
      markdown: 'Page 2 notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    await d.fireTranscriptChange(page3.id);
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
    expect(d.generator.calls[0].prompt).toContain('Page 2 notes.');
  });

  it('never enqueues a note whose joined page text is entirely blank', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    await createTypedPage({ noteId: created.id, pageIndex: 0, text: '' });

    const d = setup();
    await d.queue.start();
    // fix round 2 (Fix 4): the real engine never emits `pageFinalized` for a
    // typed page (see `finalizeTypedPage`) - `subscribeNoteEnded` is the
    // trigger a typed page's note end actually produces.
    await d.fireNoteEnded(created.id);
    await d.queue.idle();

    expect(d.generator.calls).toEqual([]);
    const updated = await getNote(created.id);
    expect(updated?.summary).toBeNull();
  });

  it('names a note on a subscribeNoteEnded event, for a note that ends on a typed page (fix round 2, Important 1)', async () => {
    // This is the scenario the fix exists for: a note whose last page is
    // typed never gets `pageFinalized` for that page, so without this
    // trigger the note would sit unnamed until the next app start's
    // startup scan (`start()`'s own re-derivation from `summary === null`,
    // covered separately below).
    //
    // The note is created *after* `start()`, deliberately: creating it
    // first would let `start()`'s own startup scan enqueue it too, and the
    // test would pass even with the `subscribeNoteEnded` wiring deleted
    // outright - exactly the vacuous shape the project has shipped before.
    // Isolating the trigger this way is what a mutation check (removing the
    // subscription in `start()`) actually catches.
    const d = setup();
    await d.queue.start();

    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    await createTypedPage({ noteId: created.id, pageIndex: 0, text: 'Typed notes about Newton.' });

    await d.fireNoteEnded(created.id);
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
    expect(d.generator.calls[0].prompt).toContain('Typed notes about Newton.');
    const updated = await getNote(created.id);
    expect(updated?.title).toBe('Newton on motion');
    expect(updated?.summary).toBe('Covers the three laws.');
  });

  it('does not enqueue on subscribeNoteEnded when the note is not actually ready (e.g. a page is still transcribing)', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: '',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'pending',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    await d.fireNoteEnded(created.id);
    await d.queue.idle();

    expect(d.generator.calls).toEqual([]);
  });

  it('de-duplicates two eligible events for the same note into one generator call', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    let release: (() => void) | null = null;
    d.generator.onGenerate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await d.queue.start();
    await d.firePageFinalized(page.id);
    // A second event for the same note while the first job is still running
    // (the generator call is held open above).
    await d.fireTranscriptChange(page.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    (release as (() => void) | null)?.();
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
  });

  it('start() re-scans and names a note that was already eligible with summary: null before it ran', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    await d.queue.start();
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
    const updated = await getNote(created.id);
    expect(updated?.title).toBe('Newton on motion');
  });

  it('start() does not re-name a note that already has a summary, until a live event fires', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    // Already named by an earlier run.
    const { setNoteSummary } = await import('@/storage/notes');
    await setNoteSummary(created.id, { summary: 'Existing summary.', model: MODEL, promptVersion: 'naming-v1' });

    const d = setup();
    await d.queue.start();
    await d.queue.idle();

    expect(d.generator.calls).toEqual([]);

    // A live event (e.g. a resumed note ending a second time) still fires.
    await d.firePageFinalized(page.id);
    await d.queue.idle();

    expect(d.generator.calls).toHaveLength(1);
  });

  it('swallows a generator failure, leaving the note untouched; a later retry tries again', async () => {
    const created = await createNote({ title: 'Note A', deviceId: 'huion', pageBaseline: 0, status: 'complete' });
    const page = await createPage({ noteId: created.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(page.id, {
      markdown: 'Notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const d = setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    d.generator.failWith = new Error('Ollama 500: boom');
    await d.queue.start();
    await d.firePageFinalized(page.id);
    await d.queue.idle();

    let updated = await getNote(created.id);
    expect(updated?.title).toBe('Note A');
    expect(updated?.summary).toBeNull();
    expect(logged).toHaveBeenCalled();

    d.generator.failWith = null;
    await d.fireTranscriptChange(page.id);
    await d.queue.idle();

    updated = await getNote(created.id);
    expect(updated?.title).toBe('Newton on motion');
    logged.mockRestore();
  });
});
