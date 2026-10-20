import { useEffect, useState } from 'react';

import { useCaptureState } from '@/capture/CaptureContext';
import { listPages } from '@/storage/pages';
import type { PageRecord } from '@/storage/types';
import type { TranscriptionQueue } from '@/transcription/queue';

/**
 * The pages of `noteId`, by `pageIndex`; empty when `noteId` is null. Storage
 * has no change feed, so this reloads on the two signals that mean a page was
 * written: capture state (a new page) and the transcription queue (a
 * transcript status change).
 */
export function useNotePages(noteId: string | null, transcriptionQueue: TranscriptionQueue): PageRecord[] {
  const { activeNoteId, activePageId, pageIndex } = useCaptureState();
  // Tagged with the note it belongs to: without the tag, selecting a second
  // note would show the first one's pages for as long as the new read took.
  const [loaded, setLoaded] = useState<{ noteId: string; rows: PageRecord[] } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(
    () => transcriptionQueue.subscribe(() => setRevision((n) => n + 1)),
    [transcriptionQueue],
  );

  useEffect(() => {
    if (!noteId) return;
    // Cleared on selection change as well as unmount: a slow read for the
    // note the user just navigated away from must not land on the new one.
    let live = true;
    void listPages(noteId)
      .then((rows) => {
        if (live) setLoaded({ noteId, rows });
      })
      .catch((error: unknown) => {
        console.error('[notes] could not list pages', error);
      });
    return () => {
      live = false;
    };
  }, [noteId, activeNoteId, activePageId, pageIndex, revision]);

  return loaded && loaded.noteId === noteId ? loaded.rows : [];
}
