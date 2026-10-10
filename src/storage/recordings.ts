import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
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

/** Reconstructs the audio as a `Blob`; `null` when there are no bytes for that id. */
export async function getRecordingAudio(id: string): Promise<Blob | null> {
  const db = await openNotesDb();
  const record = await db.get('recordingAudio', id);
  if (!record) return null;
  return new Blob([record.data], { type: record.type });
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
