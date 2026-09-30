import type { TextGenerator } from '@/llm/ollamaText';
import {
  dedupeAssignments,
  parseAssignments,
  type ExtractedAssignment,
} from '@/syllabus/assignments';
import { chunkSyllabusText } from '@/syllabus/chunk';
import { extractPdfText, renderPdfPages } from '@/syllabus/pdfText';
import { getSyllabusPromptFor } from '@/syllabus/prompts';
import type { SyllabusPageReader } from '@/syllabus/vision';

/** What the UI shows while an import is working. */
export type ExtractProgress =
  | { phase: 'reading-pdf'; page: number; pages: number }
  | { phase: 'reading-page-image'; page: number; pages: number }
  | { phase: 'extracting'; chunk: number; chunks: number };

export interface ExtractOptions {
  model: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExtractProgress) => void;
}

/** Architecture §6.5. A PDF and a paste behave identically past the first step. */
export interface SyllabusExtractor {
  fromText(text: string, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
  fromPdf(data: ArrayBuffer, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
}

export interface SyllabusExtractorOptions {
  generator: TextGenerator;
  /** Absent means a scanned page is skipped rather than failing the import. */
  pageReader?: SyllabusPageReader;
  /** Resolves a date with no year. Null means "against today" (P2-A10). */
  termStart?: number | null;
  now?: () => number;
  extractText?: typeof extractPdfText;
  renderPages?: typeof renderPdfPages;
  numPredict?: number;
}

const abortError = (): Error => {
  const err = new Error('Extraction aborted');
  err.name = 'AbortError';
  return err;
};

/**
 * One notion of "this page has no text", used both to decide what goes to the
 * vision reader and to decide what is worth sending to the model. Two different
 * predicates would let a whitespace-only page fall between them: neither
 * recovered nor included, and gone with nothing said about it.
 */
const isBlankPage = (text: string): boolean => text.trim() === '';

export function createSyllabusExtractor(opts: SyllabusExtractorOptions): SyllabusExtractor {
  const now = opts.now ?? (() => Date.now());
  const extractText = opts.extractText ?? extractPdfText;
  const renderPages = opts.renderPages ?? renderPdfPages;

  const context = () => {
    const at = now();
    return { termStart: opts.termStart ?? at, now: at };
  };

  async function fromText(text: string, o: ExtractOptions): Promise<ExtractedAssignment[]> {
    const chunks = chunkSyllabusText(text);
    if (chunks.length === 0) return [];

    const ctx = context();
    const { prompt } = getSyllabusPromptFor(o.model);
    const rows: ExtractedAssignment[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      if (o.signal?.aborted) throw abortError();
      o.onProgress?.({ phase: 'extracting', chunk: i + 1, chunks: chunks.length });
      // One chunk's failure fails the import: a partial list presented as the
      // syllabus would silently lose deadlines.
      const parsed = await opts.generator.generateJson(`${prompt}\n\n${chunks[i]}`, {
        model: o.model,
        signal: o.signal,
        numPredict: opts.numPredict,
        // Mandatory (architecture §6.4): the model's JSON is untrusted, and this
        // is what drops the bad rows.
        validate: (value) => parseAssignments(value, ctx),
      });
      rows.push(...parsed);
    }
    return dedupeAssignments(rows);
  }

  async function fromPdf(data: ArrayBuffer, o: ExtractOptions): Promise<ExtractedAssignment[]> {
    // Before the read, not after: extracting the text of a long PDF (and, for an
    // all-scanned one, rendering every page) is the expensive part, and an import
    // cancelled before it started should spend none of it.
    if (o.signal?.aborted) throw abortError();

    // A copy: the vision pass writes recovered text back into this array, and an
    // `extractText` that cached its result would otherwise hand that text out as
    // page text on the next import.
    const pages = [...(await extractText(data))];
    o.onProgress?.({ phase: 'reading-pdf', page: pages.length, pages: pages.length });

    // Pages with no usable text layer are scanned: render and OCR them (P2-A5).
    const scanned = pages.map((text, i) => (isBlankPage(text) ? i + 1 : 0)).filter((n) => n > 0);
    if (scanned.length > 0 && opts.pageReader) {
      const images = await renderPages(data, scanned);
      for (let i = 0; i < scanned.length; i += 1) {
        if (o.signal?.aborted) throw abortError();
        o.onProgress?.({
          phase: 'reading-page-image',
          page: scanned[i],
          pages: pages.length,
        });
        const { text } = await opts.pageReader.readPage(images[i], {
          model: o.model,
          signal: o.signal,
        });
        pages[scanned[i] - 1] = text;
      }
    }

    return fromText(pages.filter((text) => !isBlankPage(text)).join('\n\n'), o);
  }

  return { fromText, fromPdf };
}
