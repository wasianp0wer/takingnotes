import { describe, expect, it } from 'vitest';

import { SEARCH_REASON_MAX, validateBandResult, validateScreenIndices } from '@/search/validate';

describe('validateScreenIndices', () => {
  it('validates a clean array, deduped and sorted', () => {
    expect(validateScreenIndices([3, 1, 1, 2], 5)).toEqual([1, 2, 3]);
  });

  it('unwraps a common wrapper object', () => {
    expect(validateScreenIndices({ indices: [1, 2] }, 5)).toEqual([1, 2]);
    expect(validateScreenIndices({ candidates: [1] }, 5)).toEqual([1]);
    expect(validateScreenIndices({ relevant: [2] }, 5)).toEqual([2]);
    expect(validateScreenIndices({ matches: [3] }, 5)).toEqual([3]);
    expect(validateScreenIndices({ ids: [4] }, 5)).toEqual([4]);
  });

  it('accepts an object entry carrying an index field', () => {
    expect(validateScreenIndices([{ index: 2 }, { index: 4 }], 5)).toEqual([2, 4]);
  });

  it('drops out-of-range and non-integer entries without throwing', () => {
    expect(validateScreenIndices([0, -1, 1.5, 6, 2], 5)).toEqual([2]);
  });

  it('drops a non-numeric entry without throwing', () => {
    expect(validateScreenIndices(['two', null, 2], 5)).toEqual([2]);
  });

  it('throws on a non-array, non-wrapper value', () => {
    expect(() => validateScreenIndices('sure, note 2 looks relevant', 5)).toThrow();
    expect(() => validateScreenIndices(null, 5)).toThrow();
    expect(() => validateScreenIndices(42, 5)).toThrow();
  });

  it('an empty array, or an array that fully drops, validates to []', () => {
    expect(validateScreenIndices([], 5)).toEqual([]);
    expect(validateScreenIndices([0, 99], 5)).toEqual([]);
  });
});

describe('validateBandResult', () => {
  it.each(['strong', 'moderate', 'weak', 'none'] as const)(
    'accepts band %s',
    (raw) => {
      expect(validateBandResult({ band: raw, reason: 'x' }).band).toBe(raw);
    },
  );

  it('accepts band case/whitespace-insensitively', () => {
    expect(validateBandResult({ band: ' STRONG ', reason: 'x' }).band).toBe('strong');
  });

  it('defaults an unrecognised band to none rather than throwing', () => {
    expect(validateBandResult({ band: 'maybe', reason: 'x' }).band).toBe('none');
    expect(validateBandResult({ band: 123, reason: 'x' }).band).toBe('none');
    expect(validateBandResult({ reason: 'x' }).band).toBe('none');
  });

  it('throws on a non-object value', () => {
    expect(() => validateBandResult('strong')).toThrow();
    expect(() => validateBandResult(null)).toThrow();
    expect(() => validateBandResult([1, 2])).toThrow();
  });

  it('coerces a missing or non-string reason to "", and caps an over-long one', () => {
    expect(validateBandResult({ band: 'weak' }).reason).toBe('');
    expect(validateBandResult({ band: 'weak', reason: 42 }).reason).toBe('');
    const long = 'x'.repeat(10_000);
    const result = validateBandResult({ band: 'weak', reason: long });
    expect(result.reason.length).toBeLessThanOrEqual(SEARCH_REASON_MAX);
  });

  it('trims the reason', () => {
    expect(validateBandResult({ band: 'weak', reason: '  padded  ' }).reason).toBe('padded');
  });
});
