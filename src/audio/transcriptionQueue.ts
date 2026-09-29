// Serial transcription queue: one job in flight, status persisted on the recording
// itself so a reload can pick up where it left off (`resume()`). Whisper is far too
// heavy to run two models at once, so the loop is deliberately strictly serial.
import type { AudioTranscriber, TranscribeStage } from '@/audio/types';
import {
  getRecording,
  getRecordingAudio,
  listRecordings,
  setRecordingTranscript,
} from '@/storage/recordings';
import type { AudioTranscriptRecord } from '@/storage/types';

export interface TranscriptionQueueState {
  activeId: string | null;
  stage: TranscribeStage | null;
  /** 0-1 within `stage`; null when idle. */
  progress: number | null;
  /** Waiting ids in order, excluding the active one. */
  queuedIds: readonly string[];
}

export interface TranscriptionQueueDeps {
  transcriber: AudioTranscriber;
  decode: (audio: Blob) => Promise<Float32Array>;
  getModel: () => Promise<string>;
  now?: () => number;
  /**
   * How long a job may report no progress at all before it is abandoned; see
   * `DEFAULT_STALL_TIMEOUT_MS`. Tests pass a stand-in timer pair instead of waiting.
   */
  stallTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface TranscriptionQueue {
  /** Marks the recording pending (persisted) and queues it. Ignored if already queued or active. */
  enqueue(id: string): Promise<void>;
  /** Same as enqueue; for a failed (or done) recording. */
  retry(id: string): Promise<void>;
  /** Queues every recording whose transcript is null, 'pending' or 'running', oldest first. */
  resume(): Promise<void>;
  /** The same object until something changes, for `useSyncExternalStore`. */
  getState(): TranscriptionQueueState;
  /** State changes, including progress. */
  subscribe(fn: () => void): () => void;
  /** Called after every persisted status write, with the recording id. */
  subscribeChanges(fn: (recordingId: string) => void): () => void;
  /** Resolves when nothing is queued or running. For tests and shutdown. */
  whenIdle(): Promise<void>;
}

/**
 * A browser that kills the Whisper worker (OOM on a long recording, spec F2-A11)
 * fires no `error` event, so the only sign of life a job has is its progress
 * reports. This is the inactivity window after which a job is abandoned so the
 * serial loop can move on instead of waiting for a reply that will never come.
 *
 * It has to be longer than the longest silence a *healthy* job can have. Model
 * downloads report progress every few hundred kilobytes, but the transcribe pass
 * itself reports nothing at all between its `transcribing` 0 and its result, so
 * this window has to cover a whole transcription: on the wasm fallback that is
 * several minutes for a long recording. Fifteen minutes is generous for that and
 * still bounds a wedge that used to need a page reload.
 */
const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;

const STALL_MESSAGE =
  'Transcription stalled: the transcriber stopped responding, so it was cancelled. Try again.';

const IDLE: TranscriptionQueueState = {
  activeId: null,
  stage: null,
  progress: null,
  queuedIds: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameState(a: TranscriptionQueueState, b: TranscriptionQueueState): boolean {
  return (
    a.activeId === b.activeId &&
    a.stage === b.stage &&
    a.progress === b.progress &&
    a.queuedIds.length === b.queuedIds.length &&
    a.queuedIds.every((id, i) => id === b.queuedIds[i])
  );
}

export function createTranscriptionQueue(deps: TranscriptionQueueDeps): TranscriptionQueue {
  const now = deps.now ?? Date.now;
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  // `window.setTimeout`, not the bare global, so the handle is a number here too.
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle));
  const queued: string[] = [];
  /**
   * Ids accepted by `enqueue` whose `pending` write has not landed yet. They are
   * deliberately not in `queued`: the drain loop must not be able to start a job
   * whose `pending` write is still in flight, or that write would land after the
   * job's own `running` and strand the recording. They still count as work for
   * `whenIdle` and they still deduplicate a second `enqueue` of the same id.
   */
  const reserved = new Set<string>();
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(recordingId: string) => void>();
  const idleWaiters: (() => void)[] = [];

  let activeId: string | null = null;
  let stage: TranscribeStage | null = null;
  let progress: number | null = null;
  let state: TranscriptionQueueState = IDLE;
  let draining: Promise<void> | null = null;

  /**
   * A subscriber is a bystander: one that throws must not break the caller that
   * happened to trigger the notification, nor the drain loop.
   */
  function safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error('A transcription queue listener threw:', error);
    }
  }

  function emit(): void {
    const next: TranscriptionQueueState = { activeId, stage, progress, queuedIds: [...queued] };
    if (sameState(state, next)) return;
    state = next;
    for (const fn of [...listeners]) safely(fn);
  }

  function isIdle(): boolean {
    return !draining && activeId === null && queued.length === 0 && reserved.size === 0;
  }

  function notifyIdle(): void {
    if (!isIdle()) return;
    const waiters = idleWaiters.splice(0);
    for (const fn of waiters) fn();
  }

  /**
   * Swallows the write for a recording deleted mid-job - losing the race with a
   * delete is not an error - and keeps the loop alive for anything else.
   */
  async function write(id: string, record: AudioTranscriptRecord): Promise<void> {
    try {
      await setRecordingTranscript(id, record);
    } catch (error) {
      const message = messageOf(error);
      if (!message.startsWith('Recording not found')) {
        console.error(`Could not save transcript status for recording ${id}:`, error);
      }
      return;
    }
    for (const fn of [...changeListeners]) safely(() => fn(id));
  }

  function blank(model: string, status: 'pending' | 'running'): AudioTranscriptRecord {
    return {
      text: '',
      segments: [],
      model,
      language: null,
      status,
      error: null,
      updatedAt: now(),
    };
  }

  async function runJob(id: string): Promise<void> {
    // A recording deleted while it waited has nothing left to transcribe.
    if (!(await getRecording(id))) return;

    // Re-read rather than reuse the model from the pending write: the setting may
    // have changed while the recording sat in the queue.
    const model = await deps.getModel();
    await write(id, blank(model, 'running'));

    let finished = false;
    const fail = (error: unknown) =>
      write(id, {
        text: '',
        segments: [],
        model,
        language: null,
        status: 'failed',
        error: messageOf(error),
        updatedAt: now(),
      });

    let pcm: Float32Array;
    try {
      const audio = await getRecordingAudio(id);
      if (!audio) throw new Error('Recording audio is missing');
      pcm = await deps.decode(audio);
    } catch (error) {
      finished = true;
      await fail(error);
      return;
    }

    // Watchdog: a worker killed without an `error` event would otherwise leave this
    // job - and with it the whole serial loop - waiting for a reply for good. Every
    // progress report is a sign of life and starts the window again, so a slow but
    // progressing model download is never cancelled.
    const controller = new AbortController();
    let timer: number | null = null;
    let stalled = false;
    const disarm = (): void => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    };
    const arm = (): void => {
      disarm();
      timer = setTimer(() => {
        timer = null;
        stalled = true;
        controller.abort();
      }, stallTimeoutMs);
    };

    arm();
    try {
      const result = await deps.transcriber.transcribe(pcm, {
        model,
        signal: controller.signal,
        onProgress: (p, reported) => {
          if (finished) return;
          arm();
          if (activeId !== id) return;
          progress = p;
          stage = reported;
          emit();
        },
      });
      finished = true;
      await write(id, {
        text: result.text,
        segments: result.segments,
        model,
        language: result.language,
        status: 'done',
        error: null,
        updatedAt: now(),
      });
    } catch (error) {
      finished = true;
      await fail(stalled ? new Error(STALL_MESSAGE) : error);
    } finally {
      // Every exit path: a watchdog left armed here would abort a later job.
      disarm();
    }
  }

  async function drain(): Promise<void> {
    while (queued.length > 0) {
      const id = queued.shift()!;
      activeId = id;
      stage = null;
      progress = null;
      emit();
      try {
        await runJob(id);
      } catch (error) {
        // runJob handles its own failures; this is a last resort so one bad job
        // can never stop the queue.
        console.error(`Transcription job for recording ${id} failed:`, error);
      } finally {
        activeId = null;
        stage = null;
        progress = null;
        emit();
      }
    }
  }

  function pump(): void {
    if (draining || queued.length === 0) return;
    draining = drain().finally(() => {
      draining = null;
      // Restart for anything enqueued as the last job wound down, so an id can
      // never be left sitting in `queued` with no loop to pick it up.
      pump();
      notifyIdle();
    });
  }

  async function enqueue(id: string): Promise<void> {
    if (activeId === id || reserved.has(id) || queued.includes(id)) return;
    reserved.add(id);
    try {
      await write(id, blank(await deps.getModel(), 'pending'));
    } catch (error) {
      // `getModel` is a settings read and can reject. Give the reservation back so
      // the id is not stranded: a later retry must still be able to queue it, and
      // an idle waiter must not hang on work that will never run.
      reserved.delete(id);
      notifyIdle();
      throw error;
    }
    reserved.delete(id);
    queued.push(id);
    emit();
    pump();
  }

  async function resume(): Promise<void> {
    const recordings = await listRecordings();
    // `listRecordings` is newest first; transcribe the oldest backlog first.
    for (const recording of [...recordings].reverse()) {
      const status = recording.transcript?.status;
      if (recording.transcript === null || status === 'pending' || status === 'running') {
        await enqueue(recording.id);
      }
    }
  }

  return {
    enqueue,
    retry: enqueue,
    resume,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    subscribeChanges(fn) {
      changeListeners.add(fn);
      return () => {
        changeListeners.delete(fn);
      };
    },
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
