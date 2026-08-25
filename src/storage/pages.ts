import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { PageRecord, PageSource, PageStroke, TranscriptRecord } from '@/storage/types';

export interface CreatePageInput {
  noteId: string;
  pageIndex: number;
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
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
    capturedAt: Date.now(),
    render: null,
    renderType: null,
    renderW: null,
    renderH: null,
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

export async function listPages(noteId: string): Promise<PageRecord[]> {
  const db = await openNotesDb();
  const pages = await db.getAllFromIndex('pages', 'by-note', IDBKeyRange.only(noteId));
  return pages.sort((a, b) => a.pageIndex - b.pageIndex);
}

async function patchPage(
  id: string,
  patch: Partial<Omit<PageRecord, 'id'>>,
): Promise<PageRecord> {
  const db = await openNotesDb();
  const existing = await db.get('pages', id);
  if (!existing) {
    throw new Error(`Page not found: ${id}`);
  }
  const merged: PageRecord = { ...existing, ...patch, id: existing.id };
  await db.put('pages', merged);
  return merged;
}

export function setPageRender(
  id: string,
  render: ArrayBuffer,
  type: string,
  width: number,
  height: number,
): Promise<PageRecord> {
  return patchPage(id, { render, renderType: type, renderW: width, renderH: height });
}

export function setPageTranscript(
  id: string,
  transcript: TranscriptRecord,
): Promise<PageRecord> {
  return patchPage(id, { transcript });
}
