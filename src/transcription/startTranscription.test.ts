import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaptureEngine } from '@/capture/types';
import { createEmitter } from '@/device/emitter';
import { createNote } from '@/storage/notes';
import { createPage, getPage } from '@/storage/pages';
import { setSettingValue } from '@/storage/settingKeys';
import {
  ensureTranscriptionQueue,
  getTranscriptionQueue,
  resetTranscriptionQueueForTests,
} from '@/transcription/startTranscription';
import { resetDatabase } from '@/test/resetDb';

const mocks = vi.hoisted(() => ({
  transcribePage: vi.fn(),
  createOllamaTranscriber: vi.fn(),
  renderPage: vi.fn(),
}));

vi.mock('@/transcription/ollama', () => ({
  createOllamaTranscriber: mocks.createOllamaTranscriber,
}));

vi.mock('@/transcription/rasterize', async () => {
  const actual = await vi.importActual<typeof import('@/transcription/rasterize')>(
    '@/transcription/rasterize',
  );
  return { ...actual, renderPage: mocks.renderPage };
});

let pageFinalized: ReturnType<typeof createEmitter<string>>;
let subscribeCount: number;
let engine: CaptureEngine;

beforeEach(async () => {
  await resetDatabase();
  vi.clearAllMocks();
  mocks.transcribePage.mockResolvedValue({
    markdown: 'text',
    model: 'llava:13b',
    promptVersion: 'llava-v1',
  });
  mocks.createOllamaTranscriber.mockReturnValue({ transcribePage: mocks.transcribePage });
  mocks.renderPage.mockResolvedValue({
    blob: new Blob(['x'], { type: 'image/png' }),
    width: 600,
    height: 800,
  });

  pageFinalized = createEmitter<string>();
  subscribeCount = 0;
  // The queue only ever touches `subscribePageFinalized`; the rest of the
  // engine surface is irrelevant here, so a stub stands in for it.
  engine = {
    subscribePageFinalized: (fn: (pageId: string) => void) => {
      subscribeCount += 1;
      return pageFinalized.subscribe(fn);
    },
  } as unknown as CaptureEngine;
});

afterEach(() => {
  resetTranscriptionQueueForTests();
});

describe('ensureTranscriptionQueue', () => {
  it('returns one started singleton however often it is called', async () => {
    const first = ensureTranscriptionQueue(engine);
    const second = ensureTranscriptionQueue(engine);

    expect(second).toBe(first);
    expect(getTranscriptionQueue()).toBe(first);
    expect(subscribeCount).toBe(1);
    await first.idle();
  });

  it('has no queue before the first call and drops it on reset', async () => {
    expect(getTranscriptionQueue()).toBeNull();
    const queue = ensureTranscriptionQueue(engine);
    await queue.idle();

    resetTranscriptionQueueForTests();
    expect(getTranscriptionQueue()).toBeNull();
    expect(ensureTranscriptionQueue(engine)).not.toBe(queue);
  });

  it('wires stored settings, the Ollama transcriber and the rasterizer', async () => {
    await setSettingValue('ollama.baseUrl', 'http://pad:1234');
    await setSettingValue('ollama.model', 'llava:13b');
    await setSettingValue('transcription.renderLongEdge', 1536);

    const note = await createNote({
      title: 'Note',
      deviceId: 'huion',
      pageBaseline: 0,
      pageWidth: 1409,
      pageHeight: 1869,
    });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [{ points: [{ x: 0.1, y: 0.2, pressure: 0.5 }] }],
      finalizedAt: null,
    });

    const queue = ensureTranscriptionQueue(engine);
    pageFinalized.emit(page.id);
    await queue.idle();

    expect(mocks.createOllamaTranscriber).toHaveBeenCalledWith({ baseUrl: 'http://pad:1234' });
    expect(mocks.renderPage).toHaveBeenCalledWith(
      [{ points: [{ x: 0.1, y: 0.2, pressure: 0.5 }] }],
      { pageWidth: 1409, pageHeight: 1869 },
      1536,
    );
    expect(mocks.transcribePage).toHaveBeenCalledWith(expect.any(Blob), { model: 'llava:13b' });

    const stored = await getPage(page.id);
    expect(stored?.transcript?.status).toBe('done');
    expect(stored?.transcript?.markdown).toBe('text');
    expect(stored?.transcript?.promptVersion).toBe('llava-v1');
    expect(stored?.render).toEqual({ type: 'image/png', width: 600, height: 800 });
  });
});
