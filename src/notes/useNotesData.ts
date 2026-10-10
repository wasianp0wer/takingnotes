import { useEffect, useState } from 'react';

import { useCaptureState } from '@/capture/CaptureContext';
import { matchesTagFilter, type TagFilterMode } from '@/notes/tagFilter';
import { listNotes, listTagVocabulary, tagsOf } from '@/storage/notes';
import { listPages } from '@/storage/pages';
import type { NoteRecord, PageRecord } from '@/storage/types';
import type { TranscriptionQueue } from '@/transcription/queue';

/**
 * S5's sidebar tag filter (K37, A35). State is view-local (S5-A2): it resets
 * whenever `NotesView` remounts, never persisted.
 */
export interface TagFilterState {
  /** Every distinct tag in use, sorted (`listTagVocabulary`, A35). */
  vocabulary: string[];
  /** Tags currently selected, in pick order. */
  selected: string[];
  mode: TagFilterMode;
  /**
   * `notes.length - visibleNotes.length`. The active note is always in
   * `visibleNotes` (⚑), so it is never counted here even when it would not
   * otherwise match.
   */
  hiddenCount: number;
  /**
   * True iff there is an active note, at least one tag is selected, and that
   * note's own tags do not satisfy the filter - the case where "kept visible"
   * and "matches the filter" disagree (⚑'s "say plainly" half).
   */
  activeNoteExempted: boolean;
  /** Adds the tag if absent, removes it if present. */
  toggleTag: (tag: string) => void;
  setMode: (mode: TagFilterMode) => void;
  /** Resets both the selection and the mode to their defaults. */
  clear: () => void;
}

export interface NotesData {
  /** Every note, newest first (`listNotes` order). Unfiltered - unchanged
   * meaning from before S5, so existing selection/follow logic in
   * `NotesView` keeps working on a note the sidebar filter hides (S5-A3). */
  notes: NoteRecord[];
  /**
   * `notes`, narrowed by the tag filter, with the active note always present
   * even when it would not otherwise match (⚑). This is what the sidebar
   * (`NoteList`) renders.
   */
  visibleNotes: NoteRecord[];
  /** Pages of the selected note, by `pageIndex`; empty when nothing is selected. */
  pages: PageRecord[];
  tagFilter: TagFilterState;
  /** Forces a reload outside the four existing triggers - used after a tag write. */
  refresh: () => void;
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
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<TagFilterMode>('or');
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
  /**
   * Bumped by `refresh()`. A tag write is not one of the capture-state
   * signals above (no new note, no new page) - this is the only trigger that
   * would otherwise pick it up.
   */
  const [refreshNonce, setRefreshNonce] = useState(0);

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
    void listTagVocabulary()
      .then((loaded) => {
        if (live) setVocabulary(loaded);
      })
      .catch((error: unknown) => {
        console.error('[notes] could not list tag vocabulary', error);
      });
    return () => {
      live = false;
    };
  }, [activeNoteId, activePageId, pageIndex, revision, refreshNonce]);

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
  }, [selectedNoteId, activeNoteId, activePageId, pageIndex, revision, refreshNonce]);

  // Derived each render, not stored: `visibleNotes` is a view of `notes`
  // filtered by the current selection, with the active note's row never
  // removed by the filter (⚑ - architecture.md §8.4's note to S5).
  const visibleNotes = notes.filter(
    (note) => note.id === activeNoteId || matchesTagFilter(tagsOf(note), selected, mode),
  );
  const hiddenCount = notes.length - visibleNotes.length;
  const activeNote = activeNoteId ? notes.find((note) => note.id === activeNoteId) ?? null : null;
  const activeNoteExempted =
    activeNote !== null &&
    selected.length > 0 &&
    !matchesTagFilter(tagsOf(activeNote), selected, mode);

  function toggleTag(tag: string): void {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function clear(): void {
    setSelected([]);
    setMode('or');
  }

  return {
    notes,
    visibleNotes,
    pages: loadedPages && loadedPages.noteId === selectedNoteId ? loadedPages.rows : [],
    tagFilter: {
      vocabulary,
      selected,
      mode,
      hiddenCount,
      activeNoteExempted,
      toggleTag,
      setMode,
      clear,
    },
    refresh: () => setRefreshNonce((n) => n + 1),
  };
}
