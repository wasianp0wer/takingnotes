import { useCallback, useEffect, useRef, useState } from 'react';

import { getSettingValue, setSettingValue } from '@/storage/settingKeys';

export interface ScratchpadState {
  text: string;
  loaded: boolean;
  /**
   * Set while the last write attempt is known to have failed, so the UI can
   * stop claiming the text is saved; cleared by the next successful write.
   */
  error: string | null;
  setText(next: string): void;
  flush(): Promise<void>;
}

/**
 * Deliberately blunt: the text survives in the textarea and is retried, but a
 * retry can fail too, so the user is told to take their own copy.
 */
const SAVE_FAILED = "Couldn't save the scratchpad — copy your text somewhere safe.";

/**
 * A single autosaved setting (`triage.scratchpad`), debounced so every
 * keystroke doesn't hit IndexedDB. Writes are chained on `writeQueueRef` so
 * they always land in the order they were issued, and the pending write is
 * flushed immediately on unmount so closing the tab never loses text.
 *
 * "Dirty" is not a boolean flag but a comparison between `pendingTextRef`
 * (what the user wants saved) and `persistedRef` (what a write last actually
 * confirmed was saved). `persistedRef` only moves forward on a *successful*
 * write of that exact value, so a failed write - or a write that finishes
 * after a newer edit has already superseded it - can never falsely mark the
 * text as saved.
 */
export function useScratchpad(opts?: { debounceMs?: number }): ScratchpadState {
  const debounceMs = opts?.debounceMs ?? 500;

  const [text, setTextState] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The latest text the user wants persisted. Set from `setText` (an event
  // handler, not render) so this never touches `.current` during render.
  const pendingTextRef = useRef('');
  // The latest text a write has confirmed landed in storage.
  const persistedRef = useRef('');
  // True once `setText` has been called, so the load below knows the stored
  // value it is about to apply is already stale.
  const editedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Writes outlive the component (the unmount cleanup flushes pending text),
  // so their `setError` must be skipped once there is nothing left to tell.
  const mountedRef = useRef(true);
  // Mirrors `error`, so the common case - a successful write clearing an error
  // that was never set - schedules no update at all.
  const errorRef = useRef<string | null>(null);

  const showError = useCallback((next: string | null) => {
    if (!mountedRef.current || errorRef.current === next) return;
    errorRef.current = next;
    setError(next);
  }, []);

  const isDirty = useCallback(() => pendingTextRef.current !== persistedRef.current, []);

  const writeNow = useCallback((value: string): Promise<void> => {
    const run = writeQueueRef.current
      .then(() => setSettingValue('triage.scratchpad', value))
      .then(
        () => {
          persistedRef.current = value;
          showError(null);
        },
        (err: unknown) => {
          // Left un-rethrown on purpose: a failed write must not wedge the
          // queue (later writes still need to run) and must not become an
          // unhandled rejection for a fire-and-forget caller (the debounce
          // timer, the unmount cleanup). `isDirty()` stays true because
          // `persistedRef` was not advanced, so the next flush or unmount
          // retries the same text. The failure is still surfaced through
          // `error`, so the UI stops claiming the text has been saved.
          console.error('[triage] scratchpad save failed', err);
          showError(SAVE_FAILED);
        },
      );
    writeQueueRef.current = run;
    return run;
  }, [showError]);

  const flush = useCallback((): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!isDirty()) return writeQueueRef.current;
    return writeNow(pendingTextRef.current);
  }, [isDirty, writeNow]);

  useEffect(() => {
    let mounted = true;
    getSettingValue('triage.scratchpad')
      .then((stored) => {
        if (!mounted) return;
        if (!editedRef.current) {
          setTextState(stored);
          pendingTextRef.current = stored;
          persistedRef.current = stored;
        }
        setLoaded(true);
      })
      .catch((err: unknown) => {
        // The user must still be able to type even if the initial read
        // failed - `loaded` unblocks the UI, and whatever they type from
        // here is tracked normally (pendingTextRef starts at '', so it is
        // "dirty" the moment they type and gets saved through the usual path).
        console.error('[triage] scratchpad load failed', err);
        if (!mounted) return;
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (isDirty()) writeNow(pendingTextRef.current);
    };
  }, [isDirty, writeNow]);

  const setText = useCallback(
    (next: string) => {
      editedRef.current = true;
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

  return { text, loaded, error, setText, flush };
}
