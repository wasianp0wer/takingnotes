import { describe, expect, it, vi } from 'vitest';

import { DegenerateOutputError, type FetchLike } from '@/llm/ollamaClient';
import { createOllamaTextGenerator, DEFAULT_TEXT_NUM_PREDICT } from '@/llm/ollamaText';

const MODEL = 'gemma4:12b';

const generateOk = (response: string, doneReason = 'stop') =>
  new Response(JSON.stringify({ response, done_reason: doneReason }), { status: 200 });

const bodyOf = (call: Parameters<FetchLike>) =>
  JSON.parse(String(call[1]?.body)) as Record<string, unknown>;

/** A fetch that never settles until its signal aborts. */
const hangingFetch = () =>
  vi.fn<FetchLike>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );

/** Rows the gap analyzer's shape, used to exercise `validate`. */
interface Point {
  text: string;
}

const asPoints = (value: unknown): Point[] => {
  if (!Array.isArray(value)) throw new Error('expected an array');
  // Bad rows are dropped rather than cast: the model's JSON is untrusted input.
  return value.flatMap((row) =>
    row !== null &&
    typeof row === 'object' &&
    typeof (row as { text?: unknown }).text === 'string'
      ? [{ text: (row as { text: string }).text }]
      : [],
  );
};

describe('createOllamaTextGenerator.generate', () => {
  it('exposes the documented num_predict cap', () => {
    expect(DEFAULT_TEXT_NUM_PREDICT).toBe(2000);
  });

  it('sends the guarded request shape and returns the trimmed text', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('  an answer  '));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1/', fetchImpl });

    await expect(gen.generate('a prompt', { model: MODEL })).resolves.toBe('an answer');

    expect(fetchImpl.mock.calls[0][0]).toBe('http://h:1/api/generate');
    const body = bodyOf(fetchImpl.mock.calls[0]);
    expect(body.model).toBe(MODEL);
    expect(body.prompt).toBe('a prompt');
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_predict: DEFAULT_TEXT_NUM_PREDICT, temperature: 0 });
    expect(body).not.toHaveProperty('system');
  });

  it('sends a system prompt and a num_predict override', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('ok'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await gen.generate('p', { model: MODEL, system: 'be terse', numPredict: 64 });

    const body = bodyOf(fetchImpl.mock.calls[0]);
    expect(body.system).toBe('be terse');
    expect(body.options).toEqual({ num_predict: 64, temperature: 0 });
  });

  it('unwraps a fenced answer', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('```\nfenced\n```'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(gen.generate('p', { model: MODEL })).resolves.toBe('fenced');
  });

  it('rejects degenerate output', async () => {
    const repeated = Array.from({ length: 30 }, () => '- [illegible]').join('\n');
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk(repeated, 'length'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(gen.generate('p', { model: MODEL })).rejects.toBeInstanceOf(
      DegenerateOutputError,
    );
  });

  it('names the host when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(gen.generate('p', { model: MODEL })).rejects.toThrow(
      'Could not reach Ollama at http://h:1: Failed to fetch',
    );
  });

  it('times out per call', async () => {
    const gen = createOllamaTextGenerator({
      baseUrl: 'http://h:1',
      fetchImpl: hangingFetch(),
      timeoutMs: 20,
    });

    await expect(gen.generate('p', { model: MODEL })).rejects.toThrow(
      'Generation timed out after 0.02s',
    );
  });

  it('rejects an already-aborted signal without fetching', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('ok'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generate('p', { model: MODEL, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates an HTTP error', async () => {
    const fetchImpl = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ error: 'no such model' }), { status: 404 }),
    );
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(gen.generate('p', { model: MODEL })).rejects.toThrow(
      'Ollama 404: no such model',
    );
  });
});

describe('createOllamaTextGenerator.generateJson', () => {
  it('parses an array and hands it to validate', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      generateOk('[{"text":"one"},{"text":"two"}]'),
    );
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).resolves.toEqual([{ text: 'one' }, { text: 'two' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('unwraps a json fence without a repair call', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      generateOk('```json\n[{"text":"one"}]\n```'),
    );
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).resolves.toEqual([{ text: 'one' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('salvages JSON surrounded by prose without a repair call', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      generateOk('Sure! Here are the points:\n[{"text":"one"}]\nHope that helps.'),
    );
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).resolves.toEqual([{ text: 'one' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drops the rows validate rejects rather than casting them', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      generateOk('[{"text":"kept"},{"nope":1},null,"loose",{"text":"also kept"}]'),
    );
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).resolves.toEqual([{ text: 'kept' }, { text: 'also kept' }]);
  });

  it('fails with validate’s own message, and does not ask for a repair', async () => {
    // The JSON parsed, so repairing the JSON is the wrong remedy: the shape was
    // wrong, and a second call would only spend another model run on it.
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('{"points":[]}'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).rejects.toThrow('expected an array');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('repairs malformed JSON with exactly one extra call', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(generateOk('[{"text":"one",}]'))
      .mockResolvedValueOnce(generateOk('[{"text":"one"}]'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).resolves.toEqual([{ text: 'one' }]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The repair call shows the model its own bad output and asks for JSON only.
    const repair = String(bodyOf(fetchImpl.mock.calls[1]).prompt);
    expect(repair).toContain('[{"text":"one",}]');
    expect(repair.toLowerCase()).toContain('json');
  });

  it('fails readably when the repair is also unparseable, after one repair', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk('still not json'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints }),
    ).rejects.toThrow(/did not return valid JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes the model, system prompt and num_predict through to both calls', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(generateOk('nonsense'))
      .mockResolvedValueOnce(generateOk('[]'));
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await gen.generateJson('p', {
      model: MODEL,
      system: 'be terse',
      numPredict: 128,
      validate: asPoints,
    });

    for (const call of fetchImpl.mock.calls) {
      expect(bodyOf(call)).toMatchObject({
        model: MODEL,
        system: 'be terse',
        options: { num_predict: 128, temperature: 0 },
      });
    }
  });

  it('does not attempt a repair once the caller has aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async () => {
      controller.abort();
      return generateOk('nonsense');
    });
    const gen = createOllamaTextGenerator({ baseUrl: 'http://h:1', fetchImpl });

    await expect(
      gen.generateJson('p', { model: MODEL, validate: asPoints, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
