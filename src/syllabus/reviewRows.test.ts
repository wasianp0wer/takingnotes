import { describe, expect, it } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import {
  markExisting,
  reresolveRows,
  rowsFromExtracted,
  toConfirmed,
  type ReviewRow,
} from '@/syllabus/reviewRows';
import { sourceRefFor } from '@/syllabus/sourceRef';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

const extracted = (over?: Partial<ExtractedAssignment>): ExtractedAssignment => ({
  title: 'Essay 1',
  dueAt: local(2026, 10, 15),
  rawDate: 'Oct 15',
  estimatedMinutes: 180,
  notes: '',
  ...over,
});

const event = (over: Partial<CalendarEventRecord>): CalendarEventRecord => ({
  id: 'e1',
  title: 'Essay 1',
  kind: 'deadline',
  startsAt: local(2026, 10, 15),
  endsAt: null,
  allDay: true,
  required: true,
  estimatedMinutes: 180,
  notes: '',
  source: 'syllabus',
  sourceRef: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('rowsFromExtracted', () => {
  it('includes a dated row, prefilled for editing', () => {
    const [row] = rowsFromExtracted([extracted()], TERM, NOW);
    expect(row).toMatchObject({
      title: 'Essay 1',
      dueDate: '2026-10-15',
      dueTime: '',
      include: true,
      required: true,
      estimatedMinutes: '180',
      existing: false,
    });
  });

  it('carries a stated time into the time field', () => {
    const [row] = rowsFromExtracted(
      [extracted({ rawDate: 'Oct 15 at 11:59pm', dueAt: local(2026, 10, 15, 23, 59) })],
      TERM,
      NOW,
    );
    expect(row).toMatchObject({ dueDate: '2026-10-15', dueTime: '23:59' });
  });

  it('shows an unresolvable date as empty and excludes the row (A27)', () => {
    const [row] = rowsFromExtracted([extracted({ dueAt: null, rawDate: 'TBD' })], TERM, NOW);
    expect(row).toMatchObject({ dueDate: '', dueTime: '', include: false, rawDate: 'TBD' });
  });

  it('leaves an unstated estimate empty rather than inventing one', () => {
    const [row] = rowsFromExtracted([extracted({ estimatedMinutes: null })], TERM, NOW);
    expect(row.estimatedMinutes).toBe('');
  });

  it('gives every row its own id', () => {
    const rows = rowsFromExtracted([extracted(), extracted({ title: 'Essay 2' })], TERM, NOW);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe('reresolveRows', () => {
  it('fixes a no-year row when the term start moves', () => {
    // Built against a January 2026 term start so "January 20" resolves to
    // 2026-01-20 (not next January, which would make the assertion pass
    // whether or not re-resolution actually happened).
    const rows = rowsFromExtracted(
      [extracted({ rawDate: 'January 20', dueAt: null })],
      local(2026, 1, 1),
      NOW,
    );
    expect(rows[0].dueDate).toBe('2026-01-20');
    const moved = reresolveRows(rows, local(2027, 1, 1), NOW);
    expect(moved[0].dueDate).toBe('2027-01-20');
  });

  it('never overwrites a date the user typed', () => {
    const rows = rowsFromExtracted([extracted({ rawDate: 'TBD', dueAt: null })], TERM, NOW);
    const edited: ReviewRow[] = [{ ...rows[0], dueDate: '2026-12-01', edited: true, include: true }];
    expect(reresolveRows(edited, local(2027, 1, 1), NOW)[0].dueDate).toBe('2026-12-01');
  });

  it('leaves a row it still cannot resolve empty and excluded', () => {
    const rows = rowsFromExtracted([extracted({ rawDate: 'Week 5', dueAt: null })], TERM, NOW);
    const after = reresolveRows(rows, local(2027, 1, 1), NOW);
    expect(after[0]).toMatchObject({ dueDate: '', include: false });
  });
});

describe('markExisting', () => {
  it('marks rows that a previous import already wrote', () => {
    const rows = rowsFromExtracted([extracted(), extracted({ title: 'Midterm' })], TERM, NOW);
    const key = 'file:hist101.pdf';
    const events = [
      event({ sourceRef: sourceRefFor(key, { title: 'Essay 1', dueAt: local(2026, 10, 15) }) }),
    ];
    const marked = markExisting(rows, events, key);
    expect(marked.map((r) => r.existing)).toEqual([true, false]);
  });

  it('ignores manual events, and events from another import', () => {
    const rows = rowsFromExtracted([extracted()], TERM, NOW);
    const key = 'file:hist101.pdf';
    const ref = sourceRefFor(key, { title: 'Essay 1', dueAt: local(2026, 10, 15) });
    expect(markExisting(rows, [event({ source: 'manual', sourceRef: ref })], key)[0].existing).toBe(
      false,
    );
    expect(
      markExisting(rows, [event({ sourceRef: sourceRefFor('file:other.pdf', { title: 'Essay 1', dueAt: local(2026, 10, 15) }) })], key)[0]
        .existing,
    ).toBe(false);
  });
});

describe('toConfirmed', () => {
  const base = () => rowsFromExtracted([extracted()], TERM, NOW)[0];

  it('converts an all-day row to local midnight', () => {
    expect(toConfirmed([base()])).toEqual([
      {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
        allDay: true,
        required: true,
        estimatedMinutes: 180,
        notes: '',
      },
    ]);
  });

  it('converts a timed row to that instant, not all-day', () => {
    const [row] = toConfirmed([{ ...base(), dueTime: '23:59' }]);
    expect(row).toMatchObject({ dueAt: local(2026, 10, 15, 23, 59), allDay: false });
  });

  it('drops rows that are not ticked', () => {
    expect(toConfirmed([{ ...base(), include: false }])).toEqual([]);
  });

  it('drops a row with no date, so an unresolved row can never be written (A27)', () => {
    expect(toConfirmed([{ ...base(), dueDate: '', include: true }])).toEqual([]);
  });

  it('drops a row whose typed date is not a real day', () => {
    expect(toConfirmed([{ ...base(), dueDate: '2026-02-30' }])).toEqual([]);
    expect(toConfirmed([{ ...base(), dueDate: 'soon' }])).toEqual([]);
  });

  it('drops a row whose title is only whitespace', () => {
    expect(toConfirmed([{ ...base(), title: '   ' }])).toEqual([]);
  });

  it('turns a blank or nonsense estimate into the default, never NaN', () => {
    for (const typed of ['', '   ', 'abc', '-5', '0', '1e999']) {
      const [row] = toConfirmed([{ ...base(), estimatedMinutes: typed }]);
      expect(row.estimatedMinutes).toBe(60);
    }
  });

  it('rounds a fractional estimate and caps an absurd one', () => {
    expect(toConfirmed([{ ...base(), estimatedMinutes: '90.6' }])[0].estimatedMinutes).toBe(91);
    expect(
      toConfirmed([{ ...base(), estimatedMinutes: '99999999' }])[0].estimatedMinutes,
    ).toBeLessThanOrEqual(100_000);
  });
});
