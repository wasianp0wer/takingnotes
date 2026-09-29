import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmitter } from '@/device/emitter';
import { createNote } from '@/storage/notes';
import {
  createPage,
  getPage,
  getPageRender,
  setPageTranscript,
} from '@/storage/pages';
import type { PageStroke, PageSource, TranscriptRecord, TranscriptStatus } from '@/storage/types';
import {
  createTranscriptionQueue,
  type TranscriptionQueue,
  type TranscriptionQueueDeps,
  type TranscriptionSettingsSnapshot,
} from '@/transcription/queue';
import type { TranscriptionResult } from '@/transcription/types';
import { resetDatabase } from '@/test/resetDb';

const SETTINGS: TranscriptionSettingsSnapshot = {
  baseUrl: 'http://o',
  model: 'gemma4:12b',
  renderLongEdge: 1024,
};

const PAGE_WIDTH = 1409;
const PAGE_HEIGHT = 1869;

/** The blob the fake renderer hands back, so tests can identify it by reference. */
const RENDER_BLOB = new Blob(['x'], { type: 'image/png' });

const RESULT: TranscriptionResult = {
  markdown: 'text',
  model: 'm',
  promptVersion: 'generic-v1',
};

const INK: PageStroke[] = [
  {
    points: [
      { x: 0.1, y: 0.1, pressure: 0.5, t: 1 },
      { x: 0.2, y: 0.3, pressure: 0.6, t: 2 },
    ],
    startedAt: 1,
    endedAt: 2,
  },
];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transcript(status: TranscriptStatus, extra?: Partial<TranscriptRecord>): TranscriptRecord {
  return {
    markdown: '',
    model: 'gemma4:12b',
    promptVersion: 'gemma-v1',
    status,
    error: null,
    updatedAt: 10,
    ...extra,
  };
}

let pageFinalized: ReturnType<typeof createEmitter<string>>;
let getSettings: ReturnType<typeof vi.fn>;
let transcribePage: ReturnType<typeof vi.fn>;
let createTranscriber: ReturnType<typeof vi.fn>;
let render: ReturnType<typeof vi.fn>;
let noteId: string;

beforeEach(async () => {
  await resetDatabase();
  pageFinalized = createEmitter<string>();
  getSettings = vi.fn(async () => ({ ...SETTINGS }));
  transcribePage = vi.fn(async () => ({ ...RESULT }));
  createTranscriber = vi.fn(() => ({ transcribePage }));
  render = vi.fn(async () => ({ blob: RENDER_BLOB, width: 772, height: 1024 }));

  const note = await createNote({
    title: 'Note',
    deviceId: 'huion',
    pageBaseline: 0,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
  });
  noteId = note.id;
});

function createQueue(overrides: Partial<TranscriptionQueueDeps> = {}): TranscriptionQueue {
  return createTranscriptionQueue({
    engine: { subscribePageFinalized: (fn) => pageFinalized.subscribe(fn) },
    getSettings: getSettings as unknown as TranscriptionQueueDeps['getSettings'],
    createTranscriber: createTranscriber as unknown as TranscriptionQueueDeps['createTranscriber'],
    render: render as unknown as TranscriptionQueueDeps['render'],
    now: () => 1000,
    ...overrides,
  });
}

async function seedPage(
  opts: {
    pageIndex?: number;
    strokes?: PageStroke[];
    source?: PageSource;
    finalizedAt?: number | null;
    transcript?: TranscriptRecord;
  } = {},
): Promise<string> {
  const page = await createPage({
    noteId,
    pageIndex: opts.pageIndex ?? 0,
    devicePageNum: null,
    source: opts.source ?? 'live',
    strokes: opts.strokes ?? INK,
    finalizedAt: opts.finalizedAt === undefined ? 500 : opts.finalizedAt,
  });
  if (opts.transcript) await setPageTranscript(page.id, opts.transcript);
  return page.id;
}

async function statusOf(pageId: string): Promise<TranscriptStatus | null> {
  const page = await getPage(pageId);
  return page?.transcript?.status ?? null;
}

describe('createTranscriptionQueue', () => {
  it('transcribes a page the engine finalizes and stores the render', async () => {
    const pageId = await seedPage({ finalizedAt: null });
    const queue = createQueue();
    await queue.start();

    pageFinalized.emit(pageId);
    await queue.idle();

    const page = await getPage(pageId);
    expect(page?.transcript).toEqual({
      markdown: 'text',
      model: 'm',
      promptVersion: 'generic-v1',
      status: 'done',
      error: null,
      updatedAt: 1000,
    });
    expect(page?.render).toEqual({ type: 'image/png', width: 772, height: 1024 });
    const stored = await getPageRender(pageId);
    expect(stored?.type).toBe('image/png');
    expect(stored?.size).toBe(RENDER_BLOB.size);

    expect(render).toHaveBeenCalledWith(
      INK,
      { pageWidth: PAGE_WIDTH, pageHeight: PAGE_HEIGHT },
      1024,
    );
    expect(createTranscriber).toHaveBeenCalledWith('http://o');
    expect(transcribePage).toHaveBeenCalledWith(RENDER_BLOB, { model: 'gemma4:12b' });
  });

  it('walks a page through pending, running and done, notifying subscribers', async () => {
    // Both steps are gated so each status is read at a fixed point in the job:
    // the render is in flight (still pending) and the model call is in flight
    // (running), rather than whenever a read happens to land.
    const rendering = deferred();
    const renderGate = deferred();
    render.mockImplementation(async () => {
      rendering.resolve();
      await renderGate.promise;
      return { blob: RENDER_BLOB, width: 772, height: 1024 };
    });
    const running = deferred();
    const gate = deferred();
    transcribePage.mockImplementation(async () => {
      running.resolve();
      await gate.promise;
      return { ...RESULT };
    });

    const pageId = await seedPage();
    const queue = createQueue();
    const notified: string[] = [];
    queue.subscribe((id) => notified.push(id));

    const statuses: Array<TranscriptStatus | null> = [];
    await queue.enqueue(pageId);
    await rendering.promise;
    statuses.push(await statusOf(pageId));
    renderGate.resolve();
    await running.promise;
    statuses.push(await statusOf(pageId));
    gate.resolve();
    await queue.idle();
    statuses.push(await statusOf(pageId));

    expect(statuses).toEqual(['pending', 'running', 'done']);
    expect(notified.length).toBeGreaterThanOrEqual(3);
    expect(new Set(notified)).toEqual(new Set([pageId]));
  });

  it('marks a page failed with the error message and keeps going', async () => {
    transcribePage.mockRejectedValueOnce(new Error('boom'));
    const first = await seedPage({ pageIndex: 0 });
    const second = await seedPage({ pageIndex: 1 });

    const queue = createQueue();
    await queue.enqueue(first);
    await queue.enqueue(second);
    await queue.idle();

    const failed = await getPage(first);
    expect(failed?.transcript?.status).toBe('failed');
    expect(failed?.transcript?.error).toBe('boom');
    expect(failed?.transcript?.markdown).toBe('');
    expect(failed?.transcript?.model).toBe('gemma4:12b');
    expect(failed?.transcript?.promptVersion).toBe('gemma-v1');
    expect(await statusOf(second)).toBe('done');
  });

  it('runs one job at a time', async () => {
    const gate = deferred();
    const firstRunning = deferred();
    transcribePage.mockImplementationOnce(async () => {
      firstRunning.resolve();
      await gate.promise;
      return { ...RESULT };
    });

    const first = await seedPage({ pageIndex: 0 });
    const second = await seedPage({ pageIndex: 1 });
    const queue = createQueue();
    await queue.enqueue(first);
    await queue.enqueue(second);
    await firstRunning.promise;

    expect(await statusOf(first)).toBe('running');
    expect(await statusOf(second)).toBe('pending');
    expect(transcribePage).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);

    gate.resolve();
    await queue.idle();
    expect(await statusOf(first)).toBe('done');
    expect(await statusOf(second)).toBe('done');
  });

  it('completes an empty page without rendering or calling the model', async () => {
    const pageId = await seedPage({ strokes: [] });
    const queue = createQueue();
    await queue.enqueue(pageId);
    await queue.idle();

    const page = await getPage(pageId);
    expect(page?.transcript).toEqual({
      markdown: '',
      model: 'gemma4:12b',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1000,
    });
    expect(render).not.toHaveBeenCalled();
    expect(transcribePage).not.toHaveBeenCalled();
  });

  it('resumes interrupted and unqueued live pages on start, leaving legacy and done pages alone', async () => {
    const wasRunning = await seedPage({ pageIndex: 0, transcript: transcript('running') });
    const wasPending = await seedPage({ pageIndex: 1, transcript: transcript('pending') });
    const neverQueued = await seedPage({ pageIndex: 2 });
    const legacy = await seedPage({ pageIndex: 3, source: 'rom' });
    const alreadyDone = await seedPage({
      pageIndex: 4,
      transcript: transcript('done', { markdown: 'old', updatedAt: 42 }),
    });
    const open = await seedPage({ pageIndex: 5, finalizedAt: null });

    const queue = createQueue();
    await queue.start();
    await queue.idle();

    expect(await statusOf(wasRunning)).toBe('done');
    expect(await statusOf(wasPending)).toBe('done');
    expect(await statusOf(neverQueued)).toBe('done');
    expect((await getPage(legacy))?.transcript).toBeNull();
    expect((await getPage(open))?.transcript).toBeNull();
    expect((await getPage(alreadyDone))?.transcript).toEqual(
      transcript('done', { markdown: 'old', updatedAt: 42 }),
    );
    expect(transcribePage).toHaveBeenCalledTimes(3);
  });

  it('re-runs a failed page on retry', async () => {
    const pageId = await seedPage({
      transcript: transcript('failed', { error: 'boom' }),
    });
    const queue = createQueue();
    await queue.retry(pageId);
    await queue.idle();

    const page = await getPage(pageId);
    expect(page?.transcript?.status).toBe('done');
    expect(page?.transcript?.markdown).toBe('text');
    expect(page?.transcript?.error).toBeNull();
  });

  it('runs a page once when it is enqueued twice', async () => {
    const pageId = await seedPage();
    const queue = createQueue();
    await Promise.all([queue.enqueue(pageId), queue.enqueue(pageId)]);
    await queue.idle();

    expect(transcribePage).toHaveBeenCalledTimes(1);
    expect(await statusOf(pageId)).toBe('done');
  });

  it('skips a page that was deleted before its job ran', async () => {
    // The pending mark cannot be written for a page that is gone; that is
    // logged, and the job itself then skips it without touching the model.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = createQueue();
    await queue.enqueue('missing-page');
    await queue.idle();

    expect(transcribePage).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(await getPage('missing-page')).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('stops taking new pages after stop()', async () => {
    const pageId = await seedPage({ finalizedAt: null });
    const queue = createQueue();
    await queue.start();
    queue.stop();

    pageFinalized.emit(pageId);
    await queue.idle();

    expect(transcribePage).not.toHaveBeenCalled();
    expect((await getPage(pageId))?.transcript).toBeNull();
  });
});
