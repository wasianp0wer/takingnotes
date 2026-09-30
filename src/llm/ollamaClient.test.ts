import { describe, expect, it, vi } from 'vitest';

import {
  createOllamaClient,
  DEFAULT_TIMEOUT_MS,
  DegenerateOutputError,
  isDegenerateOutput,
  listOllamaModels,
  stripCodeFence,
  type FetchLike,
} from '@/llm/ollamaClient';

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const generateOk = (response = 'text', doneReason = 'stop') =>
  okResponse({ response, done_reason: doneReason });

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

describe('createOllamaClient', () => {
  it('exposes the documented default timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
  });

  it('posts to /api/generate with the guarded request shape', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk());
    const client = createOllamaClient({ baseUrl: 'http://h:1/', fetchImpl });

    const data = await client.generate({ model: 'm', prompt: 'p' });

    expect(data.response).toBe('text');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://h:1/api/generate');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    // `think: false` and `stream: false` are the client's own hard defaults
    // (transcription finding F1), not something a caller has to remember.
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({
      model: 'm',
      prompt: 'p',
      stream: false,
      think: false,
    });
  });

  it('sends system, images and options when given', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk());
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl });

    await client.generate({
      model: 'm',
      prompt: 'p',
      system: 's',
      images: ['aW1n'],
      options: { num_predict: 10, temperature: 0 },
    });

    expect(bodyOf(fetchImpl.mock.calls[0])).toMatchObject({
      system: 's',
      images: ['aW1n'],
      options: { num_predict: 10, temperature: 0 },
    });
  });

  it('reports the trimmed base URL', () => {
    const client = createOllamaClient({
      baseUrl: 'http://h:1///',
      fetchImpl: async () => generateOk(),
    });
    expect(client.baseUrl).toBe('http://h:1');
  });

  it('retries once without think when the model rejects the field', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: '"llava" does not support thinking' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(generateOk());
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl });

    await client.generate({ model: 'llava:13b', prompt: 'p' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl.mock.calls[0])).toHaveProperty('think', false);
    expect(bodyOf(fetchImpl.mock.calls[1])).not.toHaveProperty('think');
  });

  it('throws the Ollama error text on an HTTP error, without retrying', async () => {
    const fetchImpl = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ error: 'model "x" not found' }), { status: 404 }),
    );
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl });

    await expect(client.generate({ model: 'x', prompt: 'p' })).rejects.toThrow(
      'Ollama 404: model "x" not found',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw body when the error is not JSON', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('plain nope', { status: 500 }));
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl });

    await expect(client.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(
      'Ollama 500: plain nope',
    );
  });

  it('names the base URL when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = createOllamaClient({ baseUrl: 'http://h:1/', fetchImpl });

    await expect(client.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(
      'Could not reach Ollama at http://h:1: Failed to fetch',
    );
  });

  it('times out with the caller’s label in the message', async () => {
    const client = createOllamaClient({
      baseUrl: 'http://h:1',
      fetchImpl: hangingFetch(),
      timeoutMs: 20,
      label: 'Gap analysis',
    });

    await expect(client.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(
      'Gap analysis timed out after 0.02s',
    );
  });

  it('rejects with an AbortError when the caller aborts mid-flight', async () => {
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl: hangingFetch() });
    const controller = new AbortController();

    const promise = client.generate({ model: 'm', prompt: 'p' }, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an already-aborted signal without fetching', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => generateOk());
    const client = createOllamaClient({ baseUrl: 'http://h:1', fetchImpl, label: 'Work' });

    await expect(
      client.generate({ model: 'm', prompt: 'p' }, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Work aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a caller check an aborted signal before doing any work', () => {
    const client = createOllamaClient({
      baseUrl: 'http://h:1',
      fetchImpl: async () => generateOk(),
      label: 'Work',
    });

    expect(() => client.throwIfAborted(undefined)).not.toThrow();
    expect(() => client.throwIfAborted(AbortSignal.abort())).toThrow('Work aborted');
  });
});

describe('stripCodeFence', () => {
  it('unwraps a fence with or without a language tag, and trims', () => {
    expect(stripCodeFence('  ```markdown\n# Title\n```  ')).toBe('# Title');
    expect(stripCodeFence('```json\n[1, 2]\n```')).toBe('[1, 2]');
    expect(stripCodeFence('```\nbare\n```')).toBe('bare');
  });

  it('leaves unfenced text alone, including an inner fence', () => {
    expect(stripCodeFence('  hello  ')).toBe('hello');
    expect(stripCodeFence('before\n```js\nx\n```\nafter')).toBe('before\n```js\nx\n```\nafter');
  });
});

describe('isDegenerateOutput', () => {
  // The thorough suite lives in src/transcription/ollama.test.ts, where this
  // guard was first found (finding F2); these two pin the module's own contract.
  it('flags a low unique-line ratio that hit the token cap', () => {
    expect(isDegenerateOutput('a\nb\na\nb\na', 'length')).toBe(true);
  });

  it('accepts a normal answer', () => {
    expect(isDegenerateOutput('- one point\n- another point', 'stop')).toBe(false);
  });

  it('is what DegenerateOutputError is named for', () => {
    expect(new DegenerateOutputError('x').name).toBe('DegenerateOutputError');
  });
});

describe('listOllamaModels', () => {
  it('returns installed model names sorted', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse({ models: [{ name: 'b' }, { name: 'a' }] }),
    );

    await expect(listOllamaModels('http://h:1/', fetchImpl)).resolves.toEqual(['a', 'b']);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://h:1/api/tags');
  });

  it('names the base URL when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(listOllamaModels('http://h:1', fetchImpl)).rejects.toThrow(
      'Could not reach Ollama at http://h:1: Failed to fetch',
    );
  });
});
