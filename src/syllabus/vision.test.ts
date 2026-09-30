import { describe, expect, it, vi } from 'vitest';

import { createOllamaPageReader } from '@/syllabus/vision';

interface Body {
  model: string;
  prompt: string;
  images?: string[];
  think?: boolean;
  stream?: boolean;
  options?: { num_predict?: number; temperature?: number };
}

function fetchReturning(response: string) {
  const calls: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ response }), { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const image = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });

/**
 * The same page image, with its one read counted. Encoding a full-page render is
 * real work, so the abort check has to run before it and not merely before the
 * fetch - and only an observable encode can tell those two orderings apart.
 */
function countedImage() {
  const blob = image();
  const reads = { count: 0 };
  const readBytes = blob.arrayBuffer.bind(blob);
  blob.arrayBuffer = () => {
    reads.count += 1;
    return readBytes();
  };
  return { blob, reads };
}

describe('createOllamaPageReader', () => {
  it('sends the page image with the versioned vision prompt and the shared guards', async () => {
    const { calls, fetchImpl } = fetchReturning('Essay 1 — due Oct 15\nMidterm — Nov 2');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    const { blob, reads } = countedImage();

    const result = await reader.readPage(blob, { model: 'gemma4:12b' });

    expect(result.text).toBe('Essay 1 — due Oct 15\nMidterm — Nov 2');
    expect(result.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(calls[0].images).toHaveLength(1);
    expect(calls[0].images?.[0]).toBe('AQIDBA==');
    expect(calls[0].think).toBe(false);
    expect(calls[0].stream).toBe(false);
    expect(calls[0].options?.temperature).toBe(0);
    expect(calls[0].options?.num_predict).toBe(3000);
    // The counterpart to the aborted case below: a read that proceeds does encode.
    expect(reads.count).toBe(1);
  });

  it('unwraps a fenced answer', async () => {
    const { fetchImpl } = fetchReturning('```\nEssay 1 due Oct 15\n```');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    await expect(reader.readPage(image(), { model: 'gemma4:12b' })).resolves.toMatchObject({
      text: 'Essay 1 due Oct 15',
    });
  });

  it('refuses degenerate output instead of returning it', async () => {
    const { fetchImpl } = fetchReturning(Array.from({ length: 40 }, () => 'due').join('\n'));
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    await expect(reader.readPage(image(), { model: 'gemma4:12b' })).rejects.toThrow(/degenerate/i);
  });

  it('does not spend a base64 pass on an already-aborted read', async () => {
    const { calls, fetchImpl } = fetchReturning('text');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    const { blob, reads } = countedImage();
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.readPage(blob, { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    // Not merely "before the fetch": the image was never even read.
    expect(reads.count).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
