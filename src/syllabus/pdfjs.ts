// `?url` makes Vite emit the worker as a local asset and hand back its URL, so
// pdf.js never reaches for a CDN and the app keeps working offline (A29). The
// import itself costs nothing: it compiles to a string.
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

/** Where the bundled pdf.js worker is served from. Always same-origin. */
export const PDF_WORKER_URL: string = workerUrl;

type Pdfjs = typeof import('pdfjs-dist');

let loading: Promise<Pdfjs> | null = null;

/**
 * Loads pdf.js on demand and points it at the bundled worker.
 *
 * Dynamically imported, and cached after the first call: pdf.js is ~1 MB, and
 * nothing but a syllabus import needs it, so it must not sit in the entry chunk
 * that every page load pays for.
 */
export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    return pdfjs;
  });
  return loading;
}

/**
 * The smallest PDF pdf.js will open: one empty page, and no cross-reference
 * table (pdf.js rebuilds one, which is also how it copes with the real
 * syllabuses that come out of a word processor).
 */
function minimalPdf(): Uint8Array {
  return new TextEncoder().encode(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
      'trailer << /Root 1 0 R /Size 4 >>',
      '%%EOF',
      '',
    ].join('\n'),
  );
}

export interface PdfSupport {
  version: string;
  pages: number;
}

/**
 * Opens an in-memory PDF and reports what pdf.js read. Trivial on purpose: it
 * exists so a build problem (a worker that was not emitted, or one that only
 * loads from a CDN) shows up here rather than inside P2's extraction path.
 */
export async function pdfSupportProbe(): Promise<PdfSupport> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: minimalPdf() });
  try {
    const doc = await task.promise;
    return { version: pdfjs.version, pages: doc.numPages };
  } finally {
    // Releases the worker; without it each probe leaks one.
    await task.destroy();
  }
}

/** Test-only: forgets the cached module so a test can observe a fresh load. */
export function resetPdfjsForTests(): void {
  loading = null;
}
