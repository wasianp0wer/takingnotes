import { describe, expect, it } from 'vitest';

import { dedupeAssignments, parseAssignments } from '@/syllabus/assignments';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const ctx = { termStart: local(2026, 9, 1), now: local(2026, 9, 30) };

describe('parseAssignments', () => {
  it('maps a well-formed array, resolving each date', () => {
    const rows = parseAssignments(
      [
        { title: 'Essay 1', dueDate: 'Oct 15', kind: 'deadline', estimatedMinutes: 180, notes: '5pp' },
        { title: 'Midterm', dueDate: '2026-11-02' },
      ],
      ctx,
    );
    expect(rows).toEqual([
      {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
        rawDate: 'Oct 15',
        estimatedMinutes: 180,
        notes: '5pp',
      },
      {
        title: 'Midterm',
        dueAt: local(2026, 11, 2),
        rawDate: '2026-11-02',
        estimatedMinutes: null,
        notes: '',
      },
    ]);
  });

  it('throws when the model did not return an array at all', () => {
    expect(() => parseAssignments({ assignments: [] }, ctx)).toThrow(/array/i);
    expect(() => parseAssignments('Essay 1 due Oct 15', ctx)).toThrow(/array/i);
  });

  it('drops rows with no usable title', () => {
    const rows = parseAssignments(
      [{ dueDate: 'Oct 15' }, { title: '   ', dueDate: 'Oct 15' }, { title: 7 }, null, 'Essay'],
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it('keeps a row whose date is missing or unreadable, with no date', () => {
    const rows = parseAssignments(
      [{ title: 'Final paper', dueDate: 'TBD' }, { title: 'Reading', dueDate: 42 }],
      ctx,
    );
    expect(rows.map((r) => [r.title, r.rawDate, r.dueAt])).toEqual([
      ['Final paper', 'TBD', null],
      ['Reading', '', null],
    ]);
  });

  it('drops a row that is not a deadline (J7)', () => {
    const rows = parseAssignments(
      [
        { title: 'Lecture 3', dueDate: 'Oct 15', kind: 'event' },
        { title: 'Essay 1', dueDate: 'Oct 15', kind: 'deadline' },
      ],
      ctx,
    );
    expect(rows.map((r) => r.title)).toEqual(['Essay 1']);
  });

  it('refuses an estimate that is not a positive finite number', () => {
    const rows = parseAssignments(
      [
        { title: 'A', dueDate: 'Oct 15', estimatedMinutes: 0 },
        { title: 'B', dueDate: 'Oct 15', estimatedMinutes: -30 },
        { title: 'C', dueDate: 'Oct 15', estimatedMinutes: '90' },
        { title: 'D', dueDate: 'Oct 15', estimatedMinutes: Number.NaN },
      ],
      ctx,
    );
    expect(rows.map((r) => r.estimatedMinutes)).toEqual([null, null, null, null]);
  });

  it('ignores unknown fields and trims what it keeps', () => {
    const rows = parseAssignments(
      [{ title: '  Essay 1  ', dueDate: ' Oct 15 ', weight: '20%', notes: 7 }],
      ctx,
    );
    expect(rows[0]).toMatchObject({ title: 'Essay 1', rawDate: 'Oct 15', notes: '' });
  });
});

describe('dedupeAssignments', () => {
  it('collapses the same title and raw date, keeping the first', () => {
    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 180, notes: 'full' },
      { title: 'essay  1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Essay 2', dueAt: 2, rawDate: 'Oct 22', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Essay 2']);
    expect(rows[0].estimatedMinutes).toBe(180);
  });

  it('keeps two same-titled items with different dates', () => {
    const rows = dedupeAssignments([
      { title: 'Response paper', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Response paper', dueAt: 2, rawDate: 'Nov 15', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows).toHaveLength(2);
  });
});
