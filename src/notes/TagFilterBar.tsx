import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TagFilterMode } from '@/notes/tagFilter';

export interface TagFilterBarProps {
  /** Every distinct tag in use, sorted (A35). */
  vocabulary: string[];
  selected: string[];
  mode: TagFilterMode;
  /** Notes hidden by the filter; never counts the active note (⚑). */
  hiddenCount: number;
  /** The active note does not match the filter but is shown anyway (⚑). */
  activeNoteExempted: boolean;
  onToggleTag: (tag: string) => void;
  onModeChange: (mode: TagFilterMode) => void;
  onClear: () => void;
}

/**
 * S5's sidebar filter (K37), mounted at `NoteList.filter`
 * (docs/architecture.md §8.4). Also carries the explanation `NoteList`'s own
 * fixed "No notes yet" empty state cannot give when a filter is the reason
 * the list is short or empty (§8.4's note to S5), and the ⚑ notice for the
 * one case where the active note is shown despite not matching.
 */
export function TagFilterBar({
  vocabulary,
  selected,
  mode,
  hiddenCount,
  activeNoteExempted,
  onToggleTag,
  onModeChange,
  onClear,
}: TagFilterBarProps) {
  if (vocabulary.length === 0 && selected.length === 0) return null;

  const showStatus = hiddenCount > 0 || activeNoteExempted;
  // Clear must be reachable whenever a selection exists, not only when the
  // selection happens to be hiding or exempting something - a filter that
  // currently matches every note is still a filter the owner may want to
  // drop in one action rather than untoggling each chip by hand.
  const showClear = selected.length > 0;

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="flex flex-wrap gap-1">
        {vocabulary.map((tag) => {
          const isSelected = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggleTag(tag)}
              className={cn(
                'rounded px-2 py-0.5 text-xs font-medium',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-accent text-accent-foreground hover:bg-accent/80',
              )}
            >
              {tag}
            </button>
          );
        })}
      </div>

      {selected.length > 1 && (
        <div className="mt-2 flex items-center gap-1 text-xs">
          <Button
            type="button"
            variant={mode === 'or' ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={mode === 'or'}
            onClick={() => onModeChange('or')}
          >
            Match any
          </Button>
          <Button
            type="button"
            variant={mode === 'and' ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={mode === 'and'}
            onClick={() => onModeChange('and')}
          >
            Match all
          </Button>
        </div>
      )}

      {(showStatus || showClear) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {hiddenCount > 0 && (
            <span>
              {hiddenCount} {hiddenCount === 1 ? 'note' : 'notes'} hidden by this filter.
            </span>
          )}
          {activeNoteExempted && (
            <span>{"The note you're writing doesn't match this filter — shown anyway."}</span>
          )}
          {showClear && (
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              Clear filter
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
