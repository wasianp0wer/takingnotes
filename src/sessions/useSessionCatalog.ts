import { useCallback, useEffect, useRef, useState } from 'react';

import { useCaptureState } from '@/capture/CaptureContext';
import { listNotes } from '@/storage/notes';
import { listFinishedRecordings } from '@/storage/recordings';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

import { buildSessionCatalog } from './catalog';
import type { SessionCatalog } from './catalog';

const EMPTY: SessionCatalog = { sessions: [], uncategorized: [] };

async function loadFromStorage(): Promise<{
  notes: NoteRecord[];
  finished: RecordingRecord[];
}> {
  const [notes, finished] = await Promise.all([listNotes(), listFinishedRecordings()]);
  return { notes, finished };
}

/**
 * Loads and groups the library, reloading on capture-state changes and on any
 * of the three queue signals. A sequence counter (ported from
 * `RecordingsView`) makes an older load that resolves after a newer one
 * discard its result.
 *
 * `load` is a test-only seam so tests can control resolution order without
 * mocking the storage module; production callers omit it. It must be stable
 * across renders (a changing identity retriggers the load).
 */
export function useSessionCatalog(
  deps: {
    transcriptionQueue: { subscribe(l: () => void): () => void };
    audioQueue: { subscribeChanges(l: () => void): () => void };
    namingQueue: { subscribe(l: () => void): () => void };
  },
  load: () => Promise<{
    notes: NoteRecord[];
    finished: RecordingRecord[];
  }> = loadFromStorage,
): { catalog: SessionCatalog; loaded: boolean; reload(): void } {
  const { activeNoteId, activePageId, pageIndex } = useCaptureState();
  const { transcriptionQueue, audioQueue, namingQueue } = deps;
  const [catalog, setCatalog] = useState<SessionCatalog>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const seqRef = useRef(0);

  const reload = useCallback(() => {
    const seq = ++seqRef.current;
    void load().then(
      ({ notes, finished }) => {
        if (seq !== seqRef.current) return;
        setCatalog(buildSessionCatalog(notes, finished));
        setLoaded(true);
      },
      (error: unknown) => {
        // Keep the last good catalog but mark loaded, so consumers do not wait
        // forever; the next signal retries.
        if (seq !== seqRef.current) return;
        console.error('Session catalog load failed', error);
        setLoaded(true);
      },
    );
  }, [load]);

  useEffect(() => {
    reload();
  }, [reload, activeNoteId, activePageId, pageIndex]);

  useEffect(() => {
    const unsubscribes = [
      transcriptionQueue.subscribe(reload),
      audioQueue.subscribeChanges(reload),
      namingQueue.subscribe(reload),
    ];
    return () => {
      // Invalidates any load still in flight so it cannot apply after unmount.
      seqRef.current += 1;
      for (const off of unsubscribes) off();
    };
  }, [transcriptionQueue, audioQueue, namingQueue, reload]);

  return { catalog, loaded, reload };
}
