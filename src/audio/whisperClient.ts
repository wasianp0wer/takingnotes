// Main-thread side of the Whisper worker: one lazily created worker, one numeric id per
// call, and a promise per id. The worker itself is injected so tests never construct a real
// `Worker` and never load the model runtime.
import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import type {
  AudioTranscriber,
  AudioTranscriptionResult,
  TranscribeOptions,
  TranscribeStage,
} from '@/audio/types';
import { chunksToSegments, languageForModel } from '@/audio/whisperProtocol';
import type { WhisperRequest, WhisperResponse } from '@/audio/whisperProtocol';

/** The slice of the `Worker` interface the client needs. A real `Worker` satisfies it. */
export interface WorkerLike {
  postMessage(message: WhisperRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<WhisperResponse>) => void): void;
  addEventListener(type: 'error', fn: (e: ErrorEvent) => void): void;
  terminate(): void;
}

interface PendingCall {
  model: string;
  durationMs: number;
  /** Where this call's audio begins in the recording; added to every segment time. */
  offsetMs: number;
  onProgress?: (p: number, stage: TranscribeStage, passes?: number) => void;
  resolve: (result: AudioTranscriptionResult) => void;
  reject: (error: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException('Transcription aborted', 'AbortError');
}

/** Whether `pcm` already owns its whole buffer, so it can be transferred as it is. */
function ownsWholeBuffer(pcm: Float32Array): boolean {
  return pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength;
}

export function createWhisperTranscriber(deps: { createWorker: () => WorkerLike }): AudioTranscriber {
  const pending = new Map<number, PendingCall>();
  let worker: WorkerLike | null = null;
  let nextId = 1;

  function handleMessage(response: WhisperResponse): void {
    const call = pending.get(response.id);
    if (!call) {
      // A cancelled or already-settled call: nothing left to tell.
      return;
    }
    switch (response.type) {
      case 'progress':
        call.onProgress?.(response.progress, response.stage, response.passes);
        return;
      case 'result':
        pending.delete(response.id);
        call.resolve({
          text: response.text.trim(),
          segments: chunksToSegments(response.chunks, call.durationMs, call.offsetMs),
          language: languageForModel(call.model),
        });
        return;
      case 'error':
        pending.delete(response.id);
        call.reject(new Error(response.message));
        return;
    }
  }

  /**
   * Stops using `used`, kills it, and rejects whatever was still waiting on it.
   *
   * ⚑ Both callers need every part of this. The worker runs its jobs on one
   * chain and cannot interrupt the pipeline call it is inside, so a job nobody
   * is waiting for any more still owns the worker until it finishes on its own -
   * and the next job posted to that worker does not start, reports no progress,
   * and is declared stalled in its turn. That is how one abandoned job used to
   * fail an entire backlog. A worker that owes us an answer we have stopped
   * waiting for is not ours to keep.
   */
  function discard(used: WorkerLike, reason: string): void {
    const error = new Error(reason);
    const calls = [...pending.values()];
    pending.clear();
    if (worker === used) {
      worker = null;
    }
    used.terminate();
    for (const call of calls) {
      call.reject(error);
    }
  }

  function handleCrash(crashed: WorkerLike, message: string | undefined): void {
    discard(crashed, `Whisper worker crashed: ${message || 'unknown error'}`);
  }

  function ensureWorker(): WorkerLike {
    if (worker) {
      return worker;
    }
    const created = deps.createWorker();
    created.addEventListener('message', (event: MessageEvent<WhisperResponse>) => {
      handleMessage(event.data);
    });
    created.addEventListener('error', (event: ErrorEvent) => {
      handleCrash(created, event?.message);
    });
    worker = created;
    return created;
  }

  function transcribe(pcm: Float32Array, opts: TranscribeOptions): Promise<AudioTranscriptionResult> {
    const { model, onProgress, signal, offsetMs = 0 } = opts;
    return new Promise<AudioTranscriptionResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const id = nextId;
      nextId += 1;
      // Must be read before the buffer is handed off, which detaches the view.
      const durationMs = (pcm.length / TARGET_SAMPLE_RATE) * 1000;
      const posted = ownsWholeBuffer(pcm) ? pcm : pcm.slice();

      let onAbort: (() => void) | undefined;
      const settle = (run: () => void): void => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
        run();
      };

      // Before registering the call, so a worker that fails to start rejects instead of hanging.
      const active = ensureWorker();

      pending.set(id, {
        model,
        durationMs,
        offsetMs,
        onProgress,
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      });

      if (signal) {
        onAbort = () => {
          if (!pending.delete(id)) {
            return;
          }
          try {
            active.postMessage({ type: 'cancel', id }, []);
          } catch (error) {
            // A worker the browser already killed throws here. The caller asked to
            // abort, so it still gets its AbortError: letting this escape would
            // leave the call unsettled for good.
            console.error('Could not cancel the Whisper job in the worker:', error);
          }
          // The `cancel` above only lands if the worker is still answering, and
          // the one caller that aborts does so *because* it has had no sign of
          // life for a quarter of an hour.
          discard(active, 'Whisper worker discarded after an aborted transcription');
          settle(() => reject(abortError()));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        active.postMessage({ type: 'transcribe', id, model, pcm: posted }, [posted.buffer as ArrayBuffer]);
      } catch (error) {
        // A synchronous throw - unclonable pcm, an already-detached buffer, a worker
        // being torn down - means the worker never saw this id and will never answer
        // it. Forget the call so nothing is left waiting on a reply.
        if (pending.delete(id)) {
          settle(() => reject(error));
        }
      }
    });
  }

  return { transcribe };
}
