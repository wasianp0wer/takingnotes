import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TypedPageEditor } from '@/notes/TypedPageEditor';
import { createNote } from '@/storage/notes';
import { createTypedPage, getPage, setPageText } from '@/storage/pages';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock('@/storage/pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/pages')>();
  return {
    ...actual,
    setPageText: vi.fn(actual.setPageText),
  };
});

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

/** Rounds of real waits, long enough to clear the tests' 20ms debounce. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function mountEditor(props: { pageId: string; initialText: string; debounceMs?: number }) {
  await act(async () => {
    root.render(<TypedPageEditor {...props} />);
  });
  await settle();
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no textarea');
  return el;
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function seedTypedPage(): Promise<string> {
  const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
  const page = await createTypedPage({ noteId: note.id, pageIndex: 0 });
  return page.id;
}

describe('TypedPageEditor', () => {
  it('shows the text it was given', async () => {
    await mountEditor({ pageId: 'p1', initialText: 'hello' });
    expect(textarea().value).toBe('hello');
  });

  it('debounce-saves an edit through setPageText, mirroring it into the transcript', async () => {
    const pageId = await seedTypedPage();

    await mountEditor({ pageId, initialText: '', debounceMs: 20 });
    typeInto(textarea(), 'Newton on motion');
    await settle();

    const stored = await getPage(pageId);
    expect(stored?.text).toBe('Newton on motion');
    expect(stored?.transcript?.markdown).toBe('Newton on motion');
    expect(stored?.transcript?.status).toBe('done');
  });

  it('flushes pending text on unmount before the debounce fires', async () => {
    const pageId = await seedTypedPage();

    await mountEditor({ pageId, initialText: '', debounceMs: 10_000 });
    typeInto(textarea(), 'unsaved until unmount');
    act(() => root.unmount());
    await settle();

    expect((await getPage(pageId))?.text).toBe('unsaved until unmount');
  });

  it('surfaces a failed save without losing the typed text, and clears it once a later write succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pageId = await seedTypedPage();

    await mountEditor({ pageId, initialText: '', debounceMs: 20 });
    vi.mocked(setPageText).mockRejectedValueOnce(new Error('disk full'));
    typeInto(textarea(), 'resilient');
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save this page — copy your text somewhere safe.",
    );
    expect(textarea().value).toBe('resilient');
    expect((await getPage(pageId))?.text ?? '').toBe('');

    typeInto(textarea(), 'resilient!');
    await settle();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((await getPage(pageId))?.text).toBe('resilient!');

    consoleError.mockRestore();
  });
});
