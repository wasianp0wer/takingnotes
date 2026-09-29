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
  const queued: string[] = [];
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

  function notifyIdle(): void {
    if (draining || activeId !== null || queued.length > 0) return;
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

    try {
      const result = await deps.transcriber.transcribe(pcm, {
        model,
        onProgress: (p, reported) => {
          if (finished || activeId !== id) return;
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
      await fail(error);
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
    if (activeId === id || queued.includes(id)) return;
    queued.push(id);
    emit();
    await write(id, blank(await deps.getModel(), 'pending'));
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
      if (!draining && activeId === null && queued.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
