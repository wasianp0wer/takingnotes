// Serial transcription queue: one job in flight, status persisted on the recording
// itself so a reload can pick up where it left off (`resume()`). Whisper is far too
// heavy to run two models at once, so the loop is deliberately strictly serial.
import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import type { AudioTranscriber, TranscribeStage } from '@/audio/types';
import { mergeWindowSegments, planWindows } from '@/audio/windows';
import { newId } from '@/storage/id';
import { deletePcmCache, getPcmCache, putPcmCache } from '@/storage/pcmCache';
import {
  getRecording,
  getRecordingAudio,
  listFinishedRecordings,
  setRecordingTranscript,
  takeTranscriptionLease,
} from '@/storage/recordings';
import type { AudioTranscriptRecord, TranscriptSegment } from '@/storage/types';

/**
 * How urgently a queued recording wants the one Whisper slot.
 *
 * `foreground` is work the owner is waiting on right now: a recording that
 * just finished, one startup recovery just rescued, or one they pressed a
 * button for. `backlog` is only the launch-time catch-up `resume()` queues.
 *
 * The distinction exists because a durable partial transcript makes a backlog
 * durable too: before, nothing survived a reload so the queue was always
 * empty at launch. Now a half-done lecture would otherwise sit in front of
 * the one the owner just recorded, for however many hours it has left.
 */
export type TranscriptionPriority = 'foreground' | 'backlog';

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
  /**
   * How much of the active recording is transcribed, and how long it is, in
   * ms. Both null when idle. Together they are the one honest proportion this
   * queue can report - `passes` has no total to be a fraction of, and
   * `progress` only means anything while the model is loading.
   */
  completedMs: number | null;
  durationMs: number | null;
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
  /**
   * The decoded-audio cache. Defaults bind to `@/storage/pcmCache`. It exists
   * so a resumed job never re-decodes: decoding a lecture costs minutes and
   * peaks above a gigabyte, and a job that resumes on every launch would pay
   * that every time.
   */
  /**
   * Identifies this tab in the lease it writes. Default: an id held in
   * `sessionStorage`, so a reloaded tab is still recognised as itself.
   */
  ownerId?: string;
  /** How long a lease survives without a heartbeat. Default: `LEASE_STALE_MS`. */
  leaseStaleMs?: number;
  readPcmCache?: (recordingId: string) => Promise<Float32Array | null>;
  writePcmCache?: (recordingId: string, pcm: Float32Array) => Promise<void>;
  dropPcmCache?: (recordingId: string) => Promise<void>;
}

export interface TranscriptionQueue {
  /**
   * Marks the recording pending (persisted) and queues it. Ignored if already
   * queued or active. Defaults to `foreground`, which is what a just-finished
   * recording, a recovered one and a button press all want.
   */
  enqueue(id: string, priority?: TranscriptionPriority): Promise<void>;
  /** Same as enqueue; for a failed (or done) recording. */
  retry(id: string): Promise<void>;
  /**
   * Stops this recording's transcription and keeps what it has: the active job
   * is aborted (which terminates the Whisper worker, so the work really stops
   * rather than grinding on unwatched) and a merely queued one is dropped
   * before it ever reaches the transcriber. Either way the transcript is left
   * `paused`, carrying every window finished so far and the cursor they reach.
   *
   * ⚑ Immediate, not deferred to the next window boundary. A stop button that
   * does nothing visible for a window length would be worse than losing the
   * window in flight, which is the cost here: the cursor sits at the last
   * boundary that completed.
   *
   * ⚑ `paused` is its own status because `null`, `pending` and `running` are
   * exactly what `resume()` re-enqueues at launch - leaving any of them would
   * restart on the next reload the job the owner just stopped. This is the
   * property the old terminal cancel existed for, now served without throwing
   * the partial transcript away.
   *
   * Only the active and queued jobs can be paused: an id the queue is not
   * holding, or a recording that no longer exists, is a no-op rather than an
   * error. Discarding a transcription outright is deleting the recording.
   */
  pause(id: string): Promise<void>;
  /**
   * Queues every recording whose transcript is null, 'pending' or 'running',
   * oldest first. Deliberately not `paused`, and not `failed`.
   */
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

/**
 * How long a lease stays valid without a heartbeat.
 *
 * Deliberately the stall timeout: a job that has not written in that long is
 * dead by the watchdog's own definition, so the tab holding it is either gone
 * or about to abandon the job itself. Shorter would let a healthy slow tab be
 * robbed mid-window; longer would strand a lecture behind a crashed tab.
 */
export const LEASE_STALE_MS = 60 * 1000;

/**
 * How often a running job refreshes its lease. Progress reports arrive far
 * more often than this (once per decode step), so the heartbeat is throttled
 * to keep it from turning every one of them into a storage write.
 *
 * ⚑ The heartbeat rides on progress, not on the per-window write, and
 * `LEASE_STALE_MS` is sized against it rather than against a window. A
 * 5-minute window on a machine running inference 3-4x slower than real time
 * takes 15-20 minutes of wall clock; a lease refreshed only at the window
 * boundary would go stale in the middle of a perfectly healthy job, and
 * another tab would take it - producing exactly the interleaved writes the
 * lease exists to prevent.
 */
const LEASE_HEARTBEAT_MS = 10 * 1000;

/**
 * How far a cached decode's length may differ from its recording's reported
 * duration before it is distrusted and re-decoded.
 *
 * Generous on purpose: `durationMs` for a recording startup recovery stitched
 * is estimated from its chunk count rather than measured, so a small
 * disagreement is expected and is not evidence of a bad row. What this is
 * guarding against is a row that is wrong by minutes.
 */
const CACHE_LENGTH_TOLERANCE_MS = 5 * 1000;

/**
 * This tab's identity for leasing, stable across reloads.
 *
 * ⚑ `sessionStorage` rather than a fresh id per queue. A queue is built once
 * per page load, so a per-instance id makes a reloaded tab a *stranger* to
 * its own in-flight job: it would refuse to resume for a full
 * `LEASE_STALE_MS`, with a Retry button that silently does nothing, in the
 * exact crash-and-reload case this feature exists to survive. `sessionStorage`
 * is per-tab and survives reload, which is precisely the identity wanted.
 */
function tabOwnerId(): string {
  const key = 'transcription.ownerId';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = newId();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    // Private mode, blocked site data, or no DOM: a fresh id per queue is
    // the old behaviour and still correct, just less forgiving of a reload.
    return newId();
  }
}

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

/**
 * Rejects the in-flight step when the owner pauses. Never persisted: a paused
 * job writes `status: 'paused'` with no error, since pausing is not a failure.
 */
const PAUSED_SENTINEL = 'Transcription paused.';

const IDLE: TranscriptionQueueState = {
  activeId: null,
  stage: null,
  progress: null,
  passes: null,
  completedMs: null,
  durationMs: null,
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
    a.completedMs === b.completedMs &&
    a.durationMs === b.durationMs &&
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
  const ownerId = deps.ownerId ?? tabOwnerId();
  const leaseStaleMs = deps.leaseStaleMs ?? LEASE_STALE_MS;
  const readPcmCache = deps.readPcmCache ?? getPcmCache;
  const writePcmCache = deps.writePcmCache ?? putPcmCache;
  const dropPcmCache = deps.dropPcmCache ?? deletePcmCache;
  /**
   * Waiting work, highest priority first within each class. Two classes
   * rather than one sorted list, because a yielded job goes back to the front
   * of *its own* class - ahead of the rest of the backlog, behind anything
   * the owner is waiting on.
   */
  const waiting: Record<TranscriptionPriority, string[]> = { foreground: [], backlog: [] };
  const queuedIds = (): string[] => [...waiting.foreground, ...waiting.backlog];
  const isQueued = (id: string): boolean =>
    waiting.foreground.includes(id) || waiting.backlog.includes(id);
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
  let completedMs: number | null = null;
  let durationMs: number | null = null;
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
      completedMs,
      durationMs,
      queuedIds: queuedIds(),
    };
    if (sameState(state, next)) return;
    state = next;
    for (const fn of [...listeners]) safely(fn);
  }

  function isIdle(): boolean {
    return (
      !draining && activeId === null && queuedIds().length === 0 && reserved.size === 0
    );
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

  /**
   * The `pending` (or opening `running`) row for a recording, carrying forward
   * whatever has already been transcribed.
   *
   * ⚑ Not a blank row. Since a `running` transcript holds real content and a
   * cursor, writing blanks here would destroy the partial on the way *into*
   * the queue - on every retry, every resumed launch, and every re-enqueue of
   * a paused job.
   *
   * ⚑ A partial is only carried forward when the *same* model produced it.
   * `whisper.model` is the owner's own speed lever and can change while a
   * recording waits, so this is an expected act rather than an edge case;
   * appending model B's words to model A's and stamping the row with one
   * model id would be a lie about what the transcript is. Changing the model
   * is therefore also the only way to force a clean re-run.
   *
   * `runJob` applies the same rule again when it starts, and both are needed:
   * this one covers a model changed before the recording was queued, and
   * `runJob`'s covers one changed while it sat in the queue - a real window,
   * since the queue is serial and a backlog can be hours long.
   */
  function carryForward(
    existing: AudioTranscriptRecord | null | undefined,
    model: string,
    status: 'pending' | 'running',
  ): AudioTranscriptRecord {
    const continues = existing?.model === model ? existing : null;
    const segments = continues?.segments ?? [];
    return {
      text: textOf(segments),
      segments,
      model,
      language: continues?.language ?? null,
      status,
      error: null,
      completedMs: continues?.completedMs ?? 0,
      // ⚑ Carried, not cleared. This write happens before `runJob` reads the
      // row, so dropping the lease here would hand another tab's in-flight
      // job straight to this one - defeating the lease entirely.
      leaseOwner: existing?.leaseOwner ?? null,
      leaseAt: existing?.leaseAt ?? null,
      updatedAt: now(),
    };
  }

  /**
   * Whether the job holding the slot should step aside at this boundary.
   * Only a backlog job yields, and only to work the owner is waiting on - two
   * foreground jobs take turns in arrival order rather than interrupting each
   * other mid-lecture.
   */
  function shouldYield(priority: TranscriptionPriority): boolean {
    return priority === 'backlog' && waiting.foreground.length > 0;
  }

  /** Resolves true when the job stepped aside at a window boundary rather than finishing. */
  /**
   * Claims this recording for this tab, atomically.
   *
   * ⚑ Delegated to storage rather than done here as a read-then-write: the
   * decision and the write have to be one transaction, or two tabs opening
   * together both read "unheld" before either writes and both go on to
   * transcribe into the same row - the splice the lease exists to prevent.
   */
  function claim(id: string): Promise<boolean> {
    return takeTranscriptionLease(id, ownerId, now(), leaseStaleMs);
  }

  /** The lease fields for a write made while this queue holds the job. */
  function held(): Pick<AudioTranscriptRecord, 'leaseOwner' | 'leaseAt'> {
    return { leaseOwner: ownerId, leaseAt: now() };
  }

  /** The lease fields for a write that gives the job up. */
  const released = { leaseOwner: null, leaseAt: null } as const;

  async function runJob(id: string, priority: TranscriptionPriority): Promise<boolean> {
    // Before the first await: `cancel` is a button press and the window between
    // this job becoming active and its controller existing covers two storage
    // reads and a write, which is long enough for a click to land in.
    const controller = new AbortController();
    let pausedByUser = false;
    cancelActive = () => {
      pausedByUser = true;
      controller.abort();
    };

    // A recording deleted while it waited has nothing left to transcribe.
    const recording = await getRecording(id);
    if (!recording) return false;

    // ⚑ Left untouched, not failed: the other tab is working on it, and
    // writing anything here is exactly the interleaving the lease prevents.
    if (!(await claim(id))) return false;

    // Re-read rather than reuse the model from the pending write: the setting may
    // have changed while the recording sat in the queue.
    const model = await deps.getModel();

    let finished = false;
    /**
     * Everything transcribed so far, and how far "so far" reaches. These are
     * the job's whole persisted state: every write below is built from them,
     * including the failure writes, so a job that ends badly still leaves the
     * windows it did finish behind it.
     *
     * Seeded from what is already stored, which is what makes this job a
     * continuation rather than a restart.
     */
    /**
     * ⚑ A stored partial is only a continuation of *this* job if the same
     * model produced it. `getModel()` is re-read at entry (see above) because
     * the setting can change while a recording waits, and `whisper.model` is
     * the owner's own speed lever - so this is an expected act, not an edge
     * case. Appending model B's words to model A's and stamping the row with
     * one model id would be a lie about what the transcript is.
     *
     * This is also the only way to force a clean re-run: change the model.
     * The cached decode is kept either way - 16 kHz PCM is the same bytes
     * whichever model reads it.
     */
    const resumed = recording.transcript?.model === model ? recording.transcript : null;
    let segments: TranscriptSegment[] = resumed?.segments ? [...resumed.segments] : [];
    let cursorMs = resumed?.completedMs ?? 0;
    let language: string | null = resumed?.language ?? null;

    // Captured once, past the existence guard above: `cachedPcm` is a
    // hoisted function declaration, so TypeScript cannot carry the narrowing
    // of `recording` into it.
    const recordedDurationMs = recording.durationMs;

    /** Publishes the cursor so a view can show a real proportion. */
    const publishCursor = (): void => {
      if (activeId !== id) return;
      completedMs = cursorMs;
      durationMs = recording.durationMs;
      emit();
    };
    publishCursor();

    // ⚑ Not `blank(...)`: against a resumed job that would wipe the very
    // partial transcript this feature exists to keep, and wipe it before the
    // first new window could replace it.
    await write(id, {
      text: textOf(segments),
      segments,
      model,
      language,
      status: 'running',
      error: null,
      completedMs: cursorMs,
      ...held(),
      updatedAt: now(),
    });

    /**
     * ⚑ Carries the accumulated segments and cursor, not blanks. A lecture
     * that stalls or errors in its fortieth window used to be written back
     * empty, so the retry repeated all forty and stalled in the same place.
     */
    /**
     * Releases the cached decode.
     *
     * ⚑ On `done` only - deliberately NOT on `failed`. A failed job keeps its
     * cursor precisely so Retry resumes from the last finished window; making
     * that retry re-decode first (minutes, and a peak above a gigabyte on a
     * lecture) would give back most of what the cursor buys. The row is
     * bounded by its recording: `deleteRecording` clears it, and a job that
     * reaches `done` releases it here.
     */
    const dropCache = async (): Promise<void> => {
      try {
        await dropPcmCache(id);
      } catch (error) {
        // An orphaned cache row costs disk, not correctness, and the next
        // delete of the recording clears it anyway.
        console.warn(`Could not drop the cached decode for recording ${id}:`, error);
      }
    };

    const fail = async (error: unknown) => {
      await write(id, {
        text: textOf(segments),
        segments,
        model,
        language,
        status: 'failed',
        error: messageOf(error),
        completedMs: cursorMs,
        ...released,
        updatedAt: now(),
      });
    };

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
        reject(new Error(pausedByUser ? PAUSED_SENTINEL : stallMessage(step)));
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
      if (stalled) return new Error(stallMessage(step));
      return error;
    };

    /**
     * Refreshes only the lease, leaving the transcript's content alone. A
     * failure is swallowed: a missed heartbeat costs this job its lease at
     * worst, and never its transcript.
     */
    const beat = async (): Promise<void> => {
      try {
        const current = (await getRecording(id))?.transcript;
        // Someone else owns it now, or it is already finished: not ours to stamp.
        if (!current || current.leaseOwner !== ownerId) return;
        await setRecordingTranscript(id, { ...current, leaseAt: now() });
      } catch {
        // See above.
      }
    };

    /**
     * A paused job: every window it finished, the cursor they reach, and no
     * error - being stopped on purpose is not a failure, and writing one here
     * would put a red message under a transcript that is simply waiting.
     */
    const writePaused = () =>
      write(id, {
        text: textOf(segments),
        segments,
        model,
        language,
        status: 'paused',
        error: null,
        completedMs: cursorMs,
        ...released,
        updatedAt: now(),
      });

    arm();

    /**
     * The cached decode, when there is one that can actually serve this job.
     *
     * ⚑ The row has to match the *recording*, not merely clear the cursor.
     * A row long enough to pass the cursor but short of the audio runs the
     * job out of windows early and writes `done` on a lecture that was never
     * finished - silent truncation, and indistinguishable afterwards from a
     * recording that really did end there. A read that throws is a miss, not
     * a failure: the audio is still there to decode.
     */
    async function cachedPcm(): Promise<Float32Array | null> {
      try {
        const cached = await guard(readPcmCache(id));
        if (!cached) return null;
        const cachedMs = (cached.length / TARGET_SAMPLE_RATE) * 1000;
        if (cachedMs < cursorMs) return null;
        // A tolerance, not equality: `durationMs` for a recovered recording
        // is estimated from its chunk count (one timeslice each), so it is
        // honest to within a timeslice rather than exact.
        const expectedMs = recordedDurationMs;
        if (expectedMs > 0 && Math.abs(cachedMs - expectedMs) > CACHE_LENGTH_TOLERANCE_MS) {
          return null;
        }
        return cached;
      } catch (error) {
        if (stalled || pausedByUser) throw error;
        console.warn(`Could not read the cached decode for recording ${id}:`, error);
        return null;
      }
    }

    let pcm: Float32Array;
    try {
      const cached = await cachedPcm();
      if (cached) {
        pcm = cached;
      } else {
        const audio = await guard(getRecordingAudio(id));
        if (!audio) throw new Error('Recording audio is missing');
        step = 'decoding the audio';
        pcm = await guard(deps.decode(audio));
        // Cached before the first window, not after the last: the whole point
        // is to be there for a job that does not reach the last window.
        try {
          await guard(writePcmCache(id, pcm));
        } catch (error) {
          if (stalled || pausedByUser) throw error;
          // A cache that cannot be written costs a re-decode on resume; it
          // does not cost the transcription.
          console.warn(`Could not cache the decode for recording ${id}:`, error);
        }
      }
    } catch (error) {
      finished = true;
      disarm();
      if (pausedByUser) await writePaused();
      else await fail(endedWith(error));
      return false;
    }

    step = 'transcribing';
    let yielded = false;
    /** When the lease was last refreshed, so the heartbeat can be throttled. */
    let lastBeat = now();
    const onProgress = (p: number, reported: TranscribeStage, reportedPasses?: number): void => {
      if (finished) return;
      arm();
      if (activeId !== id) return;
      progress = p;
      stage = reported;
      passes = reportedPasses ?? null;
      emit();
      // The lease's heartbeat: a window can take far longer than the lease
      // survives, so liveness has to be reported from inside one.
      if (now() - lastBeat >= LEASE_HEARTBEAT_MS) {
        lastBeat = now();
        void beat();
      }
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
            // ⚑ The slice's own start, not the boundary: the slice begins
            // `WINDOW_OVERLAP_MS` earlier for lead-in context, and Whisper
            // times its words from the first sample it was given.
            offsetMs: window.sliceStartMs,
            onProgress,
          },
        );
        segments = mergeWindowSegments(segments, result.segments, window.startMs);
        // Advanced whatever the window produced: a window of silence yields no
        // segments, and a cursor that did not move past it would re-transcribe
        // that same quiet stretch for good.
        cursorMs = window.endMs;
        language = result.language ?? language;
        publishCursor();

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
            // Released on the terminal write; refreshed as a heartbeat on
            // every other one.
            ...(last ? released : held()),
            updatedAt: now(),
          }),
        );
        if (last) await dropCache();
        step = 'transcribing';

        // ⚑ The boundary is the only safe place to stop: the cursor was just
        // persisted, so stepping aside here costs nothing and the job resumes
        // at this exact point. This is what a durable cursor buys - before
        // it, deferring a job meant losing its work, which is why the queue
        // order had to be a fixed policy.
        if (!last && shouldYield(priority)) {
          // The lease stays: this same queue is coming back to it, and its
          // heartbeat was just refreshed by the write above.
          yielded = true;
          break;
        }
      }

      if (!yielded && windows.length === 0) {
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
            ...released,
            updatedAt: now(),
          }),
        );
        await dropCache();
      }
    } catch (error) {
      finished = true;
      if (pausedByUser) await writePaused();
      else await fail(endedWith(error));
    } finally {
      // Every exit path: a watchdog left armed here would abort a later job.
      disarm();
    }

    // ⚑ A yielded job stays `running` with its cursor - deliberately not a
    // state of its own. It is still in a waiting list, so `RecordingDetail`'s
    // "stuck" heuristic reads it as queued rather than stranded, and if the
    // tab closes before the queue gets back to it, `resume()` finds exactly
    // the `running` row it already knows how to pick up.
    return yielded;
  }

  async function drain(): Promise<void> {
    while (queuedIds().length > 0) {
      // Foreground first, always: that is the whole point of the two classes.
      const priority: TranscriptionPriority =
        waiting.foreground.length > 0 ? 'foreground' : 'backlog';
      const id = waiting[priority].shift()!;
      activeId = id;
      stage = null;
      progress = null;
      passes = null;
      completedMs = null;
      durationMs = null;
      emit();
      let yielded = false;
      try {
        yielded = await runJob(id, priority);
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
        completedMs = null;
        durationMs = null;
        // ⚑ Back to the FRONT of its own class, not the back: a job that
        // stepped aside for something more urgent has already done work, and
        // sending it behind the rest of the backlog would be a demotion for
        // having been interrupted.
        if (yielded) waiting[priority].unshift(id);
        emit();
      }
    }
  }

  function pump(): void {
    if (draining || queuedIds().length === 0) return;
    draining = drain().finally(() => {
      draining = null;
      // Restart for anything enqueued as the last job wound down, so an id can
      // never be left sitting in a waiting list with no loop to pick it up.
      pump();
      notifyIdle();
    });
  }

  async function enqueue(
    id: string,
    priority: TranscriptionPriority = 'foreground',
  ): Promise<void> {
    if (activeId === id || reserved.has(id) || isQueued(id)) return;
    reserved.add(id);
    try {
      const [model, existing] = await Promise.all([deps.getModel(), getRecording(id)]);
      // Another tab is working this recording right now: not ours to queue,
      // and not ours to write a `pending` row over.
      if (!(await claim(id))) {
        reserved.delete(id);
        notifyIdle();
        return;
      }
      await write(id, carryForward(existing?.transcript, model, 'pending'));
    } catch (error) {
      // `getModel` is a settings read and can reject. Give the reservation back so
      // the id is not stranded: a later retry must still be able to queue it, and
      // an idle waiter must not hang on work that will never run.
      reserved.delete(id);
      notifyIdle();
      throw error;
    }
    reserved.delete(id);
    waiting[priority].push(id);
    emit();
    pump();
  }

  async function pause(id: string): Promise<void> {
    if (activeId === id) {
      cancelActive?.();
      return;
    }
    // Not running and not queued - including an id still `reserved` while its
    // `pending` write lands, which the drain loop cannot have started either.
    const klass = (['foreground', 'backlog'] as const).find((name) =>
      waiting[name].includes(id),
    );
    if (!klass) return;
    waiting[klass].splice(waiting[klass].indexOf(id), 1);
    emit();
    // Whatever the `pending` write already stored, rather than another
    // settings read that could fail and leave the id dropped but still marked
    // pending. A recording deleted in the meantime has nothing to write, and
    // `write` swallows that.
    const existing = (await getRecording(id))?.transcript;
    await write(id, {
      ...carryForward(existing, existing?.model ?? '', 'pending'),
      status: 'paused',
      ...released,
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
        await enqueue(recording.id, 'backlog');
      }
    }
  }

  return {
    enqueue,
    retry: enqueue,
    pause,
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
