import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PageRecord, TranscriptRecord } from '@/storage/types';

import { TranscriptPanel } from './TranscriptPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

describe('TranscriptPanel', () => {
  it("sets a finished transcript in the theme's transcript font", () => {
    render(page({ markdown: 'Newton: F=ma' }));
    expect(elementWithText('Newton: F=ma')?.classList.contains('font-transcript')).toBe(true);
  });

  it("sets a retained previous transcript in the theme's transcript font", () => {
    render(page({ status: 'failed', error: 'boom', markdown: 'older text' }));
    expect(elementWithText('older text')?.classList.contains('font-transcript')).toBe(true);
  });
});
