// App-wide audio singletons. Built lazily so importing this module (e.g. from
// a component that isn't mounted yet) never touches the microphone, storage
// or the whisper worker; `startAudioRuntime()` is the one place that kicks
// off startup recovery (K7) and then the transcription queue's backlog,
// once per page load, in that order.
import { decodeToPcm16k } from '@/audio/pcm';
import { createRecorder } from '@/audio/recorder';
import type { Recorder } from '@/audio/recorder';
import { createTranscriptionQueue } from '@/audio/transcriptionQueue';
import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { createWhisperTranscriber } from '@/audio/whisperClient';
import { createWhisperWorker } from '@/audio/whisperWorkerFactory';
import { stitchRecordingChunks } from '@/storage/recordingChunks';
import { deleteRecording, finalizeRecording, listUnfinishedRecordings } from '@/storage/recordings';
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

export interface RecoveryDeps {
  /** Default: `getAudioRuntime().queue.enqueue`. */
  enqueue?: (recordingId: string) => Promise<void>;
  /** Default: `Date.now`. Injectable so recovery's derived `endedAt` is deterministic in tests. */
  now?: () => number;
}

/**
 * K7: startup recovery. Every recording left with `endedAt === null` (K5: a
 * row exists from the moment recording starts) is either stitched and
 * closed, or - if it never received a single chunk - deleted rather than
 * left as an empty husk.
 *
 * Closing a recovered recording goes through `finalizeRecording`, the same
 * one-transaction close `recorder.ts`'s `stop()` uses (⚑ Wave 1 review
 * finding #1): recovery must patch `endedAt` itself, in the same write that
 * deletes the chunks, or a second recovery pass (e.g. a reload that lands
 * before anything else ran) would find zero chunks and an unfinished row and
 * delete a recording this pass just finished saving.
 *
 * One recording's recovery failing (a storage error) is logged and does not
 * stop the rest from being recovered - audio must never block on another
 * recording's trouble (A28's spirit extended to recovery).
 */
export async function recoverInterruptedRecordings(deps: RecoveryDeps = {}): Promise<void> {
  const enqueue = deps.enqueue ?? ((id: string) => getAudioRuntime().queue.enqueue(id));
  const now = deps.now ?? Date.now;

  const unfinished = await listUnfinishedRecordings();
  for (const recording of unfinished) {
    try {
      const stitched = await stitchRecordingChunks(recording.id);
      if (stitched === null) {
        await deleteRecording(recording.id);
        continue;
      }
      const endedAt = now();
      await finalizeRecording(recording.id, stitched, {
        endedAt,
        durationMs: Math.max(0, endedAt - recording.startedAt),
      });
      await enqueue(recording.id);
    } catch (error) {
      console.error(`[audio] could not recover recording ${recording.id}`, error);
    }
  }
}

export interface StartAudioRuntimeDeps {
  /** Default: `recoverInterruptedRecordings`. */
  recover?: () => Promise<void>;
  /** Default: `getAudioRuntime().queue.resume`. */
  resume?: () => Promise<void>;
}

let started = false;

/**
 * Idempotent (module-level flag, StrictMode-safe): runs K7's startup
 * recovery and only then resumes the transcription queue's backlog, once
 * per page load. The order is load-bearing (⚑ Wave 1 review finding #2):
 * `resume()` reads recordings through `listFinishedRecordings()`, but if it
 * ran *before* recovery closed an interrupted recording, that recording
 * would still look unfinished and simply be skipped this launch - recovery
 * has to run first so the recording is finished (and therefore visible to
 * resume()) by the time resume() looks.
 */
export function startAudioRuntime(deps: StartAudioRuntimeDeps = {}): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  const recover = deps.recover ?? (() => recoverInterruptedRecordings());
  const resume = deps.resume ?? (() => getAudioRuntime().queue.resume());

  return recover()
    .catch((error) => {
      console.error('[audio] recovery failed', error);
    })
    .then(() => resume())
    .catch((error) => {
      console.error('[audio] resume failed', error);
    });
}

/** Resets the module-level singletons. For tests only. */
export function resetAudioRuntimeForTests(): void {
  runtime = null;
  started = false;
}
