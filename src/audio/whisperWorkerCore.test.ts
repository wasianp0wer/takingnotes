import { describe, expect, it, vi } from 'vitest';
import {
  createWhisperWorkerCore,
  type AsrPipeline,
  type PipelineLoader,
  type WhisperDevice,
} from '@/audio/whisperWorkerCore';
import type { WhisperChunk, WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

const MODEL = 'Xenova/whisper-base.en';
const OTHER_MODEL = 'Xenova/whisper-tiny';
const CHUNKS: WhisperChunk[] = [{ timestamp: [0, 1], text: ' hi' }];
const CALL_OPTIONS = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };

/** One load the fake loader saw, so tests can assert model/device without digging in mock calls. */
interface LoadCall {
  model: string;
  device: WhisperDevice;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets queued jobs and pending loads make progress. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Harness {
  core: { handle(message: WhisperRequest): Promise<void> };
  post: ReturnType<typeof vi.fn<(message: WhisperResponse) => void>>;
  pipe: ReturnType<typeof vi.fn<AsrPipeline>>;
  loadPipeline: ReturnType<typeof vi.fn<PipelineLoader>>;
  loads: LoadCall[];
  /** Every response posted so far, in order. */
  posted(): WhisperResponse[];
}

interface HarnessOptions {
  hasWebGpu?: () => Promise<boolean>;
  /** Called on every load; throw to fail that load, or return a promise to hold it open. */
  onLoad?: (
    call: LoadCall,
    onProgress: (info: { status: string; progress?: number }) => void,
  ) => void | Promise<void>;
  /** Result of the nth pipeline call; the default resolves immediately. */
  transcribe?: (call: number) => Promise<{ text: string; chunks?: WhisperChunk[] }>;
}

function harness(options: HarnessOptions = {}): Harness {
  const post = vi.fn<(message: WhisperResponse) => void>();
  const loads: LoadCall[] = [];
  let transcribeCalls = 0;
  const pipe = vi.fn<AsrPipeline>(async () => {
    transcribeCalls += 1;
    return options.transcribe
      ? await options.transcribe(transcribeCalls)
      : { text: ' hi', chunks: CHUNKS };
  });
  const loadPipeline = vi.fn<PipelineLoader>(async (model, { device, onProgress }) => {
    const call: LoadCall = { model, device };
    loads.push(call);
    await options.onLoad?.(call, onProgress);
    return pipe;
  });
  const core = createWhisperWorkerCore({
    loadPipeline,
    hasWebGpu: options.hasWebGpu ?? (async () => false),
    post,
  });
  return {
    core,
    post,
    pipe,
    loadPipeline,
    loads,
    posted: () => post.mock.calls.map(([message]) => message),
  };
}

describe('createWhisperWorkerCore', () => {
  it('loads on webgpu when an adapter is available', async () => {
    const h = harness({ hasWebGpu: async () => true });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.loads).toEqual([{ model: MODEL, device: 'webgpu' }]);
  });

  it('loads on wasm when there is no adapter', async () => {
    const h = harness({ hasWebGpu: async () => false });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.loads).toEqual([{ model: MODEL, device: 'wasm' }]);
  });

  it('loads on wasm when the adapter check throws', async () => {
    const h = harness({
      hasWebGpu: async () => {
        throw new Error('gpu unavailable');
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.loads).toEqual([{ model: MODEL, device: 'wasm' }]);
  });

  it('resolves the device once and reuses it', async () => {
    const hasWebGpu = vi.fn(async () => true);
    const h = harness({ hasWebGpu });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    await h.core.handle({ type: 'transcribe', id: 2, model: OTHER_MODEL, pcm: new Float32Array(4) });

    expect(hasWebGpu).toHaveBeenCalledTimes(1);
  });

  it('calls the pipeline with the PCM and the whisper options, then posts the result', async () => {
    const h = harness();
    const pcm = new Float32Array([0.1, -0.2, 0.3]);

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm });

    expect(h.pipe).toHaveBeenCalledWith(pcm, CALL_OPTIONS);
    expect(h.posted()).toContainEqual({ type: 'result', id: 1, text: ' hi', chunks: CHUNKS });
  });

  it('caches the pipeline per model', async () => {
    const h = harness();

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    await h.core.handle({ type: 'transcribe', id: 2, model: MODEL, pcm: new Float32Array(4) });
    expect(h.loadPipeline).toHaveBeenCalledTimes(1);

    await h.core.handle({ type: 'transcribe', id: 3, model: OTHER_MODEL, pcm: new Float32Array(4) });
    expect(h.loadPipeline).toHaveBeenCalledTimes(2);
    expect(h.loads).toEqual([
      { model: MODEL, device: 'wasm' },
      { model: OTHER_MODEL, device: 'wasm' },
    ]);
  });

  it('forwards aggregate load progress and posts the stages in order', async () => {
    const h = harness({
      onLoad: (_call, onProgress) => {
        onProgress({ status: 'initiate', progress: undefined });
        onProgress({ status: 'progress_total', progress: 50 });
        onProgress({ status: 'done' });
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.posted()).toEqual([
      { type: 'progress', id: 1, stage: 'loading', progress: 0.5 },
      { type: 'progress', id: 1, stage: 'loading', progress: 1 },
      { type: 'progress', id: 1, stage: 'transcribing', progress: 0 },
      { type: 'result', id: 1, text: ' hi', chunks: CHUNKS },
    ]);
  });

  it('posts an error for a failed load and evicts it from the cache', async () => {
    let attempts = 0;
    const h = harness({
      onLoad: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Could not locate file');
        }
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    expect(h.posted()).toContainEqual({ type: 'error', id: 1, message: 'Could not locate file' });

    await h.core.handle({ type: 'transcribe', id: 2, model: MODEL, pcm: new Float32Array(4) });
    expect(h.loadPipeline).toHaveBeenCalledTimes(2);
    expect(h.posted()).toContainEqual({ type: 'result', id: 2, text: ' hi', chunks: CHUNKS });
  });

  it('retries a failed webgpu load on wasm and stays on wasm afterwards', async () => {
    const h = harness({
      hasWebGpu: async () => true,
      onLoad: (call) => {
        if (call.device === 'webgpu') {
          throw new Error('no available backend found');
        }
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    await h.core.handle({ type: 'transcribe', id: 2, model: OTHER_MODEL, pcm: new Float32Array(4) });

    expect(h.loads).toEqual([
      { model: MODEL, device: 'webgpu' },
      { model: MODEL, device: 'wasm' },
      { model: OTHER_MODEL, device: 'wasm' },
    ]);
    expect(h.posted()).toContainEqual({ type: 'result', id: 1, text: ' hi', chunks: CHUNKS });
    expect(h.posted()).toContainEqual({ type: 'result', id: 2, text: ' hi', chunks: CHUNKS });
  });

  it('reports the wasm error when both devices fail to load', async () => {
    const h = harness({
      hasWebGpu: async () => true,
      onLoad: (call) => {
        throw new Error(call.device === 'webgpu' ? 'webgpu broke' : 'wasm broke');
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.posted()).toContainEqual({ type: 'error', id: 1, message: 'wasm broke' });
  });

  it('skips a job cancelled before it starts', async () => {
    const gate = deferred<{ text: string; chunks: WhisperChunk[] }>();
    const h = harness({
      transcribe: async (call) => (call === 1 ? await gate.promise : { text: ' hi', chunks: CHUNKS }),
    });

    const first = h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    const second = h.core.handle({ type: 'transcribe', id: 2, model: MODEL, pcm: new Float32Array(4) });
    await flush();
    await h.core.handle({ type: 'cancel', id: 2 });
    gate.resolve({ text: ' hi', chunks: CHUNKS });
    await first;
    await second;

    expect(h.pipe).toHaveBeenCalledTimes(1);
    expect(h.posted().filter((message) => message.id === 2)).toEqual([]);
  });

  it('drops the result of a job cancelled while it runs', async () => {
    const gate = deferred<{ text: string; chunks: WhisperChunk[] }>();
    const h = harness({ transcribe: async () => await gate.promise });

    const job = h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    await flush();
    expect(h.pipe).toHaveBeenCalledTimes(1);

    await h.core.handle({ type: 'cancel', id: 1 });
    gate.resolve({ text: ' hi', chunks: CHUNKS });
    await job;

    expect(h.posted().some((message) => message.type === 'result')).toBe(false);
  });

  it('posts no load progress for a job cancelled while the model loads', async () => {
    let reportProgress: ((info: { status: string; progress?: number }) => void) | undefined;
    const gate = deferred<void>();
    const h = harness({
      onLoad: (_call, onProgress) => {
        reportProgress = onProgress;
        return gate.promise;
      },
    });

    const job = h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    await flush();
    await h.core.handle({ type: 'cancel', id: 1 });
    reportProgress?.({ status: 'progress_total', progress: 50 });
    gate.resolve(undefined);
    await job;

    expect(h.pipe).not.toHaveBeenCalled();
    expect(h.posted()).toEqual([]);
  });

  it('runs jobs serially in arrival order', async () => {
    const gate = deferred<{ text: string; chunks: WhisperChunk[] }>();
    const h = harness({
      transcribe: async (call) => (call === 1 ? await gate.promise : { text: ' second', chunks: [] }),
    });

    const first = h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });
    const second = h.core.handle({ type: 'transcribe', id: 2, model: MODEL, pcm: new Float32Array(4) });
    await flush();
    expect(h.pipe).toHaveBeenCalledTimes(1);

    gate.resolve({ text: ' first', chunks: [] });
    await first;
    await second;

    expect(h.pipe).toHaveBeenCalledTimes(2);
    expect(h.posted().filter((message) => message.type === 'result')).toEqual([
      { type: 'result', id: 1, text: ' first', chunks: [] },
      { type: 'result', id: 2, text: ' second', chunks: [] },
    ]);
  });

  it('posts an error when the pipeline itself throws', async () => {
    const h = harness({
      transcribe: async () => {
        throw new Error('inference failed');
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.posted()).toContainEqual({ type: 'error', id: 1, message: 'inference failed' });
  });

  it('takes the first element when the pipeline returns an array', async () => {
    const h = harness();
    h.pipe.mockResolvedValueOnce([{ text: ' first', chunks: CHUNKS }]);

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.posted()).toContainEqual({ type: 'result', id: 1, text: ' first', chunks: CHUNKS });
  });

  it('defaults missing text and chunks', async () => {
    const h = harness();
    h.pipe.mockResolvedValueOnce({} as { text: string });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    expect(h.posted()).toContainEqual({ type: 'result', id: 1, text: '', chunks: [] });
  });
});
