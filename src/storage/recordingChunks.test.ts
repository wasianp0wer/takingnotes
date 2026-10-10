import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendRecordingChunk,
  deleteRecordingChunks,
  listRecordingChunks,
  stitchRecordingChunks,
} from '@/storage/recordingChunks';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

const TYPE = 'audio/webm;codecs=opus';

function chunk(text: string): Blob {
  return new Blob([text], { type: TYPE });
}

/**
 * `Blob.text()` is not used anywhere in this repo, so it is not known to work
 * under happy-dom; `arrayBuffer()` is (see `pages.test.ts:99`,
 * `recordings.test.ts:56`). Decode through that instead.
 */
async function textOf(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

describe('recording chunks', () => {
  it('appends and lists in seq order', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-1', 1, chunk('b'));
    const chunks = await listRecordingChunks('rec-1');
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks[0].type).toBe(TYPE);
  });

  it('keeps recordings apart', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-2', 0, chunk('z'));
    expect(await listRecordingChunks('rec-1')).toHaveLength(1);
    expect(await listRecordingChunks('rec-2')).toHaveLength(1);
  });

  it('stitches in seq order regardless of write order', async () => {
    // Write chunks out of seq order, including multi-digit seq values to catch
    // lexicographic vs numeric ordering bugs. Seq 10 is crucial: lexicographically
    // it sorts between 1 and 2, but numerically it comes after all single digits.
    const expected = 'abcdefghijk';
    const seqs = [2, 0, 10, 1, 5, 3, 9, 4, 7, 6, 8];
    for (const seq of seqs) {
      await appendRecordingChunk('rec-1', seq, chunk(expected[seq]));
    }
    const blob = await stitchRecordingChunks('rec-1');
    expect(blob).not.toBeNull();
    expect(await textOf(blob!)).toBe(expected);
    expect(blob!.type).toBe(TYPE);
  });

  it('stitches across a hole left by a failed write', async () => {
    // A dropped chunk is a hole that cannot be filled. Refusing to stitch
    // would turn one lost second into a lost lecture.
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-1', 2, chunk('c'));
    const blob = await stitchRecordingChunks('rec-1');
    expect(await textOf(blob!)).toBe('ac');
  });

  it('stitches nothing to null', async () => {
    expect(await stitchRecordingChunks('rec-nope')).toBeNull();
  });

  it('deletes one recording\'s chunks and leaves the others', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-2', 0, chunk('z'));
    await deleteRecordingChunks('rec-1');
    expect(await listRecordingChunks('rec-1')).toEqual([]);
    expect(await listRecordingChunks('rec-2')).toHaveLength(1);
  });
});
