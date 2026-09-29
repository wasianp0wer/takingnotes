// App-wide audio singletons. Built lazily so importing this module (e.g. from
// a component that isn't mounted yet) never touches the microphone, storage
// or the whisper worker; `startAudioRuntime()` is the one place that kicks
// the transcription queue's backlog off, once per page load.
import { decodeToPcm16k } from '@/audio/pcm';
import { createRecorder } from '@/audio/recorder';
import type { Recorder } from '@/audio/recorder';
import { createTranscriptionQueue } from '@/audio/transcriptionQueue';
import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { createWhisperTranscriber } from '@/audio/whisperClient';
import { createWhisperWorker } from '@/audio/whisperWorkerFactory';
import { getSettingValue } from '@/storage/settingKeys';

export interface AudioRuntime {
  recorder: Recorder;
  queue: TranscriptionQueue;
}

let runtime: AudioRuntime | null = null;

/**
 * Lazily builds the app's one recorder + queue + whisper client. No Worker is
 * created until a transcription runs (the whisper client only calls
 * `createWorker` from inside its first `transcribe()`).
 */
export function getAudioRuntime(): AudioRuntime {
  if (!runtime) {
    const transcriber = createWhisperTranscriber({ createWorker: createWhisperWorker });
    const queue = createTranscriptionQueue({
      transcriber,
      decode: decodeToPcm16k,
      getModel: () => getSettingValue('whisper.model'),
    });
    const recorder = createRecorder({
      onSaved: (recording) => {
        void queue.enqueue(recording.id).catch((error) => {
          console.error('[audio] enqueue failed', error);
        });
      },
    });
    runtime = { recorder, queue };
  }
  return runtime;
}

let started = false;

/** Idempotent (module-level flag, StrictMode-safe): resumes the transcription queue once per page load. */
export function startAudioRuntime(): void {
  if (started) return;
  started = true;
  getAudioRuntime()
    .queue.resume()
    .catch((error) => {
      console.error('[audio] resume failed', error);
    });
}
