import { useEffect, useState } from 'react';

import { useCaptureState } from '@/capture/CaptureContext';
import { listNotes } from '@/storage/notes';
import { listPages } from '@/storage/pages';
import type { NoteRecord, PageRecord } from '@/storage/types';
import type { TranscriptionQueue } from '@/transcription/queue';

export interface NotesData {
  /** Every note, newest first (`listNotes` order). */
  notes: NoteRecord[];
  /** Pages of the selected note, by `pageIndex`; empty when nothing is selected. */
  pages: PageRecord[];
}

/**
 * Storage reads for the notes view, kept out of the components so they stay
 * thin. Storage has no change feed, so this reloads on the two signals that
 * mean something was written: the capture state (a new note, a new page) and
 * the transcription queue (a transcript status change).
 */
export function useNotesData(
  selectedNoteId: string | null,
  queue: TranscriptionQueue,
): NotesData {
  const { activeNoteId, activePageId, pageIndex } = useCaptureState();
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  /**
   * Tagged with the note it belongs to. Without the tag, clicking a second note
   * would show the first one's page count, ink and transcript for as long as the
   * new read took - which is exactly the moment the user is looking.
   */
  const [loadedPages, setLoadedPages] = useState<{ noteId: string; rows: PageRecord[] } | null>(
    null,
  );
  /** Bumped by the queue; the reload effects list it as a dependency. */
  const [revision, setRevision] = useState(0);

  useEffect(() => queue.subscribe(() => setRevision((n) => n + 1)), [queue]);

  useEffect(() => {
    let live = true;
    void listNotes()
      .then((loaded) => {
        if (live) setNotes(loaded);
      })
      .catch((error: unknown) => {
        console.error('[notes] could not list notes', error);
      });
    return () => {
      live = false;
    };
  }, [activeNoteId, activePageId, pageIndex, revision]);

  useEffect(() => {
    // No selection means nothing to load - the "no rows" case is derived
    // below rather than written here, so there is no state to clear when the
    // selection goes back to null.
    if (!selectedNoteId) return;
    // Cleared on selection change as well as unmount: a slow read for the note
    // the user just navigated away from must not land on top of the new one.
    let live = true;
    void listPages(selectedNoteId)
      .then((rows) => {
        if (live) setLoadedPages({ noteId: selectedNoteId, rows });
      })
      .catch((error: unknown) => {
        console.error('[notes] could not list pages', error);
      });
    return () => {
      live = false;
    };
  }, [selectedNoteId, activeNoteId, activePageId, pageIndex, revision]);

  return {
    notes,
    pages: loadedPages && loadedPages.noteId === selectedNoteId ? loadedPages.rows : [],
  };
}
