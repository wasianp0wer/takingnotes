import { describe, expect, it, vi } from 'vitest';
import { ollamaTagsUrl, probeOllama, type ProbeFetch } from './ollamaProbe';

describe('ollamaTagsUrl', () => {
  it('builds /api/tags for localhost and 127.0.0.1 over http', () => {
    expect(ollamaTagsUrl('http://localhost:11434')).toBe('http://localhost:11434/api/tags');
    expect(ollamaTagsUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api/tags');
    expect(ollamaTagsUrl('http://localhost:11434/')).toBe('http://localhost:11434/api/tags');
    expect(ollamaTagsUrl('http://localhost')).toBe('http://localhost/api/tags');
  });

  it('probe rejects non-localhost', () => {
    for (const bad of [
      'http://192.168.1.1:11434',
      'http://example.com:11434',
      'http://localhost.example.com:11434',
      'http://127.0.0.2:11434',
      'http://0.0.0.0:11434',
      'http://[::1]:11434',
      'https://localhost:11434',
      'file:///etc/passwd',
      'app://takingnotes',
      'http://user:pw@localhost:11434',
      'http://evil.example#@localhost:11434',
      'localhost:11434',
      'not a url',
      '',
    ]) {
      expect(ollamaTagsUrl(bad), bad).toBeNull();
    }
  });

  it('rejects anything that is not a string', () => {
    expect(ollamaTagsUrl(undefined)).toBeNull();
    expect(ollamaTagsUrl(null)).toBeNull();
    expect(ollamaTagsUrl(42)).toBeNull();
    expect(ollamaTagsUrl({ toString: () => 'http://localhost:11434' })).toBeNull();
  });
});

describe('probeOllama', () => {
  it('true on any HTTP response, whatever the status', async () => {
    for (const status of [200, 403, 404, 500]) {
      const fetchImpl = vi.fn(async () => new Response('x', { status }));
      await expect(probeOllama('http://localhost:11434', fetchImpl)).resolves.toBe(true);
      expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything());
    }
  });

  it('never follows a redirect, and a 3xx still counts as reachable', async () => {
    const fetchImpl = vi.fn<ProbeFetch>(async () => new Response(null, { status: 302, headers: { Location: 'http://example.com/' } }));
    await expect(probeOllama('http://localhost:11434', fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('false on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('net::ERR_CONNECTION_REFUSED');
    });
    await expect(probeOllama('http://localhost:11434', fetchImpl)).resolves.toBe(false);
  });

  it('false after the timeout, and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      });
      const result = probeOllama('http://localhost:11434', fetchImpl);
      await vi.advanceTimersByTimeAsync(1999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fetches a disallowed URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    await expect(probeOllama('http://example.com:11434', fetchImpl)).resolves.toBe(false);
    await expect(probeOllama(7, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
