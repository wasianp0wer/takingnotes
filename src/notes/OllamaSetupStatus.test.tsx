import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '@/llm/ollamaClient';
import { OllamaSetupStatus } from '@/notes/OllamaSetupStatus';
import { setSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  await setSettingValue('ollama.model', 'gemma4:12b');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const tagsOf = (...names: string[]): FetchLike => vi.fn(async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) })));
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('OllamaSetupStatus', () => {
  it('shows pull command and copies it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => root.render(<OllamaSetupStatus fetchImpl={tagsOf('llava:7b')} />));
    await flush();
    expect(container.textContent).toContain("The model gemma4:12b isn't installed.");
    expect(container.textContent).toContain('ollama pull gemma4:12b');
    await act(async () => button('Copy').click());
    expect(writeText).toHaveBeenCalledWith('ollama pull gemma4:12b');
  });

  it('check again re-runs', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => { throw new TypeError('down'); });
    await act(async () => root.render(<OllamaSetupStatus fetchImpl={fetchImpl} probeReachable={async () => false} />));
    await flush();
    expect(container.textContent).toContain("Ollama isn't running at http://localhost:11434.");
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ models: [{ name: 'gemma4:12b' }] })));
    await act(async () => button('Check again').click());
    await flush();
    expect(container.textContent).toContain('Ollama ready');
  });

  it('compact renders nothing when ready', async () => {
    await act(async () => root.render(<OllamaSetupStatus compact fetchImpl={tagsOf('gemma4:12b')} />));
    await flush();
    expect(container.textContent).not.toContain('Ollama ready');
  });
});
