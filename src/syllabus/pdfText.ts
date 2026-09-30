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
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      // A wrong or corrupt file is the most likely failure and reaches the user.
      throw unreadable(err);
    }
    return await run(doc as never);
  } finally {
    await task.destroy();
  }
}

/**
 * The text of a PDF, page by page (architecture §6.5). A page whose text layer
 * is empty or near-empty comes back as `''` - a scanned page, not an error.
 */
export function extractPdfText(data: ArrayBuffer): Promise<string[]> {
  return withDocument(data, async (doc) => {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = (await doc.getPage(n)) as {
        getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      };
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        text += item.hasEOL === true ? '\n' : ' ';
      }
      const tidy = text
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim();
      pages.push(tidy.replace(/\s/g, '').length >= PAGE_TEXT_MIN_CHARS ? tidy : '');
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
    }
    return blobs;
  });
}
