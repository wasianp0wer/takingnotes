import { beforeEach, describe, expect, it } from 'vitest';

import { recordingForNote } from '@/gaps/analyzer';
import { createNote } from '@/storage/notes';
import { createRecording } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

const audio = () => new Blob([new Uint8Array([1])], { type: 'audio/webm' });

beforeEach(resetDatabase);

/**
 * ⚑ Wave 1 review finding #2's third named consumer: `recordingForNote`
 * (A21's "earliest recording linked to the note") must never hand gap
 * analysis a recording that is still being written - since K5 a
 * `RecordingRecord` exists from the moment recording starts, with
 * `endedAt: null` and a zero-byte `recordingAudio` row.
 */
describe('recordingForNote', () => {
  it('skips a recording linked directly to the note that is still unfinished', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0, sessionId: session.id });
    await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Still recording', startedAt: 1000, endedAt: null, durationMs: 0 },
      new Blob([], { type: 'audio/webm' }),
    );

    expect(await recordingForNote(note.id)).toBeNull();
  });

  it('picks the finished recording over an unfinished one linked to the same note', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0, sessionId: session.id });
    await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Still recording', startedAt: 500, endedAt: null, durationMs: 0 },
      new Blob([], { type: 'audio/webm' }),
    );
    const finished = await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Finished', startedAt: 1000, endedAt: 601_000, durationMs: 600_000 },
      audio(),
    );

    const result = await recordingForNote(note.id);
    expect(result?.id).toBe(finished.id);
  });

  it('skips a recording linked only through the note session when that one is unfinished', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0, sessionId: session.id });
    await createRecording(
      { sessionId: session.id, noteId: null, title: 'Still recording', startedAt: 1000, endedAt: null, durationMs: 0 },
      new Blob([], { type: 'audio/webm' }),
    );

    expect(await recordingForNote(note.id)).toBeNull();
  });

  it('still picks the earliest when both candidates are finished (A21, unchanged)', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0, sessionId: session.id });
    const later = await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Later', startedAt: 2000, endedAt: 602_000, durationMs: 600_000 },
      audio(),
    );
    const earlier = await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Earlier', startedAt: 1000, endedAt: 601_000, durationMs: 600_000 },
      audio(),
    );

    const result = await recordingForNote(note.id);
    expect(result?.id).toBe(earlier.id);
    expect(result?.id).not.toBe(later.id);
  });
});
