import { describe, expect, it } from 'vitest';

import { dedupeAssignments, normalizeTitle, parseAssignments } from '@/syllabus/assignments';

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

  it('reads the kind case- and whitespace-insensitively, so a real deadline survives', () => {
    // Title-casing an enum value is a routine model deviation; dropping a genuine
    // assignment over it is the worst direction to fail in.
    const rows = parseAssignments(
      [
        { title: 'A', dueDate: 'Oct 15', kind: 'Deadline' },
        { title: 'B', dueDate: 'Oct 15', kind: 'deadline ' },
        { title: 'C', dueDate: 'Oct 15', kind: ' DEADLINE' },
        { title: 'D', dueDate: 'Oct 15', kind: '' },
        { title: 'E', dueDate: 'Oct 15', kind: 'Event' },
      ],
      ctx,
    );
    expect(rows.map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
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

  it('refuses a fractional estimate rather than rounding it to zero', () => {
    // Rounding before the positivity check would produce the very 0 that must
    // never reach the task-priority formula.
    const rows = parseAssignments(
      [
        { title: 'A', dueDate: 'Oct 15', estimatedMinutes: 0.4 },
        { title: 'B', dueDate: 'Oct 15', estimatedMinutes: 0.49 },
        { title: 'C', dueDate: 'Oct 15', estimatedMinutes: 1e-9 },
        { title: 'D', dueDate: 'Oct 15', estimatedMinutes: -0.2 },
        { title: 'E', dueDate: 'Oct 15', estimatedMinutes: 0.6 },
        { title: 'F', dueDate: 'Oct 15', estimatedMinutes: 90.4 },
      ],
      ctx,
    );
    expect(rows.map((r) => r.estimatedMinutes)).toEqual([null, null, null, null, 1, 90]);
  });

  it('refuses an absurdly large estimate', () => {
    const rows = parseAssignments(
      [
        { title: 'A', dueDate: 'Oct 15', estimatedMinutes: 1e300 },
        { title: 'B', dueDate: 'Oct 15', estimatedMinutes: 9007199254741000 },
        { title: 'C', dueDate: 'Oct 15', estimatedMinutes: Number.POSITIVE_INFINITY },
        { title: 'D', dueDate: 'Oct 15', estimatedMinutes: 2880 },
      ],
      ctx,
    );
    expect(rows.map((r) => r.estimatedMinutes)).toEqual([null, null, null, 2880]);
  });

  it('caps the length of every text field it keeps', () => {
    const rows = parseAssignments(
      [{ title: 'a'.repeat(200_000), dueDate: 'x'.repeat(5_000), notes: 'n'.repeat(5_000) }],
      ctx,
    );
    expect(rows[0].title.length).toBe(200);
    expect(rows[0].rawDate.length).toBe(100);
    expect(rows[0].notes.length).toBe(500);
  });

  it('refuses a resolved date that cannot belong to this term', () => {
    // dates.ts guards a year it infers, but an explicit bogus year from the model
    // reaches here. A fabricated date on a real calendar is the worst outcome, so
    // it becomes undated and the review table asks the user (A27).
    const rows = parseAssignments(
      [
        { title: 'Ancient', dueDate: 'Oct 15, 1823' },
        { title: 'Far future', dueDate: 'Oct 15, 2099' },
        { title: 'Next term', dueDate: 'Feb 3, 2027' },
      ],
      ctx,
    );
    expect(rows.map((r) => [r.title, r.rawDate, r.dueAt])).toEqual([
      ['Ancient', 'Oct 15, 1823', null],
      ['Far future', 'Oct 15, 2099', null],
      ['Next term', 'Feb 3, 2027', local(2027, 2, 3)],
    ]);
  });

  it('ignores unknown fields and trims what it keeps', () => {
    const rows = parseAssignments(
      [{ title: '  Essay 1  ', dueDate: ' Oct 15 ', weight: '20%', notes: 7 }],
      ctx,
    );
    expect(rows[0]).toMatchObject({ title: 'Essay 1', rawDate: 'Oct 15', notes: '' });
  });
});

describe('normalizeTitle', () => {
  it('collapses case, whitespace, surrounding quotes and trailing punctuation', () => {
    expect(normalizeTitle('  Essay   1  ')).toBe('essay 1');
    expect(normalizeTitle('"Essay 1"')).toBe('essay 1');
    expect(normalizeTitle('Essay 1?')).toBe('essay 1');
    expect(normalizeTitle('Essay 1!')).toBe('essay 1');
    expect(normalizeTitle('Essay 1.')).toBe('essay 1');
  });

  it('keeps internal punctuation, which may distinguish two real items', () => {
    expect(normalizeTitle('Essay #1')).not.toBe(normalizeTitle('Essay 1'));
    expect(normalizeTitle('Essay one')).not.toBe(normalizeTitle('Essay 1'));
  });
});

describe('dedupeAssignments', () => {
  it('collapses the same title and raw date, merging detail into the first', () => {
    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'essay  1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 180, notes: 'full' },
      { title: 'Essay 2', dueAt: 2, rawDate: 'Oct 22', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Essay 2']);
    // The first row wins on title and date, but a later duplicate fills in what
    // it lacked: the richer reading is real information, not noise.
    expect(rows[0].estimatedMinutes).toBe(180);
    expect(rows[0].notes).toBe('full');
  });

  it('does not let a later duplicate overwrite detail the first row already had', () => {
    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 180, notes: 'full' },
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 30, notes: 'partial' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].estimatedMinutes).toBe(180);
    expect(rows[0].notes).toBe('full');
  });

  it('collapses the same date written differently by two chunks', () => {
    // The normal case for overlapping chunks: one resolved instant, three phrasings.
    const at = local(2026, 10, 15);
    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: at, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Essay 1', dueAt: at, rawDate: 'October 15', estimatedMinutes: null, notes: '' },
      { title: 'Essay 1', dueAt: at, rawDate: '10/15', estimatedMinutes: 180, notes: '' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawDate).toBe('Oct 15');
    expect(rows[0].estimatedMinutes).toBe(180);
  });

  it('keeps two same-titled items with different dates', () => {
    const rows = dedupeAssignments([
      {
        title: 'Response paper',
        dueAt: local(2026, 10, 15),
        rawDate: 'Oct 15',
        estimatedMinutes: null,
        notes: '',
      },
      {
        title: 'Response paper',
        dueAt: local(2026, 11, 15),
        rawDate: 'Nov 15',
        estimatedMinutes: null,
        notes: '',
      },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('collapses one assignment that only one chunk gave a time for', () => {
    // `sourceRefFor` keys on the local DAY, so these are one event whatever this
    // function does. Dedupe agrees with it, so the review screen shows one row
    // rather than hiding the collapse until the write (A26).
    const rows = dedupeAssignments([
      {
        title: 'Essay 1',
        dueAt: new Date(2026, 9, 15).getTime(),
        rawDate: 'Oct 15',
        estimatedMinutes: null,
        notes: '',
      },
      {
        title: 'Essay 1',
        dueAt: new Date(2026, 9, 15, 23, 59).getTime(),
        rawDate: 'Oct 15 11:59pm',
        estimatedMinutes: 180,
        notes: '',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawDate).toBe('Oct 15');
    expect(rows[0].estimatedMinutes).toBe(180);
  });

  it('collapses two same-titled items on one day at different times', () => {
    // Deliberate: `sourceRefFor` would give both the same identity, so they were
    // always going to be one event. Surfacing that here is the honest outcome.
    const rows = dedupeAssignments([
      {
        title: 'Quiz',
        dueAt: new Date(2026, 9, 15, 9).getTime(),
        rawDate: 'Oct 15 9am',
        estimatedMinutes: null,
        notes: '',
      },
      {
        title: 'Quiz',
        dueAt: new Date(2026, 9, 15, 17).getTime(),
        rawDate: 'Oct 15 5pm',
        estimatedMinutes: null,
        notes: '',
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it('separates two undated items only by their raw date text', () => {
    const rows = dedupeAssignments([
      { title: 'Final paper', dueAt: null, rawDate: 'TBD', estimatedMinutes: null, notes: '' },
      { title: 'Final paper', dueAt: null, rawDate: 'TBD', estimatedMinutes: null, notes: '' },
      { title: 'Final paper', dueAt: null, rawDate: 'Week 14', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows.map((r) => r.rawDate)).toEqual(['TBD', 'Week 14']);
  });

  it('does not mutate the rows it was given', () => {
    const input = [
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 180, notes: 'full' },
    ];
    dedupeAssignments(input);
    expect(input[0].estimatedMinutes).toBeNull();
    expect(input[0].notes).toBe('');
  });
});
