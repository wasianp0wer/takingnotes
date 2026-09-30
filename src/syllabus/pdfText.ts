import { loadPdfjs } from '@/syllabus/pdfjs';

/**
 * Below this many non-whitespace characters a page has nothing to extract and is
 * treated as scanned (P2-A4): it goes through the vision path instead. The floor
 * is high enough to clear a scan whose only text layer is a running footer such
 * as "Page 3 of 9" - counting that as text would keep the page away from the
 * vision model and silently lose its assignments.
 */
export const PAGE_TEXT_MIN_CHARS = 16;

/** Long edge in px for a scanned page render. Above Phase 1's 768 legibility floor. */
export const DEFAULT_PAGE_LONG_EDGE = 1400;

/** A drawing surface plus a way to get a PNG out of it, so tests need no real canvas. */
export interface PageCanvas {
  canvas: unknown;
  context: unknown;
  toBlob(): Promise<Blob>;
}

export type MakeCanvas = (width: number, height: number) => PageCanvas;

export interface RenderPagesOptions {
  longEdge?: number;
  makeCanvas?: MakeCanvas;
}

/**
 * pdf.js may transfer the bytes to its worker, which detaches the caller's
 * ArrayBuffer (P2-A12). Every open gets its own copy so a PDF can be read for
 * text and then rendered.
 */
const copy = (data: ArrayBuffer): Uint8Array => new Uint8Array(data.slice(0));

const unreadable = (err: unknown): Error =>
  new Error(
    `That file could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
  );

async function withDocument<T>(
  data: ArrayBuffer,
  run: (doc: {
    numPages: number;
    getPage(n: number): Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: copy(data) });
  let result: T;
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      // A wrong or corrupt file is the most likely failure and reaches the user.
      throw unreadable(err);
    }
    result = await run(doc as never);
  } catch (err) {
    // Still release the worker - without it each call leaks one - but why the call
    // failed is what the user needs to see, so a destroy that also fails must not
    // replace the cause on its way out.
    await task.destroy().catch(() => {});
    throw err;
  }
  // Nothing else went wrong, so a failure to release the worker is worth reporting.
  await task.destroy();
  return result;
}

/** A pdf.js text item. `transform[4]`/`[5]` are the item's x/y on the page. */
interface TextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

/** Where an item sits, once we know it reported usable geometry. */
interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A y shift of more than half a line height means pdf.js moved to the next line. */
const LINE_BREAK_FRACTION = 0.5;

/** A horizontal gap wider than this share of the line height is a word break. */
const WORD_GAP_FRACTION = 0.2;

function placementOf(item: TextItem): Placed | null {
  const t = item.transform;
  if (!Array.isArray(t) || typeof t[4] !== 'number' || typeof t[5] !== 'number') return null;
  if (typeof item.width !== 'number' || typeof item.height !== 'number') return null;
  if (!(item.height > 0)) return null;
  return { x: t[4], y: t[5], width: item.width, height: item.height };
}

/**
 * What goes between two text items.
 *
 * `hasEOL` alone is not enough: pdf.js does not set it reliably, so a deadline
 * table can arrive as one run of items and collapse into a single line, which puts
 * one row's date next to another row's assignment. Geometry is the authoritative
 * signal - a y change ends a line - and it also stops the opposite error: pdf.js
 * splits a run mid-word on a font change or kerning, and a blanket space between
 * items would turn "Sept" + "ember 15" into "Sept ember 15", a date that matches
 * nothing and a deadline silently lost. Items with no usable geometry fall back to
 * `hasEOL`, then a space.
 */
function separatorBetween(
  prev: { placed: Placed | null; hasEOL: boolean },
  next: Placed | null,
): string {
  const here = prev.placed;
  if (here === null || next === null) return prev.hasEOL ? '\n' : ' ';

  const lineHeight = Math.max(here.height, next.height);
  if (prev.hasEOL) return '\n';
  if (Math.abs(next.y - here.y) > lineHeight * LINE_BREAK_FRACTION) return '\n';

  // Same line: a space only where the glyphs really are apart.
  const gap = next.x - (here.x + here.width);
  return gap > lineHeight * WORD_GAP_FRACTION ? ' ' : '';
}

function assemblePageText(items: TextItem[]): string {
  let text = '';
  let prev: { placed: Placed | null; hasEOL: boolean } | null = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const placed = placementOf(item);
    if (prev !== null) text += separatorBetween(prev, placed);
    text += item.str;
    prev = { placed, hasEOL: item.hasEOL === true };
  }
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/**
 * The text of a PDF, page by page (architecture §6.5), with lines and words taken
 * from item geometry (see `separatorBetween`) so a deadline table keeps each row on
 * its own line. A page whose text layer is empty or near-empty comes back as `''` -
 * a scanned page, not an error.
 */
export function extractPdfText(data: ArrayBuffer): Promise<string[]> {
  return withDocument(data, async (doc) => {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = (await doc.getPage(n)) as {
        getTextContent(): Promise<{ items: TextItem[] }>;
        cleanup?(): unknown;
      };
      const { items } = await page.getTextContent();
      const tidy = assemblePageText(items);
      pages.push(tidy.replace(/\s/g, '').length >= PAGE_TEXT_MIN_CHARS ? tidy : '');
      // pdf.js keeps each page proxy's parsed content on the document until destroy,
      // so a 60-page scan would hold 60 pages of it for nothing.
      page.cleanup?.();
    }
    return pages;
  });
}

const defaultMakeCanvas: MakeCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D canvas context to render the page');
  return {
    canvas,
    context,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Page render produced no image'))),
          'image/png',
        );
      }),
  };
};

/**
 * Renders 1-based `pageNumbers` to PNGs, for the pages with no usable text layer.
 * The result is index-aligned with `pageNumbers`, so a caller can pair `images[i]`
 * with the i-th page it asked for. A page number the document does not have throws
 * rather than being skipped: skipping would shorten the array and shift every
 * later pairing, attaching one page's image to another page's text.
 */
export function renderPdfPages(
  data: ArrayBuffer,
  pageNumbers: number[],
  opts?: RenderPagesOptions,
): Promise<Blob[]> {
  const longEdge = opts?.longEdge ?? DEFAULT_PAGE_LONG_EDGE;
  const makeCanvas = opts?.makeCanvas ?? defaultMakeCanvas;

  return withDocument(data, async (doc) => {
    const blobs: Blob[] = [];
    for (const n of pageNumbers) {
      if (n < 1 || n > doc.numPages) {
        throw new Error(
          `Cannot render page ${n}: this PDF has ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`,
        );
      }
      const page = (await doc.getPage(n)) as {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: { canvasContext: unknown; viewport: unknown; canvas?: unknown }): {
          promise: Promise<void>;
        };
        cleanup?(): unknown;
      };
      const base = page.getViewport({ scale: 1 });
      const scale = longEdge / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const surface = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
      await page.render({
        canvasContext: surface.context,
        canvas: surface.canvas,
        viewport,
      }).promise;
      blobs.push(await surface.toBlob());
      // Drops the page's parsed content, which pdf.js would otherwise hold until
      // destroy - a whole scanned syllabus' worth of it by the last page.
      page.cleanup?.();
    }
    return blobs;
  });
}
