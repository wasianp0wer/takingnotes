import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { cn } from '@/lib/utils';
import { AdvancedFilterPanel } from '@/sessions/AdvancedFilterPanel';
import { entryStartedAt, entryTitle, noteKey } from '@/sessions/catalog';
import type { SessionEntry } from '@/sessions/catalog';
import { EMPTY_SIDEBAR_FILTER } from '@/sessions/filter';
import type { FilterOutcome, SidebarFilter } from '@/sessions/filter';
import { tagsOf } from '@/storage/notes';

export interface SessionSidebarProps {
  outcome: FilterOutcome;
  selectedKey: string | null;
  activeNoteId: string | null;
  filter: SidebarFilter;
  onFilterChange(filter: SidebarFilter): void;
  advancedOpen: boolean;
  onAdvancedOpenChange(open: boolean): void;
  vocabulary: readonly string[];
  onSelect(key: string): void;
}

function EntryButton({
  entry,
  selected,
  live,
  onSelect,
}: {
  entry: SessionEntry;
  selected: boolean;
  /** The note being written right now. */
  live: boolean;
  onSelect(key: string): void;
}) {
  const tags = entry.kind === 'note' ? tagsOf(entry.note) : [];
  return (
    <button
      type="button"
      data-entry-key={entry.key}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(entry.key)}
      className={cn(
        'block w-full px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
        HOVER_AFFORDANCE,
        selected && 'bg-selected shadow-selected-bar',
      )}
    >
      <span className="text-session-title block truncate text-sm">{entryTitle(entry)}</span>
      <span className="block text-xs">
        <span className="text-date">{new Date(entryStartedAt(entry)).toLocaleDateString()}</span>
        {live && (
          <span data-live className="text-status-ok ml-1.5 font-semibold">
            Live
          </span>
        )}
      </span>
      {tags.length > 0 && (
        <span className="block truncate text-xs">
          {tags.map((tag) => (
            <span key={tag} className="text-tag mr-1.5">
              {tag}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function Group({
  title,
  entries,
  selectedKey,
  liveKey,
  onSelect,
}: {
  title: string;
  entries: SessionEntry[];
  selectedKey: string | null;
  liveKey: string | null;
  onSelect(key: string): void;
}) {
  return (
    <section className="mt-3">
      <h2 className="text-heading px-2 pb-1 text-xs font-semibold uppercase">
        {title} · {entries.length}
      </h2>
      {entries.map((entry) => (
        <EntryButton
          key={entry.key}
          entry={entry}
          selected={entry.key === selectedKey}
          live={entry.key === liveKey}
          onSelect={onSelect}
        />
      ))}
    </section>
  );
}

export function SessionSidebar({
  outcome,
  selectedKey,
  activeNoteId,
  filter,
  onFilterChange,
  advancedOpen,
  onAdvancedOpenChange,
  vocabulary,
  onSelect,
}: SessionSidebarProps) {
  const liveKey = activeNoteId === null ? null : noteKey(activeNoteId);
  return (
    <aside className="bg-surface text-surface-foreground flex h-full w-60 shrink-0 flex-col p-2.5">
      <input
        type="text"
        aria-label="Filter sessions"
        placeholder="Filter sessions"
        className="bg-muted w-full px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        value={filter.quick}
        onChange={(e) => onFilterChange({ ...filter, quick: e.target.value })}
      />
      <button
        type="button"
        aria-expanded={advancedOpen}
        onClick={() => onAdvancedOpenChange(!advancedOpen)}
        className={cn(
          'text-link mt-1 px-1 py-0.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          HOVER_AFFORDANCE,
        )}
      >
        <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span> Advanced filter
      </button>
      {advancedOpen && (
        <AdvancedFilterPanel
          filter={filter.advanced}
          vocabulary={vocabulary}
          onChange={(advanced) => onFilterChange({ ...filter, advanced })}
          onClear={() => onFilterChange(EMPTY_SIDEBAR_FILTER)}
        />
      )}
      {outcome.error !== null && (
        <p role="alert" className="mt-1.5 text-sm text-destructive">
          {outcome.error}
        </p>
      )}
      {outcome.pending && <p className="mt-1.5 text-sm">Searching text…</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Group
          title="Sessions"
          entries={outcome.sessions}
          selectedKey={selectedKey}
          liveKey={liveKey}
          onSelect={onSelect}
        />
        <Group
          title="Uncategorized"
          entries={outcome.uncategorized}
          selectedKey={selectedKey}
          liveKey={liveKey}
          onSelect={onSelect}
        />
      </div>
    </aside>
  );
}
