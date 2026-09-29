# F2 Audio Recording + Local Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task uses superpowers:test-driven-development: write the failing test, watch it fail, implement, watch it pass, commit.

**Goal:** Record microphone audio linked to the active note, save it to IndexedDB, and transcribe it locally with Whisper (transformers.js in a Web Worker) through a resumable serial queue, with a Recordings view and a Whisper model setting.

**Architecture:** Pure/injectable `.ts` modules under `src/audio/` (recorder, PCM prep, worker protocol + client, worker core, queue, runtime singletons) with thin React components (`RecorderControl`, `RecordingsView`, `AudioSettings`). Browser/ML APIs (getUserMedia, MediaRecorder, AudioContext, Worker, transformers.js pipeline) are injected so tests use fakes and never download a model.

**Tech Stack:** React 19, TypeScript 5.9 (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Vite 7, Vitest 3 + happy-dom + fake-indexeddb, `idb`, `@huggingface/transformers` 4.3.0 (already installed in `package.json`/`package-lock.json`, uncommitted), Tailwind + shadcn-style UI in `src/components/ui/`.

**Spec:** `docs/features/f2-spec.md` (product: `docs/spec.md` §F2; contracts: `docs/architecture.md` §2.2, §2.4, §2.5, §3.3, §5).

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/f2-audio` on branch `notes/f2-audio`. Use absolute paths. Never push. Never `git stash`.
- Only create/edit files under `src/audio/**` and `src/recordings/**`, plus `package.json`/`package-lock.json` (Task 3) and `vite.config.ts` (Task 3, only if the build needs it). Do NOT edit `src/storage/**`, `src/capture/**`, `src/app/**`, `src/main.tsx`, `src/App.tsx`, `src/components/**` (the `src/components/ui/*` primitives may be imported, not edited).
- Keep export names of placeholders: `RecorderControl` (`src/audio/RecorderControl.tsx`), `AudioSettings` (`src/audio/AudioSettings.tsx`), `RecordingsView` (`src/recordings/RecordingsView.tsx`). They are mounted by Phase 0 code with no props, so any new props must be optional.
- All timestamps are epoch ms (`Date.now()` clock). `TranscriptSegment.startMs/endMs` are offsets in ms from `RecordingRecord.startedAt`.
- Storage API to use (from `src/storage/recordings.ts`, do not edit): `createRecording(input: CreateRecordingInput, audio: Blob): Promise<RecordingRecord>`, `getRecording(id)`, `listRecordings()` (newest first), `getRecordingAudio(id): Promise<Blob | null>`, `setRecordingTranscript(id, transcript: AudioTranscriptRecord): Promise<RecordingRecord>` (throws `Recording not found: <id>` if deleted), `deleteRecording(id)`.
- Setting: `getSettingValue('whisper.model')` / `setSettingValue('whisper.model', v)` from `src/storage/settingKeys.ts`; default `SETTING_DEFAULTS['whisper.model'] === 'Xenova/whisper-base.en'`.
- Whisper pipeline call options: `return_timestamps: true`, `chunk_length_s: 30`, `stride_length_s: 5`. Whisper input: 16 000 Hz mono `Float32Array`.
- Preferred MediaRecorder mime types, in order: `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/mp4`.
- Tests: Vitest, files beside sources (`*.test.ts(x)`), `fake-indexeddb` is installed globally by `src/test/setup.ts`; call `resetDatabase` from `@/test/resetDb` in `beforeEach` for DB tests. Component tests use `createRoot` + `act` with `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (pattern: `src/app/DeviceStatus.test.tsx`); no `@testing-library/react`. Tests must never import `@huggingface/transformers` or construct a real `Worker`.
- TypeScript: no `enum`, no parameter properties (`erasableSyntaxOnly`); type-only imports use `import type`. Path alias `@/` = `src/`.
- Verification commands (run from the worktree): `npx vitest run <files>`; full: `npx vitest run`; build: `npm run build` (runs `tsc -b` then `vite build`); lint a file set: `npx eslint <files>`. Baseline: 241 tests pass; lint has 1 pre-existing error in `src/components/CanvasEngine.tsx` (not ours).
- Commit messages: conventional style (`feat(audio): ...`), each ending with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage only the files your task touched (`git add <paths>`), never `git add -A`.

## Review Focus

1. Stopping before any audio chunk arrived (or a zero-byte Blob) → nothing is saved and the user sees "Nothing was recorded" (Task 5 test).
2. The mic being unplugged / the browser ending the MediaRecorder on its own → what was captured is still saved and the mic released (Task 5 test).
3. Transferring the PCM buffer to the worker detaches it, and a `Float32Array` view may not span its whole buffer → the client computes duration before posting and transfers an exact-size buffer (Task 2 test).
4. A wrong model id / offline network → the job fails with the loader's message, the failed pipeline is evicted from the cache so Retry re-attempts it, and a WebGPU load failure falls back to WASM (Task 3 tests); the queue records `failed` with the message (Task 4 test).
5. Switching the selected recording or unmounting the view → the previous object URL is revoked (Task 7 test); deleting a recording mid-queue does not wedge the queue (Task 4 test).

---

### Task 1: Formatting helpers and PCM preparation

**Files:**
- Create: `src/audio/format.ts`, `src/audio/format.test.ts`
- Create: `src/audio/pcm.ts`, `src/audio/pcm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // format.ts
  export function formatClock(ms: number): string;          // 0 → "0:00", 65_000 → "1:05", 3_725_000 → "1:02:05"; negative/NaN → "0:00"; floors to whole seconds
  export function recordingTitle(startedAt: number): string; // "Recording 2026-09-28 14:05" in LOCAL time, zero-padded
  // pcm.ts
  export const TARGET_SAMPLE_RATE = 16_000;
  export function downmixToMono(channels: readonly Float32Array[]): Float32Array;
  export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array;
  export interface DecodedAudio { sampleRate: number; channels: Float32Array[] }
  export interface PcmDeps {
    decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
    renderOffline?: (buffer: AudioBuffer, targetRate: number) => Promise<Float32Array>;
  }
  export async function decodeToPcm16k(audio: Blob, deps?: PcmDeps): Promise<Float32Array>;
  ```

**Behavior details:**
- `downmixToMono`: zero channels → empty array; one channel → returns a copy (not the same instance); N channels → per-sample average; channels of unequal length → use the shortest length.
- `resampleLinear`: `fromRate === toRate` → copy; output length `Math.round(input.length * toRate / fromRate)`; each output sample `i` reads source position `i * fromRate / toRate` with linear interpolation between floor and ceil (clamped to last sample). Rates ≤ 0 throw `RangeError`. Empty input → empty output.
- `decodeToPcm16k(blob, deps)`:
  1. `const data = await blob.arrayBuffer()`; zero bytes → throw `Error('Recording has no audio')`.
  2. `decode` default: `new AudioContext()` → `ctx.decodeAudioData(data)` → `ctx.close()` in `finally`. If `AudioContext` is undefined → throw `Error('This browser cannot decode audio')`. A decode rejection is rethrown as `Error('Could not decode the recording: <original message>')`.
  3. `renderOffline` default: if `typeof OfflineAudioContext === 'undefined'` skip to fallback; else `new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * targetRate)), targetRate)`, a `BufferSource` of `buffer` connected to `destination`, `start(0)`, `await startRendering()`, return `rendered.getChannelData(0)` (copy with `.slice()`). An offline context downmixes to 1 channel for us.
  4. If `renderOffline` throws (or is unavailable), fall back to pure: `resampleLinear(downmixToMono(channels), buffer.sampleRate, 16000)` where `channels[i] = buffer.getChannelData(i)`.

- [ ] **Step 1: Write failing tests** in `src/audio/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatClock, recordingTitle } from '@/audio/format';

describe('formatClock', () => {
  it.each([
    [0, '0:00'], [999, '0:00'], [1_000, '0:01'], [65_000, '1:05'],
    [600_000, '10:00'], [3_600_000, '1:00:00'], [3_725_000, '1:02:05'],
    [-5, '0:00'], [Number.NaN, '0:00'],
  ])('%d ms → %s', (ms, text) => expect(formatClock(ms)).toBe(text));
});

describe('recordingTitle', () => {
  it('uses zero-padded local date and time', () => {
    const at = new Date(2026, 0, 5, 9, 7, 30).getTime(); // local time
    expect(recordingTitle(at)).toBe('Recording 2026-01-05 09:07');
  });
});
```

and `src/audio/pcm.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { decodeToPcm16k, downmixToMono, resampleLinear } from '@/audio/pcm';

const f32 = (...v: number[]) => new Float32Array(v);

function fakeAudioBuffer(sampleRate: number, channels: Float32Array[]): AudioBuffer {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData: (i: number) => channels[i],
  } as unknown as AudioBuffer;
}

describe('downmixToMono', () => {
  it('averages channels sample by sample', () => {
    expect(Array.from(downmixToMono([f32(1, 0, -1), f32(0, 0, 1)]))).toEqual([0.5, 0, 0]);
  });
  it('copies a mono channel', () => {
    const mono = f32(0.25, 0.5);
    const out = downmixToMono([mono]);
    expect(Array.from(out)).toEqual([0.25, 0.5]);
    expect(out).not.toBe(mono);
  });
  it('uses the shortest channel length and handles no channels', () => {
    expect(downmixToMono([f32(1, 1, 1), f32(1)]).length).toBe(1);
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('downsamples 48k to 16k with the expected length and values', () => {
    const ramp = new Float32Array(48).map((_, i) => i);
    const out = resampleLinear(ramp, 48_000, 16_000);
    expect(out.length).toBe(16);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(3);
    expect(out[15]).toBe(45);
  });
  it('interpolates when upsampling', () => {
    expect(Array.from(resampleLinear(f32(0, 1), 8_000, 16_000))).toEqual([0, 0.5, 1, 1]);
  });
  it('copies at equal rates, keeps constants constant, and rejects bad rates', () => {
    const same = f32(1, 2);
    expect(resampleLinear(same, 16_000, 16_000)).not.toBe(same);
    expect(Array.from(resampleLinear(new Float32Array(441).fill(0.5), 44_100, 16_000)).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    expect(() => resampleLinear(same, 0, 16_000)).toThrow(RangeError);
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe('decodeToPcm16k', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });

  it('decodes then renders offline at 16 kHz', async () => {
    const buffer = fakeAudioBuffer(48_000, [f32(1, 1, 1)]);
    const decode = vi.fn().mockResolvedValue(buffer);
    const renderOffline = vi.fn().mockResolvedValue(f32(0.1, 0.2));
    const out = await decodeToPcm16k(blob, { decode, renderOffline });
    expect(decode).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(renderOffline).toHaveBeenCalledWith(buffer, 16_000);
    expect(Array.from(out)).toEqual([f32(0.1)[0], f32(0.2)[0]]);
  });

  it('falls back to the pure downmix + resample when offline rendering fails', async () => {
    const buffer = fakeAudioBuffer(32_000, [f32(1, 1, 1, 1), f32(0, 0, 0, 0)]);
    const out = await decodeToPcm16k(blob, {
      decode: async () => buffer,
      renderOffline: async () => { throw new Error('no offline context'); },
    });
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });

  it('rejects an empty recording and wraps decode failures', async () => {
    await expect(decodeToPcm16k(new Blob([]), { decode: vi.fn() })).rejects.toThrow('Recording has no audio');
    await expect(
      decodeToPcm16k(blob, { decode: async () => { throw new Error('EncodingError'); } }),
    ).rejects.toThrow('Could not decode the recording: EncodingError');
  });
});
```

Note: if happy-dom's `Blob.arrayBuffer` needs it, keep using real `Blob` (it is available in happy-dom and Node).

- [ ] **Step 2: Run** `npx vitest run src/audio/format.test.ts src/audio/pcm.test.ts` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** `format.ts` and `pcm.ts` per the behavior details (the default `decode`/`renderOffline` use the browser APIs described above; they are not exercised by tests).
- [ ] **Step 4: Run** the same command — expect PASS. Run `npx eslint src/audio/format.ts src/audio/pcm.ts src/audio/format.test.ts src/audio/pcm.test.ts` — expect no errors.
- [ ] **Step 5: Commit** `git add src/audio/format.ts src/audio/format.test.ts src/audio/pcm.ts src/audio/pcm.test.ts && git commit -m "feat(audio): clock formatting and 16 kHz mono PCM preparation"` (with the Co-Authored-By trailer).

---

### Task 2: Transcriber types, worker protocol, segment mapping and the worker client

**Files:**
- Create: `src/audio/types.ts`
- Create: `src/audio/whisperProtocol.ts`, `src/audio/whisperProtocol.test.ts`
- Create: `src/audio/whisperClient.ts`, `src/audio/whisperClient.test.ts`

**Interfaces:**
- Consumes: `TARGET_SAMPLE_RATE` from `src/audio/pcm.ts` (Task 1); `TranscriptSegment` from `@/storage/types`.
- Produces:
  ```ts
  // types.ts — architecture §3.3, with an additive `stage` argument (spec F2-A3)
  import type { TranscriptSegment } from '@/storage/types';
  export type TranscribeStage = 'loading' | 'transcribing';
  export interface TranscribeOptions {
    model: string;
    /** `p` is 0–1 within `stage`. */
    onProgress?: (p: number, stage: TranscribeStage) => void;
    signal?: AbortSignal;
  }
  export interface AudioTranscriptionResult { text: string; segments: TranscriptSegment[]; language: string | null }
  export interface AudioTranscriber {
    /** 16 kHz mono PCM. The buffer may be transferred (detached) by the implementation. */
    transcribe(pcm: Float32Array, opts: TranscribeOptions): Promise<AudioTranscriptionResult>;
  }

  // whisperProtocol.ts
  export interface WhisperChunk { timestamp: [number, number | null]; text: string }
  export type WhisperRequest =
    | { type: 'transcribe'; id: number; model: string; pcm: Float32Array }
    | { type: 'cancel'; id: number };
  export type WhisperResponse =
    | { type: 'progress'; id: number; stage: TranscribeStage; progress: number }
    | { type: 'result'; id: number; text: string; chunks: WhisperChunk[] }
    | { type: 'error'; id: number; message: string };
  export const WHISPER_OPTIONS = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 } as const;
  export function chunksToSegments(chunks: readonly WhisperChunk[], durationMs: number): TranscriptSegment[];
  export function languageForModel(model: string): string | null;

  // whisperClient.ts
  export interface WorkerLike {
    postMessage(message: WhisperRequest, transfer?: Transferable[]): void;
    addEventListener(type: 'message', fn: (e: MessageEvent<WhisperResponse>) => void): void;
    addEventListener(type: 'error', fn: (e: ErrorEvent) => void): void;
    terminate(): void;
  }
  export function createWhisperTranscriber(deps: { createWorker: () => WorkerLike }): AudioTranscriber;
  ```

**Behavior details:**
- `chunksToSegments`: sort by start; for each chunk `startMs = Math.round(s * 1000)`; end seconds = `e ?? next chunk's start ?? durationMs / 1000`; `endMs = Math.max(startMs, Math.round(end * 1000))`; `text = text.trim()`; drop chunks whose trimmed text is empty.
- `languageForModel(model)`: `/\.en$/i` → `'en'`, else `null`.
- Client:
  - Worker is created lazily on the first `transcribe` and reused.
  - Each call gets an incrementing numeric `id`. If `signal?.aborted` at call time → reject immediately with `new DOMException('Transcription aborted', 'AbortError')` without posting.
  - `durationMs = pcm.length / TARGET_SAMPLE_RATE * 1000` is computed BEFORE posting. The posted `pcm` must own an exact-size buffer: if `pcm.byteOffset !== 0 || pcm.byteLength !== pcm.buffer.byteLength` post `pcm.slice()`; post with `transfer: [posted.buffer]`.
  - `progress` messages → `onProgress(progress, stage)` of the matching id. `result` → resolve `{ text: text.trim(), segments: chunksToSegments(chunks, durationMs), language: languageForModel(model) }`. `error` → reject `new Error(message)`. Messages for unknown ids are ignored.
  - Abort after posting: post `{ type: 'cancel', id }`, reject with `AbortError`, forget the id (a later result for it is ignored).
  - Worker `error` event: reject every pending call with `new Error('Whisper worker crashed: <event.message || "unknown error">')`, `terminate()` the worker and drop it so the next call creates a new one.

- [ ] **Step 1: Write failing tests** — `src/audio/whisperProtocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunksToSegments, languageForModel } from '@/audio/whisperProtocol';

describe('chunksToSegments', () => {
  it('converts seconds to ms offsets and trims text', () => {
    expect(chunksToSegments([
      { timestamp: [0, 8.004], text: ' And so my fellow Americans' },
      { timestamp: [8.004, 11.5], text: ' ask not. ' },
    ], 12_000)).toEqual([
      { startMs: 0, endMs: 8004, text: 'And so my fellow Americans' },
      { startMs: 8004, endMs: 11_500, text: 'ask not.' },
    ]);
  });
  it('fills a missing end from the next start, then from the duration', () => {
    expect(chunksToSegments([
      { timestamp: [0, null], text: 'a' },
      { timestamp: [2, null], text: 'b' },
    ], 3_250)).toEqual([
      { startMs: 0, endMs: 2_000, text: 'a' },
      { startMs: 2_000, endMs: 3_250, text: 'b' },
    ]);
  });
  it('drops empty chunks, sorts by start and never ends before it starts', () => {
    expect(chunksToSegments([
      { timestamp: [5, 4], text: 'late' },
      { timestamp: [1, 2], text: '   ' },
      { timestamp: [0, 1], text: 'first' },
    ], 10_000)).toEqual([
      { startMs: 0, endMs: 1_000, text: 'first' },
      { startMs: 5_000, endMs: 5_000, text: 'late' },
    ]);
  });
});

describe('languageForModel', () => {
  it('is English for .en models and unknown otherwise', () => {
    expect(languageForModel('Xenova/whisper-base.en')).toBe('en');
    expect(languageForModel('onnx-community/whisper-base')).toBeNull();
  });
});
```

`src/audio/whisperClient.test.ts` — write a `FakeWorker` implementing `WorkerLike` that records `posted: { message, transfer }[]`, keeps listeners, and exposes `emit(msg: WhisperResponse)` and `crash(message: string)` (dispatches an `ErrorEvent`-like `{ message }` to error listeners), plus `terminated: boolean`. Tests (each a separate `it`):
  1. no worker is created until the first `transcribe`; two calls reuse one worker.
  2. posts `{ type: 'transcribe', id, model, pcm }` with `transfer` equal to `[postedPcm.buffer]`, and resolves with `{ text: 'hello world', segments: [...mapped], language: 'en' }` when the fake emits `{ type: 'result', id, text: ' hello world', chunks: [{ timestamp: [0, null], text: ' hello world' }] }` for a 32 000-sample input (end fills to 2 000 ms — proves duration was computed before transfer even if the fake detaches: in the fake, replace the posted pcm's length by calling `structuredClone(msg.pcm.buffer, { transfer: [msg.pcm.buffer] })` inside `postMessage` to really detach it).
  3. a `pcm` that is a subarray of a larger buffer is posted as an exact-size copy (`posted.pcm.buffer.byteLength === posted.pcm.byteLength`) with the same values.
  4. progress for the matching id reaches `onProgress(0.5, 'loading')` then `onProgress(0, 'transcribing')`; progress for another id does not.
  5. `{ type: 'error', id, message: 'Unsupported model' }` rejects with `'Unsupported model'`.
  6. aborting after posting posts `{ type: 'cancel', id }` and rejects with `name === 'AbortError'`; a late result for that id is ignored (no throw). An already-aborted signal rejects without posting.
  7. a worker crash rejects the pending call with a message containing `Whisper worker crashed`, terminates it, and the next `transcribe` creates a second worker.

- [ ] **Step 2: Run** `npx vitest run src/audio/whisperProtocol.test.ts src/audio/whisperClient.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `types.ts`, `whisperProtocol.ts`, `whisperClient.ts` per the details. No import of `@huggingface/transformers` in any of these files.
- [ ] **Step 4: Run** tests — PASS; `npx eslint` on the five files — no errors; `npx tsc -b` — no errors.
- [ ] **Step 5: Commit** `feat(audio): whisper worker protocol, segment mapping and worker client`.

---

### Task 3: Whisper worker (transformers.js) and build integration

**Files:**
- Create: `src/audio/whisperWorkerCore.ts`, `src/audio/whisperWorkerCore.test.ts`
- Create: `src/audio/whisper.worker.ts`
- Create: `src/audio/whisperWorkerFactory.ts`
- Modify (commit only): `package.json`, `package-lock.json` (the `@huggingface/transformers` ^4.3.0 dependency is already installed, uncommitted)
- Modify (only if the build requires it, minimal): `vite.config.ts`

**Interfaces:**
- Consumes: `WhisperRequest`, `WhisperResponse`, `WhisperChunk`, `WHISPER_OPTIONS` (Task 2); `TranscribeStage` (Task 2).
- Produces:
  ```ts
  // whisperWorkerCore.ts — no transformers import; everything injected
  export type WhisperDevice = 'webgpu' | 'wasm';
  export interface LoadProgress { status: string; progress?: number; file?: string; loaded?: number; total?: number }
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
  export function createWhisperWorkerCore(deps: WhisperWorkerCoreDeps): { handle(message: WhisperRequest): Promise<void> };
  // whisperWorkerFactory.ts
  export function createWhisperWorker(): Worker; // new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
  ```

**Behavior details (core):**
- Jobs run one at a time in arrival order (chain promises); `cancel` is handled immediately (not queued): it adds the id to a cancelled set. A job whose id is cancelled before it starts is skipped; a job cancelled while running has its result/error dropped. Progress for a cancelled id is not posted.
- Device is resolved once (`hasWebGpu()` → `'webgpu'` else `'wasm'`; if `hasWebGpu` throws → `'wasm'`) and cached.
- Pipelines cached as promises in a `Map` keyed `${model}|${device}`. If a load rejects, delete that cache entry. If the device is `webgpu` and the load rejects, try once more with `'wasm'` (cache under the wasm key) and from then on use `'wasm'` for every model (the WebGPU adapter is unusable); if the wasm load also fails, post `error` with the wasm error's message.
- Loading progress: `onProgress(info)` → when `info.status === 'progress_total'` and `typeof info.progress === 'number'` post `{ type: 'progress', id, stage: 'loading', progress: clamp(info.progress / 100, 0, 1) }`. (transformers.js 4.x emits `progress_total` with `progress` in 0–100.) Ignore other statuses. After the pipeline is ready post `{ stage: 'loading', progress: 1 }` once.
- Transcribing: post `{ stage: 'transcribing', progress: 0 }`, call `pipeline(pcm, { ...WHISPER_OPTIONS })`, take the first element if it returns an array, post `{ type: 'result', id, text: out.text ?? '', chunks: out.chunks ?? [] }`, and after it `{ stage: 'transcribing', progress: 1 }` is NOT needed. Any thrown error → `{ type: 'error', id, message: err instanceof Error ? err.message : String(err) }`.

**Behavior details (entry `whisper.worker.ts`, thin, untested):**
```ts
/// <reference lib="webworker" />  // only if needed for typing; otherwise cast self
import { pipeline } from '@huggingface/transformers';
import { createWhisperWorkerCore, type AsrPipeline } from '@/audio/whisperWorkerCore';
import type { WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

const core = createWhisperWorkerCore({
  hasWebGpu: async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  },
  loadPipeline: async (model, { device, onProgress }) =>
    (await pipeline('automatic-speech-recognition', model, {
      device,
      // spec F2-A2: WebGPU uses fp32 encoder + q4 merged decoder; WASM uses the library default (q8)
      ...(device === 'webgpu' ? { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } : {}),
      progress_callback: onProgress,
    })) as unknown as AsrPipeline,
  post: (message: WhisperResponse) => self.postMessage(message),
});
self.addEventListener('message', (event: MessageEvent<WhisperRequest>) => { void core.handle(event.data); });
```
Check the exact installed API in `node_modules/@huggingface/transformers/types/pipelines.d.ts`, `types/utils/hub.d.ts` (`PretrainedModelOptions`: `device`, `dtype`, `progress_callback`) and `types/utils/dtypes.d.ts` and adapt names if they differ; keep the cast minimal and typed. Make sure `tsc -b` accepts the worker (the app tsconfig uses `lib: DOM`; `self.postMessage(message)` compiles against `Window`'s one-arg overload — if not, declare `const ctx = self as unknown as { postMessage(m: WhisperResponse): void; addEventListener(...): void }`).

- [ ] **Step 1: Write failing tests** in `src/audio/whisperWorkerCore.test.ts` with a fake loader (`vi.fn`) returning a fake pipeline (`vi.fn().mockResolvedValue({ text: ' hi', chunks: [{ timestamp: [0, 1], text: ' hi' }] })`) and `post = vi.fn()`. Tests:
  1. uses `webgpu` when `hasWebGpu` resolves true, `wasm` when false, `wasm` when it throws.
  2. calls the pipeline with the PCM and `{ return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }` and posts `{ type: 'result', id: 1, text: ' hi', chunks: [...] }`.
  3. two jobs for the same model load the pipeline once; a different model loads again.
  4. forwards `progress_total` 50 as `{ type: 'progress', id, stage: 'loading', progress: 0.5 }`, ignores `{ status: 'initiate' }`, and posts `loading` 1 then `transcribing` 0 before the result (assert order of `post` calls).
  5. a rejected load posts `{ type: 'error', id, message: 'Could not locate file' }` and the next job for that model calls the loader again (evicted).
  6. a WebGPU load failure retries on wasm (loader called with `device: 'wasm'`) and the job succeeds; a later job for another model goes straight to wasm.
  7. a job cancelled before it starts never calls the pipeline; a job cancelled while the pipeline runs posts no result.
  8. jobs run serially: with a deferred first pipeline promise, the second job's pipeline is not called until the first resolves.
- [ ] **Step 2: Run** `npx vitest run src/audio/whisperWorkerCore.test.ts` — FAIL.
- [ ] **Step 3: Implement** the core, the worker entry and the factory.
- [ ] **Step 4: Run** tests — PASS. Then verify the build: `npm run build`. The worker is not referenced from the app yet (Task 6 does that), so ALSO verify worker bundling once by temporarily adding `import '@/audio/whisperWorkerFactory';` as the last import of `src/main.tsx`, running `npx vite build`, confirming a `dist/assets/whisper.worker-*.js` chunk is emitted and no error occurs, then restoring `src/main.tsx` with `git checkout -- src/main.tsx` (verify `git diff --quiet -- src/main.tsx`). If Vite errors with "Invalid value \"iife\" for option \"output.format\"" (worker code-splitting), add `worker: { format: 'es' }` to `vite.config.ts` (one property, nothing else). If dev mode would need `optimizeDeps: { exclude: ['@huggingface/transformers'] }` per the library README, add it too and say so in the report. Lint the new files.
- [ ] **Step 5: Commit** `package.json package-lock.json src/audio/whisperWorkerCore.ts src/audio/whisperWorkerCore.test.ts src/audio/whisper.worker.ts src/audio/whisperWorkerFactory.ts` (+ `vite.config.ts` if changed): `feat(audio): whisper worker running transformers.js (WebGPU, WASM fallback)`.

---

### Task 4: Serial transcription queue with resume and retry

**Files:**
- Create: `src/audio/transcriptionQueue.ts`, `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `AudioTranscriber`, `TranscribeStage` (Task 2, `src/audio/types.ts`); storage functions from `@/storage/recordings`; `AudioTranscriptRecord` from `@/storage/types`.
- Produces:
  ```ts
  export interface TranscriptionQueueState {
    activeId: string | null;
    stage: TranscribeStage | null;
    /** 0–1 within `stage`; null when idle. */
    progress: number | null;
    /** Waiting ids in order, excluding the active one. */
    queuedIds: readonly string[];
  }
  export interface TranscriptionQueueDeps {
    transcriber: AudioTranscriber;
    decode: (audio: Blob) => Promise<Float32Array>;
    getModel: () => Promise<string>;
    now?: () => number;
  }
  export interface TranscriptionQueue {
    /** Marks the recording pending (persisted) and queues it. Ignored if already queued or active. */
    enqueue(id: string): Promise<void>;
    /** Same as enqueue; for a failed (or done) recording. */
    retry(id: string): Promise<void>;
    /** Queues every recording whose transcript is null, 'pending' or 'running', oldest first. */
    resume(): Promise<void>;
    getState(): TranscriptionQueueState;          // same object until something changes (useSyncExternalStore)
    subscribe(fn: () => void): () => void;         // state changes (including progress)
    subscribeChanges(fn: (recordingId: string) => void): () => void; // after every persisted status write
    /** Resolves when nothing is queued or running. For tests and shutdown. */
    whenIdle(): Promise<void>;
  }
  export function createTranscriptionQueue(deps: TranscriptionQueueDeps): TranscriptionQueue;
  ```

**Behavior details:**
- Transcript writes use `setRecordingTranscript(id, record)` where record is a full `AudioTranscriptRecord`:
  - enqueue: `{ text: '', segments: [], model, language: null, status: 'pending', error: null, updatedAt: now() }` with `model = await getModel()`.
  - job start: `status: 'running'`, model re-read from `getModel()` (the setting may have changed), text/segments empty.
  - success: `{ text, segments, language, model, status: 'done', error: null, updatedAt }`.
  - failure (missing audio → `'Recording audio is missing'`, decode error, transcriber error): `status: 'failed'`, `error: message`, text/segments empty.
- A job for a recording that no longer exists (`getRecording` undefined) is skipped. Any `setRecordingTranscript` rejection whose message starts with `Recording not found` is swallowed (deleted mid-job); other write errors are logged via `console.error` and the queue continues.
- Enqueue of an id that is queued or active is a no-op (no write). `enqueue` resolves after the pending write, not after transcription.
- The loop is serial: exactly one `transcriber.transcribe` in flight. A failure never stops the loop.
- State: `activeId` set at job start; `stage`/`progress` from `onProgress(p, stage)`; reset to `{ activeId: null, stage: null, progress: null }` when the job ends. Emit to `subscribe` listeners on every change; `getState()` returns a new object only when something changed.
- `subscribeChanges` listeners get the recording id after each successful status write (pending, running, done, failed).
- `resume()` uses `listRecordings()` reversed (oldest first) and enqueues where `transcript === null || status === 'pending' || status === 'running'`. For those already `pending`/`running`, enqueue rewrites them `pending` (fine).

- [ ] **Step 1: Write failing tests** (`beforeEach(resetDatabase)`; create recordings with `createRecording({ title: 't', durationMs: 1000, startedAt: n }, new Blob([new Uint8Array([1])], { type: 'audio/webm' }))`; fake transcriber `{ transcribe: vi.fn(async (_pcm, opts) => { opts.onProgress?.(0.5, 'loading'); return { text: 'hello', segments: [{ startMs: 0, endMs: 500, text: 'hello' }], language: 'en' }; }) }`; `decode = vi.fn(async () => new Float32Array(16))`; `getModel = async () => 'Xenova/whisper-base.en'`; `now = () => 1000`). Tests:
  1. enqueue writes `pending` immediately (check via `getRecording` right after `await enqueue`, before `whenIdle` — use a transcriber that waits on a deferred promise), then after `whenIdle()` the transcript is `done` with text `'hello'`, the segments, `language: 'en'`, `model: 'Xenova/whisper-base.en'`, `error: null`.
  2. `running` is persisted while the transcriber runs (read inside the fake transcriber: `(await getRecording(id))!.transcript!.status === 'running'`).
  3. transcriber rejection → `failed` with `error: 'model exploded'`; missing audio (delete bytes by stubbing `decode`? — instead use a recording created then `deleteRecording` → skipped with no throw, and separately a decode rejection `'Could not decode the recording: x'` → failed with that message).
  4. serial: two enqueues with a deferred first transcription → `transcribe` called once until the first resolves, then twice; state `queuedIds` equals `[second]` while first is active.
  5. resume queues `null`, `pending` and `running` transcripts but not `done` or `failed`, oldest first (assert order of `decode`/`transcribe` calls by recording id).
  6. retry of a failed recording transcribes it again and ends `done`.
  7. duplicate enqueue while active or queued does not transcribe twice.
  8. a recording deleted while its transcription runs: queue swallows the not-found write and the next job still runs.
  9. progress: a `subscribe` listener sees `{ activeId: id, stage: 'loading', progress: 0.5 }` during the job and `{ activeId: null, stage: null, progress: null, queuedIds: [] }` after; `subscribeChanges` receives the id for pending, running and done writes (at least 3 calls).
  10. `getModel` is read at job start: change the returned model between enqueue and job start → `done` transcript records the new model.
- [ ] **Step 2: Run** `npx vitest run src/audio/transcriptionQueue.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint the two files.
- [ ] **Step 5: Commit** `feat(audio): serial transcription queue with resume and retry`.

---

### Task 5: Recorder (getUserMedia + MediaRecorder)

**Files:**
- Create: `src/audio/recorder.ts`, `src/audio/recorder.test.ts`

**Interfaces:**
- Consumes: `createRecording`, `CreateRecordingInput` from `@/storage/recordings`; `RecordingRecord` from `@/storage/types`; `recordingTitle` from `src/audio/format.ts` (Task 1).
- Produces:
  ```ts
  export const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;
  export interface RecorderLink { sessionId: string | null; noteId: string | null }
  export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';
  export interface RecorderState {
    status: RecorderStatus;
    startedAt: number | null;
    elapsedMs: number;
    /** The link captured at start; null when idle. */
    link: RecorderLink | null;
    error: string | null;
  }
  export interface MediaRecorderLike {
    readonly state: 'inactive' | 'recording' | 'paused';
    readonly mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null;
    onstop: (() => void) | null;
    onerror: ((event: unknown) => void) | null;
    start(timeslice?: number): void;
    stop(): void;
  }
  export interface MediaRecorderCtor {
    new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorderLike;
    isTypeSupported(type: string): boolean;
  }
  export interface RecorderDeps {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    MediaRecorder?: MediaRecorderCtor;
    save?: (input: CreateRecordingInput, audio: Blob) => Promise<RecordingRecord>;
    onSaved?: (recording: RecordingRecord) => void;
    now?: () => number;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    /** MediaRecorder timeslice. Default 1000. */
    timesliceMs?: number;
    /** Elapsed-time tick. Default 250. */
    tickMs?: number;
  }
  export interface Recorder {
    getState(): RecorderState;                 // stable object between changes
    subscribe(fn: () => void): () => void;
    start(link: RecorderLink): Promise<void>;
    /** Stops, saves and resolves with the saved record (null if nothing was saved). */
    stop(): Promise<RecordingRecord | null>;
    clearError(): void;
  }
  export function createRecorder(deps?: RecorderDeps): Recorder;
  ```

**Behavior details:**
- Defaults resolved lazily at `start` (not at creation): `getUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)`, `MediaRecorder = globalThis.MediaRecorder`, `save = createRecording`, `now = Date.now`, timers = `globalThis.setInterval/clearInterval`.
- `start(link)`: ignored unless `status === 'idle'`. Clears `error`, sets `starting`. Missing getUserMedia or MediaRecorder → back to idle with error `'Recording is not supported in this browser'`. `getUserMedia({ audio: true })`; rejection with `name === 'NotAllowedError'` or `'SecurityError'` → `'Microphone access was denied. Allow it in the browser to record.'`; `'NotFoundError'` → `'No microphone found'`; others → `'Could not start recording: <message>'`. Pick the first `PREFERRED_MIME_TYPES` entry with `isTypeSupported`; none → construct without options. Constructor failure → stop tracks, error `'Could not start recording: <message>'`. Then `start(timesliceMs)`, `startedAt = now()`, copy of `link` stored, `status: 'recording'`, `elapsedMs: 0`, start the tick (`elapsedMs = now() - startedAt`).
- Chunks: push `event.data` when `data.size > 0`.
- `stop()`: when `recording`, set `stopping`, call `mediaRecorder.stop()`, and resolve once `onstop` fired and the save finished. When not recording, resolve `null`.
- Finishing (shared by `stop()` and a spontaneous `onstop`, e.g. the mic was unplugged or `onerror` fired — on `onerror` call `mediaRecorder.stop()` if still recording): clear the tick; `endedAt = now()`; stop every track of the stream (`stream.getTracks().forEach(t => t.stop())`); build `new Blob(chunks, { type: mediaRecorder.mimeType || chosenType || 'audio/webm' })`; if its size is 0 → idle with error `'Nothing was recorded'`, return null; else `save({ title: recordingTitle(startedAt), durationMs: endedAt - startedAt, sessionId: link.sessionId, noteId: link.noteId, startedAt, endedAt, mimeType: blob.type }, blob)`; on success → idle (no error), call `onSaved(record)` (a throwing `onSaved` is caught and logged, never breaks the recorder), return record; on save failure → idle with error `'Could not save the recording: <message>'`, return null.
- Tracks are also stopped on every start failure after getUserMedia resolved.

- [ ] **Step 1: Write failing tests** with a hand-written fake:
```ts
class FakeTrack { stopped = false; stop() { this.stopped = true; } }
function fakeStream(tracks = [new FakeTrack()]) { return { getTracks: () => tracks } as unknown as MediaStream; }
class FakeMediaRecorder implements MediaRecorderLike {
  static supported = new Set(['audio/webm;codecs=opus']);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) { return FakeMediaRecorder.supported.has(type); }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice?: number;
  constructor(public stream: MediaStream, public options?: { mimeType?: string }) { FakeMediaRecorder.instances.push(this); }
  get mimeType() { return this.options?.mimeType ?? ''; }
  start(timeslice?: number) { this.state = 'recording'; this.timeslice = timeslice; }
  emit(bytes: number[]) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
}
```
(Note: `public` parameter properties are forbidden by `erasableSyntaxOnly` — assign fields in the constructor body instead.) Use a manual clock `let t = 1_000; now = () => t;` and fake timers via injected `setInterval`/`clearInterval` that store the callback so the test can call it. `save = vi.fn(async (input, blob) => ({ id: 'r1', ...input, byteLength: blob.size, mimeType: blob.type, transcript: null } as RecordingRecord))`. Tests:
  1. start requests `{ audio: true }`, creates the recorder with `mimeType: 'audio/webm;codecs=opus'`, starts with timeslice 1000, state `recording` with `startedAt` and the link.
  2. mime fallback: supported = `{'audio/mp4'}` → `audio/mp4`; supported = ∅ → constructed with no options.
  3. elapsed: advance clock by 2 500 and fire the tick → `elapsedMs === 2500`; subscribe listener notified.
  4. stop: emitted chunks `[1,2]`, `[3]` → saved blob size 3 and type `audio/webm;codecs=opus`; input has `title: recordingTitle(1000)`, `startedAt: 1000`, `endedAt` = clock at stop, `durationMs` = difference; tracks stopped; state idle; `onSaved` called with the record; `stop()` resolves the record; tick cleared.
  5. link captured at start: start with `{ sessionId: 's1', noteId: 'n1' }`, mutate the object passed in, stop → saved with `s1`/`n1`; start with nulls → saved with nulls.
  6. denial: getUserMedia rejects `Object.assign(new Error('denied'), { name: 'NotAllowedError' })` → idle, error `'Microphone access was denied. Allow it in the browser to record.'`, `save` not called; `NotFoundError` → `'No microphone found'`; no MediaRecorder → `'Recording is not supported in this browser'`.
  7. a second `start` while recording does not call getUserMedia again; `stop` while idle resolves null.
  8. nothing recorded (stop with no chunks) → no save, error `'Nothing was recorded'`, tracks stopped.
  9. spontaneous stop (fake calls `onstop` without `stop()` after a chunk) → saved, tracks stopped, idle.
  10. save failure → idle, error starts with `'Could not save the recording:'`, tracks stopped; `clearError()` clears it.
- [ ] **Step 2: Run** `npx vitest run src/audio/recorder.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint.
- [ ] **Step 5: Commit** `feat(audio): microphone recorder that links recordings to the active note`.

---

### Task 6: Audio runtime singletons and the header RecorderControl

**Files:**
- Create: `src/audio/audioRuntime.ts`
- Modify: `src/audio/RecorderControl.tsx` (replace placeholder body; keep export)
- Create: `src/audio/RecorderControl.test.tsx`

**Interfaces:**
- Consumes: `createRecorder`, `Recorder`, `RecorderState` (Task 5); `createTranscriptionQueue`, `TranscriptionQueue` (Task 4); `createWhisperTranscriber` (Task 2); `createWhisperWorker` (Task 3); `decodeToPcm16k` (Task 1); `formatClock` (Task 1); `getSettingValue` from `@/storage/settingKeys`; `useCaptureState` from `@/capture/CaptureContext`.
- Produces:
  ```ts
  // audioRuntime.ts
  export interface AudioRuntime { recorder: Recorder; queue: TranscriptionQueue }
  /** Lazily builds the app's one recorder + queue + whisper client. No Worker is created until a transcription runs. */
  export function getAudioRuntime(): AudioRuntime;
  /** Idempotent (module-level flag, StrictMode-safe): resumes the transcription queue once per page load. */
  export function startAudioRuntime(): void;
  // RecorderControl.tsx
  export function RecorderControl(props?: { recorder?: Recorder }): JSX.Element;
  ```

**Behavior details:**
- `getAudioRuntime()`: `transcriber = createWhisperTranscriber({ createWorker: createWhisperWorker })`; `queue = createTranscriptionQueue({ transcriber, decode: decodeToPcm16k, getModel: () => getSettingValue('whisper.model') })`; `recorder = createRecorder({ onSaved: (r) => { void queue.enqueue(r.id).catch((e) => console.error('[audio] enqueue failed', e)); } })`.
- `startAudioRuntime()`: guarded by a module-level `let started = false`; calls `getAudioRuntime().queue.resume()` and logs a rejection with `console.error('[audio] resume failed', e)`.
- `RecorderControl({ recorder })`: `const r = recorder ?? getAudioRuntime().recorder` (memoize so the default is resolved once); `useEffect(() => { if (!recorder) startAudioRuntime(); }, [recorder])`; state via `useSyncExternalStore(r.subscribe, r.getState)`; capture state via `useCaptureState()`.
  - idle/starting: an outline `Button` (size `sm`) with the `Mic` icon, text `Record`, disabled while `starting`; click → `r.start({ sessionId: capture.activeSessionId, noteId: capture.activeNoteId })`.
  - recording/stopping: a destructive `Button` with `Square` icon, text `Stop`, disabled while `stopping`; a pulsing red dot (`aria-hidden`), the elapsed time `formatClock(state.elapsedMs)` in a `<span data-testid="recorder-elapsed">` with `tabular-nums`; when `state.link?.noteId` a small `Link` icon + text `Linked to note` (`title="Linked to the active note"`).
  - `state.error` → `<span role="alert" className="text-xs text-destructive">` with the message and a small dismiss button (`aria-label="Dismiss"`) calling `r.clearError()`.
  - Stop click → `void r.stop()`.
  - Use `useCaptureState()` which requires a `CaptureProvider`: tests wrap in `<CaptureProvider engine={...}>` with a minimal fake engine object implementing `getState`/`subscribe` (cast to `CaptureEngine`).

- [ ] **Step 1: Write failing tests** `src/audio/RecorderControl.test.tsx`: build a fake `Recorder` (state object + listeners; `start = vi.fn(async (link) => set({ status: 'recording', startedAt: 0, elapsedMs: 0, link, error: null }))`, `stop = vi.fn(async () => { set(idle); return null; })`, `clearError`) and a fake capture engine whose state is `{ activeSessionId: 's1', activeNoteId: 'n1', activePageId: 'p1', pageIndex: 0 }`. Tests:
  1. idle shows a `Record` button; clicking it calls `start({ sessionId: 's1', noteId: 'n1' })`, then the view shows `Stop`, `0:00` and `Linked to note`.
  2. elapsed updates: set `elapsedMs: 65_000` → `1:05`.
  3. no active note → start called with nulls and no `Linked to note`.
  4. an error state shows the message in `[role="alert"]`; clicking `Dismiss` calls `clearError`.
  5. clicking `Stop` calls `stop`.
- [ ] **Step 2: Run** `npx vitest run src/audio/RecorderControl.test.tsx` — FAIL.
- [ ] **Step 3: Implement** `audioRuntime.ts` and `RecorderControl.tsx`.
- [ ] **Step 4: Run** the test, then the full suite `npx vitest run` (AppShell tests mount `RecorderControl` with the real runtime: resume runs against fake-indexeddb with no recordings, no Worker is built) — all PASS. Run `npm run build` and confirm `dist/assets/` contains a `whisper.worker` chunk. Lint the touched files.
- [ ] **Step 5: Commit** `feat(audio): header recorder control and app-wide audio runtime`.

---

### Task 7: Recordings view and Whisper model setting

**Files:**
- Modify: `src/recordings/RecordingsView.tsx` (replace placeholder; keep export)
- Create: `src/recordings/RecordingDetail.tsx` (selected recording: player + transcript), `src/recordings/RecordingsView.test.tsx`
- Modify: `src/audio/AudioSettings.tsx` (replace placeholder; keep export)
- Create: `src/audio/AudioSettings.test.tsx`

**Interfaces:**
- Consumes: `listRecordings`, `getRecordingAudio`, `deleteRecording` from `@/storage/recordings`; `RecordingRecord` from `@/storage/types`; `getAudioRuntime`, `TranscriptionQueue` (Tasks 4/6); `formatClock` (Task 1); `getSettingValue`, `setSettingValue`, `SETTING_DEFAULTS` from `@/storage/settingKeys`; UI primitives `Button`, `Input`, `Label`, `Progress` from `@/components/ui/*`; icons from `lucide-react`.
- Produces:
  ```ts
  export function RecordingsView(props?: { queue?: TranscriptionQueue }): JSX.Element;
  export function RecordingDetail(props: { recording: RecordingRecord; queue: TranscriptionQueue; onDelete: (id: string) => void }): JSX.Element;
  export const WHISPER_MODEL_OPTIONS: readonly { id: string; label: string }[]; // exported from AudioSettings.tsx
  export function AudioSettings(): JSX.Element;
  ```

**Behavior details:**
- RecordingsView: `const queue = props.queue ?? getAudioRuntime().queue` (resolved once). Loads `listRecordings()` on mount and reloads whenever `queue.subscribeChanges` fires and after a delete. Queue state via `useSyncExternalStore(queue.subscribe, queue.getState)`. The list is newest first (as returned). The newest is selected by default; keep the selection when the list reloads if the id still exists, otherwise select the first. Empty list → centered muted text `No recordings yet. Use Record in the header to capture audio.`
- Layout: two columns on wide screens (list `w-72` left, detail right; stack on narrow). Each list item is a `button` (`data-recording-id`) showing title, local date/time (`toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })`), duration `formatClock(durationMs)`, a `Linked to note` badge when `noteId`, and a status word (`Queued`, `Transcribing`, `Done`, `Failed`, or `Not transcribed` when transcript null).
- RecordingDetail:
  - Audio: on mount / when `recording.id` changes, `getRecordingAudio(id)` → `URL.createObjectURL(blob)` → `<audio controls src=...>`; revoke the previous URL on id change and on unmount (guard against the async load resolving after unmount: revoke immediately in that case). Missing audio → `Audio is missing`.
  - Status block: `pending` → `Queued for transcription`; `running` → `Transcribing…` plus when `queue.getState().activeId === recording.id`: stage `loading` → `Downloading model N%` with `<Progress value={N}>`, stage `transcribing` → `Transcribing…`; `failed` → error text in `role="alert"` and a `Retry` button calling `queue.retry(id)`; transcript null → `Not transcribed` and a `Transcribe` button calling `queue.retry(id)`; `done` with no segments and empty text → `No speech detected`.
  - Transcript: for `done`, a list of segments; each row a `button` with `data-start-ms` and text `formatClock(startMs)`, followed by the segment text. Clicking sets `audio.currentTime = startMs / 1000` and calls `audio.play()` (catch and ignore the returned promise rejection; `play` may be undefined in tests — guard). When there are no segments but text exists, show the text as a paragraph. Show `model` in muted small text.
  - `Delete` button (`aria-label="Delete recording"`, `Trash2` icon) → `window.confirm('Delete this recording?')` → `deleteRecording(id)` → `onDelete(id)`.
- AudioSettings: section heading `Audio`; `Label` `Whisper model` for an `Input` (`id="whisper-model"`, `list="whisper-models"`) with a `<datalist id="whisper-models">` from `WHISPER_MODEL_OPTIONS` = `Xenova/whisper-tiny.en` (Tiny, English, fastest), `Xenova/whisper-base.en` (Base, English, default), `Xenova/whisper-small.en` (Small, English, most accurate, slow), `onnx-community/whisper-base` (Base, multilingual). Loads `getSettingValue('whisper.model')` on mount; saves on blur and on Enter via `setSettingValue` with the trimmed value (empty → restore and save `SETTING_DEFAULTS['whisper.model']`). Helper text: `Downloaded once, then cached by the browser. Applies to the next transcription.` Show `Saved` briefly after a save (a `role="status"` span).

- [ ] **Step 1: Write failing tests.** `src/recordings/RecordingsView.test.tsx` (`beforeEach(resetDatabase)`; stub `URL.createObjectURL = vi.fn(() => 'blob:fake-<n>')` and `URL.revokeObjectURL = vi.fn()` in `beforeEach`, restore after; stub `window.confirm = () => true`; fake queue implementing `TranscriptionQueue` with `retry = vi.fn()`, listeners for `subscribeChanges`, a settable state). Seed with `createRecording` + `setRecordingTranscript`. Tests:
  1. lists recordings newest first (two recordings with `startedAt` 1000 and 2000 → the later title first) and shows `Linked to note` for the one with a `noteId`.
  2. shows the selected recording's transcript segments with times `0:00` and `1:05`; clicking the `1:05` button sets the `<audio>` element's `currentTime` to 65.
  3. a failed transcript shows its error and `Retry`; clicking calls `queue.retry(id)`.
  4. a queue state `{ activeId: id, stage: 'loading', progress: 0.42 }` on a running recording shows `Downloading model 42%`.
  5. selecting another recording revokes the first object URL; unmount revokes the current one.
  6. `Delete` removes the recording from the store and the list.
  7. a `subscribeChanges` notification reloads the list (update a transcript in the DB, fire the listener, see the new text).
  8. empty store shows `No recordings yet`.
  Use `await act(async () => { ... })` and a small `flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); })` helper (call it a few times) to let IndexedDB promises settle.
  `src/audio/AudioSettings.test.tsx` (`beforeEach(resetDatabase)`): shows the default `Xenova/whisper-base.en`; typing a new value (set `input.value` via the native setter + dispatch `input` event, then `blur`/`focusout`) persists it (`await getSettingValue('whisper.model')`); an empty value restores the default; the datalist has 4 options.
- [ ] **Step 2: Run** `npx vitest run src/recordings/RecordingsView.test.tsx src/audio/AudioSettings.test.tsx` — FAIL.
- [ ] **Step 3: Implement** `RecordingsView.tsx`, `RecordingDetail.tsx`, `AudioSettings.tsx`.
- [ ] **Step 4: Run** the tests, then `npx vitest run` (full) and `npm run build` — PASS; lint touched files.
- [ ] **Step 5: Commit** `feat(recordings): recordings view with playback, seekable transcript and retry; whisper model setting`.

---

### Task 8: Final verification and summary commit

**Files:** `docs/features/f2-spec.md` (assumptions only, if anything changed during implementation).

- [ ] **Step 1:** `npx vitest run` — all pass (record counts). `npm run build` — succeeds, note the worker chunk and the transformers chunk sizes. `npx eslint src/audio src/recordings` — no errors.
- [ ] **Step 2:** Update `docs/features/f2-spec.md` "Assumptions" with any rulings made during execution.
- [ ] **Step 3:** Commit `docs(f2): record implementation assumptions` with a body summarizing the feature (files, how the queue starts, deps, config changes) and the Co-Authored-By trailer.
