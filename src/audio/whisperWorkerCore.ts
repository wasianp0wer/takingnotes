// The worker's logic, with the model runtime injected. Nothing here imports
// `@huggingface/transformers`, so the whole state machine — device selection, the pipeline
// cache, serial job execution, progress and cancellation — is testable on the main thread.
// `whisper.worker.ts` is the thin shell that wires in the real pipeline loader.
import { WHISPER_OPTIONS } from '@/audio/whisperProtocol';
import type { WhisperChunk, WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

/** The ONNX execution provider a pipeline is loaded on. */
export type WhisperDevice = 'webgpu' | 'wasm';

/** A `progress_callback` report from transformers.js while model files load. */
export interface LoadProgress {
  status: string;
  /** For `progress_total`: 0–100 across all files of the model. */
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
}

/** A loaded automatic-speech-recognition pipeline, narrowed to what this worker calls. */
export type AsrPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: WhisperChunk[] } | Array<{ text: string; chunks?: WhisperChunk[] }>>;

export type PipelineLoader = (
  model: string,
  opts: { device: WhisperDevice; onProgress: (info: LoadProgress) => void },
) => Promise<AsrPipeline>;

export interface WhisperWorkerCoreDeps {
  loadPipeline: PipelineLoader;
  hasWebGpu: () => Promise<boolean>;
  post: (message: WhisperResponse) => void;
}

type TranscribeRequest = Extract<WhisperRequest, { type: 'transcribe' }>;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWhisperWorkerCore(deps: WhisperWorkerCoreDeps): {
  handle(message: WhisperRequest): Promise<void>;
} {
  /** Pipelines by `${model}|${device}`; promises, so a load in flight is shared, never repeated. */
  const pipelines = new Map<string, Promise<AsrPipeline>>();
  const cancelled = new Set<number>();
  /** The tail of the job chain: jobs run one at a time, in arrival order. */
  let queue: Promise<void> = Promise.resolve();
  let devicePromise: Promise<WhisperDevice> | null = null;
  /** Set once WebGPU has proven unusable, so every later model goes straight to wasm. */
  let webGpuUnusable = false;

  async function resolveDevice(): Promise<WhisperDevice> {
    devicePromise ??= (async (): Promise<WhisperDevice> => {
      try {
        return (await deps.hasWebGpu()) ? 'webgpu' : 'wasm';
      } catch {
        // No adapter, or a browser that throws on the check: wasm always works.
        return 'wasm';
      }
    })();
    const device = await devicePromise;
    return webGpuUnusable ? 'wasm' : device;
  }

  function load(
    model: string,
    device: WhisperDevice,
    onProgress: (info: LoadProgress) => void,
  ): Promise<AsrPipeline> {
    const key = `${model}|${device}`;
    const cached = pipelines.get(key);
    if (cached) {
      return cached;
    }
    const loading = deps.loadPipeline(model, { device, onProgress });
    pipelines.set(key, loading);
    loading.catch(() => {
      // A failed load must not be cached, or the model could never be retried.
      if (pipelines.get(key) === loading) {
        pipelines.delete(key);
      }
    });
    return loading;
  }

  async function pipelineFor(model: string, onProgress: (info: LoadProgress) => void): Promise<AsrPipeline> {
    const device = await resolveDevice();
    try {
      return await load(model, device, onProgress);
    } catch (error) {
      if (device !== 'webgpu') {
        throw error;
      }
      // The WebGPU adapter cannot run this model; assume it cannot run any of them.
      webGpuUnusable = true;
      return await load(model, 'wasm', onProgress);
    }
  }

  async function run(request: TranscribeRequest): Promise<void> {
    const { id, model, pcm } = request;
    try {
      if (cancelled.has(id)) {
        return;
      }
      const pipeline = await pipelineFor(model, (info) => {
        if (cancelled.has(id)) {
          return;
        }
        if (info.status === 'progress_total' && typeof info.progress === 'number') {
          deps.post({ type: 'progress', id, stage: 'loading', progress: clamp01(info.progress / 100) });
        }
      });
      if (cancelled.has(id)) {
        return;
      }
      deps.post({ type: 'progress', id, stage: 'loading', progress: 1 });
      deps.post({ type: 'progress', id, stage: 'transcribing', progress: 0 });
      const output = await pipeline(pcm, { ...WHISPER_OPTIONS });
      if (cancelled.has(id)) {
        return;
      }
      const first = Array.isArray(output) ? output[0] : output;
      deps.post({ type: 'result', id, text: first?.text ?? '', chunks: first?.chunks ?? [] });
    } catch (error) {
      if (!cancelled.has(id)) {
        deps.post({ type: 'error', id, message: messageOf(error) });
      }
    } finally {
      cancelled.delete(id);
    }
  }

  function handle(message: WhisperRequest): Promise<void> {
    if (message.type === 'cancel') {
      // Handled immediately, never queued: the running job has to see it.
      cancelled.add(message.id);
      return Promise.resolve();
    }
    // `run` swallows its own errors; the extra catch keeps a broken `post` from
    // stalling the queue for every later job.
    queue = queue.then(() => run(message)).catch(() => undefined);
    return queue;
  }

  return { handle };
}
