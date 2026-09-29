import type { CalendarEventKind, CalendarEventRecord } from '@/storage/types';
import { localDateTimeFromInputs, toDateInputValue, toTimeInputValue } from '@/triage/dates';
import { parseEstimateMinutes } from '@/triage/estimate';
import { DEFAULT_ESTIMATE_MINUTES } from '@/triage/priority';

export interface EventFormState {
  title: string;
  kind: CalendarEventKind;
  date: string;
  time: string;
  allDay: boolean;
  required: boolean;
  estimatedMinutes: string;
  notes: string;
}

export type EventFormValue = Pick<
  CalendarEventRecord,
  'title' | 'kind' | 'startsAt' | 'allDay' | 'required' | 'estimatedMinutes' | 'notes'
>;

export type EventFormResult = { ok: true; value: EventFormValue } | { ok: false; error: string };

export function emptyEventForm(dayMs: number): EventFormState {
  return {
    title: '',
    kind: 'deadline',
    date: toDateInputValue(dayMs),
    time: '09:00',
    allDay: false,
    required: true,
    estimatedMinutes: String(DEFAULT_ESTIMATE_MINUTES),
    notes: '',
  };
}

export function eventFormFromRecord(e: CalendarEventRecord): EventFormState {
  return {
    title: e.title,
    kind: e.kind,
    date: toDateInputValue(e.startsAt),
    time: e.allDay ? '' : toTimeInputValue(e.startsAt),
    allDay: e.allDay,
    required: e.required,
    estimatedMinutes: String(e.estimatedMinutes),
    notes: e.notes,
  };
}

export function eventValueFromForm(form: EventFormState): EventFormResult {
  const title = form.title.trim();
  if (title === '') return { ok: false, error: 'Give it a title.' };

  // Validate the date alone first (an empty time is always valid input to
  // `localDateTimeFromInputs`), so a bad time never masquerades as a bad date.
  const midnight = localDateTimeFromInputs(form.date, '');
  if (midnight === null) return { ok: false, error: 'Pick a valid date.' };

  let startsAt: number;
  if (form.allDay) {
    startsAt = midnight;
  } else {
    // An empty time is valid input to `localDateTimeFromInputs` (it means
    // local midnight), but here that would silently accept "no time" for a
    // timed event, so it is rejected explicitly.
    const timed = form.time === '' ? null : localDateTimeFromInputs(form.date, form.time);
    if (timed === null) return { ok: false, error: 'Pick a time or mark it all-day.' };
    startsAt = timed;
  }

  const estimatedMinutes = parseEstimateMinutes(form.estimatedMinutes);
  if (estimatedMinutes === null) {
    return { ok: false, error: 'Estimate must be a number of minutes.' };
  }

  return {
    ok: true,
    value: {
      title,
      kind: form.kind,
      startsAt,
      allDay: form.allDay,
      required: form.required,
      estimatedMinutes,
      notes: form.notes.trim(),
    },
  };
}
