import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopBridge } from '@/desktop/bridge';
import type { FetchLike } from '@/llm/ollamaClient';
import { OllamaSetupStatus } from '@/notes/OllamaSetupStatus';
import { setSettingValue } from '@/storage/settingKeys';
import { fakeDesktopBridge } from '@/test/fakeDesktopBridge';
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
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await act(async () => root.render(<OllamaSetupStatus fetchImpl={tagsOf('llava:7b')} />));
      await flush();
      expect(container.textContent).toContain("The model gemma4:12b isn't installed.");
      expect(container.textContent).toContain('ollama pull gemma4:12b');
      await act(async () => button('Copy').click());
      expect(writeText).toHaveBeenCalledWith('ollama pull gemma4:12b');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
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
  it('uses the desktop bridge probe by default, so a refused request reads as blocked', async () => {
    const fake = fakeDesktopBridge();
    const probeOllama = vi.fn(async () => true);
    const w = window as Window & { takingnotesDesktop?: DesktopBridge };
    w.takingnotesDesktop = { ...fake.bridge, probeOllama };
    try {
      const fetchImpl = vi.fn<FetchLike>(async () => { throw new TypeError('cors'); });
      await act(async () => root.render(<OllamaSetupStatus fetchImpl={fetchImpl} />));
      await flush();
      expect(probeOllama).toHaveBeenCalledWith('http://localhost:11434');
      expect(container.textContent).toContain('Ollama is running but refused');
      expect(container.textContent).not.toContain("isn't running");
      // How to allow the desktop app's origin.
      expect(container.textContent).toContain('launchctl setenv OLLAMA_ORIGINS "app://*"');
      expect(container.textContent).toContain('then quit and reopen Ollama');
    } finally {
      delete w.takingnotesDesktop;
    }
  });

  it('without a desktop bridge, a failed request shows both possibilities', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => { throw new TypeError('down'); });
    await act(async () => root.render(<OllamaSetupStatus fetchImpl={fetchImpl} />));
    await flush();
    expect(container.textContent).toContain("Ollama isn't running at http://localhost:11434.");
    expect(container.textContent).toContain('Ollama is running but refused');
    // The web build allows the page's own origin.
    expect(window.location.origin).toMatch(/^https?:\/\//);
    expect(container.textContent).toContain(`launchctl setenv OLLAMA_ORIGINS "${window.location.origin}"`);
    expect(container.textContent).not.toContain('app://*');
  });
});
