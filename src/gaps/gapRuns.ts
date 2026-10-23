import { useCallback, useSyncExternalStore } from 'react';

/**
 * Notes with a gap analysis run in flight, held at module level so it outlives
 * any one `GapPanel` mount: the panel remounts per page, and a run started on
 * one page must still read as running (and still block a second run, and the
 * review's Submit) on the next.
 */
const running = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isGapRunActive(noteId: string): boolean {
  return running.has(noteId);
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
 */
export async function runGapAnalysis(
  noteId: string,
  task: () => Promise<void>,
): Promise<boolean> {
  if (running.has(noteId)) return false;
  running.add(noteId);
  notify();
  try {
    await task();
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

/** Tests only. */
export function resetGapRuns(): void {
  running.clear();
  notify();
}
