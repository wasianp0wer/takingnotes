import { describe, expect, it } from 'vitest';

import { endOfLocalDay } from '@/triage/dates';
import { formatDayLabel, formatDue, formatMonthTitle, formatTime } from '@/triage/format';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const NOW = at(2026, 8, 28, 15); // Monday 28 Sep 2026, 15:00

describe('formatTime', () => {
  it('formats as zero-padded HH:mm', () => {
    expect(formatTime(at(2026, 8, 28, 9, 5))).toBe('09:05');
    expect(formatTime(at(2026, 8, 28, 23, 0))).toBe('23:00');
    expect(formatTime(at(2026, 8, 28, 0, 0))).toBe('00:00');
  });
});

describe('formatDayLabel', () => {
  it('labels today, tomorrow and yesterday', () => {
    expect(formatDayLabel(NOW, NOW)).toBe('Today');
    expect(formatDayLabel(at(2026, 8, 29, 9), NOW)).toBe('Tomorrow');
    expect(formatDayLabel(at(2026, 8, 27, 9), NOW)).toBe('Yesterday');
  });

  it('labels other days this year as weekday, day, short month', () => {
    expect(formatDayLabel(at(2026, 8, 30), NOW)).toBe('Wed 30 Sep');
  });

  it('adds the year when it differs from now', () => {
    expect(formatDayLabel(at(2027, 0, 4, 10), NOW)).toBe('Mon 4 Jan 2027');
  });
});

describe('formatDue', () => {
  it('reports no due date', () => {
    expect(formatDue(null, NOW)).toBe('No due date');
  });

  it('shows day label plus time for a timed due date today', () => {
    expect(formatDue(at(2026, 8, 28, 17, 5), NOW)).toBe('Today 17:05');
  });

  it('omits the time for an end-of-day due date', () => {
    expect(formatDue(endOfLocalDay(NOW), NOW)).toBe('Today');
  });

  it('shows tomorrow with a time', () => {
    expect(formatDue(at(2026, 8, 29, 9, 0), NOW)).toBe('Tomorrow 09:00');
  });

  it('shows a plain weekday date for an all-day item further out', () => {
    expect(formatDue(endOfLocalDay(at(2026, 8, 30)), NOW)).toBe('Wed 30 Sep');
  });

  it('shows the year and time for a date next year', () => {
    expect(formatDue(at(2027, 0, 4, 10, 0), NOW)).toBe('Mon 4 Jan 2027 10:00');
  });

  it('prefixes overdue timed items today', () => {
    expect(formatDue(at(2026, 8, 28, 9, 0), NOW)).toBe('Overdue · Today 09:00');
  });

  it('prefixes overdue all-day items from yesterday', () => {
    expect(formatDue(endOfLocalDay(at(2026, 8, 27)), NOW)).toBe('Overdue · Yesterday');
  });
});

describe('formatMonthTitle', () => {
  it('formats full month name and year', () => {
    expect(formatMonthTitle(2026, 8)).toBe('September 2026');
    expect(formatMonthTitle(2027, 0)).toBe('January 2027');
  });
});
