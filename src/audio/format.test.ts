import { describe, expect, it } from 'vitest';
import { formatClock, recordingTitle } from '@/audio/format';

describe('formatClock', () => {
  it.each([
    [0, '0:00'], [999, '0:00'], [1_000, '0:01'], [65_000, '1:05'],
    [600_000, '10:00'], [3_600_000, '1:00:00'], [3_725_000, '1:02:05'],
    [-5, '0:00'], [Number.NaN, '0:00'],
  ])('%d ms → %s', (ms, text) => expect(formatClock(ms)).toBe(text));
});

describe('recordingTitle', () => {
  it('uses zero-padded local date and time', () => {
    const at = new Date(2026, 0, 5, 9, 7, 30).getTime(); // local time
    expect(recordingTitle(at)).toBe('Recording 2026-01-05 09:07');
  });
});
