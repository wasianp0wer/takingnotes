import { useRef, useState, useSyncExternalStore } from 'react';

import { Keyboard } from 'lucide-react';

import { PageTurnControls } from '@/capture/PageTurnControls';
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
  /** `null` while the pages are still loading (see `useNotePages`). */
  pages: PageRecord[] | null;
  pageIndex: number;
  onGoToPage(i: number): void;
  mode: NotesMode;
  onModeChange(mode: NotesMode): void;
  transcriptionQueue: TranscriptionQueue;
  /** Plays a recording from an offset, for a gap suggestion's time. */
  onSeekRecording?(recordingId: string, startMs: number): void;
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
  onSeekRecording,
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
  const pageList = pages ?? [];
  const viewedIndex =
    pageList.length > 0 ? Math.min(Math.max(pageIndex, 0), pageList.length - 1) : 0;
  const viewedPage = pageList[viewedIndex];
  const dims = { pageWidth: note?.pageWidth ?? null, pageHeight: note?.pageHeight ?? null };

  return (
    <div className="flex h-full flex-col">
      <div
        data-notes-controls
        className="flex items-center justify-center gap-2 px-4 py-2"
      >
        <Switch
          aria-label="Notes view"
          checked={mode === 'transcription'}
          onCheckedChange={(checked) => onModeChange(checked ? 'transcription' : 'handwriting')}
          offLabel="Handwriting"
          onLabel="Transcription"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Type page"
          disabled={state.activeNoteId === null || creatingTypedPage || resumePending}
          title={
            state.activeNoteId === null
              ? 'Start a session or write on the pad to begin'
              : 'Finish this page and start a new, typed one'
          }
          onClick={() => void handleTypePage()}
        >
          <Keyboard aria-hidden="true" />
        </Button>
        {/* F4's only mount point (docs/architecture.md §4) - must stay mounted. */}
        <PageTurnControls variant="icon" />
      </div>
      <NoteToolbar
        pageCount={pageList.length}
        viewedIndex={viewedIndex}
        onGoToPage={onGoToPage}
      />
      {note && pages !== null && !viewedPage && (
        <p className="p-4 text-sm text-muted-foreground">
          Resume this session to write or type a page.
        </p>
      )}
      {note && viewedPage && (
        // One container for both modes. The typed editor sits at the same
        // position in the tree either way, so toggling the mode never remounts
        // it: a remount would re-seed it from `viewedPage.text`, which is stale
        // (typing sends no change signal) and a later keystroke would then
        // overwrite the saved text.
        <div className="flex min-h-0 flex-1 flex-col">
          <div data-notes-scroll className="flex min-h-0 flex-1 flex-col overflow-auto">
            {isTypedPage(viewedPage) ? (
              <TypedPageEditor
                key={viewedPage.id}
                pageId={viewedPage.id}
                initialText={viewedPage.text ?? ''}
              />
            ) : mode === 'handwriting' ? (
              <div className="flex items-start justify-center p-4">
                {viewedPage.id === state.activePageId ? (
                  <InkCanvas live dims={dims} />
                ) : (
                  <InkCanvas strokes={viewedPage.strokes} dims={dims} />
                )}
              </div>
            ) : (
              <TranscriptPanel
                key={viewedPage.id}
                page={viewedPage}
                isActivePage={viewedPage.id === state.activePageId}
                onRetry={(pageId) => transcriptionQueue.retry(pageId)}
              />
            )}
          </div>
          {/* Gap analysis is pinned to the bottom of the half in Transcription
              mode (owner, 2026-10-20): the transcript scrolls above it rather
              than pushing it down to wherever the text ends. It sits after the
              scroller, so the typed editor keeps its place in the tree across a
              mode toggle. Capped so a long gap list scrolls inside its own strip. */}
          {mode === 'transcription' && (
            <div
              data-notes-gaps
              className="max-h-[40%] shrink-0 overflow-auto border-t border-border"
            >
              <GapPanel
                key={`gaps-${viewedPage.id}`}
                noteId={viewedPage.noteId}
                pageId={viewedPage.id}
                noteIsLive={state.activeNoteId === viewedPage.noteId}
                onSeekRecording={onSeekRecording}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
