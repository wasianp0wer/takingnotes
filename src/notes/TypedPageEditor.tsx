import { useCallback, useEffect, useRef, useState } from 'react';

import { setPageText } from '@/storage/pages';

export interface TypedPageEditorProps {
  pageId: string;
  /**
   * Seeds local state once. The parent remounts this component per page
   * (`key={page.id}`, the pattern `TranscriptPanel`/`GapPanel` already use),
   * so a stale value from a previously-viewed page is never a concern.
   */
  initialText: string;
  /** Tests only; defaults to 500ms like `useScratchpad`. */
  debounceMs?: number;
}

const SAVE_FAILED = "Couldn't save this page — copy your text somewhere safe.";

/**
 * A typed page's text (K32, K35), autosaved on a debounce through
 * `setPageText` - which mirrors it into the page's transcript (K33), so
 * nothing here writes `transcript` directly. Follows `useScratchpad`'s own
 * dirty-tracking and flush-on-unmount pattern; it cannot reuse that hook,
 * which is hardwired to the single `triage.scratchpad` setting key rather
 * than a per-page write. "Dirty" is `pendingTextRef.current !==
 * persistedRef.current`, not a boolean, so a write that lands after a newer
 * edit already superseded it can never falsely mark the page saved.
 */
export function TypedPageEditor({ pageId, initialText, debounceMs = 500 }: TypedPageEditorProps) {
  const [text, setTextState] = useState(initialText);
  const [error, setError] = useState<string | null>(null);

  const pendingTextRef = useRef(initialText);
  const persistedRef = useRef(initialText);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const errorRef = useRef<string | null>(null);

  const showError = useCallback((next: string | null) => {
    if (!mountedRef.current || errorRef.current === next) return;
    errorRef.current = next;
    setError(next);
  }, []);

  const isDirty = useCallback(() => pendingTextRef.current !== persistedRef.current, []);

  const writeNow = useCallback(
    (value: string): Promise<void> => {
      const run = writeQueueRef.current
        .then(() => setPageText(pageId, value))
        .then(
          () => {
            persistedRef.current = value;
            showError(null);
          },
          (err: unknown) => {
            // Left un-rethrown on purpose, same reasoning as useScratchpad:
            // a failed write must not wedge the queue and must not become an
            // unhandled rejection for the debounce timer or the unmount
            // flush, both of which call this fire-and-forget.
            console.error('[notes] typed page save failed', err);
            showError(SAVE_FAILED);
          },
        );
      writeQueueRef.current = run;
      return run;
    },
    [pageId, showError],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // The owner's typing must survive navigating to another page: this
      // component is remounted (not just hidden) per page, so losing the
      // pending write here would lose it for good.
      if (isDirty()) writeNow(pendingTextRef.current);
    };
  }, [isDirty, writeNow]);

  const setText = useCallback(
    (next: string) => {
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

  return (
    <div className="flex w-full max-w-2xl flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Typed page</h2>
        {error ? (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Saved automatically.</span>
        )}
      </div>
      <textarea
        aria-label="Typed page text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-96 w-full flex-1 resize-none rounded bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
      />
    </div>
  );
}
