import { describe, expect, it } from 'vitest';

import { isPageTurn, PAGE_INDICATOR_MS } from '@/capture/pageTurnIndicator';
import type { CaptureState } from '@/capture/types';

const idle: CaptureState = { activeSessionId: null, activeNoteId: null, activePageId: null, pageIndex: -1 };
const page0: CaptureState = { activeSessionId: 's1', activeNoteId: 'n1', activePageId: 'p0', pageIndex: 0 };
const page1: CaptureState = { ...page0, activePageId: 'p1', pageIndex: 1 };
const otherNote: CaptureState = { activeSessionId: 's2', activeNoteId: 'n2', activePageId: 'q0', pageIndex: 0 };

describe('isPageTurn', () => {
  it('is a turn when the page changes within the same note', () => {
    expect(isPageTurn(page0, page1)).toBe(true);
  });

  it('is not a turn when a note starts, ends or is replaced', () => {
    expect(isPageTurn(idle, page0)).toBe(false);
    expect(isPageTurn(page1, idle)).toBe(false);
    expect(isPageTurn(page1, otherNote)).toBe(false);
  });

  it('is not a turn when the page did not change', () => {
    expect(isPageTurn(page0, { ...page0 })).toBe(false);
    expect(isPageTurn(idle, idle)).toBe(false);
  });

  it('shows the indicator for two seconds', () => {
    expect(PAGE_INDICATOR_MS).toBe(2000);
  });
});
