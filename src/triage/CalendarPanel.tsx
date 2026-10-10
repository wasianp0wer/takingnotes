import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { CalendarEventRecord } from '@/storage/types';
import { cn } from '@/lib/utils';
import { addLocalDays, isSameLocalDay, monthGrid, startOfLocalDay, toDateInputValue } from '@/triage/dates';
import { emptyEventForm, eventFormFromRecord, type EventFormState, type EventFormValue } from '@/triage/eventForm';
import { EventDialog } from '@/triage/EventDialog';
import { WEEKDAYS, formatDayLabel, formatMonthTitle, formatTime } from '@/triage/format';

export interface CalendarPanelProps {
  events: CalendarEventRecord[];
  now: number;
  /** Must reject on a failed write; `EventDialog` relies on it (see its `onSave`). */
  onSaveEvent(value: EventFormValue, id: string | null): Promise<void>;
  onDeleteEvent(id: string): Promise<void>;
}

/** Today plus the next 7 days. */
export const AGENDA_DAYS = 8;

/** The upper bound the K23 custom horizon field accepts. */
export const MAX_CUSTOM_AGENDA_DAYS = 365;

/**
 * K23: validates the agenda horizon's Custom… field. Empty, zero, negative,
 * non-numeric and anything over 365 are all rejected (null). A fractional
 * value floors, then is re-checked against the same rules, so `7.9` commits
 * as `7` but `0.5` (which floors to `0`) is still rejected.
 */
export function parseAgendaDays(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n);
  if (days <= 0 || days > MAX_CUSTOM_AGENDA_DAYS) return null;
  return days;
}

/** A cell shows at most this many dots, so a busy day never overflows. */
const MAX_DOTS = 3;

type DialogState = { mode: 'create'; day: number } | { mode: 'edit'; event: CalendarEventRecord } | null;

export function CalendarPanel({ events, now, onSaveEvent, onDeleteEvent }: CalendarPanelProps) {
  const [visible, setVisible] = useState(() => {
    const d = new Date(now);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [dialogKey, setDialogKey] = useState(0);

  const shiftMonth = (delta: number) => {
    setVisible(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const goToday = () => {
    const d = new Date(now);
    setVisible({ year: d.getFullYear(), month: d.getMonth() });
  };

  const openCreate = (day: number) => {
    setDialogState({ mode: 'create', day });
    setDialogKey((k) => k + 1);
  };

  const openEdit = (event: CalendarEventRecord) => {
    setDialogState({ mode: 'edit', event });
    setDialogKey((k) => k + 1);
  };

  const closeDialog = () => setDialogState(null);

  const weeks = monthGrid(visible.year, visible.month);
  const today = startOfLocalDay(now);

  let dialogInitial: EventFormState | null = null;
  let dialogEventId: string | null = null;
  if (dialogState?.mode === 'create') {
    dialogInitial = emptyEventForm(dialogState.day);
  } else if (dialogState?.mode === 'edit') {
    dialogInitial = eventFormFromRecord(dialogState.event);
    dialogEventId = dialogState.event.id;
  }

  return (
    <section className="flex h-full min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{formatMonthTitle(visible.year, visible.month)}</h2>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Next month" onClick={() => shiftMonth(1)}>
            <ChevronRight />
          </Button>
          <Button type="button" size="sm" onClick={() => openCreate(today)}>
            New event
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-muted-foreground sm:text-xs">
        {WEEKDAYS.map((wd) => (
          <span key={wd}>{wd}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weeks.flatMap((week) =>
          week.map((day) => {
            const dateStr = toDateInputValue(day);
            const outside = new Date(day).getMonth() !== visible.month;
            const isToday = isSameLocalDay(day, now);
            const dayEvents = events
              .filter((e) => isSameLocalDay(e.startsAt, day))
              // Deadlines first (a stable sort, so the rest keep their
              // `startsAt` order) so the cap below can never drop the one dot
              // that matters most: past the agenda's 8 days the red dot is the
              // only signal a deadline is there at all.
              .sort((a, b) => Number(b.kind === 'deadline') - Number(a.kind === 'deadline'))
              .slice(0, MAX_DOTS);

            return (
              <button
                key={dateStr}
                type="button"
                data-day={dateStr}
                data-outside={outside ? 'true' : undefined}
                aria-current={isToday ? 'date' : undefined}
                aria-label={`${formatDayLabel(day, now)} (${dateStr})`}
                onClick={() => openCreate(day)}
                className={cn(
                  'flex min-w-0 flex-col items-start gap-0.5 rounded-md border border-transparent p-1 text-left text-xs transition-colors hover:bg-accent sm:aspect-square sm:text-sm',
                  outside && 'text-muted-foreground',
                  isToday && 'ring-2 ring-ring',
                )}
              >
                <span className="tabular-nums">{new Date(day).getDate()}</span>
                {dayEvents.length > 0 ? (
                  <span className="flex gap-0.5">
                    {dayEvents.map((e) => (
                      <span
                        key={e.id}
                        data-dot={e.kind}
                        className={cn('size-1.5 rounded-full', e.kind === 'deadline' ? 'bg-destructive' : 'bg-primary')}
                      />
                    ))}
                  </span>
                ) : null}
              </button>
            );
          }),
        )}
      </div>

      <Agenda events={events} now={now} onOpen={openEdit} />

      {dialogState && dialogInitial ? (
        <EventDialog
          key={dialogKey}
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          initial={dialogInitial}
          eventId={dialogEventId}
          onSave={(value) => onSaveEvent(value, dialogEventId)}
          onDelete={dialogState.mode === 'edit' ? () => onDeleteEvent(dialogState.event.id) : undefined}
        />
      ) : null}
    </section>
  );
}

function Agenda({
  events,
  now,
  onOpen,
}: {
  events: CalendarEventRecord[];
  now: number;
  onOpen(event: CalendarEventRecord): void;
}) {
  const today = startOfLocalDay(now);
  const groups = Array.from({ length: AGENDA_DAYS }, (_, i) => addLocalDays(today, i))
    .map((day) => ({
      day,
      items: events
        .filter((e) => isSameLocalDay(e.startsAt, day))
        .sort((a, b) => {
          if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
          return a.startsAt - b.startsAt;
        }),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <section aria-label="Agenda" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in the next 7 days.</p>
      ) : (
        groups.map(({ day, items }) => (
          <div key={day}>
            <h3 className="text-xs font-semibold text-muted-foreground">{formatDayLabel(day, now)}</h3>
            <ul className="flex flex-col gap-1">
              {items.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(e)}
                    className="flex w-full items-center gap-2 rounded-md border border-border p-1.5 text-left text-xs hover:bg-accent sm:text-sm"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {e.allDay ? 'All day' : formatTime(e.startsAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    {e.kind === 'deadline' ? (
                      <span className="shrink-0 rounded bg-destructive/15 px-1 text-[10px] text-destructive">
                        Deadline
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
