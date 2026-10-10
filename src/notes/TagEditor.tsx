import { useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setNoteTags } from '@/storage/notes';

export interface TagEditorProps {
  noteId: string;
  tags: readonly string[];
  /** Called after a successful write, so callers can refresh stale reads (vocabulary, filter). */
  onChanged: () => void;
}

/** Shown on a failed add or remove - the console message alone would leave a
 * silently cleared input indistinguishable from a successful save. */
const TAG_SAVE_FAILED = "Couldn't save your tags — try again.";

/**
 * Inline tag editing (K38), mounted at `NoteToolbar.meta` under the
 * title/title-slot. The only writer is `setNoteTags` (K36) - normalization
 * and de-duplication are its job, not re-implemented here.
 */
export function TagEditor({ noteId, tags, onChanged }: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reports success back to the caller (mirrors `useTriageData`'s
   * `rethrow`-shaped contracts) so a caller that holds the only copy of what
   * the user typed - `addTag` below - can decide for itself whether it is
   * safe to clear that input, rather than this function clearing it on the
   * caller's behalf regardless of outcome.
   */
  async function write(nextTags: readonly string[]): Promise<boolean> {
    setSaving(true);
    try {
      await setNoteTags(noteId, nextTags);
      setError(null);
      onChanged();
      return true;
    } catch (err) {
      console.error('[notes] could not update tags', err);
      setError(TAG_SAVE_FAILED);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeTag(tag: string): Promise<void> {
    await write(tags.filter((t) => t !== tag));
  }

  async function addTag(): Promise<void> {
    const raw = draft.trim();
    if (raw === '') return;
    const ok = await write([...tags, raw]);
    // Only on success: the spec's own wording ("clears the input ... on
    // submit") describes the success path - clearing on a failed write would
    // throw away the only copy of what the owner typed with no way back.
    if (ok) setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addTag();
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            disabled={saving}
            onClick={() => void removeTag(tag)}
            className="text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={saving}
        placeholder="Add a tag"
        aria-label="Add a tag"
        className="h-6 w-28 text-xs"
      />
      <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void addTag()}>
        Add tag
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
