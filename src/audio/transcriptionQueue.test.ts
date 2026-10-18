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
import type { AudioTranscriptRecord, AudioTranscriptStatus } from '@/storage/types';
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

/**
 * A *finished* recording (`endedAt` set) - which is what every one of these
 * tests means by "a recording", since they're about the transcript queue's
 * handling of transcript status, not about K5's in-progress rows. Since K5,
 * `createRecording` with no `endedAt` leaves it `null` ("still recording"),
 * which `listFinishedRecordings()` (what `resume()` now reads, ⚑ Wave 1
 * review finding #2) would never pick up - so this helper sets it explicitly
 * rather than relying on a default that would silently make every recording
 * in this file invisible to `resume()`.
 */
async function makeRecording(startedAt = 1, title = 't'): Promise<string> {
  const recording = await createRecording(
    { title, durationMs: 1_000, startedAt, endedAt: startedAt + 1_000 },
    audio(),
  );
  return recording.id;
}

/** The K5 in-progress shape: `endedAt: null`, still being recorded. */
async function makeUnfinishedRecording(startedAt = 1, title = 't'): Promise<string> {
  const recording = await createRecording(
    { title, durationMs: 0, startedAt, endedAt: null },
    new Blob([], { type: 'audio/webm' }),
  );
  return recording.id;
}

function transcript(status: AudioTranscriptStatus): AudioTranscriptRecord {
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
  // The default decode is 16 samples at 16 kHz, so the whole recording is one
  // 1 ms window and the finished cursor sits at its end.
  completedMs: 1,
  updatedAt: NOW,
};

const PENDING: AudioTranscriptRecord = {
  text: '',
  segments: [],
  model: MODEL,
  language: null,
  status: 'pending',
  error: null,
  completedMs: 0,
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
    stallTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => number;
    clearTimer?: (handle: number) => void;
  } = {},
) {
  const transcribe = vi.fn(overrides.transcribe ?? defaultTranscribe);
  const decode = vi.fn(overrides.decode ?? (async () => new Float32Array(16)));
  const getModel = vi.fn(overrides.getModel ?? (async () => MODEL));
  const transcriber: AudioTranscriber = { transcribe };
  const queue = createTranscriptionQueue({
    transcriber,
    decode,
    getModel,
    now: () => NOW,
    stallTimeoutMs: overrides.stallTimeoutMs,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { queue, transcribe, decode, getModel };
}

/**
 * Stand-in timers, so the stall watchdog is driven by the test rather than by a
 * real clock: `armed()` lists the handles still waiting and `fire()` runs them.
 */
function manualTimers() {
  const waiting = new Map<number, () => void>();
  const delays: number[] = [];
  let nextHandle = 1;
  return {
    delays,
    deps: {
      setTimer: (fn: () => void, ms: number) => {
        const handle = nextHandle;
        nextHandle += 1;
        delays.push(ms);
        waiting.set(handle, fn);
        return handle;
      },
      clearTimer: (handle: number) => {
        waiting.delete(handle);
      },
    },
    armed: (): number[] => [...waiting.keys()],
    fire: (): void => {
      const callbacks = [...waiting.values()];
      waiting.clear();
      for (const fn of callbacks) fn();
    },
  };
}

/**
 * A transcriber that answers nothing and reports no progress - a worker the
 * browser killed without an `error` event (spec F2-A11) - but honours `signal`
 * the way `createWhisperTranscriber` does; the abort path itself is tested there.
 */
function silentTranscribe(onCalled: () => void): TranscribeBody {
  return (_pcm, opts) =>
    new Promise<AudioTranscriptionResult>((_resolve, reject) => {
      opts.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Transcription aborted', 'AbortError')),
        { once: true },
      );
      onCalled();
    });
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

async function statusOf(id: string): Promise<AudioTranscriptStatus | undefined> {
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
    let seen: AudioTranscriptStatus | undefined;
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
      completedMs: 0,
      updatedAt: NOW,
    });
  });

  it('fails a stalled transcription and carries on with the next recording', async () => {
    const stalled = await makeRecording(1);
    const next = await makeRecording(2);
    const timers = manualTimers();
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      ...timers.deps,
      stallTimeoutMs: 25,
      transcribe: (pcm, opts) => {
        calls += 1;
        if (calls > 1) return defaultTranscribe(pcm, opts);
        // The job's watchdog is armed by now; fire it as a real timer would.
        return silentTranscribe(() => timers.fire())(pcm, opts);
      },
    });

    await queue.enqueue(stalled);
    await queue.enqueue(next);
    await queue.whenIdle();

    const record = (await getRecording(stalled))!.transcript!;
    expect(record.status).toBe('failed');
    expect(record.error).toContain('stalled');
    expect(await statusOf(next)).toBe('done');
    expect(transcribe).toHaveBeenCalledTimes(2);
    // The injected window is the one that was armed, not the production default.
    expect(timers.delays.every((ms) => ms === 25)).toBe(true);
    // Nothing is left armed to fire against a later job.
    expect(timers.armed()).toEqual([]);
  });

  it('re-arms the stall watchdog on every progress report', async () => {
    const id = await makeRecording();
    const timers = manualTimers();
    let armedDuringJob: number[] = [];
    let armedAtStart: number | undefined;
    const { queue } = makeQueue({
      ...timers.deps,
      transcribe: async (pcm, opts) => {
        armedAtStart = timers.armed()[0];
        opts.onProgress?.(0.1, 'loading');
        opts.onProgress?.(0.2, 'loading');
        armedDuringJob = timers.armed();
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(armedAtStart).toBeDefined();
    // One watchdog at a time, and the one from before the reports is gone: a slow
    // but steadily progressing model download can never time out.
    expect(armedDuringJob).toHaveLength(1);
    expect(armedDuringJob[0]).not.toBe(armedAtStart);
    expect(await statusOf(id)).toBe('done');
    expect(timers.armed()).toEqual([]);
  });

  it('gives up on audio that never decodes and carries on with the next recording', async () => {
    // ⚑ The watchdog used to be armed only *after* the decode, so a decode that
    // never settles - and `decodeAudioData` on a lecture-length recording is a
    // real hazard - left the job unfinished, the serial loop blocked behind it,
    // and nothing on screen but "Transcribing..." for as long as the tab stayed
    // open. No error, no timeout, no way past it.
    const hung = await makeRecording(1);
    const next = await makeRecording(2);
    const timers = manualTimers();
    let decodeCalls = 0;
    let armedDuringDecode: number[] = [];
    const { queue, transcribe } = makeQueue({
      ...timers.deps,
      stallTimeoutMs: 25,
      decode: async () => {
        decodeCalls += 1;
        if (decodeCalls > 1) return new Float32Array(16);
        // Only fires if the watchdog is already armed by this point.
        armedDuringDecode = timers.armed();
        timers.fire();
        return new Promise<Float32Array>(() => {});
      },
    });

    await queue.enqueue(hung);
    await queue.enqueue(next);
    await queue.whenIdle();

    expect(armedDuringDecode).toHaveLength(1);
    const record = (await getRecording(hung))!.transcript!;
    expect(record.status).toBe('failed');
    // ⚑ Names the step that went silent. Two rounds of "it appears to be
    // stuck" went by without anyone being able to say *where* it stopped; a
    // stall that does not name its own step cannot be acted on.
    expect(record.error).toContain('stalled while decoding the audio');
    // The decode was never waited out: the recording behind it still ran.
    expect(await statusOf(next)).toBe('done');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(timers.armed()).toEqual([]);
  });

  it('cancels the active job, leaves it cancelled, and carries on with the next recording', async () => {
    const stopped = await makeRecording(1);
    const next = await makeRecording(2);
    let calls = 0;
    const { queue, transcribe } = makeQueue({
      transcribe: (pcm, opts) => {
        calls += 1;
        if (calls > 1) return defaultTranscribe(pcm, opts);
        // Cancelled from outside, the way the Cancel button does, once the job
        // is genuinely in the transcriber's hands.
        // `queue` is bound by the time this runs - the transcriber is only
        // ever called from inside the drain loop.
        return silentTranscribe(() => {
          void queue.cancel(stopped);
        })(pcm, opts);
      },
    });

    await queue.enqueue(stopped);
    await queue.enqueue(next);
    await queue.whenIdle();

    const record = (await getRecording(stopped))!.transcript!;
    // ⚑ Terminal, not `running` or `pending`: those two are exactly what
    // `resume()` re-enqueues on the next launch, so anything else would restart
    // the job the owner just stopped. `failed` also brings back Retry, which is
    // what makes cancelling reversible.
    expect(record.status).toBe('failed');
    expect(record.error).toBe('Transcription cancelled.');
    expect(await statusOf(next)).toBe('done');
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('drops a queued recording so it is never handed to the transcriber', async () => {
    const first = await makeRecording(1);
    const dropped = await makeRecording(2);
    const gate = deferred();
    const { queue, transcribe } = makeQueue({
      transcribe: async (pcm, opts) => {
        await gate.promise;
        return defaultTranscribe(pcm, opts);
      },
    });

    await queue.enqueue(first);
    await queue.enqueue(dropped);
    await queue.cancel(dropped);
    gate.resolve();
    await queue.whenIdle();

    expect((await getRecording(dropped))!.transcript).toMatchObject({
      status: 'failed',
      error: 'Transcription cancelled.',
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(queue.getState().queuedIds).toEqual([]);
  });

  it('ignores a cancel for a recording it is neither running nor holding', async () => {
    const id = await makeRecording();
    const { queue, transcribe } = makeQueue();

    await queue.cancel(id);

    expect(await statusOf(id)).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
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

  it('⚑ Wave 1 review finding #2: resume() never enqueues an unfinished (endedAt: null) recording', async () => {
    // Without this, a reload mid-recording would have resume() enqueue the
    // very row K4-K7 are protecting: getRecordingAudio() hands the queue a
    // 0-byte Blob (the row exists, so it is not null), the decode throws,
    // and the job is written `failed` - permanently, since resume() never
    // re-queues a failed transcript. The audio would survive (once K4-K7
    // land) but its transcript would be silently destroyed on the exact
    // reload the feature exists to survive.
    const unfinished = await makeUnfinishedRecording(1, 'still recording');
    const finished = await makeRecording(2, 'finished');

    const { queue, transcribe } = makeQueue();
    await queue.resume();
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(await statusOf(finished)).toBe('done');
    // The unfinished recording's transcript is untouched - still absent,
    // never poisoned to `failed`.
    expect((await getRecording(unfinished))?.transcript).toBeNull();
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
      passes: null,
      queuedIds: [],
    });
    expect(states.at(-1)).toEqual({
      activeId: null,
      stage: null,
      progress: null,
      passes: null,
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
    expect(idle).toEqual({
      activeId: null,
      stage: null,
      progress: null,
      passes: null,
      queuedIds: [],
    });

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
