import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recordingTitle } from '@/audio/format';
import type { CreatePendingInput, MediaRecorderLike, RecorderDeps } from '@/audio/recorder';
import { createRecorder } from '@/audio/recorder';
import type { RecordingRecord } from '@/storage/types';

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream(tracks: FakeTrack[] = [new FakeTrack()]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

class FakeMediaRecorder implements MediaRecorderLike {
  static supported = new Set(['audio/webm;codecs=opus']);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.has(type);
  }

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice?: number;
  stream: MediaStream;
  options?: { mimeType?: string };

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.options = options;
    FakeMediaRecorder.instances.push(this);
  }

  get mimeType() {
    return this.options?.mimeType ?? '';
  }

  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }

  emit(bytes: number[]) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }

  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);
});

interface ChunkRow {
  seq: number;
  blob: Blob;
}

interface Harness {
  recorder: ReturnType<typeof createRecorder>;
  createPending: ReturnType<typeof vi.fn>;
  appendChunk: ReturnType<typeof vi.fn>;
  stitch: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  deletePending: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  chunksOf: (id: string) => ChunkRow[];
  tick: () => void;
  advance: (ms: number) => void;
  lastMediaRecorder: () => FakeMediaRecorder;
  intervalCallbacks: (() => void)[];
}

/**
 * The default `stitch` mock concatenates whatever `appendChunk` actually
 * recorded, in `seq` order - not a canned blob - so a bug that persists
 * chunks out of order or drops one shows up in the stitched bytes a test
 * reads back, the same way the real `stitchRecordingChunks` would catch it.
 */
function makeHarness(overrides: Partial<RecorderDeps> = {}, stream = fakeStream()): Harness {
  let t = 1_000;
  const now = () => t;
  const intervalCallbacks: (() => void)[] = [];
  const store = new Map<string, ChunkRow[]>();
  let nextId = 0;

  const createPending = vi.fn(async (input: CreatePendingInput): Promise<RecordingRecord> => {
    const id = `r${++nextId}`;
    store.set(id, []);
    return {
      id,
      sessionId: input.sessionId,
      noteId: input.noteId,
      title: input.title,
      startedAt: input.startedAt,
      endedAt: null,
      durationMs: 0,
      mimeType: input.mimeType,
      byteLength: 0,
      transcript: null,
    };
  });
  const appendChunk = vi.fn(async (id: string, seq: number, blob: Blob) => {
    store.get(id)?.push({ seq, blob });
  });
  const stitch = vi.fn(async (id: string): Promise<Blob | null> => {
    const rows = store.get(id) ?? [];
    if (rows.length === 0) return null;
    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
    const type = ordered.find((r) => r.blob.type !== '')?.blob.type ?? '';
    return new Blob(ordered.map((r) => r.blob), { type });
  });
  const finalize = vi.fn(
    async (
      id: string,
      audio: Blob,
      patch: { endedAt: number; durationMs: number; mimeType?: string },
    ): Promise<RecordingRecord> => ({
      id,
      sessionId: null,
      noteId: null,
      title: 'x',
      startedAt: 0,
      endedAt: patch.endedAt,
      durationMs: patch.durationMs,
      mimeType: patch.mimeType ?? audio.type,
      byteLength: audio.size,
      transcript: null,
    }),
  );
  const deletePending = vi.fn(async (id: string) => {
    store.delete(id);
  });
  const onSaved = vi.fn();
  const getUserMedia = vi.fn(async () => stream);

  const recorder = createRecorder({
    getUserMedia,
    MediaRecorder: FakeMediaRecorder as unknown as RecorderDeps['MediaRecorder'],
    createPending,
    appendChunk,
    stitch,
    finalize,
    deletePending,
    onSaved,
    now,
    setInterval: (fn) => {
      intervalCallbacks.push(fn);
      return intervalCallbacks.length;
    },
    clearInterval: (handle) => {
      const index = (handle as number) - 1;
      intervalCallbacks[index] = () => {};
    },
    ...overrides,
  });

  return {
    recorder,
    createPending,
    appendChunk,
    stitch,
    finalize,
    deletePending,
    onSaved,
    getUserMedia,
    chunksOf: (id) => store.get(id) ?? [],
    tick: () => intervalCallbacks.forEach((fn) => fn()),
    advance: (ms: number) => {
      t += ms;
    },
    lastMediaRecorder: () => FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1],
    intervalCallbacks,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createRecorder', () => {
  it('starts recording: requests the mic, picks the preferred mime type, starts with timeslice 1000', async () => {
    const { recorder, getUserMedia, lastMediaRecorder } = makeHarness();

    await recorder.start({ sessionId: 's1', noteId: 'n1' });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    const fake = lastMediaRecorder();
    expect(fake.options?.mimeType).toBe('audio/webm;codecs=opus');
    expect(fake.timeslice).toBe(1000);

    const state = recorder.getState();
    expect(state.status).toBe('recording');
    expect(state.startedAt).toBe(1_000);
    expect(state.link).toEqual({ sessionId: 's1', noteId: 'n1' });
  });

  it('falls back through the preferred mime types', async () => {
    FakeMediaRecorder.supported = new Set(['audio/mp4']);
    const { recorder, lastMediaRecorder } = makeHarness();

    await recorder.start({ sessionId: null, noteId: null });

    expect(lastMediaRecorder().options?.mimeType).toBe('audio/mp4');
  });

  it('constructs with no options when nothing is supported', async () => {
    FakeMediaRecorder.supported = new Set();
    const { recorder, lastMediaRecorder } = makeHarness();

    await recorder.start({ sessionId: null, noteId: null });

    expect(lastMediaRecorder().options).toBeUndefined();
  });

  it('tracks elapsed time on the tick and notifies subscribers', async () => {
    const { recorder, advance, tick } = makeHarness();
    const listener = vi.fn();
    recorder.subscribe(listener);

    await recorder.start({ sessionId: null, noteId: null });
    listener.mockClear();

    advance(2_500);
    tick();

    expect(recorder.getState().elapsedMs).toBe(2_500);
    expect(listener).toHaveBeenCalled();
  });

  // --- K5/C2: the pending record exists, and MediaRecorder.start() is ----
  // --- called, only after - no window where a chunk can be dropped -------

  it('K5: the pending record is created with the right input before the MediaRecorder starts', async () => {
    const { recorder, createPending, appendChunk } = makeHarness();

    await recorder.start({ sessionId: 's1', noteId: 'n1' });

    expect(createPending).toHaveBeenCalledTimes(1);
    const input = createPending.mock.calls[0][0] as CreatePendingInput;
    expect(input).toMatchObject({
      sessionId: 's1',
      noteId: 'n1',
      startedAt: 1_000,
      mimeType: 'audio/webm;codecs=opus',
      title: recordingTitle(1_000),
    });
    expect(appendChunk).not.toHaveBeenCalled();
  });

  it('C2: MediaRecorder.start() is not called until createPending resolves, so no window exists where a chunk can be dropped unhandled', async () => {
    let resolveCreatePending!: () => void;
    const createPending = vi.fn(
      (input: CreatePendingInput) =>
        new Promise<RecordingRecord>((resolve) => {
          resolveCreatePending = () =>
            resolve({
              id: 'r1',
              sessionId: input.sessionId,
              noteId: input.noteId,
              title: input.title,
              startedAt: input.startedAt,
              endedAt: null,
              durationMs: 0,
              mimeType: input.mimeType,
              byteLength: 0,
              transcript: null,
            });
        }),
    );
    const { recorder, appendChunk } = makeHarness({ createPending });

    const startPromise = recorder.start({ sessionId: 's1', noteId: 'n1' });
    await flush();

    const fake = FakeMediaRecorder.instances[0];
    expect(fake).toBeDefined();
    // The real MediaRecorder.start() has not been called yet - this is the
    // structural proof that no chunk can possibly arrive during the
    // createPending await, not merely "none happened to arrive in this
    // test run".
    expect(fake.state).not.toBe('recording');

    // Emit a chunk while createPending is still pending anyway: there is no
    // handler attached yet (ondataavailable is still null), so this proves
    // the old window - start() first, handlers attached only once
    // createPending resolved - is gone, not just narrowed. A real
    // MediaRecorder could not emit here at all, since it was never started.
    fake.emit([99]);
    expect(appendChunk).not.toHaveBeenCalled();

    resolveCreatePending();
    await startPromise;

    expect(fake.state).toBe('recording');
    expect(createPending).toHaveBeenCalledTimes(1);

    // Now that start() has actually run and handlers are attached, a real
    // chunk is captured normally, as seq 0 - proving the fixture itself
    // (not just the harness) is live.
    fake.emit([1, 2, 3]);
    await flush();
    expect(appendChunk).toHaveBeenCalledTimes(1);
    expect(appendChunk.mock.calls[0][0]).toBe('r1');
    expect(appendChunk.mock.calls[0][1]).toBe(0);
  });

  // --- K4: chunks persist as they arrive, in order ------------------------

  it('K4: persists each chunk with a correct, distinct monotonic seq as it arrives', async () => {
    const { recorder, appendChunk, chunksOf } = makeHarness();

    await recorder.start({ sessionId: null, noteId: null });
    const id = 'r1';
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([10]);
    fake.emit([20]);
    fake.emit([30]);
    await flush();

    // Three real calls, not the same seq repeated - a bug that always wrote
    // seq 0 would collapse these into one row and this assertion would fail.
    expect(appendChunk).toHaveBeenCalledTimes(3);
    expect(appendChunk.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    expect(appendChunk.mock.calls.every((c) => c[0] === id)).toBe(true);

    const rows = chunksOf(id as string);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it('a zero-byte dataavailable event is not persisted as a chunk', async () => {
    const { recorder, appendChunk } = makeHarness();

    await recorder.start({ sessionId: null, noteId: null });
    const fake = FakeMediaRecorder.instances[0];
    fake.ondataavailable?.({ data: new Blob([], { type: fake.mimeType }) });
    fake.emit([1]);
    await flush();

    expect(appendChunk).toHaveBeenCalledTimes(1);
    expect(appendChunk.mock.calls[0][1]).toBe(0);
  });

  // --- I3: seq 0 (the container header) is retried; a lost chunk warns ---
  // --- (A28: reported, never fatal), the recording keeps going -----------

  it('I3: seq 0 is retried once and silently succeeds when the retry lands', async () => {
    let calls = 0;
    const appendChunk = vi.fn(async (_id: string, seq: number) => {
      calls += 1;
      if (seq === 0 && calls === 1) throw new Error('transient');
    });
    const { recorder } = makeHarness({ appendChunk });

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1, 2, 3]);
    await flush();

    expect(appendChunk).toHaveBeenCalledTimes(2);
    expect(appendChunk.mock.calls[0][1]).toBe(0);
    expect(appendChunk.mock.calls[1][1]).toBe(0);
    expect(recorder.getState().warning).toBeNull();
    expect(recorder.getState().status).toBe('recording');
  });

  it('I3: seq 0 failing twice (initial attempt plus the one retry) surfaces a non-fatal warning; recording continues', async () => {
    const appendChunk = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { recorder } = makeHarness({ appendChunk });

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1, 2, 3]);
    await flush();

    expect(appendChunk).toHaveBeenCalledTimes(2);
    expect(recorder.getState().warning).toMatch(/chunk 0/);
    expect(recorder.getState().warning).toMatch(/disk full/);
    // A28: never fatal - the recording is still live.
    expect(recorder.getState().status).toBe('recording');
  });

  it('I3: a non-zero chunk failure is not retried, but still surfaces a warning, and the recording continues', async () => {
    const appendChunk = vi.fn(async (_id: string, seq: number) => {
      if (seq === 1) throw new Error('disk full');
    });
    const { recorder } = makeHarness({ appendChunk });

    await recorder.start({ sessionId: null, noteId: null });
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([1]); // seq 0, succeeds
    fake.emit([2]); // seq 1, fails
    await flush();

    // No retry for a non-zero seq: exactly one call per emitted chunk.
    expect(appendChunk).toHaveBeenCalledTimes(2);
    expect(recorder.getState().warning).toMatch(/chunk 1/);
    expect(recorder.getState().status).toBe('recording');
  });

  it('I3: a new recording clears a stale warning from the previous one', async () => {
    const appendChunk = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { recorder } = makeHarness({ appendChunk });

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);
    await flush();
    expect(recorder.getState().warning).not.toBeNull();

    await recorder.stop();
    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().warning).toBeNull();
  });

  // --- K6: stop() awaits every append, stitches, then finalizes atomically

  it('K6: stop() awaits in-flight chunk appends before stitching', async () => {
    let resolveAppend!: () => void;
    const slowAppend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const { recorder, stitch } = makeHarness({ appendChunk: slowAppend });

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);

    const stopPromise = recorder.stop();
    await flush();
    // The append from `emit` above is still pending - stitch must not have
    // run yet, or this test could not tell "awaited" apart from "didn't".
    expect(stitch).not.toHaveBeenCalled();

    resolveAppend();
    await stopPromise;

    expect(stitch).toHaveBeenCalledTimes(1);
  });

  it('K6: stop() stitches, then finalizes atomically with the derived patch; onSaved fires with the result', async () => {
    const track = new FakeTrack();
    const stream = fakeStream([track]);
    const { recorder, finalize, onSaved, stitch, advance } = makeHarness({}, stream);

    await recorder.start({ sessionId: 's1', noteId: 'n1' });
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([1, 2]);
    fake.emit([3]);
    advance(5_000);

    const result = await recorder.stop();

    expect(stitch).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    const [id, audio, patch] = finalize.mock.calls[0] as [string, Blob, { endedAt: number; durationMs: number; mimeType?: string }];
    expect(id).toBe('r1');
    expect(audio.size).toBe(3);
    expect(patch.endedAt).toBe(6_000);
    expect(patch.durationMs).toBe(5_000);
    expect(patch.mimeType).toBe('audio/webm;codecs=opus');
    expect(track.stopped).toBe(true);

    const state = recorder.getState();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(result);
  });

  it('K7 precondition: no chunks at all -> stitch returns null, the pending row is deleted, finalize is never called', async () => {
    const track = new FakeTrack();
    const { recorder, finalize, deletePending } = makeHarness({}, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    const result = await recorder.stop();

    expect(result).toBeNull();
    expect(finalize).not.toHaveBeenCalled();
    expect(deletePending).toHaveBeenCalledWith('r1');
    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Nothing was recorded');
    expect(track.stopped).toBe(true);
  });

  it('a finalize failure leaves the pending row and its chunks untouched for later recovery; clearError clears it, tracks stay stopped', async () => {
    const track = new FakeTrack();
    const finalize = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { recorder, deletePending } = makeHarness({ finalize }, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);
    const result = await recorder.stop();

    expect(result).toBeNull();
    expect(recorder.getState().error).toBe('Could not save the recording: disk full');
    // Nothing was cleaned up on a finalize failure: no deletePending call at
    // all - the row and its chunks are left exactly as K7 recovery expects
    // to find them on the next launch.
    expect(deletePending).not.toHaveBeenCalled();
    expect(track.stopped).toBe(true);

    recorder.clearError();
    expect(recorder.getState().error).toBeNull();
  });

  it('I2: a stitch rejection does not hang stop() - the waiter always resolves and the row is left for recovery', async () => {
    const stitch = vi.fn(async () => {
      throw new Error('indexeddb blew up');
    });
    const { recorder, finalize, deletePending } = makeHarness({ stitch });

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);

    const result = await recorder.stop(); // must resolve, not hang forever

    expect(result).toBeNull();
    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Could not save the recording: indexeddb blew up');
    expect(finalize).not.toHaveBeenCalled();
    // Left for K7 recovery, not deleted - the chunks and the row survive.
    expect(deletePending).not.toHaveBeenCalled();

    // The recorder is not bricked in 'stopping': a new recording can start.
    await recorder.start({ sessionId: null, noteId: null });
    expect(recorder.getState().status).toBe('recording');
  });

  it('a createPending failure reports a start-time error and leaves no MediaRecorder running', async () => {
    const track = new FakeTrack();
    const createPending = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    const { recorder, appendChunk } = makeHarness({ createPending }, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Could not start recording: storage unavailable');
    expect(track.stopped).toBe(true);
    expect(appendChunk).not.toHaveBeenCalled();
  });

  it('captures the link at start, immune to later mutation of the caller object', async () => {
    const { recorder, createPending } = makeHarness();
    const link = { sessionId: 's1', noteId: 'n1' };

    await recorder.start(link);
    link.sessionId = 'mutated';
    link.noteId = 'mutated';
    FakeMediaRecorder.instances[0].emit([1]);
    await recorder.stop();

    expect(createPending.mock.calls[0][0]).toMatchObject({ sessionId: 's1', noteId: 'n1' });

    createPending.mockClear();
    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[1].emit([1]);
    await recorder.stop();

    expect(createPending.mock.calls[0][0]).toMatchObject({ sessionId: null, noteId: null });
  });

  it('reports mic denial without creating a pending record', async () => {
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { recorder, createPending } = makeHarness({ getUserMedia: vi.fn(async () => Promise.reject(error)) });

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe(
      'Microphone access was denied. Allow it in the browser to record.',
    );
    expect(createPending).not.toHaveBeenCalled();
  });

  it('reports no microphone found', async () => {
    const error = Object.assign(new Error('none'), { name: 'NotFoundError' });
    const { recorder } = makeHarness({ getUserMedia: vi.fn(async () => Promise.reject(error)) });

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().error).toBe('No microphone found');
  });

  it('reports unsupported when there is no MediaRecorder', async () => {
    const { recorder } = makeHarness({ MediaRecorder: undefined });

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Recording is not supported in this browser');
  });

  it('ignores a second start while recording; stop while idle resolves null', async () => {
    const { recorder, getUserMedia } = makeHarness();

    await recorder.start({ sessionId: null, noteId: null });
    await recorder.start({ sessionId: 'other', noteId: null });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(recorder.getState().link).toEqual({ sessionId: null, noteId: null });

    const idleRecorder = makeHarness().recorder;
    await expect(idleRecorder.stop()).resolves.toBeNull();
  });

  it('saves on a spontaneous stop (mic unplugged) with no explicit stop() call', async () => {
    const track = new FakeTrack();
    const { recorder, finalize } = makeHarness({}, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([9]);

    // Nothing called stop() - the fake's onstop fires on its own, as it would
    // if the OS tore the track down under MediaRecorder.
    fake.state = 'inactive';
    fake.onstop?.();
    await flush();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    expect(recorder.getState().status).toBe('idle');
  });

  it('stop() while starting (deferred getUserMedia) aborts before recording begins', async () => {
    const track = new FakeTrack();
    const pendingStream = fakeStream([track]);
    let resolveGetUserMedia!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    const { recorder, createPending } = makeHarness({ getUserMedia });

    const startPromise = recorder.start({ sessionId: null, noteId: null });
    expect(recorder.getState().status).toBe('starting');

    const stopResult = await recorder.stop();
    expect(stopResult).toBeNull();
    // getUserMedia has not resolved yet - still starting.
    expect(recorder.getState().status).toBe('starting');

    resolveGetUserMedia(pendingStream);
    await startPromise;

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBeNull();
    expect(track.stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(createPending).not.toHaveBeenCalled();
  });

  it('I1: stop() during the createPending await is not swallowed - the mic is released and the pending row is cleaned up', async () => {
    const track = new FakeTrack();
    let resolveCreatePending!: () => void;
    const createPending = vi.fn(
      (input: CreatePendingInput) =>
        new Promise<RecordingRecord>((resolve) => {
          resolveCreatePending = () =>
            resolve({
              id: 'r1',
              sessionId: input.sessionId,
              noteId: input.noteId,
              title: input.title,
              startedAt: input.startedAt,
              endedAt: null,
              durationMs: 0,
              mimeType: input.mimeType,
              byteLength: 0,
              transcript: null,
            });
        }),
    );
    const { recorder, deletePending } = makeHarness({ createPending }, fakeStream([track]));

    const startPromise = recorder.start({ sessionId: null, noteId: null });
    await flush();
    expect(recorder.getState().status).toBe('starting');

    const stopResult = await recorder.stop();
    expect(stopResult).toBeNull();
    // createPending has not resolved yet - still starting, same as the
    // getUserMedia-pending case above.
    expect(recorder.getState().status).toBe('starting');

    resolveCreatePending();
    await startPromise;

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBeNull();
    expect(track.stopped).toBe(true);
    expect(deletePending).toHaveBeenCalledWith('r1');
    // The MediaRecorder was constructed (its mimeType is needed for
    // createPending's input) but never started - the fix orders start()
    // strictly after createPending resolves and this check.
    expect(FakeMediaRecorder.instances[0]?.state).not.toBe('recording');
  });

  it('ignores a second start while starting (getUserMedia called once)', async () => {
    let resolveGetUserMedia!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    const { recorder } = makeHarness({ getUserMedia });

    const first = recorder.start({ sessionId: null, noteId: null });
    await recorder.start({ sessionId: 'other', noteId: null });

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    resolveGetUserMedia(fakeStream());
    await first;
  });

  it('reports unsupported when there is no getUserMedia', async () => {
    const { recorder } = makeHarness({ getUserMedia: undefined });

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Recording is not supported in this browser');
  });

  it('reports a mediaRecorder.start() failure, stopping tracks, deleting the now-orphaned pending row, and returning to idle', async () => {
    class ThrowingMediaRecorder extends FakeMediaRecorder {
      start(): void {
        throw new Error('boom');
      }
    }
    const track = new FakeTrack();
    const { recorder, createPending, deletePending } = makeHarness(
      { MediaRecorder: ThrowingMediaRecorder as unknown as RecorderDeps['MediaRecorder'] },
      fakeStream([track]),
    );

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Could not start recording: boom');
    expect(track.stopped).toBe(true);
    // C2 moved createPending before MediaRecorder.start(), so by the time
    // start() throws, the pending row already exists - and is immediately
    // cleaned up rather than left as an orphan for a future launch.
    expect(createPending).toHaveBeenCalledTimes(1);
    expect(deletePending).toHaveBeenCalledWith('r1');
  });

  it('getState() returns the same object reference until something changes', async () => {
    const { recorder, tick } = makeHarness();

    const before = recorder.getState();
    expect(recorder.getState()).toBe(before);

    await recorder.start({ sessionId: null, noteId: null });
    const afterStart = recorder.getState();
    expect(afterStart).not.toBe(before);
    expect(recorder.getState()).toBe(afterStart);

    tick();
    const afterTick = recorder.getState();
    expect(afterTick).not.toBe(afterStart);
    expect(recorder.getState()).toBe(afterTick);
  });

  it('stops every mic track and clears the tick on stop', async () => {
    const track = new FakeTrack();
    const { recorder, intervalCallbacks } = makeHarness({}, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);
    await recorder.stop();

    expect(track.stopped).toBe(true);
    const before = recorder.getState();
    intervalCallbacks.forEach((fn) => fn());
    expect(recorder.getState()).toBe(before);
  });
});
