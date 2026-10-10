import { describe, expect, it } from 'vitest';

import {
  NAMING_SUMMARY_MAX,
  NAMING_TITLE_MAX,
  validateNamingResult,
} from '@/notes/naming/validate';

describe('validateNamingResult', () => {
  it('accepts {title, summary} and trims both', () => {
    expect(validateNamingResult({ title: '  Newton on motion  ', summary: '  A lecture. ' })).toEqual({
      title: 'Newton on motion',
      summary: 'A lecture.',
    });
  });

  it('allows a blank title (setNoteSummary treats it as a failed generation)', () => {
    expect(validateNamingResult({ title: '  ', summary: 'A summary.' })).toEqual({
      title: '',
      summary: 'A summary.',
    });
  });

  it('throws when the value is not an object', () => {
    expect(() => validateNamingResult('not an object')).toThrow();
    expect(() => validateNamingResult(null)).toThrow();
    expect(() => validateNamingResult([{ title: 'x', summary: 'y' }])).toThrow();
  });

  it('throws when a required field is missing or the wrong type', () => {
    expect(() => validateNamingResult({ title: 'x' })).toThrow();
    expect(() => validateNamingResult({ summary: 'y' })).toThrow();
    expect(() => validateNamingResult({ title: 1, summary: 'y' })).toThrow();
    expect(() => validateNamingResult({ title: 'x', summary: 2 })).toThrow();
  });

  it('throws when summary is blank - unlike title, a blank summary is not a documented failure mode', () => {
    expect(() => validateNamingResult({ title: 'x', summary: '   ' })).toThrow();
  });

  it('caps a rambling title at NAMING_TITLE_MAX (fix round 1, Important 2)', () => {
    const long = 'word '.repeat(500).trim();
    expect(long.length).toBeGreaterThan(NAMING_TITLE_MAX);
    const result = validateNamingResult({ title: long, summary: 'A summary.' });
    expect(result.title.length).toBe(NAMING_TITLE_MAX);
    expect(result.title).toBe(long.slice(0, NAMING_TITLE_MAX));
  });

  it('caps a rambling summary at NAMING_SUMMARY_MAX (fix round 1, Important 2)', () => {
    const long = 'word '.repeat(500).trim();
    expect(long.length).toBeGreaterThan(NAMING_SUMMARY_MAX);
    const result = validateNamingResult({ title: 'A title', summary: long });
    expect(result.summary.length).toBe(NAMING_SUMMARY_MAX);
    expect(result.summary).toBe(long.slice(0, NAMING_SUMMARY_MAX));
  });

  it('does not cap a title or summary within the limit', () => {
    const result = validateNamingResult({ title: 'Short title', summary: 'Short summary.' });
    expect(result.title).toBe('Short title');
    expect(result.summary).toBe('Short summary.');
  });
});
