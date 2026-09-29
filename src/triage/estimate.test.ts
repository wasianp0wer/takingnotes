import { describe, expect, it } from 'vitest';

import { parseEstimateMinutes } from '@/triage/estimate';
import { DEFAULT_ESTIMATE_MINUTES } from '@/triage/priority';

describe('parseEstimateMinutes', () => {
  it('reads a whole number of minutes', () => {
    expect(parseEstimateMinutes('45')).toBe(45);
  });

  it('treats blank (and whitespace-only) as the default estimate', () => {
    expect(parseEstimateMinutes('')).toBe(DEFAULT_ESTIMATE_MINUTES);
    expect(parseEstimateMinutes('   ')).toBe(DEFAULT_ESTIMATE_MINUTES);
  });

  it('rounds a fractional estimate to whole minutes', () => {
    expect(parseEstimateMinutes('90.6')).toBe(91);
    expect(parseEstimateMinutes('90.4')).toBe(90);
  });

  it('accepts zero', () => {
    expect(parseEstimateMinutes('0')).toBe(0);
  });

  it('rejects a negative estimate', () => {
    expect(parseEstimateMinutes('-5')).toBeNull();
  });

  it('rejects text that is not a number', () => {
    expect(parseEstimateMinutes('soon')).toBeNull();
  });
});
