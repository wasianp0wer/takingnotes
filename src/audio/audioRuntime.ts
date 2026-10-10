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
import {
  deleteRecording,
  finalizeRecording,
  getRecording,
  listUnfinishedRecordings,
} from '@/storage/recordings';
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
  /**
   * ⚑ The id of the recording this process's own recorder currently owns
   * (if any) - default: `getAudioRuntime().recorder.getActiveRecordingId()`.
   * A recording actively being written right now must never be touched by
   * recovery: stitching and finalizing it mid-flight would purge its
   * in-progress chunks (`finalizeRecording` deletes them in the same
   * transaction it writes the audio) out from under the live recorder,
   * which would then stitch only the post-purge remainder - headerless,
   * undecodable bytes - into what it believes is the real close. Today
   * this can only happen within one process (recovery runs once at
   * startup, before any recorder is live, in the normal case), but relying
   * on that ordering alone is luck, not a guard.
   */
  activeRecordingId?: () => string | null;
  /** Default: `stitchRecordingChunks`. Injectable so tests can model another actor's interleaving. */
  stitch?: (recordingId: string) => Promise<Blob | null>;
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
 * ⚑ The same hazard, reinstated across two *concurrent* actors (two tabs
 * open after a crash, or two recovery passes racing): both can snapshot the
 * same unfinished row before either finishes. The first to finalize writes
 * the audio and purges the chunks atomically; the second's `stitch` then
 * sees zero chunks and - without the guard below - would read that as
 * "nothing was ever captured" and delete the row `finalizeRecording`'s
 * transaction just populated, destroying the lecture the first actor just
 * saved. Before deleting on a `null` stitch result, this re-reads the row
 * and only deletes when it is *still* unfinished and *still* empty
 * (`endedAt === null && byteLength === 0`) - a row some other actor just
 * finished in between fails that check and is left alone.
 *
 * One recording's recovery failing (a storage error) is logged and does not
 * stop the rest from being recovered - audio must never block on another
 * recording's trouble (A28's spirit extended to recovery).
 */
export async function recoverInterruptedRecordings(deps: RecoveryDeps = {}): Promise<void> {
  const enqueue = deps.enqueue ?? ((id: string) => getAudioRuntime().queue.enqueue(id));
  const now = deps.now ?? Date.now;
  const activeRecordingId =
    deps.activeRecordingId ?? (() => getAudioRuntime().recorder.getActiveRecordingId());
  const stitch = deps.stitch ?? stitchRecordingChunks;

  const unfinished = await listUnfinishedRecordings();
  for (const recording of unfinished) {
    if (recording.id === activeRecordingId()) {
      // Live right now, in this same process - never recovery's to touch.
      continue;
    }
    try {
      const stitched = await stitch(recording.id);
      if (stitched === null) {
        // ⚑ Re-read rather than trust the snapshot above: another actor may
        // have finalized this exact row (writing its audio and purging its
        // chunks atomically) between listUnfinishedRecordings() and here.
        // Only a row that is *still* unfinished and *still* empty is
        // genuinely abandoned.
        const current = await getRecording(recording.id);
        if (current && current.endedAt === null && current.byteLength === 0) {
          await deleteRecording(recording.id);
        }
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
