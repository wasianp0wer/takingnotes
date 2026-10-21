import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { lineAtCursor, removeLine, taskTitleFromLine } from '@/triage/scratchpadLines';

export interface ScratchpadProps {
  text: string;
  loaded: boolean;
  /**
   * An autosave failure the caller's `useScratchpad` reported. When set it
   * takes the place of the autosave hint, which would otherwise keep claiming
   * a save that did not happen.
   */
  error?: string | null;
  onChange(text: string): void;
  onPromote(title: string): Promise<void> | void;
}

/**
 * A free-form autosaved scratchpad (state owned by the caller's
 * `useScratchpad`) with a "Promote line to task" action: the line under the
 * caret becomes a task title (leading list markers stripped) and is removed
 * from the text, leaving the caret where the line used to start.
 */
export function Scratchpad({ text, loaded, error = null, onChange, onPromote }: ScratchpadProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Set by `promote` right before calling `onChange`; consumed by the effect
  // below once the textarea's value has re-rendered with the shortened text,
  // so the caret restore lands on real content rather than a stale offset.
  const pendingCaretRef = useRef<number | null>(null);
  // The latest `text` prop, so `promote`'s async continuation - resumed
  // after `onPromote` awaits a full storage round trip - can act on what
  // the pad actually contains "now" rather than a stale value captured at
  // click time. Synced in its own effect (not written during render, which
  // React disallows for refs) that runs on every commit, so by the time any
  // event handler can fire again the ref is already current.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    // Don't yank focus away from something the user deliberately focused
    // (a calendar field, another app control) while the save was pending.
    // `document.body` is jsdom/the browser's default when nothing is
    // focused, so that case is still treated as "safe to restore".
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [text]);

  const promote = async () => {
    // Guard against a stray leftover from an earlier call that bailed out
    // after setting this but before a matching `text` re-render consumed it.
    pendingCaretRef.current = null;

    try {
      const el = textareaRef.current;
      const cursor = el?.selectionStart ?? 0;
      const range = lineAtCursor(textRef.current, cursor);
      const title = taskTitleFromLine(range.text);
      if (title === '') {
        setStatus('Put the cursor on a line with text.');
        return;
      }

      try {
        await onPromote(title);
      } catch (err) {
        // The task was never saved - the line is the only copy of that
        // text, so it must not be removed, and the status must tell the
        // user their work wasn't lost.
        console.error('[triage] promote failed', err);
        setStatus("Couldn't add that task — your text is still here.");
        return;
      }

      // `onPromote` awaited a full storage round trip; re-read the pad
      // instead of using the `range`/`text` captured before the await, and
      // re-locate the line at the same start offset. If what's there no
      // longer matches what was promoted, someone (the user, another tab)
      // changed the pad meanwhile - remove nothing rather than risk cutting
      // the wrong text.
      const latestText = textRef.current;
      const currentRange = lineAtCursor(latestText, range.start);
      if (currentRange.text !== range.text) {
        setStatus(`Added “${title}” to tasks. Your edits since then are untouched.`);
        return;
      }

      const r = removeLine(latestText, currentRange);
      pendingCaretRef.current = r.cursor;
      onChange(r.text);
      setStatus(`Added “${title}” to tasks.`);
    } catch (err) {
      // Defense in depth: `promote` is always invoked as `void promote()`,
      // so it must never reject - an unhandled rejection here would be
      // strictly worse than a silently-missing status update.
      console.error('[triage] scratchpad promote failed unexpectedly', err);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void promote();
    }
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-heading">Scratchpad</h2>
        {error ? (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Saved automatically.</span>
        )}
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Scratchpad"
        disabled={!loaded}
        value={text}
        onChange={(e) => {
          setStatus(null);
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'min-h-48 w-full rounded bg-muted px-3 py-2 font-mono text-sm outline-none',
          'placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void promote()}>
          Promote line to task
        </Button>
        {status ? (
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}
