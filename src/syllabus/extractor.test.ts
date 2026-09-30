import { describe, expect, it, vi } from 'vitest';

import type { TextGenerator } from '@/llm/ollamaText';
import { SYLLABUS_DIRECT_CHAR_BUDGET } from '@/syllabus/chunk';
import { createSyllabusExtractor, type ExtractProgress } from '@/syllabus/extractor';
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

  it('renders a page with no text layer and reads it through the vision path', async () => {
    const readPage = vi.fn(async () => ({ text: 'Essay 2 due Nov 1', promptVersion: 'v' }));
    const pageReader: SyllabusPageReader = { readPage };
    const renderPages = vi.fn(async (_d: ArrayBuffer, pages: number[]) =>
      pages.map(() => new Blob(['png'])),
    );
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15'), row('Essay 2', 'Nov 1')],
    ]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Essay 1 due Oct 15', ''],
      renderPages,
    });

    const rows = await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(renderPages.mock.calls[0][1]).toEqual([2]);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    expect(prompts[0]).toContain('Essay 2 due Nov 1');
    expect(rows).toHaveLength(2);
  });

  it('skips a scanned page when there is no vision reader, rather than failing', async () => {
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Essay 1 due Oct 15', ''],
    });

    await expect(extractor.fromPdf(pdf(), { model: 'gemma4:12b' })).resolves.toHaveLength(1);
    expect(prompts).toHaveLength(1);
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
