import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWhisperTranscriber, type WorkerLike } from '@/audio/whisperClient';
import type { WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

/** A real `Worker` must satisfy `WorkerLike`, because Task 6 passes one straight in. */
const realWorkerIsWorkerLike: WorkerLike = {} as Worker;
void realWorkerIsWorkerLike;

class FakeWorker implements WorkerLike {
  posted: { message: WhisperRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  /** When true, `postMessage` really detaches the posted buffer, as a real worker hand-off does. */
  detachOnPost = false;

  private messageListeners: ((e: MessageEvent<WhisperResponse>) => void)[] = [];
  private errorListeners: ((e: ErrorEvent) => void)[] = [];

  postMessage(message: WhisperRequest, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
    if (this.detachOnPost && message.type === 'transcribe') {
      const buffer = message.pcm.buffer as ArrayBuffer;
      structuredClone(buffer, { transfer: [buffer] });
    }
  }

  addEventListener(type: 'message', fn: (e: MessageEvent<WhisperResponse>) => void): void;
  addEventListener(type: 'error', fn: (e: ErrorEvent) => void): void;
  addEventListener(type: 'message' | 'error', fn: (e: never) => void): void {
    if (type === 'message') {
      this.messageListeners.push(fn as (e: MessageEvent<WhisperResponse>) => void);
    } else {
      this.errorListeners.push(fn as (e: ErrorEvent) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: WhisperResponse): void {
    for (const fn of [...this.messageListeners]) {
      fn({ data: msg } as MessageEvent<WhisperResponse>);
    }
  }

  crash(message: string): void {
    for (const fn of [...this.errorListeners]) {
      fn({ message } as ErrorEvent);
    }
  }

  /** The `transcribe` requests posted so far, in order. */
  transcribeRequests(): Extract<WhisperRequest, { type: 'transcribe' }>[] {
    return this.posted
      .map((entry) => entry.message)
      .filter((message): message is Extract<WhisperRequest, { type: 'transcribe' }> => message.type === 'transcribe');
  }
}

let workers: FakeWorker[] = [];
/** Applied to every worker the factory makes, so the very first post can already detach. */
let detachOnPost = false;

function makeTranscriber() {
  return createWhisperTranscriber({
    createWorker: () => {
      const worker = new FakeWorker();
      worker.detachOnPost = detachOnPost;
      workers.push(worker);
      return worker;
    },
  });
}

beforeEach(() => {
  workers = [];
  detachOnPost = false;
});

describe('createWhisperTranscriber', () => {
  it('creates no worker until the first transcribe, then reuses one worker', async () => {
    const transcriber = makeTranscriber();
    expect(workers).toHaveLength(0);

    const first = transcriber.transcribe(new Float32Array(16_000), { model: 'Xenova/whisper-base.en' });
    expect(workers).toHaveLength(1);
    const second = transcriber.transcribe(new Float32Array(16_000), { model: 'Xenova/whisper-base.en' });
    expect(workers).toHaveLength(1);

    const [a, b] = workers[0].transcribeRequests();
    expect(b.id).not.toBe(a.id);
    workers[0].emit({ type: 'result', id: a.id, text: 'first', chunks: [] });
    workers[0].emit({ type: 'result', id: b.id, text: 'second', chunks: [] });

    expect((await first).text).toBe('first');
    expect((await second).text).toBe('second');
  });

  it('posts the pcm with its buffer transferred and resolves with mapped segments', async () => {
    detachOnPost = true;
    const transcriber = makeTranscriber();
    const pcm = new Float32Array(32_000);
    pcm[0] = 0.5;

    const promise = transcriber.transcribe(pcm, { model: 'Xenova/whisper-base.en' });
    const worker = workers[0];
    const { message, transfer } = worker.posted[0];
    expect(message.type).toBe('transcribe');
    const request = message as Extract<WhisperRequest, { type: 'transcribe' }>;
    expect(request.model).toBe('Xenova/whisper-base.en');
    expect(typeof request.id).toBe('number');
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(request.pcm.buffer);
    // The hand-off really detached the buffer, so the duration must already be known.
    expect(request.pcm.length).toBe(0);

    worker.emit({
      type: 'result',
      id: request.id,
      text: ' hello world',
      chunks: [{ timestamp: [0, null], text: ' hello world' }],
    });

    await expect(promise).resolves.toEqual({
      text: 'hello world',
      segments: [{ startMs: 0, endMs: 2_000, text: 'hello world' }],
      language: 'en',
    });
  });

  it('posts a subarray as an exact-size copy with the same values', async () => {
    const transcriber = makeTranscriber();
    const backing = new Float32Array(64);
    backing[16] = 0.25;
    backing[17] = -0.5;
    const view = backing.subarray(16, 48);

    const promise = transcriber.transcribe(view, { model: 'onnx-community/whisper-base' });
    const request = workers[0].transcribeRequests()[0];
    expect(request.pcm).not.toBe(view);
    expect(request.pcm.byteOffset).toBe(0);
    expect(request.pcm.buffer.byteLength).toBe(request.pcm.byteLength);
    expect(Array.from(request.pcm)).toEqual(Array.from(view));

    workers[0].emit({ type: 'result', id: request.id, text: '', chunks: [] });
    await expect(promise).resolves.toEqual({ text: '', segments: [], language: null });
  });

  it('reports progress for the matching id only', async () => {
    const transcriber = makeTranscriber();
    const onProgress = vi.fn();
    const promise = transcriber.transcribe(new Float32Array(16_000), {
      model: 'Xenova/whisper-base.en',
      onProgress,
    });
    const request = workers[0].transcribeRequests()[0];

    workers[0].emit({ type: 'progress', id: request.id, stage: 'loading', progress: 0.5 });
    workers[0].emit({ type: 'progress', id: request.id, stage: 'transcribing', progress: 0 });
    workers[0].emit({ type: 'progress', id: request.id + 999, stage: 'transcribing', progress: 0.9 });

    expect(onProgress.mock.calls).toEqual([
      [0.5, 'loading'],
      [0, 'transcribing'],
    ]);

    workers[0].emit({ type: 'result', id: request.id, text: 'x', chunks: [] });
    await promise;
  });

  it('rejects with the worker error message', async () => {
    const transcriber = makeTranscriber();
    const promise = transcriber.transcribe(new Float32Array(16_000), { model: 'bad-model' });
    const request = workers[0].transcribeRequests()[0];

    workers[0].emit({ type: 'error', id: request.id, message: 'Unsupported model' });

    await expect(promise).rejects.toThrow('Unsupported model');
  });

  it('cancels in the worker and rejects with AbortError when aborted', async () => {
    const transcriber = makeTranscriber();
    const controller = new AbortController();
    const promise = transcriber.transcribe(new Float32Array(16_000), {
      model: 'Xenova/whisper-base.en',
      signal: controller.signal,
    });
    const request = workers[0].transcribeRequests()[0];

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].posted.map((entry) => entry.message)).toEqual([
      request,
      { type: 'cancel', id: request.id },
    ]);

    // A late result for a forgotten id is ignored.
    expect(() => workers[0].emit({ type: 'result', id: request.id, text: 'late', chunks: [] })).not.toThrow();
  });

  it('rejects an already-aborted call without posting', async () => {
    const transcriber = makeTranscriber();
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcriber.transcribe(new Float32Array(16_000), {
        model: 'Xenova/whisper-base.en',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers.flatMap((worker) => worker.posted)).toEqual([]);
  });

  it('rejects pending calls on a worker crash and replaces the worker', async () => {
    const transcriber = makeTranscriber();
    const promise = transcriber.transcribe(new Float32Array(16_000), { model: 'Xenova/whisper-base.en' });

    workers[0].crash('out of memory');

    await expect(promise).rejects.toThrow('Whisper worker crashed: out of memory');
    expect(workers[0].terminated).toBe(true);

    const next = transcriber.transcribe(new Float32Array(16_000), { model: 'Xenova/whisper-base.en' });
    expect(workers).toHaveLength(2);
    workers[1].emit({ type: 'result', id: workers[1].transcribeRequests()[0].id, text: 'ok', chunks: [] });
    expect((await next).text).toBe('ok');
  });
});
