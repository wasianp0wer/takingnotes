import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { NoteRecord } from '@/storage/types';

export interface NoteListProps {
  notes: readonly NoteRecord[];
  selectedNoteId: string | null;
  activeNoteId: string | null;
  onSelect: (id: string) => void;
  /**
   * Rendered above the list. **Wave 2 mount point**: S5's tag filter bar goes
   * here, so adding it does not mean editing this component.
   */
  filter?: ReactNode;
  /**
   * Trailing controls for one row. **Wave 2 mount point**: S1's Resume button
   * goes here.
   */
  rowActions?: (note: NoteRecord) => ReactNode;
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
      {children}
    </span>
  );
}

function NoteListItem({
  note,
  selected,
  active,
  onSelect,
  rowActions,
}: {
  note: NoteRecord;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  rowActions?: (note: NoteRecord) => ReactNode;
}) {
  return (
    <li className={cn('border-b border-border px-4 py-2', selected && 'bg-accent')}>
      {/* The button's text is exactly the title - the date and badges sit
          beside it rather than inside it, so selecting a note by its title
          text never has to account for what else is on the row. */}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className="block w-full text-left text-sm font-medium hover:underline"
      >
        {note.title}
      </button>
      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <span>{new Date(note.startedAt).toLocaleDateString()}</span>
        {note.legacy && <Badge>Legacy</Badge>}
        {active && <Badge>Recording</Badge>}
        {note.status === 'interrupted' && <Badge>Interrupted</Badge>}
      </div>
      {rowActions?.(note)}
    </li>
  );
}

/**
 * The notes sidebar: filter slot, the note list itself, and per-row actions.
 * Pulled out of `NotesView` (Task 6) so Wave 2 units can add to it via the
 * `filter` / `rowActions` slots instead of editing this file directly.
 */
export function NoteList({
  notes,
  selectedNoteId,
  activeNoteId,
  onSelect,
  filter,
  rowActions,
}: NoteListProps) {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-border">
      <h2 className="px-4 py-3 text-sm font-medium">Notes</h2>
      {filter}
      {notes.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          No notes yet — write on the pad to start one.
        </p>
      ) : (
        <ul>
          {notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              selected={note.id === selectedNoteId}
              active={note.id === activeNoteId}
              onSelect={() => onSelect(note.id)}
              rowActions={rowActions}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
