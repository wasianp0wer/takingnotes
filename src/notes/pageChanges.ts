import { createEmitter } from '@/device/emitter';

/**
 * Storage has no change feed, so a writer that adds a page outside the capture
 * engine (the gap review's Submit) announces it here and `useNotePages`
 * reloads.
 */
const emitter = createEmitter<string>();

export function notifyPagesChanged(noteId: string): void {
  emitter.emit(noteId);
}

export function subscribePagesChanged(listener: (noteId: string) => void): () => void {
  return emitter.subscribe(listener);
}
