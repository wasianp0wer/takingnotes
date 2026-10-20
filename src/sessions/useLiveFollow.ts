import { useEffect, useRef } from 'react';

import { useCaptureState } from '@/capture/CaptureContext';

import { noteKey } from './catalog';
import type { SessionsUiStore } from './sessionsUiStore';

/**
 * Keeps the Sessions UI on what is being written. Mirrors NotesView's
 * previous-value comparisons: only a change after mount counts, so a restored
 * selection is never overridden by the note that was already active on load.
 */
export function useLiveFollow(store: SessionsUiStore): void {
  const { activeNoteId, pageIndex } = useCaptureState();
  const prev = useRef({ activeNoteId, pageIndex });

  useEffect(() => {
    const before = prev.current;
    prev.current = { activeNoteId, pageIndex };
    if (activeNoteId !== before.activeNoteId && activeNoteId !== null) {
      store.followActiveNote(activeNoteId, pageIndex);
    } else if (
      pageIndex !== before.pageIndex &&
      activeNoteId !== null &&
      store.getState().selectedKey === noteKey(activeNoteId)
    ) {
      store.followPage(pageIndex);
    }
  }, [store, activeNoteId, pageIndex]);
}
