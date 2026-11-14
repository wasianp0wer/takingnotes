import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { cn } from '@/lib/utils';
import type { CalendarEventRecord } from '@/storage/types';
import { isSameLocalDay } from '@/triage/dates';
import { formatDayLabel, formatTime } from '@/triage/format';

export interface DayEventsDialogProps {
  /** Local-midnight ms of the day to show; `null` means closed. */
  day: number | null;
  events: CalendarEventRecord[];
  now: number;
  onClose(): void;
  onEdit(event: CalendarEventRecord): void;
  onAdd(day: number): void;
}

/** What a calendar day cell opens: that day's events, with a way to add one. */
export function DayEventsDialog({ day, events, now, onClose, onEdit, onAdd }: DayEventsDialogProps) {
  const items =
    day === null
      ? []
      : events.filter((e) => isSameLocalDay(e.startsAt, day)).sort((a, b) => a.startsAt - b.startsAt);

  return (
    <Dialog
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{day === null ? '' : formatDayLabel(day, now)}</DialogTitle>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing on this day</p>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
            {items.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onEdit(e)}
                  className={cn(
                    'flex w-full items-center gap-2 p-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                    HOVER_AFFORDANCE,
                  )}
                >
                  <span className="shrink-0 tabular-nums text-date">
                    {e.allDay ? 'All day' : formatTime(e.startsAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => day !== null && onAdd(day)}>
            Add event
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
