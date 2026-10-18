// The windowed transcribe loop: one `transcribe()` call per window, one
// persisted write per window, and a cursor that survives every way a job can
// end. A focused file with a pass-through spy on the storage writer - the
// sequence of writes is the behaviour under test here, and
// `transcriptionQueue.test.ts` deliberately reads only the final row.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import { createTranscriptionQueue } from '@/audio/transcriptionQueue';
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

function makeQueue(
  overrides: {
    transcribe?: TranscribeBody;
    decodeMs?: number;
    stallTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => number;
    clearTimer?: (handle: number) => void;
  } = {},
) {
  const transcribe = vi.fn(overrides.transcribe ?? perWindow);
  const samples = ((overrides.decodeMs ?? TOTAL_MS) / 1000) * TARGET_SAMPLE_RATE;
  const decode = vi.fn(async () => new Float32Array(samples));
  const transcriber: AudioTranscriber = { transcribe };
  const queue = createTranscriptionQueue({
    transcriber,
    decode,
    getModel: async () => MODEL,
    now: () => 1000,
    windowMs: WINDOW_MS,
    stallTimeoutMs: overrides.stallTimeoutMs,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { queue, transcribe, decode };
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
    const failSecond: TranscribeBody = async (pcm, opts) => {
      if (opts.offsetMs === 100) throw new Error('boom');
      return perWindow(pcm, opts);
    };
    const { queue } = makeQueue({ transcribe: failSecond });

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
