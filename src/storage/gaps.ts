import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { GapKind, GapStatus, GapSuggestionRecord } from '@/storage/types';

export interface CreateGapInput {
  noteId: string;
  pageId: string;
  recordingId: string;
  /** Absolute epoch ms window of speech this point was found in. */
  fromMs: number;
  toMs: number;
  text: string;
  kind: GapKind;
  sourceQuote: string;
  model: string;
  promptVersion: string;
  /** Defaults to `'proposed'`: a fresh suggestion has not been reviewed yet. */
  status?: GapStatus;
  /** Defaults to `false`; true when the speech was summarized first (J5). */
  summarized?: boolean;
  /**
   * Offsets from the recording's start, in ms, of the speech the quote came
   * from. Absent → fall back to fromMs/toMs.
   */
  quoteStartMs?: number;
  quoteEndMs?: number;
  /** Tests and a replay pass these; live creation lets them default to now. */
  createdAt?: number;
  updatedAt?: number;
}

function buildGap(input: CreateGapInput, now: number): GapSuggestionRecord {
  return {
    id: newId(),
    noteId: input.noteId,
    pageId: input.pageId,
    recordingId: input.recordingId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    text: input.text,
    kind: input.kind,
    sourceQuote: input.sourceQuote,
    status: input.status ?? 'proposed',
    model: input.model,
    promptVersion: input.promptVersion,
    summarized: input.summarized ?? false,
    ...(input.quoteStartMs !== undefined && { quoteStartMs: input.quoteStartMs }),
    ...(input.quoteEndMs !== undefined && { quoteEndMs: input.quoteEndMs }),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  };
}

export async function createGap(input: CreateGapInput): Promise<GapSuggestionRecord> {
  const gap = buildGap(input, Date.now());
  const db = await openNotesDb();
  await db.put('gaps', gap);
  return gap;
}

/**
 * Writes a whole analysis in one transaction. One page's suggestions are
 * produced together and reviewed as a set, so a half-written batch - some
 * points on disk, the rest lost to a failed write - would look to the UI like
 * an analysis that found less than it did.
 */
export async function createGaps(
  inputs: CreateGapInput[],
): Promise<GapSuggestionRecord[]> {
  if (inputs.length === 0) return [];
  const now = Date.now();
  const gaps = inputs.map((input) => buildGap(input, now));

  const db = await openNotesDb();
  const tx = db.transaction('gaps', 'readwrite');
  for (const gap of gaps) await tx.store.put(gap);
  await tx.done;
  return gaps;
}

export async function getGap(id: string): Promise<GapSuggestionRecord | undefined> {
  const db = await openNotesDb();
  return db.get('gaps', id);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 *
 * `updatedAt` is maintained here rather than by every caller, as in
 * `updateEvent`: accept and reject are the only writes this record ever gets,
 * and one of them forgetting to bump it would make a review invisible. A caller
 * that needs a specific value can still pass it in the patch.
 */
export async function updateGap(
  id: string,
  patch: Partial<Omit<GapSuggestionRecord, 'id'>>,
): Promise<GapSuggestionRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('gaps', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Gap not found: ${id}`);
  }
  const merged: GapSuggestionRecord = {
    ...existing,
    updatedAt: Date.now(),
    ...patch,
    id: existing.id,
  };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/**
 * Applies review decisions all-or-nothing, in one transaction: when any id is
 * missing or no longer `proposed` (a re-run replaced it, or it was already
 * reviewed), nothing is written and `staleError()` is thrown. Resolves to the
 * updated records in the order given.
 */
export async function reviewProposedGaps(
  decisions: Map<string, Exclude<GapStatus, 'proposed'>>,
  staleError: () => Error,
): Promise<GapSuggestionRecord[]> {
  if (decisions.size === 0) return [];
  const db = await openNotesDb();
  const tx = db.transaction('gaps', 'readwrite');
  const now = Date.now();
  const updated: GapSuggestionRecord[] = [];
  for (const [id, status] of decisions) {
    const gap = await tx.store.get(id);
    if (!gap || gap.status !== 'proposed') {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw staleError();
    }
    updated.push({ ...gap, status, updatedAt: now });
  }
  for (const gap of updated) await tx.store.put(gap);
  await tx.done;
  return updated;
}

/**
 * Oldest first: suggestions are read in the order the model produced them, so
 * they line up with the page (and, across a note, with its pages). `id` breaks
 * a tie, because a batch shares one `createdAt` and index order is by random
 * primary key - without it, the same analysis could list in a different order
 * on every read.
 */
function byCreation(a: GapSuggestionRecord, b: GapSuggestionRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function listGapsByNote(noteId: string): Promise<GapSuggestionRecord[]> {
  const db = await openNotesDb();
  const gaps = await db.getAllFromIndex('gaps', 'by-note', IDBKeyRange.only(noteId));
  return gaps.sort(byCreation);
}

export async function listGapsByPage(pageId: string): Promise<GapSuggestionRecord[]> {
  const db = await openNotesDb();
  const gaps = await db.getAllFromIndex('gaps', 'by-page', IDBKeyRange.only(pageId));
  return gaps.sort(byCreation);
}

/**
 * Deletes a page's suggestions and reports how many went. A re-run of gap
 * analysis passes `'proposed'` (A23): accepted points are content the user kept
 * and rejected ones must not resurface. Omitting the status deletes the lot,
 * which is what discarding a page's whole analysis means.
 */
export async function deleteGapsByPage(
  pageId: string,
  status?: GapStatus,
): Promise<number> {
  const db = await openNotesDb();
  const tx = db.transaction('gaps', 'readwrite');
  // A cursor over the index rather than a list-then-delete: the read and the
  // deletes then share one transaction, so nothing can be added in between and
  // survive a run that was meant to clear it.
  let cursor = await tx.store.index('by-page').openCursor(IDBKeyRange.only(pageId));
  let deleted = 0;
  while (cursor) {
    if (status === undefined || cursor.value.status === status) {
      await cursor.delete();
      deleted += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}
