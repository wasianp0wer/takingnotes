import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recoverInterruptedRecordings,
  resetAudioRuntimeForTests,
  startAudioRuntime,
} from '@/audio/audioRuntime';
import { appendRecordingChunk, listRecordingChunks } from '@/storage/recordingChunks';
import { createRecording, finalizeRecording, getRecording } from '@/storage/recordings';
import { resetDatabase } from '@/test/resetDb';

const chunk = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });

beforeEach(async () => {
  await resetDatabase();
  resetAudioRuntimeForTests();
});

describe('recoverInterruptedRecordings (K7)', () => {
  it('stitches an unfinished recording with chunks, closes it, deletes the chunk rows, and enqueues it', async () => {
    const pending = await createRecording(
      { title: 'Lecture', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(pending.id, 0, chunk([1, 2]));
    await appendRecordingChunk(pending.id, 1, chunk([3, 4, 5]));

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({ enqueue });

    const recovered = await getRecording(pending.id);
    // Estimated from the chunk count (2 chunks * the 1000 ms default
    // timeslice), not from whenever recovery happened to run (fix round 2,
    // Fix 4) - startedAt (1_000) + 2_000.
    expect(recovered?.endedAt).toBe(3_000);
    expect(recovered?.durationMs).toBe(2_000);
    expect(recovered?.byteLength).toBe(5);

    expect(await listRecordingChunks(pending.id)).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith(pending.id);
  });

  it('deletes an unfinished recording that has no chunks at all, and never enqueues it', async () => {
    const pending = await createRecording(
      { title: 'Empty', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({ enqueue });

    expect(await getRecording(pending.id)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves an already-finished recording completely untouched', async () => {
    const finished = await createRecording(
      { title: 'Done', durationMs: 5_000, startedAt: 1_000, endedAt: 6_000 },
      chunk([1, 2, 3]),
    );

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({ enqueue });

    const after = await getRecording(finished.id);
    expect(after).toEqual(finished);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('running recovery twice on an already-recovered recording is a no-op the second time (⚑ finding #1 regression guard)', async () => {
    const pending = await createRecording(
      { title: 'Lecture', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(pending.id, 0, chunk([1, 2, 3]));

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({ enqueue });
    // If recovery failed to patch endedAt, this second pass would see zero
    // chunks and an unfinished row again, and delete a recording the first
    // pass just finished saving.
    await recoverInterruptedRecordings({ enqueue });

    const after = await getRecording(pending.id);
    // startedAt (1_000) + 1 chunk * the 1000 ms default timeslice.
    expect(after?.endedAt).toBe(2_000);
    expect(after?.byteLength).toBe(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('⚑ C1: a row finalized by another actor between the snapshot and the delete survives, instead of being destroyed', async () => {
    const pending = await createRecording(
      { title: 'Lecture', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(pending.id, 0, chunk([1, 2, 3]));

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({
      enqueue,
      // Models another actor (a second tab, or a second recovery pass)
      // finalizing this exact row first: its finalizeRecording call writes
      // the audio and purges the chunks atomically, so by the time THIS
      // pass's stitch runs, there are genuinely none left - indistinguishable
      // from "nothing was ever captured" unless the row is re-read.
      stitch: async (id) => {
        await finalizeRecording(id, chunk([1, 2, 3]), { endedAt: 4_000, durationMs: 3_000 });
        return null;
      },
    });

    const after = await getRecording(pending.id);
    // Survives as the other actor's save, not a deletion.
    expect(after).toBeDefined();
    expect(after?.endedAt).toBe(4_000);
    expect(after?.byteLength).toBe(3);
    // This pass did not itself finalize or enqueue it - the other actor did.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('⚑ C1: a recording actively owned by this process\'s recorder is never touched by recovery', async () => {
    const pending = await createRecording(
      { title: 'Live', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(pending.id, 0, chunk([1, 2, 3]));

    const enqueue = vi.fn(async () => {});
    await recoverInterruptedRecordings({
      enqueue,
      activeRecordingId: () => pending.id,
    });

    const after = await getRecording(pending.id);
    // Untouched - still live, not finalized or deleted.
    expect(after?.endedAt).toBeNull();
    expect(after?.byteLength).toBe(0);
    expect(await listRecordingChunks(pending.id)).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('startAudioRuntime ordering (⚑ finding #2)', () => {
  it('finishes recovery before the transcription queue resumes, so resume() never sees a pre-recovery unfinished row', async () => {
    const pending = await createRecording(
      { title: 'Lecture', durationMs: 0, startedAt: 1_000, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(pending.id, 0, chunk([1, 2, 3]));

    const seenAtResumeTime: Array<{ endedAt: number | null }> = [];
    const queue = {
      enqueue: vi.fn(async () => {}),
      resume: vi.fn(async () => {
        // By the time resume() runs, the recording must already be finished -
        // this is exactly what ⚑ finding #2 says must be true, or resume()
        // would enqueue the same 0-byte row recovery was about to fix.
        const current = await getRecording(pending.id);
        seenAtResumeTime.push({ endedAt: current?.endedAt ?? null });
      }),
    };

    await startAudioRuntime({
      recover: () => recoverInterruptedRecordings({ enqueue: queue.enqueue }),
      resume: queue.resume,
    });

    expect(queue.resume).toHaveBeenCalledTimes(1);
    // startedAt (1_000) + 1 chunk * the 1000 ms default timeslice.
    expect(seenAtResumeTime).toEqual([{ endedAt: 2_000 }]);
  });

  it('is idempotent across repeated calls (module-level flag, StrictMode-safe)', async () => {
    const recover = vi.fn(async () => {});
    const resume = vi.fn(async () => {});

    await startAudioRuntime({ recover, resume });
    await startAudioRuntime({ recover, resume });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
