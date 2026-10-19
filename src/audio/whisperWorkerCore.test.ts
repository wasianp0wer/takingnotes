import { describe, expect, it, vi } from 'vitest';
import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import {
  createWhisperWorkerCore,
  type AsrPipeline,
  type DecodeStreamer,
  type PipelineLoader,
  type WhisperDevice,
} from '@/audio/whisperWorkerCore';
import type { WhisperChunk, WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

const MODEL = 'Xenova/whisper-base.en';
const OTHER_MODEL = 'Xenova/whisper-tiny';
const CHUNKS: WhisperChunk[] = [{ timestamp: [0, 1], text: ' hi' }];
const CALL_OPTIONS = {
  return_timestamps: true,
  chunk_length_s: 30,
  stride_length_s: 5,
  max_new_tokens: 440,
};

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
  transcribe?: (
    call: number,
    callOptions: Record<string, unknown>,
  ) => Promise<{ text: string; chunks?: WhisperChunk[] }>;
}

function harness(options: HarnessOptions = {}): Harness {
  const post = vi.fn<(message: WhisperResponse) => void>();
  const loads: LoadCall[] = [];
  let transcribeCalls = 0;
  const pipe = vi.fn<AsrPipeline>(async (_audio, callOptions) => {
    transcribeCalls += 1;
    return options.transcribe
      ? await options.transcribe(transcribeCalls, callOptions)
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

    expect(h.pipe).toHaveBeenCalledWith(pcm, { ...CALL_OPTIONS, streamer: expect.anything() });
    expect(h.posted()).toContainEqual({ type: 'result', id: 1, text: ' hi', chunks: CHUNKS });
  });

  it('reports completed decode passes, not a fraction of a total it cannot know', async () => {
    // ⚑ `end()` fires once per `generate()` call, which is once per 30 s
    // piece the pipeline's own `chunk_length_s` windowing produces - not once
    // per transcribe request. Counting those against a window total pinned
    // the bar at 100% while the pass ran on, so no total is claimed from in
    // here: the count is a sign of life, and the real proportion comes from
    // the queue's cursor.
    //
    // Before `WHISPER_OPTIONS.max_new_tokens` existed this was far worse:
    // `generate` ran its own seek loop (`_generate_with_seek`) on top of the
    // pipeline's chunking, calling the streamer an unbounded number of times
    // when that loop failed to advance - and since every report re-arms the
    // queue's stall watchdog, the job had no upper bound at all.
    const pcm = new Float32Array(TARGET_SAMPLE_RATE * 80);
    const h = harness({
      transcribe: async (_call, callOptions) => {
        const streamer = callOptions.streamer as DecodeStreamer;
        for (let pass = 0; pass < 3; pass += 1) {
          streamer.put([[1n]]);
          streamer.end();
        }
        return { text: ' hi', chunks: CHUNKS };
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm });

    const transcribing = h
      .posted()
      .filter((message) => message.type === 'progress' && message.stage === 'transcribing');
    // The opening report, then a decode step and a finished pass for each of
    // the three: the step repeats the count, the pass advances it.
    expect(transcribing.map((message) => (message as { passes?: number }).passes)).toEqual([
      0, 0, 1, 1, 2, 2, 3,
    ]);
    // Nothing presents itself as a proportion of a whole.
    expect(
      transcribing.every((message) => (message as { progress: number }).progress === 0),
    ).toBe(true);
  });

  it('posts no transcribe-pass progress for a cancelled job', async () => {
    const pcm = new Float32Array(TARGET_SAMPLE_RATE * 80);
    // Captured and asserted outside the pipeline call: `run` swallows a throw
    // from a cancelled job, so an assertion made in there could not fail.
    let streamer: DecodeStreamer | undefined;
    const h = harness({
      transcribe: async (_call, callOptions) => {
        streamer = callOptions.streamer as DecodeStreamer | undefined;
        await h.core.handle({ type: 'cancel', id: 1 });
        streamer?.put([[1n]]);
        streamer?.end();
        return { text: ' hi', chunks: CHUNKS };
      },
    });

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm });

    expect(streamer).toBeDefined();
    expect(h.posted()).toEqual([
      { type: 'progress', id: 1, stage: 'loading', progress: 1 },
      { type: 'progress', id: 1, stage: 'transcribing', progress: 0, passes: 0 },
    ]);
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
      { type: 'progress', id: 1, stage: 'transcribing', progress: 0, passes: 0 },
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

describe('bounding the decode so a window cannot spin forever', () => {
  it('passes a max_new_tokens to the pipeline', async () => {
    // ⚑ This is what keeps a window from running thousands of decode passes.
    // With `return_timestamps` set and no `max_new_tokens`, transformers.js
    // routes through `WhisperForConditionalGeneration._generate_with_seek`
    // (modeling_whisper.js:157), whose `while (seek < total_frames)` loop
    // advances by `seek += segment_offset` - and `segment_offset` is
    // `last_ts_pos * input_stride`, which is **zero** when the model's last
    // complete segment boundary is the `<|0.00|>` timestamp. There is no
    // guard for that, so the loop spins, re-generating the same audio and
    // emitting a progress report on every spin.
    //
    // Setting `max_new_tokens` takes the plain `super.generate()` path
    // instead, which the timestamp logits processor is still installed on,
    // so timestamps survive. The pipeline's own `chunk_length_s` windowing
    // already does the long-form splitting the seek loop exists for.
    const h = harness();

    await h.core.handle({ type: 'transcribe', id: 1, model: MODEL, pcm: new Float32Array(4) });

    const [, callOptions] = h.pipe.mock.calls[0];
    expect(typeof callOptions.max_new_tokens).toBe('number');
    // Whisper's decoder holds 448 positions in total, prefix included, so the
    // cap has to leave room for the init tokens.
    expect(callOptions.max_new_tokens as number).toBeLessThan(448);
    expect(callOptions.max_new_tokens as number).toBeGreaterThan(256);
  });
});
