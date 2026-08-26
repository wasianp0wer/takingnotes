export interface Emitter<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

/**
 * Minimal multi-subscriber fan-out. Exists because HuionNoteBLE's callbacks
 * are single-slot: a second consumer would silently replace the first.
 */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(value) {
      // Iterate a copy so a listener that subscribes or unsubscribes during
      // delivery cannot change who receives this event.
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          // One broken consumer must not stop the others - a thrown error in
          // the preview canvas cannot be allowed to halt session recording.
          console.error('[emitter] subscriber threw', error);
        }
      }
    },
  };
}
