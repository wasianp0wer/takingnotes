import { describe, expect, it } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import { toDateInputValue } from '@/triage/dates';
import {
  emptyEventForm,
  eventFormFromRecord,
  eventValueFromForm,
  type EventFormState,
} from '@/triage/eventForm';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const NOW = at(2026, 8, 28, 15);

function makeEvent(overrides: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: 'evt-1',
    title: 'Problem set 3',
    kind: 'deadline',
    startsAt: at(2026, 8, 29, 14, 30),
    endsAt: null,
    allDay: false,
    required: true,
    estimatedMinutes: 90,
    notes: 'bring calculator',
    source: 'manual',
    sourceRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseForm(overrides: Partial<EventFormState> = {}): EventFormState {
  return {
    title: 'Reading response',
    kind: 'deadline',
    date: '2026-09-30',
    time: '10:00',
    allDay: false,
    required: true,
    estimatedMinutes: '60',
    notes: 'chapter 4',
    ...overrides,
  };
}

describe('emptyEventForm', () => {
  it('builds the default form for a given day', () => {
    expect(emptyEventForm(NOW)).toEqual({
      title: '',
      kind: 'deadline',
      date: toDateInputValue(NOW),
      time: '09:00',
      allDay: false,
      required: true,
      estimatedMinutes: '60',
      notes: '',
    });
  });
});

describe('eventFormFromRecord / eventValueFromForm round trip', () => {
  it('round-trips a timed event', () => {
    const record = makeEvent({
      startsAt: at(2026, 8, 29, 14, 30),
      allDay: false,
    });
    const form = eventFormFromRecord(record);
    expect(form.time).toBe('14:30');
    expect(form.allDay).toBe(false);

    const result = eventValueFromForm(form);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({
      title: record.title,
      kind: record.kind,
      startsAt: record.startsAt,
      allDay: record.allDay,
      required: record.required,
      estimatedMinutes: record.estimatedMinutes,
      notes: record.notes,
    });
  });

  it('round-trips an all-day event', () => {
    const record = makeEvent({
      startsAt: at(2026, 8, 30), // local midnight
      allDay: true,
    });
    const form = eventFormFromRecord(record);
    expect(form.time).toBe('');
    expect(form.allDay).toBe(true);

    const result = eventValueFromForm(form);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({
      title: record.title,
      kind: record.kind,
      startsAt: record.startsAt,
      allDay: record.allDay,
      required: record.required,
      estimatedMinutes: record.estimatedMinutes,
      notes: record.notes,
    });
  });
});

describe('eventValueFromForm validation', () => {
  it('rejects an empty title', () => {
    expect(eventValueFromForm(baseForm({ title: '   ' }))).toEqual({
      ok: false,
      error: 'Give it a title.',
    });
  });

  it('trims title and notes', () => {
    const result = eventValueFromForm(baseForm({ title: '  Buy milk  ', notes: '  fresh  ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.title).toBe('Buy milk');
    expect(result.value.notes).toBe('fresh');
  });

  it('rejects an empty date', () => {
    expect(eventValueFromForm(baseForm({ date: '' }))).toEqual({
      ok: false,
      error: 'Pick a valid date.',
    });
  });

  it('rejects a date that Date would silently roll over', () => {
    expect(eventValueFromForm(baseForm({ date: '2026-02-30' }))).toEqual({
      ok: false,
      error: 'Pick a valid date.',
    });
  });

  it('rejects an empty time when not all-day', () => {
    expect(eventValueFromForm(baseForm({ allDay: false, time: '' }))).toEqual({
      ok: false,
      error: 'Pick a time or mark it all-day.',
    });
  });

  it('rejects a malformed time when not all-day', () => {
    expect(eventValueFromForm(baseForm({ allDay: false, time: '99:99' }))).toEqual({
      ok: false,
      error: 'Pick a time or mark it all-day.',
    });
  });

  it('ignores a bad time when all-day', () => {
    const result = eventValueFromForm(baseForm({ allDay: true, time: 'garbage' }));
    expect(result.ok).toBe(true);
  });

  it('rejects a negative estimate', () => {
    expect(eventValueFromForm(baseForm({ estimatedMinutes: '-5' }))).toEqual({
      ok: false,
      error: 'Estimate must be a number of minutes.',
    });
  });

  it('rejects a non-numeric estimate', () => {
    expect(eventValueFromForm(baseForm({ estimatedMinutes: 'abc' }))).toEqual({
      ok: false,
      error: 'Estimate must be a number of minutes.',
    });
  });

  it('defaults an empty estimate to 60', () => {
    const result = eventValueFromForm(baseForm({ estimatedMinutes: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.estimatedMinutes).toBe(60);
  });

  it('trims whitespace around a numeric estimate', () => {
    const result = eventValueFromForm(baseForm({ estimatedMinutes: ' 90 ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.estimatedMinutes).toBe(90);
  });

  it('rounds a fractional estimate', () => {
    const result = eventValueFromForm(baseForm({ estimatedMinutes: '12.6' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.estimatedMinutes).toBe(13);
  });

  it('sets startsAt to local midnight of the date for an all-day event', () => {
    const result = eventValueFromForm(baseForm({ allDay: true, date: '2026-09-30', time: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.startsAt).toBe(at(2026, 8, 30));
  });
});
