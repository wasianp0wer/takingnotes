import { useState } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { sessionStartedAtOf } from '@/capture/engine';
import { ensureTranscriptionQueue } from '@/transcription/startTranscription';
import type { TranscriptionQueue } from '@/transcription/queue';
import { GapPanel } from '@/notes/GapPanel';
import { InkCanvas } from '@/notes/InkCanvas';
import { NoteList } from '@/notes/NoteList';
import { NoteToolbar } from '@/notes/NoteToolbar';
import { ResumeButton } from '@/notes/ResumeButton';
import { TranscriptPanel } from '@/notes/TranscriptPanel';
import { useNotesData } from '@/notes/useNotesData';

export interface NotesViewProps {
  /** Tests only - a real mount builds its own via `ensureTranscriptionQueue`. */
  queue?: TranscriptionQueue;
}

/**
 * The note list, the live/stored ink for the selected page and its
 * transcript, plus F4's page-turn controls (the only place they mount - see
 * `PageTurnControls`'s own header comment).
 */
export function NotesView(props?: NotesViewProps) {
  const engine = useCaptureEngine();
  const state = useCaptureState();
  // A module singleton (F1-A7): built once, never rebuilt on re-render and
  // never stopped when this view unmounts.
  const [queue] = useState<TranscriptionQueue>(
    () => props?.queue ?? ensureTranscriptionQueue(engine),
  );

  // `null` means "no explicit choice yet" - resolved below to the active
  // note, and failing that the newest one, as soon as we know what those
  // are. Once resolved (or once the user clicks a note), this holds its id.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Viewed page index. Kept in sync with `state.pageIndex` while the note
  // being viewed is the one being recorded (see below); free to navigate
  // independently otherwise.
  const [pageIndex, setPageIndex] = useState(0);

  const { notes, pages } = useNotesData(selectedNoteId, queue);

  // Resolves the default selection and follows the active note. Both are
  // done here, during render (comparing against state, not a ref - refs
  // can't be read or written during render), rather than in an effect: an
  // effect would commit the placeholder frame (no selection / the old page)
  // before catching up a tick later, and a note starting or turning a page
  // is exactly the moment that flash would be most visible.
  const [prevActiveNoteId, setPrevActiveNoteId] = useState(state.activeNoteId);
  const activeNoteIdChanged = prevActiveNoteId !== state.activeNoteId;
  if (activeNoteIdChanged) setPrevActiveNoteId(state.activeNoteId);

  // Tracked separately from `activeNoteIdChanged` so a page turn on the
  // active note is only followed on the render where it happens - not on
  // every render for as long as the user has since navigated elsewhere.
  const [prevActivePageIndex, setPrevActivePageIndex] = useState(state.pageIndex);
  const activePageIndexChanged = prevActivePageIndex !== state.pageIndex;
  if (activePageIndexChanged) setPrevActivePageIndex(state.pageIndex);

  if (activeNoteIdChanged && state.activeNoteId !== null) {
    // A note just became (or stayed) active: follow it and its live page,
    // overriding whatever the user had picked.
    if (selectedNoteId !== state.activeNoteId) setSelectedNoteId(state.activeNoteId);
    if (pageIndex !== state.pageIndex) setPageIndex(state.pageIndex);
  } else if (selectedNoteId === null) {
    // Nothing chosen yet: the active note if there is one, else the newest
    // (`notes` is newest-first - see `listNotes`).
    const fallback = state.activeNoteId ?? notes[0]?.id ?? null;
    if (fallback !== null) {
      setSelectedNoteId(fallback);
      if (fallback === state.activeNoteId) setPageIndex(state.pageIndex);
    }
  } else if (activePageIndexChanged && selectedNoteId === state.activeNoteId) {
    // Viewing the active note while it turns pages: follow along.
    setPageIndex(state.pageIndex);
  }

  const selectedNote = notes.find((n) => n.id === selectedNoteId) ?? null;
  const viewedIndex = pages.length > 0 ? Math.min(Math.max(pageIndex, 0), pages.length - 1) : 0;
  const viewedPage = pages[viewedIndex];

  function selectNote(id: string) {
    setSelectedNoteId(id);
    setPageIndex(0);
  }

  function goToPage(index: number) {
    setPageIndex(index);
  }

  const dims = {
    pageWidth: selectedNote?.pageWidth ?? null,
    pageHeight: selectedNote?.pageHeight ?? null,
  };

  // K15: a session locks you into its note, so New note must be disabled
  // while one is running.
  const sessionLocked = sessionStartedAtOf(state) !== null;

  // K16: viewing anything other than the active note while a session is
  // locked still shows that writing is going somewhere - chosen over a hard
  // lock so a lecture can be checked against an older note without ending
  // the session. Names the *active* note, not the one being viewed.
  const activeNoteTitle = notes.find((n) => n.id === state.activeNoteId)?.title ?? null;
  const showsWritingDestination =
    sessionLocked && state.activeNoteId !== null && selectedNoteId !== state.activeNoteId;

  return (
    <div className="flex h-full">
      <NoteList
        notes={notes}
        selectedNoteId={selectedNoteId}
        activeNoteId={state.activeNoteId}
        onSelect={selectNote}
        rowActions={(note) => (
          <ResumeButton
            note={note}
            engine={engine}
            activeNoteId={state.activeNoteId}
            sessionLocked={sessionLocked}
          />
        )}
      />

      <div className="flex flex-1 flex-col">
        <NoteToolbar
          noteTitle={selectedNote?.title ?? null}
          sessionLocked={sessionLocked}
          hasActiveNote={state.activeNoteId !== null}
          onNewNote={() => void engine.startNote()}
          onEndNote={() => void engine.endNote()}
          pageCount={pages.length}
          viewedIndex={viewedIndex}
          onGoToPage={goToPage}
          banner={
            showsWritingDestination && activeNoteTitle !== null ? (
              <p
                role="status"
                className="px-4 py-1 text-xs text-muted-foreground"
              >
                {`Writing still goes to "${activeNoteTitle}"`}
              </p>
            ) : undefined
          }
        />

        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 items-start justify-center overflow-auto p-4">
            {viewedPage &&
              (viewedPage.id === state.activePageId ? (
                <InkCanvas live dims={dims} />
              ) : (
                <InkCanvas strokes={viewedPage.strokes} dims={dims} />
              ))}
          </div>
          <div className="w-96 shrink-0 overflow-auto border-l border-border">
            {viewedPage && (
              <>
                <TranscriptPanel
                  // Remounts per page, so a "Already queued." notice from one
                  // page's Retry never shows up against another page.
                  key={viewedPage.id}
                  page={viewedPage}
                  isActivePage={viewedPage.id === state.activePageId}
                  onRetry={(pageId) => queue.retry(pageId)}
                />
                {/* P1's only mount point (docs/architecture.md §6.7). The note
                    id comes off the page itself, so it is never out of step with
                    the page being shown. Keyed per page for the same reason as
                    the transcript panel. */}
                <GapPanel
                  key={`gaps-${viewedPage.id}`}
                  noteId={viewedPage.noteId}
                  pageId={viewedPage.id}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
