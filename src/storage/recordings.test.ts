import { beforeEach, describe, expect, it } from 'vitest';

import { openNotesDb } from '@/storage/db';
import { createNote } from '@/storage/notes';
import {
  createRecording,
  deleteRecording,
  finalizeRecording,
  getRecording,
  getRecordingAudio,
  listFinishedRecordings,
  listRecordings,
  listRecordingsBySession,
  listUnfinishedRecordings,
  recordingOwnersByNote,
  recordingsForNote,
  setRecordingTranscript,
  updateRecording,
} from '@/storage/recordings';
import {
  appendRecordingChunk,
  listRecordingChunks,
} from '@/storage/recordingChunks';
import type { AudioTranscriptRecord, RecordingRecord } from '@/storage/types';
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
    const earlierOpen = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Earlier open', startedAt: 500, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
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
    expect(unfinished.map((r) => r.id)).toEqual([open.id, earlierOpen.id]);
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

describe('listFinishedRecordings', () => {
  it('excludes rows with no endedAt and returns the rest newest first', async () => {
    const open = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Open', startedAt: 3_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    const earlierFinished = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Earlier finished', startedAt: 1_000, durationMs: 500 },
      new Blob(['y'], { type: 'audio/webm' }),
    );
    await updateRecording(earlierFinished.id, { endedAt: 1_500 });
    const laterFinished = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Later finished', startedAt: 2_000, durationMs: 500 },
      new Blob(['z'], { type: 'audio/webm' }),
    );
    await updateRecording(laterFinished.id, { endedAt: 2_500 });

    const finished = await listFinishedRecordings();
    expect(finished.map((r) => r.id)).toEqual([laterFinished.id, earlierFinished.id]);
    expect(finished.some((r) => r.id === open.id)).toBe(false);
  });
});

describe('finalizeRecording', () => {
  it('writes the audio, patches the row and removes the chunks', async () => {
    const created = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Lecture', startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(created.id, 0, new Blob(['a'], { type: 'audio/webm' }));
    await appendRecordingChunk(created.id, 1, new Blob(['b'], { type: 'audio/webm' }));

    const stitched = new Blob(['ab'], { type: 'audio/webm' });
    const finalized = await finalizeRecording(created.id, stitched, {
      endedAt: 5_000,
      durationMs: 4_000,
    });

    expect(finalized.endedAt).toBe(5_000);
    expect(finalized.durationMs).toBe(4_000);
    expect(finalized.byteLength).toBe(2);
    expect(finalized.mimeType).toBe('audio/webm');

    const loaded = await getRecording(created.id);
    expect(loaded).toEqual(finalized);

    const blob = await getRecordingAudio(created.id);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([97, 98]));

    expect(await listRecordingChunks(created.id)).toEqual([]);
  });

  it('honors an explicit mimeType patch over the stitched blob\'s own type', async () => {
    const created = await createRecording(
      { title: 'Lecture', startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: '' }),
    );

    const finalized = await finalizeRecording(created.id, new Blob(['x'], { type: '' }), {
      endedAt: 2_000,
      durationMs: 1_000,
      mimeType: 'audio/webm;codecs=opus',
    });

    expect(finalized.mimeType).toBe('audio/webm;codecs=opus');
    expect((await getRecordingAudio(created.id))!.type).toBe('audio/webm;codecs=opus');
  });

  it('is harmless to finalize the same recording a second time', async () => {
    const created = await createRecording(
      { title: 'Lecture', startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(created.id, 0, new Blob(['a'], { type: 'audio/webm' }));

    await finalizeRecording(created.id, new Blob(['a'], { type: 'audio/webm' }), {
      endedAt: 5_000,
      durationMs: 4_000,
    });
    const second = await finalizeRecording(created.id, new Blob(['ab'], { type: 'audio/webm' }), {
      endedAt: 6_000,
      durationMs: 5_000,
    });

    expect(second.endedAt).toBe(6_000);
    expect(second.byteLength).toBe(2);
    expect(await listRecordingChunks(created.id)).toEqual([]);
  });

  it('rejects a missing id and leaves storage untouched', async () => {
    await expect(
      finalizeRecording('missing', new Blob(['x'], { type: 'audio/webm' }), {
        endedAt: 1_000,
        durationMs: 500,
      }),
    ).rejects.toThrow(/not found/i);

    const db = await openNotesDb();
    expect(await db.count('recordings')).toBe(0);
    expect(await db.count('recordingAudio')).toBe(0);
  });
});

describe('recordingsForNote (fix round 2, Fix 3a)', () => {
  it('includes a recording linked directly by noteId', async () => {
    const note = await createNote({ title: 'Note', deviceId: 'huion', pageBaseline: 0 });
    const linked = await createRecording(
      { title: 'Direct', noteId: note.id, startedAt: 1_000, durationMs: 1_000, endedAt: 2_000 },
      audio(),
    );
    await createRecording(
      { title: 'Unrelated', startedAt: 1_000, durationMs: 1_000, endedAt: 2_000 },
      audio(),
    );

    expect((await recordingsForNote(note.id)).map((r) => r.id)).toEqual([linked.id]);
  });

  it('includes a recording linked only through the note\'s session (K12/A32)', async () => {
    const note = await createNote({
      title: 'Note',
      deviceId: 'huion',
      pageBaseline: 0,
      sessionId: 'sess-1',
    });
    const linked = await createRecording(
      { title: 'Via session', sessionId: 'sess-1', startedAt: 1_000, durationMs: 1_000, endedAt: 2_000 },
      audio(),
    );

    expect((await recordingsForNote(note.id)).map((r) => r.id)).toEqual([linked.id]);
  });

  it('de-duplicates a recording that matches both link paths at once', async () => {
    const note = await createNote({
      title: 'Note',
      deviceId: 'huion',
      pageBaseline: 0,
      sessionId: 'sess-1',
    });
    const linked = await createRecording(
      {
        title: 'Both',
        noteId: note.id,
        sessionId: 'sess-1',
        startedAt: 1_000,
        durationMs: 1_000,
        endedAt: 2_000,
      },
      audio(),
    );

    expect((await recordingsForNote(note.id)).map((r) => r.id)).toEqual([linked.id]);
  });

  it('excludes a linked recording that has not finished yet', async () => {
    const note = await createNote({ title: 'Note', deviceId: 'huion', pageBaseline: 0 });
    await createRecording(
      { title: 'Still recording', noteId: note.id, startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );

    expect(await recordingsForNote(note.id)).toEqual([]);
  });

  it('returns nothing for a note with no linked recording at all', async () => {
    const note = await createNote({ title: 'Lonely', deviceId: 'huion', pageBaseline: 0 });

    expect(await recordingsForNote(note.id)).toEqual([]);
  });
});

describe('recordingOwnersByNote (fix round 3, I5)', () => {
  function rec(overrides: Partial<RecordingRecord> & { id: string }): RecordingRecord {
    return {
      sessionId: null,
      noteId: null,
      title: 'R',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1000,
      mimeType: 'audio/webm',
      byteLength: 10,
      transcript: null,
      ...overrides,
    };
  }

  it('maps a directly-linked recording to its note', () => {
    const notes = [{ id: 'n1' }];
    const recordings = [rec({ id: 'r1', noteId: 'n1' })];
    expect(recordingOwnersByNote(notes, recordings)).toEqual(new Map([['r1', 'n1']]));
  });

  it("maps a session-linked recording to the note sharing that session", () => {
    const notes = [{ id: 'n1', sessionId: 'sess-1' }];
    const recordings = [rec({ id: 'r1', sessionId: 'sess-1' })];
    expect(recordingOwnersByNote(notes, recordings)).toEqual(new Map([['r1', 'n1']]));
  });

  it('leaves a standalone recording (no noteId, no matching session) unmapped', () => {
    const notes = [{ id: 'n1', sessionId: 'sess-1' }];
    const recordings = [rec({ id: 'r1', sessionId: 'sess-2' })];
    expect(recordingOwnersByNote(notes, recordings).size).toBe(0);
  });

  it('a direct noteId link wins over a session link naming a different note', () => {
    const notes = [
      { id: 'direct-note' },
      { id: 'session-note', sessionId: 'sess-1' },
    ];
    const recordings = [rec({ id: 'r1', noteId: 'direct-note', sessionId: 'sess-1' })];
    expect(recordingOwnersByNote(notes, recordings).get('r1')).toBe('direct-note');
  });

  it('matches recordingsForNote looped per note, for a corpus with both link kinds', async () => {
    const viaSession = await createNote({
      title: 'Via session',
      deviceId: 'd',
      pageBaseline: 0,
      sessionId: 'shared-session',
    });
    const direct = await createNote({ title: 'Direct', deviceId: 'd', pageBaseline: 0 });
    await createRecording(
      { title: 'A', sessionId: 'shared-session', startedAt: 1_000, durationMs: 1_000, endedAt: 2_000 },
      audio(),
    );
    await createRecording(
      { title: 'B', noteId: direct.id, startedAt: 1_000, durationMs: 1_000, endedAt: 2_000 },
      audio(),
    );

    const finished = await listFinishedRecordings();
    const looped = new Map<string, string>();
    for (const note of [viaSession, direct]) {
      for (const recording of await recordingsForNote(note.id)) {
        looped.set(recording.id, note.id);
      }
    }
    const batched = recordingOwnersByNote([viaSession, direct], finished);
    expect(batched).toEqual(looped);
  });
});
