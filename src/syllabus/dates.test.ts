import { describe, expect, it } from 'vitest';

import { parseSyllabusDate, resolveDueDate } from '@/syllabus/dates';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();

/** A term that starts 1 September 2026, and a "now" inside it. */
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

describe('resolveDueDate', () => {
  it('reads an ISO date with a year', () => {
    expect(resolveDueDate('2026-10-15', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('due 2026/10/15', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('reads a month name with a day and a year', () => {
    expect(resolveDueDate('October 15th, 2026', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('Oct. 15 2026', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('reads a day-first month name with no year against the term start', () => {
    expect(resolveDueDate('15 Oct', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('rolls a no-year date earlier than the term start into the next year', () => {
    // Term starts in September 2026, so "January 20" is the following January.
    expect(resolveDueDate('January 20', TERM, NOW)).toBe(local(2027, 1, 20));
  });

  it('keeps a no-year date that falls exactly on the term start day in that year', () => {
    expect(resolveDueDate('September 1', TERM, NOW)).toBe(local(2026, 9, 1));
  });

  it('reads a numeric date month-first, and a two-digit year as 2000+', () => {
    expect(resolveDueDate('10/15', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('10/15/26', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('10/15/2026', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('resolves today and tomorrow against now', () => {
    expect(resolveDueDate('today', TERM, NOW)).toBe(local(2026, 9, 30));
    expect(resolveDueDate('tomorrow', TERM, NOW)).toBe(local(2026, 10, 1));
  });

  it('returns null rather than guessing', () => {
    for (const raw of ['', '   ', 'TBD', 'see Canvas', 'Week 5', 'Finals week', 'n/a']) {
      expect(resolveDueDate(raw, TERM, NOW)).toBeNull();
    }
  });

  it('returns null for a date that is not a real day', () => {
    expect(resolveDueDate('Feb 30', TERM, NOW)).toBeNull();
    expect(resolveDueDate('13/40', TERM, NOW)).toBeNull();
    expect(resolveDueDate('2026-02-30', TERM, NOW)).toBeNull();
  });
});

describe('parseSyllabusDate', () => {
  it('reports no time as local midnight', () => {
    expect(parseSyllabusDate('Oct 15', TERM, NOW)).toEqual({
      at: local(2026, 10, 15),
      hasTime: false,
    });
  });

  it('reads a 12-hour time', () => {
    expect(parseSyllabusDate('Oct 15 at 11:59pm', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 23, 59),
      hasTime: true,
    });
    expect(parseSyllabusDate('10/15 5:00 PM', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 17, 0),
      hasTime: true,
    });
    expect(parseSyllabusDate('Oct 15 by 9am', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 9, 0),
      hasTime: true,
    });
  });

  it('reads a 24-hour time', () => {
    expect(parseSyllabusDate('2026-10-15 17:00', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 17, 0),
      hasTime: true,
    });
  });

  it('ignores a time that is not a real time', () => {
    expect(parseSyllabusDate('Oct 15 at 25:99', TERM, NOW)).toEqual({
      at: local(2026, 10, 15),
      hasTime: false,
    });
  });
});
