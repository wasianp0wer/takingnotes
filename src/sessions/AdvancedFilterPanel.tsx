import type { AdvancedFilter } from '@/sessions/filter';
import { cn } from '@/lib/utils';
import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { Switch } from '@/components/ui/switch';
import type { NoteRecord } from '@/storage/types';

export interface AdvancedFilterPanelProps {
  filter: AdvancedFilter;
  vocabulary: readonly string[];
  onChange(filter: AdvancedFilter): void;
  onClear(): void;
}

const STATUSES: { value: NoteRecord['status']; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'interrupted', label: 'Interrupted' },
  { value: 'complete', label: 'Complete' },
];

const FIELD =
  'w-full min-w-0 bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';
const BUTTON = cn(
  'px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
  HOVER_AFFORDANCE,
);

function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function AdvancedFilterPanel({
  filter,
  vocabulary,
  onChange,
  onClear,
}: AdvancedFilterPanelProps) {
  const set = (patch: Partial<AdvancedFilter>) => onChange({ ...filter, ...patch });
  return (
    <div data-slot="advanced-panel" className="mt-1.5 space-y-2 bg-muted p-2 text-sm">
      <div className="flex gap-1.5">
        <input
          type="date"
          aria-label="From date"
          className={cn(FIELD, 'text-date')}
          value={filter.from ?? ''}
          onChange={(e) => set({ from: e.target.value === '' ? null : e.target.value })}
        />
        <input
          type="date"
          aria-label="To date"
          className={cn(FIELD, 'text-date')}
          value={filter.to ?? ''}
          onChange={(e) => set({ to: e.target.value === '' ? null : e.target.value })}
        />
      </div>

      {vocabulary.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {vocabulary.map((tag) => {
            const on = filter.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                className={cn(BUTTON, 'text-tag', on && 'bg-selected')}
                onClick={() => set({ tags: toggled(filter.tags, tag) })}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          aria-pressed={filter.tagMode === 'or'}
          className={cn(BUTTON, filter.tagMode === 'or' && 'bg-selected')}
          onClick={() => set({ tagMode: 'or' })}
        >
          Any tag
        </button>
        <button
          type="button"
          aria-pressed={filter.tagMode === 'and'}
          className={cn(BUTTON, filter.tagMode === 'and' && 'bg-selected')}
          onClick={() => set({ tagMode: 'and' })}
        >
          All tags
        </button>
      </div>

      <input
        type="text"
        aria-label="Title contains"
        placeholder="Title contains"
        className={FIELD}
        value={filter.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      <input
        type="text"
        aria-label="Text contains"
        placeholder="Text contains"
        className={FIELD}
        value={filter.text}
        onChange={(e) => set({ text: e.target.value })}
      />
      <Switch
        checked={filter.regex}
        onCheckedChange={(regex) => set({ regex })}
        offLabel="Off"
        onLabel="Regex"
        aria-label="Regex"
      />

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Has recording"
          checked={filter.hasRecording}
          onChange={(e) => set({ hasRecording: e.target.checked })}
        />
        Has recording
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Has typed page"
          checked={filter.hasTypedPage}
          onChange={(e) => set({ hasTypedPage: e.target.checked })}
        />
        Has typed page
      </label>

      <div className="flex flex-wrap gap-1">
        {STATUSES.map(({ value, label }) => {
          const on = filter.statuses.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              className={cn(BUTTON, on && 'bg-selected')}
              onClick={() => set({ statuses: toggled(filter.statuses, value) })}
            >
              {label}
            </button>
          );
        })}
      </div>

      <button type="button" className={cn(BUTTON, 'text-link')} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
