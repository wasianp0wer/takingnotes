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

describe('createOllamaPageReader', () => {
  it('sends the page image with the versioned vision prompt and the shared guards', async () => {
    const { calls, fetchImpl } = fetchReturning('Essay 1 — due Oct 15\nMidterm — Nov 2');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });

    const result = await reader.readPage(image(), { model: 'gemma4:12b' });

    expect(result.text).toBe('Essay 1 — due Oct 15\nMidterm — Nov 2');
    expect(result.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(calls[0].images).toHaveLength(1);
    expect(calls[0].images?.[0]).toBe('AQIDBA==');
    expect(calls[0].think).toBe(false);
    expect(calls[0].stream).toBe(false);
    expect(calls[0].options?.temperature).toBe(0);
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
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.readPage(image(), { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toHaveLength(0);
  });
});
