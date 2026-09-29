import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  endOfLocalDay,
  isSameLocalDay,
  localDateTimeFromInputs,
  monthGrid,
  startOfLocalDay,
  toDateInputValue,
  toTimeInputValue,
} from '@/triage/dates';

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m, d, h, min, s, ms).getTime();

describe('startOfLocalDay / endOfLocalDay', () => {
  it('returns local midnight of the same day', () => {
    expect(startOfLocalDay(at(2026, 8, 28, 0))).toBe(at(2026, 8, 28));
    expect(startOfLocalDay(at(2026, 8, 28, 12, 30))).toBe(at(2026, 8, 28));
    expect(startOfLocalDay(at(2026, 8, 28, 23, 59, 59, 999))).toBe(at(2026, 8, 28));
  });

  it('returns the last millisecond of the same local day', () => {
    expect(endOfLocalDay(at(2026, 8, 28, 0))).toBe(at(2026, 8, 28, 23, 59, 59, 999));
    expect(endOfLocalDay(at(2026, 8, 28, 23, 59, 59, 999))).toBe(at(2026, 8, 28, 23, 59, 59, 999));
  });
});

describe('addLocalDays', () => {
  it('keeps the wall-clock time', () => {
    expect(addLocalDays(at(2026, 8, 28, 17, 45), 1)).toBe(at(2026, 8, 29, 17, 45));
  });
  it('crosses month and year ends', () => {
    expect(addLocalDays(at(2026, 8, 30, 9), 1)).toBe(at(2026, 9, 1, 9));
    expect(addLocalDays(at(2026, 11, 31, 9), 1)).toBe(at(2027, 0, 1, 9));
  });
  it('accepts negative and zero offsets', () => {
    expect(addLocalDays(at(2026, 9, 1, 9), -1)).toBe(at(2026, 8, 30, 9));
    expect(addLocalDays(at(2026, 9, 1, 9), 0)).toBe(at(2026, 9, 1, 9));
  });
});

describe('isSameLocalDay', () => {
  it('is true within a day and false across midnight', () => {
    expect(isSameLocalDay(at(2026, 8, 28, 0), at(2026, 8, 28, 23, 59))).toBe(true);
    expect(isSameLocalDay(at(2026, 8, 28, 23, 59, 59, 999), at(2026, 8, 29))).toBe(false);
  });
});

describe('monthGrid', () => {
  it('lays out September 2026 as 5 Sunday-first weeks', () => {
    const grid = monthGrid(2026, 8);
    expect(grid).toHaveLength(5);
    for (const week of grid) expect(week).toHaveLength(7);
    expect(grid[0][0]).toBe(at(2026, 7, 30));
    expect(grid[4][6]).toBe(at(2026, 9, 3));
    for (const week of grid) {
      for (const day of week) {
        expect(new Date(day).getDay()).toBe(week.indexOf(day));
        expect(startOfLocalDay(day)).toBe(day);
      }
    }
  });
  it('uses 4 rows for February 2026, which starts on a Sunday', () => {
    const grid = monthGrid(2026, 1);
    expect(grid).toHaveLength(4);
    expect(grid[0][0]).toBe(at(2026, 1, 1));
    expect(grid[3][6]).toBe(at(2026, 1, 28));
  });
});

describe('date/time input values', () => {
  it('formats with zero padding', () => {
    expect(toDateInputValue(at(2026, 0, 5, 7, 3))).toBe('2026-01-05');
    expect(toTimeInputValue(at(2026, 0, 5, 7, 3))).toBe('07:03');
  });
  it('round-trips', () => {
    const ms = at(2026, 8, 28, 17, 45);
    expect(localDateTimeFromInputs(toDateInputValue(ms), toTimeInputValue(ms))).toBe(ms);
  });
  it('treats an empty time as local midnight', () => {
    expect(localDateTimeFromInputs('2026-09-28', '')).toBe(at(2026, 8, 28));
  });
  it('rejects invalid input', () => {
    expect(localDateTimeFromInputs('', '')).toBeNull();
    expect(localDateTimeFromInputs('2026-02-30', '')).toBeNull();
    expect(localDateTimeFromInputs('2026-09-28', '25:00')).toBeNull();
    expect(localDateTimeFromInputs('not a date', '10:00')).toBeNull();
  });
});
