import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recordingTitle } from '@/audio/format';
import type { MediaRecorderLike, RecorderDeps } from '@/audio/recorder';
import { createRecorder } from '@/audio/recorder';
import type { CreateRecordingInput } from '@/storage/recordings';
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

interface Harness {
  recorder: ReturnType<typeof createRecorder>;
  save: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  tick: () => void;
  advance: (ms: number) => void;
  lastMediaRecorder: () => FakeMediaRecorder;
  intervalCallbacks: (() => void)[];
}

function makeHarness(overrides: Partial<RecorderDeps> = {}, stream = fakeStream()): Harness {
  let t = 1_000;
  const now = () => t;
  const intervalCallbacks: (() => void)[] = [];
  const save = vi.fn(
    async (input: CreateRecordingInput, blob: Blob): Promise<RecordingRecord> =>
      ({
        id: 'r1',
        sessionId: input.sessionId ?? null,
        noteId: input.noteId ?? null,
        title: input.title,
        startedAt: input.startedAt ?? 0,
        endedAt: input.endedAt ?? null,
        durationMs: input.durationMs,
        mimeType: input.mimeType ?? blob.type,
        byteLength: blob.size,
        transcript: null,
      }) as RecordingRecord,
  );
  const onSaved = vi.fn();
  const getUserMedia = vi.fn(async () => stream);

  const recorder = createRecorder({
    getUserMedia,
    MediaRecorder: FakeMediaRecorder as unknown as RecorderDeps['MediaRecorder'],
    save,
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
    save,
    onSaved,
    getUserMedia,
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

  it('stops, saves the recorded chunks, stops tracks, clears the tick, and goes idle', async () => {
    const track = new FakeTrack();
    const stream = fakeStream([track]);
    const { recorder, save, onSaved, advance, intervalCallbacks } = makeHarness({}, stream);

    await recorder.start({ sessionId: 's1', noteId: 'n1' });
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([1, 2]);
    fake.emit([3]);
    advance(5_000);

    const result = await recorder.stop();

    expect(save).toHaveBeenCalledTimes(1);
    const [input, blob] = save.mock.calls[0] as [CreateRecordingInput, Blob];
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(input.title).toBe(recordingTitle(1_000));
    expect(input.startedAt).toBe(1_000);
    expect(input.endedAt).toBe(6_000);
    expect(input.durationMs).toBe(5_000);
    expect(track.stopped).toBe(true);

    const state = recorder.getState();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(result);

    // The tick was cleared: no interval callback still ticks elapsedMs.
    const before = recorder.getState();
    intervalCallbacks.forEach((fn) => fn());
    expect(recorder.getState()).toBe(before);
  });

  it('captures the link at start, immune to later mutation of the caller object', async () => {
    const { recorder, save } = makeHarness();
    const link = { sessionId: 's1', noteId: 'n1' };

    await recorder.start(link);
    link.sessionId = 'mutated';
    link.noteId = 'mutated';
    FakeMediaRecorder.instances[0].emit([1]);
    await recorder.stop();

    expect(save.mock.calls[0][0]).toMatchObject({ sessionId: 's1', noteId: 'n1' });

    save.mockClear();
    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[1].emit([1]);
    await recorder.stop();

    expect(save.mock.calls[0][0]).toMatchObject({ sessionId: null, noteId: null });
  });

  it('reports mic denial without saving', async () => {
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { recorder, save } = makeHarness({ getUserMedia: vi.fn(async () => Promise.reject(error)) });

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe(
      'Microphone access was denied. Allow it in the browser to record.',
    );
    expect(save).not.toHaveBeenCalled();
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

  it('reports nothing recorded when no chunks arrived, and still stops tracks', async () => {
    const track = new FakeTrack();
    const { recorder, save } = makeHarness({}, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    const result = await recorder.stop();

    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Nothing was recorded');
    expect(track.stopped).toBe(true);
  });

  it('saves on a spontaneous stop (mic unplugged) with no explicit stop() call', async () => {
    const track = new FakeTrack();
    const { recorder, save } = makeHarness({}, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    const fake = FakeMediaRecorder.instances[0];
    fake.emit([9]);

    // Nothing called stop() - the fake's onstop fires on its own, as it would
    // if the OS tore the track down under MediaRecorder.
    fake.state = 'inactive';
    fake.onstop?.();
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    expect(recorder.getState().status).toBe('idle');
  });

  it('reports a save failure without losing track cleanup; clearError clears it', async () => {
    const track = new FakeTrack();
    const save = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { recorder } = makeHarness({ save }, fakeStream([track]));

    await recorder.start({ sessionId: null, noteId: null });
    FakeMediaRecorder.instances[0].emit([1]);
    const result = await recorder.stop();

    expect(result).toBeNull();
    expect(recorder.getState().error).toBe('Could not save the recording: disk full');
    expect(track.stopped).toBe(true);

    recorder.clearError();
    expect(recorder.getState().error).toBeNull();
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
    const { recorder, save } = makeHarness({ getUserMedia });

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
    expect(save).not.toHaveBeenCalled();
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

  it('reports a mediaRecorder.start() failure, stopping tracks and returning to idle', async () => {
    class ThrowingMediaRecorder extends FakeMediaRecorder {
      start(): void {
        throw new Error('boom');
      }
    }
    const track = new FakeTrack();
    const { recorder, save } = makeHarness(
      { MediaRecorder: ThrowingMediaRecorder as unknown as RecorderDeps['MediaRecorder'] },
      fakeStream([track]),
    );

    await recorder.start({ sessionId: null, noteId: null });

    expect(recorder.getState().status).toBe('idle');
    expect(recorder.getState().error).toBe('Could not start recording: boom');
    expect(track.stopped).toBe(true);
    expect(save).not.toHaveBeenCalled();
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
});
