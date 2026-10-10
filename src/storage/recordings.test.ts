import { beforeEach, describe, expect, it } from 'vitest';

import { openNotesDb } from '@/storage/db';
import {
  createRecording,
  deleteRecording,
  getRecording,
  getRecordingAudio,
  listRecordings,
  listRecordingsBySession,
  listUnfinishedRecordings,
  setRecordingTranscript,
  updateRecording,
} from '@/storage/recordings';
import {
  appendRecordingChunk,
  listRecordingChunks,
} from '@/storage/recordingChunks';
import type { AudioTranscriptRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const audio = (bytes = [1, 2, 3, 4], type = 'audio/webm') =>
  new Blob([new Uint8Array(bytes)], { type });

const TRANSCRIPT: AudioTranscriptRecord = {
  text: 'hello world',
  segments: [{ startMs: 0, endMs: 900, text: 'hello world' }],
  model: 'Xenova/whisper-base.en',
  language: 'en',
  status: 'done',
  error: null,
  updatedAt: 42,
};

beforeEach(resetDatabase);

describe('recordings repository', () => {
  it('creates a recording with sensible defaults and derives its byte length', async () => {
    const recording = await createRecording({ title: 'Take 1', durationMs: 1_500 }, audio());

    expect(recording.id).toBeTruthy();
    expect(recording.sessionId).toBeNull();
    expect(recording.noteId).toBeNull();
    expect(recording.durationMs).toBe(1_500);
    expect(recording.byteLength).toBe(4);
    expect(recording.mimeType).toBe('audio/webm');
    expect(recording.startedAt).toBeGreaterThan(0);
    expect(recording.endedAt).toBeNull();
    expect(recording.transcript).toBeNull();
    expect(await getRecording(recording.id)).toEqual(recording);
  });

  it('round-trips the audio bytes as a Blob', async () => {
    const recording = await createRecording(
      { title: 'Take 1', durationMs: 10 },
      audio([9, 8, 7]),
    );

    const blob = await getRecordingAudio(recording.id);
    expect(blob?.type).toBe('audio/webm');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('stores exactly the bytes of a subarray-backed Blob', async () => {
    const view = new Uint8Array([0, 0, 7, 8, 9, 0]).subarray(2, 5);
    const recording = await createRecording(
      { title: 'View', durationMs: 1 },
      new Blob([view], { type: 'audio/webm' }),
    );

    const blob = await getRecordingAudio(recording.id);
    expect(blob!.size).toBe(3);
    expect(recording.byteLength).toBe(3);
  });

  it('keeps audio bytes out of the recording record', async () => {
    const recording = await createRecording(
      { title: 'Big', durationMs: 1 },
      audio([...new Uint8Array(2048).fill(3)]),
    );

    const loaded = await getRecording(recording.id);
    expect(JSON.stringify(loaded)).not.toContain('"data"');
    for (const value of Object.values(loaded!)) {
      expect(value instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
  });

  it('returns null from getRecordingAudio when there are no bytes', async () => {
    expect(await getRecordingAudio('missing')).toBeNull();
  });

  it('links a recording to a session and a note', async () => {
    const recording = await createRecording(
      { title: 'Linked', durationMs: 5, sessionId: 'sess-1', noteId: 'note-1' },
      audio(),
    );

    expect(recording.sessionId).toBe('sess-1');
    expect(recording.noteId).toBe('note-1');
    expect((await listRecordingsBySession('sess-1')).map((r) => r.id)).toEqual([recording.id]);
    expect(await listRecordingsBySession('sess-2')).toEqual([]);
  });

  it('applies a partial update and returns the merged record', async () => {
    const created = await createRecording({ title: 'Draft', durationMs: 1 }, audio());
    const updated = await updateRecording(created.id, { title: 'Final', endedAt: 77 });

    expect(updated.title).toBe('Final');
    expect(updated.endedAt).toBe(77);
    expect(await getRecording(created.id)).toEqual(updated);
  });

  it('throws when updating an unknown recording', async () => {
    await expect(updateRecording('missing', { title: 'x' })).rejects.toThrow('missing');
    await expect(setRecordingTranscript('missing', TRANSCRIPT)).rejects.toThrow('missing');
  });

  it('persists both writes when two recording updates race', async () => {
    const created = await createRecording({ title: 'Race', durationMs: 1 }, audio());

    await Promise.all([
      updateRecording(created.id, { title: 'renamed' }),
      setRecordingTranscript(created.id, TRANSCRIPT),
    ]);

    const loaded = await getRecording(created.id);
    expect(loaded?.title).toBe('renamed');
    expect(loaded?.transcript?.text).toBe('hello world');
  });

  it('stores a transcript with its segments', async () => {
    const created = await createRecording({ title: 'T', durationMs: 1 }, audio());
    await setRecordingTranscript(created.id, TRANSCRIPT);

    const loaded = await getRecording(created.id);
    expect(loaded?.transcript?.segments).toEqual([{ startMs: 0, endMs: 900, text: 'hello world' }]);
    expect(loaded?.transcript?.model).toBe('Xenova/whisper-base.en');
    expect(loaded?.transcript?.status).toBe('done');
  });

  it('lists recordings newest first', async () => {
    const first = await createRecording({ title: 'One', durationMs: 1, startedAt: 1_000 }, audio());
    const second = await createRecording({ title: 'Two', durationMs: 1, startedAt: 2_000 }, audio());

    expect((await listRecordings()).map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('deletes a recording together with its bytes', async () => {
    const doomed = await createRecording({ title: 'Doomed', durationMs: 1 }, audio());
    const kept = await createRecording({ title: 'Kept', durationMs: 1 }, audio());

    await deleteRecording(doomed.id);

    expect(await getRecording(doomed.id)).toBeUndefined();
    expect(await getRecordingAudio(doomed.id)).toBeNull();
    expect(await getRecordingAudio(kept.id)).not.toBeNull();
    const db = await openNotesDb();
    expect(await db.count('recordingAudio')).toBe(1);
  });

  it('deleting an unknown recording is a no-op', async () => {
    await expect(deleteRecording('missing')).resolves.toBeUndefined();
  });
});

describe('unfinished recordings', () => {
  it('lists only those with no endedAt, newest first', async () => {
    const open = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Open', startedAt: 2_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    const closed = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Closed', startedAt: 1_000, durationMs: 500 },
      new Blob(['y'], { type: 'audio/webm' }),
    );
    await updateRecording(closed.id, { endedAt: 1_500 });

    const unfinished = await listUnfinishedRecordings();
    expect(unfinished.map((r) => r.id)).toEqual([open.id]);
  });

  it('deleting a recording drops its chunks too', async () => {
    const rec = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Open', startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(rec.id, 0, new Blob(['a'], { type: 'audio/webm' }));
    await deleteRecording(rec.id);
    expect(await listRecordingChunks(rec.id)).toEqual([]);
  });
});
