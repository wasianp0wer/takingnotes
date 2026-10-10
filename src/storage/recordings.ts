import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import { getNote } from '@/storage/notes';
import type { AudioTranscriptRecord, RecordingRecord } from '@/storage/types';

export interface CreateRecordingInput {
  title: string;
  durationMs: number;
  /** Null when the recording was made with no active note (A10). */
  sessionId?: string | null;
  noteId?: string | null;
  startedAt?: number;
  endedAt?: number | null;
  /** Defaults to the Blob's own type, which is what MediaRecorder reports. */
  mimeType?: string;
}

/**
 * Writes the record and its bytes in one transaction, so a recording never
 * exists without its audio (or the other way round). Takes a `Blob` for the
 * same reason `setPageRender` does: passing `someUint8Array.buffer` would
 * silently store the whole backing buffer rather than the intended view.
 */
export async function createRecording(
  input: CreateRecordingInput,
  audio: Blob,
): Promise<RecordingRecord> {
  const data = await audio.arrayBuffer();
  const type = input.mimeType ?? audio.type;

  const recording: RecordingRecord = {
    id: newId(),
    sessionId: input.sessionId ?? null,
    noteId: input.noteId ?? null,
    title: input.title,
    // Always a number, never left to the caller to omit: `listRecordings()`
    // (and so `recordingsForNote`) reads the `by-started` index, which
    // silently skips any row with an invalid key.
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? null,
    durationMs: input.durationMs,
    mimeType: type,
    byteLength: data.byteLength,
    transcript: null,
  };

  const db = await openNotesDb();
  const tx = db.transaction(['recordings', 'recordingAudio'], 'readwrite');
  await tx.objectStore('recordingAudio').put({ data, type }, recording.id);
  await tx.objectStore('recordings').put(recording);
  await tx.done;
  return recording;
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const db = await openNotesDb();
  return db.get('recordings', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 */
export async function updateRecording(
  id: string,
  patch: Partial<Omit<RecordingRecord, 'id'>>,
): Promise<RecordingRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('recordings', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Recording not found: ${id}`);
  }
  const merged: RecordingRecord = { ...existing, ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

export function setRecordingTranscript(
  id: string,
  transcript: AudioTranscriptRecord,
): Promise<RecordingRecord> {
  return updateRecording(id, { transcript });
}

/** Newest first, matching `listNotes`. Metadata only - the bytes stay in `recordingAudio`. */
export async function listRecordings(): Promise<RecordingRecord[]> {
  const db = await openNotesDb();
  const ascending = await db.getAllFromIndex('recordings', 'by-started');
  return ascending.reverse();
}

/** Oldest first: within one session, chronological order is the useful one. */
export async function listRecordingsBySession(sessionId: string): Promise<RecordingRecord[]> {
  const db = await openNotesDb();
  const recordings = await db.getAllFromIndex(
    'recordings',
    'by-session',
    IDBKeyRange.only(sessionId),
  );
  return recordings.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * K5: a recording created at start, before any chunk exists, so recovery can
 * find it by `endedAt === null` and knows its link, title and start time.
 * Newest first, matching `listRecordings`.
 */
export async function listUnfinishedRecordings(): Promise<RecordingRecord[]> {
  const all = await listRecordings();
  return all.filter((recording) => recording.endedAt === null);
}

/**
 * The complement of `listUnfinishedRecordings`: every recording whose
 * finalisation completed. Since K5, a `RecordingRecord` exists from the
 * moment recording starts, with `endedAt: null` and a zero-byte
 * `recordingAudio` row - so `listRecordings()` alone no longer means "ready to
 * use". Anything that treats a row as finished work (transcription, playback
 * lists, gap-analysis recording selection) must filter through this rather
 * than inventing its own `endedAt !== null` check. Newest first, matching
 * `listRecordings`.
 */
export async function listFinishedRecordings(): Promise<RecordingRecord[]> {
  const all = await listRecordings();
  return all.filter((recording) => recording.endedAt !== null);
}

/**
 * Every *finished* recording linked to a note, directly (`recording.noteId`)
 * or through the note's session (K12/A32: a session may hold several). This
 * is the one place that knows both link paths - lifted from `gaps/analyzer.ts`'s
 * module-private `candidateRecordings` (fix round 2, Fix 3a) so search has a
 * public way to attribute an audio-transcript hit back to a note without
 * re-deriving the two-path logic a second time. Anything that needs "this
 * note's recordings" should call this rather than inventing its own
 * `noteId`/`sessionId` check, the same instruction `listFinishedRecordings`
 * already carries for "finished work".
 *
 * Only *finished* recordings qualify (`listFinishedRecordings()`, not
 * `listRecordings()`): since K5 a `RecordingRecord` exists from the moment
 * recording starts, so a still-recording row would otherwise be read as
 * ready to use. Results are de-duplicated by id (a recording can match both
 * link paths at once) with no further ordering guarantee.
 *
 * This completeness depends on every recording carrying a numeric
 * `startedAt` - `listRecordings()` reads the `by-started` index, which skips
 * a row with an invalid key. `createRecording` always assigns one (see its
 * own comment), so that holds today; a future write path that bypasses
 * `createRecording` would silently break it.
 */
export async function recordingsForNote(noteId: string): Promise<RecordingRecord[]> {
  const note = await getNote(noteId);
  const finished = await listFinishedRecordings();
  const candidates = new Map<string, RecordingRecord>();
  for (const recording of finished) {
    const linkedDirectly = recording.noteId === noteId;
    const linkedViaSession =
      typeof note?.sessionId === 'string' && recording.sessionId === note.sessionId;
    if (linkedDirectly || linkedViaSession) candidates.set(recording.id, recording);
  }
  return [...candidates.values()];
}

/** Reconstructs the audio as a `Blob`; `null` when there are no bytes for that id. */
export async function getRecordingAudio(id: string): Promise<Blob | null> {
  const db = await openNotesDb();
  const record = await db.get('recordingAudio', id);
  if (!record) return null;
  return new Blob([record.data], { type: record.type });
}

/**
 * K6: the atomic close of a recording. Writes the stitched `audio`, patches
 * the row (`endedAt`, `durationMs`, `byteLength` derived from the blob, and
 * `mimeType` - defaulting to the blob's own type, same as `createRecording`)
 * and deletes that recording's chunk rows, all inside one transaction.
 *
 * Doing the three writes as one is what makes K6's ordering claim true by
 * construction ("chunks are only deleted once the stitched blob is durably
 * written"): with these as separate transactions, a crash between the audio
 * write and the chunk delete would leave a row with `endedAt === null`, zero
 * chunks, and a complete stitched recording already on disk - which startup
 * recovery (K7) would then read as an empty, abandoned row and delete, taking
 * a finished lecture with it. One transaction makes that window impossible:
 * either all three land, or none do.
 */
export async function finalizeRecording(
  id: string,
  audio: Blob,
  patch: { endedAt: number; durationMs: number; mimeType?: string },
): Promise<RecordingRecord> {
  const data = await audio.arrayBuffer();
  const type = patch.mimeType ?? audio.type;

  const db = await openNotesDb();
  const tx = db.transaction(['recordings', 'recordingAudio', 'recordingChunks'], 'readwrite');
  const recordings = tx.objectStore('recordings');
  const existing = await recordings.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Recording not found: ${id}`);
  }

  const merged: RecordingRecord = {
    ...existing,
    endedAt: patch.endedAt,
    durationMs: patch.durationMs,
    byteLength: data.byteLength,
    mimeType: type,
    id: existing.id,
  };

  await tx.objectStore('recordingAudio').put({ data, type }, id);
  await recordings.put(merged);

  // Same orphan-avoiding scan as `deleteRecording`: the index is on
  // `recordingId` only, so the keys are read back then deleted one by one.
  const chunkStore = tx.objectStore('recordingChunks');
  const keys = await chunkStore.index('by-recording').getAllKeys(IDBKeyRange.only(id));
  for (const key of keys) await chunkStore.delete(key);

  await tx.done;
  return merged;
}

/** Deletes the record, its bytes and any chunks left over, in one transaction. */
export async function deleteRecording(id: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(['recordings', 'recordingAudio', 'recordingChunks'], 'readwrite');
  await tx.objectStore('recordings').delete(id);
  await tx.objectStore('recordingAudio').delete(id);
  // A recording deleted while still open would otherwise leave its chunks
  // behind forever: nothing else scans for orphans.
  const chunkStore = tx.objectStore('recordingChunks');
  const keys = await chunkStore.index('by-recording').getAllKeys(IDBKeyRange.only(id));
  for (const key of keys) await chunkStore.delete(key);
  await tx.done;
}
