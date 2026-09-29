import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@/triage/dates';

const HOUR = 3_600_000;
let previousTz: string | undefined;

beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe('local day math across DST (America/New_York)', () => {
  it('spring forward: 2026-03-08 is 23 hours long', () => {
    const noon = new Date(2026, 2, 8, 12).getTime();
    expect(endOfLocalDay(noon) - startOfLocalDay(noon)).toBe(23 * HOUR - 1);
    const next = addLocalDays(new Date(2026, 2, 7, 12).getTime(), 1);
    expect(new Date(next).getHours()).toBe(12);
    expect(next - new Date(2026, 2, 7, 12).getTime()).toBe(23 * HOUR);
  });
  it('fall back: 2026-11-01 is 25 hours long', () => {
    const noon = new Date(2026, 10, 1, 12).getTime();
    expect(endOfLocalDay(noon) - startOfLocalDay(noon)).toBe(25 * HOUR - 1);
    expect(new Date(addLocalDays(new Date(2026, 9, 31, 12).getTime(), 1)).getHours()).toBe(12);
  });
});
