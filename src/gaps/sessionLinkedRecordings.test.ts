import { beforeEach, describe, expect, it } from 'vitest';

import { noteHasRecording } from '@/gaps/analyzer';
import { createNote } from '@/storage/notes';
import { createRecording } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

/**
 * Renamed from `recordingForNote.test.ts` (fix round 2, Fix 4): that function
 * no longer exists on this branch, and a test file named for a deleted
 * function is exactly the kind of drift the review flagged.
 *
 * ⚑ Wave 1 review finding #2's third named consumer. Since K5 a
 * `RecordingRecord` exists from the moment recording starts, with
 * `endedAt: null` and a zero-byte `recordingAudio` row, so gap analysis must
 * never be handed one that is still being written.
 *
 * S3 wrote this against `recordingForNote` (A21's "earliest recording linked
 * to the note"), which K45 replaced with per-page selection - `recordingForPage`
 * plus `noteHasRecording` for the note-wide gate. The direct-link case and the
 * positive session case both moved into `analyzer.test.ts` with that change.
 *
 * What is kept here is the one case neither covers: a recording reachable
 * *only* through the note's session, still unfinished. `recordingsForNote`
 * (`storage/recordings.ts`, fix round 2's lift of S1's module-private
 * `candidateRecordings`) derives both link paths from the single
 * `listFinishedRecordings()` listing, so this now holds by construction
 * rather than by a hand-written filter - which is exactly why it is worth
 * pinning. Reintroducing a second, unfiltered listing (the shape this
 * finding was raised against) would turn it red.
 */
describe('session-linked recordings and the finished filter', () => {
  it('a note whose only session-linked recording is unfinished has no recording', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({
      title: 'N',
      deviceId: 'd',
      pageBaseline: 0,
      sessionId: session.id,
    });
    await createRecording(
      {
        sessionId: session.id,
        noteId: null,
        title: 'Still recording',
        startedAt: 1000,
        endedAt: null,
        durationMs: 0,
      },
      new Blob([], { type: 'audio/webm' }),
    );

    expect(await noteHasRecording(note.id)).toBe(false);
  });

  it('a note whose session-linked recording is finished does have one', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({
      title: 'N',
      deviceId: 'd',
      pageBaseline: 0,
      sessionId: session.id,
    });
    await createRecording(
      {
        sessionId: session.id,
        noteId: null,
        title: 'Done',
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
      },
      new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
    );

    expect(await noteHasRecording(note.id)).toBe(true);
  });
});
