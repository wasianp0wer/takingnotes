import { openNotesDb } from '@/storage/db';
import type { RecordingChunkRecord } from '@/storage/types';

/**
 * The `recordingChunks` store (K4-K6): one `MediaRecorder` chunk per row,
 * written as it arrives so an interruption costs at most one timeslice of
 * audio. Chunks are transient - `stop()` stitches them into `recordingAudio`
 * and deletes them - so a row surviving a reload means a recording that was
 * interrupted, which is exactly what startup recovery looks for.
 *
 * The id is `<recordingId>:<seq>` rather than a random one: a retried write of
 * the same chunk then overwrites itself instead of duplicating a second of
 * audio into the stitched file.
 */
function chunkId(recordingId: string, seq: number): string {
  return `${recordingId}:${seq}`;
}

export async function appendRecordingChunk(
  recordingId: string,
  seq: number,
  blob: Blob,
): Promise<void> {
  const data = await blob.arrayBuffer();
  const record: RecordingChunkRecord = {
    id: chunkId(recordingId, seq),
    recordingId,
    seq,
    data,
    type: blob.type,
  };
  const db = await openNotesDb();
  await db.put('recordingChunks', record);
}

/**
 * `seq`-ordered, which is stitch order. The index is on `recordingId` only.
 * The primary key is `<recordingId>:<seq>` as a string, so index results come
 * back ordered lexicographically: past nine chunks, "rec:10" sorts before
 * "rec:2", making the sort essential for correctness in any recording longer
 * than nine seconds.
 */
export async function listRecordingChunks(
  recordingId: string,
): Promise<RecordingChunkRecord[]> {
  const db = await openNotesDb();
  const chunks = await db.getAllFromIndex(
    'recordingChunks',
    'by-recording',
    IDBKeyRange.only(recordingId),
  );
  return chunks.sort((a, b) => a.seq - b.seq);
}

/**
 * Concatenates a recording's chunks in `seq` order, or `null` when it has none.
 *
 * A hole in the sequence (a write that failed) is concatenated across rather
 * than treated as an error: the missing second is unrecoverable either way, and
 * refusing to stitch would discard every second that did land.
 */
export async function stitchRecordingChunks(recordingId: string): Promise<Blob | null> {
  const chunks = await listRecordingChunks(recordingId);
  if (chunks.length === 0) return null;
  return new Blob(
    chunks.map((c) => c.data),
    { type: chunks[0].type },
  );
}

export async function deleteRecordingChunks(recordingId: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction('recordingChunks', 'readwrite');
  const keys = await tx.store.index('by-recording').getAllKeys(IDBKeyRange.only(recordingId));
  for (const key of keys) await tx.store.delete(key);
  await tx.done;
}
