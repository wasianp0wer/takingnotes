import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { sessionStartedAtOf } from '@/capture/engine';
import { ensureTranscriptionQueue } from '@/transcription/startTranscription';
import type { TranscriptionQueue } from '@/transcription/queue';
import { Button } from '@/components/ui/button';
import { GapPanel } from '@/notes/GapPanel';
import { InkCanvas } from '@/notes/InkCanvas';
import type { NamingQueue } from '@/notes/naming/queue';
import { ensureNamingQueue } from '@/notes/naming/startNaming';
import { NoteList } from '@/notes/NoteList';
import { NoteTitle } from '@/notes/NoteTitle';
import { NoteToolbar } from '@/notes/NoteToolbar';
import { getResumeLock } from '@/notes/resumeLock';
import { ResumeButton } from '@/notes/ResumeButton';
import { TagEditor } from '@/notes/TagEditor';
import { TagFilterBar } from '@/notes/TagFilterBar';
import { TranscriptPanel } from '@/notes/TranscriptPanel';
import { TypedPageEditor } from '@/notes/TypedPageEditor';
import { useNotesData } from '@/notes/useNotesData';
import { tagsOf } from '@/storage/notes';
import { isTypedPage } from '@/storage/pages';

export interface NotesViewProps {
  /** Tests only - a real mount builds its own via `ensureTranscriptionQueue`. */
  queue?: TranscriptionQueue;
  /** Tests only - a real mount builds its own via `ensureNamingQueue`. */
  namingQueue?: NamingQueue;
}

/**
 * The note list, the live/stored ink for the selected page and its
 * transcript, plus F4's page-turn controls (the only place they mount - see
 * `PageTurnControls`'s own header comment).
 */
export function NotesView(props?: NotesViewProps) {
  const engine = useCaptureEngine();
  const state = useCaptureState();
  const resumeLock = getResumeLock();
  const resumeLockState = useSyncExternalStore(resumeLock.subscribe, resumeLock.getState);
  // A module singleton (F1-A7): built once, never rebuilt on re-render and
  // never stopped when this view unmounts.
  const [queue] = useState<TranscriptionQueue>(
    () => props?.queue ?? ensureTranscriptionQueue(engine),
  );
  // Also a module singleton, built once here alongside the transcription
  // queue it subscribes to (K17's second trigger).
  const [namingQueue] = useState<NamingQueue>(
    () => props?.namingQueue ?? ensureNamingQueue(engine, queue),
  );

  // `null` means "no explicit choice yet" - resolved below to the active
  // note, and failing that the newest one, as soon as we know what those
  // are. Once resolved (or once the user clicks a note), this holds its id.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Viewed page index. Kept in sync with `state.pageIndex` while the note
  // being viewed is the one being recorded (see below); free to navigate
  // independently otherwise.
  const [pageIndex, setPageIndex] = useState(0);

  const { notes, visibleNotes, pages, tagFilter, reloadNotes } = useNotesData(
    selectedNoteId,
    queue,
  );

  // Fix round 1, Important 5: a generated title/summary (K17-K18) touches
  // neither capture state nor the transcription queue - useNotesData's own
  // two reload triggers - so without this the sidebar and toolbar kept
  // showing the timestamp title until something unrelated (a page turn, a
  // later transcript change) happened to re-trigger a read. This is the
  // naming queue's `subscribe` declared for exactly this; nothing consumed
  // it before.
  useEffect(() => namingQueue.subscribe(() => reloadNotes()), [namingQueue, reloadNotes]);

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

  // Debounces a double-click into one typed page, the same pattern
  // `PageTurnControls`'s own "New page" button uses for its manual turn.
  const [creatingTypedPage, setCreatingTypedPage] = useState(false);
  const typedPageInFlight = useRef(false);

  async function handleTypePage() {
    if (typedPageInFlight.current) return;
    typedPageInFlight.current = true;
    setCreatingTypedPage(true);
    try {
      await engine.newTypedPage();
    } catch (error) {
      console.error('[notes] starting a typed page failed', error);
    } finally {
      typedPageInFlight.current = false;
      setCreatingTypedPage(false);
    }
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
        notes={visibleNotes}
        selectedNoteId={selectedNoteId}
        activeNoteId={state.activeNoteId}
        onSelect={selectNote}
        filter={
          <TagFilterBar
            vocabulary={tagFilter.vocabulary}
            selected={tagFilter.selected}
            mode={tagFilter.mode}
            hiddenCount={tagFilter.hiddenCount}
            activeNoteExempted={tagFilter.activeNoteExempted}
            onToggleTag={tagFilter.toggleTag}
            onModeChange={tagFilter.setMode}
            onClear={tagFilter.clear}
          />
        }
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
          title={
            selectedNote ? (
              <NoteTitle
                key={selectedNote.id}
                noteId={selectedNote.id}
                title={selectedNote.title}
                onRenamed={reloadNotes}
              />
            ) : undefined
          }
          meta={
            selectedNote ? (
              <TagEditor
                noteId={selectedNote.id}
                tags={tagsOf(selectedNote)}
                onChanged={reloadNotes}
              />
            ) : undefined
          }
          // Fix round 1, Important 1: §8.3's hazard applies to New note too
          // - sessionStartedAtOf(state) reads null during a pending resume
          // just as much as during a pending startSession(), so New note
          // must be disabled for that window too, not only while a session
          // it already opened is locked.
          sessionLocked={sessionLocked || resumeLockState.pending}
          hasActiveNote={state.activeNoteId !== null}
          onNewNote={() => void resumeLock.run(() => engine.startNote())}
          onEndNote={() => void engine.endNote()}
          actions={
            <Button
              variant="outline"
              size="sm"
              // Fix round 2, Fix 4: the only mutating toolbar control that
              // wasn't gated on the resume lock. §8.3's hazard window is
              // this call's too - it reads `state.activeNoteId`/`pageIndex`
              // (inside its own op) while a resume elsewhere may still be
              // between `noteOpen = true` and publishing the resumed note's
              // state - so disabling while `resumeLockState.pending` matches
              // New note's own gating rather than leaning on the engine's
              // op-chain FIFO to keep this correct by accident.
              disabled={
                state.activeNoteId === null || creatingTypedPage || resumeLockState.pending
              }
              title={
                state.activeNoteId === null
                  ? 'Start a note to begin typing'
                  : 'Finish this page and start a new, typed one'
              }
              onClick={() => void handleTypePage()}
            >
              Type page
            </Button>
          }
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
              (isTypedPage(viewedPage) ? (
                // Remounts per page (key), so a previous page's local edit
                // state (and its own flush-on-unmount) never bleeds into the
                // next one shown here.
                <TypedPageEditor key={viewedPage.id} pageId={viewedPage.id} initialText={viewedPage.text ?? ''} />
              ) : viewedPage.id === state.activePageId ? (
                <InkCanvas live dims={dims} />
              ) : (
                <InkCanvas strokes={viewedPage.strokes} dims={dims} />
              ))}
          </div>
          <div className="w-96 shrink-0 overflow-auto border-l border-border">
            {viewedPage && (
              <>
                {/* A typed page's "transcription" is already done the moment
                    its text is non-blank (K33), and it's already visible in
                    the editor above - showing this too would either duplicate
                    it or, while it's the active page, wrongly say "Transcribed
                    when the page is finished". */}
                {!isTypedPage(viewedPage) && (
                  <TranscriptPanel
                    // Remounts per page, so a "Already queued." notice from one
                    // page's Retry never shows up against another page.
                    key={viewedPage.id}
                    page={viewedPage}
                    isActivePage={viewedPage.id === state.activePageId}
                    onRetry={(pageId) => queue.retry(pageId)}
                  />
                )}
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
