// A focused file, because it mocks the storage layer that
// `transcriptionQueue.test.ts` deliberately exercises for real: the one thing
// that cannot be provoked against a real database is a write that neither
// lands nor rejects, which is what a wedged IndexedDB transaction looks like.
import { describe, expect, it, vi } from 'vitest';
import type { AudioTranscriptRecord, RecordingRecord } from '@/storage/types';

const storage = vi.hoisted(() => ({
  getRecording: vi.fn(),
  getRecordingAudio: vi.fn(),
  listFinishedRecordings: vi.fn(),
  setRecordingTranscript: vi.fn(),
  takeTranscriptionLease: vi.fn(async () => true),
}));

vi.mock('@/storage/recordings', () => storage);

const { createTranscriptionQueue } = await import('@/audio/transcriptionQueue');

const MODEL = 'Xenova/whisper-base.en';
const RECORDING = { id: 'r1', title: 'Lecture', byteLength: 10 } as unknown as RecordingRecord;

/** Stand-in timers, so the watchdog is driven by the test rather than a clock. */
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

describe('a transcript write that never lands', () => {
  it('is given up on, reported, and does not block the recording behind it', async () => {
    const timers = manualTimers();
    const written: AudioTranscriptRecord[] = [];
    storage.getRecording.mockResolvedValue(RECORDING);
    storage.getRecordingAudio.mockResolvedValue(new Blob(['x']));
    storage.listFinishedRecordings.mockResolvedValue([]);
    storage.setRecordingTranscript.mockImplementation(
      async (_id: string, record: AudioTranscriptRecord) => {
        written.push(record);
        if (record.status === 'done') {
          // The watchdog is armed by now; fire it as a real timer would, then
          // neither land nor reject - the one case nothing used to bound.
          timers.fire();
          return new Promise<RecordingRecord>(() => {});
        }
        return RECORDING;
      },
    );
    const queue = createTranscriptionQueue({
      ...timers.deps,
      transcriber: { transcribe: async () => ({ text: 'hi', segments: [], language: 'en' }) },
      decode: async () => new Float32Array(16),
      getModel: async () => MODEL,
      stallTimeoutMs: 25,
    });

    await queue.enqueue('r1');
    await queue.whenIdle();

    expect(written.map((record) => record.status)).toEqual(['pending', 'running', 'done', 'failed']);
    expect(written.at(-1)!.error).toContain('stalled while saving the transcript');
    // Nothing is left armed to fire against a later job.
    expect(timers.armed()).toEqual([]);
  });
});
