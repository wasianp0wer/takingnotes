import { describe, expect, it } from 'vitest';

import {
  dedupeAssignments,
  MAX_ESTIMATED_MINUTES,
  normalizeTitle,
  parseAssignments,
} from '@/syllabus/assignments';
import { MAX_ESTIMATED_MINUTES as MAX_ESTIMATED_MINUTES_REVIEW } from '@/syllabus/reviewRows';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const ctx = { termStart: local(2026, 9, 1), now: local(2026, 9, 30) };

/**
 * The real `String.prototype.isWellFormed`, reached through `unknown` rather
 * than a direct call: this project's `lib` predates ES2024, so a direct call
 * would not type-check, but the runtime method itself is what should decide
 * whether truncation left a lone surrogate half behind.
 */
const isWellFormed = (s: string): boolean =>
  (s as unknown as { isWellFormed(): boolean }).isWellFormed();

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

  it('accepts a model-stated estimate of 3000 (between the old 2880 cap and the current one)', () => {
    // The old cap here (2880) disagreed with the cap the review screen let a
    // user type by hand (100,000): a model stating 3000 was silently nulled
    // and shown as the 60-minute default, a number the user could type but
    // the model could not state. 2880 and huge/infinite values behave
    // identically under either cap, so only a value in this gap would catch
    // a regression back to the old one.
    const rows = parseAssignments([{ title: 'A', dueDate: 'Oct 15', estimatedMinutes: 3000 }], ctx);
    expect(rows[0].estimatedMinutes).toBe(3000);
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

  it('truncates by code point, never splitting a surrogate pair in half', () => {
    // ASCII text ('a'.repeat(...), above) truncates identically whether the
    // cap counts code points or code units, so it would not catch a
    // regression to a plain `.slice()`. This title is exactly MAX_TITLE
    // (200) code points, its last one an astral-plane emoji that is two
    // UTF-16 code units - the case a naive code-unit slice would cut through.
    const title = `${'a'.repeat(199)}😀`;
    const rows = parseAssignments([{ title, dueDate: 'Oct 15' }], ctx);
    expect(isWellFormed(rows[0].title)).toBe(true);
    expect(rows[0].title.endsWith('😀')).toBe(true);
    expect(rows[0].title).toBe(title);
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

describe('MAX_ESTIMATED_MINUTES', () => {
  it('is the one constant reviewRows.ts re-exports rather than declaring its own', () => {
    expect(MAX_ESTIMATED_MINUTES_REVIEW).toBe(MAX_ESTIMATED_MINUTES);
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

  it('escapes the separator inside an unresolved title/raw-date, so two different rows cannot collide', () => {
    // Unescaped, the key is `${title}|raw:${rawDate}`, and both rows below
    // produce the identical string 'a|raw:b|raw:c': row 1 from
    // title='a|raw:b' + rawDate='c', row 2 from title='a' +
    // rawDate='b|raw:c'. Escaping the '|' must keep them apart.
    const rows = dedupeAssignments([
      { title: 'A|raw:B', dueAt: null, rawDate: 'C', estimatedMinutes: null, notes: '' },
      { title: 'A', dueAt: null, rawDate: 'B|raw:C', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows).toHaveLength(2);
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
