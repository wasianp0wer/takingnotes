import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptionSettings } from '@/notes/TranscriptionSettings';
import type { FetchLike } from '@/transcription/ollama';
import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const TAGS_RESPONSE = { models: [{ name: 'llava:7b' }, { name: 'gemma4:12b' }] };

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function fakeFetch(impl?: (url: string) => Response | Promise<Response>): FetchLike {
  return vi.fn((url: string) => {
    if (impl) return Promise.resolve(impl(url));
    return Promise.resolve(jsonResponse(TAGS_RESPONSE));
  }) as unknown as FetchLike;
}

function render(fetchImpl: FetchLike) {
  act(() => {
    root.render(<TranscriptionSettings fetchImpl={fetchImpl} />);
  });
}

function select(): HTMLSelectElement {
  const found = container.querySelector('select');
  if (!found) throw new Error('no select rendered');
  return found;
}

function addressInput(): HTMLInputElement {
  const found = container.querySelector('input#ollama-base-url');
  if (!found) throw new Error('no address input rendered');
  return found as HTMLInputElement;
}

function renderSizeInput(): HTMLInputElement {
  const found = container.querySelector('input[type="number"]');
  if (!found) throw new Error('no render size input rendered');
  return found as HTMLInputElement;
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)!.set!;
const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value',
)!.set!;

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function blur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  nativeSelectValueSetter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * `await act(async () => { await vi.waitFor(...) })` deadlocks: React defers
 * flushing state updates made during an async `act` callback until that
 * callback settles, but the polled assertion inside it never settles until
 * the DOM reflects those updates. Looping over short, separately-awaited
 * `act` calls instead gives React a flush point on every iteration.
 */
async function waitForUpdate(assertion: () => void, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
    }
  }
}

describe('TranscriptionSettings', () => {
  it('lists installed models as options and selects the saved default', async () => {
    const fetchImpl = fakeFetch();
    render(fetchImpl);

    await waitForUpdate(() => {
      // `listOllamaModels` sorts, so this is alphabetical, not response order.
      const options = Array.from(select().options).map((o) => o.value);
      expect(options).toEqual(['gemma4:12b', 'llava:7b']);
    });

    expect(select().value).toBe('gemma4:12b');
  });

  it('reports an unreachable Ollama with the A13 hint', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    ) as unknown as FetchLike;
    render(fetchImpl);

    await waitForUpdate(() => {
      expect(container.textContent).toContain('Could not reach Ollama');
    });

    expect(container.textContent).toContain(
      'Is Ollama running, and does OLLAMA_ORIGINS allow this page?',
    );
  });

  it('saves the model on change', async () => {
    const fetchImpl = fakeFetch();
    render(fetchImpl);

    await waitForUpdate(() => {
      expect(select().options.length).toBe(2);
    });

    await act(async () => {
      setSelectValue(select(), 'llava:7b');
    });

    await vi.waitFor(async () => {
      expect(await getSettingValue('ollama.model')).toBe('llava:7b');
    });
  });

  it('clamps the render size to the floor on blur', async () => {
    const fetchImpl = fakeFetch();
    render(fetchImpl);

    await waitForUpdate(() => {
      expect(select().options.length).toBe(2);
    });

    await act(async () => {
      setInputValue(renderSizeInput(), '500');
      blur(renderSizeInput());
    });

    expect(renderSizeInput().value).toBe('768');
    await vi.waitFor(async () => {
      expect(await getSettingValue('transcription.renderLongEdge')).toBe(768);
    });
  });

  it('saves the address on blur and refetches models from the new address', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return jsonResponse(TAGS_RESPONSE);
    });
    render(fetchImpl);

    await waitForUpdate(() => {
      expect(select().options.length).toBe(2);
    });

    await act(async () => {
      setInputValue(addressInput(), 'http://example.test:11434');
      blur(addressInput());
    });

    await vi.waitFor(async () => {
      expect(await getSettingValue('ollama.baseUrl')).toBe('http://example.test:11434');
    });
    await vi.waitFor(() => {
      expect(calls).toContain('http://example.test:11434/api/tags');
    });
  });

  it('shows Loading models… while the fetch is in flight, then clears it', async () => {
    await setSettingValue('ollama.baseUrl', 'http://localhost:11434');
    let resolveFetch!: (res: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    ) as unknown as FetchLike;
    render(fetchImpl);

    await waitForUpdate(() => {
      expect(container.textContent).toContain('Loading models…');
    });

    await act(async () => {
      resolveFetch(jsonResponse(TAGS_RESPONSE));
    });

    await waitForUpdate(() => {
      expect(container.textContent).not.toContain('Loading models…');
    });
  });
  it('still loads models after a StrictMode remount', async () => {
    // StrictMode mounts, runs cleanup, then mounts again on the same instance,
    // so a mounted flag that is only ever cleared stays false for the life of
    // the component and silently discards every async result.
    const fetchImpl = fakeFetch();
    act(() => {
      root.render(
        <StrictMode>
          <TranscriptionSettings fetchImpl={fetchImpl} />
        </StrictMode>,
      );
    });

    await waitForUpdate(() => {
      // 'llava:7b' can only come from the fetched list: the saved model
      // ('gemma4:12b', the default) is always offered regardless.
      expect(Array.from(select().options).map((o) => o.value)).toContain('llava:7b');
    });
  });
});
