import { describe, expect, it, vi } from 'vitest';

import { checkOllamaSetup } from '@/llm/ollamaSetup';
import type { FetchLike } from '@/llm/ollamaClient';

const tags = (...names: string[]): FetchLike =>
  vi.fn(async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) })));
const failing: FetchLike = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
});
const base = 'http://localhost:11434';

describe('checkOllamaSetup', () => {
  it('ready when model listed', async () => {
    expect(await checkOllamaSetup({ baseUrl: base, model: 'llava:7b', fetch: tags('llava:7b') })).toEqual({ state: 'ready' });
  });
  it('matches untagged model to :latest', async () => {
    expect(await checkOllamaSetup({ baseUrl: base, model: 'llava', fetch: tags('llava:latest') })).toEqual({ state: 'ready' });
  });
  it('model-missing', async () => {
    expect(await checkOllamaSetup({ baseUrl: base, model: 'gemma4:12b', fetch: tags('llava:7b') })).toEqual({
      state: 'model-missing',
      model: 'gemma4:12b',
    });
  });
  it('unreachable with probe false', async () => {
    const probeReachable = vi.fn(async () => false);
    expect(await checkOllamaSetup({ baseUrl: base, model: 'm', fetch: failing, probeReachable })).toEqual({ state: 'unreachable' });
    expect(probeReachable).toHaveBeenCalledWith(base);
  });
  it('blocked with probe true', async () => {
    expect(await checkOllamaSetup({ baseUrl: base, model: 'm', fetch: failing, probeReachable: async () => true })).toEqual({ state: 'blocked' });
  });
  it('unreachable-or-blocked without probe', async () => {
    expect(await checkOllamaSetup({ baseUrl: base, model: 'm', fetch: failing })).toEqual({ state: 'unreachable-or-blocked' });
  });
});
