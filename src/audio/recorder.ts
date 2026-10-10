// Captures microphone audio with MediaRecorder and saves it linked to the
// note/session that was active when recording started (A10: that link is
// null when there was no active note).
//
// K4-K6: the recording survives an interruption. The `RecordingRecord` is
// created at `start()` - before any chunk exists - with `endedAt: null`, and
// every `MediaRecorder` timeslice is persisted to storage as it arrives
// (`appendRecordingChunk`). `stop()` stitches those chunks and closes the
// recording through `finalizeRecording`'s single atomic transaction (writes
// the audio, patches `endedAt`/`durationMs`/`byteLength`/`mimeType`, deletes
// the chunk rows) - never a stitch-then-patch sequence of separate writes,
// which would reopen the crash window `finalizeRecording` exists to close
// (a crash between those steps would leave `endedAt === null`, zero chunks,
// and a complete recording already on disk, which startup recovery would
// then read as an abandoned empty row and delete).
import { recordingTitle } from '@/audio/format';
import { createRecording, deleteRecording, finalizeRecording } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';
import { appendRecordingChunk, stitchRecordingChunks } from '@/storage/recordingChunks';

export const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

export interface RecorderLink {
  sessionId: string | null;
  noteId: string | null;
}

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecorderState {
  status: RecorderStatus;
  startedAt: number | null;
  elapsedMs: number;
  /** The link captured at start; null when idle. */
  link: RecorderLink | null;
  error: string | null;
  /**
   * A28: a lost chunk (one `appendChunk` failure) is reported, never fatal -
   * the recording keeps going. Distinct from `error`, which accompanies a
   * terminal state change; `warning` can appear mid-recording and is reset
   * whenever a new recording starts or the current one ends.
   */
  warning: string | null;
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

/** Input to `RecorderDeps.createPending` (K5): everything known before any audio exists. */
export interface CreatePendingInput {
  title: string;
  sessionId: string | null;
  noteId: string | null;
  startedAt: number;
  mimeType: string;
}

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: MediaRecorderCtor;
  /**
   * K5: creates the `RecordingRecord` before any chunk exists, with
   * `endedAt: null`. Default wraps `createRecording` with a zero-byte Blob
   * and `endedAt: null`, `durationMs: 0`.
   */
  createPending?: (input: CreatePendingInput) => Promise<RecordingRecord>;
  /** K4: persists one `MediaRecorder` timeslice as it arrives. Default: `appendRecordingChunk`. */
  appendChunk?: (recordingId: string, seq: number, blob: Blob) => Promise<void>;
  /** Reassembles a recording's persisted chunks in order. Default: `stitchRecordingChunks`. */
  stitch?: (recordingId: string) => Promise<Blob | null>;
  /** K6: the one atomic close. Default: `finalizeRecording`. */
  finalize?: (
    id: string,
    audio: Blob,
    patch: { endedAt: number; durationMs: number; mimeType?: string },
  ) => Promise<RecordingRecord>;
  /** Cleans up a pending row that never received any audio. Default: `deleteRecording`. */
  deletePending?: (id: string) => Promise<void>;
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
  getState(): RecorderState;
  subscribe(fn: () => void): () => void;
  start(link: RecorderLink): Promise<void>;
  /** Stops, saves and resolves with the saved record (null if nothing was saved). */
  stop(): Promise<RecordingRecord | null>;
  clearError(): void;
  /**
   * The id of the recording currently owned by this recorder instance (the
   * pending row created at `start()`, cleared once `stop()`/`finish()`
   * settles it), or `null` when idle. Lets a same-process caller - K7's
   * startup recovery, in particular - recognise and skip a recording that
   * is actively being written right now, rather than relying on recovery
   * only ever running before any recorder is live.
   */
  getActiveRecordingId(): string | null;
}

const IDLE_STATE: RecorderState = {
  status: 'idle',
  startedAt: null,
  elapsedMs: 0,
  link: null,
  error: null,
  warning: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a rejected `getUserMedia()` to the message shown to the user. Browsers
 * report both a real permission denial and a blocked-by-policy denial as
 * `NotAllowedError`/`SecurityError`; both read the same to a person hitting
 * "Record".
 */
function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in the browser to record.';
  }
  if (name === 'NotFoundError') {
    return 'No microphone found';
  }
  return `Could not start recording: ${messageOf(error)}`;
}

async function defaultCreatePending(input: CreatePendingInput): Promise<RecordingRecord> {
  return createRecording(
    {
      title: input.title,
      durationMs: 0,
      sessionId: input.sessionId,
      noteId: input.noteId,
      startedAt: input.startedAt,
      endedAt: null,
      mimeType: input.mimeType,
    },
    new Blob([], { type: input.mimeType }),
  );
}

export function createRecorder(deps: RecorderDeps = {}): Recorder {
  let state: RecorderState = IDLE_STATE;
  const listeners = new Set<() => void>();

  let mediaRecorder: MediaRecorderLike | null = null;
  let stream: MediaStream | null = null;
  let chosenType: string | undefined;
  let tickHandle: unknown = null;
  let stopWaiters: Array<(result: RecordingRecord | null) => void> = [];
  // Set by stop() when it lands during 'starting' - the only await point in
  // start() before the pending record is created is the getUserMedia call
  // below, so this is the only window where a stop request can otherwise be
  // silently dropped, leaving the mic live.
  let stopRequested = false;

  // K4: the recording id (once the pending record exists) and the next chunk
  // sequence number. `pendingAppends` collects every in-flight
  // `appendChunk()` promise (already internally caught) so `finish()` can
  // await all of them before stitching - without this, the last chunk or
  // two (delivered by MediaRecorder's own `stop()`) could still be in
  // flight to IndexedDB when stitching reads back, silently dropping the
  // very end of the recording.
  let recordingId: string | null = null;
  let nextSeq = 0;
  let pendingAppends: Promise<void>[] = [];

  // Resolved fresh in start() (defaults are lazy - not evaluated until a
  // recording actually begins - so definite assignment here, not a default
  // value, which would resolve them at createRecorder() time instead), then
  // held here so finish() - which can run long after start() returns, or
  // from a spontaneous onstop - uses the same instances throughout one
  // recording rather than re-resolving against possibly-changed globals.
  let createPendingFn!: (input: CreatePendingInput) => Promise<RecordingRecord>;
  let appendChunkFn!: (recordingId: string, seq: number, blob: Blob) => Promise<void>;
  let stitchFn!: (recordingId: string) => Promise<Blob | null>;
  let finalizeFn!: (
    id: string,
    audio: Blob,
    patch: { endedAt: number; durationMs: number; mimeType?: string },
  ) => Promise<RecordingRecord>;
  let deletePendingFn!: (id: string) => Promise<void>;
  let nowFn!: () => number;
  let setIntervalFn!: (fn: () => void, ms: number) => unknown;
  let clearIntervalFn!: (handle: unknown) => void;

  function setState(patch: Partial<RecorderState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (error) {
        console.error('[recorder] a subscriber threw', error);
      }
    }
  }

  function stopTick(): void {
    if (tickHandle !== null) {
      clearIntervalFn(tickHandle);
      tickHandle = null;
    }
  }

  function stopStream(): void {
    stream?.getTracks().forEach((track) => track.stop());
  }

  /**
   * Shared by an explicit `stop()` and a spontaneous stop (mic unplugged, or
   * `onerror` forcing a stop) - both end up here through `onstop`, so a
   * recording is closed the same way regardless of why MediaRecorder
   * stopped.
   *
   * I2: everything from here on runs inside a `try/finally`. `stitchFn` was
   * previously the one unguarded await in this function (both calls after
   * it already had their own `try`): on rejection, the tail never ran,
   * `stopWaiters` was never settled, `await recorder.stop()` hung forever,
   * `status` stayed `'stopping'` (disabling Stop and refusing a new
   * `start()`) until a reload, and the bare `void finish()` call in
   * `onstop` raised an unhandled rejection. The `finally` below guarantees
   * `recordingId` is cleared and every waiter is resolved regardless of
   * which step fails.
   */
  async function finish(): Promise<RecordingRecord | null> {
    stopTick();
    const startedAt = state.startedAt;
    const id = recordingId;
    const endedAt = nowFn();
    stopStream();

    const type = mediaRecorder?.mimeType || chosenType || 'audio/webm';
    // Every chunk append issued so far (including one MediaRecorder's own
    // stop() just triggered via a final ondataavailable) must be durably
    // written before stitching reads them back.
    await Promise.all(pendingAppends);
    pendingAppends = [];
    mediaRecorder = null;
    stream = null;

    let result: RecordingRecord | null = null;
    try {
      if (id === null || startedAt === null) {
        setState({ ...IDLE_STATE, error: 'Nothing was recorded' });
      } else {
        let stitched: Blob | null = null;
        let stitchFailed = false;
        try {
          stitched = await stitchFn(id);
        } catch (error) {
          stitchFailed = true;
          // Same as a finalize failure below: the row and its chunks are
          // left exactly as they are, so K7's startup recovery can still
          // find and finish this recording on the next launch.
          setState({ ...IDLE_STATE, error: `Could not save the recording: ${messageOf(error)}` });
        }
        if (!stitchFailed) {
          if (stitched === null) {
            try {
              await deletePendingFn(id);
            } catch (error) {
              console.error('[recorder] could not delete an empty pending recording', error);
            }
            setState({ ...IDLE_STATE, error: 'Nothing was recorded' });
          } else {
            try {
              const record = await finalizeFn(id, stitched, {
                endedAt,
                durationMs: endedAt - startedAt,
                mimeType: type,
              });
              setState({ ...IDLE_STATE });
              result = record;
              try {
                deps.onSaved?.(record);
              } catch (error) {
                console.error('[recorder] onSaved threw', error);
              }
            } catch (error) {
              // Deliberately no cleanup here: the pending row and its
              // chunks are left exactly as they are, so K7's startup
              // recovery can still find and finish this recording on the
              // next launch.
              setState({ ...IDLE_STATE, error: `Could not save the recording: ${messageOf(error)}` });
            }
          }
        }
      }
    } finally {
      recordingId = null;
      const waiters = stopWaiters;
      stopWaiters = [];
      for (const waiter of waiters) waiter(result);
    }
    return result;
  }

  async function start(link: RecorderLink): Promise<void> {
    if (state.status !== 'idle') return;
    stopRequested = false;
    setState({ error: null, warning: null, status: 'starting' });

    const getUserMedia =
      deps.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    const MediaRecorderCtor =
      deps.MediaRecorder ?? (globalThis.MediaRecorder as unknown as MediaRecorderCtor | undefined);
    if (!getUserMedia || !MediaRecorderCtor) {
      setState({ status: 'idle', error: 'Recording is not supported in this browser' });
      return;
    }

    let nextStream: MediaStream;
    try {
      nextStream = await getUserMedia({ audio: true });
    } catch (error) {
      setState({ status: 'idle', error: micErrorMessage(error) });
      return;
    }

    // A stop() that arrived while getUserMedia was pending (the only await
    // point in this function before the pending record exists) must not be
    // silently dropped: without this check the mic would stay live and
    // recording would start anyway once permission came through, even
    // though the caller already asked to stop.
    if (stopRequested) {
      stopRequested = false;
      nextStream.getTracks().forEach((track) => track.stop());
      setState({ status: 'idle', error: null });
      return;
    }

    chosenType = PREFERRED_MIME_TYPES.find((type) => MediaRecorderCtor.isTypeSupported(type));

    let nextRecorder: MediaRecorderLike;
    try {
      nextRecorder = chosenType
        ? new MediaRecorderCtor(nextStream, { mimeType: chosenType })
        : new MediaRecorderCtor(nextStream);
    } catch (error) {
      nextStream.getTracks().forEach((track) => track.stop());
      setState({ status: 'idle', error: `Could not start recording: ${messageOf(error)}` });
      return;
    }

    // Resolve the rest of the deps now, for use by finish()/the tick - see
    // the comment on the outer declarations.
    createPendingFn = deps.createPending ?? defaultCreatePending;
    appendChunkFn = deps.appendChunk ?? appendRecordingChunk;
    stitchFn = deps.stitch ?? stitchRecordingChunks;
    finalizeFn = deps.finalize ?? finalizeRecording;
    deletePendingFn = deps.deletePending ?? deleteRecording;
    nowFn = deps.now ?? Date.now;
    setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle as number));

    const startedAt = nowFn();
    // `mimeType` is populated at construction time (set by the `options`
    // passed to `new MediaRecorderCtor(...)` above), so this is available
    // before `start()` is ever called.
    const type = nextRecorder.mimeType || chosenType || 'audio/webm';

    // K5/C2: the RecordingRecord is created *before* `MediaRecorder.start()`
    // is ever called - not merely before any chunk is appended. The
    // previous order called `start()` first and only attached
    // `ondataavailable`/`onstop`/`onerror` once this resolved, which meant
    // the one real window in which the recorder could legitimately be
    // producing data - the moment right after `start()` - had no handler
    // listening at all. A `dataavailable` delivered then (the very first
    // one, carrying the container's EBML header, Segment info and Tracks)
    // would be dropped with no trace, and without it the stitched blob is
    // undecodable no matter how many later chunks survive. Calling
    // `start()` only after this resolves and the handlers are attached
    // closes that window entirely, rather than merely narrowing it: the
    // real `MediaRecorder` cannot produce data before `start()` runs.
    let pending: RecordingRecord;
    try {
      pending = await createPendingFn({
        title: recordingTitle(startedAt),
        sessionId: link.sessionId,
        noteId: link.noteId,
        startedAt,
        mimeType: type,
      });
    } catch (error) {
      nextStream.getTracks().forEach((track) => track.stop());
      setState({ status: 'idle', error: `Could not start recording: ${messageOf(error)}` });
      return;
    }

    // I1: a stop() landing while the await above was pending must not be
    // silently dropped, the same as the getUserMedia-pending check above -
    // this is the second (and last) await point before the MediaRecorder
    // actually starts. Without this, start() would proceed, publish
    // 'recording', and leave the microphone running after the owner asked
    // it to stop; stop() itself would have already resolved null, so the
    // caller (SessionControls) would believe nothing was recording while a
    // recording was in fact live.
    if (stopRequested) {
      stopRequested = false;
      nextStream.getTracks().forEach((track) => track.stop());
      try {
        await deletePendingFn(pending.id);
      } catch (error) {
        console.error('[recorder] could not delete an unstarted pending recording', error);
      }
      setState({ status: 'idle', error: null });
      return;
    }

    recordingId = pending.id;
    nextSeq = 0;
    pendingAppends = [];

    nextRecorder.ondataavailable = (event) => {
      if (event.data.size === 0 || recordingId === null) return;
      const id = recordingId;
      const seq = nextSeq++;
      pendingAppends.push(appendChunkWithRetry(id, seq, event.data));
    };
    nextRecorder.onstop = () => {
      void finish();
    };
    nextRecorder.onerror = () => {
      if (nextRecorder.state === 'recording') nextRecorder.stop();
    };

    const timesliceMs = deps.timesliceMs ?? 1000;
    try {
      nextRecorder.start(timesliceMs);
    } catch (error) {
      // The pending row already exists (created above) but no audio will
      // ever arrive for it - clean it up now rather than leaving an orphan
      // for a future launch's K7 recovery to find and discard.
      recordingId = null;
      nextStream.getTracks().forEach((track) => track.stop());
      try {
        await deletePendingFn(pending.id);
      } catch (deleteError) {
        console.error('[recorder] could not delete an unstarted pending recording', deleteError);
      }
      setState({ status: 'idle', error: `Could not start recording: ${messageOf(error)}` });
      return;
    }

    stream = nextStream;
    mediaRecorder = nextRecorder;

    const capturedLink: RecorderLink = { sessionId: link.sessionId, noteId: link.noteId };
    setState({ status: 'recording', startedAt, elapsedMs: 0, link: capturedLink, error: null });

    const tickMs = deps.tickMs ?? 250;
    tickHandle = setIntervalFn(() => {
      setState({ elapsedMs: nowFn() - startedAt });
    }, tickMs);
  }

  /**
   * I3: persists one chunk, with one retry for `seq 0` specifically - it
   * carries the container's EBML header, Segment info and Tracks, so
   * losing it makes the whole recording undecodable regardless of how many
   * later chunks survive, unlike any other chunk (a hole elsewhere in the
   * sequence is a gap storage's own `stitchRecordingChunks` already
   * tolerates). A28: a failure that survives the retry is reported through
   * `state.warning` - never fatal, the recording keeps going - so the
   * owner can react (e.g. by ending and resuming the session) while the
   * lecture is still happening, rather than discovering the loss only when
   * playback or transcription fails later.
   */
  function appendChunkWithRetry(id: string, seq: number, blob: Blob): Promise<void> {
    const attempt = () => appendChunkFn(id, seq, blob);
    const reportFailure = (error: unknown) => {
      console.error(`[recorder] failed to persist chunk ${seq}`, error);
      setState({
        warning: `Could not save part of the recording (chunk ${seq}): ${messageOf(error)}`,
      });
    };
    if (seq === 0) {
      return attempt().catch(() => attempt().catch(reportFailure));
    }
    return attempt().catch(reportFailure);
  }

  async function stop(): Promise<RecordingRecord | null> {
    if (state.status === 'starting') {
      // start() is still awaiting one of its two pre-'recording' await
      // points (getUserMedia, or createPendingFn - I1). Record the
      // request; start() checks it again after each one and aborts
      // (tracks stopped, any pending row deleted, back to idle) instead of
      // silently proceeding to publish 'recording' with the mic still live.
      stopRequested = true;
      return null;
    }
    if (state.status !== 'recording') return null;
    setState({ status: 'stopping' });
    return new Promise<RecordingRecord | null>((resolve) => {
      stopWaiters.push(resolve);
      mediaRecorder?.stop();
    });
  }

  function clearError(): void {
    if (state.error !== null) setState({ error: null });
  }

  return {
    getState() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    start,
    stop,
    clearError,
    getActiveRecordingId() {
      return recordingId;
    },
  };
}
