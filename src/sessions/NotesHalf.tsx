import { useRef, useState, useSyncExternalStore } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { GapPanel } from '@/notes/GapPanel';
import { InkCanvas } from '@/notes/InkCanvas';
import { NoteToolbar } from '@/notes/NoteToolbar';
import { getResumeLock } from '@/notes/resumeLock';
import { TranscriptPanel } from '@/notes/TranscriptPanel';
import { TypedPageEditor } from '@/notes/TypedPageEditor';
import type { SessionEntry } from '@/sessions/catalog';
import type { NotesMode } from '@/sessions/sessionsUiStore';
import { isTypedPage } from '@/storage/pages';
import type { PageRecord } from '@/storage/types';
import type { TranscriptionQueue } from '@/transcription/queue';

export interface NotesHalfProps {
  entry: SessionEntry | null;
  pages: PageRecord[];
  pageIndex: number;
  onGoToPage(i: number): void;
  mode: NotesMode;
  onModeChange(mode: NotesMode): void;
  transcriptionQueue: TranscriptionQueue;
  /** K15, computed by the caller (`sessionStartedAtOf(state) !== null`). */
  sessionLocked: boolean;
}

/** The notes half: Handwriting / Transcription switch, toolbar, and the viewed page. */
export function NotesHalf({
  entry,
  pages,
  pageIndex,
  onGoToPage,
  mode,
  onModeChange,
  transcriptionQueue,
  sessionLocked,
}: NotesHalfProps) {
  const engine = useCaptureEngine();
  const state = useCaptureState();
  const resumeLock = getResumeLock();
  const resumePending = useSyncExternalStore(resumeLock.subscribe, resumeLock.getState).pending;

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

  const note = entry?.kind === 'note' ? entry.note : null;
  const viewedIndex = pages.length > 0 ? Math.min(Math.max(pageIndex, 0), pages.length - 1) : 0;
  const viewedPage = pages[viewedIndex];
  const dims = { pageWidth: note?.pageWidth ?? null, pageHeight: note?.pageHeight ?? null };

  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-center px-4 py-2">
        <Switch
          aria-label="Notes view"
          checked={mode === 'transcription'}
          onCheckedChange={(checked) => onModeChange(checked ? 'transcription' : 'handwriting')}
          offLabel="Handwriting"
          onLabel="Transcription"
        />
      </div>
      <NoteToolbar
        // Fix round 1, Important 1 (carried over): §8.3's hazard applies to
        // New note too, so a pending resume locks it like a running session.
        sessionLocked={sessionLocked || resumePending}
        hasActiveNote={state.activeNoteId !== null}
        onNewNote={() => void resumeLock.run(() => engine.startNote())}
        onEndNote={() => void engine.endNote()}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={state.activeNoteId === null || creatingTypedPage || resumePending}
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
        onGoToPage={onGoToPage}
      />
      {note && !viewedPage && (
        <p className="p-4 text-sm text-muted-foreground">
          Resume this session to write or type a page.
        </p>
      )}
      {note && viewedPage && mode === 'handwriting' && (
        <div className="flex flex-1 items-start justify-center overflow-auto p-4">
          {isTypedPage(viewedPage) ? (
            // Remounts per page (key), so a previous page's local edit state
            // never bleeds into the next one shown here.
            <TypedPageEditor
              key={viewedPage.id}
              pageId={viewedPage.id}
              initialText={viewedPage.text ?? ''}
            />
          ) : viewedPage.id === state.activePageId ? (
            <InkCanvas live dims={dims} />
          ) : (
            <InkCanvas strokes={viewedPage.strokes} dims={dims} />
          )}
        </div>
      )}
      {note && viewedPage && mode === 'transcription' && (
        <div className="flex flex-1 flex-col overflow-auto">
          {/* Gap analysis sits above the transcript (owner decision). */}
          <GapPanel
            key={`gaps-${viewedPage.id}`}
            noteId={viewedPage.noteId}
            pageId={viewedPage.id}
          />
          {isTypedPage(viewedPage) ? (
            <TypedPageEditor
              key={viewedPage.id}
              pageId={viewedPage.id}
              initialText={viewedPage.text ?? ''}
            />
          ) : (
            <TranscriptPanel
              key={viewedPage.id}
              page={viewedPage}
              isActivePage={viewedPage.id === state.activePageId}
              onRetry={(pageId) => transcriptionQueue.retry(pageId)}
            />
          )}
        </div>
      )}
    </div>
  );
}
