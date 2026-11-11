import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  createOllamaTranscriber,
  DEFAULT_NUM_PREDICT,
  DEFAULT_TIMEOUT_MS,
  DegenerateOutputError,
  isDegenerateOutput,
  listOllamaModels,
  type FetchLike,
} from '@/transcription/ollama';
import { getPromptFor } from '@/transcription/prompts';

const MODEL = 'gemma4:12b';
const png = () => new Blob(['png-bytes'], { type: 'image/png' });

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const generateOk = (response = '# Title\n- a', doneReason = 'stop') =>
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

describe('createOllamaTranscriber', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_NUM_PREDICT).toBe(2000);
  });

  it('posts the page to /api/generate with the guarded request shape', async () => {
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1/', fetch });

    await t.transcribePage(png(), { model: MODEL, firstPage: true });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://h:1/api/generate');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = bodyOf(fetch.mock.calls[0]);
    expect(body.model).toBe(MODEL);
    expect(body.prompt).toBe(getPromptFor(MODEL, { firstPage: true }).prompt);
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_predict: 2000, temperature: 0 });
    expect((body.images as string[])[0]).toBe(btoa('png-bytes'));
  });

  it('sends the later-page prompt when the page is not the first of its note', async () => {
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1/', fetch });

    await t.transcribePage(png(), { model: MODEL, firstPage: false });

    const body = bodyOf(fetch.mock.calls[0]);
    expect(body.prompt).toBe(getPromptFor(MODEL, { firstPage: false }).prompt);
    expect(body.prompt).not.toBe(getPromptFor(MODEL, { firstPage: true }).prompt);
  });

  it('base64-encodes a blob larger than one chunk without corrupting bytes', async () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await t.transcribePage(new Blob([bytes], { type: 'image/png' }), { model: MODEL, firstPage: true });

    const images = bodyOf(fetch.mock.calls[0]).images as string[];
    expect(images[0]).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('honours a numPredict override', async () => {
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch, numPredict: 42 });

    await t.transcribePage(png(), { model: MODEL, firstPage: true });

    expect(bodyOf(fetch.mock.calls[0]).options).toEqual({
      num_predict: 42,
      temperature: 0,
    });
  });

  it('returns the markdown with the model and prompt version', async () => {
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(t.transcribePage(png(), { model: MODEL, firstPage: true })).resolves.toEqual({
      markdown: '# Title\n- a',
      model: MODEL,
      promptVersion: 'gemma-v2',
    });
  });

  it('strips a wrapping markdown fence and trims', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      generateOk('  ```markdown\n# Title\n- a\n```  '),
    );
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    const result = await t.transcribePage(png(), { model: MODEL, firstPage: true });
    expect(result.markdown).toBe('# Title\n- a');
  });

  it('retries once without think when the model rejects the field', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: '"llava" does not support thinking' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    const result = await t.transcribePage(png(), { model: 'llava:13b', firstPage: true });

    expect(result.markdown).toBe('# Title\n- a');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch.mock.calls[0])).toHaveProperty('think', false);
    expect(bodyOf(fetch.mock.calls[1])).not.toHaveProperty('think');
  });

  it('rejects when the retry without think also fails', async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ error: 'does not support thinking' }), {
          status: 400,
        }),
    );
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(t.transcribePage(png(), { model: 'llava:13b', firstPage: true })).rejects.toThrow(
      /does not support thinking/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects other HTTP errors with Ollama error text, without retrying', async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ error: 'model "x" not found' }), { status: 404 }),
    );
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(t.transcribePage(png(), { model: 'x', firstPage: true })).rejects.toThrow(
      /model "x" not found/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('names the base URL when Ollama is unreachable', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(t.transcribePage(png(), { model: MODEL, firstPage: true })).rejects.toThrow(
      'Could not reach Ollama at http://h:1: Failed to fetch',
    );
  });

  it('rejects with a timeout message when the per-page timer fires', async () => {
    const fetch = hangingFetch();
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch, timeoutMs: 20 });

    await expect(t.transcribePage(png(), { model: MODEL, firstPage: true })).rejects.toThrow(
      'Transcription timed out after 0.02s',
    );
  });

  it('rejects with an AbortError when the caller aborts mid-flight', async () => {
    const fetch = hangingFetch();
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });
    const controller = new AbortController();

    const promise = t.transcribePage(png(), { model: MODEL, firstPage: true, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const fetch = vi.fn<FetchLike>(async () => generateOk());
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(
      t.transcribePage(png(), { model: MODEL, firstPage: true, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects degenerate output', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      generateOk(Array.from({ length: 30 }, () => '[illegible]').join('\n'), 'length'),
    );
    const t = createOllamaTranscriber({ baseUrl: 'http://h:1', fetch });

    await expect(t.transcribePage(png(), { model: MODEL, firstPage: true })).rejects.toBeInstanceOf(
      DegenerateOutputError,
    );
  });
});

describe('isDegenerateOutput', () => {
  it('flags a low unique-line ratio that hit the token cap', () => {
    expect(isDegenerateOutput('a\nb\na\nb\na', 'length')).toBe(true);
  });

  it('accepts distinct lines even when the cap was hit', () => {
    expect(isDegenerateOutput('a\nb\nc\nd\ne', 'length')).toBe(false);
  });

  it('flags a long repetitive block regardless of done reason', () => {
    const lines = Array.from({ length: 30 }, () => '[illegible]').join('\n');
    expect(isDegenerateOutput(lines, 'stop')).toBe(true);
  });

  it('flags a low unique-token ratio on a single line', () => {
    const tokens = Array.from({ length: 250 }, () => '[illegible]').join(' ');
    expect(isDegenerateOutput(tokens, 'stop')).toBe(true);
  });

  it('accepts a checklist of identical lines that stopped normally', () => {
    const checklist = Array.from({ length: 8 }, () => '- [ ] ').join('\n');
    expect(isDegenerateOutput(checklist, 'stop')).toBe(false);
  });

  it('accepts a hand-drawn table whose rows repeat', () => {
    const table = [
      '| day | done |',
      '| --- | --- |',
      ...Array.from({ length: 10 }, () => '| Mon | yes |'),
    ].join('\n');
    expect(isDegenerateOutput(table, 'stop')).toBe(false);
  });

  it('accepts a normal page', () => {
    const page = '# Meeting\n\n- transhumance and proof finding\n- sheep move north in June\n- ask about the tax rolls\n\nNext: read chapter 4.';
    expect(isDegenerateOutput(page, 'stop')).toBe(false);
    expect(isDegenerateOutput('', 'stop')).toBe(false);
  });
});

describe('listOllamaModels', () => {
  it('returns installed model names sorted', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      okResponse({ models: [{ name: 'b' }, { name: 'a' }] }),
    );

    await expect(listOllamaModels('http://h:1/', fetch)).resolves.toEqual(['a', 'b']);
    expect(fetch.mock.calls[0][0]).toBe('http://h:1/api/tags');
  });

  it('returns an empty list when models is missing', async () => {
    const fetch = vi.fn<FetchLike>(async () => okResponse({}));
    await expect(listOllamaModels('http://h:1', fetch)).resolves.toEqual([]);
  });

  it('rejects on an HTTP error', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('nope', { status: 500 }));
    await expect(listOllamaModels('http://h:1', fetch)).rejects.toThrow('Ollama 500');
  });

  it('names the base URL when Ollama is unreachable', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(listOllamaModels('http://h:1/', fetch)).rejects.toThrow(
      'Could not reach Ollama at http://h:1: Failed to fetch',
    );
  });
});
