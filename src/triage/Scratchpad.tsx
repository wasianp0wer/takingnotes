import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { lineAtCursor, removeLine, taskTitleFromLine } from '@/triage/scratchpadLines';

export interface ScratchpadProps {
  text: string;
  loaded: boolean;
  onChange(text: string): void;
  onPromote(title: string): Promise<void> | void;
}

/**
 * A free-form autosaved scratchpad (state owned by the caller's
 * `useScratchpad`) with a "Promote line to task" action: the line under the
 * caret becomes a task title (leading list markers stripped) and is removed
 * from the text, leaving the caret where the line used to start.
 */
export function Scratchpad({ text, loaded, onChange, onPromote }: ScratchpadProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Set by `promote` right before calling `onChange`; consumed by the effect
  // below once the textarea's value has re-rendered with the shortened text,
  // so the caret restore lands on real content rather than a stale offset.
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [text]);

  const promote = async () => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? 0;
    const range = lineAtCursor(text, cursor);
    const title = taskTitleFromLine(range.text);
    if (title === '') {
      setStatus('Put the cursor on a line with text.');
      return;
    }
    await onPromote(title);
    const r = removeLine(text, range);
    pendingCaretRef.current = r.cursor;
    onChange(r.text);
    setStatus(`Added “${title}” to tasks.`);
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
        <h2 className="text-sm font-semibold text-foreground">Scratchpad</h2>
        <span className="text-xs text-muted-foreground">Saved automatically.</span>
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Scratchpad"
        disabled={!loaded}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          'min-h-48 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow]',
          'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
