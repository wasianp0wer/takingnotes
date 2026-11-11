import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageRecord, TranscriptRecord } from '@/storage/types';

import { TranscriptPanel } from './TranscriptPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
/**
 * A failed transcript mounts `<OllamaSetupStatus compact />`, which asks
 * Ollama for its models. Stubbed so these tests never touch the network.
 * Restored only after the file: that request starts after an IndexedDB read,
 * so it can land after the test that caused it has finished.
 */
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchStub = vi.fn(async () => {
    throw new TypeError('no network in tests');
  });
  vi.stubGlobal('fetch', fetchStub);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function page(transcript: Partial<TranscriptRecord>): PageRecord {
  return {
    id: 'p1',
    noteId: 'n1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [],
    pointCount: 0,
    capturedAt: 1,
    render: null,
    finalizedAt: 2,
    transcript: {
      markdown: '',
      model: 'gemma4:12b',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 3,
      ...transcript,
    },
  };
}

function render(p: PageRecord): void {
  act(() => {
    root.render(<TranscriptPanel page={p} isActivePage={false} onRetry={async () => true} />);
  });
}

function elementWithText(text: string): Element | undefined {
  return [...container.querySelectorAll('div')].find((el) => el.textContent === text);
}

/** The Markdown renderer is lazy-loaded; wait for it to replace the plain fallback. */
async function rendererLoaded(): Promise<void> {
  for (let i = 0; i < 50 && !container.querySelector('.katex'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe('TranscriptPanel', () => {
  it("sets a finished transcript in the theme's transcript font", () => {
    render(page({ markdown: 'Newton: F=ma' }));
    expect(elementWithText('Newton: F=ma')?.classList.contains('font-transcript')).toBe(true);
  });

  it("a failed transcript's Ollama check goes to the stub, not the network", async () => {
    render(page({ status: 'failed', error: 'boom' }));
    for (let i = 0; i < 50 && fetchStub.mock.calls.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(String(fetchStub.mock.calls[0]?.[0])).toBe('http://localhost:11434/api/tags');
  });

  it("sets a retained previous transcript in the theme's transcript font", () => {
    render(page({ status: 'failed', error: 'boom', markdown: 'older text' }));
    expect(elementWithText('older text')?.classList.contains('font-transcript')).toBe(true);
  });

  it('frames the transcribed handwriting in its own bordered block', () => {
    render(page({ markdown: 'Newton: F=ma' }));
    const block = elementWithText('Newton: F=ma')!;
    expect(block.hasAttribute('data-transcript-text')).toBe(true);
    expect(block.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['border', 'border-border']),
    );
    // The model/prompt line sits outside the frame.
    expect(block.textContent).not.toContain('gemma4:12b');
  });

  it('frames a retained previous transcript too', () => {
    render(page({ status: 'failed', error: 'boom', markdown: 'older text' }));
    const block = elementWithText('older text')!;
    expect(block.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['border', 'border-border']),
    );
  });

  it('gives the transcript a set area that scrolls on its own instead of growing with the text', () => {
    render(page({ markdown: 'Newton: F=ma' }));
    const block = elementWithText('Newton: F=ma')!;
    const cls = block.className.split(/\s+/);
    // Fills the space it is given and scrolls inside it.
    expect(cls).toEqual(expect.arrayContaining(['flex-1', 'min-h-0', 'overflow-auto']));
    // Its panel fills the notes area as a column, so the block has a set height to fill.
    const panel = block.parentElement!.className.split(/\s+/);
    expect(panel).toEqual(expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0']));
  });

  it('renders the finished transcript as Markdown with maths, inside the frame', async () => {
    render(page({ markdown: '# Causes\n\nwar $\\rightarrow$ amendments' }));
    await rendererLoaded();
    const block = container.querySelector('[data-transcript-text]')!;
    expect(block.querySelector('h1')?.textContent).toBe('Causes');
    expect(block.querySelector('.katex')).not.toBeNull();
    expect(block.textContent).not.toContain('$');
  });

  it('renders a retained previous transcript as Markdown too', async () => {
    render(page({ status: 'failed', error: 'boom', markdown: '- item $\\leq$ 3' }));
    await rendererLoaded();
    expect(container.querySelector('li .katex')).not.toBeNull();
  });
});
