import { useState } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { PageTurnControls } from '@/capture/PageTurnControls';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NoteRecord } from '@/storage/types';
import { ensureTranscriptionQueue } from '@/transcription/startTranscription';
import type { TranscriptionQueue } from '@/transcription/queue';
import { InkCanvas } from '@/notes/InkCanvas';
import { TranscriptPanel } from '@/notes/TranscriptPanel';
import { useNotesData } from '@/notes/useNotesData';

export interface NotesViewProps {
  /** Tests only - a real mount builds its own via `ensureTranscriptionQueue`. */
  queue?: TranscriptionQueue;
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
      {children}
    </span>
  );
}

function NoteListItem({
  note,
  selected,
  active,
  onSelect,
}: {
  note: NoteRecord;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li className={cn('border-b border-border px-4 py-2', selected && 'bg-accent')}>
      {/* The button's text is exactly the title - the date and badges sit
          beside it rather than inside it, so selecting a note by its title
          text never has to account for what else is on the row. */}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className="block w-full text-left text-sm font-medium hover:underline"
      >
        {note.title}
      </button>
      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <span>{new Date(note.startedAt).toLocaleDateString()}</span>
        {note.legacy && <Badge>Legacy</Badge>}
        {active && <Badge>Recording</Badge>}
        {note.status === 'interrupted' && <Badge>Interrupted</Badge>}
      </div>
    </li>
  );
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

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-border">
        <h2 className="px-4 py-3 text-sm font-medium">Notes</h2>
        {notes.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">
            No notes yet — write on the pad to start one.
          </p>
        ) : (
          <ul>
            {notes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                selected={note.id === selectedNoteId}
                active={note.id === state.activeNoteId}
                onSelect={() => selectNote(note.id)}
              />
            ))}
          </ul>
        )}
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <span className="text-sm font-medium">
            {selectedNote ? selectedNote.title : 'No note selected'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void engine.startNote()}>
              New note
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={state.activeNoteId === null}
              onClick={() => void engine.endNote()}
            >
              End note
            </Button>
            {pages.length > 0 && (
              <>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={viewedIndex <= 0}
                  onClick={() => goToPage(viewedIndex - 1)}
                >
                  ‹
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {viewedIndex + 1} of {pages.length}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={viewedIndex >= pages.length - 1}
                  onClick={() => goToPage(viewedIndex + 1)}
                >
                  ›
                </Button>
              </>
            )}
            {/* F4's only mount point (docs/architecture.md §4) - must stay mounted. */}
            <PageTurnControls />
          </div>
        </div>

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
              <TranscriptPanel
                // Remounts per page, so a "Already queued." notice from one
                // page's Retry never shows up against another page.
                key={viewedPage.id}
                page={viewedPage}
                isActivePage={viewedPage.id === state.activePageId}
                onRetry={(pageId) => queue.retry(pageId)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
