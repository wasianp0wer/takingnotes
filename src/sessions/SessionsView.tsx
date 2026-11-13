import { useEffect, useMemo, useState } from 'react';

import { getAudioRuntime } from '@/audio/audioRuntime';
import type { TranscriptionQueue as AudioTranscriptionQueue } from '@/audio/transcriptionQueue';
import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { sessionStartedAtOf } from '@/capture/engine';
import type { NamingQueue } from '@/notes/naming/queue';
import { ensureNamingQueue } from '@/notes/naming/startNaming';
import { AudioHalf } from '@/sessions/AudioHalf';
import { entryTitle, findEntry, noteKey } from '@/sessions/catalog';
import type { SessionCatalog } from '@/sessions/catalog';
import { filterCatalog } from '@/sessions/filter';
import { NotesHalf } from '@/sessions/NotesHalf';
import { SessionHeader } from '@/sessions/SessionHeader';
import { SessionSidebar } from '@/sessions/SessionSidebar';
import { useSessionsUi } from '@/sessions/SessionsUiContext';
import { useEntryText } from '@/sessions/useEntryText';
import { useNotePages } from '@/sessions/useNotePages';
import { useRegexFilter } from '@/sessions/useRegexFilter';
import { useSessionCatalog } from '@/sessions/useSessionCatalog';
import { tagsOf } from '@/storage/notes';
import type { TranscriptionQueue } from '@/transcription/queue';
import { ensureTranscriptionQueue } from '@/transcription/startTranscription';

export interface SessionsViewProps {
  /** Tests only - a real mount builds its own via `ensureTranscriptionQueue`. */
  queue?: TranscriptionQueue;
  /** Tests only - a real mount builds its own via `ensureNamingQueue`. */
  namingQueue?: NamingQueue;
  /** Tests only - a real mount uses the app-wide `getAudioRuntime().queue`. */
  audioQueue?: AudioTranscriptionQueue;
}

/** Every tag in use, sorted - the advanced filter's tag choices. */
function vocabularyOf(catalog: SessionCatalog): string[] {
  const all = new Set<string>();
  for (const entry of [...catalog.sessions, ...catalog.uncategorized]) {
    if (entry.kind === 'note') for (const tag of tagsOf(entry.note)) all.add(tag);
  }
  return [...all].sort();
}

/**
 * The Sessions tab: the sidebar of sessions and loose entries, and for the
 * selected one its header, notes half and audio half side by side. All view
 * state lives in the Sessions UI store above this component, so a tab switch
 * or a reload restores it.
 */
export function SessionsView(props?: SessionsViewProps) {
  const engine = useCaptureEngine();
  const state = useCaptureState();
  const [ui, store] = useSessionsUi();
  // Module singletons, built once and never stopped when this view unmounts.
  const [queue] = useState<TranscriptionQueue>(
    () => props?.queue ?? ensureTranscriptionQueue(engine),
  );
  const [namingQueue] = useState<NamingQueue>(
    () => props?.namingQueue ?? ensureNamingQueue(engine, queue),
  );
  const [audioQueue] = useState<AudioTranscriptionQueue>(
    () => props?.audioQueue ?? getAudioRuntime().queue,
  );

  const { catalog, loaded, reload } = useSessionCatalog({
    transcriptionQueue: queue,
    audioQueue,
    namingQueue,
  });

  const advanced = ui.sidebarFilter.advanced;
  const textNeeded = advanced.text.trim() !== '' || advanced.hasTypedPage;
  const textByKey = useEntryText(textNeeded, catalog);
  const regex = useRegexFilter(advanced, catalog, textByKey);
  const outcome = filterCatalog(catalog, ui.sidebarFilter, textByKey, state.activeNoteId, regex);
  const vocabulary = useMemo(() => vocabularyOf(catalog), [catalog]);

  // Resolving the selection. The stored key is not validated, so anything not
  // in the loaded catalog falls back quietly: the active note, else the newest
  // session, else the newest uncategorized entry. The live note is exempt -
  // it is selected the moment it starts, before the catalog has reloaded.
  const activeKey = state.activeNoteId === null ? null : noteKey(state.activeNoteId);
  const selectedEntry = findEntry(catalog, ui.selectedKey);
  const selectionHolds =
    selectedEntry !== null || (ui.selectedKey !== null && ui.selectedKey === activeKey);
  const fallbackKey =
    !loaded || selectionHolds
      ? null
      : (findEntry(catalog, activeKey)?.key ??
        catalog.sessions[0]?.key ??
        catalog.uncategorized[0]?.key ??
        null);
  const entry = selectedEntry ?? findEntry(catalog, fallbackKey);

  useEffect(() => {
    if (fallbackKey === null) return;
    store.selectEntry(fallbackKey);
    if (fallbackKey === activeKey) store.goToPage(state.pageIndex);
    // Only a new fallback is acted on; the page is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackKey, store]);

  const pages = useNotePages(entry?.kind === 'note' ? entry.note.id : null, queue);

  // K15: a session locks you into its note.
  const sessionLocked = sessionStartedAtOf(state) !== null;
  // K16: while a locked session writes to one note and another is viewed, say
  // where the writing goes. Names the *active* note, not the viewed one.
  const activeEntry = findEntry(catalog, activeKey);
  const writingDestinationTitle =
    sessionLocked && activeKey !== null && entry?.key !== activeKey && activeEntry !== null
      ? entryTitle(activeEntry)
      : null;

  const recordings =
    entry === null ? [] : entry.kind === 'note' ? entry.recordings : [entry.recording];
  const halfKey = entry?.key ?? 'none';
  const libraryEmpty =
    loaded && catalog.sessions.length === 0 && catalog.uncategorized.length === 0;

  return (
    <div className="flex h-full min-h-0">
      <SessionSidebar
        outcome={outcome}
        selectedKey={entry?.key ?? null}
        activeNoteId={state.activeNoteId}
        filter={ui.sidebarFilter}
        onFilterChange={store.setSidebarFilter}
        advancedOpen={ui.advancedFilterOpen}
        onAdvancedOpenChange={store.setAdvancedFilterOpen}
        vocabulary={vocabulary}
        onSelect={store.selectEntry}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {libraryEmpty && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No sessions yet. Use Start session in the header to begin one.
          </p>
        )}
        <SessionHeader
          entry={entry}
          activeNoteId={state.activeNoteId}
          sessionLocked={sessionLocked}
          writingDestinationTitle={writingDestinationTitle}
          onChanged={reload}
        />
        <div className="flex min-h-0 flex-1 gap-2 p-2">
          <section
            data-half="notes"
            aria-label="Notes"
            className="min-h-0 min-w-0 flex-1 border border-border"
          >
            <NotesHalf
              key={halfKey}
              entry={entry}
              pages={pages}
              pageIndex={ui.pageIndex}
              onGoToPage={store.goToPage}
              mode={ui.notesMode}
              onModeChange={store.setNotesMode}
              transcriptionQueue={queue}
              sessionLocked={sessionLocked}
              onSeekRecording={store.seekRecording}
            />
          </section>
          <section
            data-half="audio"
            aria-label="Audio"
            className="bg-surface/40 min-h-0 min-w-0 flex-1 border border-border"
          >
            <AudioHalf
              key={halfKey}
              recordings={recordings}
              selectedRecordingId={ui.recordingId}
              onSelectRecording={store.selectRecording}
              seek={ui.seek}
              onSeekApplied={store.clearSeek}
              followNewest={entry !== null && entry.key === activeKey}
              audioQueue={audioQueue}
              onChanged={reload}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
