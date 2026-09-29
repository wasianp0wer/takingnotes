// Captures microphone audio with MediaRecorder and saves it linked to the
// note/session that was active when recording started (A10: that link is
// null when there was no active note). Runs entirely in memory - chunks are
// buffered as they arrive and only ever touch storage once, in `save()`, so
// a recording never exists half-written.
import { recordingTitle } from '@/audio/format';
import { createRecording } from '@/storage/recordings';
import type { CreateRecordingInput } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';

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

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: MediaRecorderCtor;
  save?: (input: CreateRecordingInput, audio: Blob) => Promise<RecordingRecord>;
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
}

const IDLE_STATE: RecorderState = {
  status: 'idle',
  startedAt: null,
  elapsedMs: 0,
  link: null,
  error: null,
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

export function createRecorder(deps: RecorderDeps = {}): Recorder {
  let state: RecorderState = IDLE_STATE;
  const listeners = new Set<() => void>();

  let mediaRecorder: MediaRecorderLike | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let chosenType: string | undefined;
  let tickHandle: unknown = null;
  let stopWaiters: Array<(result: RecordingRecord | null) => void> = [];

  // Resolved fresh in start() (defaults are lazy - not evaluated until a
  // recording actually begins - so definite assignment here, not a default
  // value, which would resolve them at createRecorder() time instead), then
  // held here so finish() - which can run long after start() returns, or
  // from a spontaneous onstop - uses the same instances throughout one
  // recording rather than re-resolving against possibly-changed globals.
  let saveFn!: (input: CreateRecordingInput, audio: Blob) => Promise<RecordingRecord>;
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
   * recording is saved (or dropped as empty) the same way regardless of why
   * MediaRecorder stopped.
   */
  async function finish(): Promise<RecordingRecord | null> {
    stopTick();
    const startedAt = state.startedAt;
    const link = state.link;
    const endedAt = nowFn();
    stopStream();

    const type = mediaRecorder?.mimeType || chosenType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    mediaRecorder = null;
    stream = null;

    let result: RecordingRecord | null = null;
    if (blob.size === 0 || startedAt === null) {
      setState({ ...IDLE_STATE, error: 'Nothing was recorded' });
    } else {
      try {
        const record = await saveFn(
          {
            title: recordingTitle(startedAt),
            durationMs: endedAt - startedAt,
            sessionId: link?.sessionId ?? null,
            noteId: link?.noteId ?? null,
            startedAt,
            endedAt,
            mimeType: blob.type,
          },
          blob,
        );
        setState({ ...IDLE_STATE });
        result = record;
        try {
          deps.onSaved?.(record);
        } catch (error) {
          console.error('[recorder] onSaved threw', error);
        }
      } catch (error) {
        setState({ ...IDLE_STATE, error: `Could not save the recording: ${messageOf(error)}` });
      }
    }

    const waiters = stopWaiters;
    stopWaiters = [];
    for (const waiter of waiters) waiter(result);
    return result;
  }

  async function start(link: RecorderLink): Promise<void> {
    if (state.status !== 'idle') return;
    setState({ error: null, status: 'starting' });

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
    saveFn = deps.save ?? createRecording;
    nowFn = deps.now ?? Date.now;
    setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle as number));

    chunks = [];
    nextRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    nextRecorder.onstop = () => {
      void finish();
    };
    nextRecorder.onerror = () => {
      if (nextRecorder.state === 'recording') nextRecorder.stop();
    };

    stream = nextStream;
    mediaRecorder = nextRecorder;

    const timesliceMs = deps.timesliceMs ?? 1000;
    nextRecorder.start(timesliceMs);

    const startedAt = nowFn();
    const capturedLink: RecorderLink = { sessionId: link.sessionId, noteId: link.noteId };
    setState({ status: 'recording', startedAt, elapsedMs: 0, link: capturedLink, error: null });

    const tickMs = deps.tickMs ?? 250;
    tickHandle = setIntervalFn(() => {
      setState({ elapsedMs: nowFn() - startedAt });
    }, tickMs);
  }

  async function stop(): Promise<RecordingRecord | null> {
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
  };
}
