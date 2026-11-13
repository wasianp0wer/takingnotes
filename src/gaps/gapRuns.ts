import { useCallback, useSyncExternalStore } from 'react';

/**
 * Notes with a gap analysis run in flight, held at module level so it outlives
 * any one `GapPanel` mount: the panel remounts per page, and a run started on
 * one page must still read as running (and still block a second run, and the
 * review's Submit) on the next.
 */
const running = new Set<string>();
/**
 * How many times each note's runs have reported progress. A panel reloads when
 * it moves, so a page's `pending` / `running` / `done` shows while the run is
 * still going rather than only once the whole note is finished.
 */
const progress = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isGapRunActive(noteId: string): boolean {
  return running.has(noteId);
}

export function gapRunProgress(noteId: string): number {
  return progress.get(noteId) ?? 0;
}

export function subscribeGapRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `task` as the note's gap run. The mark is set synchronously, before any
 * `await`, so two presses in one batch cannot both start a run. Resolves to
 * false, without calling `task`, when a run for the note is already in flight;
 * a rejection from `task` is passed on after the mark is cleared.
 *
 * `task` is handed a `report` to call whenever the run has written something a
 * panel should show (see `gapRunProgress`).
 */
export async function runGapAnalysis(
  noteId: string,
  task: (report: () => void) => Promise<void>,
): Promise<boolean> {
  if (running.has(noteId)) return false;
  running.add(noteId);
  notify();
  const report = (): void => {
    progress.set(noteId, gapRunProgress(noteId) + 1);
    notify();
  };
  try {
    await task(report);
    return true;
  } finally {
    running.delete(noteId);
    notify();
  }
}

/** Whether the note has a gap run in flight, kept current for React. */
export function useGapRunActive(noteId: string): boolean {
  const getSnapshot = useCallback(() => running.has(noteId), [noteId]);
  return useSyncExternalStore(subscribeGapRuns, getSnapshot);
}

/** The note's progress count (`gapRunProgress`), kept current for React. */
export function useGapRunProgress(noteId: string): number {
  const getSnapshot = useCallback(() => gapRunProgress(noteId), [noteId]);
  return useSyncExternalStore(subscribeGapRuns, getSnapshot);
}

/** Tests only. */
export function resetGapRuns(): void {
  running.clear();
  progress.clear();
  notify();
}
