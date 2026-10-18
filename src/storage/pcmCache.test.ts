import { beforeEach, describe, expect, it } from 'vitest';

import { openNotesDb } from '@/storage/db';
import { deletePcmCache, getPcmCache, putPcmCache } from '@/storage/pcmCache';
import { createRecording, deleteRecording } from '@/storage/recordings';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('the transient PCM cache', () => {
  it('round-trips PCM within Int16 quantization error', async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123]);
    await putPcmCache('r1', pcm);

    const back = await getPcmCache('r1');

    expect(back).not.toBeNull();
    expect(back!.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      expect(back![i]).toBeCloseTo(pcm[i], 3);
    }
  });

  it('clamps samples outside [-1, 1] rather than wrapping', async () => {
    // Wrapping is the failure that matters: +2 stored as a wrapped Int16 comes
    // back as a loud negative sample, which is audible garbage rather than
    // clipping.
    await putPcmCache('r1', new Float32Array([2, -2]));

    const back = await getPcmCache('r1');

    expect(back![0]).toBeCloseTo(1, 3);
    expect(back![1]).toBeCloseTo(-1, 3);
  });

  it('returns null for a recording with no cache row', async () => {
    expect(await getPcmCache('missing')).toBeNull();
  });

  it('deletes a row on request', async () => {
    await putPcmCache('r1', new Float32Array([0.25]));

    await deletePcmCache('r1');

    expect(await getPcmCache('r1')).toBeNull();
  });

  it('keeps recordings apart', async () => {
    await putPcmCache('r1', new Float32Array([0.25]));
    await putPcmCache('r2', new Float32Array([0.5, 0.75]));

    expect((await getPcmCache('r1'))!.length).toBe(1);
    expect((await getPcmCache('r2'))!.length).toBe(2);
  });

  it('deleting a recording deletes its PCM cache', async () => {
    const recording = await createRecording(
      { title: 'Lecture', durationMs: 1000 },
      new Blob(['audio'], { type: 'audio/webm' }),
    );
    await putPcmCache(recording.id, new Float32Array([0.25]));

    await deleteRecording(recording.id);

    expect(await getPcmCache(recording.id)).toBeNull();
  });
});

describe('a cache row written at another sample rate', () => {
  it('is refused rather than returned at the wrong clock', async () => {
    // ⚑ `PcmCacheRecord.sampleRate` exists so a rate change is detectable
    // rather than silent. Returning such a row would put every transcript
    // timestamp on the wrong clock, with nothing to show it had happened.
    const db = await openNotesDb();
    await db.put('pcmCache', {
      recordingId: 'r1',
      sampleRate: 44_100,
      samples: new Int16Array([1, 2, 3]).buffer,
    });

    expect(await getPcmCache('r1')).toBeNull();
  });
});
