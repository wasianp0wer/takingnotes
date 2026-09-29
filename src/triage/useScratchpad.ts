import { useCallback, useEffect, useRef, useState } from 'react';

import { getSettingValue, setSettingValue } from '@/storage/settingKeys';

export interface ScratchpadState {
  text: string;
  loaded: boolean;
  setText(next: string): void;
  flush(): Promise<void>;
}

/**
 * A single autosaved setting (`triage.scratchpad`), debounced so every
 * keystroke doesn't hit IndexedDB. Writes are chained on `writeQueueRef` so
 * they always land in the order they were issued, and the pending write is
 * flushed immediately on unmount so closing the tab never loses text.
 */
export function useScratchpad(opts?: { debounceMs?: number }): ScratchpadState {
  const debounceMs = opts?.debounceMs ?? 500;

  const [text, setTextState] = useState('');
  const [loaded, setLoaded] = useState(false);

  // The latest text pending a write. Set from `setText` (an event handler,
  // not render) so this never touches `.current` during render.
  const pendingTextRef = useRef('');
  // True once `setText` has been called, so the load below knows the stored
  // value it is about to apply is already stale.
  const editedRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const writeNow = useCallback((value: string): Promise<void> => {
    dirtyRef.current = false;
    const run = writeQueueRef.current.then(() => setSettingValue('triage.scratchpad', value));
    writeQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return writeQueueRef.current;
    return writeNow(pendingTextRef.current);
  }, [writeNow]);

  useEffect(() => {
    let mounted = true;
    getSettingValue('triage.scratchpad').then((stored) => {
      if (!mounted) return;
      if (!editedRef.current) setTextState(stored);
      setLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Separate from the load effect above so its cleanup - flushing pending
  // text - runs on every unmount (including StrictMode's throwaway one),
  // never depending on whether the load has resolved yet.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current) writeNow(pendingTextRef.current);
    };
  }, [writeNow]);

  const setText = useCallback(
    (next: string) => {
      editedRef.current = true;
      dirtyRef.current = true;
      pendingTextRef.current = next;
      setTextState(next);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        writeNow(next);
      }, debounceMs);
    },
    [debounceMs, writeNow],
  );

  return { text, loaded, setText, flush };
}
