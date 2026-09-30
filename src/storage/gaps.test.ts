import { beforeEach, describe, expect, it } from 'vitest';

import {
  createGap,
  createGaps,
  deleteGapsByPage,
  getGap,
  listGapsByNote,
  listGapsByPage,
  updateGap,
  type CreateGapInput,
} from '@/storage/gaps';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

function input(overrides: Partial<CreateGapInput> = {}): CreateGapInput {
  return {
    noteId: 'note-1',
    pageId: 'page-1',
    recordingId: 'rec-1',
    fromMs: 1_000,
    toMs: 2_000,
    text: 'Transhumance peaked in the 1450s',
    kind: 'claim',
    sourceQuote: 'so transhumance really peaks in the fourteen fifties',
    model: 'gemma4:12b',
    promptVersion: 'gap-gemma-v1',
    ...overrides,
  };
}

describe('gaps repository', () => {
  it('creates a suggestion as proposed, with timestamps and no summarization', async () => {
    const gap = await createGap(input());

    expect(gap.id).toBeTruthy();
    expect(gap.status).toBe('proposed');
    expect(gap.summarized).toBe(false);
    expect(gap.kind).toBe('claim');
    expect(gap.createdAt).toBeGreaterThan(0);
    expect(gap.updatedAt).toBe(gap.createdAt);
    expect(await getGap(gap.id)).toEqual(gap);
  });

  it('honours explicit status, summarized and timestamps', async () => {
    const gap = await createGap(
      input({ status: 'accepted', summarized: true, createdAt: 10, updatedAt: 20 }),
    );

    expect(gap).toMatchObject({
      status: 'accepted',
      summarized: true,
      createdAt: 10,
      updatedAt: 20,
    });
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getGap('nope')).toBeUndefined();
  });

  it('writes a batch in one transaction and returns the records', async () => {
    const written = await createGaps([
      input({ text: 'first', createdAt: 1 }),
      input({ text: 'second', kind: 'definition', createdAt: 2 }),
    ]);

    expect(written.map((g) => g.text)).toEqual(['first', 'second']);
    expect(new Set(written.map((g) => g.id)).size).toBe(2);
    expect(await listGapsByPage('page-1')).toHaveLength(2);
  });

  it('writes nothing for an empty batch', async () => {
    expect(await createGaps([])).toEqual([]);
    expect(await listGapsByPage('page-1')).toEqual([]);
  });

  it('updates a suggestion and bumps updatedAt', async () => {
    const gap = await createGap(input({ createdAt: 10, updatedAt: 10 }));

    const updated = await updateGap(gap.id, { status: 'rejected' });

    expect(updated.status).toBe('rejected');
    expect(updated.id).toBe(gap.id);
    expect(updated.updatedAt).toBeGreaterThan(10);
    expect(await getGap(gap.id)).toEqual(updated);
  });

  it('lets a caller pin updatedAt in the patch', async () => {
    const gap = await createGap(input());
    const updated = await updateGap(gap.id, { status: 'accepted', updatedAt: 5 });
    expect(updated.updatedAt).toBe(5);
  });

  it('rejects an update to a missing suggestion', async () => {
    await expect(updateGap('nope', { status: 'accepted' })).rejects.toThrow(
      'Gap not found: nope',
    );
  });

  it('lists a note’s suggestions oldest first, across its pages', async () => {
    await createGaps([
      input({ pageId: 'page-2', text: 'later', createdAt: 200 }),
      input({ pageId: 'page-1', text: 'earlier', createdAt: 100 }),
      input({ noteId: 'note-2', pageId: 'page-9', text: 'other note', createdAt: 150 }),
    ]);

    expect((await listGapsByNote('note-1')).map((g) => g.text)).toEqual([
      'earlier',
      'later',
    ]);
    expect((await listGapsByNote('note-2')).map((g) => g.text)).toEqual(['other note']);
    expect(await listGapsByNote('note-3')).toEqual([]);
  });

  it('lists one page’s suggestions in creation order', async () => {
    await createGaps([
      input({ text: 'a', createdAt: 1 }),
      input({ text: 'b', createdAt: 2 }),
      input({ pageId: 'page-2', text: 'elsewhere', createdAt: 3 }),
    ]);

    expect((await listGapsByPage('page-1')).map((g) => g.text)).toEqual(['a', 'b']);
  });

  it('deletes only the requested status when one is given', async () => {
    // A23: a re-run replaces proposed suggestions and leaves accepted and
    // rejected ones alone, so a rejected point does not come back.
    await createGaps([
      input({ text: 'proposed', status: 'proposed' }),
      input({ text: 'accepted', status: 'accepted' }),
      input({ text: 'rejected', status: 'rejected' }),
      input({ pageId: 'page-2', text: 'other page', status: 'proposed' }),
    ]);

    const deleted = await deleteGapsByPage('page-1', 'proposed');

    expect(deleted).toBe(1);
    expect((await listGapsByPage('page-1')).map((g) => g.text).sort()).toEqual([
      'accepted',
      'rejected',
    ]);
    expect(await listGapsByPage('page-2')).toHaveLength(1);
  });

  it('deletes every suggestion of a page when no status is given', async () => {
    await createGaps([
      input({ text: 'proposed' }),
      input({ text: 'accepted', status: 'accepted' }),
    ]);

    expect(await deleteGapsByPage('page-1')).toBe(2);
    expect(await listGapsByPage('page-1')).toEqual([]);
  });

  it('deletes nothing for a page with no suggestions', async () => {
    expect(await deleteGapsByPage('page-1', 'proposed')).toBe(0);
  });
});
