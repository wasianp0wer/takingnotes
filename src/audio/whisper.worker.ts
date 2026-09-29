// The Whisper worker entry point: the only module that imports the model runtime. It stays
// deliberately thin — the logic lives in `whisperWorkerCore.ts`, which is tested on the main
// thread — so nothing here needs a worker harness to verify.
import { pipeline } from '@huggingface/transformers';
import { createWhisperWorkerCore, type AsrPipeline } from '@/audio/whisperWorkerCore';
import type { WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

/**
 * The worker global. The app tsconfig uses `lib: DOM`, so `self` is typed as a `Window`;
 * this narrows it to the two members the worker actually uses, with the worker's own
 * one-argument `postMessage`.
 */
const ctx = self as unknown as {
  postMessage(message: WhisperResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WhisperRequest>) => void): void;
};

const core = createWhisperWorkerCore({
  hasWebGpu: async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  },
  loadPipeline: async (model, { device, onProgress }) =>
    (await pipeline('automatic-speech-recognition', model, {
      device,
      // Spec F2-A2: WebGPU runs an fp32 encoder with a q4 merged decoder; on wasm the
      // library default (q8) is the one that is actually fast.
      ...(device === 'webgpu' ? { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } : {}),
      progress_callback: onProgress,
    })) as unknown as AsrPipeline,
  post: (message: WhisperResponse) => ctx.postMessage(message),
});

ctx.addEventListener('message', (event: MessageEvent<WhisperRequest>) => {
  void core.handle(event.data);
});
