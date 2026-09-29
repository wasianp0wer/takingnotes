import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranscriptionQueue } from '@/audio/transcriptionQueue';
import type { TranscriptionQueueState } from '@/audio/transcriptionQueue';
import type {
  AudioTranscriber,
  AudioTranscriptionResult,
  TranscribeOptions,
} from '@/audio/types';
import { openNotesDb } from '@/storage/db';
import {
  createRecording,
  deleteRecording,
  getRecording,
  setRecordingTranscript,
} from '@/storage/recordings';
import type { AudioTranscriptRecord, TranscriptStatus } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const MODEL = 'Xenova/whisper-base.en';
const NOW = 1000;

beforeEach(resetDatabase);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const audio = () => new Blob([new Uint8Array([1])], { type: 'audio/webm' });

async function makeRecording(startedAt = 1, title = 't'): Promise<string> {
  const recording = await createRecording({ title, durationMs: 1_000, startedAt }, audio());
  return recording.id;
}

function transcript(status: TranscriptStatus): AudioTranscriptRecord {
  return {
    text: status === 'done' ? 'old' : '',
    segments: [],
    model: MODEL,
    language: null,
    status,
    error: status === 'failed' ? 'boom' : null,
    updatedAt: 1,
  };
}

const RESULT: AudioTranscriptionResult = {
  text: 'hello',
  segments: [{ startMs: 0, endMs: 500, text: 'hello' }],
  language: 'en',
};

const DONE: AudioTranscriptRecord = {
  text: 'hello',
  segments: [{ startMs: 0, endMs: 500, text: 'hello' }],
  model: MODEL,
  language: 'en',
  status: 'done',
  error: null,
  updatedAt: NOW,
};

const PENDING: AudioTranscriptRecord = {
  text: '',
  segments: [],
  model: MODEL,
  language: null,
  status: 'pending',
  error: null,
  updatedAt: NOW,
};

type TranscribeBody = (pcm: Float32Array, opts: TranscribeOptions) => Promise<AudioTranscriptionResult>;

const defaultTranscribe: TranscribeBody = async (_pcm, opts) => {
  opts.onProgress?.(0.5, 'loading');
  return { ...RESULT, segments: RESULT.segments.map((s) => ({ ...s })) };
};

function makeQueue(
  overrides: {
    transcribe?: TranscribeBody;
    decode?: (input: Blob) => Promise<Float32Array>;
    getModel?: () => Promise<string>;
  } = {},
) {
  const transcribe = vi.fn(overrides.transcribe ?? defaultTranscribe);
  const decode = vi.fn(overrides.decode ?? (async () => new Float32Array(16)));
  const getModel = vi.fn(overrides.getModel ?? (async () => MODEL));
  const transcriber: AudioTranscriber = { transcribe };
  const queue = createTranscriptionQueue({ transcriber, decode, getModel, now: () => NOW });
  return { queue, transcribe, decode, getModel };
}

/**
 * `getModel` is called twice per recording (once for the pending write, once at
 * job start), so parking its second call parks the job *before* it writes
 * `running` - the only deterministic way to observe the persisted `pending`.
 */
function gateAtJobStart(model: () => string) {
  const gate = deferred();
  let calls = 0;
  const getModel = async () => {
    calls += 1;
    if (calls >= 2) await gate.promise;
    return model();
  };
  return { gate, getModel };
}

async function statusOf(id: string): Promise<TranscriptStatus | undefined> {
  return (await getRecording(id))?.transcript?.status;
}

describe('transcription queue', () => {
  it('persists pending on enqueue, then done with the transcription result', async () => {
    const id = await makeRecording();
    const { gate, getModel } = gateAtJobStart(() => MODEL);
    const { queue, transcribe } = makeQueue({ getModel });

    await queue.enqueue(id);

    expect((await getRecording(id))!.transcript).toEqual(PENDING);
    expect(transcribe).not.toHaveBeenCalled();

    gate.resolve();
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript).toEqual(DONE);
  });

  it('persists running while the transcriber is working', async () => {
    const id = await makeRecording();
    let seen: TranscriptStatus | undefined;
    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        seen = await statusOf(id);
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(seen).toBe('running');
    expect(await statusOf(id)).toBe('done');
  });

  it('records a transcriber rejection as failed', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({
      transcribe: async () => {
        throw new Error('model exploded');
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript).toEqual({
      text: '',
      segments: [],
      model: MODEL,
      language: null,
      status: 'failed',
      error: 'model exploded',
      updatedAt: NOW,
    });
  });

  it('records a decode rejection as failed', async () => {
    const id = await makeRecording();
    const { queue, transcribe } = makeQueue({
      decode: async () => {
        throw new Error('Could not decode the recording: x');
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript).toMatchObject({
      status: 'failed',
      error: 'Could not decode the recording: x',
      text: '',
      segments: [],
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('records missing audio bytes as failed', async () => {
    const id = await makeRecording();
    const db = await openNotesDb();
    await db.delete('recordingAudio', id);
    const { queue, decode, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript).toMatchObject({
      status: 'failed',
      error: 'Recording audio is missing',
    });
    expect(decode).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('skips a recording deleted before its job starts and keeps draining', async () => {
    const gone = await makeRecording(1);
    const live = await makeRecording(2);
    await deleteRecording(gone);
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(gone);
    await queue.enqueue(live);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(await getRecording(gone)).toBeUndefined();
    expect(await statusOf(live)).toBe('done');
  });

  it('swallows the not-found write for a recording deleted mid-job and runs the next', async () => {
    const doomed = await makeRecording(1);
    const next = await makeRecording(2);
    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        if ((await statusOf(doomed)) === 'running') {
          await deleteRecording(doomed);
        }
        return defaultTranscribe(pcm, opts);
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await queue.enqueue(doomed);
    await queue.enqueue(next);
    await queue.whenIdle();

    expect(await getRecording(doomed)).toBeUndefined();
    expect(await statusOf(next)).toBe('done');
    // A lost race with a delete is not a fault: nothing is logged.
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('logs any other write failure and keeps draining', async () => {
    const unstorable = await makeRecording(1);
    const next = await makeRecording(2);
    let calls = 0;
    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        calls += 1;
        const result = await defaultTranscribe(pcm, opts);
        if (calls === 1) {
          // A function cannot be structured-cloned into IndexedDB, so the `done`
          // write rejects with something other than `Recording not found`.
          return { ...result, segments: [{ ...result.segments[0], hook: () => {} }] as never };
        }
        return result;
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await queue.enqueue(unstorable);
    await queue.enqueue(next);
    await queue.whenIdle();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(await statusOf(unstorable)).toBe('running');
    expect(await statusOf(next)).toBe('done');
    logged.mockRestore();
  });

  it('logs a job that fails before it can record a status and keeps draining', async () => {
    const broken = await makeRecording(1);
    const next = await makeRecording(2);
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      getModel: async () => {
        calls += 1;
        // Call 1 is the pending write, call 2 is the job start - a failure there
        // lands before the job has any status it could mark failed.
        if (calls === 2) throw new Error('settings read failed');
        return MODEL;
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await queue.enqueue(broken);
    await queue.whenIdle();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(await statusOf(broken)).toBe('pending');
    expect(transcribe).not.toHaveBeenCalled();

    // The loop survived it and still takes work.
    await queue.enqueue(next);
    await queue.whenIdle();

    expect(await statusOf(next)).toBe('done');
    expect(transcribe).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('logs a throwing listener and carries on', async () => {
    const id = await makeRecording(1);
    const next = await makeRecording(2);
    const { queue } = makeQueue();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = queue.subscribe(() => {
      throw new Error('render exploded');
    });
    const stopChanges = queue.subscribeChanges(() => {
      throw new Error('change handler exploded');
    });

    await queue.enqueue(id);
    await queue.whenIdle();
    stop();
    stopChanges();

    expect(logged).toHaveBeenCalled();
    expect(await statusOf(id)).toBe('done');

    await queue.enqueue(next);
    await queue.whenIdle();

    expect(await statusOf(next)).toBe('done');
    logged.mockRestore();
  });

  it('does not strand a recording when the pending write cannot read the model', async () => {
    const id = await makeRecording(1);
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      getModel: async () => {
        calls += 1;
        if (calls === 1) throw new Error('settings read failed');
        return MODEL;
      },
    });

    await expect(queue.enqueue(id)).rejects.toThrow('settings read failed');

    expect(queue.getState().queuedIds).toEqual([]);
    expect((await getRecording(id))!.transcript).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    await expect(queue.whenIdle()).resolves.toBeUndefined();

    // The failed enqueue left nothing behind, so the id can still be queued.
    await queue.retry(id);
    await queue.whenIdle();

    expect(await statusOf(id)).toBe('done');
  });

  it('releases idle waiters when an enqueue fails before it is queued', async () => {
    const id = await makeRecording(1);
    const gate = deferred();
    const { queue } = makeQueue({
      getModel: async () => {
        await gate.promise;
        throw new Error('settings read failed');
      },
    });

    const failing = queue.enqueue(id);
    let settled = false;
    const idle = queue.whenIdle().then(() => {
      settled = true;
    });

    // The enqueue is accepted but not yet persisted: that is not idle.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(failing).rejects.toThrow('settings read failed');
    await idle;

    expect(settled).toBe(true);
  });

  it('never lets a slow pending write overwrite the status of a job already under way', async () => {
    const first = await makeRecording(1);
    const second = await makeRecording(2);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const slowModel = deferred();
    let modelCalls = 0;
    let transcribeCalls = 0;
    const { queue } = makeQueue({
      getModel: async () => {
        modelCalls += 1;
        // Call 3 is the pending write for `second`, enqueued while `first` is active.
        if (modelCalls === 3) await slowModel.promise;
        return MODEL;
      },
      transcribe: async (pcm, opts) => {
        transcribeCalls += 1;
        if (transcribeCalls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(first);
    await firstStarted.promise;

    // Enqueued, but its pending write is parked on `getModel`.
    const enqueueSecond = queue.enqueue(second);

    // Wait for the loop to go quiet after `first`; with the pending write published
    // to the loop too early, `second` would run here and be overwritten below.
    const drained = deferred();
    const stop = queue.subscribe(() => {
      const current = queue.getState();
      if (current.activeId === null && current.queuedIds.length === 0) drained.resolve();
    });
    releaseFirst.resolve();
    await drained.promise;
    stop();

    slowModel.resolve();
    await enqueueSecond;
    await queue.whenIdle();

    expect(await statusOf(first)).toBe('done');
    expect(await statusOf(second)).toBe('done');
    expect(transcribeCalls).toBe(2);
  });

  it('runs one transcription at a time and keeps the rest queued', async () => {
    const first = await makeRecording(1);
    const second = await makeRecording(2);
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      transcribe: async (pcm, opts) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(first);
    await queue.enqueue(second);
    await started.promise;

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(queue.getState().activeId).toBe(first);
    expect(queue.getState().queuedIds).toEqual([second]);

    gate.resolve();
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await statusOf(first)).toBe('done');
    expect(await statusOf(second)).toBe('done');
  });

  it('resume queues null, pending and running transcripts oldest first', async () => {
    const untouched = await makeRecording(1, 'null');
    const pending = await makeRecording(2, 'pending');
    const running = await makeRecording(3, 'running');
    const done = await makeRecording(4, 'done');
    const failed = await makeRecording(5, 'failed');
    await setRecordingTranscript(pending, transcript('pending'));
    await setRecordingTranscript(running, transcript('running'));
    await setRecordingTranscript(done, transcript('done'));
    await setRecordingTranscript(failed, transcript('failed'));

    const order: (string | null)[] = [];
    const queueRef: { current?: ReturnType<typeof makeQueue>['queue'] } = {};
    const { queue, transcribe } = makeQueue({
      decode: async () => {
        order.push(queueRef.current!.getState().activeId);
        return new Float32Array(16);
      },
    });
    queueRef.current = queue;

    await queue.resume();
    await queue.whenIdle();

    expect(order).toEqual([untouched, pending, running]);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(await statusOf(done)).toBe('done');
    expect((await getRecording(done))!.transcript!.text).toBe('old');
    expect(await statusOf(failed)).toBe('failed');
  });

  it('retry transcribes a failed recording again', async () => {
    const id = await makeRecording();
    let calls = 0;
    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        calls += 1;
        if (calls === 1) throw new Error('model exploded');
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();
    expect(await statusOf(id)).toBe('failed');

    await queue.retry(id);
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript).toEqual(DONE);
  });

  it('ignores a duplicate enqueue of an active or queued recording', async () => {
    const active = await makeRecording(1);
    const waiting = await makeRecording(2);
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      transcribe: async (pcm, opts) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(active);
    await queue.enqueue(waiting);
    await started.promise;

    const changed: string[] = [];
    const stopChanges = queue.subscribeChanges((id) => changed.push(id));
    await queue.enqueue(active);
    await queue.enqueue(waiting);
    await queue.retry(waiting);

    expect(changed).toEqual([]);
    expect(queue.getState().queuedIds).toEqual([waiting]);

    gate.resolve();
    await queue.whenIdle();
    stopChanges();

    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('reports stage and progress to subscribers and resets when the job ends', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue();
    const states: TranscriptionQueueState[] = [];
    const changed: string[] = [];
    const stop = queue.subscribe(() => states.push(queue.getState()));
    const stopChanges = queue.subscribeChanges((changedId) => changed.push(changedId));

    await queue.enqueue(id);
    await queue.whenIdle();
    stop();
    stopChanges();

    expect(states).toContainEqual({
      activeId: id,
      stage: 'loading',
      progress: 0.5,
      queuedIds: [],
    });
    expect(states.at(-1)).toEqual({
      activeId: null,
      stage: null,
      progress: null,
      queuedIds: [],
    });
    expect(changed).toEqual([id, id, id]);

    const before = states.length;
    await queue.enqueue(await makeRecording(2));
    await queue.whenIdle();
    expect(states).toHaveLength(before);
  });

  it('re-reads the model at job start', async () => {
    const id = await makeRecording();
    let model = MODEL;
    const { gate, getModel } = gateAtJobStart(() => model);
    const { queue, transcribe } = makeQueue({ getModel });

    await queue.enqueue(id);
    expect((await getRecording(id))!.transcript!.model).toBe(MODEL);

    model = 'Xenova/whisper-small.en';
    gate.resolve();
    await queue.whenIdle();

    expect((await getRecording(id))!.transcript!.model).toBe('Xenova/whisper-small.en');
    expect(transcribe.mock.calls[0][1].model).toBe('Xenova/whisper-small.en');
  });

  it('keeps the same state object until something changes', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue();

    const idle = queue.getState();
    expect(queue.getState()).toBe(idle);
    expect(idle).toEqual({ activeId: null, stage: null, progress: null, queuedIds: [] });

    await queue.enqueue(id);
    const queued = queue.getState();
    expect(queued).not.toBe(idle);
    expect(queue.getState()).toBe(queued);

    await queue.whenIdle();
    const after = queue.getState();
    expect(after).toEqual(idle);
    expect(queue.getState()).toBe(after);
  });

  it('whenIdle resolves when nothing was ever enqueued', async () => {
    const { queue } = makeQueue();
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });

  it('whenIdle waits for work enqueued while it is already pending', async () => {
    const first = await makeRecording(1);
    const second = await makeRecording(2);
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      transcribe: async (pcm, opts) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(first);
    await started.promise;

    let settled = false;
    const idle = queue.whenIdle().then(() => {
      settled = true;
    });

    await queue.enqueue(second);
    expect(settled).toBe(false);

    gate.resolve();
    await idle;

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await statusOf(first)).toBe('done');
    expect(await statusOf(second)).toBe('done');
    expect(queue.getState().queuedIds).toEqual([]);
  });
});
