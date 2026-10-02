import { describe, expect, it } from 'vitest';

import { localDayKey } from '@/syllabus/day';

describe('localDayKey', () => {
  it('formats as YYYY-MM-DD in local time, zero-padded for single-digit months and days', () => {
    expect(localDayKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
    expect(localDayKey(new Date(2026, 8, 9).getTime())).toBe('2026-09-09');
    expect(localDayKey(new Date(2026, 11, 31).getTime())).toBe('2026-12-31');
  });

  describe('spring forward - 8 March 2026 (US DST start, clocks skip 2am to 3am)', () => {
    it('gives every instant on the skip day the same key, including one inside the nonexistent hour', () => {
      const beforeGap = new Date(2026, 2, 8, 1, 30).getTime();
      // 2:30am does not exist locally on this day; the engine normalizes it
      // forward. Whatever it becomes, it must still read as 8 March.
      const insideGap = new Date(2026, 2, 8, 2, 30).getTime();
      const afterGap = new Date(2026, 2, 8, 3, 30).getTime();
      const lateInDay = new Date(2026, 2, 8, 23, 59).getTime();

      expect(localDayKey(beforeGap)).toBe('2026-03-08');
      expect(localDayKey(insideGap)).toBe('2026-03-08');
      expect(localDayKey(afterGap)).toBe('2026-03-08');
      expect(localDayKey(lateInDay)).toBe('2026-03-08');
    });

    it('still separates the day before and the day after', () => {
      expect(localDayKey(new Date(2026, 2, 7, 23, 59).getTime())).toBe('2026-03-07');
      expect(localDayKey(new Date(2026, 2, 9, 0, 1).getTime())).toBe('2026-03-09');
    });
  });

  describe('fall back - 1 November 2026 (US DST end, 1am-2am happens twice)', () => {
    it('gives the same key to both occurrences of the repeated 1:30am', () => {
      const firstPass = new Date(2026, 10, 1, 1, 30).getTime();
      // The same wall-clock 1:30am recurs one real hour later, once the clocks
      // fall back. These are genuinely different instants.
      const secondPass = firstPass + 60 * 60 * 1000;
      expect(secondPass).not.toBe(firstPass);

      expect(localDayKey(firstPass)).toBe('2026-11-01');
      expect(localDayKey(secondPass)).toBe('2026-11-01');
    });

    it('still separates the day before and the day after', () => {
      expect(localDayKey(new Date(2026, 9, 31, 23, 59).getTime())).toBe('2026-10-31');
      expect(localDayKey(new Date(2026, 10, 2, 0, 1).getTime())).toBe('2026-11-02');
    });
  });
});
