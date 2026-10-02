import { describe, expect, it, vi } from 'vitest';

import type { TextGenerator } from '@/llm/ollamaText';
import { SYLLABUS_DIRECT_CHAR_BUDGET } from '@/syllabus/chunk';
import { createSyllabusExtractor, type ExtractProgress } from '@/syllabus/extractor';
import { getSyllabusPromptFor } from '@/syllabus/prompts';
import type { SyllabusPageReader } from '@/syllabus/vision';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

/**
 * A fake TextGenerator. `generateJson` runs the caller's own `validate` over
 * canned JSON, which is what makes "bad rows are dropped" a real assertion.
 */
function fakeGenerator(replies: unknown[]) {
  const prompts: string[] = [];
  const generator: TextGenerator = {
    generate: vi.fn(async () => ''),
    generateJson: vi.fn(async (prompt: string, o: { validate: (v: unknown) => unknown }) => {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return o.validate(reply);
    }),
  } as unknown as TextGenerator;
  return { generator, prompts };
}

const row = (title: string, dueDate: string) => ({ title, dueDate, kind: 'deadline' });

describe('fromText', () => {
  it('makes one call for a short syllabus and drops the rows validate refuses', async () => {
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15'), { dueDate: 'Oct 20' }, row('Lecture', 'Oct 16')],
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    const rows = await extractor.fromText('Essay 1 due Oct 15', { model: 'gemma4:12b' });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    // The titleless row is dropped; "Lecture" is kind deadline here so it stays.
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Lecture']);
    expect(rows[0].dueAt).toBe(local(2026, 10, 15));
  });

  it('sends the registry’s extraction instructions ahead of the syllabus text', async () => {
    // Without this, the prompt could be dropped from the call entirely - and the
    // instructions are the only reason the model answers with a JSON array at all.
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    await extractor.fromText('Essay 1 due Oct 15', { model: 'gemma4:12b' });

    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).not.toBe('');
    expect(prompts[0]).toContain(prompt);
    expect(prompts[0]).toContain('Return a JSON array');
    expect(prompts[0].indexOf(prompt)).toBeLessThan(prompts[0].indexOf('Essay 1 due Oct 15'));
  });

  it('reads `now` once per extraction, not once per chunk', async () => {
    // Two chunks resolving "Oct 15" against different `now` values would resolve to
    // two different days, and dedupe would then keep both as separate assignments.
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    const now = vi.fn(() => NOW);
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({ generator, termStart: null, now });

    await extractor.fromText(long, { model: 'gemma4:12b' });

    expect(prompts.length).toBeGreaterThan(1);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('chunks a long syllabus and dedupes what the overlap reports twice', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    expect(long.length).toBeGreaterThan(SYLLABUS_DIRECT_CHAR_BUDGET);
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15')],
      [row('Essay 1', 'Oct 15'), row('Essay 2', 'Oct 22')],
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    const rows = await extractor.fromText(long, { model: 'gemma4:12b' });

    expect(prompts.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Essay 2']);
  });

  it('fails the whole extraction when one chunk fails, rather than returning part of it', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    const { generator } = fakeGenerator([
      [row('Essay 1', 'Oct 15')],
      new Error('Ollama 500: out of memory'),
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    await expect(extractor.fromText(long, { model: 'gemma4:12b' })).rejects.toThrow(
      /out of memory/,
    );
  });

  it('stops before the next chunk when the signal is aborted', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    const controller = new AbortController();
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const gen = generator.generateJson as unknown as ReturnType<typeof vi.fn>;
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });
    // Abort as soon as the first call has been made.
    gen.mockImplementationOnce(async (prompt: string, o: { validate: (v: unknown) => unknown }) => {
      prompts.push(prompt);
      controller.abort();
      return o.validate([row('Essay 1', 'Oct 15')]);
    });

    await expect(
      extractor.fromText(long, { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(prompts).toHaveLength(1);
  });

  it('returns nothing for text with no content, without calling the model', async () => {
    const { generator, prompts } = fakeGenerator([[]]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });
    await expect(extractor.fromText('   ', { model: 'gemma4:12b' })).resolves.toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('resolves no-year dates against now when no term start is set', async () => {
    const { generator } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({ generator, termStart: null, now: () => NOW });
    const [only] = await extractor.fromText('Essay 1', { model: 'gemma4:12b' });
    expect(only.dueAt).toBe(local(2026, 10, 15));
  });
});

describe('fromPdf', () => {
  const pdf = () => new TextEncoder().encode('%PDF').buffer as ArrayBuffer;

  it('sends the PDF’s page text down the same path', async () => {
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Course info', 'Essay 1 due Oct 15'],
    });

    const rows = await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    expect(rows.map((r) => r.title)).toEqual(['Essay 1']);
  });

  it('renders the pages with no text layer and reads each through the vision path', async () => {
    // Scanned pages INTERLEAVED with text pages, and each recovered text tagged with
    // its own page, so writing a page's recovered text back one slot over is visible
    // in the prompt rather than falling off the end of the array.
    const blobPage = new Map<Blob, number>();
    const renderPages = vi.fn(async (_d: ArrayBuffer, pages: number[]) =>
      pages.map((page) => {
        const blob = new Blob([`png-${page}`]);
        blobPage.set(blob, page);
        return blob;
      }),
    );
    const readPage = vi.fn(async (image: Blob) => ({
      text: `scan of page ${blobPage.get(image)}`,
      promptVersion: 'v',
    }));
    const pageReader: SyllabusPageReader = { readPage };
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15'), row('Essay 2', 'Nov 1')],
    ]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => [
        'text of page 1: Essay 1 due Oct 15',
        '',
        'text of page 3',
        '',
        'text of page 5',
      ],
      renderPages,
    });

    const rows = await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(renderPages.mock.calls[0][1]).toEqual([2, 4]);
    expect(readPage).toHaveBeenCalledTimes(2);
    // Every page's own text is present...
    const expectedOrder = [
      'text of page 1',
      'scan of page 2',
      'text of page 3',
      'scan of page 4',
      'text of page 5',
    ];
    for (const fragment of expectedOrder) expect(prompts[0]).toContain(fragment);
    // ...and each recovered page sits in its own position, between the text pages
    // that surround it. A write shifted by one breaks this ordering.
    const positions = expectedOrder.map((fragment) => prompts[0].indexOf(fragment));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(rows).toHaveLength(2);
  });

  it('treats a whitespace-only page as scanned rather than dropping it silently', async () => {
    const renderPages = vi.fn(async (_d: ArrayBuffer, pages: number[]) =>
      pages.map(() => new Blob(['png'])),
    );
    const { generator, prompts } = fakeGenerator([[row('Essay 2', 'Nov 1')]]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader: { readPage: async () => ({ text: 'scan of page 2', promptVersion: 'v' }) },
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['text of page 1', '  \n  '],
      renderPages,
    });

    await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(renderPages.mock.calls[0][1]).toEqual([2]);
    expect(prompts[0]).toContain('scan of page 2');
  });

  it('skips a scanned page when there is no vision reader, rather than failing', async () => {
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const renderPages = vi.fn(async (_d: ArrayBuffer, pages: number[]) =>
      pages.map(() => new Blob(['png'])),
    );
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Essay 1 due Oct 15', ''],
      renderPages,
    });

    await expect(extractor.fromPdf(pdf(), { model: 'gemma4:12b' })).resolves.toHaveLength(1);
    expect(prompts).toHaveLength(1);
    // Nothing is rendered when there is nothing that could read it.
    expect(renderPages).not.toHaveBeenCalled();
  });

  it('stops before reading the PDF when the signal is already aborted', async () => {
    const extractText = vi.fn(async () => ['Essay 1 due Oct 15']);
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const controller = new AbortController();
    controller.abort();
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText,
    });

    await expect(
      extractor.fromPdf(pdf(), { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(extractText).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(0);
  });

  it('does not rewrite the array `extractText` returned', async () => {
    // A caching `extractText` would otherwise hand out vision text as page text on
    // the next import.
    const pages = ['text of page 1', ''];
    const { generator } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader: { readPage: async () => ({ text: 'scan of page 2', promptVersion: 'v' }) },
      termStart: TERM,
      now: () => NOW,
      extractText: async () => pages,
      renderPages: async (_d, wanted) => wanted.map(() => new Blob(['png'])),
    });

    await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(pages).toEqual(['text of page 1', '']);
  });

  it('reports progress for reading, vision and extraction, in order', async () => {
    const seen: ExtractProgress[] = [];
    const { generator } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader: { readPage: async () => ({ text: 'Essay 1 due Oct 15', promptVersion: 'v' }) },
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Course info here, long enough', ''],
      renderPages: async (_d, pages) => pages.map(() => new Blob(['png'])),
    });

    await extractor.fromPdf(pdf(), {
      model: 'gemma4:12b',
      onProgress: (p) => seen.push(p),
    });

    expect(seen.map((p) => p.phase)).toEqual([
      'reading-pdf',
      'reading-page-image',
      'extracting',
    ]);
    expect(seen[1]).toMatchObject({ page: 2, pages: 2 });
    expect(seen[2]).toMatchObject({ chunk: 1, chunks: 1 });
  });
});
