import { useEffect, useRef, useState } from 'react';

import { renameNote } from '@/storage/notes';

export interface NoteTitleProps {
  noteId: string;
  title: string;
  /** Called after a successful rename - the caller's list of notes has no other signal for it. */
  onRenamed?: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * K20: the note title, inline-editable in the notes header. Mounted in
 * `NoteToolbar.title`. Committing a changed, non-blank title calls
 * `renameNote`, which sets `titleSource: 'manual'` and permanently opts the
 * note out of auto-titling (K20, A34) - already implemented in
 * `storage/notes.ts`; this component's only job is calling it and handling
 * the edges `renameNote` itself does not: an unchanged commit (no write, so
 * `titleSourceOf` is never flipped to 'manual' by a non-edit), a blank
 * commit (reverted locally with an inline error, mirroring `renameNote`'s
 * own "a note title cannot be blank" guard so the person sees why nothing
 * happened), and a rejected write (shown inline, editing stays open to
 * retry or cancel).
 */
export function NoteTitle({ noteId, title, onRenamed }: NoteTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A rename elsewhere (or a different note under the same key) updated the
  // title prop: the displayed draft should track it whenever not mid-edit.
  // Done during render, comparing against the previous render's prop - not
  // in an effect, which would call setState synchronously inside an effect
  // body and trigger a needless extra render (React's documented "adjusting
  // state when a prop changes" pattern).
  const [prevTitle, setPrevTitle] = useState(title);
  if (title !== prevTitle) {
    setPrevTitle(title);
    if (!editing) setDraft(title);
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function open() {
    setDraft(title);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(title);
    setError(null);
    setEditing(false);
  }

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === title) {
      // No edit at all: closing must not call renameNote, or a bare click
      // that opens and immediately commits would flip titleSource to
      // 'manual' with nothing actually renamed.
      setEditing(false);
      setError(null);
      return;
    }
    if (trimmed === '') {
      setError('A note title cannot be blank.');
      setDraft(title);
      return;
    }
    try {
      await renameNote(noteId, trimmed);
      setEditing(false);
      setError(null);
      onRenamed?.();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        className="text-left text-sm font-medium hover:underline"
      >
        {title}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          else if (e.key === 'Escape') cancel();
        }}
        className="rounded bg-muted px-1 text-sm font-medium"
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
