import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { Input } from '@/components/ui/input';
import { getSettingValue, SETTING_DEFAULTS, setSettingValue } from '@/storage/settingKeys';
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

/** K23: the fixed preset choices for the agenda horizon, in days ahead of today. */
const AGENDA_PRESETS = [3, 7, 14, 30] as const;

/** K23: the sentinel stored for the "All" preset - see `settingKeys.ts`. */
const AGENDA_ALL = Number.POSITIVE_INFINITY;

/** Whether `days` is one of the five named choices (a preset, or "All"). */
function isNamedAgendaPreset(days: number): boolean {
  return (AGENDA_PRESETS as readonly number[]).includes(days) || days === AGENDA_ALL;
}

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

/**
 * K23/K25: the agenda's candidate days. For a finite horizon this is exactly
 * the old fixed window (`agendaDays + 1` consecutive local days starting
 * today - `7` reproduces the old hard-coded `AGENDA_DAYS = 8`). For the "All"
 * sentinel (`Infinity`) there is no fixed-length window to build, so instead
 * every distinct local day, today or later, that the passed-in `events` has
 * at least one event on is returned, ascending - no upper bound, and no day
 * invented that has nothing in it.
 */
export function candidateDaysForAgenda(
  events: readonly CalendarEventRecord[],
  today: number,
  agendaDays: number,
): number[] {
  if (Number.isFinite(agendaDays)) {
    return Array.from({ length: agendaDays + 1 }, (_, i) => addLocalDays(today, i));
  }
  const days = new Set<number>();
  for (const e of events) {
    const day = startOfLocalDay(e.startsAt);
    if (day >= today) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
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

  // K23: the agenda horizon. `agendaDays` is the currently *applied* value
  // (always one of the five presets, or whatever custom number was last
  // committed); `showCustom` only controls whether the Custom… field is
  // revealed - it does not itself change `agendaDays`.
  const [agendaDays, setAgendaDaysState] = useState<number>(SETTING_DEFAULTS['triage.agendaDays']);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  // True once the user has applied a value (by preset click or a custom
  // commit). Guards against the async initial load landing *after* that and
  // clobbering it with the stale stored value - the same race `AudioSettings`
  // guards against with its own `dirtyRef`.
  const interactedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void getSettingValue('triage.agendaDays').then((stored) => {
      if (!active || interactedRef.current) return;
      setAgendaDaysState(stored);
      if (!isNamedAgendaPreset(stored)) {
        setShowCustom(true);
        setCustomDraft(Number.isFinite(stored) ? String(stored) : '');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const applyAgendaDays = (days: number) => {
    interactedRef.current = true;
    setAgendaDaysState(days);
    void setSettingValue('triage.agendaDays', days);
  };

  const selectPreset = (days: number) => {
    setShowCustom(false);
    setCustomError(null);
    applyAgendaDays(days);
  };

  const toggleCustom = () => {
    setShowCustom(true);
    setCustomError(null);
    // Prefill from whatever is actually applied, so a blur without typing
    // commits the same value right back - a no-op, not an error. "All" has
    // no finite day count to prefill with, so the field opens empty there.
    if (Number.isFinite(agendaDays)) {
      setCustomDraft(String(agendaDays));
    }
  };

  const commitCustom = () => {
    const parsed = parseAgendaDays(customDraft);
    if (parsed === null) {
      setCustomError('Enter a whole number of days from 1 to 365.');
      return;
    }
    setCustomError(null);
    applyAgendaDays(parsed);
  };

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
        <h2 className="text-sm font-semibold text-heading">{formatMonthTitle(visible.year, visible.month)}</h2>
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
                  'flex min-w-0 flex-col items-start gap-0.5 p-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:aspect-square sm:text-sm',
                  HOVER_AFFORDANCE,
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

      <div aria-label="Agenda horizon" className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">Agenda horizon:</span>
        {AGENDA_PRESETS.map((d) => (
          <Button
            key={d}
            type="button"
            size="sm"
            variant={agendaDays === d ? 'default' : 'outline'}
            aria-pressed={agendaDays === d}
            aria-label={`${d} days`}
            onClick={() => selectPreset(d)}
          >
            {d}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={agendaDays === AGENDA_ALL ? 'default' : 'outline'}
          aria-pressed={agendaDays === AGENDA_ALL}
          aria-label="All"
          onClick={() => selectPreset(AGENDA_ALL)}
        >
          All
        </Button>
        <Button
          type="button"
          size="sm"
          // Pressed means "a custom value is applied" (K23), not "the panel
          // is open" - opening the control must never itself claim a change.
          variant={!isNamedAgendaPreset(agendaDays) ? 'default' : 'outline'}
          aria-pressed={!isNamedAgendaPreset(agendaDays)}
          aria-label="Custom…"
          onClick={toggleCustom}
        >
          Custom…
        </Button>
        {showCustom ? (
          <span className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              max={MAX_CUSTOM_AGENDA_DAYS}
              aria-label="Custom agenda days"
              value={customDraft}
              onChange={(e) => {
                setCustomDraft(e.target.value);
                setCustomError(null);
              }}
              onBlur={commitCustom}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitCustom();
                }
              }}
              className="w-16"
            />
            <span className="text-xs text-muted-foreground">days</span>
          </span>
        ) : null}
        {customError ? <p className="w-full text-xs text-destructive">{customError}</p> : null}
      </div>

      <Agenda events={events} now={now} agendaDays={agendaDays} onOpen={openEdit} />

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
  agendaDays,
  onOpen,
}: {
  events: CalendarEventRecord[];
  now: number;
  agendaDays: number;
  onOpen(event: CalendarEventRecord): void;
}) {
  const today = startOfLocalDay(now);
  const groups = candidateDaysForAgenda(events, today, agendaDays)
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

  // K23/K25: horizon-aware empty state. Default (7) reproduces the exact old
  // copy; "All" has no day count to report.
  const emptyLabel = Number.isFinite(agendaDays) ? `Nothing in the next ${agendaDays} days.` : 'Nothing coming up.';

  return (
    <section aria-label="Agenda" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        groups.map(({ day, items }) => (
          <div key={day}>
            <h3 className="text-xs font-semibold text-heading">{formatDayLabel(day, now)}</h3>
            <ul className="flex flex-col gap-1">
              {items.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(e)}
                    className={cn(
                      'flex w-full items-center gap-2 p-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:text-sm',
                      HOVER_AFFORDANCE,
                    )}
                  >
                    <span className="shrink-0 tabular-nums text-date">
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
