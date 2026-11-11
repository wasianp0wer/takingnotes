import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type {
  GapAnalysisMeta,
  PageRecord,
  PageSource,
  PageStroke,
  TranscriptRecord,
} from '@/storage/types';

/**
 * A page's searchable text only, with no `strokes`, `render` or
 * `gapAnalysis` (fix round 2, Fix 3b). `listAllPageText`'s projection type.
 */
export interface PageTextProjection {
  id: string;
  noteId: string;
  pageIndex: number;
  /** The typed text, present only on a `source: 'typed'` page (K32). */
  text?: string;
  /** The transcribed (or, for a typed page, mirrored - K33) text, if any. */
  transcript: TranscriptRecord | null;
}

export interface CreatePageInput {
  noteId: string;
  pageIndex: number;
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
  /** Defaults to now; the legacy migration passes the recorded timestamp. */
  capturedAt?: number;
  /**
   * Defaults to `null` - a live page starts open. The legacy migration passes a
   * timestamp, because an imported ROM page is complete by definition and must
   * not look like a page that is still being written.
   */
  finalizedAt?: number | null;
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
    finalizedAt: input.finalizedAt ?? null,
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
 * Every page in the database, projected down to just its searchable text
 * (fix round 2, Fix 3b) - for a corpus-wide plain-text scan (S6), which has
 * no note to key a `by-note` lookup on and would otherwise mean one
 * `listPages` call per note plus every page's `strokes` loaded into memory
 * at once: for a semester, megabytes of ink held onto to search a few
 * kilobytes of text. `listPages` itself is unchanged and keeps returning
 * whole records - its callers (page navigation, transcription, gap
 * analysis) need the ink, this one doesn't.
 *
 * Still one scan of the whole `pages` store under the hood (`idb`/IndexedDB
 * has no server-side column projection), so the heavy fields are loaded
 * transiently either way; what this buys is a single bulk read instead of
 * one indexed query per note, and a result list a search can hold for its
 * whole run without also pinning every page's strokes in memory for that
 * same stretch.
 */
export async function listAllPageText(): Promise<PageTextProjection[]> {
  const db = await openNotesDb();
  const pages = await db.getAll('pages');
  return pages.map((page) => ({
    id: page.id,
    noteId: page.noteId,
    pageIndex: page.pageIndex,
    text: page.text,
    transcript: page.transcript,
  }));
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

/**
 * Records the outcome of a gap analysis of this page (docs/architecture.md
 * §6.1). Replaces whatever was there: only the last run is interesting, and the
 * suggestions it produced live in the `gaps` store. `null` puts the page back to
 * never-analyzed.
 */
export function setPageGapAnalysis(
  id: string,
  meta: GapAnalysisMeta | null,
): Promise<PageRecord> {
  return patchPage(id, { gapAnalysis: meta });
}

/**
 * Replaces the page's strokes and recomputes `pointCount`. Live capture calls
 * this repeatedly with a growing array (pen-up plus a periodic flush), so it
 * replaces rather than appends: re-flushing the same strokes is then a no-op
 * instead of a duplication, and a stroke that was trimmed locally disappears.
 */
export function setPageStrokes(id: string, strokes: PageStroke[]): Promise<PageRecord> {
  return patchPage(id, { strokes, pointCount: countPoints(strokes) });
}

/**
 * The single reading of `finalizedAt`'s documented default: absent (a v1 row,
 * written before the field existed) means finalized, because a legacy page is
 * complete by definition. Only an explicit `null` is an open page.
 */
export function isPageFinalized(page: PageRecord): boolean {
  return page.finalizedAt !== null;
}

/**
 * Marks the page as closed to further strokes. Leaves an already-finalized page
 * untouched: startup recovery finalizes whatever was left open, and it must not
 * move the mark on a page that was closed properly (which would re-date it for
 * anything keyed on the finalize moment).
 */
export async function finalizePage(id: string, at: number): Promise<PageRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('pages', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page not found: ${id}`);
  }
  if (isPageFinalized(existing)) {
    await tx.done;
    return existing;
  }
  const merged: PageRecord = { ...existing, finalizedAt: at };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/** K33: a typed page's "transcription" is the typing itself. */
export const TYPED_MODEL = 'typed';
export const TYPED_PROMPT_VERSION = 'typed/1';

export function isTypedPage(page: PageRecord): boolean {
  return page.source === 'typed';
}

export interface CreateTypedPageInput {
  noteId: string;
  pageIndex: number;
  /** Defaults to empty - the editor opens blank and autosaves. */
  text?: string;
  capturedAt?: number;
}

/**
 * A typed page (K32): no strokes, no device page number, and its text mirrored
 * into `transcript` by `setPageText` so every existing consumer of page text -
 * search, gap analysis - reads the one field it already knows about (K33).
 */
export async function createTypedPage(input: CreateTypedPageInput): Promise<PageRecord> {
  const page = await createPage({
    noteId: input.noteId,
    pageIndex: input.pageIndex,
    devicePageNum: null,
    source: 'typed',
    strokes: [],
    capturedAt: input.capturedAt,
  });
  return setPageText(page.id, input.text ?? '');
}

/**
 * Writes a typed page's text and mirrors it into the transcript.
 *
 * Blank text leaves `transcript: null` rather than writing a `'done'`
 * transcript with empty markdown: a contentless "finished" transcript would
 * reach smart search as a real document and gap analysis as a page worth
 * comparing, when A22 already says a contentless page is skipped.
 */
export async function setPageText(id: string, text: string): Promise<PageRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('pages', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page not found: ${id}`);
  }
  if (!isTypedPage(existing)) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page ${id} is not a typed page`);
  }

  const markdown = text.trim();
  const transcript: TranscriptRecord | null =
    markdown === ''
      ? null
      : {
          markdown,
          model: TYPED_MODEL,
          promptVersion: TYPED_PROMPT_VERSION,
          status: 'done',
          error: null,
          updatedAt: Date.now(),
        };

  const merged: PageRecord = { ...existing, text, transcript };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/**
 * True when a page holds nothing yet, so switching it between handwritten and
 * typed can replace it in place instead of leaving an empty page behind. Only
 * an *open* page qualifies (a finalized page is history, however empty), and
 * anything that could hang off a page disqualifies it: a stroke, non-blank
 * typed text (whitespace only counts as blank, as it does in `setPageText`), a
 * transcript, a render or a gap analysis.
 */
export function isBlankPage(page: PageRecord): boolean {
  return (
    page.finalizedAt === null &&
    page.strokes.length === 0 &&
    (page.text ?? '').trim() === '' &&
    page.transcript === null &&
    page.render === null &&
    !page.gapAnalysis
  );
}

export interface ReplaceBlankPageInput {
  source: 'live' | 'typed';
  devicePageNum: number | null;
  /** Ink the new page starts with - the stroke that triggered a typed-to-live switch. */
  strokes: PageStroke[];
  capturedAt: number;
}

/**
 * Re-creates a blank page as a fresh page of the given kind under the same id,
 * note and `pageIndex`, so nothing that refers to it is left dangling. The
 * blank check and the write share one transaction, so a write that gave the
 * page content first (a typed-page autosave) wins and this returns `null`
 * without touching it - as it also does for a missing page.
 */
export async function replaceBlankPage(
  id: string,
  input: ReplaceBlankPageInput,
): Promise<PageRecord | null> {
  const db = await openNotesDb();
  const tx = db.transaction('pages', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing || !isBlankPage(existing)) {
    await tx.done;
    return null;
  }
  const page: PageRecord = {
    id: existing.id,
    noteId: existing.noteId,
    pageIndex: existing.pageIndex,
    devicePageNum: input.devicePageNum,
    source: input.source,
    strokes: input.strokes,
    pointCount: countPoints(input.strokes),
    capturedAt: input.capturedAt,
    render: null,
    transcript: null,
    finalizedAt: null,
    ...(input.source === 'typed' ? { text: '' } : {}),
  };
  await tx.store.put(page);
  await tx.done;
  return page;
}

/**
 * When a page last received writing: the latest stroke end, falling back to
 * `capturedAt` for a page whose strokes carry no timestamps (ROM, legacy, or a
 * typed page). Shared by startup recovery and by `resumeNote`, both of which
 * must finalize an interrupted page at the time the writing stopped rather than
 * at the time the app noticed - a `finalizedAt` of "now", days later, would
 * stretch that page's gap-analysis speech window across the whole gap.
 */
export function pageEndedAt(page: PageRecord): number {
  let latest = 0;
  for (const stroke of page.strokes) {
    if (stroke.endedAt !== undefined && stroke.endedAt > latest) latest = stroke.endedAt;
  }
  return latest > 0 ? latest : page.capturedAt;
}
