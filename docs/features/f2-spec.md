# F2 — Audio recording + local transcription (feature spec)

Product source: `docs/spec.md` §F2. Contracts: `docs/architecture.md` §2.2
(`RecordingRecord`, `AudioTranscriptRecord`, `TranscriptSegment`), §2.4
(`src/storage/recordings.ts`), §2.5 (`whisper.model`), §3.3 (`AudioTranscriber`).
Assumptions A10–A12 in `docs/assumptions.md` apply.

F2 owns `src/audio/**` and `src/recordings/**`. It replaces the bodies of the
Phase 0 placeholders `RecorderControl`, `AudioSettings` and `RecordingsView`
and keeps their export names.

## User-visible behavior

1. **Record.** The header's Record button asks for the microphone and starts
   recording. While recording it shows a stop button, the elapsed time
   (`m:ss`, `h:mm:ss` past an hour) and, when a note was active at start, a
   "linked to note" indicator. Stopping saves the recording and queues it for
   transcription. A denied permission, a missing microphone or an unsupported
   browser shows a short error next to the button; the button stays usable.
2. **Link.** A recording started while a note is active stores that note's
   `noteId` and `sessionId`, read from `useCaptureState()` at start. Changing
   or ending the note during the recording does not change the link. With no
   active note both are `null` (A10).
3. **Save.** On stop the audio (held in memory, A11) is saved with
   `createRecording` in one transaction with its metadata: title
   `Recording <YYYY-MM-DD HH:mm>` (local time of start), `startedAt` and
   `endedAt` epoch ms, `durationMs = endedAt - startedAt`, mime type from the
   MediaRecorder/Blob.
4. **Transcribe.** A serial queue transcribes saved recordings one at a time:
   read audio → decode to 16 kHz mono PCM → Whisper in a Web Worker
   (transformers.js; WebGPU when available, WASM otherwise) → text plus
   timestamped segments. Status goes `pending → running → done | failed`,
   persisted through `setRecordingTranscript`. Model download and
   transcription progress are shown live. Failed ones can be retried. On app
   start the queue resumes recordings whose transcript is `pending`,
   `running` or missing (`null`).
5. **Recordings view.** Newest first. Each item: title, date/time, duration,
   "linked to note" when `noteId` is set, an `<audio>` player (object URL from
   the stored Blob, revoked on unmount/change), transcript status (with
   progress while running, error + Retry when failed), transcript text as
   segments each with a clickable `m:ss` timestamp that seeks the player to
   that segment, and Delete.
6. **Settings.** The Audio section edits `whisper.model`: a text field with
   suggestions (`Xenova/whisper-tiny.en`, `Xenova/whisper-base.en` (default),
   `Xenova/whisper-small.en`, `onnx-community/whisper-base` (multilingual)).
   The model is read when a transcription starts, so a change applies to the
   next job.

## Design

```
RecorderControl ──start({sessionId,noteId})──▶ recorder.ts ──createRecording──▶ IndexedDB
        │                                         │ onSaved(rec)
        │ mount: startAudioRuntime()              ▼
        └──────────────▶ audioRuntime.ts ──▶ transcriptionQueue.ts
                                                  │ getRecordingAudio → decodeToPcm16k (pcm.ts)
                                                  ▼
                                   whisperClient.ts (AudioTranscriber)
                                                  │ postMessage (whisperProtocol.ts)
                                                  ▼
                                   whisper.worker.ts → whisperWorkerCore.ts → transformers.js
```

| File | Responsibility |
|------|----------------|
| `src/audio/recorder.ts` | `createRecorder(deps)`: getUserMedia + MediaRecorder lifecycle, state via `getState/subscribe`, saves on stop, calls `onSaved`. All browser APIs injected. |
| `src/audio/pcm.ts` | `downmixToMono`, `resampleLinear` (pure), `decodeToPcm16k(blob, deps?)` (AudioContext decode + OfflineAudioContext resample, pure fallback). |
| `src/audio/whisperProtocol.ts` | Typed worker message unions, `chunksToSegments` (seconds → ms segments), `languageForModel`. |
| `src/audio/whisperWorkerCore.ts` | Worker logic with an injected pipeline loader: pipeline cache per model+device, device pick, progress mapping, result/error/cancel messages. No transformers import. |
| `src/audio/whisper.worker.ts` | Thin entry: wires `@huggingface/transformers` `pipeline` + `self.postMessage` into the core. |
| `src/audio/whisperClient.ts` | `createWhisperTranscriber({ createWorker })`: `AudioTranscriber` over the worker; request ids, progress routing, abort, worker crash. |
| `src/audio/transcriptionQueue.ts` | `createTranscriptionQueue(deps)`: serial queue, status writes, resume, retry, live progress state, change notifications. |
| `src/audio/audioRuntime.ts` | App singletons (recorder, queue, transcriber) and idempotent `startAudioRuntime()`. |
| `src/audio/format.ts` | `formatClock(ms)` (`m:ss` / `h:mm:ss`), `recordingTitle(startedAt)`. |
| `src/audio/RecorderControl.tsx`, `src/audio/AudioSettings.tsx`, `src/recordings/RecordingsView.tsx` | Thin UI. |

### `AudioTranscriber` (architecture §3.3, extended compatibly)

```ts
export type TranscribeStage = 'loading' | 'transcribing';
export interface AudioTranscriber {
  transcribe(pcm: Float32Array, opts: {
    model: string;
    onProgress?: (p: number, stage: TranscribeStage) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string; segments: TranscriptSegment[]; language: string | null }>;
}
```

`p` is 0–1 within its stage. The extra `stage` argument is additive: a
one-argument callback from §3.3 still type-checks.

### Worker protocol

Main → worker: `{ type: 'transcribe', id, model, pcm }` (the PCM buffer is
transferred) and `{ type: 'cancel', id }`.
Worker → main: `{ type: 'progress', id, stage, progress }`,
`{ type: 'result', id, text, chunks }` (raw `[start, end|null]` seconds; the
client maps them), `{ type: 'error', id, message }`.

The worker picks `webgpu` when `navigator.gpu?.requestAdapter()` resolves an
adapter, else `wasm`, caches one pipeline promise per `model|device`, and
calls the pipeline with `return_timestamps: true, chunk_length_s: 30,
stride_length_s: 5` and no `language` (`.en` models need none; multilingual
ones auto-detect). A failed pipeline load is evicted from the cache so a retry
re-downloads. Model download progress comes from `progress_callback`'s
`progress_total` events (fallback: per-file `progress` events). Cancel marks the
id cancelled; its eventual result is dropped (transformers.js cannot abort a
running pipeline).

### Segment mapping

`chunksToSegments(chunks, durationMs)`: each chunk `{ timestamp: [s, e|null], text }`
→ `{ startMs: round(s*1000), endMs: round((e ?? nextStart ?? durationSec)*1000), text: text.trim() }`;
empty-text chunks dropped; `endMs >= startMs` is enforced; ordered by start.
`TranscriptSegment` offsets are from `Recording.startedAt`, so absolute time
is `startedAt + startMs` (shared epoch-ms clock with stroke points).

### Queue

- `enqueue(id)`: if not queued/running, writes transcript `{ status: 'pending',
  text: '', segments: [], model, language: null, error: null, updatedAt }` and
  appends it. `retry(id)` = enqueue for a failed/done recording.
- Worker loop: one job at a time. Job: `running` → `getRecordingAudio` →
  `decode` → `transcriber.transcribe` → `done` (text, segments, language,
  model) or `failed` (error message). Missing recording (deleted meanwhile) is
  skipped silently; a failed status write for a deleted recording is ignored.
- `resume()`: `listRecordings()` oldest first; enqueue every recording whose
  transcript is `null`, `pending` or `running` (a `running` left by a reload
  was interrupted).
- State for the UI: `{ activeId, stage, progress, queuedIds }` via
  `getState/subscribe`; `subscribeChanges(fn)` fires after any status write so
  the list refreshes.
- Model: read from `getSettingValue('whisper.model')` when a job starts.

### Startup

`RecorderControl` (always mounted in the header) calls `startAudioRuntime()` in
an effect. It is idempotent through a module-level flag (StrictMode safe, same
pattern as `useLegacyMigration`) and calls `queue.resume()` once. No Phase 0
file changes.

## Tests (planned)

1. **recorder** (`src/audio/recorder.test.ts`, fake MediaRecorder + fake
   getUserMedia + fake clock):
   - start requests `{ audio: true }`, picks `audio/webm;codecs=opus` when
     supported, falls back to the next supported type, and to no mimeType
     when none is supported;
   - state goes idle → recording → idle; elapsed advances with the tick;
   - timesliced chunks are concatenated into the saved Blob;
   - stop stops every mic track;
   - saved recording has title, `startedAt/endedAt/durationMs`, mime type;
     `onSaved` is called with the record;
   - linking: `sessionId`/`noteId` captured at start are saved even if the
     caller's values change before stop; `null` when none;
   - permission denial (`NotAllowedError`) → state `idle` with a clear
     "Microphone access was denied" error, no recording saved; `NotFoundError`
     → "No microphone found"; missing MediaRecorder → unsupported error;
   - a second start while recording is ignored; stop while idle is a no-op;
   - save failure surfaces as an error and releases the mic.
2. **pcm** (`src/audio/pcm.test.ts`): downmix averages channels (and passes
   mono through); resample 48k→16k length and values for a ramp/constant, 16k
   passthrough, upsample; `decodeToPcm16k` uses injected decode/offline
   render and falls back to the pure path when OfflineAudioContext is missing
   or throws; decode errors reject with a clear message.
3. **segment mapping** (`src/audio/whisperProtocol.test.ts`): seconds → ms
   rounding, null end filled from next start / duration, trimmed text, empty
   chunks dropped, `languageForModel`.
4. **worker core** (`src/audio/whisperWorkerCore.test.ts`, fake pipeline
   loader): picks webgpu/wasm, caches one pipeline per model, evicts a failed
   load, forwards load progress, calls the pipeline with the timestamp/chunk
   options, posts result/error, drops a cancelled job's result.
5. **worker client** (`src/audio/whisperClient.test.ts`, fake Worker): posts a
   transcribe message with the PCM buffer transferred, resolves with mapped
   segments, routes progress by id with stage, rejects on error message,
   abort posts cancel and rejects with `AbortError`, a worker `error` event
   rejects pending jobs and the next call gets a fresh worker, lazy worker
   creation.
6. **queue** (`src/audio/transcriptionQueue.test.ts`, fake-indexeddb + fake
   transcriber + fake decode): pending → running → done with segments and
   model; failed with error message; serial (second job starts after first
   finishes); resume picks `null`/`pending`/`running` but not `done`/`failed`;
   retry of a failed recording succeeds; duplicate enqueue ignored; deleted
   recording skipped; progress state and change notifications.
7. **components**: `src/audio/RecorderControl.test.tsx` (click Record →
   elapsed and linked indicator shown with an injected fake recorder; error
   shown), `src/recordings/RecordingsView.test.tsx` (lists recordings newest
   first with transcript segments; clicking a timestamp sets
   `audio.currentTime`; Retry shown for failed and calls the queue; Delete
   removes), `src/audio/AudioSettings.test.tsx` (loads default, saves
   change).
8. **format** (`src/audio/format.test.ts`): `formatClock`, `recordingTitle`.

Tests never download models: the Worker and pipeline are faked at
`createWorker` / the pipeline loader.

## Assumptions

- F2-A1 `Xenova/whisper-base.en` is verified on the Hugging Face Hub as a
  transformers.js ASR model with ONNX weights (checked 2026-09-28), so the
  default in `SETTING_DEFAULTS` is unchanged. `@huggingface/transformers` 4.3.0
  (latest) is used; its own default ASR model is `Xenova/whisper-tiny.en`.
- F2-A2 dtype: on WebGPU the encoder runs `fp32` and the merged decoder
  `q4` (the combination transformers.js's Whisper WebGPU demo uses); on WASM
  the library default (`q8`) is used. ONNX runtime WASM binaries load from
  the library's default CDN; bundling them locally is deferred.
- F2-A3 `AudioTranscriber.opts.onProgress` gains a second `stage` argument
  (`'loading' | 'transcribing'`). Backward compatible with §3.3.
- F2-A4 Language: `'en'` for `*.en` models, otherwise `null`
  (transformers.js does not report the detected language in its ASR output).
- F2-A5 `durationMs` is wall-clock `endedAt - startedAt`; `startedAt` is taken
  when MediaRecorder starts (after permission), so segment offsets line up
  with the audio's zero.
- F2-A6 Cancelling is best-effort: deleting a recording while it is being
  transcribed lets the worker finish; the result write is ignored.
- F2-A7 Recordings are "linked to note" by id only; the recordings view does
  not resolve the note's title (F1 owns notes UI). It shows "Linked to a note".
- F2-A8 Resume treats a `null` transcript as never-queued (a crash between
  save and enqueue) and queues it.
- F2-A9 The queue is started by `RecorderControl`'s mount (always in the
  header) rather than by editing `AppShell`.
- F2-A10 The recorder is a module singleton, so switching tabs never stops a
  recording. Recording across page reloads is not supported (A11).
- F2-A11 Long recordings are decoded whole in memory (a 1-hour stereo 48 kHz
  decode is over 1 GB of float samples before resampling). Chunked decoding is
  deferred; very long recordings may fail to transcribe on low-memory machines
  and show as `failed` with the browser's error.
