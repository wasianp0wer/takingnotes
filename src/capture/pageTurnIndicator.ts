import type { CaptureState } from '@/capture/types';

/** How long the "Page N" indicator stays up after the most recent turn. */
export const PAGE_INDICATOR_MS = 2000;

/**
 * True when the active page changed within the same note - a device turn, the
 * "New page" button, or anything else that called `newPage`. Starting, ending
 * or switching notes is not a turn.
 */
export function isPageTurn(prev: CaptureState, next: CaptureState): boolean {
  return (
    prev.activeNoteId !== null &&
    prev.activeNoteId === next.activeNoteId &&
    next.activePageId !== null &&
    prev.activePageId !== next.activePageId
  );
}
