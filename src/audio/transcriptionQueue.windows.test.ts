// The windowed transcribe loop: one `transcribe()` call per window, one
// persisted write per window, and a cursor that survives every way a job can
// end. A focused file with a pass-through spy on the storage writer - the
// sequence of writes is the behaviour under test here, and
// `transcriptionQueue.test.ts` deliberately reads only the final row.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import { LEASE_STALE_MS, createTranscriptionQueue } from '@/audio/transcriptionQueue';
import type {
  AudioTranscriber,
  AudioTranscriptionResult,
  TranscribeOptions,
} from '@/audio/types';
import { createRecording } from '@/storage/recordings';
import type { AudioTranscriptRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

vi.mock('@/storage/recordings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/recordings')>();
  return {
    ...actual,
    setRecordingTranscript: vi.fn(actual.setRecordingTranscript),
  };
});

const { setRecordingTranscript } = await import('@/storage/recordings');
const writeSpy = vi.mocked(setRecordingTranscript);

const MODEL = 'Xenova/whisper-base.en';
const WINDOW_MS = 100;
/** Three windows of `WINDOW_MS` each. */
const TOTAL_MS = 300;

beforeEach(async () => {
  await resetDatabase();
  writeSpy.mockClear();
});

/** Every persisted transcript for `id`, in write order. */
function writesFor(id: string): AudioTranscriptRecord[] {
  return writeSpy.mock.calls.filter(([recordingId]) => recordingId === id).map(([, record]) => record);
}

async function makeRecording(): Promise<string> {
  const recording = await createRecording(
    { title: 'Lecture', durationMs: TOTAL_MS, startedAt: 1, endedAt: 1 + TOTAL_MS },
    new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
  );
  return recording.id;
}

type TranscribeBody = (
  pcm: Float32Array,
  opts: TranscribeOptions,
) => Promise<AudioTranscriptionResult>;

/** One segment per window, named for the window, placed on the recording's clock. */
const perWindow: TranscribeBody = async (_pcm, opts) => {
  const offsetMs = opts.offsetMs ?? 0;
  const index = offsetMs / WINDOW_MS + 1;
  return {
    text: `window ${index}`,
    segments: [{ startMs: offsetMs, endMs: offsetMs + 50, text: `window ${index}` }],
    language: 'en',
  };
};

/** Rejects the second window, leaving a job half done. */
const failSecondWindow: TranscribeBody = async (pcm, opts) => {
  if (opts.offsetMs === 100) throw new Error('boom');
  return perWindow(pcm, opts);
};

function samplesFor(ms: number): number {
  return (ms / 1000) * TARGET_SAMPLE_RATE;
}

function makeQueue(
  overrides: {
    transcribe?: TranscribeBody;
    decodeMs?: number;
    /** Seed the cache with this much audio before the run; omit for an empty cache. */
    cachedMs?: number;
    cacheReadError?: unknown;
    ownerId?: string;
    stallTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => number;
    clearTimer?: (handle: number) => void;
  } = {},
) {
  const transcribe = vi.fn(overrides.transcribe ?? perWindow);
  const decode = vi.fn(async () => new Float32Array(samplesFor(overrides.decodeMs ?? TOTAL_MS)));

  // An in-memory stand-in for the `pcmCache` store, so these tests exercise
  // the queue's cache *policy* without depending on IndexedDB round trips.
  const rows = new Map<string, Float32Array>();
  if (overrides.cachedMs !== undefined) rows.set('seeded', new Float32Array(0));
  const read = vi.fn(async (recordingId: string) => {
    if (overrides.cacheReadError !== undefined) throw overrides.cacheReadError;
    if (overrides.cachedMs !== undefined && !rows.has(recordingId)) {
      return new Float32Array(samplesFor(overrides.cachedMs));
    }
    return rows.get(recordingId) ?? null;
  });
  const write = vi.fn(async (recordingId: string, pcm: Float32Array) => {
    rows.set(recordingId, pcm);
  });
  const drop = vi.fn(async (recordingId: string) => {
    rows.delete(recordingId);
  });

  const transcriber: AudioTranscriber = { transcribe };
  const queue = createTranscriptionQueue({
    transcriber,
    decode,
    getModel: async () => MODEL,
    now: () => 1000,
    windowMs: WINDOW_MS,
    ownerId: overrides.ownerId,
    readPcmCache: read,
    writePcmCache: write,
    dropPcmCache: drop,
    stallTimeoutMs: overrides.stallTimeoutMs,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { queue, transcribe, decode, cache: { read, write, drop } };
}

/** Stand-in timers, so the stall watchdog is driven by the test, not a clock. */
function manualTimers() {
  const waiting = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    deps: {
      setTimer: (fn: () => void, ms: number) => {
        void ms;
        const handle = nextHandle;
        nextHandle += 1;
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

describe('the windowed transcribe loop', () => {
  it('writes a partial transcript after each window', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    const written = writesFor(id);
    const running = written.filter((r) => r.status === 'running');
    // The opening `running` write, then one per completed window except the
    // last - which is the terminal `done` write below.
    expect(running.map((r) => r.completedMs)).toEqual([0, 100, 200]);
    expect(written.at(-1)!.status).toBe('done');
    expect(written.at(-1)!.completedMs).toBe(300);
  });

  it('accumulates text and segments across windows', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    const final = writesFor(id).at(-1)!;
    expect(final.segments.map((s) => s.text)).toEqual(['window 1', 'window 2', 'window 3']);
    expect(final.text).toContain('window 1');
    expect(final.text).toContain('window 3');
  });

  it('calls the transcriber once per window, not once per recording', async () => {
    const id = await makeRecording();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(transcribe.mock.calls.map(([, opts]) => opts.offsetMs)).toEqual([0, 100, 200]);
  });

  it('advances the cursor past a window that produces no segments', async () => {
    // ⚑ Silence must still move the cursor, or the job re-transcribes the
    // same quiet minute forever.
    const id = await makeRecording();
    const silentSecond: TranscribeBody = async (pcm, opts) =>
      opts.offsetMs === 100
        ? { text: '', segments: [], language: 'en' }
        : perWindow(pcm, opts);
    const { queue } = makeQueue({ transcribe: silentSecond });

    await queue.enqueue(id);
    await queue.whenIdle();

    const final = writesFor(id).at(-1)!;
    expect(final.status).toBe('done');
    expect(final.completedMs).toBe(300);
    expect(final.segments.map((s) => s.text)).toEqual(['window 1', 'window 3']);
  });

  it('keeps the segments it already had when a later window fails', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({ transcribe: failSecondWindow });

    await queue.enqueue(id);
    await queue.whenIdle();

    const failed = writesFor(id).at(-1)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('boom');
    expect(failed.completedMs).toBe(100);
    expect(failed.segments.map((s) => s.text)).toEqual(['window 1']);
  });

  it('keeps the cursor when the watchdog abandons the job as stalled', async () => {
    // ⚑ The point of this one: today a stalled lecture repeats all its work
    // on every Retry and stalls in the same place. With the cursor kept, the
    // retry resumes instead.
    const id = await makeRecording();
    const timers = manualTimers();
    const stallSecond: TranscribeBody = (pcm, opts) => {
      if (opts.offsetMs !== 100) return perWindow(pcm, opts);
      return new Promise<AudioTranscriptionResult>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Transcription aborted', 'AbortError')),
          { once: true },
        );
        timers.fire();
      });
    };
    const { queue } = makeQueue({ ...timers.deps, transcribe: stallSecond, stallTimeoutMs: 25 });

    await queue.enqueue(id);
    await queue.whenIdle();

    const failed = writesFor(id).at(-1)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('stalled');
    expect(failed.completedMs).toBe(100);
    expect(failed.segments.map((s) => s.text)).toEqual(['window 1']);
    expect(timers.armed()).toEqual([]);
  });

  it('transcribes a recording shorter than one window in a single pass', async () => {
    const id = await makeRecording();
    const { queue, transcribe } = makeQueue({ decodeMs: 40 });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalledTimes(1);
    const final = writesFor(id).at(-1)!;
    expect(final.status).toBe('done');
    expect(final.completedMs).toBe(40);
  });
});

describe('resuming from the cursor, backed by the PCM cache', () => {
  /** The transcript a half-finished job leaves behind: one window done, cursor at 100. */
  const HALF: AudioTranscriptRecord = {
    text: 'window 1',
    segments: [{ startMs: 0, endMs: 50, text: 'window 1' }],
    model: MODEL,
    language: 'en',
    status: 'running',
    error: null,
    completedMs: 100,
    updatedAt: 1,
  };

  it('starts at the stored cursor instead of at zero', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, HALF);
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe.mock.calls.map(([, opts]) => opts.offsetMs)).toEqual([100, 200]);
    const final = writesFor(id).at(-1)!;
    expect(final.status).toBe('done');
    expect(final.segments.map((s) => s.text)).toEqual(['window 1', 'window 2', 'window 3']);
  });

  it('does not blank a half-finished transcript when it picks the job back up', async () => {
    // ⚑ The opening `running` write used to blank the row. Against a resumed
    // job that would destroy the very partial this feature exists to keep -
    // and destroy it *before* the first new window could replace it.
    const id = await makeRecording();
    await setRecordingTranscript(id, HALF);
    writeSpy.mockClear();
    const { queue } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(writesFor(id).every((r) => r.segments.length >= 1)).toBe(true);
  });

  it('caches the decoded PCM on the first decode and reuses it on the next run', async () => {
    const id = await makeRecording();
    const { queue, decode, cache } = makeQueue({ transcribe: failSecondWindow });

    await queue.enqueue(id);
    await queue.whenIdle();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledTimes(1);

    await queue.retry(id);
    await queue.whenIdle();

    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.read).toHaveBeenCalledTimes(2);
  });

  it('deletes the cache once the transcript reaches a terminal status', async () => {
    const id = await makeRecording();
    const { queue, cache } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(cache.drop).toHaveBeenCalledWith(id);
  });

  it('keeps the cache when the job fails, so Retry resumes without re-decoding', async () => {
    // ⚑ A failed job keeps its cursor precisely so Retry picks up at the last
    // finished window. Dropping the cache here would make that retry re-decode
    // the whole lecture first, giving back most of what the cursor buys.
    const id = await makeRecording();
    const { queue, cache } = makeQueue({ transcribe: failSecondWindow });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(cache.drop).not.toHaveBeenCalled();
  });

  it('re-decodes when the cached PCM is too short for the stored cursor', async () => {
    // ⚑ A short cache row silently truncates the lecture: every window past
    // its end would simply not exist, and the job would write `done`.
    const id = await makeRecording();
    await setRecordingTranscript(id, HALF);
    const { queue, decode, cache } = makeQueue({
      cachedMs: 50, // shorter than the cursor at 100
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(cache.read).toHaveBeenCalledWith(id);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('re-decodes when the cache read throws', async () => {
    const id = await makeRecording();
    const { queue, decode, cache } = makeQueue({ cacheReadError: new Error('store is gone') });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(cache.read).toHaveBeenCalledWith(id);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(writesFor(id).at(-1)!.status).toBe('done');
  });

  it('finishes cleanly when the cursor is already at the end', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, { ...HALF, completedMs: TOTAL_MS });
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).not.toHaveBeenCalled();
    expect(writesFor(id).at(-1)!.status).toBe('done');
  });

  it('finishes cleanly when the cursor is past the end', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, { ...HALF, completedMs: TOTAL_MS + 5_000 });
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).not.toHaveBeenCalled();
    expect(writesFor(id).at(-1)!.status).toBe('done');
  });
});

describe('a model change', () => {
  const HALF_ON_TINY: AudioTranscriptRecord = {
    text: 'window 1',
    segments: [{ startMs: 0, endMs: 50, text: 'window 1' }],
    model: 'Xenova/whisper-tiny.en',
    language: 'en',
    status: 'paused',
    error: null,
    completedMs: 100,
    updatedAt: 1,
  };

  it('starts clean when the model differs from the stored transcript', async () => {
    // ⚑ Resuming model B onto model A's output and stamping the row with one
    // model id would be a lie about what the transcript is.
    const id = await makeRecording();
    await setRecordingTranscript(id, HALF_ON_TINY);
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe.mock.calls.map(([, opts]) => opts.offsetMs)).toEqual([0, 100, 200]);
    const final = writesFor(id).at(-1)!;
    expect(final.model).toBe(MODEL);
    expect(final.segments).toHaveLength(3);
  });

  it('discards the old model’s words rather than appending to them', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, {
      ...HALF_ON_TINY,
      segments: [{ startMs: 0, endMs: 50, text: 'heard by the old model' }],
    });
    writeSpy.mockClear();
    const { queue } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(writesFor(id).at(-1)!.text).not.toContain('old model');
  });

  it('still reuses the cached decode, which does not depend on the model', async () => {
    // Decoded 16 kHz PCM is the same bytes whichever Whisper model reads it,
    // so a model change resets the cursor but has no reason to pay for a
    // second decode.
    const id = await makeRecording();
    await setRecordingTranscript(id, HALF_ON_TINY);
    const { queue, decode, cache } = makeQueue({ cachedMs: TOTAL_MS });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(cache.read).toHaveBeenCalledWith(id);
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps the cursor when the model is unchanged', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, { ...HALF_ON_TINY, model: MODEL });
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe.mock.calls.map(([, opts]) => opts.offsetMs)).toEqual([100, 200]);
  });
});

describe('priority and window-boundary preemption', () => {
  it('a foreground enqueue preempts a running backlog job at the next window boundary', async () => {
    const backlog = await makeRecording();
    const fresh = await makeRecording();
    const order: string[] = [];
    let enqueuedFresh = false;

    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const active = queue.getState().activeId;
        if (active !== null && order.at(-1) !== active) order.push(active);
        // Part way through the backlog job, the owner finishes a recording.
        if (active === backlog && !enqueuedFresh) {
          enqueuedFresh = true;
          await queue.enqueue(fresh);
        }
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(backlog, 'backlog');
    await queue.whenIdle();

    expect(order).toEqual([backlog, fresh, backlog]);
  });

  it('a yielded job keeps status running and stays queued', async () => {
    const backlog = await makeRecording();
    const fresh = await makeRecording();
    let enqueuedFresh = false;
    let queuedWhileYielded: readonly string[] = [];

    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const active = queue.getState().activeId;
        if (active === backlog && !enqueuedFresh) {
          enqueuedFresh = true;
          await queue.enqueue(fresh);
        }
        if (active === fresh) queuedWhileYielded = queue.getState().queuedIds;
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(backlog, 'backlog');
    await queue.whenIdle();

    // While the fresh job runs, the yielded one is still queued - which is
    // what keeps RecordingDetail's "stuck" heuristic from flagging it.
    expect(queuedWhileYielded).toContain(backlog);
    const yielded = writesFor(backlog).filter((r) => r.status === 'running');
    expect(yielded.length).toBeGreaterThan(0);
  });

  it('a yielded job returns to the front of its own class', async () => {
    const first = await makeRecording();
    const second = await makeRecording();
    const fresh = await makeRecording();
    const order: string[] = [];
    let enqueuedFresh = false;

    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const active = queue.getState().activeId;
        if (active !== null && order.at(-1) !== active) order.push(active);
        if (active === first && !enqueuedFresh) {
          enqueuedFresh = true;
          await queue.enqueue(fresh);
        }
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(first, 'backlog');
    await queue.enqueue(second, 'backlog');
    await queue.whenIdle();

    expect(order).toEqual([first, fresh, first, second]);
  });

  it('a foreground job is not preempted by another foreground job', async () => {
    const running = await makeRecording();
    const alsoFresh = await makeRecording();
    const order: string[] = [];
    let enqueued = false;

    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const active = queue.getState().activeId;
        if (active !== null && order.at(-1) !== active) order.push(active);
        if (active === running && !enqueued) {
          enqueued = true;
          await queue.enqueue(alsoFresh);
        }
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(running);
    await queue.whenIdle();

    expect(order).toEqual([running, alsoFresh]);
  });

  it('enqueues the launch backlog as backlog, so a recording made during it goes first', async () => {
    // The real shape of this: the app launches, starts chewing through a
    // half-done lecture, and the owner records something new while it runs.
    const old = await makeRecording();
    await setRecordingTranscript(old, {
      text: '',
      segments: [],
      model: MODEL,
      language: null,
      status: 'running',
      error: null,
      completedMs: 0,
      updatedAt: 1,
    });
    const order: string[] = [];
    let fresh: string | null = null;

    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const active = queue.getState().activeId;
        if (active !== null && order.at(-1) !== active) order.push(active);
        if (active === old && fresh === null) {
          fresh = await makeRecording();
          await queue.enqueue(fresh);
        }
        return perWindow(pcm, opts);
      },
    });

    await queue.resume();
    await queue.whenIdle();

    expect(order).toEqual([old, fresh, old]);
  });
});

describe('the single-writer lease', () => {
  const OWNER = 'owner-a';

  it('stamps its owner and a heartbeat on every window write', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    const running = writesFor(id).filter((r) => r.status === 'running');
    expect(running.every((r) => r.leaseOwner === OWNER)).toBe(true);
    expect(running.every((r) => typeof r.leaseAt === 'number')).toBe(true);
  });

  it('skips a job another owner is actively holding', async () => {
    // ⚑ Two tabs each build their own queue and each run resume() at launch.
    // Without this, their interleaved window writes ratchet the cursor
    // backwards and splice two runs into one transcript.
    const id = await makeRecording();
    await setRecordingTranscript(id, {
      text: 'theirs',
      segments: [{ startMs: 0, endMs: 50, text: 'theirs' }],
      model: MODEL,
      language: 'en',
      status: 'running',
      error: null,
      completedMs: 100,
      leaseOwner: 'owner-b',
      leaseAt: 1000,
      updatedAt: 1000,
    });
    writeSpy.mockClear();
    const { queue, transcribe } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).not.toHaveBeenCalled();
    expect(writesFor(id).some((r) => r.leaseOwner === OWNER)).toBe(false);
  });

  it('takes over a job whose lease has gone stale', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, {
      text: '',
      segments: [],
      model: MODEL,
      language: null,
      status: 'running',
      error: null,
      completedMs: 0,
      leaseOwner: 'owner-b',
      leaseAt: 1000 - (LEASE_STALE_MS + 1),
      updatedAt: 1,
    });
    const { queue, transcribe } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalled();
  });

  it('takes a job with no lease at all, as every pre-upgrade row has', async () => {
    const id = await makeRecording();
    const { queue, transcribe } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalled();
  });

  it('takes back a job it already owns', async () => {
    const id = await makeRecording();
    await setRecordingTranscript(id, {
      text: '',
      segments: [],
      model: MODEL,
      language: null,
      status: 'running',
      error: null,
      completedMs: 0,
      leaseOwner: OWNER,
      leaseAt: 1000,
      updatedAt: 1,
    });
    const { queue, transcribe } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(transcribe).toHaveBeenCalled();
  });

  it('clears the lease when the job finishes', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({ ownerId: OWNER });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(writesFor(id).at(-1)!.leaseOwner).toBeNull();
  });

  it('clears the lease when the job fails', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({ ownerId: OWNER, transcribe: failSecondWindow });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(writesFor(id).at(-1)!.leaseOwner).toBeNull();
  });

  it('clears the lease when the owner pauses', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue({
      ownerId: OWNER,
      transcribe: async (pcm, opts) => {
        if (opts.offsetMs === 100) await queue.pause(id);
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    const paused = writesFor(id).filter((r) => r.status === 'paused').at(-1)!;
    expect(paused.leaseOwner).toBeNull();
  });
});

describe('the queue state a view reads', () => {
  it('reports the cursor and the recording duration while transcribing', async () => {
    const id = await makeRecording();
    const seen: { completedMs: number | null; durationMs: number | null }[] = [];
    const { queue } = makeQueue({
      transcribe: async (pcm, opts) => {
        const state = queue.getState();
        seen.push({ completedMs: state.completedMs, durationMs: state.durationMs });
        return perWindow(pcm, opts);
      },
    });

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(seen).toEqual([
      { completedMs: 0, durationMs: TOTAL_MS },
      { completedMs: 100, durationMs: TOTAL_MS },
      { completedMs: 200, durationMs: TOTAL_MS },
    ]);
  });

  it('clears the cursor and duration when the queue goes idle', async () => {
    const id = await makeRecording();
    const { queue } = makeQueue();

    await queue.enqueue(id);
    await queue.whenIdle();

    expect(queue.getState().completedMs).toBeNull();
    expect(queue.getState().durationMs).toBeNull();
  });
});
