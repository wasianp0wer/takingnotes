import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { PageRecord, PageSource, PageStroke, TranscriptRecord } from '@/storage/types';

export interface CreatePageInput {
  noteId: string;
  pageIndex: number;
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
  /** Defaults to now; the legacy migration passes the recorded timestamp. */
  capturedAt?: number;
}

export function countPoints(strokes: PageStroke[]): number {
  return strokes.reduce((total, stroke) => total + stroke.points.length, 0);
}

export async function createPage(input: CreatePageInput): Promise<PageRecord> {
  const page: PageRecord = {
    id: newId(),
    noteId: input.noteId,
    pageIndex: input.pageIndex,
    devicePageNum: input.devicePageNum,
    source: input.source,
    strokes: input.strokes,
    pointCount: countPoints(input.strokes),
    capturedAt: input.capturedAt ?? Date.now(),
    render: null,
    transcript: null,
  };

  const db = await openNotesDb();
  await db.put('pages', page);
  return page;
}

export async function getPage(id: string): Promise<PageRecord | undefined> {
  const db = await openNotesDb();
  return db.get('pages', id);
}

/** Returns page metadata only - image bytes stay in the `pageRenders` store. */
export async function listPages(noteId: string): Promise<PageRecord[]> {
  const db = await openNotesDb();
  const pages = await db.getAllFromIndex('pages', 'by-note', IDBKeyRange.only(noteId));
  return pages.sort((a, b) => a.pageIndex - b.pageIndex);
}

/**
 * Read-modify-write inside a single transaction. Two implicit transactions
 * (a `get` then a `put`) would let a concurrent update land in between and be
 * silently overwritten.
 */
async function patchPage(
  id: string,
  patch: Partial<Omit<PageRecord, 'id'>>,
): Promise<PageRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('pages', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page not found: ${id}`);
  }
  const merged: PageRecord = { ...existing, ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/**
 * Stores a rendered page image. Takes a `Blob` so callers never have to reason
 * about byte offsets - passing `someUint8Array.buffer` would silently store the
 * whole backing buffer rather than the intended view. `ArrayBuffer` is the
 * on-disk shape only (spec D7) and never crosses this boundary.
 */
export async function setPageRender(
  id: string,
  blob: Blob,
  width: number,
  height: number,
): Promise<PageRecord> {
  const data = await blob.arrayBuffer();
  const type = blob.type;

  const db = await openNotesDb();
  const tx = db.transaction(['pages', 'pageRenders'], 'readwrite');
  const pages = tx.objectStore('pages');
  const existing = await pages.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page not found: ${id}`);
  }

  const merged: PageRecord = { ...existing, render: { type, width, height }, id: existing.id };
  await tx.objectStore('pageRenders').put({ data, type, width, height }, id);
  await pages.put(merged);
  await tx.done;
  return merged;
}

/** Reconstructs the render as a `Blob`; `null` when the page has no render. */
export async function getPageRender(id: string): Promise<Blob | null> {
  const db = await openNotesDb();
  const record = await db.get('pageRenders', id);
  if (!record) return null;
  return new Blob([record.data], { type: record.type });
}

export function setPageTranscript(
  id: string,
  transcript: TranscriptRecord,
): Promise<PageRecord> {
  return patchPage(id, { transcript });
}
