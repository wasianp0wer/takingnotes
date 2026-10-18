// Serial transcription queue: one job in flight, status persisted on the recording
// itself so a reload can pick up where it left off (`resume()`). Whisper is far too
// heavy to run two models at once, so the loop is deliberately strictly serial.
import type { AudioTranscriber, TranscribeStage } from '@/audio/types';
import { mergeWindowSegments, planWindows } from '@/audio/windows';
import {
  getRecording,
  getRecordingAudio,
  listFinishedRecordings,
  setRecordingTranscript,
} from '@/storage/recordings';
import type { AudioTranscriptRecord, TranscriptSegment } from '@/storage/types';

export interface TranscriptionQueueState {
  activeId: string | null;
  stage: TranscribeStage | null;
  /** 0-1 within `stage`; null when idle, and always 0 while `transcribing`. */
  progress: number | null;
  /**
   * Decode passes finished by the transcribe pass so far; null when idle or
   * loading. There is no total to compare it against - the pipeline decides how
   * many passes each window needs as it runs - so this is a count that climbs,
   * and a count that climbs is what tells a working job from a dead one.
   */
  passes: number | null;
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
  /** How much of a recording one window covers. Default: `DEFAULT_WINDOW_MS`. */
  windowMs?: number;
}

export interface TranscriptionQueue {
  /** Marks the recording pending (persisted) and queues it. Ignored if already queued or active. */
  enqueue(id: string): Promise<void>;
  /** Same as enqueue; for a failed (or done) recording. */
  retry(id: string): Promise<void>;
  /**
   * Stops this recording's transcription: the active job is aborted (which
   * terminates the Whisper worker, so the work really stops rather than
   * grinding on unwatched), and a merely queued one is dropped before it ever
   * reaches the transcriber. Either way the transcript is left `failed`
   * carrying `CANCELLED_MESSAGE`.
   *
   * ⚑ Terminal on purpose. `null`, `pending` and `running` are exactly what
   * `resume()` re-enqueues at launch, so leaving any of them would restart the
   * job the owner just stopped on the next reload. `failed` also brings back
   * the Retry button, which is what keeps cancelling reversible.
   *
   * Only the active and queued jobs are cancellable: an id the queue is not
   * holding is a no-op, not an error.
   */
  cancel(id: string): Promise<void>;
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
 * It has to be longer than the longest silence a *healthy* job can have, and
 * every phase of a job now breaks its own silence: model downloads report every
 * few hundred kilobytes, and the transcribe pass reports once per decode step
 * (`whisperWorkerCore`'s streamer). So the longest healthy silence is a load
 * from cache plus the first window's feature extraction - seconds, not minutes.
 *
 * ⚑ This was fifteen minutes when it had to cover a whole *inference*, because
 * the transcribe pass reported nothing between its `transcribing` 0 and its
 * result. It never did cover one: a lecture is hundreds of sequentially decoded
 * 30-second windows, so the watchdog cancelled healthy jobs and reported them as
 * stalled. Fifteen minutes is now far more than this needs, and is kept only so
 * a slow machine mid-window is never mistaken for a dead one.
 */
const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;

/** The step of a job a stall is reported against, named as the message reads it. */
type JobStep = 'reading the audio' | 'decoding the audio' | 'transcribing' | 'saving the transcript';

/**
 * ⚑ The step is in the message because a stall that does not name one cannot be
 * acted on: every step of a job - the read, the decode, the transcription and the
 * save - can go silent, they fail identically from the outside, and the fix for
 * each is a different one.
 */
function stallMessage(step: JobStep): string {
  return `Transcription stalled while ${step}: it stopped responding, so it was cancelled. Try again.`;
}

/** What a cancelled job's transcript records, so the owner sees why it stopped. */
const CANCELLED_MESSAGE = 'Transcription cancelled.';

const IDLE: TranscriptionQueueState = {
  activeId: null,
  stage: null,
  progress: null,
  passes: null,
  queuedIds: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The transcript text for a set of segments. Built from the segments rather
 * than kept alongside them, so the two can never disagree about what was
 * heard - and so a partial transcript's text is exactly the part that is
 * actually transcribed.
 */
function textOf(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join(' ').trim();
}

function sameState(a: TranscriptionQueueState, b: TranscriptionQueueState): boolean {
  return (
    a.activeId === b.activeId &&
    a.stage === b.stage &&
    a.progress === b.progress &&
    a.passes === b.passes &&
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
  let passes: number | null = null;
  let state: TranscriptionQueueState = IDLE;
  let draining: Promise<void> | null = null;
  /**
   * Aborts the job that is running right now. `runJob` installs this for its own
   * lifetime and `drain` clears it, so it is never left pointing at a finished
   * job's controller.
   */
  let cancelActive: (() => void) | null = null;

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
    const next: TranscriptionQueueState = {
      activeId,
      stage,
      progress,
      passes,
      queuedIds: [...queued],
    };
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
   *
   * A write that is refused for any other reason is logged and the row is left
   * as it stands, deliberately: a `running` row is what `resume()` re-enqueues,
   * so a transient refusal retries itself on the next launch, where a `failed`
   * row would need the owner to press Retry by hand.
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
      completedMs: 0,
      updatedAt: now(),
    };
  }

  async function runJob(id: string): Promise<void> {
    // Before the first await: `cancel` is a button press and the window between
    // this job becoming active and its controller existing covers two storage
    // reads and a write, which is long enough for a click to land in.
    const controller = new AbortController();
    let cancelledByUser = false;
    cancelActive = () => {
      cancelledByUser = true;
      controller.abort();
    };

    // A recording deleted while it waited has nothing left to transcribe.
    if (!(await getRecording(id))) return;

    // Re-read rather than reuse the model from the pending write: the setting may
    // have changed while the recording sat in the queue.
    const model = await deps.getModel();
    await write(id, blank(model, 'running'));

    let finished = false;
    /**
     * Everything transcribed so far, and how far "so far" reaches. These are
     * the job's whole persisted state: every write below is built from them,
     * including the failure writes, so a job that ends badly still leaves the
     * windows it did finish behind it.
     */
    let segments: TranscriptSegment[] = [];
    let cursorMs = 0;
    let language: string | null = null;

    /**
     * ⚑ Carries the accumulated segments and cursor, not blanks. A lecture
     * that stalls or errors in its fortieth window used to be written back
     * empty, so the retry repeated all forty and stalled in the same place.
     */
    const fail = (error: unknown) =>
      write(id, {
        text: textOf(segments),
        segments,
        model,
        language,
        status: 'failed',
        error: messageOf(error),
        completedMs: cursorMs,
        updatedAt: now(),
      });

    // Watchdog: a worker killed without an `error` event would otherwise leave this
    // job - and with it the whole serial loop - waiting for a reply for good. Every
    // progress report is a sign of life and starts the window again, so a slow but
    // progressing model download or transcribe pass is never cancelled.
    //
    // ⚑ Armed before the audio is read rather than after it is decoded, because
    // reading and decoding are the two steps that report nothing of their own. A
    // `decodeAudioData` that never settles - and a lecture-length recording is
    // where that happens - used to hang this job, and the serial loop behind it,
    // silently and permanently: no error, no timeout, and nothing on screen but
    // "Transcribing...".
    let timer: number | null = null;
    let stalled = false;
    /** Read when the watchdog fires, so the stall names whatever was in flight. */
    let step: JobStep = 'reading the audio';
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

    /**
     * Rejects when the watchdog fires, so the steps that cannot take an
     * `AbortSignal` - `getRecordingAudio`, `decode` - can still be given up on.
     * It carries a catch of its own: once the job is past them nothing is racing
     * it any more, and a later abort would surface as an unhandled rejection.
     */
    const whenStalled = new Promise<never>((_resolve, reject) => {
      const bail = (): void => {
        reject(new Error(cancelledByUser ? CANCELLED_MESSAGE : stallMessage(step)));
      };
      // An abort that already happened fires no listener, and a cancel can land
      // before this promise is built.
      if (controller.signal.aborted) {
        bail();
        return;
      }
      controller.signal.addEventListener('abort', bail, { once: true });
    });
    whenStalled.catch(() => {});
    /** Bounds a step that cannot take an `AbortSignal` by the watchdog. */
    const guard = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, whenStalled]);

    /** What a terminal failure should record, given how the job actually ended. */
    const endedWith = (error: unknown): unknown => {
      if (cancelledByUser) return new Error(CANCELLED_MESSAGE);
      if (stalled) return new Error(stallMessage(step));
      return error;
    };

    arm();

    let pcm: Float32Array;
    try {
      const audio = await guard(getRecordingAudio(id));
      if (!audio) throw new Error('Recording audio is missing');
      step = 'decoding the audio';
      pcm = await guard(deps.decode(audio));
    } catch (error) {
      finished = true;
      disarm();
      await fail(endedWith(error));
      return;
    }

    step = 'transcribing';
    const onProgress = (p: number, reported: TranscribeStage, reportedPasses?: number): void => {
      if (finished) return;
      arm();
      if (activeId !== id) return;
      progress = p;
      stage = reported;
      passes = reportedPasses ?? null;
      emit();
    };

    try {
      // ⚑ One `transcribe` call per window, not one per recording. A lecture
      // used to be a single pipeline call that reported nothing and persisted
      // nothing until it finished - hours later, or never. Each window's write
      // below is what makes the job resumable.
      const windows = planWindows(pcm.length, cursorMs, deps.windowMs);
      for (const [index, window] of windows.entries()) {
        const result = await deps.transcriber.transcribe(
          // A subarray, so the master PCM is not detached by the hand-off and
          // the next window still has audio to slice. The client copies a view
          // that does not own its whole buffer, which this one does not.
          pcm.subarray(window.startSample, window.endSample),
          {
            model,
            signal: controller.signal,
            offsetMs: window.startMs,
            onProgress,
          },
        );
        segments = mergeWindowSegments(segments, result.segments, window.startMs);
        // Advanced whatever the window produced: a window of silence yields no
        // segments, and a cursor that did not move past it would re-transcribe
        // that same quiet stretch for good.
        cursorMs = window.endMs;
        language = result.language ?? language;

        const last = index === windows.length - 1;
        if (last) finished = true;
        step = 'saving the transcript';
        // Guarded like the decode: a write is the one step of a job with
        // nothing of its own to stop it waiting for good.
        await guard(
          write(id, {
            text: textOf(segments),
            segments,
            model,
            language,
            status: last ? 'done' : 'running',
            error: null,
            completedMs: cursorMs,
            updatedAt: now(),
          }),
        );
        step = 'transcribing';
      }

      if (windows.length === 0) {
        // Nothing left to transcribe - an empty recording, or a cursor already
        // at or past the end. Finishing is the honest outcome; looping or
        // failing would both be wrong.
        finished = true;
        step = 'saving the transcript';
        await guard(
          write(id, {
            text: textOf(segments),
            segments,
            model,
            language,
            status: 'done',
            error: null,
            completedMs: cursorMs,
            updatedAt: now(),
          }),
        );
      }
    } catch (error) {
      finished = true;
      await fail(endedWith(error));
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
      passes = null;
      emit();
      try {
        await runJob(id);
      } catch (error) {
        // runJob handles its own failures; this is a last resort so one bad job
        // can never stop the queue.
        console.error(`Transcription job for recording ${id} failed:`, error);
      } finally {
        cancelActive = null;
        activeId = null;
        stage = null;
        progress = null;
        passes = null;
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

  async function cancel(id: string): Promise<void> {
    if (activeId === id) {
      cancelActive?.();
      return;
    }
    const waiting = queued.indexOf(id);
    // Not running and not queued - including an id still `reserved` while its
    // `pending` write lands, which the drain loop cannot have started either.
    if (waiting === -1) return;
    queued.splice(waiting, 1);
    emit();
    // The model the `pending` write already stored, rather than another settings
    // read that could fail and leave the id dropped but still marked pending.
    const model = (await getRecording(id))?.transcript?.model ?? '';
    await write(id, {
      text: '',
      segments: [],
      model,
      language: null,
      status: 'failed',
      error: CANCELLED_MESSAGE,
      updatedAt: now(),
    });
    notifyIdle();
  }

  async function resume(): Promise<void> {
    // listFinishedRecordings(), not listRecordings(): since K5 a
    // RecordingRecord exists from the moment recording starts, with
    // transcript: null and a zero-byte recordingAudio row. Enqueuing one of
    // those (⚑ Wave 1 review finding #2) would hand this job a 0-byte Blob,
    // the decode would throw, and the job would be written `failed` -
    // permanently, since resume() never re-enqueues a failed transcript. The
    // audio survives (once K4-K7's recovery runs) but its transcript would
    // be silently destroyed on the exact reload this feature exists to
    // survive.
    const recordings = await listFinishedRecordings();
    // Newest first; transcribe the oldest backlog first.
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
    cancel,
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
